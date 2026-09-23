class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.status = statusCode;
  }
}

function isSecureEndpoint(rawEndpoint) {
  let url;
  try {
    url = new URL(rawEndpoint.trim());
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    // `URL.hostname` returns IPv6 hosts in the bracketed form (e.g. "[::1]"),
    // per the WHATWG URL host serializer, so the comparison must use brackets.
    const host = url.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  }
  return false;
}

function buildApiUrl(rawEndpoint, resourcePath) {
  const url = new URL(rawEndpoint.trim());
  const basePath = url.pathname
    .replace(/\/(models|chat\/completions)\/?$/i, "")
    .replace(/\/+$/, "");
  url.pathname = `${basePath}/${resourcePath}`;
  url.hash = "";
  return url;
}

function buildChatCompletionsUrl(rawEndpoint) {
  const url = buildApiUrl(rawEndpoint, "chat/completions");
  return url.toString();
}

function buildApiHeaders(apiKey, { accept, contentType } = {}) {
  const headers = {};
  if (accept) headers.Accept = accept;
  if (contentType) headers["Content-Type"] = contentType;
  headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function formatBenchmarkRequest(requestUrl, body) {
  const headers = buildApiHeaders("[REDACTED]", {
    accept: "text/event-stream",
    contentType: "application/json",
  });
  return [
    `POST ${requestUrl}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    JSON.stringify(body, null, 2),
  ].join("\n");
}

async function runWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  let failure = null;
  async function runWorker() {
    while (nextIndex < items.length && failure == null) {
      const item = items[nextIndex];
      nextIndex += 1;
      try {
        await worker(item);
      } catch (error) {
        failure ??= error;
      }
    }
  }
  // Wait for every worker to finish its in-flight item before rejecting, so the
  // caller never sees a failure while other items are still mutating shared state.
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
  if (failure != null) throw failure;
}

// Drives a callback roughly once per `intervalMs` using requestAnimationFrame,
// so the live test-time clock ticks without setInterval's fixed-wakeup cost and
// pauses automatically when the tab is hidden. Returns a stop() function.
function startThrottledClock(callback, intervalMs = 1000) {
  let rafId = 0;
  let lastFire = 0;
  const loop = (now) => {
    if (now - lastFire >= intervalMs) {
      lastFire = now;
      callback(now);
    }
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(rafId);
}

function shuffleWithSeed(items, seed) {
  let state = seed >>> 0;
  const random = () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

function percentile(values, probability) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)];
}

function summarizeRuns(runs) {
  const tokensPerSecond = runs.map((run) => run.tokensPerSecond);
  return {
    ttftMedian: percentile(runs.map((run) => run.ttftMs), 0.5),
    ttftP95: percentile(runs.map((run) => run.ttftMs), 0.95),
    e2eMedian: percentile(runs.map((run) => run.endToEndLatencyMs), 0.5),
    e2eP95: percentile(runs.map((run) => run.endToEndLatencyMs), 0.95),
    tpsMin: tokensPerSecond.length > 0 ? Math.min(...tokensPerSecond) : null,
    tpsMedian: percentile(tokensPerSecond, 0.5),
    tpsMax: tokensPerSecond.length > 0 ? Math.max(...tokensPerSecond) : null,
  };
}

function buildRunThroughputSeries(runs) {
  return runs
    .filter((run) => Number.isFinite(run.index) && Number.isFinite(run.tokensPerSecond))
    .map((run) => ({
      runNumber: run.index,
      tokensPerSecond: run.tokensPerSecond,
    }))
    .sort((left, right) => left.runNumber - right.runNumber);
}

// --- Pure benchmark view-model helpers (unit-tested without a DOM) ---

// Splits a server-reported combined completion-token total into an estimated
// reasoning share and the remaining visible (final content) tokens, using the
// proportion of streamed reasoning vs. total output characters. Shared by Speed
// Test 1 (as answerTokens), Thinking Test 1, and the Decode Test.
function splitCompletionTokens(completionTokens, reasoningCharacters, outputCharacters) {
  const total = Number.isFinite(completionTokens) ? Math.max(0, Math.round(completionTokens)) : 0;
  if (total === 0 || !Number.isFinite(outputCharacters) || outputCharacters <= 0) {
    return { reasoningTokens: 0, visibleOutputTokens: total };
  }
  const reasoningChars = Number.isFinite(reasoningCharacters) ? Math.max(0, reasoningCharacters) : 0;
  const reasoningTokens = Math.min(total, Math.max(0, Math.round((reasoningChars / outputCharacters) * total)));
  return { reasoningTokens, visibleOutputTokens: total - reasoningTokens };
}

// Client-observed decode speed: visible tokens generated after the first token,
// divided by the time between the first and last visible token. The first token
// is subtracted from the numerator because it is not part of the decode interval.
function calculateDecodeTokensPerSecond(visibleOutputTokens, decodeTimeMs) {
  if (!Number.isFinite(visibleOutputTokens) || visibleOutputTokens <= 1) return null;
  if (!Number.isFinite(decodeTimeMs) || decodeTimeMs <= 0) return null;
  return (visibleOutputTokens - 1) / (decodeTimeMs / 1000);
}

// Aggregates a group of identical Decode Test runs (same model + output length):
// p50 decode speed, p50/p90 TTFT and total latency, plus p50 decode time, visible
// tokens, and reasoning tokens. Percentiles use nearest-rank selection.
function summarizeDecodeRuns(runs) {
  const values = (key) => runs.map((run) => run[key]).filter(Number.isFinite);
  const decodeValues = values("decodeTokensPerSecond");
  return {
    decodeTpsP50: percentile(decodeValues, 0.5),
    decodeTpsMin: decodeValues.length > 0 ? Math.min(...decodeValues) : null,
    decodeTpsMax: decodeValues.length > 0 ? Math.max(...decodeValues) : null,
    ttftP50: percentile(values("ttftMs"), 0.5),
    ttftP90: percentile(values("ttftMs"), 0.9),
    decodeTimeP50: percentile(values("decodeTimeMs"), 0.5),
    totalLatencyP50: percentile(values("totalLatencyMs"), 0.5),
    totalLatencyP90: percentile(values("totalLatencyMs"), 0.9),
    visibleTokensP50: percentile(values("visibleOutputTokens"), 0.5),
    reasoningTokensP50: percentile(values("reasoningTokens"), 0.5),
    reasoningRequired: runs.some((run) => run.reasoningRequired),
    completed: runs.length,
  };
}

// Parses the Decode Test's comma-separated output-lengths field into an
// ascending, deduplicated list of integers. Blank and non-numeric entries are
// skipped; each remaining value is clamped to [minLength, maxLength] like
// clampInteger. Returns an empty array when nothing valid remains so callers
// can apply their own fallback (the benchmark defaults to 100, 500, 1000).
function parseDecodeOutputTokenOptions(raw, { minLength = 1, maxLength = 100000 } = {}) {
  const lengths = [];
  String(raw ?? "").split(",").forEach((part) => {
    const trimmed = part.trim();
    if (trimmed === "") return;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;
    const length = Math.min(maxLength, Math.max(minLength, Math.round(parsed)));
    if (!lengths.includes(length)) lengths.push(length);
  });
  return lengths.sort((a, b) => a - b);
}

// Maps a 0-based measured run index to the output length of its group. Warm-ups
// (index -1) use the first length. Runs are grouped in order: the first
// `runsPerConfig` runs use the first length, the next group the second, and so on.
function decodeOutputTokensForRun(runIndex, outputTokenLengths, runsPerConfig) {
  const group = runIndex >= 0 ? Math.floor(runIndex / runsPerConfig) : 0;
  return outputTokenLengths[group] ?? outputTokenLengths[0];
}

// Flattens model results into one presentation row per model × output length.
// Each row carries the group's completed runs, its failed-run count (failed
// measured runs are bucketed by their 1-based run number), and an aggregate
// summary, so rows exist before a run finishes and fill in live during a run.
function buildDecodeRunRows(results, outputTokenLengths, runsPerConfig) {
  const rows = [];
  results.forEach((result) => {
    outputTokenLengths.forEach((length, lengthIndex) => {
      const runs = result.runs.filter((run) => run.outputTokens === length);
      const failed = (result.errors ?? []).filter(
        (error) => Number.isInteger(error.run)
          && Math.floor((error.run - 1) / runsPerConfig) === lengthIndex,
      ).length;
      rows.push({
        modelId: result.modelId,
        length,
        lengthIndex,
        runs,
        failed,
        perGroup: runsPerConfig,
        result,
        summary: summarizeDecodeRuns(runs),
      });
    });
  });
  return rows;
}

// Per-group status so each model's output-length tests are visibly run one length
// at a time. `lengthIndex` is the 0-based position of this length in the sequence.
function decodeGroupStatus({ result, runs, failed, perGroup, lengthIndex }) {
  const progress = `${runs.length}/${perGroup}`;
  if (!result) return { text: "-", className: "" };
  if (runs.length + failed >= perGroup) {
    if (failed === 0) return { text: `Completed ${progress}`, className: "complete" };
    return runs.length > 0
      ? { text: `Partial ${progress}`, className: "partial" }
      : { text: `Failed ${progress}`, className: "error" };
  }
  const activeMatch = /^run (\d+)\/(\d+)$/i.exec(result.status);
  if (activeMatch) {
    const activeGroup = Math.floor((Number(activeMatch[1]) - 1) / perGroup);
    if (lengthIndex === activeGroup) {
      return { text: `Running ${progress}`, className: "running" };
    }
    if (lengthIndex < activeGroup) {
      return failed > 0
        ? { text: `Partial ${progress}`, className: "partial" }
        : { text: `Completed ${progress}`, className: "complete" };
    }
    return { text: "Waiting", className: "" };
  }
  if (result.status === "warming") return { text: `Warming up ${progress}`, className: "running" };
  if (result.status === "queued") {
    return runs.length > 0
      ? { text: `Partial ${progress}`, className: "partial" }
      : { text: "Queued", className: "" };
  }
  if (result.status === "cancelled") {
    return { text: `Cancelled ${progress}`, className: "running" };
  }
  if (result.status === "error") return { text: `Error ${progress}`, className: "error" };
  if (failed > 0) return { text: `Partial ${progress}`, className: "partial" };
  return { text: "Waiting", className: "" };
}

// Pivots the per-length rows into one row per model, with a p50 decode-speed
// value keyed as `tps<length>` plus a `byLength` map for the chart.
function buildDecodeMatrixRows(runRows, outputTokenLengths) {
  const byModel = new Map();
  runRows.forEach((view) => {
    if (!byModel.has(view.modelId)) {
      byModel.set(view.modelId, { modelId: view.modelId, byLength: new Map() });
    }
    byModel.get(view.modelId).byLength.set(view.length, view.summary.decodeTpsP50);
  });
  return [...byModel.values()].map((entry) => {
    const row = { modelId: entry.modelId, byLength: entry.byLength };
    outputTokenLengths.forEach((length) => {
      row[`tps${length}`] = entry.byLength.get(length) ?? null;
    });
    return row;
  });
}

// Maps a shared streaming result onto the Decode Test metric set. Visible-token
// timing comes from the content-only clocks tracked by runStreamingChatCompletion,
// so reasoning tokens never contribute to decode speed or TTFT. Prefers the
// provider's exact reasoning-token count; falls back to the character-proportional
// estimate when the endpoint does not break it out.
function buildDecodeMeasurement(stream, config, outputTokens, fixedLengthApplied = Boolean(config.fixedOutput)) {
  const completionTokens = stream.measurement.completionTokens;
  const serverReasoningTokens = stream.measurement.serverReasoningTokens;
  const hasServerReasoning = Number.isFinite(serverReasoningTokens);
  const estimated = splitCompletionTokens(
    completionTokens,
    stream.reasoningText.length,
    stream.outputText.length,
  );
  const reasoningTokens = hasServerReasoning
    ? Math.min(completionTokens, Math.max(0, serverReasoningTokens))
    : estimated.reasoningTokens;
  const visibleOutputTokens = hasServerReasoning
    ? Math.max(0, completionTokens - reasoningTokens)
    : estimated.visibleOutputTokens;
  const reasoningTokenSource = hasServerReasoning ? "server" : "estimated";
  const ttftMs = stream.measurement.ttftContentMs;
  const lastVisibleTokenMs = stream.measurement.lastContentTokenMs;
  const decodeTimeMs = Number.isFinite(ttftMs) && Number.isFinite(lastVisibleTokenMs)
    ? Math.max(0, lastVisibleTokenMs - ttftMs)
    : null;
  const decodeTokensPerSecond = calculateDecodeTokensPerSecond(visibleOutputTokens, decodeTimeMs);
  const reasoningRequired = reasoningTokens > 0 || stream.reasoningText.length > 0;
  return {
    ...stream.measurement,
    // Override the shared first-token TTFT with the Decode Test definition: the
    // first *visible* output token, not the first reasoning delta.
    firstAnyTokenMs: stream.measurement.ttftMs,
    ttftMs,
    lastVisibleTokenMs,
    decodeTimeMs,
    totalLatencyMs: stream.measurement.endToEndLatencyMs,
    visibleOutputTokens,
    reasoningTokens,
    reasoningTokenSource,
    decodeTokensPerSecond,
    reasoningRequired,
    thinkingDisabled: Boolean(config.disableThinking) && !reasoningRequired,
    fixedLengthApplied,
    outputTokens,
  };
}

function calculateCostPerCorrect(cost, correctCount) {
  return cost === null || cost === undefined || correctCount <= 0
    ? null
    : cost / correctCount;
}

function calculateAggregateCostPerCorrect(usage, correctCount) {
  if (usage.hasUnpriced || usage.pricedUsageCount <= 0) return null;
  return calculateCostPerCorrect(usage.cost, correctCount);
}

function deriveBenchmarkRunStatus(results, { wasAborted = false, orchestrationFailed = false } = {}) {
  if (wasAborted) return "cancelled";
  if (orchestrationFailed || !Array.isArray(results) || results.length === 0) return "error";
  if (results.every((result) => result.status === "complete")) return "complete";
  return results.some((result) => result.runs.length > 0) ? "partial" : "error";
}

function summarizeThinkingAccuracy(result) {
  const runs = Array.isArray(result?.runs) ? result.runs : [];
  const measuredFailures = Array.isArray(result?.errors)
    ? result.errors.filter((error) => Number.isInteger(error?.run) && error.run > 0).length
    : 0;
  const total = runs.length + measuredFailures;
  const correct = runs.filter((run) => run.correct).length;
  const compliant = runs.filter((run) => run.formatCompliant).length;
  return {
    correct,
    compliant,
    total,
    successful: runs.length,
    failed: measuredFailures,
    accuracy: total > 0 ? correct / total : null,
    formatCompliance: total > 0 ? compliant / total : null,
  };
}

function summarizeRunThinkingAccuracy(results) {
  return results.reduce((total, result) => {
    const accuracy = summarizeThinkingAccuracy(result);
    total.correct += accuracy.correct;
    total.compliant += accuracy.compliant;
    total.total += accuracy.total;
    total.successful += accuracy.successful;
    total.failed += accuracy.failed;
    return total;
  }, { correct: 0, compliant: 0, total: 0, successful: 0, failed: 0 });
}

// --- Long-context test helpers (Needle Test / Prefill Test) ---
//
// Both long-context tests build, from a deterministic seed, a log-style
// filler document at a configurable absolute input size, hide exactly one
// access-code entry (the needle) at a configurable percent position, and ask
// the model to report the code:
//
//   Needle Test  - document sized at a fill percent of each model's
//                  advertised context window (default 90%), needle at
//                  varying positions: the "lost in the middle" accuracy
//                  curve. Models without window metadata are skipped.
//   Prefill Test - varying input sizes (10K-1M), needle pinned near the end:
//                  the prefill curve, headlined by the effective input
//                  processing rate = p50 input tokens / p50 TTFT.
//
// Every model runs every configured size x position combination, one results
// row per combination. Combinations whose size exceeds a model's advertised
// context window are skipped before any request is sent.

const CONTEXT_SECTORS = [
  "blue", "amber", "cobalt", "verdant", "indigo", "rose", "slate", "topaz",
];
// Unambiguous alphanumerics only, so a recovered code is never a misread O/0 or I/1.
const CONTEXT_CODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CONTEXT_MIN_DOCUMENT_TOKENS = 256;
// Neutral filler templates. None of them may mention codes or sectors or
// contain code-shaped strings - the needle is the only such line in the document.
const CONTEXT_FILLER_TEMPLATES = [
  (r, n) => `Entry ${n}: routine telemetry sweep on module ${1 + Math.floor(r() * 48)} completed; all readings within normal range.`,
  (r, n) => `Entry ${n}: cache warm-up for shard ${1 + Math.floor(r() * 32)} finished in ${40 + Math.floor(r() * 900)} ms with no errors reported.`,
  (r, n) => `Entry ${n}: scheduled checkpoint archived to cold storage; checksum verified.`,
  (r, n) => `Entry ${n}: background compaction merged ${1 + Math.floor(r() * 2400)} records on storage node ${1 + Math.floor(r() * 16)} without warnings.`,
  (r, n) => `Entry ${n}: queue depth settled at ${Math.floor(r() * 900)} items; consumer lag remains inside the green band.`,
  (r, n) => `Entry ${n}: index rebuild on replica ${1 + Math.floor(r() * 8)} completed; latency profile nominal.`,
  (r, n) => `Entry ${n}: disk usage on volume ${1 + Math.floor(r() * 12)} returned to ${30 + Math.floor(r() * 40)} percent after cleanup.`,
  (r, n) => `Entry ${n}: health probe round ${1 + Math.floor(r() * 4000)} passed across ${2 + Math.floor(r() * 30)} upstream targets.`,
  (r, n) => `Entry ${n}: configuration snapshot ${100 + Math.floor(r() * 800)} applied to the staging fleet.`,
  (r, n) => `Entry ${n}: throughput sample recorded at ${50 + Math.floor(r() * 4000)} requests per second over a five-minute window.`,
];

function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Parses the comma-separated needle-position percents field into an ascending,
// deduplicated list of integers. Blank and non-numeric entries are skipped;
// each remaining value is clamped to [minPercent, maxPercent] like
// clampInteger. Returns an empty array when nothing valid remains so callers
// can apply their own fallback (the benchmark defaults to 5, 25, 50, 75, 90).
function parseContextPositionPercentOptions(raw, { minPercent = 0, maxPercent = 100 } = {}) {
  const percents = [];
  String(raw ?? "").split(",").forEach((part) => {
    const trimmed = part.trim();
    if (trimmed === "") return;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;
    const percent = Math.min(maxPercent, Math.max(minPercent, Math.round(parsed)));
    if (!percents.includes(percent)) percents.push(percent);
  });
  return percents.sort((a, b) => a - b);
}

// Parses the comma-separated input-size field into an ascending, deduplicated
// list of token counts. Blank and non-numeric entries are skipped; each
// remaining value is clamped to [minTokens, maxTokens]. Returns an empty
// array when nothing valid remains so callers can apply their own fallback
// (the benchmark defaults to 10K, 100K, 250K, 500K, 750K, 1M).
function parseContextInputTokenOptions(raw, { minTokens = 1024, maxTokens = 10485760 } = {}) {
  const sizes = [];
  String(raw ?? "").split(",").forEach((part) => {
    const trimmed = part.trim();
    if (trimmed === "") return;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;
    const size = Math.min(maxTokens, Math.max(minTokens, Math.round(parsed)));
    if (!sizes.includes(size)) sizes.push(size);
  });
  return sizes.sort((a, b) => a - b);
}

// Maps a 0-based measured run index to its size x position combination.
// Combos are ordered size-major (for each input size, every position), so the
// matrix fills one size row at a time. Warm-ups (index -1) use the first
// combo; out-of-range groups fall back to the first combo. Mirrors the Decode
// Test's output-length grouping.
function contextComboForRun(runIndex, inputTokenSizes, positionPercents, runsPerCombo) {
  const group = runIndex >= 0 ? Math.floor(runIndex / runsPerCombo) : 0;
  const comboCount = inputTokenSizes.length * positionPercents.length;
  if (group < 0 || group >= comboCount) {
    return { inputTokens: inputTokenSizes[0], positionPercent: positionPercents[0] };
  }
  const sizeIndex = Math.floor(group / positionPercents.length);
  const positionIndex = group % positionPercents.length;
  return {
    inputTokens: inputTokenSizes[sizeIndex],
    positionPercent: positionPercents[positionIndex],
  };
}

// 0-based filler-line index for the needle at `positionPercent` percent of the
// document: round((lineCount - 1) * percent / 100), clamped into the document.
// 5% lands near the top, 50% at the middle line, 90% near the bottom.
function contextNeedleLineIndex(positionPercent, lineCount) {
  const count = Math.max(1, Math.floor(lineCount));
  const percent = Number.isFinite(positionPercent)
    ? Math.min(100, Math.max(0, positionPercent))
    : 50;
  return Math.max(0, Math.min(count - 1, Math.round((count - 1) * percent / 100)));
}

// Approximate token depth of the needle inside an `inputTokens`-token
// document: documents are built from uniform filler lines, so the needle sits
// about `positionPercent` of the way in, mirroring the line-index placement
// math above. Null when there is no document (an unsizable model).
function contextNeedleTokenDepth(inputTokens, positionPercent) {
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) return null;
  const percent = Number.isFinite(positionPercent)
    ? Math.min(100, Math.max(0, positionPercent))
    : 50;
  return Math.round((inputTokens * percent) / 100);
}

// Effective input processing rate: server-reported prompt tokens divided by
// TTFT (request dispatch to the first generated token). Prefill must finish
// before any token appears, so this measures how fast the endpoint digests a
// long prompt, network and queueing overhead included - hence "effective".
// Null when either input is missing or non-positive.
function calculateEffectiveInputTokensPerSecond(promptTokens, ttftMs) {
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) return null;
  if (!Number.isFinite(ttftMs) || ttftMs <= 0) return null;
  return promptTokens / (ttftMs / 1000);
}

// Prefill Test sizing: the document targets an absolute token count from the
// configured input-size list, floored at the minimum document size so tiny
// inputs stay non-degenerate.
function contextDocumentTokensForSize(inputTokens) {
  const requested = Number.isFinite(inputTokens) ? Math.max(0, Math.round(inputTokens)) : 0;
  return Math.max(CONTEXT_MIN_DOCUMENT_TOKENS, requested);
}

// Needle Test sizing: the document fills `fillPercent` of a model's
// advertised context window (floored at the minimum document size). Null
// when the model has no usable window metadata - the caller skips such
// models entirely because there is nothing to size against.
function contextInputTokensForWindow(contextWindowTokens, fillPercent) {
  const hasWindow = Number.isFinite(contextWindowTokens) && contextWindowTokens > 0;
  if (!hasWindow) return null;
  const fill = Number.isFinite(fillPercent)
    ? Math.min(100, Math.max(0, fillPercent))
    : 90;
  return Math.max(CONTEXT_MIN_DOCUMENT_TOKENS, Math.floor((contextWindowTokens * fill) / 100));
}

// Planned usage for a run-confirmation warning: how many requests a model
// will actually send and how many input tokens they carry. Combinations that
// cannot run (an unsizable model, or sizes above its advertised window)
// contribute nothing; the warm-up uses the first runnable size, so it counts
// only when at least one combination can run.
function summarizeContextPlannedUsage({ inputTokenSizes, positionCount, runsPerCombo, contextWindowTokens }) {
  const sizes = Array.isArray(inputTokenSizes) ? inputTokenSizes : [];
  const positions = Number.isFinite(positionCount) ? Math.max(0, Math.floor(positionCount)) : 0;
  const runsPer = Number.isFinite(runsPerCombo) ? Math.max(0, Math.floor(runsPerCombo)) : 0;
  const hasWindow = Number.isFinite(contextWindowTokens) && contextWindowTokens > 0;
  const runnable = sizes.filter((size) => Number.isFinite(size) && size > 0
    && (!hasWindow || size <= contextWindowTokens));
  if (runnable.length === 0) return { requests: 0, inputTokens: 0 };
  const measuredTokens = runnable.reduce(
    (total, size) => total + size * positions * runsPer,
    0,
  );
  // Warm-up: one extra request at the first runnable size.
  return {
    requests: 1 + runnable.length * positions * runsPer,
    inputTokens: measuredTokens + runnable[0],
  };
}

function generateContextFillerLine(random, entryNumber) {
  const template = CONTEXT_FILLER_TEMPLATES[Math.floor(random() * CONTEXT_FILLER_TEMPLATES.length)];
  return template(random, entryNumber);
}

function generateContextCode(random) {
  const group = () => Array.from(
    { length: 4 },
    () => CONTEXT_CODE_CHARSET[Math.floor(random() * CONTEXT_CODE_CHARSET.length)],
  ).join("");
  return `${group()}-${group()}-${group()}`;
}

// Grows neutral filler lines until the chars/4 token estimate reaches the
// target (at least 8 lines so the document is never degenerate), then
// replaces the line at the needle index with the access-code entry. Length is
// tracked incrementally (a running character total) instead of re-joining the
// document per line, which keeps generation linear for near-window-sized
// documents; the +64-character pad covers the shrink from swapping a filler
// line for the shorter needle line.
function buildContextDocument({ random, sector, code, positionPercent, targetDocumentTokens }) {
  const lines = [];
  let totalCharacters = 0;
  const targetCharacters = targetDocumentTokens * 4;
  let entryNumber = 1;
  while (lines.length < 8 || totalCharacters < targetCharacters + 64) {
    const line = generateContextFillerLine(random, entryNumber);
    lines.push(line);
    totalCharacters += line.length + 1;
    entryNumber += 1;
  }
  const needleIndex = contextNeedleLineIndex(positionPercent, lines.length);
  lines[needleIndex] = `Entry ${needleIndex + 1}: access code for sector ${sector} is ${code}.`;
  return { lines, needleIndex, estimatedTokens: estimateTokenCount(lines.join("\n")) };
}

function renderContextPrompt(lines, sector) {
  return [
    `The log document below contains many entries. Exactly one entry contains the access code for the ${sector} sector. Read the document and report that access code.`,
    "",
    "--- DOCUMENT START ---",
    ...lines,
    "--- DOCUMENT END ---",
    "",
    `Report the access code for the ${sector} sector.`,
    "",
    "Your entire response must be exactly one line containing only the access code, exactly as it appears in the document entry.",
    "Output nothing else. Do not include reasoning, explanations, labels, markdown, or any text beyond the access code.",
  ].join("\n");
}

function generateContextTask(runSeed, runIndex, inputTokens, positionPercent) {
  const baseSeed = (runSeed >>> 0);
  const taskSeed = (baseSeed + runIndex * 2654435761) >>> 0;
  const targetDocumentTokens = contextDocumentTokensForSize(inputTokens);
  const random = createSeededRandom(taskSeed);
  const sector = CONTEXT_SECTORS[Math.floor(random() * CONTEXT_SECTORS.length)];
  const code = generateContextCode(random);
  const document = buildContextDocument({
    random,
    sector,
    code,
    positionPercent,
    targetDocumentTokens,
  });
  return {
    seed: taskSeed,
    runIndex,
    inputTokens,
    positionPercent,
    sector,
    code,
    targetDocumentTokens,
    estimatedDocumentTokens: document.estimatedTokens,
    documentLineCount: document.lines.length,
    needleLineIndex: document.needleIndex,
    prompt: renderContextPrompt(document.lines, sector),
    expected: { sector, code },
  };
}

function extractContextAnswer(contentText) {
  if (!contentText) return { ok: false, raw: null };
  // The prompt requires the entire response to contain only the access code.
  // Trim surrounding whitespace for transport/model cosmetics, but reject any
  // explanation, label, markdown, or additional non-empty line.
  const raw = contentText.trim();
  const match = raw.match(/^([A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4})$/);
  if (!match) return { ok: false, raw };
  return { ok: true, raw, code: match[1] };
}

function gradeContextAnswer(extracted, expected) {
  if (!extracted?.ok) return false;
  return extracted.code.toUpperCase() === String(expected?.code ?? "").toUpperCase();
}

// Overall accuracy for one model's result. Failed measured requests count as
// incorrect and non-compliant, mirroring Thinking Test 1's rule; skipped
// combinations (input size exceeds the model's window) are not attempts.
function summarizeContextAccuracy(result) {
  const runs = (Array.isArray(result?.runs) ? result.runs : []).filter((run) => !run?.skipped);
  const measuredFailures = Array.isArray(result?.errors)
    ? result.errors.filter((error) => Number.isInteger(error?.run) && error.run > 0).length
    : 0;
  const total = runs.length + measuredFailures;
  const correct = runs.filter((run) => run.correct).length;
  const compliant = runs.filter((run) => run.formatCompliant).length;
  return {
    correct,
    compliant,
    total,
    successful: runs.length,
    failed: measuredFailures,
    accuracy: total > 0 ? correct / total : null,
    formatCompliance: total > 0 ? compliant / total : null,
  };
}

function summarizeRunContextAccuracy(results) {
  return results.reduce((total, result) => {
    const accuracy = summarizeContextAccuracy(result);
    total.correct += accuracy.correct;
    total.compliant += accuracy.compliant;
    total.total += accuracy.total;
    total.successful += accuracy.successful;
    total.failed += accuracy.failed;
    return total;
  }, { correct: 0, compliant: 0, total: 0, successful: 0, failed: 0 });
}

// Placeholder measurement for combinations skipped without a request:
// either the input size exceeds the model's advertised context window
// (Prefill Test) or the model has no window metadata to size against
// (Needle Test). Skipped runs never hit the endpoint, never count as
// accuracy attempts, and render as "Skipped".
function buildSkippedContextMeasurement({
  inputTokens,
  positionPercent,
  skipReason = "input size exceeds the model's advertised context window",
}) {
  return {
    skipped: true,
    skipReason,
    inputTokens,
    positionPercent,
    correct: false,
    formatCompliant: false,
  };
}

// Aggregates one combination's runs (same model + input size + needle
// position): TTFT as both p50 (the typical run) and p90 (the tail - with few
// runs, nearest-rank p90 is simply the slowest run), and the effective input
// processing rate computed from the aggregates as p50 input tokens ÷ p50 TTFT
// (higher is better). Skipped runs are reported separately and never count as
// attempts; failed runs (bucketed by the caller from run numbers) count as
// incorrect.
function summarizeContextPositionRuns(runs, failedRuns = 0) {
  const activeRuns = runs.filter((run) => !run?.skipped);
  const values = (key) => activeRuns.map((run) => run[key]).filter(Number.isFinite);
  const total = activeRuns.length + failedRuns;
  const correct = activeRuns.filter((run) => run.correct).length;
  const compliant = activeRuns.filter((run) => run.formatCompliant).length;
  const ttftP50 = percentile(values("ttftMs"), 0.5);
  const promptTokensP50 = percentile(values("promptTokens"), 0.5);
  // Wall-clock test time for the combination: from its first measured run's
  // start to its last recorded run's end (testTimeStartMs/testTimeEndMs are
  // stamped around each measurement by the engine). The engine adds the
  // live in-flight time while the row runs. Null when nothing ran.
  const timedRuns = activeRuns.filter(
    (run) => Number.isFinite(run.testTimeStartMs) && Number.isFinite(run.testTimeEndMs),
  );
  const testTimeStartedAtMs = timedRuns.length > 0
    ? Math.min(...timedRuns.map((run) => run.testTimeStartMs))
    : null;
  const testTimeMs = timedRuns.length === 0
    ? null
    : Math.max(...timedRuns.map((run) => run.testTimeEndMs)) - testTimeStartedAtMs;
  return {
    completed: activeRuns.length,
    skipped: runs.length - activeRuns.length,
    failed: failedRuns,
    total,
    correct,
    compliant,
    accuracy: total > 0 ? correct / total : null,
    formatCompliance: total > 0 ? compliant / total : null,
    ttftP50,
    ttftP90: percentile(values("ttftMs"), 0.9),
    inputTpsP50: calculateEffectiveInputTokensPerSecond(promptTokensP50, ttftP50),
    e2eP50: percentile(values("endToEndLatencyMs"), 0.5),
    promptTokensP50,
    reasoningTokensP50: percentile(values("reasoningTokens"), 0.5),
    testTimeMs,
    testTimeStartedAtMs,
  };
}

// Flattens model results into one presentation row per model × input size ×
// needle position (size-major, mirroring the run order). `inputTokenSizes`
// is either a flat list of sizes (Prefill Test) or a function
// (result) => sizes[] so each model can size its own documents against its
// advertised context window (Needle Test); a non-positive size marks a model
// that cannot be sized and whose combinations are all skipped. Each row
// carries the combination's completed runs, its failed-run count (failed
// measured runs are bucketed by their 1-based run number), and an aggregate
// summary, so rows exist before a run finishes and fill in live during a run.
function buildContextRunRows(results, inputTokenSizes, positionPercents, runsPerCombo) {
  const sizesFor = (result) => (typeof inputTokenSizes === "function"
    ? inputTokenSizes(result)
    : inputTokenSizes);
  const rows = [];
  results.forEach((result) => {
    sizesFor(result).forEach((inputTokens, sizeIndex) => {
      positionPercents.forEach((positionPercent, positionIndex) => {
        const comboIndex = sizeIndex * positionPercents.length + positionIndex;
        const runs = result.runs.filter(
          (run) => run.inputTokens === inputTokens && run.positionPercent === positionPercent,
        );
        const failed = (result.errors ?? []).filter(
          (error) => Number.isInteger(error.run)
            && Math.floor((error.run - 1) / runsPerCombo) === comboIndex,
        ).length;
        rows.push({
          modelId: result.modelId,
          inputTokens,
          positionPercent,
          sizeIndex,
          positionIndex,
          comboIndex,
          runs,
          failed,
          perGroup: runsPerCombo,
          result,
          summary: summarizeContextPositionRuns(runs, failed),
        });
      });
    });
  });
  return rows;
}

// Per-combination status so each model's size × position tests are visibly run
// one combination at a time. `comboIndex` is the 0-based position of the
// combination in the size-major sequence. Fully-skipped combinations report
// "Skipped" instead of "Completed".
function contextGroupStatus({ result, runs, failed, perGroup, comboIndex }) {
  const progress = `${runs.length}/${perGroup}`;
  if (!result) return { text: "-", className: "" };
  const skippedRuns = runs.filter((run) => run?.skipped).length;
  if (runs.length > 0 && skippedRuns === runs.length) {
    return { text: `Skipped ${progress}`, className: "" };
  }
  if (runs.length + failed >= perGroup) {
    if (failed === 0) return { text: `Completed ${progress}`, className: "complete" };
    return runs.length > 0
      ? { text: `Partial ${progress}`, className: "partial" }
      : { text: `Failed ${progress}`, className: "error" };
  }
  const activeMatch = /^run (\d+)\/(\d+)$/i.exec(result.status);
  if (activeMatch) {
    const activeGroup = Math.floor((Number(activeMatch[1]) - 1) / perGroup);
    if (comboIndex === activeGroup) {
      // Count the in-flight run (and any failed attempts) so the row reads
      // "Running 1/3" as soon as its first run starts streaming, not
      // "Running 0/3".
      const inFlight = Math.min(runs.length + failed + 1, perGroup);
      return { text: `Running ${inFlight}/${perGroup}`, className: "running" };
    }
    if (comboIndex < activeGroup) {
      return failed > 0
        ? { text: `Partial ${progress}`, className: "partial" }
        : { text: `Completed ${progress}`, className: "complete" };
    }
    return { text: "Waiting", className: "" };
  }
  if (result.status === "warming") return { text: `Warming up ${progress}`, className: "running" };
  if (result.status === "queued") {
    return runs.length > 0
      ? { text: `Partial ${progress}`, className: "partial" }
      : { text: "Queued", className: "" };
  }
  if (result.status === "cancelled") {
    return { text: `Cancelled ${progress}`, className: "running" };
  }
  if (result.status === "error") return { text: `Error ${progress}`, className: "error" };
  if (failed > 0) return { text: `Partial ${progress}`, className: "partial" };
  return { text: "Waiting", className: "" };
}

// Pivots the per-combination rows into one matrix row per model × input size,
// with one accuracy cell per needle position (`acc<percent>` keys for the
// sortable matrix columns, plus a `byPosition` map with the full cell state).
// Cells are pending (no attempts yet), skipped (size exceeds the model's
// advertised window), or an accuracy ratio.
function buildContextMatrixRows(runRows, positionPercents) {
  const byKey = new Map();
  runRows.forEach((view) => {
    const key = `${view.modelId}|${view.inputTokens}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        modelId: view.modelId,
        inputTokens: view.inputTokens,
        byPosition: new Map(),
      });
    }
    const summary = view.summary;
    const cell = {
      accuracy: summary.accuracy,
      attempts: summary.total,
      correct: summary.correct,
      skipped: summary.completed === 0 && summary.skipped > 0 && summary.failed === 0,
      pending: summary.total === 0 && summary.skipped === 0,
    };
    byKey.get(key).byPosition.set(view.positionPercent, cell);
  });
  return [...byKey.values()].map((entry) => {
    const row = {
      modelId: entry.modelId,
      inputTokens: entry.inputTokens,
      byPosition: entry.byPosition,
    };
    positionPercents.forEach((percent) => {
      row[`acc${percent}`] = entry.byPosition.get(percent)?.accuracy ?? null;
    });
    return row;
  });
}

