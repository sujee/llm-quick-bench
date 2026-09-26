// Enforces the site-wide pre-run preview: before any benchmark starts, its
// results table lists the selected models as Queued rows. Behavioral tests
// drive the real Speed/Thinking render functions against a minimal DOM;
// a structural test locks the same default in for every benchmark file.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.join(__dirname, "..");

const THINKING_COLUMNS = [
  "modelId",
  "status",
  "accuracy",
  "formatCompliance",
  "ttftMedian",
  "ttftP95",
  "e2eMedian",
  "e2eP95",
  "reasoningTokensMedian",
  "answerTokensMedian",
  "costPerCorrect",
  "totalTokens",
  "cost",
  "totalTestTimeMs",
];

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
    title: "",
    disabled: false,
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
    replaceChildren(...nodes) { this.children = [...nodes]; },
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return fakeElement(); },
    querySelectorAll() { return []; },
  };
  return element;
}

// Minimal DOM shaped like index.html: every #id resolves to a stub, and the
// Thinking Test's static [data-thinking-column] header cells exist so its
// table renders cells at all.
function loadPreviewUI() {
  const elements = new Map();
  const thinkingHeaders = THINKING_COLUMNS.map((key) => {
    const header = fakeElement("th");
    header.dataset.thinkingColumn = key;
    return header;
  });
  const document = {
    createElement: (tag) => fakeElement(tag),
    createElementNS: (namespace, tag) => fakeElement(tag),
    querySelector(selector) {
      const id = selector.match(/^#([\w-]+)$/)?.[1];
      if (!id) return null;
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id);
    },
    querySelectorAll(selector) {
      if (selector === "[data-thinking-column]") return thinkingHeaders;
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    body: fakeElement("body"),
  };

  const context = vm.createContext({
    AbortController,
    Blob,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init?.detail; }
    },
    DOMException,
    Headers,
    ReadableStream,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    clearTimeout,
    setTimeout,
    performance,
    console: { error() {}, log() {}, warn() {}, info() {} },
    crypto: {
      getRandomValues: (array) => { array[0] = 1; return array; },
      randomUUID: () => "00000000-0000-4000-8000-000000000000",
    },
    document,
    localStorage: { getItem: () => null, setItem() {} },
    fetch: () => Promise.reject(new Error("Unexpected fetch")),
  });

  // Load order mirrors index.html for the two behaviorally tested
  // benchmarks; both own their results tables end to end.
  ["js/bench-utils.js", "js/presets.js", "js/model-loader.js", "js/speed-test1.js", "js/thinking-test1.js"].forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(projectRoot, file), "utf8"), context, { filename: file });
  });

  vm.runInContext(`this.__ui = {
    MODELS,
    renderSpeedResults,
    speedBody,
    renderThinkingResults,
    thinkingBody,
  };`, context);
  return context.__ui;
}

function selectModel(ui) {
  ui.MODELS.push({
    modelId: "openai/gpt-preview-test",
    selected: true,
    inputPrice: 1,
    outputPrice: 2,
    cachedInputPrice: 0.1,
  });
}

test("Speed Test previews selected models as Queued rows before a run", () => {
  const ui = loadPreviewUI();
  selectModel(ui);
  ui.renderSpeedResults();

  // renderSpeedTable appends one table per render into #speed-body.
  const table = ui.speedBody.children.at(-1);
  assert.ok(table, "a results table renders before any run");
  const [thead, tbody] = table.children;
  assert.ok(thead && tbody, "the table has head and body sections");
  assert.equal(tbody.children.length, 1, "one row per selected model");

  const row = tbody.children[0];
  assert.equal(row.dataset.modelId, "openai/gpt-preview-test");
  const statusCell = row.children[1];
  const pill = statusCell.children[0];
  assert.equal(pill.textContent, "Queued", "the pre-run status is Queued");
  // Every metric cell is a placeholder dash, never a fake measurement.
  const metricCells = row.children.slice(2, -1);
  assert.ok(
    metricCells.every((cell) => cell.textContent === "-"),
    `metric cells render "-" before the run (got ${metricCells.map((cell) => cell.textContent).join(",")})`,
  );

  // Deselecting the model drops the preview row on the next render.
  ui.MODELS[0].selected = false;
  ui.renderSpeedResults();
  const nextTable = ui.speedBody.children.at(-1);
  assert.equal(nextTable.children[1].children.length, 0, "no preview rows once deselected");
});

test("Thinking Test previews selected models as Queued rows before a run", () => {
  const ui = loadPreviewUI();
  selectModel(ui);
  ui.renderThinkingResults();

  // The Thinking Test appends <tr> rows directly into its static tbody.
  assert.equal(ui.thinkingBody.children.length, 1, "one row per selected model");
  const row = ui.thinkingBody.children[0];
  assert.equal(row.dataset.modelId, "openai/gpt-preview-test");

  const cellsByKey = new Map(row.children.map((cell) => [cell.dataset.thinkingColumn, cell]));
  const statusPill = cellsByKey.get("status").children[0];
  assert.equal(statusPill.textContent, "Queued", "the pre-run status is Queued");
  // Optional integer columns show "-", not a fake zero, before any run.
  assert.equal(cellsByKey.get("reasoningTokensMedian").textContent, "-");
  assert.equal(cellsByKey.get("answerTokensMedian").textContent, "-");
  assert.equal(cellsByKey.get("accuracy").textContent, "-");
  assert.equal(cellsByKey.get("cost").textContent, "-");

  ui.MODELS[0].selected = false;
  ui.renderThinkingResults();
  assert.equal(ui.thinkingBody.children.length, 0, "no preview rows once deselected");
});

test("every benchmark previews selected models before a run (site-wide default)", () => {
  const sources = {
    "js/speed-test1.js": /previewBenchmarkResults\(\)/,
    "js/thinking-test1.js": /previewBenchmarkResults\(\)/,
    // Decode, the long-context engine, and the Cache Test build their
    // previews inline from the selected models.
    "js/decode-test1.js": /MODELS\.filter\(\(model\) => model\.selected\)/,
    "js/context-bench.js": /MODELS\.filter\(\(model\) => model\.selected\)/,
    "js/cache-test1.js": /MODELS\.filter\(\(model\) => model\.selected\)/,
  };
  for (const [file, pattern] of Object.entries(sources)) {
    const source = fs.readFileSync(path.join(projectRoot, file), "utf8");
    assert.match(
      source,
      pattern,
      `${file} must render a pre-run preview of the selected models`,
    );
  }
  // The shared helper is the default for benchmarks without a bespoke
  // row shape.
  const benchSource = fs.readFileSync(path.join(projectRoot, "js", "bench-utils.js"), "utf8");
  assert.match(benchSource, /function previewBenchmarkResults/);
});
