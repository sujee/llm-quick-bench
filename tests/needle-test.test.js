const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
const benchSource = fs.readFileSync(path.join(projectRoot, "js", "bench-utils.js"), "utf8");
const engineSource = fs.readFileSync(path.join(projectRoot, "js", "context-bench.js"), "utf8");
const needleSource = fs.readFileSync(path.join(projectRoot, "js", "needle-test1.js"), "utf8");
const prefillSource = fs.readFileSync(path.join(projectRoot, "js", "prefill-test1.js"), "utf8");

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
    TextEncoder,
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
    CONTEXT_SECTORS,
    buildContextDocument,
    buildContextMatrixRows,
    buildContextRunRows,
    buildSkippedContextMeasurement,
    calculateEffectiveInputTokensPerSecond,
    contextComboForRun,
    contextDocumentTokensForSize,
    contextGroupStatus,
    contextInputTokensForWindow,
    contextNeedleLineIndex,
    contextNeedleTokenDepth,
    createChunkedUploadBody,
    createSeededRandom,
    extractContextAnswer,
    generateContextTask,
    gradeContextAnswer,
    parseContextInputTokenOptions,
    parseContextPositionPercentOptions,
    renderContextPrompt,
    summarizeContextAccuracy,
    summarizeContextPlannedUsage,
    summarizeContextPositionRuns,
    summarizeRunContextAccuracy,
  };`, context);
  return { context, renderErrors, utils: context.__benchUtils };
}

test("Needle and Prefill tabs, panels, and scripts are wired into the page", () => {
  assert.match(html, /id="needle-test-tab"[\s\S]*aria-controls="needle-test-panel"/);
  assert.match(html, /id="needle-test-panel"[\s\S]*aria-labelledby="needle-test-tab"/);
  assert.match(html, /id="prefill-test-tab"[\s\S]*aria-controls="prefill-test-panel"/);
  assert.match(html, /id="prefill-test-panel"[\s\S]*aria-labelledby="prefill-test-tab"/);

  // The engine must load before the two tests that instantiate it, and all
  // benchmark scripts keep their relative order.
  const scriptOrder = [
    "js/bench-utils.js",
    "js/speed-test1.js",
    "js/thinking-test1.js",
    "js/decode-test1.js",
    "js/context-bench.js",
    "js/needle-test1.js",
    "js/prefill-test1.js",
  ]
    .map((name) => ({ name, index: html.indexOf(`<script src="${name}"`) }));
  scriptOrder.forEach(({ name, index }) => assert.ok(index !== -1, `Missing script ${name}`));
  for (let i = 1; i < scriptOrder.length; i += 1) {
    assert.ok(
      scriptOrder[i].index > scriptOrder[i - 1].index,
      `${scriptOrder[i].name} must load after ${scriptOrder[i - 1].name}`,
    );
  }
  // The old Long Context tab is gone.
  assert.doesNotMatch(html, /context-test1-tab|long-context1\.js/);
});

test("every DOM id referenced by the long-context test files exists in index.html", () => {
  [needleSource, prefillSource].forEach((source) => {
    const referencedIds = [...source.matchAll(/querySelector\("#([a-z0-9-]+)"\)/gi)]
      .map((match) => match[1]);
    const uniqueIds = [...new Set(referencedIds)];
    assert.ok(uniqueIds.length > 10, "each test file references many ids");
    uniqueIds.forEach((id) => {
      assert.match(html, new RegExp(`id="${id}"`), `Missing #${id} in index.html`);
    });
  });
});

