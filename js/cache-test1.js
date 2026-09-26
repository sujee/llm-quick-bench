// Cache Test - prompt-cache effectiveness with a short vs padded prompt.
//
// One fixed trivia question ("What is the capital of France?") is asked two
// ways per model:
//
//   short  - the bare question: a handful of tokens, deliberately below the
//            minimum prefix most providers cache.
//   padded - the same question surrounded by a seeded filler log sized to the
//            configured payload (default 50K tokens) so the whole prompt
//            clears the cacheable minimum.
//
// Each variant sends 1 cold request (the cache prime and prefill baseline)
// followed by N byte-identical repeats, all serialized from the same request
// body object, so nothing but the prefix cache can explain the differences.
// The server-reported usage split (prompt_tokens_details.cached_tokens) is
// the ground truth for the cache hit %, next to the TTFT reduction and the
// billed-cost drop at cached input pricing.
//
// Task generation, cache summaries, and pricing math live in bench-utils.js
// (generateCachePromptPayload, summarizeCacheRuns, calculateCacheCost,
// calculateCacheSavingsPct, gradeCacheAnswer). Reuses the shared model
// loader, streaming runner, table controller, confirmation dialog, and
// exports from bench-utils.js and speed-test1.js.
//
// Loaded with `defer` last. Other benchmarks reference cacheAbortController,
// updateCacheRunButtonState, resetCacheResults, and isCacheBenchmarkRunning
// through typeof guards, so this file stays independently loadable.

const CACHE_LOG_NAME = "Cache Test";
const CACHE_MAX_OUTPUT_TOKENS = 64;
const CACHE_SAMPLE_TEXT_LIMIT = 48000;
const CACHE_MIN_PAYLOAD_TOKENS = 1024;
const CACHE_MAX_PAYLOAD_TOKENS = 10_000_000;
// Fallback only: used when the payload field parses to no valid value.
const DEFAULT_CACHE_PAYLOAD_TOKENS = 50000;

const cacheForm = document.querySelector("#cache-form");
const cachePayloadInput = document.querySelector("#cache-payload");
const cacheRunsInput = document.querySelector("#cache-runs");
const cacheTemperatureInput = document.querySelector("#cache-temperature");
const cacheTimeoutInput = document.querySelector("#cache-timeout");
const cacheRequireServerTokensInput = document.querySelector("#cache-require-server-tokens");
const cacheLogConsoleInput = document.querySelector("#cache-log-console");
// Exclude read-only controls so toggling the form back on after a run does
// not enable them.
const cacheConfigInputs = [...cacheForm.querySelectorAll("input, select, textarea")]
  .filter((control) => !control.disabled && !control.readOnly);
const cacheRunButton = document.querySelector("#cache-run-button");
const cacheCancelButton = document.querySelector("#cache-cancel-button");
const cacheStatus = document.querySelector("#cache-status");
const cacheResults = document.querySelector("#cache-results");
const cacheChart = document.querySelector("#cache-chart");
const cacheBody = document.querySelector("#cache-body");
const cacheUsageNote = document.querySelector("#cache-usage-note");
const cacheSummaryTime = document.querySelector("#summary-cache-time");
const cacheSummaryBest = document.querySelector("#summary-cache-best");
const cacheSummaryTotalTokens = document.querySelector("#summary-cache-total-tokens");
const cacheSummaryCost = document.querySelector("#summary-cache-cost");
const cacheSummarySavings = document.querySelector("#summary-cache-savings");
const exportCacheCsvButton = document.querySelector("#export-cache-csv");
const exportCacheJsonButton = document.querySelector("#export-cache-json");
const cacheColumnOptions = document.querySelector("#cache-column-options");
const showAllCacheColumnsButton = document.querySelector("#show-all-cache-columns");
const cacheSortHeaders = [...document.querySelectorAll("[data-cache-column]")];
const cacheTemplateCode = document.querySelector("#cache-request-template-code");
const cacheSampleRequestNote = document.querySelector("#cache-sample-request-note");
const cacheSampleRequestCode = document.querySelector("#cache-sample-request-code");
const cacheSampleResponseNote = document.querySelector("#cache-sample-response-note");
const cacheSampleResponseCode = document.querySelector("#cache-sample-response-code");
const cacheSampleOutputNote = document.querySelector("#cache-sample-output-note");
const cacheSampleOutputCode = document.querySelector("#cache-sample-output-code");

let cacheRun = null;
let cacheAbortController = null;
let cacheStartedAtMs = null;
let cacheStopClock = null;
let cacheSampleCapturePending = false;

const cacheColumnPreferenceKey = "llm-quick-bench:cache-columns:v1";
const defaultCacheColumns = [
  "modelId",
  "status",
  "payloadTokens",
  "promptTokensP50",
  "coldTtftMs",
  "warmTtftP50",
  "ttftReductionPct",
  "warmCachedTokensP50",
  "cacheHitPct",
  "costSavingsPct",
  "testTimeMs",
];

// Standard sortable table via the shared constructor: every column header is
// clickable, but there is NO default sort - rows appear in natural order
// (models in execution order, each model's variants short → padded →
// busted) until a header is clicked.
const cacheTable = createBenchmarkTable({
  headers: cacheSortHeaders,
  columnAttr: "cacheColumn",
  preferenceKey: cacheColumnPreferenceKey,
  defaultColumns: defaultCacheColumns,
  initialSortKey: null,
  pickerContainer: cacheColumnOptions,
  showAllButton: showAllCacheColumnsButton,
  onSort: renderCacheResults,
});
cacheTable.bindHeaders();

cacheCancelButton.addEventListener("click", () => cacheAbortController?.abort());
exportCacheCsvButton.addEventListener("click", exportCacheCsv);
exportCacheJsonButton.addEventListener("click", exportCacheJson);
[cachePayloadInput, cacheRunsInput, cacheTemperatureInput].forEach((control) => {
  control.addEventListener("input", () => {
    renderCacheRequestTemplate();
    if (cacheAbortController == null) {
      renderBenchmarkSafely(renderCacheResults, "Cache Test field change");
    }
  });
});
providerSelect.addEventListener("change", renderCacheRequestTemplate);
endpointInput.addEventListener("input", renderCacheRequestTemplate);
document.addEventListener("models:selection-changed", updateCacheRunButtonState);
document.addEventListener("models:selection-changed", () => {
  if (cacheAbortController == null) {
    renderBenchmarkSafely(renderCacheResults, "Cache Test selection change");
  }
});

// Temperature is an optional request field: the provider default fills the
// input (blank for OpenAI), and a blank input is omitted from the request.
function applyCacheProviderDefaults(provider) {
  const defaults = resolveTestRequestDefaults("cache", provider);
  if ("temperature" in defaults) {
    cacheTemperatureInput.value = defaults.temperature == null
      ? ""
      : String(defaults.temperature);
  }
  renderCacheRequestTemplate();
}
registerProviderDefaultsApplier(applyCacheProviderDefaults);

function getCacheConfig() {
  const payloadTokens = clampInteger(
    cachePayloadInput.value,
    CACHE_MIN_PAYLOAD_TOKENS,
    CACHE_MAX_PAYLOAD_TOKENS,
  );
  return {
    payloadTokens,
    runsPerModel: clampInteger(cacheRunsInput.value, 1, 50),
    temperature: parseOptionalClampedNumber(cacheTemperatureInput.value, 0, 2),
    timeoutMs: clampInteger(cacheTimeoutInput.value, 10, 600) * 1000,
    logToConsole: cacheLogConsoleInput.checked,
    requireServerTokenCounts: cacheRequireServerTokensInput.checked,
  };
}