function summarizeBenchmarkUsage(result) {
  // Skipped runs (Long Context 1 combinations that exceed the model's
  // context window) never hit the endpoint, so they carry no usage.
  const requests = [result.warmup, ...result.runs].filter(
    (request) => request && !request.skipped,
  );
  const promptTokens = requests.reduce((sum, request) => sum + request.promptTokens, 0);
  const completionTokens = requests.reduce((sum, request) => sum + request.completionTokens, 0);
  const inputPrice = result.pricing?.inputPerMillionTokens;
  const outputPrice = result.pricing?.outputPerMillionTokens;
  const hasPricing = inputPrice != null && outputPrice != null;
  return {
    requestCount: requests.length,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    hasEstimated: requests.some((request) => request.tokenCountEstimated),
    cost: requests.length > 0 && hasPricing
      ? ((promptTokens * inputPrice) + (completionTokens * outputPrice)) / 1_000_000
      : null,
  };
}

function summarizeRunUsage(results) {
  return results.reduce((total, result) => {
    const usage = summarizeBenchmarkUsage(result);
    total.promptTokens += usage.promptTokens;
    total.completionTokens += usage.completionTokens;
    total.totalTokens += usage.totalTokens;
    total.cost += usage.cost ?? 0;
    total.requestCount += usage.requestCount;
    if (usage.requestCount > 0 && usage.cost !== null) total.pricedUsageCount += 1;
    if (usage.hasEstimated) total.estimatedModelCount += 1;
    total.hasEstimated ||= usage.hasEstimated;
    total.hasUnpriced ||= usage.requestCount > 0 && usage.cost === null;
    return total;
  }, {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cost: 0,
    requestCount: 0,
    pricedUsageCount: 0,
    estimatedModelCount: 0,
    hasEstimated: false,
    hasUnpriced: false,
  });
}