test("the long-context engine lives in context-bench.js and the tests only configure it", () => {
  // Pure helpers the engine calls directly.
  const sharedAndUsed = [
    "buildContextMatrixRows",
    "buildContextRunRows",
    "buildSkippedContextMeasurement",
    "calculateEffectiveInputTokensPerSecond",
    "contextComboForRun",
    "contextGroupStatus",
    "contextNeedleTokenDepth",
    "extractContextAnswer",
    "generateContextTask",
    "gradeContextAnswer",
    "summarizeContextPlannedUsage",
    "summarizeRunContextAccuracy",
  ];
  // Building blocks exercised through generateContextTask / the row builders.
  const sharedInternal = [
    "buildContextDocument",
    "contextDocumentTokensForSize",
    "contextNeedleLineIndex",
    "createChunkedUploadBody",
    "createSeededRandom",
    "renderContextPrompt",
    "summarizeContextAccuracy",
    "summarizeContextPositionRuns",
  ];
  const parsingHelpers = [
    "parseContextInputTokenOptions",
    "parseContextPositionPercentOptions",
  ];
  [...sharedAndUsed, ...sharedInternal, ...parsingHelpers].forEach((name) => {
    assert.match(benchSource, new RegExp(`function ${name}\\(`), `${name} should live in bench-utils.js`);
    [engineSource, needleSource, prefillSource].forEach((source) => {
      assert.doesNotMatch(
        source,
        new RegExp(`function ${name}\\(`),
        `${name} should not be redefined in the long-context files`,
      );
    });
  });
  sharedAndUsed.forEach((name) => {
    assert.match(engineSource, new RegExp(`\\b${name}\\(`), `${name} should be used by context-bench.js`);
  });
  // The engine owns the shared factory, registry, and column set.
  ["createContextBenchmark", "contextBenchmarks", "isAnyContextBenchmarkRunning", "resetContextResults", "updateContextRunButtons", "formatContextSize", "CONTEXT_BENCH_COLUMNS"].forEach((name) => {
    assert.match(engineSource, new RegExp(`\\b${name} =|^function ${name}|function ${name}\\(`), `${name} should live in context-bench.js`);
  });
  // Both tests instantiate the factory; neither redefines engine machinery.
  assert.match(needleSource, /createContextBenchmark\(\{/);
  assert.match(prefillSource, /createContextBenchmark\(\{/);
  assert.doesNotMatch(needleSource, /function buildRow|function renderResults\(|createBenchmarkTable\(/);
  assert.doesNotMatch(prefillSource, /function buildRow|function renderResults\(|createBenchmarkTable\(/);
});

test("needle positions parse from the comma-separated field", () => {
  const { utils } = loadBenchUtils();
  // Spread into this realm's array: vm-realm arrays fail prototype-checked deepEqual.
  assert.deepEqual([...utils.parseContextPositionPercentOptions("5,25,50,75,90")], [5, 25, 50, 75, 90]);
  assert.deepEqual([...utils.parseContextPositionPercentOptions("50, 5, 50,25")], [5, 25, 50]);
  assert.deepEqual([...utils.parseContextPositionPercentOptions("0, 49.9, 150")], [0, 50, 100]);
  assert.deepEqual([...utils.parseContextPositionPercentOptions("abc, , x")], []);
  assert.deepEqual([...utils.parseContextPositionPercentOptions(null)], []);
});

test("input sizes parse from the comma-separated field", () => {
  const { utils } = loadBenchUtils();
  assert.deepEqual(
    [...utils.parseContextInputTokenOptions("10000,50000,100000,250000,500000,1000000")],
    [10000, 50000, 100000, 250000, 500000, 1000000],
  );
  assert.deepEqual([...utils.parseContextInputTokenOptions("100000, 10000, 100000")], [10000, 100000]);
  assert.deepEqual([...utils.parseContextInputTokenOptions("500, 2048.4, 20000000")], [1024, 2048, 10485760]);
  assert.deepEqual([...utils.parseContextInputTokenOptions("abc, , x")], []);
  assert.deepEqual([...utils.parseContextInputTokenOptions(null)], []);
});

test("run index maps to its size × position combination (warm-up uses the first)", () => {
  const { utils } = loadBenchUtils();
  const sizes = [10000, 100000];
  const percents = [5, 50];
  // Combos are size-major: 10K@5, 10K@50, 100K@5, 100K@50.
  const combo = (runIndex) => utils.contextComboForRun(runIndex, sizes, percents, 2);
  assert.deepEqual({ ...combo(-1) }, { inputTokens: 10000, positionPercent: 5 });
  assert.deepEqual({ ...combo(0) }, { inputTokens: 10000, positionPercent: 5 });
  assert.deepEqual({ ...combo(2) }, { inputTokens: 10000, positionPercent: 50 });
  assert.deepEqual({ ...combo(4) }, { inputTokens: 100000, positionPercent: 5 });
  assert.deepEqual({ ...combo(6) }, { inputTokens: 100000, positionPercent: 50 });
  assert.deepEqual({ ...combo(8) }, { inputTokens: 10000, positionPercent: 5 });
  // The Needle Test is the degenerate case: one fixed size, positions vary.
  const needleCombo = (runIndex) => utils.contextComboForRun(runIndex, [100000], [5, 50, 90], 3);
  assert.deepEqual({ ...needleCombo(-1) }, { inputTokens: 100000, positionPercent: 5 });
  assert.deepEqual({ ...needleCombo(0) }, { inputTokens: 100000, positionPercent: 5 });
  assert.deepEqual({ ...needleCombo(2) }, { inputTokens: 100000, positionPercent: 5 });
  assert.deepEqual({ ...needleCombo(3) }, { inputTokens: 100000, positionPercent: 50 });
  assert.deepEqual({ ...needleCombo(6) }, { inputTokens: 100000, positionPercent: 90 });
  // The Prefill Test is the other degenerate case: sizes vary, one position.
  const prefillCombo = (runIndex) => utils.contextComboForRun(runIndex, [10000, 50000], [90], 1);
  assert.deepEqual({ ...prefillCombo(-1) }, { inputTokens: 10000, positionPercent: 90 });
  assert.deepEqual({ ...prefillCombo(0) }, { inputTokens: 10000, positionPercent: 90 });
  assert.deepEqual({ ...prefillCombo(1) }, { inputTokens: 50000, positionPercent: 90 });
});

test("needle line index lands at the requested percent of the document", () => {
  const { utils } = loadBenchUtils();
  assert.equal(utils.contextNeedleLineIndex(5, 6421), 321);
  assert.equal(utils.contextNeedleLineIndex(50, 6421), 3210);
  assert.equal(utils.contextNeedleLineIndex(90, 6421), 5778);
  assert.equal(utils.contextNeedleLineIndex(0, 10), 0);
  assert.equal(utils.contextNeedleLineIndex(100, 10), 9);
  assert.equal(utils.contextNeedleLineIndex(50, 8), 4);
  assert.equal(utils.contextNeedleLineIndex(150, 10), 9);
  assert.equal(utils.contextNeedleLineIndex(-10, 10), 0);
});

test("needle token depth reports how deep the needle sits in the document", () => {  const { utils } = loadBenchUtils();
  // Depth tracks the position percent of the input size.
  assert.equal(utils.contextNeedleTokenDepth(117964, 90), 106168);
  assert.equal(utils.contextNeedleTokenDepth(117964, 75), 88473);
  assert.equal(utils.contextNeedleTokenDepth(117964, 50), 58982);
  assert.equal(utils.contextNeedleTokenDepth(117964, 5), 5898);
  assert.equal(utils.contextNeedleTokenDepth(10000, 90), 9000);
  assert.equal(utils.contextNeedleTokenDepth(250000, 90), 225000);
  // No document (unsizable model): null, nothing to measure depth in.
  assert.equal(utils.contextNeedleTokenDepth(0, 90), null);
  assert.equal(utils.contextNeedleTokenDepth(null, 90), null);
  assert.equal(utils.contextNeedleTokenDepth(-100, 90), null);
  // Percent clamps to [0, 100].
  assert.equal(utils.contextNeedleTokenDepth(1000, 150), 1000);
  assert.equal(utils.contextNeedleTokenDepth(1000, -10), 0);
});

test("document targets the requested input size with a minimum floor", () => {
  const { utils } = loadBenchUtils();
  assert.equal(utils.contextDocumentTokensForSize(100000), 100000);
  assert.equal(utils.contextDocumentTokensForSize(250000), 250000);
  assert.equal(utils.contextDocumentTokensForSize(100), 256);
  assert.equal(utils.contextDocumentTokensForSize(null), 256);
});

test("needle sizing fills a share of the model's context window", () => {
  const { utils } = loadBenchUtils();
  // 90% of a 128K window.
  assert.equal(utils.contextInputTokensForWindow(131072, 90), 117964);
  assert.equal(utils.contextInputTokensForWindow(131072), 117964);
  assert.equal(utils.contextInputTokensForWindow(1000, 50), 500);
  // Tiny windows keep the minimum document size.
  assert.equal(utils.contextInputTokensForWindow(100, 90), 256);
  // No window metadata -> null: nothing to size against.
  assert.equal(utils.contextInputTokensForWindow(null, 90), null);
  assert.equal(utils.contextInputTokensForWindow(undefined, 90), null);
  // Fill clamps to [0, 100].
  assert.equal(utils.contextInputTokensForWindow(1000, 150), 1000);
  assert.equal(utils.contextInputTokensForWindow(1000, -10), 256);
});

test("planned usage counts warm-up plus measured requests for the run warning", () => {
  const { utils } = loadBenchUtils();
  // Needle shape: one window-sized document per request. 5 positions x 3
  // measured runs + 1 warm-up, all at 117,964 tokens.
  const needle = utils.summarizeContextPlannedUsage({
    inputTokenSizes: [117964],
    positionCount: 5,
    runsPerCombo: 3,
    contextWindowTokens: 131072,
  });
  assert.equal(needle.requests, 16);
  assert.equal(needle.inputTokens, 117964 * 16);
  // No window metadata: nothing is sent.
  const unsizable = utils.summarizeContextPlannedUsage({
    inputTokenSizes: [0],
    positionCount: 5,
    runsPerCombo: 3,
    contextWindowTokens: null,
  });
  assert.deepEqual({ ...unsizable }, { requests: 0, inputTokens: 0 });
  // Prefill shape: sizes above the model's window are never sent; the
  // warm-up runs at the first runnable size.
  const prefill = utils.summarizeContextPlannedUsage({
    inputTokenSizes: [10000, 50000, 100000, 250000, 500000, 1000000],
    positionCount: 1,
    runsPerCombo: 1,
    contextWindowTokens: 131072,
  });
  assert.equal(prefill.requests, 4);
  assert.equal(prefill.inputTokens, 10000 + 50000 + 100000 + 10000);
  // Prefill without window metadata: every size runs, warm-up included.
  const prefillNowrap = utils.summarizeContextPlannedUsage({
    inputTokenSizes: [10000, 50000, 100000, 250000, 500000, 1000000],
    positionCount: 1,
    runsPerCombo: 1,
    contextWindowTokens: null,
  });
  assert.equal(prefillNowrap.requests, 7);
  assert.equal(
    prefillNowrap.inputTokens,
    10000 + 50000 + 100000 + 250000 + 500000 + 1000000 + 10000,
  );
  // Everything oversized: no requests at all.
  const allOversized = utils.summarizeContextPlannedUsage({
    inputTokenSizes: [250000],
    positionCount: 1,
    runsPerCombo: 1,
    contextWindowTokens: 131072,
  });
  assert.deepEqual({ ...allOversized }, { requests: 0, inputTokens: 0 });
});

test("chunked upload body streams the exact bytes with progress telemetry", async () => {
  const { utils } = loadBenchUtils();
  const live = {};
  const bodyText = JSON.stringify({ messages: [{ content: `entry ${"x".repeat(150000)}` }] });
  const totalBytes = new TextEncoder().encode(bodyText).length;
  const stream = utils.createChunkedUploadBody(bodyText, live);
  assert.equal(live.uploadTotalBytes, totalBytes);
  assert.equal(live.uploadLoadedBytes, 0);
  const chunks = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    // Progress only ever moves forward, in chunk-sized steps.
    assert.ok(live.uploadLoadedBytes > 0 && live.uploadLoadedBytes <= totalBytes);
  }
  const reassembled = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  chunks.forEach((chunk) => {
    reassembled.set(chunk, offset);
    offset += chunk.length;
  });
  assert.equal(new TextDecoder().decode(reassembled), bodyText);
  assert.equal(live.uploadLoadedBytes, totalBytes);
});

test("effective input processing rate divides prompt tokens by TTFT", () => {
  const { utils } = loadBenchUtils();
  assert.equal(utils.calculateEffectiveInputTokensPerSecond(4096, 2000), 2048);
  assert.equal(utils.calculateEffectiveInputTokensPerSecond(100000, 1000), 100000);
  assert.equal(utils.calculateEffectiveInputTokensPerSecond(0, 2000), null);
  assert.equal(utils.calculateEffectiveInputTokensPerSecond(4096, 0), null);
  assert.equal(utils.calculateEffectiveInputTokensPerSecond(NaN, NaN), null);
});

test("generateContextTask is deterministic per seed and varies per question and size", () => {
  const { utils } = loadBenchUtils();
  const first = utils.generateContextTask(0xC0FFEE, 0, 100000, 25);
  const firstAgain = utils.generateContextTask(0xC0FFEE, 0, 100000, 25);
  assert.equal(first.prompt, firstAgain.prompt);
  assert.deepEqual(first.expected, firstAgain.expected);

  const second = utils.generateContextTask(0xC0FFEE, 1, 100000, 25);
  assert.notEqual(first.prompt, second.prompt);

  const otherSize = utils.generateContextTask(0xC0FFEE, 0, 250000, 25);
  assert.notEqual(first.prompt, otherSize.prompt);
  assert.equal(otherSize.targetDocumentTokens, 250000);

  const otherSeed = utils.generateContextTask(0xBADF00D, 0, 100000, 25);
  assert.notEqual(first.prompt, otherSeed.prompt);
});

test("generated documents contain exactly one needle at the requested percent", () => {
  const { utils } = loadBenchUtils();
  const codePattern = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
  const inputTokens = 8192;

  [5, 25, 50, 75, 90].forEach((percent, runIndex) => {
    const task = utils.generateContextTask(0xC0FFEE, runIndex, inputTokens, percent);
    assert.equal(task.inputTokens, inputTokens);
    assert.equal(task.positionPercent, percent);
    assert.ok(codePattern.test(task.code), `code should match the strict format, got ${task.code}`);
    assert.ok(utils.CONTEXT_SECTORS.includes(task.sector));

    const lines = task.prompt.split("\n");
    const documentStart = lines.indexOf("--- DOCUMENT START ---");
    const documentEnd = lines.indexOf("--- DOCUMENT END ---");
    const documentLines = lines.slice(documentStart + 1, documentEnd);
    assert.equal(documentLines.length, task.documentLineCount);
    assert.equal(documentLines[task.needleLineIndex], documentLines.find(
      (line) => line.includes(`access code for sector ${task.sector} is ${task.code}`),
    ));

    const needleLines = documentLines.filter((line) => /access code for sector/i.test(line));
    assert.equal(needleLines.length, 1);
    documentLines.forEach((line, index) => {
      if (index === task.needleLineIndex) return;
      assert.doesNotMatch(line, /access|sector|\bcode\b/i, `filler line must stay neutral: ${line}`);
      assert.doesNotMatch(line, /[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/, `filler line must not contain code-shaped strings: ${line}`);
    });

    const fraction = task.needleLineIndex / (task.documentLineCount - 1);
    assert.ok(Math.abs(fraction - percent / 100) <= 0.01, `needle fraction ${fraction} vs ${percent}%`);

    assert.ok(task.estimatedDocumentTokens >= task.targetDocumentTokens);
    assert.ok(task.estimatedDocumentTokens < task.targetDocumentTokens + 50);
    assert.equal(task.targetDocumentTokens, inputTokens);
    assert.match(lines[0], new RegExp(`access code for the ${task.sector} sector`));
    assert.match(lines[lines.length - 4], new RegExp(`Report the access code for the ${task.sector} sector`));
  });
});

test("answer extraction accepts exactly one code line and grading is case-insensitive", () => {
  const { utils } = loadBenchUtils();
  const expected = { sector: "blue", code: "AB23-CD45-EF67" };

  const exact = utils.extractContextAnswer("AB23-CD45-EF67");
  assert.equal(exact.ok, true);
  assert.equal(exact.code, "AB23-CD45-EF67");
  assert.equal(utils.gradeContextAnswer(exact, expected), true);
  assert.equal(utils.gradeContextAnswer(utils.extractContextAnswer("ab23-cd45-ef67"), expected), true);
  assert.equal(utils.extractContextAnswer("  AB23-CD45-EF67\n").ok, true);
  assert.equal(utils.extractContextAnswer("AB23-CD45-EF67\nextra line").ok, false);
  assert.equal(utils.extractContextAnswer("The code is AB23-CD45-EF67").ok, false);
  assert.equal(utils.extractContextAnswer("AB23-CD45-EF67-XY89").ok, false);
  assert.equal(utils.extractContextAnswer("").ok, false);
  assert.equal(utils.gradeContextAnswer(utils.extractContextAnswer("ZZ99-YY88-XX77"), expected), false);
});

test("skipped measurements mark combinations that cannot run", () => {
  const { utils } = loadBenchUtils();
  // Default reason: oversized input (Prefill Test).
  const skipped = utils.buildSkippedContextMeasurement({ inputTokens: 250000, positionPercent: 90 });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.inputTokens, 250000);
  assert.equal(skipped.positionPercent, 90);
  assert.match(skipped.skipReason, /exceeds the model's advertised context window/);
  // Override reason: no window metadata to size against (Needle Test).
  const unsizable = utils.buildSkippedContextMeasurement({
    inputTokens: 0,
    positionPercent: 50,
    skipReason: "model has no advertised context window to size the document against",
  });
  assert.equal(unsizable.skipped, true);
  assert.equal(unsizable.inputTokens, 0);
  assert.match(unsizable.skipReason, /no advertised context window/);
});

test("combination summaries exclude skipped runs and count failed runs as incorrect", () => {
  const { utils } = loadBenchUtils();
  const runs = [
    { skipped: true },
    { correct: true, formatCompliant: true, ttftMs: 100, endToEndLatencyMs: 400, promptTokens: 100000, reasoningTokens: 0 },
    { correct: false, formatCompliant: true, ttftMs: 200, endToEndLatencyMs: 600, promptTokens: 100000, reasoningTokens: 12 },
    { correct: true, formatCompliant: true, ttftMs: 300, endToEndLatencyMs: 900, promptTokens: 100000, reasoningTokens: 0 },
  ];
  const summary = utils.summarizeContextPositionRuns(runs, 1);
  assert.equal(summary.completed, 3);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.total, 4);
  assert.equal(summary.correct, 2);
  assert.equal(summary.accuracy, 0.5);
  assert.equal(summary.ttftP50, 200);
  assert.equal(summary.ttftP90, 300);
  assert.equal(summary.promptTokensP50, 100000);
  assert.equal(summary.inputTpsP50, 500000);

  const allSkipped = utils.summarizeContextPositionRuns([{ skipped: true }], 0);
  assert.equal(allSkipped.completed, 0);
  assert.equal(allSkipped.accuracy, null);
  assert.equal(allSkipped.inputTpsP50, null);
  const empty = utils.summarizeContextPositionRuns([], 0);
  assert.equal(empty.accuracy, null);
  assert.equal(empty.inputTpsP50, null);
});

test("combination test time spans the first measured run to the last recorded end", () => {
  const { utils } = loadBenchUtils();
  // Stamps are added around each measurement by the engine; the summary
  // spans min start to max end across the row's measured runs.
  const runs = [
    { skipped: true },
    { correct: true, testTimeStartMs: 1000, testTimeEndMs: 2500 },
    { correct: true, testTimeStartMs: 2600, testTimeEndMs: 4100 },
  ];
  const summary = utils.summarizeContextPositionRuns(runs, 0);
  assert.equal(summary.testTimeStartedAtMs, 1000);
  assert.equal(summary.testTimeMs, 3100);
  // Untimed runs (older exports, warm-up-only) and all-skipped rows report
  // no test time.
  const untimed = utils.summarizeContextPositionRuns(
    [{ correct: true, ttftMs: 100 }],
    0,
  );
  assert.equal(untimed.testTimeMs, null);
  assert.equal(untimed.testTimeStartedAtMs, null);
  const allSkipped = utils.summarizeContextPositionRuns([{ skipped: true }], 0);
  assert.equal(allSkipped.testTimeMs, null);
  assert.equal(allSkipped.testTimeStartedAtMs, null);
});

test("run rows bucket runs and failed-run numbers by size × position combination", () => {
  const { utils } = loadBenchUtils();
  const result = {
    modelId: "model-a",
    status: "complete",
    runs: [
      { inputTokens: 100000, positionPercent: 5, correct: true },
      { inputTokens: 100000, positionPercent: 5, correct: false },
      { inputTokens: 100000, positionPercent: 50, correct: true },
      { inputTokens: 100000, positionPercent: 90, skipped: true },
      { inputTokens: 100000, positionPercent: 90, skipped: true },
    ],
    errors: [
      { run: "warmup", message: "ignored" },
      { run: 3, message: "timed out" },
    ],
  };
  // Needle-test shape: one size, three positions, two runs per position.
  const rows = utils.buildContextRunRows([result], [100000], [5, 50, 90], 2);
  assert.equal(rows.length, 3);
  const [row5, row50, row90] = rows;
  assert.equal(row5.comboIndex, 0);
  assert.equal(row5.runs.length, 2);
  assert.equal(row5.failed, 0);
  assert.equal(row5.summary.total, 2);
  // Failed run 3 maps to combo floor((3-1)/2) = 1, the 50% position.
  assert.equal(row50.comboIndex, 1);
  assert.equal(row50.failed, 1);
  assert.equal(row50.summary.total, 2);
  assert.equal(row90.comboIndex, 2);
  assert.equal(row90.summary.skipped, 2);
  assert.equal(row90.summary.total, 0);
  assert.equal(row90.summary.accuracy, null);

  // Prefill-test shape: two sizes, one position, one run per size.
  const prefillResult = {
    modelId: "model-b",
    status: "complete",
    runs: [
      { inputTokens: 10000, positionPercent: 90, correct: true },
      { inputTokens: 50000, positionPercent: 90, correct: true },
    ],
    errors: [{ run: 2, message: "timed out" }],
  };
  const prefillRows = utils.buildContextRunRows([prefillResult], [10000, 50000], [90], 1);
  assert.equal(prefillRows.length, 2);
  assert.equal(prefillRows[0].inputTokens, 10000);
  assert.equal(prefillRows[1].inputTokens, 50000);
  assert.equal(prefillRows[1].failed, 1);
  assert.equal(prefillRows[1].summary.total, 2);
});

test("run rows accept per-model sizes so each model sizes its own documents", () => {
  const { utils } = loadBenchUtils();
  // Needle-test shape: the sizes function reads each model's context window.
  const results = [
    {
      modelId: "model-128k",
      status: "complete",
      runs: [
        { inputTokens: 117964, positionPercent: 5, correct: true },
        { inputTokens: 117964, positionPercent: 90, correct: true },
      ],
      errors: [],
    },
    {
      modelId: "model-nowrap",
      status: "complete",
      runs: [
        { inputTokens: 0, positionPercent: 5, skipped: true },
        { inputTokens: 0, positionPercent: 90, skipped: true },
      ],
      errors: [],
    },
  ];
  const windows = { "model-128k": 131072, "model-nowrap": null };
  const sizesFor = (result) => [
    utils.contextInputTokensForWindow(windows[result.modelId], 90) ?? 0,
  ];
  const rows = utils.buildContextRunRows(results, sizesFor, [5, 90], 1);
  assert.equal(rows.length, 4);
  const model128k = rows.filter((row) => row.modelId === "model-128k");
  assert.ok(model128k.every((row) => row.inputTokens === 117964));
  assert.ok(model128k.every((row) => row.summary.correct === 1));
  const nowrap = rows.filter((row) => row.modelId === "model-nowrap");
  assert.ok(nowrap.every((row) => row.inputTokens === 0));
  assert.ok(nowrap.every((row) => row.summary.skipped === 1 && row.summary.total === 0));
});

test("group status reports queued, running, skipped, partial, and failed states", () => {
  const { utils } = loadBenchUtils();
  const base = { runs: [], failed: 0, perGroup: 2, comboIndex: 0 };
  const expect = (view, text, className) => {
    const status = utils.contextGroupStatus(view);
    assert.equal(status.text, text, `expected "${text}", got "${status.text}"`);
    assert.equal(status.className, className);
  };
  expect({ ...base, result: null }, "-", "");
  expect({ ...base, result: { status: "queued" } }, "Queued", "");
  // The in-flight run counts: "Running 1/2" as soon as the first run starts
  // streaming (not "Running 0/2").
  expect({ ...base, result: { status: "run 1/4" } }, "Running 1/2", "running");
  expect({ ...base, result: { status: "run 2/4" }, runs: [{}] }, "Running 2/2", "running");
  // Failed attempts count toward the in-flight progress too.
  expect({ ...base, result: { status: "run 2/4" }, failed: 1 }, "Running 2/2", "running");
  expect({ runs: [{}, {}], failed: 0, perGroup: 2, comboIndex: 0, result: { status: "run 3/4" } }, "Completed 2/2", "complete");
  expect({ runs: [], failed: 0, perGroup: 2, comboIndex: 1, result: { status: "run 1/4" } }, "Waiting", "");
  expect({ ...base, result: { status: "complete" }, runs: [{}, {}] }, "Completed 2/2", "complete");
  expect({ ...base, result: { status: "partial" }, runs: [{}], failed: 1 }, "Partial 1/2", "partial");
  expect({ ...base, result: { status: "error" }, failed: 2 }, "Failed 0/2", "error");
  expect({ ...base, result: { status: "complete" }, runs: [{ skipped: true }, { skipped: true }] }, "Skipped 2/2", "");
});

test("matrix rows pivot accuracy per model, size, and position", () => {
  const { utils } = loadBenchUtils();
  const runRows = [
    { modelId: "model-a", inputTokens: 100000, positionPercent: 5, summary: { accuracy: 1, total: 1, correct: 1, skipped: 0, failed: 0, completed: 1 } },
    { modelId: "model-a", inputTokens: 100000, positionPercent: 50, summary: { accuracy: 0, total: 2, correct: 0, skipped: 0, failed: 0, completed: 2 } },
    { modelId: "model-a", inputTokens: 100000, positionPercent: 90, summary: { accuracy: null, total: 0, correct: 0, skipped: 2, failed: 0, completed: 0 } },
    { modelId: "model-b", inputTokens: 100000, positionPercent: 5, summary: { accuracy: null, total: 0, correct: 0, skipped: 0, failed: 0, completed: 0 } },
  ];
  const rows = utils.buildContextMatrixRows(runRows, [5, 50, 90]);
  assert.equal(rows.length, 2);
  const [rowA, rowB] = rows;
  assert.equal(rowA.modelId, "model-a");
  assert.equal(rowA.acc5, 1);
  assert.equal(rowA.acc50, 0);
  assert.equal(rowA.acc90, null);
  assert.equal(rowA.byPosition.get(90).skipped, true);
  assert.equal(rowB.acc5, null);
  assert.equal(rowB.byPosition.get(5).pending, true);
});

test("overall accuracy counts measured failures as incorrect and skips as nothing", () => {
  const { utils } = loadBenchUtils();
  const accuracy = utils.summarizeContextAccuracy({
    runs: [
      { correct: true, formatCompliant: true },
      { skipped: true },
      { correct: false, formatCompliant: true },
    ],
    errors: [{ run: 2, message: "timed out" }],
  });
  assert.equal(accuracy.total, 3);
  assert.equal(accuracy.correct, 1);
  assert.equal(accuracy.accuracy, 1 / 3);

  const aggregate = utils.summarizeRunContextAccuracy([
    { runs: [{ correct: true, formatCompliant: true }], errors: [] },
    {
      runs: [{ correct: true, formatCompliant: true }, { skipped: true }, { correct: false, formatCompliant: false }],
      errors: [{ run: 2, message: "timed out" }],
    },
  ]);
  assert.equal(aggregate.total, 4);
  assert.equal(aggregate.correct, 2);
});

test("Needle Test form defaults and configuration follow the bench conventions", () => {
  const panel = html.slice(html.indexOf('id="needle-test-panel"'));
  assert.match(panel, /<label for="needle-fill">Context fill %<\/label>/);
  assert.match(panel, /id="needle-fill"[^>]*min="10" max="100" value="90"/);
  assert.match(panel, /id="needle-positions"[^>]*value="5,25,50,75,90"/);
  assert.match(panel, /<label for="needle-runs">Number of runs per position<\/label>/);
  assert.match(panel, /id="needle-runs"[^>]*min="1" max="20" value="3"/);
  assert.match(panel, /id="needle-require-server-tokens"[^>]*checked/);

  // No thinking toggle by design, and no fixed input size: the document
  // fills a share of each model's context window.
  assert.doesNotMatch(panel, /needle-disable-thinking/);
  assert.doesNotMatch(panel, /needle-size/);
  assert.doesNotMatch(needleSource, /disableThinking|enable_thinking/);
  assert.doesNotMatch(engineSource, /chat_template_kwargs/);

  // Config: fill percent, parsed positions with fallback, runs per position.
  assert.match(needleSource, /fillPercent: getNeedleFillPercent\(\)/);
  assert.match(needleSource, /const DEFAULT_NEEDLE_POSITION_PERCENTS = \[5, 25, 50, 75, 90\];/);
  assert.match(needleSource, /percents\.length > 0 \? percents : \[\.\.\.DEFAULT_NEEDLE_POSITION_PERCENTS\]/);
  assert.equal(
    (needleSource.match(/DEFAULT_NEEDLE_POSITION_PERCENTS/g) ?? []).length,
    2,
    "DEFAULT_NEEDLE_POSITION_PERCENTS should appear only in its declaration and the empty-field fallback",
  );
  assert.match(needleSource, /clampInteger\(needleRunsInput\.value, 1, 20\)/);
  // Temperature is a provider-defaulted optional field (blank for OpenAI).
  assert.match(panel, /id="needle-temperature"[^>]*min="0" max="2" step="0\.1" value="0"/);
  assert.match(needleSource, /temperature: parseOptionalClampedNumber\(needleTemperatureInput\.value, 0, 2\)/);
  assert.match(needleSource, /temperature: config\.temperature,/);
  assert.match(engineSource, /temperature: config\.temperature,/);
  assert.match(engineSource, /function applyContextProviderDefaults\(provider\)[\s\S]*?"temperature" in defaults/);
  assert.match(engineSource, /registerProviderDefaultsApplier\(applyContextProviderDefaults\)/);
  assert.match(engineSource, /dom\.temperatureInput/);

  // Models run one at a time: the parallel-models field is gone and the
  // concurrency is hard-wired to 1, while the Prefill Test keeps its field.
  assert.doesNotMatch(panel, /needle-concurrency/);
  assert.doesNotMatch(needleSource, /needle-concurrency/);
  assert.match(needleSource, /concurrency: 1,/);
  assert.match(prefillSource, /prefill-concurrency/);
  assert.match(html, /id="prefill-concurrency"/);
  // The engine's running status names the execution mode.
  assert.match(engineSource, /one model at a time/);
  assert.match(engineSource, /models in parallel/);

  // Per-model sizing: each model's document fills fill% of its window, and
  // models without window metadata are skipped entirely.
  assert.match(needleSource, /function resolveNeedleSizes\(config, modelId\)/);
  assert.match(needleSource, /contextInputTokensForWindow\(windowTokens, config\.fillPercent\)/);
  assert.match(needleSource, /return \[inputTokens \?\? 0\];/);
  assert.match(needleSource, /function needleSkipNote\(selectedModels\)/);
  assert.match(needleSource, /no context-window metadata and will be skipped entirely/);
  assert.match(needleSource, /% of each model's context window/);
  // The engine resolves sizes per model and computes the skip note through
  // the spec hooks.
  assert.match(engineSource, /resolveSizes = \(config\) => config\.inputTokenSizes \?\? \[\]/);
  assert.match(engineSource, /resolveSizes\(config, result\.modelId\)/);
  assert.match(engineSource, /\(result\) => resolveSizes\(config, result\.modelId\)/);
  assert.match(engineSource, /skipNote\(selectedModels, config\)/);
  // Unsizable models (non-positive sizes) skip every combination with a
  // window-specific reason.
  assert.match(engineSource, /!\(combo\.inputTokens > 0\)/);
  assert.match(engineSource, /no advertised context window to size the document against/);

  // Run confirmation: the Needle Test warns about the planned request and
  // token volume (with estimated input cost) before sending anything, in a
  // styled dialog; the Prefill Test runs without a confirmation.
  assert.match(needleSource, /confirmRun: true/);
  assert.doesNotMatch(prefillSource, /confirmRun/);
  assert.match(engineSource, /confirmRun = false/);
  assert.match(benchSource, /function showBenchmarkConfirm\(/);
  assert.match(engineSource, /await showBenchmarkConfirm\(\{/);
  assert.match(engineSource, /buildRunConfirmContent\(selectedModels, config\)/);
  assert.doesNotMatch(engineSource, /window\.confirm/);
  assert.match(engineSource, /summarizeContextPlannedUsage\(\{/);
  assert.match(engineSource, /cancelled before running - no requests were sent/);

  // The needle test enables the accuracy matrix.
  assert.match(needleSource, /renderMatrix: true/);
  assert.match(needleSource, /matrixPreferenceKey: "llm-quick-bench:needle-matrix-columns:v1"/);
  assert.match(panel, /id="needle-matrix" class="table-frame"/);
  assert.match(panel, /id="export-needle-matrix-csv"/);
});

test("both long-context tests render the shared column set through the engine", () => {
  // Default view: Model | Status | Input tokens | Needle position | Accuracy |
  // Effective input tok/s | TTFT p50 | TTFT p90 | Test time; server tokens
  // stay picker-only. The engine owns the columns; both tests use them.
  assert.match(engineSource, /const CONTEXT_BENCH_COLUMNS = \[/);
  assert.match(
    engineSource,
    /key: "modelId", label: "Model"[\s\S]{0,80}key: "status", label: "Status"[\s\S]{0,80}key: "inputTokens", label: "Input tokens"[\s\S]{0,80}key: "positionPercent", label: "Needle position"[\s\S]{0,80}key: "accuracy", label: "Accuracy"[\s\S]{0,80}key: "inputTpsP50", label: "Effective input tok\/s"[\s\S]{0,80}key: "ttftP50", label: "TTFT p50"[\s\S]{0,80}key: "ttftP90", label: "TTFT p90"[\s\S]{0,80}key: "testTimeMs", label: "Test time"[\s\S]{0,80}key: "promptTokensP50", label: "Server tok p50"/,
  );
  // No send-time column (the raw sendMs measurement stays in the run data).
  assert.doesNotMatch(engineSource, /sendP50/);
  // Status sits second (right after the model) so live progress is always in
  // view; Test time is the last default column and ticks live.
  assert.match(
    engineSource,
    /const CONTEXT_BENCH_DEFAULT_COLUMNS = \[\s*"modelId",\s*"status",\s*"inputTokens",\s*"positionPercent",\s*"accuracy",\s*"inputTpsP50",\s*"ttftP50",\s*"ttftP90",\s*"testTimeMs",\s*\]/,
  );
  // Test time: each measurement is stamped, the cell ticks while running,
  // the clock re-renders, and the export converts to seconds.
  assert.match(engineSource, /measurement\.testTimeStartMs = measurementStartedAtMs;/);
  assert.match(engineSource, /measurement\.testTimeEndMs = performance\.now\(\);/);
  assert.match(engineSource, /\/\^Running\/\.test\(status\.text\)/);
  assert.match(engineSource, /live test time/);
  assert.match(engineSource, /case "testTimeMs":\s*\n\s*return summary\.testTimeMs == null \? null : \+\(summary\.testTimeMs \/ 1000\)\.toFixed\(3\);/);
  assert.match(benchSource, /testTimeMs,\s*\n\s*testTimeStartedAtMs,/);
  // Per-run send phase (dispatch -> headers) stays recorded in the raw
  // measurement data for exports.
  assert.match(benchSource, /const headersAt = performance\.now\(\);/);
  assert.match(benchSource, /sendMs: headersAt - startedAt,/);
  // Live timers: the running row's Test time ticks from the first measured
  // run, via per-model live telemetry stamped by the streaming helper.
  assert.match(benchSource, /liveState\.dispatchAtMs = startedAt;/);
  assert.match(engineSource, /const liveRuns = new Map\(\);/);
  assert.match(engineSource, /liveRuns\.set\(modelId, liveState\);/);
  assert.match(engineSource, /liveRuns\.delete\(modelId\);/);
  // Input upload progress bar: the request body streams in chunks with byte
  // telemetry, and the running (or warming first) row's Status cell renders
  // the bar from it.
  assert.match(benchSource, /liveState\.uploadLoadedBytes = offset;/);
  assert.match(benchSource, /requestInit\.duplex = "half";/);
  assert.match(benchSource, /liveState\.headersAtMs = headersAt;/);
  assert.match(engineSource, /liveRun\.uploadTotalBytes/);
  assert.match(engineSource, /Input \$\{percent\}%/);
  assert.match(engineSource, /context-upload/);
  // Test time: each measurement is stamped, the cell ticks while running,
  // the clock re-renders, and the export converts to seconds.
  assert.match(engineSource, /measurement\.testTimeStartMs = measurementStartedAtMs;/);
  assert.match(engineSource, /measurement\.testTimeEndMs = performance\.now\(\);/);
  assert.match(engineSource, /\/\^Running\/\.test\(status\.text\)/);
  assert.match(engineSource, /live test time/);
  assert.match(engineSource, /case "testTimeMs":\s*\n\s*return summary\.testTimeMs == null \? null : \+\(summary\.testTimeMs \/ 1000\)\.toFixed\(3\);/);
  assert.match(benchSource, /testTimeMs,\s*\n\s*testTimeStartedAtMs,/);
  // The default column set changed (Status moved into the default view), so
  // stored v1 column preferences are retired in favor of the new defaults.
  assert.match(needleSource, /columnPreferenceKey: "llm-quick-bench:needle-columns:v2"/);
  assert.match(prefillSource, /columnPreferenceKey: "llm-quick-bench:prefill-columns:v2"/);
  // The needle position cell shows the percent and the approximate token
  // depth inside the document; unsizable models keep the bare percent.
  assert.match(engineSource, /contextNeedleTokenDepth\(view\.inputTokens, view\.positionPercent\)/);
  assert.match(engineSource, /~\$\{formatContextSize\(needleDepth\)\} tokens in/);
  assert.match(engineSource, /\? `\$\{view\.positionPercent\}%`/);
  // Effective input rate is computed from the aggregates: p50 tokens / p50 TTFT.
  assert.match(benchSource, /inputTpsP50: calculateEffectiveInputTokensPerSecond\(promptTokensP50, ttftP50\)/);
  assert.match(benchSource, /ttftP90: percentile\(values\("ttftMs"\), 0\.9\)/);
  // The engine never re-enables disabled fields (the filter runs in each test file).
  assert.match(needleSource, /filter\(\(control\) => !control\.disabled && !control\.readOnly\)/);
  assert.match(prefillSource, /filter\(\(control\) => !control\.disabled && !control\.readOnly\)/);
});

test("the two long-context tests are cross-locked with each other and the other benchmarks", () => {
  // The engine guards its submit against the other long-context test and the
  // other three benchmarks.
  assert.match(engineSource, /contextBenchmarks\.some\(\(benchmark\) => benchmark\.key !== key && benchmark\.isRunning\(\)\)/);
  assert.match(engineSource, /if \(typeof speedAbortController !== "undefined" && speedAbortController != null\)/);
  assert.match(engineSource, /if \(typeof thinkingAbortController !== "undefined" && thinkingAbortController != null\)/);
  assert.match(engineSource, /if \(typeof decodeAbortController !== "undefined" && decodeAbortController != null\)/);
  // The registry locks both run buttons and resets both results.
  assert.match(engineSource, /function updateContextRunButtons\(/);
  assert.match(engineSource, /function resetContextResults\(\)/);
  assert.match(engineSource, /function isAnyContextBenchmarkRunning\(\)/);

  // speed-test1.js guards a typeof-safe running check and resets both tests.
  const speedSource = fs.readFileSync(path.join(projectRoot, "js", "speed-test1.js"), "utf8");
  assert.match(speedSource, /typeof isAnyContextBenchmarkRunning !== "function"/);
  assert.match(speedSource, /if \(typeof resetContextResults === "function"\) resetContextResults\(\);/);
  assert.match(speedSource, /if \(typeof updateContextRunButtons === "function"\) updateContextRunButtons\(isRunning\);/);

  // thinking-test1.js and decode-test1.js lock against both tests too.
  const thinkingSource = fs.readFileSync(path.join(projectRoot, "js", "thinking-test1.js"), "utf8");
  const decodeSource = fs.readFileSync(path.join(projectRoot, "js", "decode-test1.js"), "utf8");
  [thinkingSource, decodeSource].forEach((source) => {
    assert.match(source, /typeof isAnyContextBenchmarkRunning === "function" && isAnyContextBenchmarkRunning\(\)/);
    assert.match(source, /if \(typeof updateContextRunButtons === "function"\) updateContextRunButtons\(isRunning\);/);
  });
});

test("the sample-capture reservation is released on both paths", () => {
  // Released when the request throws...
  assert.match(engineSource, /catch \(error\) \{[\s\S]{0,200}sampleCapturePending = false/);
  // ...and after the sample is stored or captured.
  const releases = engineSource.match(/if \(captureExchange\) sampleCapturePending = false;/g) ?? [];
  assert.ok(releases.length >= 2, "capture slot must be released on both paths");
});