function activeCacheConfig() {
  return cacheRun?.config ?? getCacheConfig();
}

// The prompt variants. comboIndex feeds contextGroupStatus: runs are
// grouped variant-major (all short requests, then all padded, then all
// busted), so the active run number maps onto the variant the same way it
// does for the long-context tests' combinations.
function getCacheVariants(config) {
  return [
    { key: "short", comboIndex: 0, targetTokens: 0, label: "Short" },
    {
      key: "padded",
      comboIndex: 1,
      targetTokens: config.payloadTokens,
      label: `Padded · ${formatContextSize(config.payloadTokens)}`,
    },
    {
      key: "busted",
      comboIndex: 2,
      targetTokens: config.payloadTokens,
      bustsCache: true,
      label: `Busted · ${formatContextSize(config.payloadTokens)}`,
    },
  ];
}

// Fresh per-request nonce for the busted control variant. Prepended as the
// very first line of the prompt: prefix caches match from position 0, so a
// differing first line guarantees a miss no matter what follows.
function generateCacheNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `Request nonce: ${hex}`;
}

function isCacheBenchmarkRunning() {
  return cacheAbortController != null;
}

function updateCacheRunButtonState() {
  cacheRunButton.disabled = !MODELS?.some((model) => model.selected)
    || modelsLoading
    || cacheAbortController != null
    || (typeof speedAbortController !== "undefined" && speedAbortController != null)
    || (typeof thinkingAbortController !== "undefined" && thinkingAbortController != null)
    || (typeof decodeAbortController !== "undefined" && decodeAbortController != null)
    || (typeof isAnyContextBenchmarkRunning === "function" && isAnyContextBenchmarkRunning());
}

function setCacheRunning(isActive) {
  const otherRunning = (typeof speedAbortController !== "undefined" && speedAbortController != null)
    || (typeof thinkingAbortController !== "undefined" && thinkingAbortController != null)
    || (typeof decodeAbortController !== "undefined" && decodeAbortController != null)
    || (typeof isAnyContextBenchmarkRunning === "function" && isAnyContextBenchmarkRunning());
  cacheRunButton.disabled = isActive
    || otherRunning
    || !MODELS?.some((model) => model.selected)
    || modelsLoading;
  cacheRunButton.firstElementChild.textContent = isActive ? "Running…" : "Run selected";
  cacheRunButton.setAttribute("aria-busy", String(isActive));
  cacheCancelButton.hidden = !isActive;
  cacheConfigInputs.forEach((control) => { control.disabled = isActive; });
  loadButton.disabled = isActive;
  connectionControls.forEach((control) => { control.disabled = isActive; });
  updateModelSelectionButtons(isActive);
  document.querySelectorAll("#models-body .model-select").forEach((checkbox) => { checkbox.disabled = isActive; });
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
  // Lock or release the long-context tests' run buttons (needle + prefill).
  if (typeof updateContextRunButtons === "function") updateContextRunButtons(isActive);
  if (isActive) startCacheClock(); else stopCacheClock();
}

function setCacheStatus(message, isError = false) {
  cacheStatus.textContent = message;
  cacheStatus.classList.toggle("error", isError);
}

// No thinking toggle by design: like the long-context tests, the request body
// carries no per-request thinking controls, so each model is measured the way
// it is actually served. A single body object is built per model × variant
// and reused for the cold request and every repeat, so the serialized bytes
// are identical - the premise of the test.
function buildCacheRequestBody(modelId, config, prompt, provider) {
  const outputLimitField = provider === "openai" ? "max_completion_tokens" : "max_tokens";
  const body = {
    model: modelId,
    messages: [{ role: "user", content: prompt }],
    stream: true,
    top_p: 1,
    temperature: config.temperature,
    [outputLimitField]: CACHE_MAX_OUTPUT_TOKENS,
    stream_options: { include_usage: true },
  };
  return stripBlankFields(body);
}

cacheForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (cacheAbortController != null) {
    setCacheStatus("Cache Test is already running.", true);
    return;
  }
  if (typeof speedAbortController !== "undefined" && speedAbortController != null) {
    setCacheStatus("Speed Test 1 is already running.", true);
    return;
  }
  if (typeof thinkingAbortController !== "undefined" && thinkingAbortController != null) {
    setCacheStatus("Thinking Test 1 is already running.", true);
    return;
  }
  if (typeof decodeAbortController !== "undefined" && decodeAbortController != null) {
    setCacheStatus("Decode Test is already running.", true);
    return;
  }
  if (typeof isAnyContextBenchmarkRunning === "function" && isAnyContextBenchmarkRunning()) {
    setCacheStatus("A long-context test is already running.", true);
    return;
  }
  const selectedModels = MODELS.filter((model) => model.selected);
  if (selectedModels.length === 0) {
    setCacheStatus("Select at least one model to run.", true);
    return;
  }

  const config = getCacheConfig();
  config.runs = getCacheVariants(config).length * (1 + config.runsPerModel);
  const connection = {
    provider: providerSelect.value,
    endpoint: endpointInput.value,
    apiKey: apiKeyInput.value.trim(),
  };

  // One click can send a large volume of tokens (2 variants × cold +
  // repeats × payload): confirm the planned volume and estimated input cost
  // in the styled dialog before the first request goes out. Nothing is sent
  // on Cancel, Escape, or a backdrop click.
  if (!(await showBenchmarkConfirm({
    title: "Run Cache Test?",
    ...buildCacheConfirmContent(selectedModels, config),
    confirmLabel: "Run test",
  }))) {
    setCacheStatus("Cancelled before running - no requests were sent.");
    return;
  }

  cacheAbortController = new AbortController();
  cacheStartedAtMs = performance.now();
  const runSeed = crypto.getRandomValues(new Uint32Array(1))[0];
  cacheRun = createBenchmarkRun({
    selectedModels,
    connection,
    config,
    runSeed,
    methodology: {
      temperature: config.temperature,
      topP: 1,
      operation: "prompt-cache effectiveness: short vs padded vs nonce-busted trivia prompt",
      prompt: 'fixed question "What is the capital of France?"; the short variant sends it bare, the padded variant pads it with seeded filler sized to the configured payload, the busted variant prepends a fresh nonce to every request so the prefix cache can never match',
      sequence: "per model, per variant: 1 cold request then byte-identical repeats (except busted, where every request carries a new nonce)",
      cacheHit: "warm cached tokens p50 / warm prompt tokens p50, from server-reported usage",
      ttftReduction: "(cold TTFT - warm TTFT p50) / cold TTFT",
      cost: "uncached prompt tokens x input price + cached tokens x cached input price",
      grading: "the answer must mention Paris",
      percentile: "nearest rank",
    },
  });
  cacheRun.executionOrder = selectedModels.map((model) => model.modelId);
  exportCacheCsvButton.disabled = false;
  exportCacheJsonButton.disabled = false;
  setCacheRunning(true);
  cacheResults.hidden = false;
  renderBenchmarkSafely(renderCacheResults, "Cache Test initial state");
  scrollToBenchmarkResults(cacheResults);
  setCacheStatus(
    `Running ${selectedModels.length} model${selectedModels.length === 1 ? "" : "s"} × 3 variants (short, padded ${formatContextSize(config.payloadTokens)}, nonce-busted ${formatContextSize(config.payloadTokens)}) × ${1 + config.runsPerModel} requests each, one model at a time…`,
  );

  let orchestrationFailed = false;
  try {
    // Models run strictly one at a time: each cold prefill stays uncontended
    // so TTFT (and the cache effect on it) stays comparable.
    for (let modelIndex = 0; modelIndex < cacheRun.results.length; modelIndex += 1) {
      if (cacheAbortController.signal.aborted) break;
      await benchmarkCacheModel(
        cacheRun.results[modelIndex],
        config,
        cacheAbortController.signal,
        connection,
        runSeed,
        modelIndex,
      );
    }
    const completed = cacheRun.results.filter((result) => result.runs.length > 0).length;
    const failed = cacheRun.results.filter((result) => result.status === "error").length;
    const partial = cacheRun.results.filter((result) => result.status === "partial").length;
    setCacheStatus(
      cacheAbortController.signal.aborted
        ? `Cancelled. Preserved results for ${completed} model${completed === 1 ? "" : "s"}.`
        : `Finished ${completed} model${completed === 1 ? "" : "s"}${partial ? `; ${partial} had failed requests` : ""}${failed ? `; ${failed} failed` : ""}.`,
      failed > 0 && completed === 0,
    );
  } catch (error) {
    orchestrationFailed = true;
    console.error("[LLM Quick Bench] Cache Test orchestration failed.", error);
    setCacheStatus(error.message || "Cache Test stopped unexpectedly.", true);
  } finally {
    const wasAborted = cacheAbortController?.signal.aborted ?? false;
    cacheRun.status = deriveBenchmarkRunStatus(cacheRun.results, {
      wasAborted,
      orchestrationFailed,
    });
    cacheRun.finishedAt = new Date().toISOString();
    cacheRun.totalTestTimeMs = performance.now() - cacheStartedAtMs;
    cacheAbortController = null;
    cacheStartedAtMs = null;
    cacheSampleCapturePending = false;
    setCacheRunning(false);
    renderBenchmarkSafely(renderCacheResults, "Cache Test final state");
    if (typeof updateSpeedRunButtonState === "function") updateSpeedRunButtonState();
    if (typeof updateThinkingRunButtonState === "function") updateThinkingRunButtonState();
    if (typeof updateDecodeRunButtonState === "function") updateDecodeRunButtonState();
    if (typeof updateContextRunButtons === "function") updateContextRunButtons(false);
  }
});