function createBenchmarkRun({ selectedModels, connection, config, methodology, runSeed }) {
  return {
    status: "running",
    startedAt: new Date().toISOString(),
    provider: connection.provider,
    endpoint: buildChatCompletionsUrl(connection.endpoint),
    environment: {
      userAgent: navigator.userAgent,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    methodology,
    config,
    sampleExchange: null,
    runSeed,
    executionOrder: null,
    results: selectedModels.map((model) => ({
      modelId: model.modelId,
      pricing: {
        inputPerMillionTokens: model.inputPrice,
        outputPerMillionTokens: model.outputPrice,
      },
      status: "queued",
      warmup: null,
      runs: [],
      errors: [],
      totalTestTimeMs: null,
    })),
  };
}

function estimateTokenCount(text) {
  return Math.max(1, Math.round(text.length / 4));
}

function estimatePromptTokenCount(messages) {
  const contentTokens = messages.reduce((sum, message) => sum + estimateTokenCount(message.content), 0);
  return contentTokens + (messages.length * 4) + 2;
}

function clampInteger(value, minimum, maximum) {
  const parsed = Number(value);
  const clamped = Number.isFinite(parsed) ? Math.round(parsed) : minimum;
  return Math.min(maximum, Math.max(minimum, clamped));
}

// Parses an optional numeric config field. Returns null for an empty or
// non-numeric value so callers can omit the corresponding request option
// instead of substituting a default.
function parseOptionalClampedNumber(value, minimum, maximum, { integer = false } = {}) {
  const trimmed = String(value).trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const clamped = Math.min(maximum, Math.max(minimum, parsed));
  return integer ? Math.round(clamped) : clamped;
}

function formatMilliseconds(value) {
  return value === null ? "-" : `${Math.round(value).toLocaleString()} ms`;
}

function formatRate(value) {
  return value === null ? "-" : `${value.toFixed(1)} tok/s`;
}

function formatDuration(value) {
  if (value === null || value === undefined) return "-";
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds % 60).toFixed(1)}s`;
}

function formatInteger(value) {
  return Math.round(value).toLocaleString();
}

function formatTokenUsageBreakdown(usage) {
  if (!usage || usage.requestCount === 0) return "-";
  return `${formatInteger(usage.totalTokens)} (${formatInteger(usage.promptTokens)} in + ${formatInteger(usage.completionTokens)} out)${usage.hasEstimated ? " *" : ""}`;
}

function formatBenchmarkErrorTooltip(result, maxLength = 160) {
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  if (errors.length === 0) return "";
  const latest = errors[errors.length - 1];
  const scope = latest?.run === "warmup"
    ? "Warm-up"
    : Number.isFinite(latest?.run) ? `Run ${latest.run}` : "Error";
  const message = String(latest?.message || "Benchmark request failed.")
    .replace(/\s+/g, " ")
    .trim();
  const summary = `${scope}: ${message}`;
  const shortened = summary.length > maxLength
    ? `${summary.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
    : summary;
  const errorCount = errors.length > 1 ? ` (${errors.length} errors total)` : "";
  return `${shortened}${errorCount}\nCheck console for details.`;
}

