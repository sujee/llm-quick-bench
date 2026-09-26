# Cache Test Specification

Reproducible specification for the Cache Test benchmark in LLM Quick Bench.
Everything an agent needs to re-implement or verify the test is described
here. The shipped implementation lives in `js/cache-test1.js` with shared
helpers in `js/bench-utils.js`; this document is the source of truth for the
logic.

## 1. Purpose

Measure how effective a provider's **prompt caching** is, per model, using one
fixed trivia question asked two ways:

- **short** — the bare question. A handful of tokens, deliberately below the
  minimum prefix length most providers cache (about 1024 tokens for OpenAI).
- **padded** — the same question surrounded by filler so the whole prompt
  reaches the configured size (default 50,000 tokens). The padding enables
  caching by pushing the prompt over that minimum — it is **not** a
  cache-busting nonce; nothing random is injected into individual requests.
- **busted** — the no-cache control: the same padded prompt (identical
  filler bytes) with a fresh nonce prepended as the very first line of every
  request. Prefix caches match from token 0, so a differing first line
  guarantees a miss on every request. Every busted request is a genuine
  cold request.

Each variant sends **1 cold request** (the cache prime and prefill baseline)
followed by **N byte-identical repeats** (default 5). Because the request
bytes are identical within a variant, any difference between the cold request
and the repeats is attributable to the prefix cache.

The test reports three headline dimensions:

| Dimension | Metric | Source |
|---|---|---|
| Did it cache? | **Cache hit %** | server-reported `cached_tokens` ÷ `prompt_tokens` |
| Was it faster? | **TTFT reduction** | (cold TTFT − warm TTFT p50) ÷ cold TTFT |
| Was it cheaper? | **Cost savings** | (cold cost − warm cost p50) ÷ cold cost |

## 2. The question and the two variants

Every request in the test asks exactly one question:

```
What is the capital of France? Answer with the city name only.
```

### short variant

The prompt is the bare question string. No filler, no headers. Expected
prompt size is ~15 tokens (estimated at `ceil(len / 4)`).

### padded variant

The prompt is:

```
The reference log below is background context for the question that follows.

--- CONTEXT START ---
<filler line 1>
<filler line 2>
...
--- CONTEXT END ---

What is the capital of France? Answer with the city name only.
```

The question is always the **last** line, so the prompt ends identically on
every request.

### busted variant (the no-cache control)

The prompt is the padded variant's prompt with a fresh nonce line prepended
as the very first line of **every** request:

```
Request nonce: <16 random hex chars>
The reference log below is background context for the question that follows.
... (identical padded filler) ...
What is the capital of France? Answer with the city name only.
```

`generateCacheNonce()` (in `js/cache-test1.js`) draws 8 random bytes per
request. Because prefix caches match from token 0, the differing first line
guarantees a miss regardless of the identical content after it. The busted
variant's body is rebuilt per request (it cannot share the stable body);
its filler is the padded variant's filler (same seed, payloadIndex 1).

## 3. Payload generation (`generateCachePromptPayload`)

Lives in `js/bench-utils.js`. Signature:

```js
generateCachePromptPayload({ runSeed, payloadIndex, targetTokens })
```

- `runSeed` — a fresh `Uint32Array(1)` random value drawn once per benchmark
  run (`crypto.getRandomValues`).
- `payloadIndex` — `modelIndex * 2 + variantIndex`, so every model × variant
  gets a distinct payload within the run.
- `targetTokens` — `0` builds the short variant; a positive count builds the
  padded variant.

Deterministic seeding:

```
taskSeed = (runSeed + payloadIndex * 2654435761) >>> 0
random   = createSeededRandom(taskSeed)
```

`createSeededRandom` and `generateContextFillerLine` are the same seeded
filler primitives the Needle/Prefill tests use (neutral log lines, no
code-shaped strings).

Filler growth loop (padded variant only):

- The fixed wrapper lines (header, markers, question) are measured first as
  `fixedCharacters`; the target is the **whole assembled prompt**, not just
  the filler block: grow filler lines (tracking a running character total so
  generation stays linear) until at least 8 lines exist and
  `fillerCharacters + fixedCharacters >= targetTokens * 4 + 64` (the
  64-character pad covers the final join slack).
- Result: `estimatedTokens` for the full prompt lands on the configured size
  within one filler line (~a few tokens), so a configured 50K run sends a
  ~50K-token prompt.
- `estimatedTokens = estimateTokenCount(prompt)` = `round(len(prompt) / 4)`.

Properties this guarantees:

- **Same seed ⇒ byte-identical payload** (the premise of the test: cold and
  repeats share one serialized body).