// One model's full sequence: the short variant's cold request + repeats,
// then the padded variant's. A payload and a request body are built once per
// variant and shared by every request of that variant, so the serialized
// bytes stay identical - the premise the test measures.
async function benchmarkCacheModel(result, config, signal, connection, runSeed, modelIndex) {
  if (signal.aborted) {
    result.status = "cancelled";
    return;
  }
  const modelStartedAt = performance.now();
  result.startedAtMs = modelStartedAt;
  result.startedAt = new Date().toISOString();
  result.status = "queued";
  renderBenchmarkSafely(renderCacheResults, `${result.modelId} queued`);

  const variants = getCacheVariants(config);
  const requestsPerVariant = 1 + config.runsPerModel;
  const totalRequests = requestsPerVariant * variants.length;
  const variantPlans = variants.map((variant, variantIndex) => {
    // The busted control reuses the padded variant's filler (payloadIndex 1),
    // so its prompt differs from the padded prompt only by the per-request
    // nonce - identical content, cache impossible. That is the cleanest
    // possible A/B for the cache effect.
    const sharesPaddedFiller = variant.key === "busted";
    const payload = generateCachePromptPayload({
      runSeed,
      payloadIndex: modelIndex * variants.length + (sharesPaddedFiller ? 1 : variantIndex),
      targetTokens: variant.targetTokens,
    });
    return {
      variant,
      payload,
      // The busted variant cannot share a body: every request prepends a
      // fresh nonce, so its body is rebuilt per request in the loop below.
      body: variant.bustsCache
        ? null
        : buildCacheRequestBody(result.modelId, config, payload.prompt, connection.provider),
    };
  });

  let requestIndex = 0;
  for (const plan of variantPlans) {
    for (let repeatIndex = 0; repeatIndex < requestsPerVariant; repeatIndex += 1) {
      if (signal.aborted) break;
      const phase = repeatIndex === 0 ? "cold" : "warm";
      const label = phase === "cold"
        ? `${plan.variant.key}-cold`
        : `${plan.variant.key}-warm-${repeatIndex}`;
      requestIndex += 1;
      result.status = `run ${requestIndex}/${totalRequests}`;
      renderBenchmarkSafely(renderCacheResults, `${result.modelId} ${label} start`);
      const measurementStartedAtMs = performance.now();
      try {
        // Busted requests prepend a fresh nonce to the shared filler, busting
        // the prefix cache; every other variant resends its stable body.
        const requestBody = plan.variant.bustsCache
          ? buildCacheRequestBody(
            result.modelId,
            config,
            `${generateCacheNonce()}\n${plan.payload.prompt}`,
            connection.provider,
          )
          : plan.body;
        const measurement = await runCacheRequest(result, plan, requestBody, config, signal, label, phase, connection);
        measurement.testTimeStartMs = measurementStartedAtMs;
        measurement.testTimeEndMs = performance.now();
        result.runs.push({ index: requestIndex, variant: plan.variant.key, ...measurement });
      } catch (error) {
        if (signal.aborted) break;
        console.error(`[LLM Quick Bench] Cache Test request ${label} failed for ${result.modelId}.`, error);
        result.errors.push({
          run: requestIndex,
          variant: plan.variant.key,
          phase,
          message: error.message,
        });
      }
      renderBenchmarkSafely(renderCacheResults, `${result.modelId} ${label} result`);
    }
  }

  result.status = signal.aborted
    ? "cancelled"
    : result.runs.length > 0
      ? (result.errors.length > 0 ? "partial" : "complete")
      : "error";
  result.finishedAt = new Date().toISOString();
  result.totalTestTimeMs = performance.now() - modelStartedAt;
  renderBenchmarkSafely(renderCacheResults, `${result.modelId} final state`);
}