function getBenchmarkErrorTooltipElement() {
  let tooltip = document.querySelector("#benchmark-error-tooltip");
  if (tooltip) return tooltip;
  tooltip = document.createElement("div");
  tooltip.id = "benchmark-error-tooltip";
  tooltip.className = "benchmark-error-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  document.body.append(tooltip);
  return tooltip;
}

function showBenchmarkErrorTooltip(anchor, message) {
  const tooltip = getBenchmarkErrorTooltipElement();
  tooltip.textContent = message;
  tooltip.hidden = false;
  const anchorRect = anchor.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const margin = 12;
  const left = Math.min(
    Math.max(margin, anchorRect.left),
    Math.max(margin, window.innerWidth - tooltipRect.width - margin),
  );
  const below = anchorRect.bottom + 8;
  const top = below + tooltipRect.height <= window.innerHeight - margin
    ? below
    : Math.max(margin, anchorRect.top - tooltipRect.height - 8);
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}

function hideBenchmarkErrorTooltip() {
  const tooltip = document.querySelector("#benchmark-error-tooltip");
  if (tooltip) tooltip.hidden = true;
}

function renderBenchmarkStatusCell(cell, statusText, statusClass, result) {
  const pill = document.createElement("span");
  pill.className = `status-pill ${statusClass}`.trim();
  pill.textContent = statusText;
  cell.append(pill);

  const tooltip = formatBenchmarkErrorTooltip(result);
  if (!tooltip) return;
  cell.classList.add("status-has-error");
  const indicator = document.createElement("span");
  indicator.className = "status-error-indicator";
  indicator.textContent = "ⓘ";
  indicator.tabIndex = 0;
  indicator.setAttribute("aria-label", tooltip);
  cell.append(indicator);
  cell.addEventListener("mouseenter", () => showBenchmarkErrorTooltip(cell, tooltip));
  cell.addEventListener("mouseleave", hideBenchmarkErrorTooltip);
  cell.addEventListener("focusin", () => showBenchmarkErrorTooltip(cell, tooltip));
  cell.addEventListener("focusout", hideBenchmarkErrorTooltip);
}

