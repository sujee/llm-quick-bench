// Needle Test - long-context needle-retrieval accuracy by position.
//
// The document fills a configured percent of each model's advertised context
// window (default 90%), with the needle hidden at one of the configured
// percent positions (default 5%, 25%, 50%, 75%, 90%): the "lost in the
// middle" accuracy curve. One results row per model x position plus an
// accuracy matrix (one row per model, one column per position). Models
// without context-window metadata are skipped entirely - there is nothing to
// size the document against. Models run one at a time so a window-sized
// prefill is never contended by another model's traffic.
//
// The whole benchmark engine - submit handling, run sequence, grading,
// oversized-combination skipping, rendering, exports, cross-benchmark
// locking - lives in context-bench.js; this file supplies the DOM wiring,
// the config parsing, and the wording. Task generation and summaries live in
// bench-utils.js. Loaded with `defer` after context-bench.js and before
// prefill-test1.js, which shares the same engine.

// Fallback only: used when the positions field parses to no valid values.
// The positions that run always come from the field, never from this list.
const DEFAULT_NEEDLE_POSITION_PERCENTS = [5, 25, 50, 75, 90];
// The request template previews against this illustrative window.
const NEEDLE_TEMPLATE_WINDOW_TOKENS = 131072;

const needleForm = document.querySelector("#needle-form");
const needleFillInput = document.querySelector("#needle-fill");
const needlePositionsInput = document.querySelector("#needle-positions");
const needleRunsInput = document.querySelector("#needle-runs");
const needleTemperatureInput = document.querySelector("#needle-temperature");
const needleTimeoutInput = document.querySelector("#needle-timeout");
const needleRequireServerTokensInput = document.querySelector("#needle-require-server-tokens");
const needleLogConsoleInput = document.querySelector("#needle-log-console");
// Exclude read-only controls so toggling the form back on after a run does
// not enable them.
const needleConfigInputs = [...needleForm.querySelectorAll("input, select, textarea")]
  .filter((control) => !control.disabled && !control.readOnly);

function getNeedleFillPercent() {
  return clampInteger(needleFillInput.value, 10, 100);
}

function getNeedlePositionOptions() {
  const percents = parseContextPositionPercentOptions(needlePositionsInput?.value);
  return percents.length > 0 ? percents : [...DEFAULT_NEEDLE_POSITION_PERCENTS];
}

function getNeedleConfig() {
  return {
    runsPerCombo: clampInteger(needleRunsInput.value, 1, 20),
    fillPercent: getNeedleFillPercent(),
    positionPercents: getNeedlePositionOptions(),
    temperature: parseOptionalClampedNumber(needleTemperatureInput.value, 0, 2),
    // Models run strictly one at a time: window-sized prefills are big, and
    // parallel traffic would contend for the endpoint and inflate TTFT.
    concurrency: 1,
    timeoutMs: clampInteger(needleTimeoutInput.value, 10, 600) * 1000,
    logToConsole: needleLogConsoleInput.checked,
    requireServerTokenCounts: needleRequireServerTokensInput.checked,
  };
}

// Each model sizes its own documents: fill % of its advertised context
// window. A 0 size marks a model without window metadata, whose every
// combination is skipped.
function resolveNeedleSizes(config, modelId) {
  const model = MODELS.find((candidate) => candidate.modelId === modelId);
  const windowTokens = Number.isFinite(model?.contextWindow) && model.contextWindow > 0
    ? model.contextWindow
    : null;
  const inputTokens = contextInputTokensForWindow(windowTokens, config.fillPercent);
  return [inputTokens ?? 0];
}

function needleSkipNote(selectedModels) {
  const withoutWindow = selectedModels.filter(
    (model) => !(Number.isFinite(model.contextWindow) && model.contextWindow > 0),
  );
  if (withoutWindow.length === 0) return "";
  return ` ${withoutWindow.length} model${withoutWindow.length === 1 ? " has" : "s have"} no context-window metadata and will be skipped entirely.`;
}