async function runCacheRequest(result, plan, body, config, signal, runLabel, phase, connection) {
  // Capture the padded variant's first warm repeat: the most interesting
  // exchange (a full cache-hit response with its usage split).
  const captureExchange = runLabel === "padded-warm-1"
    && cacheRun != null
    && cacheRun.sampleExchange == null
    && !cacheSampleCapturePending;
  if (captureExchange) cacheSampleCapturePending = true;
  let stream;
  try {
    stream = await runStreamingChatCompletion({
      modelId: result.modelId,
      config,
      outerSignal: signal,
      runLabel,
      connection,
      // Short and padded variants pass their stable per-variant body (the
      // same object every time, so the serialized bytes are identical); the
      // busted variant passes a body freshly rebuilt around a new nonce.
      body,
      logName: CACHE_LOG_NAME,
      captureExchange,
    });
  } catch (error) {
    if (captureExchange) cacheSampleCapturePending = false;
    throw error;
  }

  const correct = gradeCacheAnswer(stream.contentText);
  const relevantMeasurement = { ...stream.measurement };
  delete relevantMeasurement.tokensPerSecond;
  const cost = calculateCacheCost({
    promptTokens: stream.measurement.promptTokens,
    cachedTokens: stream.measurement.cachedTokens,
    inputPrice: result.pricing?.inputPerMillionTokens,
    cachedInputPrice: result.pricing?.cachedInputPerMillionTokens,
  });
  const measurement = {
    ...relevantMeasurement,
    phase,
    variant: plan.variant.key,
    targetPayloadTokens: plan.variant.targetTokens,
    estimatedPayloadTokens: plan.payload.estimatedTokens,
    correct,
    cost,
  };

  if (!correct) {
    const excerpt = stream.contentText.length > 200
      ? `${stream.contentText.slice(0, 200)}…`
      : stream.contentText;
    console.log(
      `[${CACHE_LOG_NAME}] FAILURE · ${result.modelId} · ${runLabel}\n` +
      `--- MODEL RESPONSE ---\n${stream.contentText}\n` +
      `--- ANALYSIS ---\n` +
      `Expected: an answer mentioning Paris.\n` +
      `Variant: ${plan.variant.key} (${plan.variant.label}).\n` +
      `Response: "${excerpt}"\n` +
      `Content: ${stream.contentText.length} chars.`,
    );
  }

  if (captureExchange && cacheRun && !cacheRun.sampleExchange) {
    const gradingBlock = [
      "--- GRADING ---",
      `Variant: ${plan.variant.label} · ${phase} request`,
      "Expected: an answer mentioning Paris",
      `Correct: ${correct}`,
      "--- CACHE ---",
      `Phase: ${phase}`,
      `Prompt tokens: ${measurement.promptTokens}`,
      `Server-reported cached tokens: ${measurement.cachedTokens ?? "(endpoint did not report the cache split)"}`,
      `Input-side cost: ${formatCost(measurement.cost)}`,
    ].join("\n");
    cacheRun.sampleExchange = {
      modelId: result.modelId,
      runLabel,
      capturedAt: new Date().toISOString(),
      task: {
        variant: plan.variant.key,
        variantLabel: plan.variant.label,
        targetPayloadTokens: plan.variant.targetTokens,
        estimatedPayloadTokens: plan.payload.estimatedTokens,
        correct,
      },
      // Long payloads make the captured exchange huge; keep the head and tail
      // of each text so the structure, usage split, and grading stay visible
      // without rendering megabytes into the page.
      request: truncateCacheSampleText(stream.request),
      response: truncateCacheSampleText(stream.response),
      consolidatedOutput: truncateCacheSampleText(
        `${stream.consolidatedOutput}\n\n${gradingBlock}`,
      ),
    };
    renderBenchmarkSafely(renderCacheMethodologySample, "Cache Test sample exchange");
  }
  if (captureExchange) cacheSampleCapturePending = false;

  logBenchmarkEvent(config, CACHE_LOG_NAME, "completion summary", {
    model: result.modelId,
    run: runLabel,
    measurement,
  });
  return measurement;
}

function truncateCacheSampleText(text) {
  if (typeof text !== "string" || text.length <= CACHE_SAMPLE_TEXT_LIMIT) return text;
  const half = Math.floor(CACHE_SAMPLE_TEXT_LIMIT / 2);
  const omitted = text.length - CACHE_SAMPLE_TEXT_LIMIT;
  return [
    text.slice(0, half),
    `… ${omitted} characters omitted from the middle of this capture …`,
    text.slice(text.length - half),
  ].join("\n");
}