// Styled confirmation dialog used for pre-run warnings: a replacement for
// window.confirm that matches the app's design. Renders a modal with a
// headline, per-item rows (`{ label, detail, meta, muted }`), an emphasized
// totals block, and a footnote; resolves true only on the confirm button,
// false on Cancel, Escape, or a backdrop click. Focus starts on Cancel (the
// safe default for expensive actions), stays trapped while open, and returns
// to the previously focused element afterwards.
function showBenchmarkConfirm({
  title,
  headline = null,
  rows = [],
  totals = null,
  note = null,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
}) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const titleId = `benchmark-confirm-title-${Math.random().toString(36).slice(2, 8)}`;

    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    const dialog = document.createElement("div");
    dialog.className = "confirm-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", titleId);

    const heading = document.createElement("h2");
    heading.className = "confirm-title";
    heading.id = titleId;
    heading.textContent = title;
    dialog.append(heading);

    if (headline != null) {
      const headlineElement = document.createElement("p");
      headlineElement.className = "confirm-headline";
      headlineElement.textContent = headline;
      dialog.append(headlineElement);
    }

    if (rows.length > 0) {
      const list = document.createElement("ul");
      list.className = "confirm-rows";
      rows.forEach((row) => {
        const item = document.createElement("li");
        item.className = row?.muted ? "confirm-row confirm-row-muted" : "confirm-row";
        const label = document.createElement("span");
        label.className = "confirm-row-label";
        label.textContent = row?.label ?? "";
        item.append(label);
        const detail = document.createElement("span");
        detail.className = "confirm-row-detail";
        detail.textContent = row?.detail ?? "";
        item.append(detail);
        if (row?.meta != null) {
          const meta = document.createElement("span");
          meta.className = "confirm-row-meta";
          meta.textContent = row.meta;
          item.append(meta);
        }
        list.append(item);
      });
      dialog.append(list);
    }

    if (totals != null) {
      const totalsElement = document.createElement("div");
      totalsElement.className = "confirm-totals";
      const label = document.createElement("span");
      label.className = "confirm-totals-label";
      label.textContent = "Totals";
      totalsElement.append(label);
      const detail = document.createElement("span");
      detail.className = "confirm-totals-detail";
      detail.textContent = totals.detail ?? "";
      totalsElement.append(detail);
      if (totals.meta != null) {
        const meta = document.createElement("span");
        meta.className = "confirm-totals-meta";
        meta.textContent = totals.meta;
        totalsElement.append(meta);
      }
      dialog.append(totalsElement);
    }

    if (note != null) {
      const noteElement = document.createElement("p");
      noteElement.className = "confirm-note";
      noteElement.textContent = note;
      dialog.append(noteElement);
    }

    const actions = document.createElement("div");
    actions.className = "confirm-actions";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "confirm-cancel";
    cancelButton.textContent = cancelLabel;
    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.className = "confirm-go";
    confirmButton.textContent = confirmLabel;
    actions.append(cancelButton, confirmButton);
    dialog.append(actions);
    overlay.append(dialog);

    function close(result) {
      document.removeEventListener("keydown", onKeydown);
      overlay.remove();
      if (previousFocus != null && document.contains(previousFocus)) previousFocus.focus();
      resolve(result);
    }
    function onKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        close(false);
      } else if (event.key === "Tab") {
        // Simple focus trap: only the two action buttons are focusable.
        event.preventDefault();
        if (document.activeElement === confirmButton) cancelButton.focus();
        else confirmButton.focus();
      }
    }
    confirmButton.addEventListener("click", () => close(true));
    cancelButton.addEventListener("click", () => close(false));
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) close(false);
    });
    document.addEventListener("keydown", onKeydown);
    document.body.append(overlay);
    cancelButton.focus();
  });
}