- **Fresh `runSeed` per benchmark run ⇒ regenerated padding**, so re-running
  the test never measures a cache warmed by the previous run. Within the run
  the padding stays fixed — it enables caching, it does not bust it.
- **Different `payloadIndex` ⇒ different payload**, so two models (or the two
  variants) never share a prefix by accident.

A cold request can still hit an unrelated cache (shared provider
infrastructure), so cold numbers are presented as "first request", not a
guaranteed miss.

## 4. Request construction

One request body is built **once per model × variant** and reused (the same
object is passed to every streaming call, so `JSON.stringify` output is
byte-identical):

```js
{
  model: <modelId>,
  messages: [{ role: "user", content: <payload prompt> }],
  stream: true,
  top_p: 1,
  temperature: <optional, omitted when null>,
  <max_tokens | max_completion_tokens>: 64,   // openai provider ⇒ max_completion_tokens
  stream_options: { include_usage: true },
}
```

Rules:

- **No per-request unique id.** (The long-context engine prefixes
  `Request id: <uuid>` to defeat caching; the Cache Test must never do this.)
- **No thinking toggles** (`chat_template_kwargs` is never sent) — each model
  is measured the way it is actually served.
- Output is capped at 64 tokens (the answer is a few tokens); blank fields
  are stripped by `stripBlankFields` before serialization.
- `stream_options.include_usage` is always `true` — the cached-token split
  comes from the usage chunk. When "Require server token counts" is checked
  (default), a missing usage fails the request rather than estimating.

## 5. Run sequence

Per benchmark run:

1. Read config (below), validate model selection, and show the styled
   confirmation dialog (`showBenchmarkConfirm`) with per-model planned
   requests, input tokens, and estimated input cost at **full** input pricing.
   Nothing is sent on Cancel/Escape/backdrop.
2. Draw `runSeed`.
3. For each selected model, **strictly serially** (one model at a time so
   each cold prefill is uncontended):
   1. Build the short payload + body, then the padded payload + body, then
      the busted plan (padded filler, per-request nonce bodies).
   2. Send the short variant: request 1 = **cold** (`short-cold`), requests
      2..N+1 = **warm** (`short-warm-1..N`).
   3. Send the padded variant the same way (`padded-cold`,
      `padded-warm-1..N`).
   4. Send the busted variant the same way (`busted-cold`,
      `busted-warm-1..N`); each of its requests rebuilds the body around a
      fresh nonce, so its "warm" runs are guaranteed misses too.
4. Per-request result status on the model row: `run k/total` where
   `total = 3 * (1 + runsPerModel)`; final per-model status is
   `complete | partial | error | cancelled`.

Total requests per model = `3 * (1 + runsPerModel)` (default 18).

Cancellation: an `AbortController` aborts in-flight streams; completed
measurements are preserved and the run status becomes `cancelled`.

## 6. Measurement per request

Collected by the shared streaming runner (`runStreamingChatCompletion`):

- `ttftMs` — request dispatch → first generated token of any kind (content or
  reasoning).
- `promptTokens` — from the usage chunk.
- `cachedTokens` — from the usage chunk, trying each field in order:
  `usage.prompt_tokens_details.cached_tokens` (OpenAI-compatible standard),
  `usage.cached_tokens` (top-level shorthand), then
  `usage.prompt_cache_hit_tokens` (Nebius's newer backends, which null out
  `prompt_tokens_details` and report the split top-level alongside
  `prompt_cache_miss_tokens`). **Null when the endpoint reports no split**
  (rendered "-", never treated as zero).
- `completionTokens`, reasoning text/content text, `sendMs`, etc. (standard
  shared measurement fields).

Each run is tagged `phase: "cold" | "warm"` and `variant: "short" | "padded"`,
stamped with `testTimeStartMs`/`testTimeEndMs`, graded (below), and costed
(below).

### Grading (`gradeCacheAnswer`)

The trimmed content must match `/\bparis\b/i`. Surrounding words and
punctuation are tolerated ("The capital of France is Paris." is correct).
This verifies a cached prefill does not corrupt the answer.

## 7. Summary math

All in `js/bench-utils.js`, grouped per model × variant row.

### `summarizeCacheRuns(runs, failedRuns)`

Splits a row's runs into `phase === "cold"` (at most one) and
`phase === "warm"`, then:

- `coldTtftMs` — the cold run's TTFT.
- `warmTtftP50`, `warmTtftP90` — nearest-rank percentiles of warm TTFTs
  (`percentile(values, p)` = `sorted[ceil(p * n) - 1]`).
- `ttftReductionPct = (coldTtftMs − warmTtftP50) / coldTtftMs × 100`
  (null until both sides exist).
- `coldCachedTokens`, `warmCachedTokensP50` (percentile of warm
  `cachedTokens`; null when unreported).
