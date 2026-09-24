const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.join(__dirname, "..");

// Minimal DOM stand-in. Elements are created on demand and every
// document.querySelector(selector) returns the same element for a selector, so
// the test can read the real buttons the script captured at load time.
function fakeElement(tag = "div") {
  const element = {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    className: "",
    id: "",
    value: "",
    type: "text",
    checked: false,
    disabled: false,
    hidden: false,
    tabIndex: 0,
    scope: "",
    title: "",
    textContent: "",
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
    prepend(...nodes) { this.children.unshift(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    remove() {},
    insertBefore() {},
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    querySelector() { return fakeElement(); },
    querySelectorAll() { return []; },
    get firstElementChild() {
      return this.children.find((child) => child && child.tagName) ?? fakeElement();
    },
  };
  return element;
}

function loadModelSelectionUI() {
  const elements = new Map();
  const document = {
    createElement: (tag) => fakeElement(tag),
    createElementNS: (namespace, tag) => fakeElement(tag),
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, fakeElement());
      return elements.get(selector);
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
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
    console: { error() {}, log() {}, warn() {} },
    crypto: { getRandomValues: (array) => { array[0] = 1; return array; } },
    document,
    localStorage: { getItem: () => null, setItem() {} },
    fetch: () => Promise.reject(new Error("Unexpected fetch")),
  });

  // Load order mirrors index.html: bench-utils -> presets -> model-loader ->
  // speed-test1 (which owns the model-selection button state).
  ["js/bench-utils.js", "js/presets.js", "js/model-loader.js", "js/speed-test1.js"].forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(projectRoot, file), "utf8"), context, { filename: file });
  });

  vm.runInContext(`this.__ui = {
    MODELS,
    setModels,
    setLoading,
    updateModelResultsState,
    updateModelSelectionButtons,
    selectNewestModelsButton,
    selectIntelligentModelsButton,
    selectAllModelsButton,
    invertModelSelectionButton,
    selectNoModelsButton,
  };`, context);
  return context.__ui;
}

test("with no models loaded every selection shortcut is disabled", () => {
  const ui = loadModelSelectionUI();
  ui.setModels([]);
  ui.updateModelSelectionButtons();

  assert.equal(ui.selectNewestModelsButton.disabled, true);
  assert.equal(ui.selectIntelligentModelsButton.disabled, true);
  assert.equal(ui.selectAllModelsButton.disabled, true);
  assert.equal(ui.invertModelSelectionButton.disabled, true);
  assert.equal(ui.selectNoModelsButton.disabled, true);
});

test("Select 5 newest is disabled when no model has a release date", () => {
  const ui = loadModelSelectionUI();
  ui.setModels([
    { modelId: "a", releaseDate: null, aaIndex: 5 },
    { modelId: "b", releaseDate: undefined, aaIndex: 6 },
  ]);
  ui.updateModelSelectionButtons();

  assert.equal(ui.selectNewestModelsButton.disabled, true);
  assert.equal(ui.selectIntelligentModelsButton.disabled, false);
});

test("Select top 5 intelligent is disabled when no model has an AA index", () => {
  const ui = loadModelSelectionUI();
  ui.setModels([
    { modelId: "a", releaseDate: "2026-01-01", aaIndex: null },
    { modelId: "b", releaseDate: "2026-02-01", aaIndex: "" },
  ]);
  ui.updateModelSelectionButtons();

  assert.equal(ui.selectNewestModelsButton.disabled, false);
  assert.equal(ui.selectIntelligentModelsButton.disabled, true);
});

test("each shortcut enables once its own field is present on any model", () => {
  const ui = loadModelSelectionUI();
  ui.setModels([
    { modelId: "a", releaseDate: "2026-01-01", aaIndex: null },
    { modelId: "b", releaseDate: null, aaIndex: 42 },
  ]);
  ui.updateModelSelectionButtons();

  assert.equal(ui.selectNewestModelsButton.disabled, false);
  assert.equal(ui.selectIntelligentModelsButton.disabled, false);
  assert.equal(ui.selectAllModelsButton.disabled, false);
});

test("a missing-field value of 0 still counts as available", () => {
  const ui = loadModelSelectionUI();
  ui.setModels([{ modelId: "a", releaseDate: "2026-01-01", aaIndex: 0 }]);
  ui.updateModelSelectionButtons();

  assert.equal(ui.selectIntelligentModelsButton.disabled, false);
});

test("updateModelResultsState applies the same availability rules", () => {
  const ui = loadModelSelectionUI();
  ui.setModels([{ modelId: "a", releaseDate: "2026-01-01", aaIndex: null }]);
  ui.updateModelResultsState();

  assert.equal(ui.selectNewestModelsButton.disabled, false);
  assert.equal(ui.selectIntelligentModelsButton.disabled, true);
});

test("loading disables every shortcut regardless of loaded data", () => {
  const ui = loadModelSelectionUI();
  ui.setModels([{ modelId: "a", releaseDate: "2026-01-01", aaIndex: 5 }]);

  ui.setLoading(true);
  assert.equal(ui.selectNewestModelsButton.disabled, true);
  assert.equal(ui.selectIntelligentModelsButton.disabled, true);

  ui.setLoading(false);
  assert.equal(ui.selectNewestModelsButton.disabled, false);
  assert.equal(ui.selectIntelligentModelsButton.disabled, false);
});

test("model-loader.hasAnyModelField is the shared availability predicate", () => {
  // Guard the pure helper the buttons rely on: blank/null/undefined are missing,
  // numbers (including 0) and non-empty strings count as present.
  const source = fs.readFileSync(path.join(projectRoot, "js", "model-loader.js"), "utf8");
  assert.match(source, /function hasAnyModelField\(models, key\)/);
  assert.match(source, /models\.some\(\(model\) => !isMissing\(model\?\.\[key\]\)\)/);
});