function formatCost(value) {
  if (value === null || value === undefined) return "-";
  if (value > 0 && value < 0.000001) return "<$0.000001";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 6,
  }).format(value);
}

function isMissing(value) {
  return value === null || value === undefined || value === "";
}

function compareValues(left, right) {
  if (left === right) return 0;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return normalizedValue(left).localeCompare(normalizedValue(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function normalizedValue(value) {
  return String(value);
}

function toCsvRow(values) {
  return values.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",");
}

function fileTimestamp() {
  return new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
}

function downloadFile(filename, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function getVisibleExportColumns(headers, visibleColumns, columnAttr) {
  return headers
    .filter((header) => visibleColumns.has(header.dataset[columnAttr]))
    .map((header) => ({
      key: header.dataset[columnAttr],
      label: header.querySelector("button span").textContent,
    }));
}

function getVisibleColumnDefinitions(columns, visibleColumns, excludedKeys = []) {
  const excluded = new Set(excludedKeys);
  return columns.filter((column) => (
    visibleColumns.has(column.key) && !excluded.has(column.key)
  ));
}

function exportBenchmarkCsvFile({ filenamePrefix, columns, results, getValue, getTotal }) {
  const header = columns.map((column) => column.label);
  const rows = results.map((result) => columns.map((column) => getValue(result, column.key)));
  rows.push(columns.map((column) => getTotal(column.key)));
  downloadFile(
    `${filenamePrefix}-${fileTimestamp()}.csv`,
    [header, ...rows].map(toCsvRow).join("\n"),
    "text/csv",
  );
}

function exportBenchmarkJsonFile({
  filenamePrefix,
  columns,
  results,
  getValue,
  getTotal,
  metadata = {},
}) {
  const toSelectedObject = (result) => Object.fromEntries(
    columns.map((column) => [column.key, getValue(result, column.key)]),
  );
  const payload = {
    exportedAt: new Date().toISOString(),
    selectedColumns: columns.map((column) => column.key),
    ...metadata,
    results: results.map(toSelectedObject),
    total: Object.fromEntries(columns.map((column) => [column.key, getTotal(column.key)])),
  };
  downloadFile(
    `${filenamePrefix}-${fileTimestamp()}.json`,
    JSON.stringify(payload, null, 2),
    "application/json",
  );
}

// --- Shared benchmark infrastructure (column picker, sort state, run sequence) ---
// Kept here so Speed Test 1, Thinking Test 1, the Decode Test, and the
// Needle and Prefill Tests share one implementation of column management, the
// warmup/measured loop, and SSE parsing instead of duplicating it. This file
// also owns the per-benchmark pure view-model helpers (for example the Decode
// Test's token split, run grouping, group status, matrix pivot, and
// measurement mapping, and the long-context tests' task generation, grading,
// and per-combination accuracy summaries above) so they can be unit-tested
// without a DOM.

function loadVisibleColumnSet(storageKey, allKeys, defaultColumns) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (Array.isArray(saved)) {
      const valid = saved.filter((key) => allKeys.includes(key));
      if (valid.length > 0) return new Set(valid);
    }
  } catch {
    // Storage may be unavailable in strict privacy contexts; use defaults.
  }
  return new Set((defaultColumns ?? allKeys).slice());
}

function saveVisibleColumnSet(storageKey, visibleColumns) {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...visibleColumns]));
  } catch {
    // Column selection still works for this session when storage is unavailable.
  }
}

// Builds the visible-columns checkbox dropdown inside `container` from either
// existing table headers or `{ key, label }` column definitions. Each checkbox
// toggles membership in `visibleColumns` (a Set). `onChange(visibleColumns)` runs
// after each successful toggle so callers can fix sort state, save, and re-render.
// Mutates the existing Set instance so closures elsewhere keep working.
function buildColumnPicker({
  headers = null,
  columns = null,
  columnAttr,
  container,
  visibleColumns,
  onChange,
}) {
  container.replaceChildren();
  const columnEntries = columns ?? headers.map((header) => ({
    key: header.dataset[columnAttr],
    label: header.querySelector("button span").textContent,
  }));
  columnEntries.forEach(({ key, label: columnLabel }) => {
    const label = document.createElement("label");
    label.className = "column-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = key;
    checkbox.checked = visibleColumns.has(key);
    const text = document.createElement("span");
    text.textContent = columnLabel;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        visibleColumns.add(key);
      } else if (visibleColumns.size === 1) {
        checkbox.checked = true;
        return;
      } else {
        visibleColumns.delete(key);
      }
      onChange(visibleColumns);
    });
    label.append(checkbox, text);
    container.append(label);
  });
}

function syncColumnPicker(container, visibleColumns) {
  container.querySelectorAll("input").forEach((checkbox) => {
    checkbox.checked = visibleColumns.has(checkbox.value);
  });
}

// Refreshes hidden / aria-sort / sort-icon state on sortable column headers.
function updateSortHeaders({ headers, columnAttr, visibleColumns = null, sortState }) {
  headers.forEach((header) => {
    const key = header.dataset[columnAttr];
    header.hidden = visibleColumns ? !visibleColumns.has(key) : false;
    const isActive = key === sortState.key;
    header.classList.toggle("sorted-column", isActive);
    header.setAttribute("aria-sort", isActive ? sortState.direction : "none");
    header.querySelector(".sort-icon").textContent = isActive
      ? sortState.direction === "ascending" ? "↑" : "↓"
      : "↕";
  });
}

// Returns the next sort state when a column header is clicked: toggle direction
// when the same column is selected again, otherwise reset to ascending.
function nextSortState(currentSortState, key) {
  return {
    key,
    direction: currentSortState.key === key && currentSortState.direction === "ascending"
      ? "descending"
      : "ascending",
  };
}

// Stable sort of a copy of `rows` by the active sort state, using a per-row
// `getSortValue(row, key)` projector. Missing values sort to the bottom regardless
// of direction (matching the original per-test sorters).
function sortRowsByState(rows, getSortValue, sortState) {
  return [...rows].sort((left, right) => {
    const leftValue = getSortValue(left, sortState.key);
    const rightValue = getSortValue(right, sortState.key);
    if (isMissing(leftValue)) return isMissing(rightValue) ? 0 : 1;
    if (isMissing(rightValue)) return -1;
    const comparison = compareValues(leftValue, rightValue);
    return sortState.direction === "ascending" ? comparison : -comparison;
  });
}

// Shared sortable-table controller. Every table uses the same header markup,
// direction toggling, active-column styling, and missing-value sort behavior.
// Existing headers can be bound with bindHeaders(); dynamic tables can build
// their headers from a column definition array with renderHeaders().
function createTableSorter({ initialKey, initialDirection = "ascending", onSort }) {
  let sortState = { key: initialKey, direction: initialDirection };
  let headerConfig = null;
  const boundHeaders = new WeakSet();

  function setState(nextState) {
    sortState = {
      key: nextState.key,
      direction: nextState.direction === "descending" ? "descending" : "ascending",
    };
    if (headerConfig) updateSortHeaders({ ...headerConfig, sortState });
  }

  function sortBy(key) {
    sortState = nextSortState(sortState, key);
    if (headerConfig) updateSortHeaders({ ...headerConfig, sortState });
    onSort?.(sortState);
  }

  function updateHeaders(config) {
    updateSortHeaders({ ...config, sortState });
  }

  function bindHeaders(config) {
    headerConfig = config;
    config.headers.forEach((header) => {
      if (boundHeaders.has(header)) return;
      const button = header.querySelector(".sort-button");
      if (!button) return;
      button.addEventListener("click", () => sortBy(header.dataset[config.columnAttr]));
      boundHeaders.add(header);
    });
    updateHeaders(config);
  }

  function renderHeaders({
    container,
    columns,
    columnAttr = "sortColumn",
    visibleColumns = null,
  }) {
    const row = document.createElement("tr");
    const headers = columns.map(({ key, label, title }) => {
      const header = document.createElement("th");
      header.scope = "col";
      header.dataset[columnAttr] = key;
      if (title) header.title = title;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "sort-button";
      const labelElement = document.createElement("span");
      labelElement.textContent = label;
      const icon = document.createElement("span");
      icon.className = "sort-icon";
      icon.setAttribute("aria-hidden", "true");
      button.append(labelElement, icon);
      header.append(button);
      row.append(header);
      return header;
    });
    container.replaceChildren(row);
    bindHeaders({ headers, columnAttr, visibleColumns });
    return headers;
  }

  return {
    get state() {
      return { ...sortState };
    },
    bindHeaders,
    markCell(cell, key) {
      cell.classList.toggle("sorted-column", sortState.key === key);
    },
    renderHeaders,
    reset(nextState) {
      setState(nextState);
    },
    sortBy,
    sortRows(rows, getSortValue) {
      return sortRowsByState(rows, getSortValue, sortState);
    },
    updateHeaders,
  };
}

