// Prefill Test - long-prompt prefill speed across input sizes.
//
// The needle sits at a fixed position near the end of the document (default
// 90%) while the input size varies (default 10K, 50K, 100K, 250K, 500K,
// 1M tokens): the prefill curve. One results row per model x input size,
// headlined by the effective input processing rate (p50 input tokens / p50
// TTFT) with TTFT p50/p90; retrieval accuracy at each size is still graded
// because the needle is always present.
//
// The whole benchmark engine - submit handling, run sequence, grading,
// oversized-combination skipping, rendering, exports, cross-benchmark
// locking - lives in context-bench.js; this file supplies the DOM wiring,
// the config parsing, and the wording. Task generation and summaries live in
// bench-utils.js. Loaded with `defer` last, after context-bench.js and
// needle-test1.js, which share the same engine.

// Fallback only: used when the sizes field parses to no valid values.
// The sizes that run always come from the field, never from this list.
const DEFAULT_PREFILL_INPUT_TOKENS = [10000, 50000, 100000, 250000, 500000, 1000000];

const prefillForm = document.querySelector("#prefill-form");
const prefillSizesInput = document.querySelector("#prefill-sizes");
const prefillPositionInput = document.querySelector("#prefill-position");
const prefillRunsInput = document.querySelector("#prefill-runs");
const prefillTemperatureInput = document.querySelector("#prefill-temperature");
const prefillConcurrencyInput = document.querySelector("#prefill-concurrency");
const prefillTimeoutInput = document.querySelector("#prefill-timeout");
const prefillRequireServerTokensInput = document.querySelector("#prefill-require-server-tokens");
const prefillLogConsoleInput = document.querySelector("#prefill-log-console");
// Exclude read-only controls so toggling the form back on after a run does
// not enable them.
const prefillConfigInputs = [...prefillForm.querySelectorAll("input, select, textarea")]
  .filter((control) => !control.disabled && !control.readOnly);

function getPrefillSizeOptions() {
  const sizes = parseContextInputTokenOptions(prefillSizesInput?.value);
  return sizes.length > 0 ? sizes : [...DEFAULT_PREFILL_INPUT_TOKENS];
}

function getPrefillConfig() {
  return {
    runsPerCombo: clampInteger(prefillRunsInput.value, 1, 20),
    inputTokenSizes: getPrefillSizeOptions(),
    positionPercents: [clampInteger(prefillPositionInput.value, 0, 100)],
    temperature: parseOptionalClampedNumber(prefillTemperatureInput.value, 0, 2),
    concurrency: clampInteger(prefillConcurrencyInput.value, 1, 12),
    timeoutMs: clampInteger(prefillTimeoutInput.value, 10, 600) * 1000,
    logToConsole: prefillLogConsoleInput.checked,
    requireServerTokenCounts: prefillRequireServerTokensInput.checked,
  };
}

createContextBenchmark({
  key: "prefill",
  logName: "Prefill Test",
  // One click can send mega-token prompts (up to 1M tokens per request at
  // the default sizes), so confirm the planned volume and estimated input
  // cost before anything is sent - same styled dialog as the Needle Test.
  confirmRun: true,
  dom: {
    form: prefillForm,
    configInputs: prefillConfigInputs,
    runButton: document.querySelector("#prefill-run-button"),
    cancelButton: document.querySelector("#prefill-cancel-button"),
    status: document.querySelector("#prefill-status"),
    results: document.querySelector("#prefill-results"),
    body: document.querySelector("#prefill-body"),
    usageNote: document.querySelector("#prefill-usage-note"),
    summaryTime: document.querySelector("#summary-prefill-time"),
    summaryBest: document.querySelector("#summary-prefill-best"),
    summaryAccuracy: document.querySelector("#summary-prefill-accuracy"),
    summaryTotalTokens: document.querySelector("#summary-prefill-total-tokens"),
    summaryCost: document.querySelector("#summary-prefill-cost"),
    summaryCostPerCorrect: document.querySelector("#summary-prefill-cost-per-correct"),
    exportCsvButton: document.querySelector("#export-prefill-csv"),
    exportJsonButton: document.querySelector("#export-prefill-json"),
    columnOptions: document.querySelector("#prefill-column-options"),
    showAllColumns: document.querySelector("#show-all-prefill-columns"),
    templateCode: document.querySelector("#prefill-request-template-code"),
    sampleRequestNote: document.querySelector("#prefill-sample-request-note"),
    sampleRequestCode: document.querySelector("#prefill-sample-request-code"),
    sampleResponseNote: document.querySelector("#prefill-sample-response-note"),
    sampleResponseCode: document.querySelector("#prefill-sample-response-code"),
    sampleOutputNote: document.querySelector("#prefill-sample-output-note"),
    sampleOutputCode: document.querySelector("#prefill-sample-output-code"),
    temperatureInput: prefillTemperatureInput,
    // The sizes field changes the template and every preview row.
    templateInputs: [prefillSizesInput, prefillPositionInput, prefillTemperatureInput],
    rowShapeInputs: [prefillSizesInput],
  },
  columnPreferenceKey: "llm-quick-bench:prefill-columns:v2",
  getConfig: getPrefillConfig,
  getTemplateConfig: getPrefillConfig,
  methodology: (config) => ({
    temperature: config.temperature,
    topP: 1,
    operation: "long-prompt prefill speed across input sizes",
    prompt: "seeded filler log document with one access-code entry near the end, regenerated per question",
    sizing: `input sizes from the comma-separated list; combinations larger than a model's advertised context window are skipped`,
    positions: `needle fixed at round((lines - 1) x ${config.positionPercents[0]} / 100), near the end of the document`,
    runsPerSize: config.runsPerCombo,
    grading: "require the entire response to be exactly one access-code line; correct if it matches the document entry case-insensitively",
    inputRate: "effective input processing rate = p50 input tokens / p50 TTFT (request dispatch to first generated token), one row per input size",
    percentile: "nearest rank",
  }),
  runningStatus: (config, selectedModels) => (
    `Running ${selectedModels.length} models × ${config.inputTokenSizes.length} input sizes (${config.inputTokenSizes.map(formatContextSize).join(", ")}) × ${config.runsPerCombo} run${config.runsPerCombo === 1 ? "" : "s"} with the needle at ${config.positionPercents[0]}%`
  ),
  templateHeader: (config) => [
    `// One request per input size: ${config.inputTokenSizes.map(formatContextSize).join(", ")} with the needle at ${config.positionPercents[0]}%.`,
  ],
  extraNotes: () => [
    "The headline metric is the effective input rate: watch how it holds (or collapses) as the input size grows.",
  ],
});