// Pre-run confirmation content: totals the planned requests and input tokens
// per model (all variants, cold + repeats) and estimates the input cost at
// full pricing - cache hits would only lower it, and the busted control
// always pays full price.
function buildCacheConfirmContent(selectedModels, config) {
  const repeats = 1 + config.runsPerModel;
  const requestsPerModel = getCacheVariants(config).length * repeats;
  const shortTokens = generateCachePromptPayload({
    runSeed: 1,
    payloadIndex: 0,
    targetTokens: 0,
  }).estimatedTokens;
  const paddedTokens = generateCachePromptPayload({
    runSeed: 1,
    payloadIndex: 1,
    targetTokens: config.payloadTokens,
  }).estimatedTokens;
  // The busted control shares the padded filler and adds a ~10-token nonce.
  const bustedTokens = paddedTokens + 10;
  const plans = selectedModels.map((model) => {
    const inputPrice = Number.isFinite(model?.inputPrice) ? model.inputPrice : null;
    const inputTokens = repeats * (shortTokens + paddedTokens + bustedTokens);
    return {
      modelId: model.modelId,
      // Short name in the dialog; the full id stays in the row tooltip.
      label: shortModelLabel(model.modelId),
      requests: requestsPerModel,
      inputTokens,
      cost: inputPrice != null && inputTokens > 0
        ? (inputTokens / 1_000_000) * inputPrice
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
    rows: plans.map((plan) => ({
      label: plan.label,
      title: plan.modelId,
      detail: `${plan.requests} requests (short + padded + nonce-busted, cold + ${config.runsPerModel} repeat${config.runsPerModel === 1 ? "" : "s"} each) · about ${formatInteger(plan.inputTokens)} input tokens`,
      meta: plan.cost != null ? `input cost about ${formatCost(plan.cost)}` : "pricing unknown",
      muted: false,
    })),
    totals: {
      detail: `${formatInteger(totalRequests)} requests · about ${formatInteger(totalTokens)} input tokens`,
      meta: totalCost != null ? `estimated input cost about ${formatCost(totalCost)}` : null,
    },
    note: "Estimated at full input pricing - prompt-cache hits reduce the repeats' cost, while the nonce-busted requests always pay full price. Output tokens (a few per request) are not included.",
  };
}

// One results row per model × variant. Before a run, selected models preview
// as queued rows so the table fills in live.
function getCacheRunRows(config) {
  const variants = getCacheVariants(config);
  const requestsPerVariant = 1 + config.runsPerModel;
  const results = cacheRun
    ? cacheRun.results
    : MODELS.filter((model) => model.selected).map((model) => ({
      modelId: model.modelId,
      status: "queued",
      runs: [],
      errors: [],
      pricing: {
        inputPerMillionTokens: model.inputPrice,
        outputPerMillionTokens: model.outputPrice,
        cachedInputPerMillionTokens: model.cachedInputPrice,
      },
    }));
  const rows = [];
  results.forEach((result) => {
    variants.forEach((variant) => {
      const runs = result.runs.filter((run) => run.variant === variant.key);
      const failed = result.errors.filter((error) => error.variant === variant.key).length;
      rows.push({
        result,
        variant,
        runs,
        failed,
        perGroup: requestsPerVariant,
        summary: summarizeCacheRuns(runs, failed),
        cost: summarizeCacheRowCost(result, runs),
        status: contextGroupStatus({
          result,
          runs,
          failed,
          perGroup: requestsPerVariant,
          comboIndex: variant.comboIndex,
        }),
      });
    });
  });
  return rows;
}

// Cost figures for one row: the cold request's cost, the warm p50 cost, and
// the savings between them. Without cached pricing metadata the cached share
// bills at the full input price (calculateCacheCost's fallback), so savings
// read 0% rather than "-": the honest "no known discount", and it becomes a
// real number the moment a cached price is added to the catalog.
function summarizeCacheRowCost(result, runs) {
  const hasCachedPrice = Number.isFinite(result.pricing?.cachedInputPerMillionTokens);
  const coldRun = runs.find((run) => run.phase === "cold") ?? null;
  const warmRuns = runs.filter((run) => run.phase === "warm");
  const coldCost = coldRun != null && Number.isFinite(coldRun.cost) ? coldRun.cost : null;
  const warmCostP50 = percentile(
    warmRuns.map((run) => run.cost).filter((cost) => Number.isFinite(cost)),
    0.5,
  );
  return {
    // Kept for the tooltip: whether the catalog carries a cached price or
    // the input-price fallback is in play.
    hasCachedPrice,
    coldCost,
    warmCostP50,
    costSavingsPct: calculateCacheSavingsPct(coldCost, warmCostP50),
  };
}

// Wall-clock time for one variant's requests (cold + repeats): ticks live
// from the first request's dispatch while the variant runs, frozen once done.
function getCacheVariantElapsedMs(view) {
  const first = view.runs.find((run) => Number.isFinite(run.testTimeStartMs));
  if (first == null) return null;
  const last = view.runs[view.runs.length - 1];
  const endMs = Number.isFinite(last?.testTimeEndMs) ? last.testTimeEndMs : performance.now();
  return Math.max(0, endMs - first.testTimeStartMs);
}

function formatCachePercent(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${value.toFixed(1)}%`;
}

function formatCacheInteger(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return formatInteger(value);
}

function formatCacheCost(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return formatCost(value);
}

// Compact tick label for the log-scale TTFT axis: 10 ms, 100 ms, 1 s, 10 s.
function formatCacheTtftTick(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${ms / 1000} s`;
  return `${Math.round(ms / 60000)} min`;
}

// Compact value label printed above each bar: 300 ms, 9.8 s, 2 min.
function formatCacheTtftCompact(ms) {
  if (!Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
  return `${Math.round(ms / 60000)} min`;
}

// One chart per model: three variant groups (short / padded / busted), each
// with a cold-TTFT bar and a warm-p50 bar on a log scale. The log scale keeps
// the tiny short-variant requests visible next to multi-second padded
// prefills. Hovering a group shows the exact numbers.
function renderCacheCharts(rows) {
  cacheChart.replaceChildren();
  const models = [];
  rows.forEach((row) => {
    let entry = models.find((candidate) => candidate.modelId === row.result.modelId);
    if (!entry) {
      entry = { modelId: row.result.modelId, variantRows: [] };
      models.push(entry);
    }
    entry.variantRows.push(row);
  });
  const chartable = models.filter(({ variantRows }) => variantRows.some(
    (row) => Number.isFinite(row.summary.coldTtftMs) || Number.isFinite(row.summary.warmTtftP50),
  ));
  if (chartable.length === 0) {
    const empty = document.createElement("p");
    empty.className = "decode-chart-empty";
    empty.textContent = "The cold-vs-warm chart appears here once the first requests complete.";
    cacheChart.append(empty);
    return;
  }
  chartable.forEach(({ modelId, variantRows }) => {
    cacheChart.append(buildCacheModelChart(modelId, variantRows));
  });
}

function buildCacheModelChart(modelId, variantRows) {
  const wrap = document.createElement("div");
  wrap.className = "decode-line-chart";

  const title = document.createElement("div");
  title.className = "cache-chart-title";
  const label = document.createElement("span");
  label.className = "cache-chart-model";
  label.textContent = shortModelLabel(modelId);
  label.title = modelId;
  const legend = document.createElement("span");
  legend.className = "cache-legend";
  legend.innerHTML = ""
    + '<span class="cache-legend-item"><span class="cache-legend-chip cold"></span>cold TTFT</span>'
    + '<span class="cache-legend-item"><span class="cache-legend-chip warm"></span>warm p50</span>';
  title.append(label, legend);
  wrap.append(title);

  const tooltip = document.createElement("div");
  tooltip.className = "decode-tooltip";
  tooltip.hidden = true;
  wrap.append(tooltip);

  const width = 480;
  const height = 240;
  const padLeft = 60;
  const padRight = 10;
  const padTop = 22;
  const padBottom = 36;
  const innerWidth = width - padLeft - padRight;
  const innerHeight = height - padTop - padBottom;

  // Log-scale domain across this model's positive cold/warm TTFTs.
  const values = variantRows.flatMap((row) => [row.summary.coldTtftMs, row.summary.warmTtftP50])
    .filter((value) => Number.isFinite(value) && value > 0);
  const logMin = Math.floor(Math.log10(Math.min(...values)));
  const logMax = Math.ceil(Math.log10(Math.max(...values)));
  const span = Math.max(1, logMax - logMin);
  const yFor = (value) => padTop + (1 - (Math.log10(value) - logMin) / span) * innerHeight;

  const parts = [];
  for (let decade = logMin; decade <= logMax; decade += 1) {
    const y = yFor(10 ** decade);
    parts.push(`<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}" class="decode-grid"/>`);
    parts.push(`<text x="${padLeft - 8}" y="${(y + 4).toFixed(1)}" class="decode-tick" text-anchor="end">${formatCacheTtftTick(10 ** decade)}</text>`);
  }
  parts.push(`<line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${height - padBottom}" class="decode-axis"/>`);
  parts.push(`<line x1="${padLeft}" y1="${height - padBottom}" x2="${width - padRight}" y2="${height - padBottom}" class="decode-axis"/>`);
  parts.push(`<text x="${padLeft}" y="${padTop - 8}" class="decode-axis-label">TTFT</text>`);

  const baseline = height - padBottom;
  const barWidth = 30;
  const barGap = 8;
  const pairWidth = barWidth * 2 + barGap;

  const svgNamespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("class", "decode-chart-svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Cold versus warm time-to-first-token by variant for ${modelId}`);
  svg.innerHTML = parts.join("");

  variantRows.forEach((row, index) => {
    const groupCenter = padLeft + (innerWidth * (index + 0.5)) / variantRows.length;
    const pairLeft = groupCenter - pairWidth / 2;
    const { summary } = row;
    const bars = [
      {
        key: "cold",
        value: summary.coldTtftMs,
        className: "cache-bar-cold",
        tooltip: formatCacheTtftCompact(summary.coldTtftMs),
      },
      {
        key: "warm",
        value: summary.warmTtftP50,
        className: "cache-bar-warm",
        // The warm bar also carries its improvement over the cold request.
        tooltip: Number.isFinite(summary.warmTtftP50) && Number.isFinite(summary.ttftReductionPct)
          ? `${formatCacheTtftCompact(summary.warmTtftP50)} · ${Math.round(summary.ttftReductionPct)}% faster`
          : formatCacheTtftCompact(summary.warmTtftP50),
      },
    ];
    bars.forEach((bar, barIndex) => {
      if (!Number.isFinite(bar.value) || bar.value <= 0) return;
      const barLeft = pairLeft + barIndex * (barWidth + barGap);
      const topY = yFor(bar.value);
      const barHeight = Math.max(2, baseline - topY);
      const rect = document.createElementNS(svgNamespace, "rect");
      rect.setAttribute("x", barLeft.toFixed(1));
      rect.setAttribute("y", (baseline - barHeight).toFixed(1));
      rect.setAttribute("width", barWidth);
      rect.setAttribute("height", barHeight.toFixed(1));
      rect.setAttribute("rx", "3");
      rect.setAttribute("class", bar.className);
      rect.dataset.tooltip = bar.tooltip;
      svg.append(rect);

      // The bar's number, printed right above it.
      const valueLabel = document.createElementNS(svgNamespace, "text");
      valueLabel.setAttribute("x", (barLeft + barWidth / 2).toFixed(1));
      valueLabel.setAttribute("y", Math.max(padTop - 2, topY - 6).toFixed(1));
      valueLabel.setAttribute("class", "cache-bar-value");
      valueLabel.setAttribute("text-anchor", "middle");
      valueLabel.textContent = formatCacheTtftCompact(bar.value);
      svg.append(valueLabel);
    });

    const groupLabel = document.createElementNS(svgNamespace, "text");
    groupLabel.setAttribute("x", groupCenter.toFixed(1));
    groupLabel.setAttribute("y", `${baseline + 18}`);
    groupLabel.setAttribute("class", "decode-tick");
    groupLabel.setAttribute("text-anchor", "middle");
    groupLabel.textContent = row.variant.key === "short"
      ? "Short"
      : row.variant.key === "padded" ? "Padded" : "Busted";
    svg.append(groupLabel);
  });

  // Hovering a bar shows its value; the warm bar adds its improvement %.
  svg.addEventListener("mousemove", (event) => {
    const bar = event.target.closest?.("rect.cache-bar-cold, rect.cache-bar-warm");
    if (bar) {
      tooltip.textContent = bar.dataset.tooltip;
      tooltip.hidden = false;
    } else {
      tooltip.hidden = true;
      return;
    }
    tooltip.style.left = `${event.clientX + 12}px`;
    tooltip.style.top = `${event.clientY + 12}px`;
  });
  svg.addEventListener("mouseleave", () => { tooltip.hidden = true; });

  wrap.append(svg);
  return wrap;
}

function renderCacheResults() {
  const config = activeCacheConfig();
  const rows = getCacheRunRows(config);
  renderCacheCharts(rows);

  if (cacheRun) {
    const elapsedMs = cacheRun.totalTestTimeMs
      ?? (cacheStartedAtMs === null ? null : performance.now() - cacheStartedAtMs);
    cacheSummaryTime.textContent = formatDuration(elapsedMs);
    const reductions = rows
      .map((row) => row.summary.ttftReductionPct)
      .filter((value) => Number.isFinite(value));
    cacheSummaryBest.textContent = reductions.length > 0
      ? `${Math.max(...reductions).toFixed(1)}%`
      : "-";
    const runUsage = summarizeRunUsage(cacheRun.results);
    cacheSummaryTotalTokens.textContent = formatInteger(runUsage.totalTokens);
    const costSummary = summarizeCacheRunCost(cacheRun.results);
    cacheSummaryCost.textContent = costSummary.costedRequests === 0
      ? "-"
      : costSummary.unpricedRequests > 0
        ? `${formatCost(costSummary.totalCost)} + unpriced`
        : formatCost(costSummary.totalCost);
    cacheSummaryCost.title = costSummary.unpricedRequests > 0
      ? "Some requests lack pricing metadata and are excluded from this cost total."
      : "All cold and repeat requests, cache pricing applied where the server reported cached tokens.";
    cacheSummarySavings.textContent = formatCachePercent(costSummary.savingsPct);
    cacheSummarySavings.title = "Total prompt-token cost with server-reported cache pricing vs the same requests at full input price.";
    updateCacheUsageNote(runUsage, costSummary);
  }

  cacheTable.updateHeaders();
  cacheBody.replaceChildren();
  const views = cacheTable.sortRows(rows, getCacheSortValue);
  if (views.length === 0) {
    const emptyRow = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = cacheSortHeaders.length;
    cell.className = "context-empty-cell";
    cell.textContent = "Select one or more models above, then run the Cache Test to populate this table.";
    emptyRow.append(cell);
    cacheBody.append(emptyRow);
  } else {
    views.forEach((view) => {
      cacheBody.append(buildCacheResultRow(view));
    });
  }
}

function buildCacheResultRow(view) {
  const { result, variant, summary, cost } = view;
  const row = document.createElement("tr");
  row.dataset.modelId = result.modelId;
  row.dataset.variant = variant.key;
  const warmCorrect = view.runs.filter((run) => run.phase === "warm" && run.correct).length;

  cacheTable.allKeys.forEach((key) => {
    const cell = document.createElement("td");
    cell.dataset.cacheColumn = key;
    cell.hidden = !cacheTable.isVisible(key);
    cacheTable.markCell(cell, key);
    switch (key) {
      case "modelId":
        cell.textContent = shortModelLabel(result.modelId);
        cell.title = result.modelId;
        break;
      case "status":
        renderBenchmarkStatusCell(cell, view.status.text, view.status.className, result);
        break;
      case "payloadTokens":
        cell.textContent = variant.key === "short"
          ? "Short"
          : variant.key === "busted"
            ? `Busted · ${formatContextSize(variant.targetTokens)}`
            : `Padded · ${formatContextSize(variant.targetTokens)}`;
        cell.title = variant.key === "short"
          ? "bare question, no filler - below most providers' cacheable minimum"
          : variant.key === "busted"
            ? "the padded prompt with a fresh nonce prepended to every request - the prefix cache can never match; the no-cache control"
            : `question + about ${formatInteger(variant.targetTokens)} tokens of filler padding`;
        break;
      case "promptTokensP50":
        cell.textContent = formatCacheInteger(summary.promptTokensP50);
        cell.title = "Server-reported prompt tokens for this variant's prompt (median across its requests); compare with the configured size in the Variant column.";
        break;
      case "coldTtftMs":
        cell.textContent = formatMilliseconds(summary.coldTtftMs);
        break;
      case "warmTtftP50":
      case "warmTtftP90":
        cell.textContent = formatMilliseconds(summary[key]);
        break;
      case "ttftReductionPct":
        cell.textContent = formatCachePercent(summary.ttftReductionPct);
        cell.title = "(cold TTFT − warm TTFT p50) ÷ cold TTFT";
        break;
      case "coldCachedTokens":
        cell.textContent = formatCacheInteger(summary.coldCachedTokens);
        cell.title = "Server-reported cached tokens on the cold request; '-' when the endpoint does not report the split.";
        break;
      case "warmCachedTokensP50":
        cell.textContent = formatCacheInteger(summary.warmCachedTokensP50);
        cell.title = "Median server-reported cached tokens across the warm repeats.";
        break;
      case "cachedTokensTotal":
        cell.textContent = formatCacheInteger(getCacheCachedTokensTotal(view));
        cell.title = "Server-reported cached tokens summed across this variant's requests (cold + repeats); '-' when the endpoint does not report the split.";
        break;
      case "cacheHitPct":
        cell.textContent = formatCachePercent(summary.cacheHitPct);
        cell.title = "warm cached tokens p50 ÷ warm prompt tokens p50, server-reported";
        break;
      case "coldCost":
        cell.textContent = formatCacheCost(cost.coldCost);
        cell.title = "Cold request prompt-token cost at full input pricing.";
        break;
      case "warmCostP50":
        cell.textContent = formatCacheCost(cost.warmCostP50);
        cell.title = "Median warm prompt-token cost, cached tokens billed at the cached input price.";
        break;
      case "costSavingsPct":
        cell.textContent = formatCachePercent(cost.costSavingsPct);
        if (cost.hasCachedPrice) {
          cell.title = "(cold cost − warm cost p50) ÷ cold cost";
        } else {
          // Little "!" marker: the savings number comes from the input-price
          // fallback because the catalog has no cached price for this model.
          // Wired to the app's instant styled tooltip (native title tooltips
          // dwell too long and get destroyed by the live per-second
          // re-render while a run is active).
          const indicator = document.createElement("span");
          indicator.className = "cache-price-fallback-indicator";
          indicator.textContent = "!";
          indicator.setAttribute("aria-label", "No cached pricing found, using default pricing");
          indicator.tabIndex = 0;
          const fallbackMessage = "No cached pricing found, using default pricing - cached tokens bill at the input price, so savings read 0% until a cached price is added to the catalog.";
          indicator.addEventListener("mouseenter", () => showBenchmarkErrorTooltip(indicator, fallbackMessage));
          indicator.addEventListener("mouseleave", hideBenchmarkErrorTooltip);
          indicator.addEventListener("focusin", () => showBenchmarkErrorTooltip(indicator, fallbackMessage));
          indicator.addEventListener("focusout", hideBenchmarkErrorTooltip);
          cell.append(indicator);
        }
        break;
      case "warmAccuracy": {
        cell.textContent = formatRatioPercent(summary.warmAccuracy, 1, warmCorrect, summary.warmRuns);
        const accuracyHighlight = getAccuracyHighlightClass(summary.warmAccuracy);
        if (accuracyHighlight) cell.classList.add(accuracyHighlight);
        break;
      }
      case "testTimeMs": {
        const elapsedMs = getCacheVariantElapsedMs(view);
        cell.classList.add("context-time-cell");
        cell.textContent = elapsedMs == null ? "-" : formatDuration(elapsedMs);
        cell.title = "Wall-clock time for this variant's requests (cold + repeats); ticks live while running.";
        break;
      }
      default:
        cell.textContent = "-";
    }
    row.append(cell);
  });

  const runsTitle = view.runs.length > 0
    ? `${result.modelId} · ${variant.label} · ${view.runs.length}/${view.perGroup} requests`
    : `${result.modelId} · ${variant.label} · not run yet`;
  row.title = runsTitle;
  return row;
}

// Server-reported cached tokens summed across a variant row's requests:
// null when no run reported the split, so the honest "unknown" is kept.
function getCacheCachedTokensTotal(view) {
  const values = view.runs
    .map((run) => run.cachedTokens)
    .filter((value) => Number.isFinite(value));
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

function getCacheSortValue(view, sortKey) {
  switch (sortKey) {
    // Sort by the displayed (vendor-stripped) name so the visual order is
    // alphabetical; the full id stays in the tooltip and exports.
    case "modelId": return shortModelLabel(view.result.modelId).toLowerCase();
    case "status": return view.status.text;
    case "payloadTokens": return view.variant.targetTokens;
    case "promptTokensP50": return view.summary.promptTokensP50;
    case "coldTtftMs": return view.summary.coldTtftMs;
    case "warmTtftP50": return view.summary.warmTtftP50;
    case "warmTtftP90": return view.summary.warmTtftP90;
    case "ttftReductionPct": return view.summary.ttftReductionPct;
    case "coldCachedTokens": return view.summary.coldCachedTokens;
    case "warmCachedTokensP50": return view.summary.warmCachedTokensP50;
    case "cachedTokensTotal": return getCacheCachedTokensTotal(view);
    case "cacheHitPct": return view.summary.cacheHitPct;
    case "coldCost": return view.cost.coldCost;
    case "warmCostP50": return view.cost.warmCostP50;
    case "costSavingsPct": return view.cost.costSavingsPct;
    case "warmAccuracy": return view.summary.warmAccuracy;
    case "testTimeMs": return getCacheVariantElapsedMs(view);
    default: return null;
  }
}

// Summary-card cost across the whole run: actual input cost (cache pricing
// applied to server-reported cached tokens) plus output cost, against the
// same requests priced at full input rates.
function summarizeCacheRunCost(results) {
  let inputCost = 0;
  let noCacheInputCost = 0;
  let outputCost = 0;
  let costedRequests = 0;
  let unpricedRequests = 0;
  results.forEach((result) => {
    const inputPrice = result.pricing?.inputPerMillionTokens;
    const outputPrice = result.pricing?.outputPerMillionTokens;
    result.runs.forEach((run) => {
      if (!Number.isFinite(run.promptTokens)) return;
      if (!Number.isFinite(inputPrice)) {
        unpricedRequests += 1;
        return;
      }
      costedRequests += 1;
      inputCost += Number.isFinite(run.cost)
        ? run.cost
        : (run.promptTokens * inputPrice) / 1_000_000;
      noCacheInputCost += (run.promptTokens * inputPrice) / 1_000_000;
      if (Number.isFinite(run.completionTokens) && Number.isFinite(outputPrice)) {
        outputCost += (run.completionTokens * outputPrice) / 1_000_000;
      }
    });
  });
  return {
    totalCost: inputCost + outputCost,
    savingsPct: costedRequests > 0 && unpricedRequests === 0 && noCacheInputCost > 0
      ? (1 - inputCost / noCacheInputCost) * 100
      : null,
    costedRequests,
    unpricedRequests,
  };
}

function updateCacheUsageNote(runUsage, costSummary) {
  const notes = [
    "Each row is one model × variant (short = bare question, padded = question + filler to the configured size, busted = the padded prompt with a fresh per-request nonce so the cache can never hit). Per variant: 1 cold request followed by repeats - byte-identical for short and padded, nonce-fresh for busted.",
    "The busted rows are the no-cache control: their cold/warm split is meaningless by design (every request is a guaranteed miss), so expect ~0% cache hit, ~0% TTFT reduction, and ~0% cost savings there - the contrast with the padded row is the cache effect.",
    "Input tokens is the server-reported prompt size for the variant (median across its requests); compare it with the configured size in the Variant column.",
    "Cache hit % = warm cached tokens p50 ÷ warm prompt tokens p50, taken from the server-reported usage split; endpoints that do not report cached_tokens show -.",
    "TTFT reduction = (cold TTFT − warm TTFT p50) ÷ cold TTFT; percentiles use nearest-rank selection across successful repeats.",
    "Costs cover prompt tokens; the warm cost bills server-reported cached tokens at the model's cached-input price. Models without cached pricing metadata (marked ! on the savings cell) fall back to the input price for the cached share, so their savings read 0% until a cached price is added to the catalog.",
    "Warm accuracy checks each repeat still answers Paris.",
  ];
  if (runUsage.hasEstimated) {
    notes.push("* Some token counts are estimated because the endpoint omitted streaming usage; compare their costs cautiously.");
  }
  if (costSummary.unpricedRequests > 0) {
    notes.push("Some requests lack pricing metadata and are excluded from the displayed cost and savings.");
  }
  cacheUsageNote.textContent = notes.join(" ");
}

// Exports mirror the table: one row per model × variant, restricted to the
// columns currently selected in the picker. Test time exports as seconds.
function getCacheExportValue(view, exportKey) {
  switch (exportKey) {
    case "modelId": return view.result.modelId;
    case "status": return view.status.text;
    case "payloadTokens": return view.variant.key;
    case "coldCost": return view.cost.coldCost;
    case "warmCostP50": return view.cost.warmCostP50;
    case "costSavingsPct": return view.cost.costSavingsPct;
    case "testTimeMs": {
      const elapsedMs = getCacheVariantElapsedMs(view);
      return elapsedMs == null ? null : +(elapsedMs / 1000).toFixed(3);
    }
    default:
      return getCacheSortValue(view, exportKey);
  }
}

function getCacheExportTotalValue(exportKey) {
  const values = {
    modelId: "TOTAL RUN",
    status: cacheRun?.status ?? "",
    payloadTokens: null,
    promptTokensP50: null,
    coldTtftMs: null,
    warmTtftP50: null,
    warmTtftP90: null,
    ttftReductionPct: null,
    coldCachedTokens: null,
    warmCachedTokensP50: null,
    cachedTokensTotal: null,
    cacheHitPct: null,
    coldCost: null,
    warmCostP50: null,
    costSavingsPct: null,
    warmAccuracy: null,
    testTimeMs: cacheRun?.totalTestTimeMs == null ? null : +(cacheRun.totalTestTimeMs / 1000).toFixed(3),
  };
  return values[exportKey];
}

function exportCacheCsv() {
  if (!cacheRun) return;
  exportBenchmarkCsvFile({
    filenamePrefix: "llm-cache-test",
    columns: cacheTable.getVisibleDefinitions(),
    results: cacheTable.sortRows(getCacheRunRows(activeCacheConfig()), getCacheSortValue),
    getValue: getCacheExportValue,
    getTotal: getCacheExportTotalValue,
  });
}

function exportCacheJson() {
  if (!cacheRun) return;
  exportBenchmarkJsonFile({
    filenamePrefix: "llm-cache-test",
    columns: cacheTable.getVisibleDefinitions(),
    results: cacheTable.sortRows(getCacheRunRows(activeCacheConfig()), getCacheSortValue),
    getValue: getCacheExportValue,
    getTotal: getCacheExportTotalValue,
    metadata: {
      config: cacheRun.config,
      methodology: cacheRun.methodology,
      runSeed: cacheRun.runSeed,
      executionOrder: cacheRun.executionOrder,
    },
  });
}

// Keeps the live request template readable: show the payload head and tail
// with an omission marker instead of embedding thousands of lines. When the
// preview comes from a capped sample (the configured size exceeds
// CACHE_TEMPLATE_SAMPLE_TOKENS), the real filler count is unknown without
// building the full payload, so cappedNote replaces the count with the
// configured size instead of a misleading sample count.
function truncateCachePromptPreview(prompt, cappedNote = null) {
  const lines = prompt.split("\n");
  if (lines.length <= 20) return prompt;
  const headCount = 6;
  const tailCount = 9;
  const omitted = lines.length - headCount - tailCount;
  return [
    ...lines.slice(0, headCount),
    cappedNote ?? `… ${omitted} filler lines omitted; the full payload is sent in the actual request …`,
    ...lines.slice(-tailCount),
  ].join("\n");
}

// Live-template sample cap: the request template is regenerated on every
// keystroke of the config fields, so above this token count the preview
// renders from a capped sample instead of the full payload. Generation is
// deterministic per (runSeed, payloadIndex), so the sample's head and tail
// lines are byte-identical to the real payload's; only the filler count
// differs, which the preview describes via the configured size. The confirm
// dialog and the benchmark itself always build the full payload.
const CACHE_TEMPLATE_SAMPLE_TOKENS = 2048;

function renderCacheRequestTemplate() {
  const config = getCacheConfig();
  const shortPayload = generateCachePromptPayload({ runSeed: 0xC0FFEE, payloadIndex: 0, targetTokens: 0 });
  const sampleCapped = config.payloadTokens > CACHE_TEMPLATE_SAMPLE_TOKENS;
  const paddedPayload = generateCachePromptPayload({
    runSeed: 0xC0FFEE,
    payloadIndex: 1,
    targetTokens: sampleCapped ? CACHE_TEMPLATE_SAMPLE_TOKENS : config.payloadTokens,
  });
  const endpointValue = endpointInput.value.trim() || "https://api.example.com/v1";
  let requestUrl;
  try {
    requestUrl = buildChatCompletionsUrl(endpointValue);
  } catch (error) {
    console.warn("[LLM Quick Bench] Cache Test request preview failed.", error);
    cacheTemplateCode.textContent = "Enter a valid API endpoint to preview the benchmark request.";
    return;
  }
  // Preview the padded variant (the interesting body); the short variant is
  // the same request with just the question as the prompt. Above the sample
  // cap the filler count in the preview is the sample's, not the real
  // payload's, so the omission marker shows the configured size instead.
  const body = buildCacheRequestBody(
    "<selected-model>",
    config,
    truncateCachePromptPreview(
      paddedPayload.prompt,
      sampleCapped
        ? `… filler omitted; the full ${formatContextSize(config.payloadTokens)} payload is sent in the actual request …`
        : null,
    ),
    providerSelect.value,
  );
  const paddedSizeNote = sampleCapped
    ? `≈${formatContextSize(config.payloadTokens)} tokens`
    : `~${paddedPayload.estimatedTokens} tokens`;
  cacheTemplateCode.textContent = [
    `// Fixed question, three variants (short, padded, nonce-busted) × ${1 + config.runsPerModel} requests each: per variant, 1 cold + ${config.runsPerModel} repeat${config.runsPerModel === 1 ? "" : "s"} (byte-identical except the nonce-busted control).`,
    `// Short variant: the bare question (~${shortPayload.estimatedTokens} tokens).`,
    `// Padded variant (shown below): the question after ${formatContextSize(config.payloadTokens)} of filler (${paddedSizeNote}).`,
    formatBenchmarkRequest(requestUrl, body),
  ].join("\n");
}

function renderCacheMethodologySample() {
  const sample = cacheRun?.sampleExchange;
  if (!sample) {
    cacheSampleRequestNote.textContent = "No measured request has been captured yet.";
    cacheSampleResponseNote.textContent = "Run the test to capture an actual request and its complete streamed response.";
    cacheSampleOutputNote.textContent = "Run the test to assemble generated output and the grading verdict from an actual measured request.";
    cacheSampleRequestCode.textContent = "Run a test to capture an actual measured request.";
    cacheSampleResponseCode.textContent = "Run a test to capture its actual streamed response.";
    cacheSampleOutputCode.textContent = "Run a test to capture its consolidated output and grading.";
    return;
  }
  const source = `${sample.modelId} · ${sample.runLabel}`;
  const taskNote = sample.task?.variantLabel != null
    ? `${sample.task.variantLabel} variant (${sample.task.estimatedPayloadTokens} estimated tokens). `
    : "";
  cacheSampleRequestNote.textContent = `${taskNote}Actual request captured from ${source}. Long payloads are truncated head + tail; the API key is redacted.`;
  cacheSampleResponseNote.textContent = `Actual response captured from ${source}. Chunk labels show the decoded network reads.`;
  cacheSampleOutputNote.textContent = `Actual generated deltas from ${source}, consolidated with the grading and cache verdict.`;
  cacheSampleRequestCode.textContent = sample.request;
  cacheSampleResponseCode.textContent = sample.response;
  cacheSampleOutputCode.textContent = sample.consolidatedOutput;
}

function resetCacheResults() {
  cacheRun = null;
  cacheSampleCapturePending = false;
  cacheSummaryTime.textContent = "-";
  cacheSummaryBest.textContent = "-";
  cacheSummaryTotalTokens.textContent = "-";
  cacheSummaryCost.textContent = "-";
  cacheSummaryCost.removeAttribute("title");
  cacheSummarySavings.textContent = "-";
  cacheSummarySavings.removeAttribute("title");
  cacheUsageNote.textContent = "Results will appear here after a Cache Test run.";
  exportCacheCsvButton.disabled = true;
  exportCacheJsonButton.disabled = true;
  cacheResults.hidden = false;
  renderCacheMethodologySample();
  renderBenchmarkSafely(renderCacheResults, "Cache Test reset");
}

function startCacheClock() {
  stopCacheClock();
  cacheStopClock = startThrottledClock(() => {
    if (cacheRun?.status === "running") {
      // Full re-render so the summary time, per-row test times, and statuses
      // all tick while the run is live.
      renderBenchmarkSafely(renderCacheResults, "Cache Test live test time");
    }
  });
}

function stopCacheClock() {
  if (cacheStopClock) {
    cacheStopClock();
    cacheStopClock = null;
  }
}

// Initial state: empty preview table, no sample yet, provider defaults
// applied, and the run button gated on model selection.
resetCacheResults();
applyCacheProviderDefaults(providerSelect.value);
updateCacheRunButtonState();
renderCacheRequestTemplate();