// One shared table controller for every benchmark results table. A benchmark
// initializes it with its own columns (or existing static headers), preference
// key, default visible subset, initial sort, column-picker container, and
// re-render callback. The controller owns the visible-column set (persisted to
// localStorage), sort state, header binding/rendering, cell marking, row
// sorting, the column picker, and the "show all" behavior so each benchmark only
// supplies its domain data.
function createBenchmarkTable({
  columns = null,
  headers = null,
  columnAttr,
  preferenceKey,
  defaultColumns = null,
  initialSortKey,
  initialSortDirection = "ascending",
  pickerContainer = null,
  showAllButton = null,
  onSort,
}) {
  const allKeys = columns
    ? columns.map((column) => column.key)
    : headers.map((header) => header.dataset[columnAttr]);
  const visibleColumns = loadVisibleColumnSet(preferenceKey, allKeys, defaultColumns ?? allKeys);
  const sorter = createTableSorter({
    initialKey: initialSortKey,
    initialDirection: initialSortDirection,
    onSort,
  });
  if (!visibleColumns.has(sorter.state.key)) {
    sorter.reset({ key: [...visibleColumns][0], direction: "ascending" });
  }

  if (pickerContainer) {
    buildColumnPicker({
      columns,
      headers,
      columnAttr,
      container: pickerContainer,
      visibleColumns,
      onChange: (nextColumns) => {
        if (!nextColumns.has(sorter.state.key)) {
          sorter.reset({ key: [...nextColumns][0], direction: "ascending" });
        }
        saveVisibleColumnSet(preferenceKey, visibleColumns);
        onSort?.();
      },
    });
  }

  if (showAllButton) {
    showAllButton.addEventListener("click", () => {
      visibleColumns.clear();
      allKeys.forEach((key) => visibleColumns.add(key));
      saveVisibleColumnSet(preferenceKey, visibleColumns);
      if (pickerContainer) syncColumnPicker(pickerContainer, visibleColumns);
      onSort?.();
    });
  }

  return {
    visibleColumns,
    allKeys,
    get state() {
      return sorter.state;
    },
    reset(nextState) {
      sorter.reset(nextState);
    },
    isVisible(key) {
      return visibleColumns.has(key);
    },
    renderHeaders(container) {
      sorter.renderHeaders({ container, columns, columnAttr, visibleColumns });
    },
    bindHeaders() {
      sorter.bindHeaders({ headers, columnAttr, visibleColumns });
    },
    updateHeaders() {
      sorter.updateHeaders({ headers, columnAttr, visibleColumns });
    },
    markCell(cell, key) {
      sorter.markCell(cell, key);
    },
    sortRows(rows, getSortValue) {
      return sorter.sortRows(rows, getSortValue);
    },
    // Columns resolved in display order, limited to the visible selection, for
    // CSV/JSON exports.
    getVisibleDefinitions() {
      return columns
        ? getVisibleColumnDefinitions(columns, visibleColumns)
        : getVisibleExportColumns(headers, visibleColumns, columnAttr);
    },
  };
}

// Live (in-progress) test-time display for a still-running result row: returns
// elapsed ms since result.startedAtMs when the row is queued/warming/running,
// otherwise null so callers fall back to result.totalTestTimeMs.
function getLiveElapsedMs(result, statusRegex = /^run \d+\/\d+$/i) {
  if (!result.startedAtMs) return null;
  if (result.status === "queued" || result.status === "warming" || statusRegex.test(result.status)) {
    return performance.now() - result.startedAtMs;
  }
  return null;
}

function renderBenchmarkSafely(render, context = "benchmark") {
  try {
    render();
    return true;
  } catch (error) {
    console.error(`[LLM Quick Bench] ${context} rendering failed.`, error);
    return false;
  }
}

// Smoothly brings a benchmark's results table into view when a run starts. The
// scroll waits one frame so the freshly revealed results have laid out, eases
// over a distance-scaled duration, and jumps instantly for reduced-motion users.
function scrollToBenchmarkResults(element) {
  if (!element) return;
  requestAnimationFrame(() => {
    const rect = element.getBoundingClientRect();
    if (rect.height === 0) return;
    const startY = window.scrollY;
    const distance = rect.top;
    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion || Math.abs(distance) < 4) {
      window.scrollTo(0, startY + distance);
      return;
    }
    const duration = Math.min(1400, Math.max(500, Math.abs(distance) * 0.9));
    const startTime = performance.now();
    const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);
    const step = (now) => {
      const progress = Math.min((now - startTime) / duration, 1);
      window.scrollTo(0, startY + distance * easeInOut(progress));
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function logBenchmarkEvent(config, logName, event, details) {
  if (!config.logToConsole) return;
  let serializedDetails;
  try {
    serializedDetails = JSON.stringify(details, null, 2);
  } catch {
    serializedDetails = String(details);
  }
  console.log(`[${logName}] ${event}\n${serializedDetails}`);
}

function logBenchmarkRaw(config, logName, label, rawData) {
  if (!config.logToConsole) return;
  console.log(`[${logName}] ${label}\n${rawData}`);
}

function formatAssembledOutput(reasoningText, contentText) {
  const sections = [];
  if (reasoningText) sections.push(`--- REASONING ---\n${reasoningText}`);
  if (contentText) sections.push(`--- FINAL CONTENT ---\n${contentText}`);
  return sections.join("\n\n") || "[No generated text]";
}

function formatCapturedStreamResponse(responseHeaderLines, rawResponseChunks) {
  return [
    responseHeaderLines.join("\n"),
    "",
    ...rawResponseChunks.flatMap((chunk, index) => [`[chunk ${index + 1}]`, chunk]),
  ].join("\n");
}

// Streaming request bodies (needed for upload-progress telemetry) require
// duplex: "half". Detect support once; where unsupported (older Safari), the
// requests fall back to a plain string body and simply skip the progress bar.
const STREAM_UPLOAD_SUPPORTED = (() => {
  try {
    new Request("http://localhost/", {
      method: "POST",
      body: new ReadableStream({ start: (controller) => controller.close() }),
      duplex: "half",
    });
    return true;
  } catch {
    return false;
  }
})();

// Streams a request body in chunks and reports byte progress through
// liveState (uploadTotalBytes / uploadLoadedBytes) so the UI can show how
// much of the input has been sent. The body is encoded once and chunked at
// byte boundaries, and ReadableStream bodies apply backpressure, so the
// counts track the connection closely.
function createChunkedUploadBody(bodyText, liveState) {
  const bytes = new TextEncoder().encode(bodyText);
  liveState.uploadTotalBytes = bytes.length;
  liveState.uploadLoadedBytes = 0;
  const chunkSize = 65536;
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
      liveState.uploadLoadedBytes = offset;
    },
  });
}