const needleBenchmark = createContextBenchmark({
  key: "needle",
  logName: "Needle Test",
  dom: {
    form: needleForm,
    configInputs: needleConfigInputs,
    runButton: document.querySelector("#needle-run-button"),
    cancelButton: document.querySelector("#needle-cancel-button"),
    status: document.querySelector("#needle-status"),
    results: document.querySelector("#needle-results"),
    body: document.querySelector("#needle-body"),
    matrix: document.querySelector("#needle-matrix"),
    usageNote: document.querySelector("#needle-usage-note"),
    summaryTime: document.querySelector("#summary-needle-time"),
    summaryBest: document.querySelector("#summary-needle-best"),
    summaryAccuracy: document.querySelector("#summary-needle-accuracy"),
    summaryTotalTokens: document.querySelector("#summary-needle-total-tokens"),
    summaryCost: document.querySelector("#summary-needle-cost"),
    summaryCostPerCorrect: document.querySelector("#summary-needle-cost-per-correct"),
    exportCsvButton: document.querySelector("#export-needle-csv"),
    exportJsonButton: document.querySelector("#export-needle-json"),
    exportMatrixCsvButton: document.querySelector("#export-needle-matrix-csv"),
    exportMatrixJsonButton: document.querySelector("#export-needle-matrix-json"),
    columnOptions: document.querySelector("#needle-column-options"),
    showAllColumns: document.querySelector("#show-all-needle-columns"),
    templateCode: document.querySelector("#needle-request-template-code"),
    sampleRequestNote: document.querySelector("#needle-sample-request-note"),
    sampleRequestCode: document.querySelector("#needle-sample-request-code"),
    sampleResponseNote: document.querySelector("#needle-sample-response-note"),
    sampleResponseCode: document.querySelector("#needle-sample-response-code"),
    sampleOutputNote: document.querySelector("#needle-sample-output-note"),
    sampleOutputCode: document.querySelector("#needle-sample-output-code"),
    temperatureInput: needleTemperatureInput,
    // The positions field drives the matrix columns; the fill field changes
    // every preview row's size.
    positionsInput: needlePositionsInput,
    templateInputs: [needleFillInput, needlePositionsInput, needleTemperatureInput],
    rowShapeInputs: [needleFillInput, needlePositionsInput],
  },
  columnPreferenceKey: "llm-quick-bench:needle-columns:v2",
  renderMatrix: true,
  matrixPreferenceKey: "llm-quick-bench:needle-matrix-columns:v1",
  // Documents fill most of each model's context window, so one click can send
  // millions of tokens: confirm the planned volume and estimated input cost
  // before the run starts. The Prefill Test runs without a confirmation.
  confirmRun: true,
  getConfig: getNeedleConfig,
  getTemplateConfig: () => ({
    // One stand-in size so the template stays readable; real runs size per
    // model against its own advertised window.
    inputTokenSizes: [contextInputTokensForWindow(NEEDLE_TEMPLATE_WINDOW_TOKENS, getNeedleFillPercent()) ?? 0],
    positionPercents: getNeedlePositionOptions(),
    temperature: parseOptionalClampedNumber(needleTemperatureInput.value, 0, 2),
  }),
  resolveSizes: resolveNeedleSizes,
  skipNote: needleSkipNote,
  methodology: (config) => ({
    temperature: config.temperature,
    topP: 1,
    operation: "needle retrieval accuracy by document position",
    prompt: "seeded filler log document with one access-code entry, regenerated per question",
    sizing: `documents fill ${config.fillPercent}% of each model's advertised context window; models without window metadata are skipped entirely`,
    positions: "needle placed at round((lines - 1) x percent / 100) for each configured percent",
    runsPerPosition: config.runsPerCombo,
    grading: "require the entire response to be exactly one access-code line; correct if it matches the document entry case-insensitively",
    inputRate: "effective input processing rate = p50 input tokens / p50 TTFT (request dispatch to first generated token), one row per position",
    percentile: "nearest rank",
  }),
  runningStatus: (config, selectedModels) => (
    `Running ${selectedModels.length} models × ${config.positionPercents.length} positions (${config.positionPercents.join(", ")}%) × ${config.runsPerCombo} run${config.runsPerCombo === 1 ? "" : "s"} at ${config.fillPercent}% of each model's context window`
  ),
  templateHeader: (config) => [
    `// One request per needle position: ${config.positionPercents.join(", ")}% at ${config.fillPercent}% of each model's context window.`,
    `// Shown against an illustrative ${formatContextSize(NEEDLE_TEMPLATE_WINDOW_TOKENS)} window; each model receives its own window-sized document.`,
  ],
});