- `promptTokensP50` — percentile of `promptTokens` across **all** of the
  row's requests (cold included): the server-reported prompt size shown in
  the Input tokens column.
- `warmPromptTokensP50` — percentile of warm `promptTokens` (used by the hit
  fraction).
- `cacheHitPct = min(warmCachedTokensP50 / warmPromptTokensP50, 1) × 100`
  (null when cached tokens are unreported or the prompt count is missing).
- `warmAccuracy` — share of warm runs whose answer mentions Paris.

### `calculateCacheCost({ promptTokens, cachedTokens, inputPrice, cachedInputPrice })`

```
cachedCount  = clamp(cachedTokens, 0, promptTokens)   // 0 when unreported
cachedPrice  = cachedInputPrice ?? inputPrice        // conservative fallback
cost         = ((promptTokens − cachedCount) × inputPrice
               + cachedCount × cachedPrice) / 1_000_000
```

Null when `promptTokens` or `inputPrice` is unknown. When `cachedInputPrice`
is missing, the cached share bills at the full `inputPrice` (the fallback the
user asked for), so rows without cached catalog pricing read 0% savings
rather than "-" — the honest "no known discount", correct the moment a cached
price is added. This is the **prompt-token cost only**; output tokens are
excluded from the row cost columns.

### `calculateCacheSavingsPct(coldCost, warmCost)`

```
(1 − warmCost / coldCost) × 100     // null if either is missing or cold ≤ 0
```

Savings are computed even without cached catalog pricing: the cost fallback
bills the cached share at the input price, so such rows read 0% until a
cached price is added.

Prices come from the model catalog (`inputPrice`, `cachedInputPrice` after
enrichment from `data/models-*.json`).

## 8. Configuration (form fields)

| Field | Input id | Default | Clamp | Notes |
|---|---|---|---|---|
| Padded prompt size (tokens) | `cache-payload` | 50000 | 1024..10,000,000 | Total prompt size for the padded variant (filler + question). Minimum stays above typical cacheable-prefix thresholds. |
| Runs per model | `cache-runs` | 5 | 1..50 | Warm repeats per variant. |
| Temperature | `cache-temperature` | 0 (provider default; blank for OpenAI) | 0..2, optional | Omitted from the body when blank. |
| Timeout / request (sec) | `cache-timeout` | 300 | 10..600 | Cold padded prefills are slow. |
| Require server token counts | `cache-require-server-tokens` | checked | — | Fails requests whose usage is missing (the cache split lives there). |
| Log to console | `cache-log-console` | unchecked | — | Standard redacted request/response logging. |

There is deliberately **no** thinking toggle and no concurrency setting
(models always run one at a time).

## 9. Results presentation

One row per **model × variant**.

