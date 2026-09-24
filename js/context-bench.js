// Long-context benchmark engine shared by the Needle Test and the Prefill
// Test. Both hide one access-code entry (the needle) inside a seeded filler
// document at a configurable size and percent position, and ask the model to
// report the code:
//
//   Needle Test  - document sized at a fill percent of each model's
//                  advertised context window (default 90%), needle at
//                  varying positions: the "lost in the middle" accuracy
//                  curve, shown as one results row per model x position
//                  plus an accuracy matrix. Models without window metadata
//                  are skipped entirely.
//   Prefill Test - varying input sizes (10K..1M), needle pinned near the end:
//                  the prefill curve. Effective input rate = p50 input tokens
//                  / p50 TTFT, one results row per model x size.
//
// createContextBenchmark() wires the whole benchmark for one tab: submit
// handling, the warm-up + measured run sequence, seeding, grading, oversized-
// combination skipping (input size > the model's advertised window), the
// results table, the optional accuracy matrix, summary cards, the request
// template, sample-exchange capture, exports, and cross-benchmark locking.
// The two test files only supply their DOM references, config parsing, and
// the wording that differs.
//
// Loaded with `defer` after decode-test1.js, before needle-test1.js and
// prefill-test1.js, which instantiate it. Task generation, run-combination
// grouping, matrix pivoting, and accuracy summaries live in bench-utils.js.
// Display helpers like formatRatioPercent and getAccuracyHighlightClass come
// from thinking-test1.js, following the same cross-file reuse as
// decode-test1.js.

// Shared results columns: Model | Status | Input tokens | Needle position |
// Accuracy | Effective input tok/s | TTFT p50 | TTFT p90 | Test time. The
// server-reported token count stays available via the column picker.
const CONTEXT_BENCH_COLUMNS = [
  { key: "modelId", label: "Model" },
  { key: "status", label: "Status" },
  { key: "inputTokens", label: "Input tokens" },
  { key: "positionPercent", label: "Needle position" },
  { key: "accuracy", label: "Accuracy" },
  { key: "inputTpsP50", label: "Effective input tok/s" },
  { key: "ttftP50", label: "TTFT p50" },
  { key: "ttftP90", label: "TTFT p90" },
  { key: "testTimeMs", label: "Test time" },
  { key: "promptTokensP50", label: "Server tok p50" },
];
const CONTEXT_BENCH_DEFAULT_COLUMNS = [
  "modelId",
  "status",
  "inputTokens",
  "positionPercent",
  "accuracy",
  "inputTpsP50",
  "ttftP50",
  "ttftP90",
  "testTimeMs",
];
const CONTEXT_BENCH_SAMPLE_TEXT_LIMIT = 48000;

