const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
const cacheSource = fs.readFileSync(path.join(projectRoot, "js", "cache-test1.js"), "utf8");
const presetsSource = fs.readFileSync(path.join(projectRoot, "js", "presets.js"), "utf8");

function fakeElement(tag = "div") {
  const element = {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    className: "",
    value: "",
    checked: false,
    textContent: "",
    hidden: false,
    classList: {
      _set: new Set(),
      add(...names) { names.forEach((name) => this._set.add(name)); },
      remove(...names) { names.forEach((name) => this._set.delete(name)); },
      toggle(name, force) {
        const on = force === undefined ? !this._set.has(name) : force;
        if (on) this._set.add(name); else this._set.delete(name);
        return on;
      },
      contains(name) { return this._set.has(name); },
    },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
    querySelector() { return fakeElement(); },
    querySelectorAll() { return []; },
  };
  return element;
}

function loadBenchUtils() {
  const renderErrors = [];
  const context = vm.createContext({
    AbortController,
    Blob,
    DOMException,
    Headers,
    ReadableStream,
    Response,
    TextDecoder,
    URL,
    clearTimeout,
    console: {
      error: (...args) => renderErrors.push(args),
      log: () => {},
      warn: () => {},
    },
    performance,
    setTimeout,
    document: {
      createElement: (tag) => fakeElement(tag),
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
  });
  const source = fs.readFileSync(path.join(projectRoot, "js", "bench-utils.js"), "utf8");
  vm.runInContext(`${source}\nthis.__benchUtils = {
    calculateCacheCost,
    calculateCacheSavingsPct,
    createBenchmarkTable,
    extractSseChunkData,
    parseSseLine,
    generateCachePromptPayload,
    gradeCacheAnswer,
    summarizeCacheRuns,
  };`, context);
  return { context, renderErrors, utils: context.__benchUtils };
}

function loadPresets() {
  const context = vm.createContext({});
  vm.runInContext(`${presetsSource}\nthis.__presets = {
    resolveTestRequestDefaults,
    TEST_REQUEST_DEFAULTS,
    PROVIDER_TEST_REQUEST_OVERRIDES,
  };`, context);
  return context.__presets;
}

test("SSE usage extraction reports cached prompt tokens", () => {
  const { utils } = loadBenchUtils();

  // OpenAI-compatible standard location.
  const standard = utils.extractSseChunkData(utils.parseSseLine(
    'data: {"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":96}}}',
  ));
  assert.equal(standard.promptTokens, 100);
  assert.equal(standard.cachedTokens, 96);

  // Top-level shorthand used by some OpenAI-compatible endpoints.
  const shorthand = utils.extractSseChunkData(utils.parseSseLine(
    'data: {"usage":{"prompt_tokens":100,"cached_tokens":80}}',
  ));
  assert.equal(shorthand.cachedTokens, 80);

  // No cache split reported: the honest null, not zero.
  const absent = utils.extractSseChunkData(utils.parseSseLine(
    'data: {"usage":{"prompt_tokens":100,"completion_tokens":5}}',
  ));
  assert.equal(absent.cachedTokens, null);

  // Zero cached tokens is a real value and must survive.
  const zero = utils.extractSseChunkData(utils.parseSseLine(
    'data: {"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":0}}}',
  ));
  assert.equal(zero.cachedTokens, 0);
});

test("SSE usage extraction reads Nebius prompt_cache_hit_tokens", () => {
  const { utils } = loadBenchUtils();

  // Positive hit through the Nebius field: prompt_tokens_details is null and
  // the split is reported top-level as hit/miss counts.
  const hit = utils.extractSseChunkData(utils.parseSseLine(
    'data: {"usage":{"prompt_tokens":7461,"completion_tokens":5,"prompt_tokens_details":null,"prompt_cache_hit_tokens":7400,"prompt_cache_miss_tokens":61}}',
  ));
  assert.equal(hit.cachedTokens, 7400);
  assert.equal(hit.promptTokens, 7461);

  // Zero through the Nebius field is a real zero, not an unknown.
  const zero = utils.extractSseChunkData(utils.parseSseLine(
    'data: {"usage":{"prompt_tokens":7461,"completion_tokens":5,"prompt_tokens_details":null,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":7461}}',
  ));
  assert.equal(zero.cachedTokens, 0);

  // Real captured shape from zai-org/GLM-5.3-Flash on Nebius Token Factory
  // (16K cache-test payload): reasoning tokens included, no caching at all.
  // Regression guard for the model that exposed the missing field.
  const glm = utils.extractSseChunkData(utils.parseSseLine(
    'data: {"usage":{"completion_tokens":39,"prompt_tokens":14989,"total_tokens":15028,"completion_tokens_details":{"reasoning_tokens":37},"prompt_tokens_details":null,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":14989,"reasoning_tokens":37}}',
  ));
  assert.equal(glm.promptTokens, 14989);
  assert.equal(glm.cachedTokens, 0);
  assert.equal(glm.reasoningTokens, 37);

  // Real captured shape from Qwen/Qwen3-30B-A3B-Instruct-2507 on the same
  // provider: the standard field, near-total hit.
  const qwen = utils.extractSseChunkData(utils.parseSseLine(
    'data: {"usage":{"prompt_tokens":8417,"total_tokens":8419,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":8416}}}',
  ));
  assert.equal(qwen.promptTokens, 8417);
  assert.equal(qwen.cachedTokens, 8416);
});

test("SSE cache-token extraction prefers the standard field over the shorthands", () => {
  const { utils } = loadBenchUtils();

  // All three fields present: the OpenAI-compatible standard field wins.
  const allThree = utils.extractSseChunkData(utils.parseSseLine(
    'data: {"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":96},"cached_tokens":80,"prompt_cache_hit_tokens":70}}',
  ));
  assert.equal(allThree.cachedTokens, 96);

  // Standard field absent: the top-level cached_tokens shorthand wins over
  // the Nebius field.
  const shorthandAndNebius = utils.extractSseChunkData(utils.parseSseLine(
    'data: {"usage":{"prompt_tokens":100,"cached_tokens":80,"prompt_cache_hit_tokens":70}}',
  ));
  assert.equal(shorthandAndNebius.cachedTokens, 80);

  // Only the Nebius field: it is used.
  const nebiusOnly = utils.extractSseChunkData(utils.parseSseLine(
    'data: {"usage":{"prompt_tokens":100,"prompt_cache_hit_tokens":70}}',
  ));
  assert.equal(nebiusOnly.cachedTokens, 70);
});

test("cache prompt payload builds short and padded variants", () => {
  const { utils } = loadBenchUtils();

  const short = utils.generateCachePromptPayload({ runSeed: 42, payloadIndex: 0, targetTokens: 0 });
  assert.equal(short.padded, false);
  assert.equal(short.lineCount, 0);
  assert.match(short.prompt, /What is the capital of France\? Answer with the city name only\./);
  assert.ok(short.estimatedTokens < 30);

  const padded = utils.generateCachePromptPayload({ runSeed: 42, payloadIndex: 1, targetTokens: 50000 });
  assert.equal(padded.padded, true);
  assert.ok(padded.lineCount > 8, "the padded payload carries a filler document");
  // The WHOLE prompt (wrapper + filler + question) matches the configured
  // size, within the slack of one final filler line.
  assert.ok(padded.estimatedTokens >= 50000, `payload reaches the target (got ${padded.estimatedTokens})`);
  assert.ok(padded.estimatedTokens < 50100, `payload stays at the target (got ${padded.estimatedTokens})`);
  assert.match(padded.prompt, /--- CONTEXT START ---/);
  assert.match(padded.prompt, /--- CONTEXT END ---/);
  // The question stays the last line so the payload ends identically every time.
  assert.ok(padded.prompt.trimEnd().endsWith("What is the capital of France? Answer with the city name only."));

  // Same seed: byte-identical payload (the premise of the test).
  const paddedAgain = utils.generateCachePromptPayload({ runSeed: 42, payloadIndex: 1, targetTokens: 50000 });
  assert.equal(padded.prompt, paddedAgain.prompt);

  // Fresh seed: new padding, so a re-run cannot measure a previously warmed cache.
  const repadded = utils.generateCachePromptPayload({ runSeed: 43, payloadIndex: 1, targetTokens: 50000 });
  assert.notEqual(padded.prompt, repadded.prompt);
  // Different models get different payloads too.
  const otherModel = utils.generateCachePromptPayload({ runSeed: 42, payloadIndex: 3, targetTokens: 50000 });
  assert.notEqual(padded.prompt, otherModel.prompt);
});

test("cache grading accepts any answer that mentions Paris", () => {
  const { utils } = loadBenchUtils();
  assert.equal(utils.gradeCacheAnswer("Paris"), true);
  assert.equal(utils.gradeCacheAnswer("The capital of France is Paris."), true);
  assert.equal(utils.gradeCacheAnswer("paris "), true);
  assert.equal(utils.gradeCacheAnswer("London"), false);
  assert.equal(utils.gradeCacheAnswer(""), false);
  assert.equal(utils.gradeCacheAnswer(null), false);
});

test("summarizeCacheRuns splits cold and warm phases", () => {
  const { utils } = loadBenchUtils();
  const runs = [
    { phase: "cold", ttftMs: 10000, promptTokens: 50000, cachedTokens: 0, correct: true },
    { phase: "warm", ttftMs: 2000, promptTokens: 50000, cachedTokens: 48000, correct: true },
    { phase: "warm", ttftMs: 2400, promptTokens: 50000, cachedTokens: 49000, correct: true },
    { phase: "warm", ttftMs: 1800, promptTokens: 50000, cachedTokens: 50000, correct: false },
  ];
  const summary = utils.summarizeCacheRuns(runs, 0);
  assert.equal(summary.coldRuns, 1);
  assert.equal(summary.warmRuns, 3);
  assert.equal(summary.coldTtftMs, 10000);
  // Input tokens: median server-reported prompt size across ALL requests.
  assert.equal(summary.promptTokensP50, 50000);
  // Nearest-rank p50 of [1800, 2000, 2400] is 2000; p90 is the slowest, 2400.
  assert.equal(summary.warmTtftP50, 2000);
  assert.equal(summary.warmTtftP90, 2400);
  assert.ok(Math.abs(summary.ttftReductionPct - 80) < 1e-9);
  // p50 of [48000, 49000, 50000] is 49000 -> 98% of 50000.
  assert.ok(Math.abs(summary.cacheHitPct - 98) < 1e-9);
  assert.ok(Math.abs(summary.warmAccuracy - 2 / 3) < 1e-9);

  // Without server-reported cached tokens the hit fraction stays unknown.
  const unreported = utils.summarizeCacheRuns([
    { phase: "cold", ttftMs: 900, promptTokens: 12 },
    { phase: "warm", ttftMs: 500, promptTokens: 12 },
  ], 0);
  assert.equal(unreported.cacheHitPct, null);
  assert.equal(unreported.warmCachedTokensP50, null);

  // Server-reported zeros (the Nebius GLM-5.3-Flash shape) are a real 0%
  // cache hit, not an unknown.
  const reportedZeros = utils.summarizeCacheRuns([
    { phase: "cold", ttftMs: 2387, promptTokens: 14989, cachedTokens: 0 },
    { phase: "warm", ttftMs: 1200, promptTokens: 14989, cachedTokens: 0 },
    { phase: "warm", ttftMs: 1236, promptTokens: 14989, cachedTokens: 0 },
  ], 0);
  assert.equal(reportedZeros.cacheHitPct, 0);
  assert.equal(reportedZeros.warmCachedTokensP50, 0);
  // No cache hit means no TTFT reduction worth reporting beyond noise.
  assert.ok(Math.abs(reportedZeros.ttftReductionPct - ((2387 - 1200) / 2387) * 100) < 1e-9);

  // A cold-only partial run has no warm stats to report.
  const coldOnly = utils.summarizeCacheRuns([
    { phase: "cold", ttftMs: 900, promptTokens: 12, cachedTokens: 0 },
  ], 2);
  assert.equal(coldOnly.warmTtftP50, null);
  assert.equal(coldOnly.ttftReductionPct, null);
  assert.equal(coldOnly.failedRuns, 2);
});

test("cache cost math splits cached and uncached prompt tokens", () => {
  const { utils } = loadBenchUtils();

  const full = utils.calculateCacheCost({
    promptTokens: 50000,
    cachedTokens: 0,
    inputPrice: 2,
    cachedInputPrice: 0.2,
  });
  assert.ok(Math.abs(full - 0.1) < 1e-12);

  const cached = utils.calculateCacheCost({
    promptTokens: 50000,
    cachedTokens: 50000,
    inputPrice: 2,
    cachedInputPrice: 0.2,
  });
  assert.ok(Math.abs(cached - 0.01) < 1e-12);

  const mixed = utils.calculateCacheCost({
    promptTokens: 50000,
    cachedTokens: 48000,
    inputPrice: 2,
    cachedInputPrice: 0.2,
  });
  assert.ok(Math.abs(mixed - (2000 * 2 + 48000 * 0.2) / 1_000_000) < 1e-12);

  // No cached price metadata: the cached share bills at the full input price.
  const unpriced = utils.calculateCacheCost({
    promptTokens: 50000,
    cachedTokens: 50000,
    inputPrice: 2,
    cachedInputPrice: null,
  });
  assert.ok(Math.abs(unpriced - 0.1) < 1e-12);

  // Cached counts clamp to the prompt total; unknowns stay null.
  const clamped = utils.calculateCacheCost({
    promptTokens: 100,
    cachedTokens: 500,
    inputPrice: 2,
    cachedInputPrice: 0.2,
  });
  assert.ok(Math.abs(clamped - 100 * 0.2 / 1_000_000) < 1e-12);
  assert.equal(utils.calculateCacheCost({ promptTokens: null, cachedTokens: 0, inputPrice: 2, cachedInputPrice: 0.2 }), null);
  assert.equal(utils.calculateCacheCost({ promptTokens: 100, cachedTokens: 0, inputPrice: null, cachedInputPrice: 0.2 }), null);

  assert.ok(Math.abs(utils.calculateCacheSavingsPct(0.1, 0.01) - 90) < 1e-9);
  assert.equal(utils.calculateCacheSavingsPct(null, 0.01), null);
  assert.equal(utils.calculateCacheSavingsPct(0, 0.01), null);
});

test("Cache Test form defaults and variants follow the bench conventions", () => {
  const panel = html.slice(html.indexOf('id="cache-test-panel"'));
  assert.match(panel, /<label for="cache-payload">Padded prompt size \(tokens\)<\/label>/);
  assert.match(panel, /id="cache-payload"[^>]*min="1024" max="10000000" value="50000"/);
  assert.match(panel, /<label for="cache-runs">Runs per model<\/label>/);
  assert.match(panel, /id="cache-runs"[^>]*min="1" max="50" value="5"/);
  assert.match(panel, /id="cache-require-server-tokens"[^>]*checked/);
  assert.match(html, /id="cache-test-tab"[^>]*>\s*Cache Test\s*</);

  // No thinking toggle by design: the request body sends no
  // chat_template_kwargs, matching the long-context tests.
  assert.doesNotMatch(panel, /cache-disable-thinking/);
  assert.doesNotMatch(cacheSource, /disableThinking|enable_thinking|chat_template_kwargs/);

  // The cached-token columns exist, including the summed Cached tokens column.
  assert.match(panel, /data-cache-column="coldCachedTokens"/);
  assert.match(panel, /data-cache-column="warmCachedTokensP50"/);
  assert.match(panel, /data-cache-column="cachedTokensTotal"/);
  assert.match(panel, /data-cache-column="cachedTokensTotal"[^>]*>.*?<span>Cached tokens \(total\)<\/span>/s);

  // Standard sortable table via the shared constructor: every column header
  // is clickable, defaulting to TTFT reduction descending.
  assert.match(panel, /data-cache-column="ttftReductionPct"[^>]*>.*?<span>TTFT reduction<\/span>/s);
  assert.ok(
    (panel.match(/class="sort-button"/g) ?? []).length >= 17,
    "every cache table column header is a clickable sort button",
  );
  assert.match(cacheSource, /cacheTable\.bindHeaders\(\)/);
  assert.match(cacheSource, /const views = cacheTable\.sortRows\(rows, getCacheSortValue\);/);
  // No default sort: rows appear in natural order (model, then short →
  // padded → busted) until a header is clicked.
  assert.match(cacheSource, /initialSortKey: null,/);
  // Model names render via the shared shortModelLabel (catalog name or
  // vendor-stripped id); the full id stays in the tooltip and the exports.
  assert.match(cacheSource, /cell\.textContent = shortModelLabel\(result\.modelId\)/);
  // The cost-savings cell carries a "!" marker when the catalog has no cached
  // price and the number comes from the input-price fallback; the marker uses
  // the app's instant styled tooltip, not a slow native title.
  assert.match(cacheSource, /cache-price-fallback-indicator/);
  assert.match(cacheSource, /No cached pricing found, using default pricing/);
  assert.match(cacheSource, /showBenchmarkErrorTooltip\(indicator, fallbackMessage\)/);

  // Config: clamped payload with fallback, runs per model, optional temperature.
  assert.match(cacheSource, /const DEFAULT_CACHE_PAYLOAD_TOKENS = 50000;/);
  assert.match(cacheSource, /runsPerModel: clampInteger\(cacheRunsInput\.value, 1, 50\)/);
  assert.match(cacheSource, /temperature: parseOptionalClampedNumber\(cacheTemperatureInput\.value, 0, 2\)/);
  assert.match(cacheSource, /requireServerTokenCounts: cacheRequireServerTokensInput\.checked/);
});

test("live request template renders from a capped sample above the cap", () => {
  // The template is regenerated on every keystroke of the config fields, so
  // above CACHE_TEMPLATE_SAMPLE_TOKENS the preview must not rebuild the full
  // (potentially multi-megabyte) payload: it renders from a capped sample at
  // the same seed, whose head and tail lines are byte-identical to the real
  // payload's. The full payload is only built on run (confirm dialog and
  // benchmark), once per click.
  assert.match(cacheSource, /CACHE_TEMPLATE_SAMPLE_TOKENS = \d+;/);
  assert.match(cacheSource, /config\.payloadTokens > CACHE_TEMPLATE_SAMPLE_TOKENS/);
  assert.match(
    cacheSource,
    /sampleCapped \? CACHE_TEMPLATE_SAMPLE_TOKENS : config\.payloadTokens/,
  );
  // Capped previews describe the configured size instead of the sample's
  // misleading filler count; uncapped previews keep the exact count.
  assert.match(cacheSource, /cappedNote = null/);
  assert.match(
    cacheSource,
    /cappedNote \?\? `… \$\{omitted\} filler lines omitted/,
  );
  // The template no longer builds the full payload inline; the old
  // single-line full-size build must be gone.
  assert.doesNotMatch(cacheSource, /payloadIndex: 1, targetTokens: config\.payloadTokens\)/);
});

test("Cache Test request bodies stay byte-identical within short and padded variants", () => {
  const panel = html.slice(html.indexOf('id="cache-test-panel"'));
  // The shared context-bench engine tags every prompt with a unique
  // "Request id:" prefix, which would defeat prefix caching. The Cache Test
  // must not do that for the short and padded variants: one body object per
  // variant is reused for the cold request and every repeat.
  assert.doesNotMatch(cacheSource, /Request id:/);
  // The non-busted branch of the per-request body selection resends the
  // stable per-variant body; the busted branch rebuilds around a fresh nonce.
  assert.match(cacheSource, /: plan\.body;/);
  assert.match(cacheSource, /: buildCacheRequestBody\(result\.modelId, config, payload\.prompt, connection\.provider\),/);
  // Three variants: short, padded, and the nonce-busted control.
  assert.match(cacheSource, /key: "short"/);
  assert.match(cacheSource, /key: "padded"/);
  assert.match(cacheSource, /key: "busted"/);
  assert.match(cacheSource, /bustsCache: true/);
  // The busted control prepends a fresh nonce as the very first line of
  // every request, so the prefix cache can never match.
  assert.match(cacheSource, /function generateCacheNonce\(\)/);
  assert.match(cacheSource, /generateCacheNonce\(\)\}\\n\$\{plan\.payload\.prompt\}/);
  // It reuses the padded variant's filler, so its prompt differs from the
  // padded prompt only by the nonce.
  assert.match(cacheSource, /sharesPaddedFiller/);
  // The plain variant is the bare question; the padded variant pads it.
  assert.match(cacheSource, /targetTokens: variant\.targetTokens/);
  assert.match(cacheSource, /generateCachePromptPayload\(\{\s*runSeed,/);

  // The cold-vs-warm chart sits above the table: one per model, log-scale
  // TTFT bars per variant, with hover tooltips reusing the decode chart CSS.
  assert.match(panel, /id="cache-chart"/);
  assert.match(panel, /TTFT: cold vs warm/);
  assert.match(cacheSource, /function renderCacheCharts/);
  assert.match(cacheSource, /function buildCacheModelChart/);
  assert.match(cacheSource, /renderCacheCharts\(rows\);/);
  // Hovering a bar shows its value; the warm (green) bar also carries its
  // improvement %.
  assert.match(cacheSource, /rect\.cache-bar-cold, rect\.cache-bar-warm/);
  assert.match(cacheSource, /tooltip\.textContent = bar\.dataset\.tooltip;/);
  assert.doesNotMatch(cacheSource, /cache-group-hit/);
  // No savings label under the x-axis groups - savings live in the table.
  assert.doesNotMatch(cacheSource, /cache-savings-label/);
  assert.doesNotMatch(cacheSource, /savings \$\{formatCachePercent/);

  // The pre-run dialog uses short model names and the widened shared dialog.
  assert.match(cacheSource, /label: shortModelLabel\(model\.modelId\)/);
  assert.match(cacheSource, /title: plan\.modelId,/);
  // The dialog's per-model rows render as a table: model | notes | cost.
  const benchSource = fs.readFileSync(path.join(projectRoot, "js", "bench-utils.js"), "utf8");
  assert.match(benchSource, /className = "confirm-table"/);
  assert.match(benchSource, /\["Model", "Notes", "Cost \(estimated\)"\]/);

  // Cross-benchmark locking: the other benchmarks refuse to start while the
  // Cache Test runs, and the Cache Test refuses while they run.
  assert.match(cacheSource, /Cache Test is already running\./);
  assert.match(cacheSource, /typeof isAnyContextBenchmarkRunning === "function" && isAnyContextBenchmarkRunning\(\)/);
  const speedSource = fs.readFileSync(path.join(projectRoot, "js", "speed-test1.js"), "utf8");
  const thinkingSource = fs.readFileSync(path.join(projectRoot, "js", "thinking-test1.js"), "utf8");
  const decodeSource = fs.readFileSync(path.join(projectRoot, "js", "decode-test1.js"), "utf8");
  const contextSource = fs.readFileSync(path.join(projectRoot, "js", "context-bench.js"), "utf8");
  assert.match(speedSource, /isCacheBenchmarkRunningSafely/);
  assert.match(speedSource, /resetCacheResults/);
  assert.match(thinkingSource, /Cache Test is already running\./);
  assert.match(decodeSource, /Cache Test is already running\./);
  assert.match(contextSource, /Cache Test is already running\./);
  // Pre-run preview is the site-wide default: selected models appear as
  // Queued rows before any benchmark starts.
  assert.match(speedSource, /previewBenchmarkResults\(\)/);
  assert.match(thinkingSource, /previewBenchmarkResults\(\)/);
  assert.match(decodeSource, /MODELS\.filter\(\(model\) => model\.selected\)/);
  assert.match(cacheSource, /MODELS\.filter\(\(model\) => model\.selected\)/);

  // The tab and script wiring exist and load after the shared engine.
  assert.match(html, /js\/cache-test1\.js" defer><\/script>/);
  assert.ok(
    html.indexOf('js/context-bench.js" defer></script>') < html.indexOf('js/cache-test1.js" defer></script>'),
    "cache-test1.js loads after context-bench.js",
  );
});

test("provider defaults include the cache test with blank temperature for OpenAI", () => {
  const presets = loadPresets();
  // Compare fields directly: objects built inside the vm realm have a
  // different Object.prototype, so deepEqual reports reference inequality.
  const nebiusDefaults = presets.resolveTestRequestDefaults("cache", "nebius");
  assert.equal(nebiusDefaults.temperature, 0);
  assert.equal("disableThinking" in nebiusDefaults, false);
  const openaiDefaults = presets.resolveTestRequestDefaults("cache", "openai");
  assert.equal(openaiDefaults.temperature, null);
  assert.equal("disableThinking" in openaiDefaults, false);
});

test("column picker supports plain non-sortable headers (Cache Test regression)", () => {
  const { context, utils } = loadBenchUtils();
  // Headers without a sort button: querySelector("button span") returns null.
  // This exact shape crashed the whole cache-test1.js script at page load
  // before the fallback existed, leaving the run button disabled forever.
  const container = context.document.createElement("div");
  const headers = ["alpha", "beta"].map((key) => {
    const header = context.document.createElement("th");
    header.dataset.cacheColumn = key;
    header.textContent = `${key} label`;
    header.querySelector = () => null;
    return header;
  });
  const table = utils.createBenchmarkTable({
    headers,
    columnAttr: "cacheColumn",
    preferenceKey: "llm-quick-bench:test-plain-headers",
    defaultColumns: ["alpha", "beta"],
    initialSortKey: "alpha",
    pickerContainer: container,
    showAllButton: context.document.createElement("button"),
  });
  assert.deepEqual(table.allKeys, ["alpha", "beta"]);
  assert.equal(container.children.length, 2, "one picker option per header");
});