Above the table sits a **TTFT chart, one per model**: three variant groups
(short / padded / busted), each with two bars — the cold request's TTFT
(muted) and the warm p50 (accent) — on a **log scale** (the y axis is
labeled just "TTFT"; the log scale keeps the tiny short variant visible
next to multi-second padded prefills). charts render in a responsive grid,
up to two per row, each capped at 640px so a lone chart does not stretch
full width. Each bar prints its TTFT number right above it; hovering a bar
shows its value, with the warm bar adding its improvement % ("0.9 s · 91%
faster"). Group labels under the x axis are the variant names only - no
savings line (cost savings live in the table). Gridlines sit at decades
(10 ms, 100 ms, 1 s, 10 s). Implemented in `renderCacheCharts` / `buildCacheModelChart`
(`js/cache-test1.js`), reusing the Decode Test's chart CSS
(`decode-line-chart`, `decode-grid`, `decode-tick`, `decode-tooltip`) plus
`cache-bar-cold` / `cache-bar-warm` / `cache-group-hit`.

Sorting uses the shared table constructor: every column header is
clickable. There is **no default sort** — rows appear in natural order
(models in execution order, each model's variants short → padded → busted)
until a header is clicked; the first click on any column sorts ascending.
The shared constructor supports this via `initialSortKey: null`. The column
picker controls visibility.

Columns (key → meaning):

| Key | Label | Value |
|---|---|---|
| `modelId` | Model | model id rendered without the vendor prefix (`openai/gpt-5.7` → `gpt-5.7`); the full id stays in the tooltip and exports |
| `status` | Status | per-variant status via `contextGroupStatus` (Queued / Running x/y / Completed x/y / Partial / Failed / Cancelled), where `perGroup = 1 + runsPerModel` |
| `payloadTokens` | Variant | `Short`, `Padded · <size>`, or `Busted · <size>` |
| `promptTokensP50` | Input tokens | median server-reported prompt tokens across the variant's requests (cold included) — compare with the configured size in the Variant column |
| `coldTtftMs` | Cold TTFT | cold request TTFT |
| `warmTtftP50` / `warmTtftP90` | Warm TTFT p50/p90 | warm repeat percentiles |
| `ttftReductionPct` | TTFT reduction | headline |
| `coldCachedTokens` | Cold cached tok | cold request's reported cached tokens |
| `warmCachedTokensP50` | Warm cached tok p50 | median warm cached tokens |
| `cachedTokensTotal` | Cached tokens (total) | cached tokens summed across the row's requests; hidden by default (column picker) |
| `cacheHitPct` | Cache hit | headline |
| `coldCost` / `warmCostP50` | Cold cost / Warm cost p50 | `calculateCacheCost` per request |
| `costSavingsPct` | Cost savings | headline; a "!" marker appears on the cell when the model has no cached catalog price and the number comes from the input-price fallback |
| `warmAccuracy` | Warm accuracy | share of warm repeats mentioning Paris |
| `testTimeMs` | Test time | wall-clock for the variant's requests; ticks live from the first request's dispatch |

Default visible columns: `modelId, status, payloadTokens, promptTokensP50,
coldTtftMs, warmTtftP50, ttftReductionPct, warmCachedTokensP50, cacheHitPct,
costSavingsPct, testTimeMs`. Everything else is in the column
picker; preferences persist under `llm-quick-bench:cache-columns:v1`.

Summary cards: Run time · Best TTFT reduction (max across rows) ·
Total tokens (all requests) · Estimated cost (actual input cost with cache
pricing + output cost; "+ unpriced" when pricing metadata is missing) ·
Cache savings (run-level: `1 − actualInputCost / noCacheInputCost`).

Exports (CSV/JSON) mirror the visible columns, one row per model × variant,
with a `TOTAL RUN` footer; test time exports in seconds; the JSON includes
`config`, `methodology`, `runSeed`, and `executionOrder`.

A sample exchange (request, raw streamed chunks, consolidated output with
grading + cache verdict) is captured from the **first warm padded repeat**
(`padded-warm-1`), head/tail-truncated at 48,000 characters.

## 10. Cross-benchmark locking

While the Cache Test runs, all other benchmark tabs are locked (and it is
locked while any of them runs):

- `cache-test1.js` exposes `cacheAbortController`,
  `isCacheBenchmarkRunning()`, `updateCacheRunButtonState()`, and
  `resetCacheResults()`.
- `speed-test1.js`, `thinking-test1.js`, `decode-test1.js`, and
  `context-bench.js` refuse to start while the Cache Test runs and disable its
  run button during their own runs (all through `typeof` guards so files stay
  independently loadable).
- Reloading models resets the Cache Test results
  (`resetCacheResults()` alongside `resetContextResults()`).

## 11. Reproduction checklist

1. Tab + panel: `index.html` — `cache-test-tab` button, `cache-test-panel`
   panel, `js/cache-test1.js` loaded last with `defer`.
2. Shared logic: `js/bench-utils.js` — `extractSseChunkData` (cached tokens),
   `runStreamingChatCompletion` (threads `cachedTokens` into the measurement),
   `generateCachePromptPayload`, `gradeCacheAnswer`, `summarizeCacheRuns`,
   `calculateCacheCost`, `calculateCacheSavingsPct`, and
   `createBenchmarkRun` (carries `cachedInputPerMillionTokens` in `pricing`).
3. Provider defaults: `js/presets.js` — `cache: { temperature: 0 }`, OpenAI
   override `cache: { temperature: null }`.
4. Benchmark file: `js/cache-test1.js` (config parsing, variant rows,
   sequence, rendering, exports, locking).
5. Tests: `tests/cache-test.test.js` (SSE cached-token extraction, payload
   determinism/freshness, grading, summary math, cost math, panel/locking
   structure, provider defaults) plus the updated shape assertion in
   `tests/bench-utils.test.js`.
6. Validate with `node --test tests/*.test.js`.

## 12. Known caveats (by design)

- Caches are strictly **prefix-based** and expire after minutes; repeats are
  sent back to back to stay inside the TTL. The test measures the happy path
  (one stable payload, immediate reuse), not partial-prefix overlap or TTL
  decay.
- The short variant may still show hits on endpoints with no minimum
  cacheable prefix (for example vLLM-style automatic prefix caching) — that
  is a finding, not a bug.
- The busted control's warm columns are meaningless by design (every request
  is a guaranteed miss); expect ~0% cache hit, ~0% TTFT reduction, and ~0%
  cost savings there. The padded-vs-busted contrast is the read.
- Endpoints that never report `cached_tokens` show "-" for cache metrics;
  TTFT reduction still works there.