// Compact size labels for configured inputs: 10K, 100K, 250K, 500K, 750K, 1M.
// Non-positive sizes (a model that cannot be sized) render as "-". Uses
// decimal thousands, unlike the model catalog's 1024-based context-window
// formatting.
function formatContextSize(value) {
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value >= 1000000 && value % 1000000 === 0) return `${value / 1000000}M`;
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}K`;
  return value.toLocaleString();
}

// Every instantiated context benchmark (needle, prefill) registers here so
// the two tests, the other benchmarks, and the model loader can lock and
// reset them through the helpers below.
const contextBenchmarks = [];

function isAnyContextBenchmarkRunning() {
  return contextBenchmarks.some((benchmark) => benchmark.isRunning());
}

// Resets every context benchmark's results (used when models reload).
function resetContextResults() {
  contextBenchmarks.forEach((benchmark) => benchmark.reset());
}

// Cross-benchmark lock entry point: speed/thinking/decode call this while
// they run, and each context benchmark calls it for the others.
function updateContextRunButtons(extraDisabled = false) {
  const disabled = extraDisabled
    || isAnyContextBenchmarkRunning()
    || (typeof MODELS !== "undefined" && Array.isArray(MODELS) && !MODELS.some((model) => model.selected))
    || (typeof modelsLoading !== "undefined" && modelsLoading);
  contextBenchmarks.forEach((benchmark) => {
    benchmark.runButton.disabled = disabled;
  });
}

// Shared status note for models whose window is smaller than the largest
// configured input size; those combinations are skipped.
function contextSkipNote(selectedModels, inputTokenSizes) {
  const largest = Math.max(...inputTokenSizes);
  const smallWindows = selectedModels.filter(
    (model) => Number.isFinite(model.contextWindow)
      && model.contextWindow > 0
      && model.contextWindow < largest,
  );
  if (smallWindows.length === 0) return "";
  return ` ${smallWindows.length} model${smallWindows.length === 1 ? " has" : "s have"} a context window smaller than ${formatContextSize(largest)}; their oversized combinations will be skipped.`;
}

function createContextBenchmark({
  key,
  logName,
  dom,
  columnPreferenceKey,
  defaultColumns = CONTEXT_BENCH_DEFAULT_COLUMNS,
  renderMatrix = false,
  matrixPreferenceKey = null,
  confirmRun = false,
  getConfig,
  getTemplateConfig,
  resolveSizes = (config) => config.inputTokenSizes ?? [],
  skipNote = (selectedModels, config) => contextSkipNote(selectedModels, config.inputTokenSizes ?? []),
  methodology,
  runningStatus,
  templateHeader,
  extraNotes = () => [],
}) {
  const table = createBenchmarkTable({
    columns: CONTEXT_BENCH_COLUMNS,
    columnAttr: "contextColumn",
    preferenceKey: columnPreferenceKey,
    defaultColumns,
    initialSortKey: "modelId",
    initialSortDirection: "ascending",
    pickerContainer: dom.columnOptions,
    showAllButton: dom.showAllColumns,
    onSort: renderResults,
  });

  // Accuracy matrix pivot (needle test): one row per model x input size, one
  // column per position. Columns follow the active positions, so the table
  // controller is rebuilt whenever they change.
  let matrixColumns = [];
  let matrixTable = null;
  let matrixPositionsKey = null;
  function rebuildMatrix(positionPercents) {
    const positionKey = positionPercents.join(",");
    if (positionKey === matrixPositionsKey) return false;
    matrixPositionsKey = positionKey;
    matrixColumns = [
      { key: "modelId", label: "Model" },
      { key: "inputTokens", label: "Input tokens" },
      ...positionPercents.map((percent) => ({
        key: `acc${percent}`,
        label: `${percent}%`,
      })),
    ];
    matrixTable = createBenchmarkTable({
      columns: matrixColumns,
      columnAttr: "contextMatrixColumn",
      preferenceKey: matrixPreferenceKey,
      initialSortKey: "modelId",
      initialSortDirection: "ascending",
      onSort: renderMatrixTable,
    });
    return true;
  }

  let run = null;
  let abortController = null;
  let startedAtMs = null;
  let stopClock = null;
  let sampleCapturePending = false;
  // In-flight request telemetry per model, so the running row's Test time
  // ticks from its first measured run. Runs are serial per model, so one
  // entry per modelId is enough.
  const liveRuns = new Map();

  function activeConfig() {
    return run?.config ?? getConfig();
  }

  // Flattens model results into one row per model x input size x needle
  // position. Sizes resolve per model (Needle Test sizes against each model's
  // advertised window), so the row builder receives a function. Before a
  // run, selected models preview as empty rows so the table fills in live.
  function getRunRows() {
    const results = run
      ? run.results
      : MODELS.filter((model) => model.selected).map((model) => ({
        modelId: model.modelId,
        runs: [],
        errors: [],
        status: null,
        pricing: {
          inputPerMillionTokens: model.inputPrice,
          outputPerMillionTokens: model.outputPrice,
        },
      }));
    const config = activeConfig();
    return buildContextRunRows(
      results,
      (result) => resolveSizes(config, result.modelId),
      config.positionPercents,
      config.runsPerCombo,
    );
  }

  function getMatrixRows() {
    return buildContextMatrixRows(getRunRows(), activeConfig().positionPercents);
  }

  function getMatrixSortValue(row, matrixKey) {
    if (matrixKey === "modelId") return row.modelId;
    if (matrixKey === "inputTokens") return row.inputTokens;
    return row[matrixKey] ?? null;
  }

  dom.cancelButton.addEventListener("click", () => abortController?.abort());
  dom.exportCsvButton.addEventListener("click", exportCsv);
  dom.exportJsonButton.addEventListener("click", exportJson);
  if (dom.exportMatrixCsvButton) dom.exportMatrixCsvButton.addEventListener("click", exportMatrixCsv);
  if (dom.exportMatrixJsonButton) dom.exportMatrixJsonButton.addEventListener("click", exportMatrixJson);
  (dom.templateInputs ?? []).forEach((control) => {
    control.addEventListener("input", renderTemplate);
    control.addEventListener("change", renderTemplate);
  });
  (dom.rowShapeInputs ?? []).forEach((control) => {
    control.addEventListener("input", () => {
      if (isRunning()) return;
      renderBenchmarkSafely(renderResults, `${logName} field change`);
    });
  });
  if (dom.positionsInput) {
    dom.positionsInput.addEventListener("input", () => {
      if (isRunning()) return;
      // getTemplateConfig applies the test's own fallback parsing.
      if (rebuildMatrix(getTemplateConfig().positionPercents)) {
        renderBenchmarkSafely(renderResults, `${logName} positions change`);
      }
    });
  }
  providerSelect.addEventListener("change", renderTemplate);
  endpointInput.addEventListener("input", renderTemplate);

  // Provider defaults fill the temperature input (blank for OpenAI); a blank
  // input is omitted from the request. Re-rendering is handled by the existing
  // provider-change listener and the initial renderTemplate() call below.
  function applyContextProviderDefaults(provider) {
    if (!dom.temperatureInput) return;
    const defaults = resolveTestRequestDefaults(key, provider);
    if ("temperature" in defaults) {
      dom.temperatureInput.value = defaults.temperature == null ? "" : String(defaults.temperature);
    }
  }
  registerProviderDefaultsApplier(applyContextProviderDefaults);
  applyContextProviderDefaults(providerSelect.value);
  document.addEventListener("models:selection-changed", updateButtonState);
  document.addEventListener("models:selection-changed", () => {
    if (abortController == null) renderBenchmarkSafely(renderResults, `${logName} selection change`);
  });

  dom.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (typeof speedAbortController !== "undefined" && speedAbortController != null) {
      setStatus(`${logName}: Speed Test 1 is already running.`, true);
      return;
    }
    if (typeof thinkingAbortController !== "undefined" && thinkingAbortController != null) {
      setStatus(`${logName}: Thinking Test 1 is already running.`, true);
      return;
    }
    if (typeof decodeAbortController !== "undefined" && decodeAbortController != null) {
      setStatus(`${logName}: Decode Test is already running.`, true);
      return;
    }
    if (contextBenchmarks.some((benchmark) => benchmark.key !== key && benchmark.isRunning())) {
      setStatus(`${logName}: the other long-context test is already running.`, true);
      return;
    }
    const selectedModels = MODELS.filter((model) => model.selected);
    if (selectedModels.length === 0) {
      setStatus("Select at least one model to run.", true);
      return;
    }

    const config = getConfig();
    // Total measured runs = runs per size x position combination. Sizes may
    // resolve per model (Needle Test), but every model gets the same
    // combination count, so the first selected model's sizes set the count.
    const firstSizes = resolveSizes(config, selectedModels[0]?.modelId ?? "");
    config.runs = config.runsPerCombo
      * Math.max(1, firstSizes.length)
      * config.positionPercents.length;

    // Tests flagged confirmRun (the Needle Test) can send millions of tokens
    // in one click: confirm the planned volume and estimated input cost in a
    // styled dialog before the first request goes out. Nothing is sent on
    // Cancel, Escape, or a backdrop click.
    if (confirmRun
      && !(await showBenchmarkConfirm({
        title: `Run ${logName}?`,
        ...buildRunConfirmContent(selectedModels, config),
        confirmLabel: "Run test",
      }))) {
      setStatus(`${logName}: cancelled before running - no requests were sent.`);
      return;
    }
    const connection = {
      provider: providerSelect.value,
      endpoint: endpointInput.value,
      apiKey: apiKeyInput.value.trim(),
    };

    abortController = new AbortController();
    startedAtMs = performance.now();
    const runSeed = crypto.getRandomValues(new Uint32Array(1))[0];
    run = createBenchmarkRun({
      selectedModels,
      connection,
      config,
      runSeed,
      methodology: methodology(config),
    });
    if (renderMatrix) rebuildMatrix(config.positionPercents);
    dom.exportCsvButton.disabled = false;
    dom.exportJsonButton.disabled = false;
    if (dom.exportMatrixCsvButton) dom.exportMatrixCsvButton.disabled = false;
    if (dom.exportMatrixJsonButton) dom.exportMatrixJsonButton.disabled = false;
    const scheduledResults = shuffleWithSeed([...run.results], runSeed);
    run.executionOrder = scheduledResults.map((result) => result.modelId);
    setRunning(true);
    dom.results.hidden = false;
    renderBenchmarkSafely(renderResults, `${logName} initial state`);
    scrollToBenchmarkResults(dom.results);
    const parallelModels = Math.min(config.concurrency, selectedModels.length);
    setStatus(
      `${runningStatus(config, selectedModels)}${parallelModels > 1
        ? ` with up to ${parallelModels} models in parallel`
        : ", one model at a time"}…${skipNote(selectedModels, config)}`,
    );

    let orchestrationFailed = false;
    try {
      await runWithConcurrency(
        scheduledResults,
        config.concurrency,
        (result) => benchmarkModel(result, config, abortController.signal, connection, runSeed),
      );
      const completed = run.results.filter((result) => result.runs.length > 0).length;
      const failed = run.results.filter((result) => result.status === "error").length;
      const partial = run.results.filter((result) => result.status === "partial").length;
      setStatus(
        abortController.signal.aborted
          ? `Cancelled. Preserved results for ${completed} completed model${completed === 1 ? "" : "s"}.`
          : `Finished ${completed} model${completed === 1 ? "" : "s"}${partial ? `; ${partial} had failed runs` : ""}${failed ? `; ${failed} failed` : ""}.`,
        failed > 0 && completed === 0,
      );
    } catch (error) {
      orchestrationFailed = true;
      console.error(`[LLM Quick Bench] ${logName} orchestration failed.`, error);
      setStatus(error.message || `${logName} stopped unexpectedly.`, true);
    } finally {
      const wasAborted = abortController?.signal.aborted ?? false;
      run.status = deriveBenchmarkRunStatus(run.results, {
        wasAborted,
        orchestrationFailed,
      });
      run.finishedAt = new Date().toISOString();
      run.totalTestTimeMs = performance.now() - startedAtMs;
      run.usage = summarizeRunUsage(run.results);
      run.accuracy = summarizeRunContextAccuracy(run.results);
      abortController = null;
      startedAtMs = null;
      sampleCapturePending = false;
      setRunning(false);
      renderBenchmarkSafely(renderResults, `${logName} final state`);
      if (typeof updateSpeedRunButtonState === "function") updateSpeedRunButtonState();
      if (typeof updateThinkingRunButtonState === "function") updateThinkingRunButtonState();
      if (typeof updateDecodeRunButtonState === "function") updateDecodeRunButtonState();
    }
  });

  function isRunning() {
    return abortController != null;
  }

  function updateButtonState() {
    dom.runButton.disabled = !MODELS?.some((model) => model.selected)
      || modelsLoading
      || abortController != null
      || (typeof speedAbortController !== "undefined" && speedAbortController != null)
      || (typeof thinkingAbortController !== "undefined" && thinkingAbortController != null)
      || (typeof decodeAbortController !== "undefined" && decodeAbortController != null)
      || contextBenchmarks.some((benchmark) => benchmark.key !== key && benchmark.isRunning());
  }

  function setRunning(isActive) {
    const otherRunning = (typeof speedAbortController !== "undefined" && speedAbortController != null)
      || (typeof thinkingAbortController !== "undefined" && thinkingAbortController != null)
      || (typeof decodeAbortController !== "undefined" && decodeAbortController != null)
      || contextBenchmarks.some((benchmark) => benchmark.key !== key && benchmark.isRunning());
    dom.runButton.disabled = isActive
      || otherRunning
      || !MODELS?.some((model) => model.selected)
      || modelsLoading;
    dom.runButton.firstElementChild.textContent = isActive ? "Running…" : "Run selected";
    dom.runButton.setAttribute("aria-busy", String(isActive));
    dom.cancelButton.hidden = !isActive;
    dom.configInputs.forEach((control) => { control.disabled = isActive; });
    // Lock shared connection + model selection so existing models/selecting operations stay frozen mid-run.
    loadButton.disabled = isActive;
    connectionControls.forEach((control) => { control.disabled = isActive; });
    updateModelSelectionButtons(isActive);
    document.querySelectorAll("#models-body .model-select").forEach((checkbox) => { checkbox.disabled = isActive; });
    // Cross-lock the other benchmarks so only one runs at a time.
    if (typeof speedRunButton !== "undefined") {
      speedRunButton.disabled = isActive
        || speedAbortController != null
        || !MODELS.some((model) => model.selected)
        || modelsLoading;
    }
    if (typeof thinkingRunButton !== "undefined") {
      thinkingRunButton.disabled = isActive
        || thinkingAbortController != null
        || !MODELS.some((model) => model.selected)
        || modelsLoading;
    }
    if (typeof decodeRunButton !== "undefined") {
      decodeRunButton.disabled = isActive
        || decodeAbortController != null
        || !MODELS.some((model) => model.selected)
        || modelsLoading;
    }
    // Refresh the other long-context test's run button through its own state
    // computation so it locks while this test runs and unlocks correctly.
    contextBenchmarks.forEach((benchmark) => {
      if (benchmark.key !== key) benchmark.updateButtonState();
    });
    if (isActive) startClock(); else stopClockHandler();
  }

  function setStatus(message, isError = false) {
    dom.status.textContent = message;
    dom.status.classList.toggle("error", isError);
  }

  // Pre-run confirmation content for tests that can send a large volume of
  // tokens in one click (the Needle Test sizes documents against whole
  // context windows): totals the planned requests and input tokens per
  // model and estimates the input cost from pricing metadata. Unsizable
  // models contribute nothing and are called out per row. Rendered by the
  // styled showBenchmarkConfirm dialog.
  function buildRunConfirmContent(selectedModels, config) {
    const plans = selectedModels.map((model) => {
      const windowTokens = Number.isFinite(model?.contextWindow) && model.contextWindow > 0
        ? model.contextWindow
        : null;
      const plan = summarizeContextPlannedUsage({
        inputTokenSizes: resolveSizes(config, model.modelId),
        positionCount: config.positionPercents.length,
        runsPerCombo: config.runsPerCombo,
        contextWindowTokens: windowTokens,
      });
      const inputPrice = Number.isFinite(model?.inputPrice) ? model.inputPrice : null;
      return {
        modelId: model.modelId,
        requests: plan.requests,
        inputTokens: plan.inputTokens,
        cost: inputPrice != null && plan.inputTokens > 0
          ? (plan.inputTokens / 1_000_000) * inputPrice
          : null,
      };
    });
    const totalRequests = plans.reduce((total, plan) => total + plan.requests, 0);
    const totalTokens = plans.reduce((total, plan) => total + plan.inputTokens, 0);
    const unpriced = plans.some((plan) => plan.cost == null && plan.requests > 0);
    const totalCost = unpriced
      ? null
      : plans.reduce((total, plan) => total + (plan.cost ?? 0), 0);
    return {
      headline: `About to send ${formatInteger(totalRequests)} requests and about ${formatInteger(totalTokens)} input tokens.`,
      rows: plans.map((plan) => {
        if (plan.requests === 0) {
          return {
            label: plan.modelId,
            detail: "0 requests - no context-window metadata to size the document against",
            meta: "skipped",
            muted: true,
          };
        }
        return {
          label: plan.modelId,
          detail: `${plan.requests} requests · about ${formatInteger(plan.inputTokens)} input tokens`,
          meta: plan.cost != null ? `input cost about ${formatCost(plan.cost)}` : "pricing unknown",
          muted: false,
        };
      }),
      totals: {
        detail: `${formatInteger(totalRequests)} requests · about ${formatInteger(totalTokens)} input tokens`,
        meta: totalCost != null ? `estimated input cost about ${formatCost(totalCost)}` : null,
      },
      note: "Output and reasoning tokens are not included in the estimate.",
    };
  }

  async function benchmarkModel(result, config, signal, connection, runSeed) {
    const model = MODELS.find((candidate) => candidate.modelId === result.modelId);
    const contextWindowTokens = Number.isFinite(model?.contextWindow) && model.contextWindow > 0
      ? model.contextWindow
      : null;
    // Sizes resolve per model: the Prefill Test reads the configured list,
    // the Needle Test sizes each document against the model's advertised
    // window. A non-positive size means the model cannot be sized (no
    // window metadata) and every combination is skipped.
    const modelSizes = resolveSizes(config, result.modelId);
    const unsizable = modelSizes.some((size) => !(size > 0));
    if (unsizable) {
      console.info(
        `[${logName}] ${result.modelId}: no advertised context window to size the document against; skipping all combinations.`,
      );
    } else if (contextWindowTokens != null) {
      const oversizedSizes = modelSizes.filter((size) => size > contextWindowTokens);
      if (oversizedSizes.length > 0) {
        console.info(
          `[${logName}] ${result.modelId}: skipping ${oversizedSizes.length * config.positionPercents.length} size × position combination(s) for input size${oversizedSizes.length === 1 ? "" : "s"} ${oversizedSizes.map(formatContextSize).join(", ")} that exceed${oversizedSizes.length === 1 ? "s" : ""} its ${formatContextSize(contextWindowTokens)} context window.`,
        );
      }
    }
    // Builds one combination's measurement. Runs are serial per model and
    // grouped size-major: for each input size, every position - so each test
    // varies exactly one axis.
    const buildCombinationMeasurement = ({ runIndex, label, includeUsage }) => {
      const combo = contextComboForRun(
        runIndex,
        modelSizes.length > 0 ? modelSizes : [0],
        config.positionPercents,
        config.runsPerCombo,
      );
      // Unsizable models skip every combination without a request.
      if (!(combo.inputTokens > 0)) {
        return buildSkippedContextMeasurement({
          inputTokens: combo.inputTokens,
          positionPercent: combo.positionPercent,
          skipReason: "model has no advertised context window to size the document against",
        });
      }
      // Oversized combinations are skipped without a request when the
      // model's advertised window is known.
      if (contextWindowTokens != null && combo.inputTokens > contextWindowTokens) {
        return buildSkippedContextMeasurement(combo);
      }
      return runCompletion(
        result.modelId,
        generateContextTask(runSeed, runIndex, combo.inputTokens, combo.positionPercent),
        config,
        signal,
        includeUsage,
        label,
        connection,
      );
    };
    // Time each measured run (document generation + request) so every row
    // gets its own Test time column: the stamps below give the summary the
    // combination's wall-clock span, and the renderer keeps the active row
    // ticking live.
    await runBenchmarkSequence(
      result,
      config,
      signal,
      async (sequence) => {
        const measurementStartedAtMs = performance.now();
        const measurement = await buildCombinationMeasurement(sequence);
        measurement.testTimeStartMs = measurementStartedAtMs;
        measurement.testTimeEndMs = performance.now();
        return measurement;
      },
      () => renderBenchmarkSafely(renderResults, `${result.modelId} progress`),
    );
  }

  async function runCompletion(modelId, task, config, outerSignal, includeUsage, runLabel, connection) {
    const captureExchange = runLabel.startsWith("run-")
      && run != null
      && run.sampleExchange == null
      && !sampleCapturePending;
    if (captureExchange) sampleCapturePending = true;
    const liveState = {};
    liveRuns.set(modelId, liveState);
    let stream;
    try {
      stream = await runStreamingChatCompletion({
        modelId,
        config,
        outerSignal,
        runLabel,
        connection,
        body: buildRequestBody(modelId, config, task.prompt, includeUsage),
        logName,
        captureExchange,
        liveState,
      });
    } catch (error) {
      if (captureExchange) sampleCapturePending = false;
      throw error;
    } finally {
      liveRuns.delete(modelId);
    }
    const extracted = extractContextAnswer(stream.contentText);
    const correct = gradeContextAnswer(extracted, task.expected);
    // The server only reports the total completion-token count; split it
    // proportionally between reasoning and answer characters as an estimate.
    const { reasoningTokens, visibleOutputTokens: answerTokens } = splitCompletionTokens(
      stream.measurement.completionTokens,
      stream.reasoningText.length,
      stream.outputText.length,
    );
    const inputTokensPerSecond = calculateEffectiveInputTokensPerSecond(
      stream.measurement.promptTokens,
      stream.measurement.ttftMs,
    );

    if (!correct || !extracted.ok) {
      const analysis = [];
      if (!extracted.ok) {
        analysis.push("Format: BROKEN - the entire response was not exactly one access-code line.");
        analysis.push(`Expected: ${task.code}`);
        if (extracted.raw === null) {
          analysis.push("Reason: the model response was empty.");
        } else {
          const excerpt = extracted.raw.length > 200
            ? `${extracted.raw.slice(0, 200)}…`
            : extracted.raw;
          analysis.push(`Response: "${excerpt}"`);
        }
      } else {
        analysis.push(`Format: OK - parsed "${extracted.code}"`);
        analysis.push(`Expected: ${task.code}`);
        if (extracted.code.toUpperCase() !== task.code.toUpperCase()) {
          analysis.push("Mismatch: the reported code is not the access code from the document entry.");
        }
      }
      analysis.push(`Needle: ${task.positionPercent}% position (sector ${task.sector}), document line ${task.needleLineIndex + 1} of ${task.documentLineCount}.`);
      analysis.push(`Document: ~${task.estimatedDocumentTokens} tokens (target ${formatContextSize(task.inputTokens)}).`);
      if (stream.reasoningText) analysis.push(`Reasoning: ${stream.reasoningText.length} chars (omitted from response above).`);
      analysis.push(`Content: ${stream.contentText.length} chars.`);
      console.log(
        `[${logName}] FAILURE · ${modelId} · ${runLabel}\n` +
        `--- MODEL RESPONSE ---\n${stream.contentText}\n` +
        `--- ANALYSIS ---\n${analysis.join("\n")}`,
      );
    }

    const relevantMeasurement = { ...stream.measurement };
    delete relevantMeasurement.tokensPerSecond;
    const measurement = {
      ...relevantMeasurement,
      reasoningTokens,
      answerTokens,
      inputTokensPerSecond,
      correct,
      formatCompliant: extracted.ok,
      parsedAnswer: extracted.ok ? extracted.code : null,
      expectedAnswer: task.code,
      inputTokens: task.inputTokens,
      positionPercent: task.positionPercent,
      sector: task.sector,
      targetDocumentTokens: task.targetDocumentTokens,
      estimatedDocumentTokens: task.estimatedDocumentTokens,
    };

    if (captureExchange && run && !run.sampleExchange) {
      const gradingBlock = [
        "--- GRADING ---",
        `Needle position: ${task.positionPercent}% of a ${formatContextSize(task.inputTokens)} document (sector ${task.sector})`,
        `Expected: ${measurement.expectedAnswer}`,
        `Parsed:  ${measurement.parsedAnswer ?? "(response did not match a single access-code line)"}`,
        `Correct:  ${measurement.correct}`,
      ].join("\n");
      run.sampleExchange = {
        modelId,
        runLabel,
        capturedAt: new Date().toISOString(),
        task: {
          inputTokens: task.inputTokens,
          positionPercent: task.positionPercent,
          sector: task.sector,
          documentLineCount: task.documentLineCount,
          estimatedDocumentTokens: task.estimatedDocumentTokens,
          expectedAnswer: measurement.expectedAnswer,
          parsedAnswer: measurement.parsedAnswer,
          correct: measurement.correct,
        },
        // Long documents make the captured exchange huge; keep the head and
        // tail of each text so the structure and grading stay visible without
        // rendering megabytes into the page.
        request: truncateSampleText(stream.request),
        response: truncateSampleText(stream.response),
        consolidatedOutput: truncateSampleText(
          `${stream.consolidatedOutput}\n\n${gradingBlock}`,
        ),
      };
      sampleCapturePending = false;
      renderBenchmarkSafely(renderMethodologySample, `${logName} sample exchange`);
    }
    if (captureExchange) sampleCapturePending = false;

    logBenchmarkEvent(config, logName, "completion summary", {
      model: modelId,
      run: runLabel,
      measurement,
    });
    return measurement;
  }

  function truncateSampleText(text) {
    if (typeof text !== "string" || text.length <= CONTEXT_BENCH_SAMPLE_TEXT_LIMIT) return text;
    const half = Math.floor(CONTEXT_BENCH_SAMPLE_TEXT_LIMIT / 2);
    const omitted = text.length - CONTEXT_BENCH_SAMPLE_TEXT_LIMIT;
    return [
      text.slice(0, half),
      `… ${omitted} characters omitted from the middle of this capture …`,
      text.slice(text.length - half),
    ].join("\n");
  }

  // No thinking toggle by design: both tests always run each model at its
  // default thinking behavior so retrieval is measured the way the model is
  // actually served.
  function buildRequestBody(modelId, config, prompt, includeUsage = true) {
    const requestId = crypto.randomUUID();
    const taggedPrompt = `Request id: ${requestId}\n${prompt}`;
    const body = {
      model: modelId,
      messages: [{ role: "user", content: taggedPrompt }],
      stream: true,
      top_p: 1,
      temperature: config.temperature,
    };
    if (includeUsage) body.stream_options = { include_usage: true };
    return stripBlankFields(body);
  }

  function renderResults() {
    let runUsage = null;
    if (run) {
      runUsage = summarizeRunUsage(run.results);
      const elapsedMs = run.totalTestTimeMs
        ?? (startedAtMs === null ? null : performance.now() - startedAtMs);
      dom.summaryTime.textContent = formatDuration(elapsedMs);
      dom.summaryBest.textContent = formatBestInputRate();
      const runAccuracy = summarizeRunContextAccuracy(run.results);
      dom.summaryAccuracy.textContent = formatRatioPercent(
        runAccuracy.total > 0 ? runAccuracy.correct / runAccuracy.total : null,
      );
      dom.summaryTotalTokens.textContent = formatInteger(runUsage.totalTokens);
      dom.summaryCost.textContent = runUsage.requestCount === 0
        ? "-"
        : runUsage.pricedUsageCount === 0
          ? "Unpriced"
          : `${formatCost(runUsage.cost)}${runUsage.hasUnpriced ? " + unpriced" : ""}`;
      dom.summaryCost.title = runUsage.hasUnpriced
        ? "Some selected models have no pricing metadata; their usage is excluded from this cost total."
        : "Warm-up and measured questions are included.";
      const aggregateCostPerCorrect = calculateAggregateCostPerCorrect(
        runUsage,
        runAccuracy.correct,
      );
      dom.summaryCostPerCorrect.textContent = formatCost(aggregateCostPerCorrect);
      dom.summaryCostPerCorrect.title = runUsage.hasUnpriced
        ? "Unavailable because at least one model has usage without pricing metadata."
        : "Total benchmark cost divided by correct measured runs.";
    }

    if (renderMatrix) {
      renderBenchmarkSafely(renderMatrixTable, `${logName} matrix`);
    }

    const thead = document.createElement("thead");
    table.renderHeaders(thead);
    const tbody = document.createElement("tbody");
    const views = table.sortRows(getRunRows(), getSortValue);
    if (views.length === 0) {
      // Always render the table, even with no selected models or runs yet.
      const emptyRow = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = CONTEXT_BENCH_COLUMNS.length;
      cell.className = "context-empty-cell";
      cell.textContent = `Select one or more models above, then run the ${logName} to populate this table.`;
      emptyRow.append(cell);
      tbody.append(emptyRow);
    } else {
      let previousModel = null;
      views.forEach((view) => {
        const row = buildRow(view);
        if (view.modelId !== previousModel) {
          row.classList.add("context-model-start");
          previousModel = view.modelId;
        }
        tbody.append(row);
      });
    }

    dom.body.replaceChildren();
    const tableElement = document.createElement("table");
    tableElement.className = "context-table";
    tableElement.append(thead, tbody);
    dom.body.append(tableElement);

    if (run) updateUsageNote(runUsage);
  }

  // Compact accuracy pivot: one row per model x input size, one column per
  // needle position, value = accuracy.
  function renderMatrixTable() {
    const thead = document.createElement("thead");
    matrixTable.renderHeaders(thead);
    const tbody = document.createElement("tbody");
    const rows = matrixTable.sortRows(getMatrixRows(), getMatrixSortValue);
    if (rows.length === 0) {
      const emptyRow = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = matrixColumns.length;
      cell.className = "context-empty-cell";
      cell.textContent = `Select one or more models above, then run the ${logName} to compare needle accuracy by position.`;
      emptyRow.append(cell);
      tbody.append(emptyRow);
    } else {
      rows.forEach((matrixRow) => {
        const row = document.createElement("tr");
        matrixColumns.forEach(({ key: matrixKey }) => {
          const cell = document.createElement("td");
          cell.dataset.contextMatrixColumn = matrixKey;
          cell.hidden = !matrixTable.isVisible(matrixKey);
          if (matrixKey === "modelId") {
            cell.className = "context-matrix-model";
            cell.textContent = matrixRow.modelId;
            cell.title = matrixRow.modelId;
          } else if (matrixKey === "inputTokens") {
            cell.className = "context-matrix-size";
            cell.textContent = formatContextSize(matrixRow.inputTokens);
            cell.title = `${formatInteger(matrixRow.inputTokens)} tokens`;
          } else {
            const percent = Number(matrixKey.replace("acc", ""));
            const cellState = matrixRow.byPosition.get(percent);
            cell.className = "context-accuracy-cell";
            if (!cellState || cellState.pending) {
              cell.textContent = "-";
            } else if (cellState.skipped) {
              cell.textContent = "—";
              cell.className = "context-accuracy-cell context-accuracy-skipped";
              cell.title = "Skipped: input size exceeds the model's advertised context window";
            } else {
              cell.textContent = `${Math.round(cellState.accuracy * 100)}%`;
              cell.title = `${cellState.correct}/${cellState.attempts} correct`;
              const highlight = getAccuracyHighlightClass(cellState.accuracy);
              if (highlight) cell.classList.add(highlight);
            }
          }
          matrixTable.markCell(cell, matrixKey);
          row.append(cell);
        });
        tbody.append(row);
      });
    }

    const tableElement = document.createElement("table");
    tableElement.className = "context-matrix";
    tableElement.append(thead, tbody);
    dom.matrix.replaceChildren(tableElement);
  }

  function buildRow(view) {
    const { result, summary } = view;
    const status = contextGroupStatus(view);
    // Approximate token depth of the needle in this row's document: null for
    // unsizable models (no document to measure depth in).
    const needleDepth = contextNeedleTokenDepth(view.inputTokens, view.positionPercent);
    // Live telemetry for this row's in-flight request: the actively running
    // combination (a measured run streaming now) gets it so its Test time
    // ticks from the first measured run; during the warm-up request, the
    // first combination's row gets it so the input progress bar shows for
    // that big first upload too.
    const rowIsRunning = abortController != null && /^Running/.test(status.text);
    const rowIsWarming = abortController != null
      && /^Warming up/.test(status.text)
      && view.comboIndex === 0;
    const liveRun = (rowIsRunning || rowIsWarming) ? liveRuns.get(view.modelId) : null;
    const row = document.createElement("tr");
    row.dataset.modelId = view.modelId;
    row.dataset.inputTokens = String(view.inputTokens);
    row.dataset.positionPercent = String(view.positionPercent);

    CONTEXT_BENCH_COLUMNS.forEach(({ key }) => {
      const cell = document.createElement("td");
      cell.dataset.contextColumn = key;
      cell.hidden = !table.isVisible(key);
      table.markCell(cell, key);
      switch (key) {
        case "modelId":
          cell.textContent = view.modelId;
          cell.title = view.modelId;
          break;
        case "inputTokens":
          cell.textContent = formatContextSize(view.inputTokens);
          cell.title = `${formatInteger(view.inputTokens)} tokens`;
          break;
        case "positionPercent":
          // Percent position plus the needle's approximate token depth inside
          // the document; unsizable models keep the bare percent.
          cell.textContent = needleDepth === null
            ? `${view.positionPercent}%`
            : `${view.positionPercent}% · ~${formatContextSize(needleDepth)} tokens in`;
          cell.title = needleDepth === null
            ? "needle at this percent of the document"
            : `needle at ${view.positionPercent}% of the document, about ${formatInteger(needleDepth)} tokens in`;
          break;
        case "status":
          renderBenchmarkStatusCell(cell, status.text, status.className, result);
          {
            // Input upload progress bar for this row's in-flight request:
            // the body is streamed in known-size chunks, so we know how
            // many bytes have been handed to the connection. Shown while
            // the prompt uploads, hidden once the endpoint accepts it.
            const uploadTotal = liveRun != null ? liveRun.uploadTotalBytes : null;
            if (liveRun != null
              && liveRun.headersAtMs == null
              && Number.isFinite(uploadTotal)
              && uploadTotal > 0) {
              const percent = Math.min(
                100,
                Math.max(0, Math.round((liveRun.uploadLoadedBytes / uploadTotal) * 100)),
              );
              const upload = document.createElement("span");
              upload.className = "context-upload";
              const label = document.createElement("span");
              label.className = "context-upload-label";
              label.textContent = `Input ${percent}%`;
              const track = document.createElement("span");
              track.className = "context-upload-track";
              const fill = document.createElement("span");
              fill.className = "context-upload-fill";
              fill.style.width = `${percent}%`;
              track.append(fill);
              upload.append(label, track);
              cell.append(upload);
            }
          }
          break;
        case "accuracy":
          cell.textContent = formatRatioPercent(summary.accuracy, 1, summary.correct, summary.total);
          {
            const accuracyHighlight = getAccuracyHighlightClass(summary.accuracy);
            if (accuracyHighlight) cell.classList.add(accuracyHighlight);
          }
          break;
        case "inputTpsP50":
          cell.classList.add("context-tps-cell");
          cell.textContent = formatRate(summary.inputTpsP50);
          break;
        case "ttftP50":
        case "ttftP90":
          cell.textContent = formatMilliseconds(summary[key]);
          break;
        case "promptTokensP50":
          cell.textContent = summary.promptTokensP50 === null
            ? "-"
            : formatInteger(summary.promptTokensP50);
          break;
        case "testTimeMs":
          // Wall-clock time for this combination's measured runs (warm-up
          // excluded): ticks live from the first measured run's dispatch
          // while the row runs, frozen once done. Skipped and
          // not-yet-started rows show "-".
          cell.classList.add("context-time-cell");
          {
            let elapsedMs;
            if (rowIsRunning) {
              const firstStartMs = summary.testTimeStartedAtMs
                ?? (liveRun != null && Number.isFinite(liveRun.dispatchAtMs)
                  ? liveRun.dispatchAtMs
                  : null);
              elapsedMs = firstStartMs == null ? null : performance.now() - firstStartMs;
            } else {
              elapsedMs = summary.testTimeMs;
            }
            cell.textContent = elapsedMs == null ? "-" : formatDuration(elapsedMs);
          }
          cell.title = "Wall-clock time for this combination's measured runs (warm-up excluded); ticks live while running.";
          break;
        default:
          cell.textContent = "-";
      }
      row.append(cell);
    });

    const positionLabel = needleDepth === null
      ? `needle at ${view.positionPercent}%`
      : `needle at ${view.positionPercent}% (~${formatContextSize(needleDepth)} tokens in)`;
    const runsTitle = summary.completed > 0
      ? `${view.modelId} · ${formatContextSize(view.inputTokens)} · ${positionLabel} · ${summary.completed}/${view.perGroup} runs`
      : `${view.modelId} · ${formatContextSize(view.inputTokens)} · ${positionLabel} · not run yet`;
    row.title = runsTitle;
    return row;
  }

  function formatBestInputRate() {
    const values = getRunRows()
      .map((view) => view.summary.inputTpsP50)
      .filter((value) => Number.isFinite(value));
    if (values.length === 0) return "-";
    return `${Math.max(...values).toLocaleString(undefined, { maximumFractionDigits: 1 })} tok/s`;
  }

  function updateUsageNote(runUsage) {
    const notes = [
      "Each row aggregates the runs for one model, input size, and needle position. Accuracy counts failed requests as incorrect; the warm-up question is excluded.",
      "Effective input tok/s = p50 input tokens ÷ p50 TTFT per row. TTFT is request dispatch to first generated token, so the rate includes network and queueing overhead; higher is better. TTFT p90 is the tail - with few runs, nearest-rank p90 is simply the slowest run.",
      "Combinations that cannot run are skipped without a request and show as Skipped / —: input sizes that exceed the model's advertised context window (Prefill Test), or models without window metadata to size the document against (Needle Test).",
      "Reasoning and answer token splits are estimated from character proportions; the server reports only the total.",
      "Percentiles use nearest-rank selection across successful measured runs.",
      ...extraNotes(runUsage),
    ];
    if (runUsage.hasEstimated) notes.push("* Some token counts are estimated because the endpoint omitted streaming usage; compare their costs cautiously.");
    if (runUsage.hasUnpriced) {
      notes.push("Some models lack pricing metadata and are excluded from the displayed cost subtotal.");
    }
    dom.usageNote.textContent = notes.join(" ");
  }

  function getSortValue(view, sortKey) {
    const summary = view.summary;
    switch (sortKey) {
      case "modelId": return view.modelId;
      case "inputTokens": return view.inputTokens;
      case "positionPercent": return view.positionPercent;
      case "status": return contextGroupStatus(view).text;
      default: return summary[sortKey] ?? null;
    }
  }

  function reset() {
    run = null;
    sampleCapturePending = false;
    liveRuns.clear();
    dom.summaryTime.textContent = "-";
    dom.summaryBest.textContent = "-";
    dom.summaryAccuracy.textContent = "-";
    dom.summaryTotalTokens.textContent = "-";
    dom.summaryCost.textContent = "-";
    dom.summaryCost.removeAttribute("title");
    dom.summaryCostPerCorrect.textContent = "-";
    dom.summaryCostPerCorrect.removeAttribute("title");
    dom.usageNote.textContent = `Results will appear here after a ${logName} run.`;
    dom.exportCsvButton.disabled = true;
    dom.exportJsonButton.disabled = true;
    if (dom.exportMatrixCsvButton) dom.exportMatrixCsvButton.disabled = true;
    if (dom.exportMatrixJsonButton) dom.exportMatrixJsonButton.disabled = true;
    dom.results.hidden = false;
    if (renderMatrix) rebuildMatrix(activeConfig().positionPercents);
    renderBenchmarkSafely(renderResults, `${logName} reset`);
  }

  function startClock() {
    stopClockHandler();
    stopClock = startThrottledClock(() => {
      if (run?.status === "running") {
        // Re-render so the summary time and the per-row Test time column
        // tick while the run is live.
        renderBenchmarkSafely(renderResults, `${logName} live test time`);
      }
    });
  }

  function stopClockHandler() {
    if (stopClock) {
      stopClock();
      stopClock = null;
    }
  }

  // Keeps the live request template readable: show the document head and tail
  // with an omission marker instead of embedding thousands of lines.
  function truncatePromptPreview(prompt) {
    const lines = prompt.split("\n");
    if (lines.length <= 20) return prompt;
    const headCount = 6;
    const tailCount = 9;
    const omitted = lines.length - headCount - tailCount;
    return [
      ...lines.slice(0, headCount),
      `… ${omitted} document lines omitted; the full document is sent in the actual request …`,
      ...lines.slice(-tailCount),
    ].join("\n");
  }

  function renderTemplate() {
    const templateConfig = getTemplateConfig();
    const inputTokenSizes = templateConfig.inputTokenSizes;
    const positionPercents = templateConfig.positionPercents;
    // Preview the smallest size so the template stays readable; real runs
    // cover every configured combination.
    const sampleTask = generateContextTask(0xC0FFEE, 0, inputTokenSizes[0], positionPercents[0]);
    const endpointValue = endpointInput.value.trim() || "https://api.example.com/v1";
    let requestUrl;
    try {
      requestUrl = buildChatCompletionsUrl(endpointValue);
    } catch (error) {
      console.warn(`[LLM Quick Bench] ${logName} request preview failed.`, error);
      dom.templateCode.textContent = "Enter a valid API endpoint to preview the benchmark request.";
      return;
    }
    const body = buildRequestBody(
      "<selected-model>",
      templateConfig,
      truncatePromptPreview(sampleTask.prompt),
      true,
    );
    dom.templateCode.textContent = [
      ...templateHeader(templateConfig),
      inputTokenSizes.length > 1
        ? `// Shown for the smallest size (${formatContextSize(inputTokenSizes[0])}); larger sizes send proportionally longer documents.`
        : `// Shown for the ${formatContextSize(inputTokenSizes[0])} input size.`,
      formatBenchmarkRequest(requestUrl, body),
    ].join("\n");
  }

  function renderMethodologySample() {
    const sample = run?.sampleExchange;
    if (!sample) {
      dom.sampleRequestNote.textContent = "No measured question has been captured yet.";
      dom.sampleResponseNote.textContent = "Run the test to capture an actual request and its complete streamed response.";
      dom.sampleOutputNote.textContent = "Run the test to assemble generated output and grading verdict from an actual measured question.";
      dom.sampleRequestCode.textContent = "Run a test to capture an actual measured request.";
      dom.sampleResponseCode.textContent = "Run a test to capture its actual streamed response.";
      dom.sampleOutputCode.textContent = "Run a test to capture its consolidated output and grading.";
      return;
    }
    const source = `${sample.modelId} · ${sample.runLabel}`;
    const taskNote = sample.task?.inputTokens != null && sample.task?.positionPercent != null
      ? `Needle at ${sample.task.positionPercent}% of a ${formatContextSize(sample.task.inputTokens)} document. `
      : "";
    dom.sampleRequestNote.textContent = `${taskNote}Actual request captured from ${source}. Long documents are truncated head + tail; the API key is redacted.`;
    dom.sampleResponseNote.textContent = `Actual response captured from ${source}. Chunk labels show the decoded network reads.`;
    dom.sampleOutputNote.textContent = `Actual generated deltas from ${source}, consolidated and graded.`;
    dom.sampleRequestCode.textContent = sample.request;
    dom.sampleResponseCode.textContent = sample.response;
    dom.sampleOutputCode.textContent = sample.consolidatedOutput;
  }

  // Exports mirror the table: one row per model x size x position (and one
  // row per model x size for the matrix), restricted to the columns
  // currently selected in the pickers.
  function getExportValue(view, exportKey) {
    const summary = view.summary;
    switch (exportKey) {
      case "modelId": return view.modelId;
      case "inputTokens": return view.inputTokens;
      case "positionPercent": return `${view.positionPercent}%`;
      case "status": return contextGroupStatus(view).text;
      // Test time exports as seconds so spreadsheets can sort/sum it.
      case "testTimeMs":
        return summary.testTimeMs == null ? null : +(summary.testTimeMs / 1000).toFixed(3);
      default:
        return summary[exportKey] ?? null;
    }
  }

  function getExportTotalValue(exportKey) {
    const values = {
      modelId: "TOTAL RUN",
      inputTokens: null,
      positionPercent: null,
      status: run?.status ?? "",
      accuracy: null,
      inputTpsP50: null,
      ttftP50: null,
      ttftP90: null,
      testTimeMs: run?.totalTestTimeMs == null ? null : +(run.totalTestTimeMs / 1000).toFixed(3),
      promptTokensP50: null,
    };
    return values[exportKey];
  }

  function exportCsv() {
    if (!run) return;
    exportBenchmarkCsvFile({
      filenamePrefix: `llm-${key}-test`,
      columns: table.getVisibleDefinitions(),
      results: table.sortRows(getRunRows(), getSortValue),
      getValue: getExportValue,
      getTotal: getExportTotalValue,
    });
  }

  function exportJson() {
    if (!run) return;
    exportBenchmarkJsonFile({
      filenamePrefix: `llm-${key}-test`,
      columns: table.getVisibleDefinitions(),
      results: table.sortRows(getRunRows(), getSortValue),
      getValue: getExportValue,
      getTotal: getExportTotalValue,
      metadata: {
        config: run.config,
        methodology: run.methodology,
        runSeed: run.runSeed,
        executionOrder: run.executionOrder,
      },
    });
  }

  function getMatrixExportValue(row, exportKey) {
    if (exportKey === "modelId") return row.modelId;
    if (exportKey === "inputTokens") return row.inputTokens;
    return row[exportKey] ?? null;
  }

  function exportMatrixCsv() {
    if (!run || !matrixTable) return;
    exportBenchmarkCsvFile({
      filenamePrefix: `llm-${key}-matrix`,
      columns: matrixTable.getVisibleDefinitions(),
      results: matrixTable.sortRows(getMatrixRows(), getMatrixSortValue),
      getValue: getMatrixExportValue,
      getTotal: (exportKey) => (exportKey === "modelId" ? "TOTAL RUN" : null),
    });
  }

  function exportMatrixJson() {
    if (!run || !matrixTable) return;
    exportBenchmarkJsonFile({
      filenamePrefix: `llm-${key}-matrix`,
      columns: matrixTable.getVisibleDefinitions(),
      results: matrixTable.sortRows(getMatrixRows(), getMatrixSortValue),
      getValue: getMatrixExportValue,
      getTotal: (exportKey) => (exportKey === "modelId" ? "TOTAL RUN" : null),
      metadata: {
        config: run.config,
        methodology: run.methodology,
        runSeed: run.runSeed,
        executionOrder: run.executionOrder,
      },
    });
  }

  // Wire initial state.
  reset();
  renderMethodologySample();
  renderTemplate();
  updateButtonState();

  const instance = {
    key,
    logName,
    runButton: dom.runButton,
    isRunning,
    updateButtonState,
    reset,
    renderResults: () => renderBenchmarkSafely(renderResults, `${logName} render`),
  };
  contextBenchmarks.push(instance);
  return instance;
}