async function runStreamingChatCompletion({
  modelId,
  config,
  outerSignal,
  runLabel,
  connection,
  body,
  logName,
  captureExchange = false,
  // Optional mutable object the caller keeps a reference to: stamped with
  // dispatchAtMs at request dispatch, so a live UI can tick timers from the
  // moment the request goes out while it is in flight.
  liveState = null,
}) {
  const requestController = new AbortController();
  const abortFromOuter = () => requestController.abort(outerSignal.reason);
  if (outerSignal.aborted) {
    requestController.abort(outerSignal.reason);
  } else {
    outerSignal.addEventListener("abort", abortFromOuter, { once: true });
  }
  const timeoutId = setTimeout(
    () => requestController.abort(new DOMException("Request timed out", "TimeoutError")),
    config.timeoutMs,
  );
  const startedAt = performance.now();
  if (liveState) {
    liveState.dispatchAtMs = startedAt;
  }
  let reader = null;

  try {
    const requestUrl = buildChatCompletionsUrl(connection.endpoint);
    const shouldBuildDiagnosticText = captureExchange || config.logToConsole;
    const rawRequestText = shouldBuildDiagnosticText
      ? formatBenchmarkRequest(requestUrl, body)
      : null;
    if (rawRequestText !== null) {
      logBenchmarkRaw(config, logName, `${modelId} · ${runLabel} · RAW REQUEST`, rawRequestText);
    }

    // Stream the body in chunks when upload telemetry is requested, so the
    // running row can show an input progress bar; otherwise send a plain
    // string body (identical wire behavior to before).
    const bodyText = JSON.stringify(body);
    const useStreamUpload = liveState != null && STREAM_UPLOAD_SUPPORTED;
    const requestBody = useStreamUpload
      ? createChunkedUploadBody(bodyText, liveState)
      : bodyText;
    const requestInit = {
      method: "POST",
      headers: buildApiHeaders(connection.apiKey, {
        accept: "text/event-stream",
        contentType: "application/json",
      }),
      body: requestBody,
      signal: requestController.signal,
    };
    if (useStreamUpload) requestInit.duplex = "half";

    const response = await fetch(requestUrl, requestInit);

    // Response headers are only available once the endpoint has received the
    // whole request, so dispatch -> headers is the request's send phase:
    // uploading the entire prompt and having the endpoint accept it. Recorded
    // per run (sendMs) for the raw results/export data.
    const headersAt = performance.now();
    if (liveState) liveState.headersAtMs = headersAt;

    const responseHeaderLines = shouldBuildDiagnosticText
      ? [`HTTP ${response.status} ${response.statusText}`.trim()]
      : [];
    if (shouldBuildDiagnosticText) {
      response.headers.forEach((value, key) => responseHeaderLines.push(`${key}: ${value}`));
      logBenchmarkRaw(
        config,
        logName,
        `${modelId} · ${runLabel} · RAW RESPONSE HEADERS`,
        responseHeaderLines.join("\n"),
      );
    }

    if (!response.ok) {
      const rawErrorBody = await response.text();
      logBenchmarkRaw(config, logName, `${modelId} · ${runLabel} · RAW RESPONSE BODY`, rawErrorBody);
      let payload;
      try {
        payload = rawErrorBody ? JSON.parse(rawErrorBody) : {};
      } catch {
        payload = { message: rawErrorBody };
      }
      const message = payload?.error?.message || payload?.message || response.statusText;
      throw new HttpError(response.status, `${response.status} ${message}`.trim());
    }
    if (!response.body) throw new Error("The endpoint returned no streaming response body.");

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let firstTokenAt = null;
    let lastTokenAt = null;
    // Visible (final content) timing is tracked separately from reasoning timing
    // so the Decode Test can measure generation speed on answer tokens only.
    let firstContentTokenAt = null;
    let lastContentTokenAt = null;
    let outputText = "";
    let reasoningText = "";
    let contentText = "";
    let rawChunkNumber = 0;
    const rawResponseChunks = [];
    let promptTokens = null;
    let completionTokens = null;
    let serverReasoningTokens = null;
    let finishReason = null;

    const consumeLine = (line) => {
      const chunk = parseSseLine(line);
      if (!chunk) return;
      const chunkData = extractSseChunkData(chunk);
      if (chunkData.completionTokens !== null) completionTokens = chunkData.completionTokens;
      if (chunkData.promptTokens !== null) promptTokens = chunkData.promptTokens;
      if (chunkData.reasoningTokens !== null) serverReasoningTokens = chunkData.reasoningTokens;
      if (chunkData.finishReason) finishReason = chunkData.finishReason;
      if (chunkData.contentDelta || chunkData.reasoningDelta) {
        const receivedAt = performance.now();
        if (firstTokenAt === null) firstTokenAt = receivedAt;
        lastTokenAt = receivedAt;
        if (chunkData.contentDelta) {
          if (firstContentTokenAt === null) firstContentTokenAt = receivedAt;
          lastContentTokenAt = receivedAt;
        }
        contentText += chunkData.contentDelta;
        reasoningText += chunkData.reasoningDelta;
        outputText += chunkData.reasoningDelta + chunkData.contentDelta;
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      const rawResponseChunk = decoder.decode(value || new Uint8Array(), { stream: !done });
      if (rawResponseChunk) {
        rawChunkNumber += 1;
        if (captureExchange) rawResponseChunks.push(rawResponseChunk);
        logBenchmarkRaw(
          config,
          logName,
          `${modelId} · ${runLabel} · RAW RESPONSE CHUNK #${rawChunkNumber}`,
          rawResponseChunk,
        );
      }
      buffer += rawResponseChunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      lines.forEach(consumeLine);
      if (done) break;
    }
    if (buffer) consumeLine(buffer);

    const consolidatedOutput = shouldBuildDiagnosticText
      ? formatAssembledOutput(reasoningText, contentText)
      : null;
    if (consolidatedOutput !== null) {
      logBenchmarkRaw(
        config,
        logName,
        `${modelId} · ${runLabel} · ASSEMBLED RESPONSE`,
        consolidatedOutput,
      );
    }

    const finishedAt = performance.now();
    if (firstTokenAt === null) throw new Error("The stream completed without generated text.");
    const completionTokenCountEstimated = completionTokens === null;
    const promptTokenCountEstimated = promptTokens === null;
    if (config.requireServerTokenCounts && (completionTokenCountEstimated || promptTokenCountEstimated)) {
      throw new Error("The endpoint omitted prompt or completion token usage required by this benchmark.");
    }
    if (completionTokenCountEstimated) completionTokens = estimateTokenCount(outputText);
    if (promptTokenCountEstimated) promptTokens = estimatePromptTokenCount(body.messages);
    const generationSeconds = Math.max((finishedAt - firstTokenAt) / 1000, 0.001);

    return {
      request: captureExchange ? rawRequestText : null,
      response: captureExchange
        ? formatCapturedStreamResponse(responseHeaderLines, rawResponseChunks)
        : null,
      consolidatedOutput: captureExchange ? consolidatedOutput : null,
      outputText,
      reasoningText,
      contentText,
      measurement: {
        sendMs: headersAt - startedAt,
        ttftMs: firstTokenAt - startedAt,
        ttftContentMs: firstContentTokenAt === null ? null : firstContentTokenAt - startedAt,
        lastTokenMs: lastTokenAt === null ? null : lastTokenAt - startedAt,
        lastContentTokenMs: lastContentTokenAt === null ? null : lastContentTokenAt - startedAt,
        endToEndLatencyMs: finishedAt - startedAt,
        tokensPerSecond: completionTokens / generationSeconds,
        promptTokens,
        completionTokens,
        serverReasoningTokens,
        totalTokens: promptTokens + completionTokens,
        tokenCountEstimated: completionTokenCountEstimated || promptTokenCountEstimated,
        promptTokenCountEstimated,
        completionTokenCountEstimated,
        outputCharacters: outputText.length,
        reasoningCharacters: reasoningText.length,
        contentCharacters: contentText.length,
        responseChunks: rawChunkNumber,
        finishReason,
      },
    };
  } catch (error) {
    logBenchmarkEvent(config, logName, "request error", {
      model: modelId,
      run: runLabel,
      name: error.name,
      message: error.message,
    });
    if (requestController.signal.aborted && !outerSignal.aborted) {
      throw new Error(`Timed out after ${Math.round(config.timeoutMs / 1000)} seconds.`);
    }
    throw error;
  } finally {
    try { await reader?.cancel(); } catch {}
    clearTimeout(timeoutId);
    outerSignal.removeEventListener("abort", abortFromOuter);
  }
}

// Drives the per-model benchmark sequence: one warm-up request, then `config.runs`
// measured runs, scoped by `signal`. The `runOnce({ runIndex, label, includeUsage })`
// callback performs the actual streaming request and returns a per-run measurement
// object pushed onto `result.runs`. `render()` is called after each status
// transition so each test's results table updates live. The warm-up retries
// without `include_usage` if the endpoint rejects it with HTTP 400, mirroring the
// original per-test bodies.
async function runBenchmarkSequence(result, config, signal, runOnce, render) {
  if (signal.aborted) {
    result.status = "cancelled";
    renderBenchmarkSafely(render, `${result.modelId} cancelled state`);
    return;
  }
  const modelStartedAt = performance.now();
  result.startedAtMs = modelStartedAt;
  result.startedAt = new Date().toISOString();
  result.status = "warming";
  renderBenchmarkSafely(render, `${result.modelId} warm-up state`);

  let includeUsage = true;
  try {
    try {
      result.warmup = await runOnce({ runIndex: -1, label: "warmup", includeUsage: true });
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 400) throw error;
      includeUsage = false;
      result.warmup = await runOnce({ runIndex: -1, label: "warmup-fallback", includeUsage: false });
    }

  } catch (error) {
    result.status = signal.aborted ? "cancelled" : "error";
    if (!signal.aborted) {
      console.error(`[LLM Quick Bench] Benchmark warm-up failed for ${result.modelId}.`, error);
      result.errors.push({ run: "warmup", message: error.message });
    }
    result.finishedAt = new Date().toISOString();
    result.totalTestTimeMs = performance.now() - modelStartedAt;
    renderBenchmarkSafely(render, `${result.modelId} warm-up failure state`);
    return;
  }

  for (let runIndex = 0; runIndex < config.runs; runIndex += 1) {
    if (signal.aborted) break;
    result.status = `run ${runIndex + 1}/${config.runs}`;
    renderBenchmarkSafely(render, `${result.modelId} run ${runIndex + 1} start`);
    try {
      const measuredRun = await runOnce({ runIndex, label: `run-${runIndex + 1}`, includeUsage });
      result.runs.push({ index: runIndex + 1, ...measuredRun });
    } catch (error) {
      if (signal.aborted) break;
      console.error(
        `[LLM Quick Bench] Benchmark run ${runIndex + 1} failed for ${result.modelId}.`,
        error,
      );
      result.errors.push({ run: runIndex + 1, message: error.message });
    }
    renderBenchmarkSafely(render, `${result.modelId} run ${runIndex + 1} result`);
  }

  result.status = signal.aborted
    ? "cancelled"
    : result.runs.length > 0
      ? result.errors.length > 0 ? "partial" : "complete"
      : "error";
  result.finishedAt = new Date().toISOString();
  result.totalTestTimeMs = performance.now() - modelStartedAt;
  renderBenchmarkSafely(render, `${result.modelId} final state`);
}

// Parses one raw SSE line. Returns the parsed chunk object for `data:` lines with
// valid JSON payload, or null for blank lines, comments, `[DONE]`, or unparseable
// JSON. Anything non-null is meant to be passed to extractSseChunkData().
function parseSseLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// Projects a parsed SSE chunk into flat fields the consumer can apply. Token
// counts come back as null when absent (so callers can keep them on a strict
// "if (ct !== null) ..." pattern); content/reasoning deltas come back as strings
// (empty when absent). finishReason keeps the raw value or null.
function extractSseChunkData(chunk) {
  const completionTokens = Number.isFinite(chunk?.usage?.completion_tokens)
    ? chunk.usage.completion_tokens
    : null;
  const promptTokens = Number.isFinite(chunk?.usage?.prompt_tokens)
    ? chunk.usage.prompt_tokens
    : null;
  // Providers that break out reasoning tokens report them in one of these fields.
  const reasoningTokens = Number.isFinite(chunk?.usage?.completion_tokens_details?.reasoning_tokens)
    ? chunk.usage.completion_tokens_details.reasoning_tokens
    : Number.isFinite(chunk?.usage?.reasoning_tokens)
      ? chunk.usage.reasoning_tokens
      : null;
  const finishReason = chunk?.choices?.[0]?.finish_reason ?? null;
  const delta = chunk?.choices?.[0]?.delta;
  const contentDelta = typeof delta?.content === "string" ? delta.content : "";
  const reasoningDelta = typeof delta?.reasoning_content === "string"
    ? delta.reasoning_content
    : typeof delta?.reasoning === "string" ? delta.reasoning : "";
  return { completionTokens, promptTokens, reasoningTokens, finishReason, contentDelta, reasoningDelta };
}
