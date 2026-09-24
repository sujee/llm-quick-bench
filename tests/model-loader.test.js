const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.join(__dirname, "..");

// Minimal stand-in for the DOM element bench-utils.js expects at load time.
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

function fakeResponse({ ok = true, status = 200, statusText = "", body = "" } = {}) {
  return {
    ok,
    status,
    statusText,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  };
}

// Copies a value from the vm realm into this realm so deepStrictEqual can
// compare plain objects and arrays without cross-realm prototype mismatches.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// Model-loader.js is a classic script: it uses bench-utils.js globals
// (buildApiUrl/buildApiHeaders) and the browser `fetch`. Loading the real
// bench-utils.js beside it exercises the actual URL/header helpers.
function loadModelLoader({ fetch: fetchImpl = () => Promise.reject(new Error("Unexpected fetch")) } = {}) {
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
    console: { error: () => {}, log: () => {}, warn: () => {} },
    performance,
    setTimeout,
    document: { createElement: (tag) => fakeElement(tag) },
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: fetchImpl,
  });
  vm.runInContext(fs.readFileSync(path.join(projectRoot, "js", "bench-utils.js"), "utf8"), context);
  const source = fs.readFileSync(path.join(projectRoot, "js", "model-loader.js"), "utf8");
  vm.runInContext(`${source}
this.__modelLoader = {
  MODELS,
  MODELS_GENERIC_FILE,
  MODELS_PROVIDER_FILES,
  buildModelsUrl,
  buildModelReference,
  collectModalities,
  declaredModalities,
  enrichModels,
  fetchProviderModels,
  findModelReference,
  getModelModalities,
  getParameterCount,
  getPricePerMillion,
  isEmbeddingModel,
  isNonChatModel,
  isTextInTextOutModel,
  loadCatalogFile,
  loadModelReference,
  modalitiesFromId,
  modalitiesFromTypeToken,
  normalizeModelId,
  normalizeReleaseDate,
  parseParameterCount,
  pricePerMillion,
  providerCatalogFile,
  readResponse,
  setModels,
  stripModelDateSuffix,
  toNumber,
  toTableRow,
};`, context);
  return context.__modelLoader;
}

// A trimmed copy of the shipped catalog covering the lookup cases: exact ids,
// base names, aa_slugs, HF repository ids, a genuinely colliding alias, an
// embedding entry, and null AA fields.
const CATALOG = [
  {
    name: "GLM-5.3",
    type: "text2text",
    vendor: "zai-org",
    aa_slug: "glm-5-3",
    aa_intelligence_index: 45,
    model_id: "zai-org/GLM-5.3",
    model_release_date: "2026-08-18",
    context_window_K: 1024,
    huggingface_url: "https://huggingface.co/zai-org/GLM-5.3",
    param_count_B: 753,
  },
  {
    name: "DeepSeek-V4-Pro-0813",
    type: "text2text",
    vendor: "deepseek",
    aa_slug: "deepseek-v4-pro",
    aa_intelligence_index: 36,
    model_id: "deepseek-ai/DeepSeek-V4-Pro-0813",
    model_release_date: "2026-08-13",
    context_window_K: 1024,
    huggingface_url: "https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813",
    param_count_B: 1600,
  },
  {
    name: "DeepSeek-V4-Pro",
    type: "text2text",
    vendor: "deepseek",
    aa_slug: "deepseek-v4-pro-0424",
    aa_intelligence_index: 31,
    model_id: "deepseek-ai/DeepSeek-V4-Pro",
    model_release_date: "2026-04-24",
    context_window_K: 1024,
    huggingface_url: "https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro",
    param_count_B: 1600,
  },
  {
    name: "Nemotron-3.5-Lightning",
    type: "text2text",
    vendor: "nvidia",
    aa_slug: "nemotron-3-5-lightning",
    aa_intelligence_index: 14,
    model_id: "nvidia/Nemotron-3_5-Lightning",
    model_release_date: "2026-08-11",
    context_window_K: 1024,
    huggingface_url: "https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16",
    param_count_B: 31.6,
  },
  {
    name: "Qwen3-Embedding-8B",
    type: "embedding",
    vendor: "Qwen",
    aa_slug: null,
    aa_intelligence_index: null,
    model_id: "Qwen/Qwen3-Embedding-8B",
    model_release_date: "2025-06-05",
    context_window_K: 40,
    huggingface_url: "https://huggingface.co/Qwen/Qwen3-Embedding-8B",
    param_count_B: 8,
  },
];

test("model-loader.js owns the model pipeline and loads before speed-test1.js", () => {
  const html = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
  const scriptOrder = ["js/bench-utils.js", "js/presets.js", "js/model-loader.js", "js/speed-test1.js"]
    .map((name) => ({ name, index: html.indexOf(`<script src="${name}"`) }));
  scriptOrder.forEach(({ name, index }) => assert.ok(index !== -1, `Missing script ${name}`));
  for (let i = 1; i < scriptOrder.length; i += 1) {
    assert.ok(
      scriptOrder[i].index > scriptOrder[i - 1].index,
      `${scriptOrder[i].name} must load after ${scriptOrder[i - 1].name}`,
    );
  }

  const loaderSource = fs.readFileSync(path.join(projectRoot, "js", "model-loader.js"), "utf8");
  const pipelineFunctions = [
    "buildModelsUrl", "readResponse", "fetchProviderModels", "toTableRow", "enrichModels",
    "loadModelReference", "buildModelReference", "findModelReference", "normalizeModelId",
    "isEmbeddingModel", "isNonChatModel", "normalizeReleaseDate", "getParameterCount", "parseParameterCount",
    "toNumber", "getPricePerMillion", "pricePerMillion", "stripModelDateSuffix",
    "getModelModalities", "isTextInTextOutModel", "modalitiesFromTypeToken", "modalitiesFromId",
    "collectModalities", "declaredModalities",
  ];
  pipelineFunctions.forEach((name) => {
    assert.match(loaderSource, new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  });

  // speed-test1.js keeps the UI orchestration but none of the pipeline itself.
  const speedSource = fs.readFileSync(path.join(projectRoot, "js", "speed-test1.js"), "utf8");
  pipelineFunctions.forEach((name) => {
    assert.doesNotMatch(speedSource, new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  });
  assert.match(speedSource, /await fetchProviderModels\(/);
  assert.match(speedSource, /enrichModels\(returnedModels, modelReference\)/);

  // The catalog filename literal is defined once in the pipeline.
  assert.equal((loaderSource.match(/"data\/models-generic\.json"/g) ?? []).length, 1);
  assert.match(speedSource, /\$\{MODELS_GENERIC_FILE\}/);
});

test("model-loader owns the shared MODELS array and setModels replaces it in place", () => {
  const loader = loadModelLoader();
  const reference = loader.MODELS;

  assert.ok(Array.isArray(reference));
  assert.equal(reference.length, 0);
  assert.equal(loader.MODELS, reference);

  loader.setModels([{ modelId: "a" }, { modelId: "b" }]);
  assert.equal(loader.MODELS, reference); // same array, mutated not replaced
  assert.deepEqual([...reference].map((model) => model.modelId), ["a", "b"]);

  loader.setModels([{ modelId: "c" }]);
  assert.deepEqual([...reference].map((model) => model.modelId), ["c"]);

  loader.setModels(null);
  assert.equal(reference.length, 0);
});

test("benchmark scripts read MODELS instead of a speed-test1-owned models global", () => {
  const consumerFiles = [
    "js/speed-test1.js",
    "js/thinking-test1.js",
    "js/decode-test1.js",
    "js/context-bench.js",
    "js/needle-test1.js",
  ];
  consumerFiles.forEach((file) => {
    const source = fs.readFileSync(path.join(projectRoot, file), "utf8");
    assert.doesNotMatch(
      source,
      /(^|[^.\w])models\.(filter|find|forEach|some|length|map)\b/,
      `${file} should read MODELS, not the old models global`,
    );
    assert.match(source, /MODELS/, `${file} should reference MODELS`);
  });

  const speedSource = fs.readFileSync(path.join(projectRoot, "js", "speed-test1.js"), "utf8");
  assert.doesNotMatch(speedSource, /^let models = \[\]/m);
  assert.match(speedSource, /setModels\(loadedModels\)/);
});

test("buildModelsUrl appends /models and adds verbose only for nebius", () => {
  const loader = loadModelLoader();

  assert.equal(
    loader.buildModelsUrl("https://api.example.com/v1", "openai"),
    "https://api.example.com/v1/models",
  );
  assert.equal(
    loader.buildModelsUrl("https://api.tokenfactory.nebius.com/v1", "nebius"),
    "https://api.tokenfactory.nebius.com/v1/models?verbose=true",
  );
  // A base URL that already names /models is not doubled up.
  assert.equal(
    loader.buildModelsUrl("https://api.example.com/v1/models", "custom"),
    "https://api.example.com/v1/models",
  );
  assert.equal(loader.MODELS_GENERIC_FILE, "data/models-generic.json");
});

test("readResponse parses JSON and reports empty or non-JSON bodies", async () => {
  const loader = loadModelLoader();

  assert.deepEqual(Object.keys(await loader.readResponse(fakeResponse({ body: "" }))), []);
  const payload = await loader.readResponse(fakeResponse({ body: '{"data":[]}' }));
  assert.equal(payload.data.length, 0);

  await assert.rejects(
    loader.readResponse(fakeResponse({ body: "not json" })),
    /The endpoint returned a non-JSON response\./,
  );
  await assert.rejects(
    loader.readResponse(fakeResponse({ ok: false, status: 500, body: "upstream boom" })),
    /^Error: 500 upstream boom$/,
  );
});

test("fetchProviderModels fetches /models with the API key and returns the array", async () => {
  const calls = [];
  const loader = loadModelLoader({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return fakeResponse({ body: JSON.stringify([{ id: "zai-org/GLM-5.3" }]) });
    },
  });

  const models = await loader.fetchProviderModels("https://api.example.com/v1", "openai", "secret-key");

  assert.equal(models.length, 1);
  assert.equal(models[0].id, "zai-org/GLM-5.3");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.com/v1/models");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Accept, "application/json");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-key");
});

test("fetchProviderModels accepts an OpenAI-style { data: [] } payload", async () => {
  const loader = loadModelLoader({
    fetch: async () => fakeResponse({ body: JSON.stringify({ object: "list", data: [{ id: "m" }] }) }),
  });

  const models = await loader.fetchProviderModels("https://api.example.com/v1", "custom", "k");
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "m");
});

test("fetchProviderModels surfaces provider errors and rejects malformed payloads", async () => {
  const loader = loadModelLoader({
    fetch: async (url) => fakeResponse({
      ok: false,
      status: 404,
      body: JSON.stringify({ error: { message: "Provider not found" } }),
    }),
  });
  await assert.rejects(
    loader.fetchProviderModels("https://api.example.com/v1", "openai", "k"),
    /404 Provider not found/,
  );

  const messageLoader = loadModelLoader({
    fetch: async () => fakeResponse({ ok: false, status: 500, body: JSON.stringify({ message: "upstream down" }) }),
  });
  await assert.rejects(
    messageLoader.fetchProviderModels("https://api.example.com/v1", "openai", "k"),
    /500 upstream down/,
  );

  const statusTextLoader = loadModelLoader({
    fetch: async () => fakeResponse({ ok: false, status: 503, statusText: "Service Unavailable", body: "" }),
  });
  await assert.rejects(
    statusTextLoader.fetchProviderModels("https://api.example.com/v1", "openai", "k"),
    /503 Service Unavailable/,
  );

  const malformedLoader = loadModelLoader({
    fetch: async () => fakeResponse({ body: JSON.stringify({ object: "list" }) }),
  });
  await assert.rejects(
    malformedLoader.fetchProviderModels("https://api.example.com/v1", "openai", "k"),
    /did not return a model array or an OpenAI-style \{ data: \[\] \} response/,
  );

  // A network/CORS failure propagates so the caller can add its CORS hint.
  const networkLoader = loadModelLoader({
    fetch: async () => { throw new TypeError("Failed to fetch"); },
  });
  await assert.rejects(
    networkLoader.fetchProviderModels("https://api.example.com/v1", "openai", "k"),
    TypeError,
  );
});

test("loadModelReference fetches the catalog constant and builds the lookup index", async () => {
  const calls = [];
  const loader = loadModelLoader({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return fakeResponse({ body: JSON.stringify(CATALOG) });
    },
  });

  const index = await loader.loadModelReference();

  assert.equal(calls[0].url, "data/models-generic.json");
  assert.equal(calls[0].options.headers.Accept, "application/json");
  assert.equal(typeof index.exact.has, "function");
  assert.equal(typeof index.aliases.has, "function");
  assert.ok(index.exact.has("zai-org-glm-5-3"));
  assert.ok(index.aliases.has("glm-5-3"));
});

test("loadModelReference reports unreadable, non-array, and invalid catalogs", async () => {
  const offlineLoader = loadModelLoader({
    fetch: async () => { throw new TypeError("Failed to fetch"); },
  });
  await assert.rejects(
    offlineLoader.loadModelReference(),
    /Unable to load data\/models-generic\.json\. Serve the app over HTTP instead of opening index\.html directly\./,
  );

  const notFoundLoader = loadModelLoader({
    fetch: async () => fakeResponse({ ok: false, status: 404 }),
  });
  await assert.rejects(
    notFoundLoader.loadModelReference(),
    /Unable to load data\/models-generic\.json \(404\)\./,
  );

  const invalidJsonLoader = loadModelLoader({
    fetch: async () => fakeResponse({ body: "not json" }),
  });
  await assert.rejects(
    invalidJsonLoader.loadModelReference(),
    /data\/models-generic\.json contains invalid JSON\./,
  );

  const notArrayLoader = loadModelLoader({
    fetch: async () => fakeResponse({ body: '{"models":[]}' }),
  });
  await assert.rejects(
    notArrayLoader.loadModelReference(),
    /data\/models-generic\.json must contain an array of models\./,
  );
});

// A provider catalog entry carrying the OpenAI-style pricing fields the
// provider file adds on top of the shared catalog.
const PROVIDER_CATALOG = [
  {
    name: "GPT-6 Astra",
    type: "image2text",
    vendor: "openai",
    aa_slug: "gpt-6-astra",
    aa_intelligence_index: 53,
    model_id: "openai/gpt-6-astra",
    model_release_date: "2026-09-04",
    context_window_K: 1025.390625,
    input_price_per_million_tokens: 10,
    cached_input_price_per_million_tokens: 1,
    cache_write_price_per_million_tokens: 12.5,
    output_price_per_million_tokens: 50,
  },
];

test("providerCatalogFile maps known providers and returns null otherwise", () => {
  const loader = loadModelLoader();

  assert.equal(loader.providerCatalogFile("openai"), "data/models-openai.json");
  assert.equal(loader.providerCatalogFile("nebius"), null);
  assert.equal(loader.providerCatalogFile(null), null);
});

test("loadModelReference merges the shared and provider catalogs", async () => {
  const calls = [];
  const loader = loadModelLoader({
    fetch: async (url) => {
      calls.push(url);
      return fakeResponse({
        body: JSON.stringify(url === "data/models-openai.json" ? PROVIDER_CATALOG : []),
      });
    },
  });

  const index = await loader.loadModelReference("openai");

  assert.deepEqual([...calls].sort(), ["data/models-generic.json", "data/models-openai.json"]);
  const astra = loader.findModelReference("openai/gpt-6-astra", index);
  assert.equal(astra.name, "GPT-6 Astra");
  assert.equal(astra.aaIndex, 53);
  assert.equal(astra.inputPrice, 10);
  assert.equal(astra.outputPrice, 50);
  assert.equal(astra.cachedInputPrice, 1);
  assert.equal(astra.cacheWritePrice, 12.5);
});

test("loadModelReference skips the provider file for providers without one", async () => {
  const calls = [];
  const loader = loadModelLoader({
    fetch: async (url) => { calls.push(url); return fakeResponse({ body: "[]" }); },
  });

  await loader.loadModelReference("nebius");
  assert.deepEqual(calls, ["data/models-generic.json"]);
});

test("toTableRow falls back to catalog prices when the provider omits them", () => {
  const loader = loadModelLoader();
  const index = loader.buildModelReference(PROVIDER_CATALOG);

  const row = loader.toTableRow({ id: "openai/gpt-6-astra" }, index);
  assert.equal(row.inputPrice, 10);
  assert.equal(row.outputPrice, 50);
  assert.equal(row.cachedInputPrice, 1);
  assert.equal(row.cacheWritePrice, 12.5);
  assert.equal(row.blendedPrice, ((3 * 10) + 50) / 4);

  // The provider's explicit prices still win over the catalog.
  const providerPriced = loader.toTableRow({
    id: "openai/gpt-6-astra",
    input_price_per_million_tokens: 1,
    output_price_per_million_tokens: 2,
  }, index);
  assert.equal(providerPriced.inputPrice, 1);
  assert.equal(providerPriced.outputPrice, 2);
});

test("toTableRow price resolution supersedes the catalog field by field", () => {
  const loader = loadModelLoader();
  const index = loader.buildModelReference(PROVIDER_CATALOG);

  // 1. Explicit provider per-million fields win over every catalog field, and
  //    the blended price is recomputed from the provider's values.
  const explicit = loader.toTableRow({
    id: "openai/gpt-6-astra",
    input_price_per_million_tokens: 1,
    output_price_per_million_tokens: 2,
    cached_input_price_per_million_tokens: 0.1,
    cache_write_price_per_million_tokens: 0.2,
  }, index);
  assert.equal(explicit.inputPrice, 1);
  assert.equal(explicit.outputPrice, 2);
  assert.equal(explicit.cachedInputPrice, 0.1);
  assert.equal(explicit.cacheWritePrice, 0.2);
  assert.equal(explicit.blendedPrice, ((3 * 1) + 2) / 4);

  // 2. A provider value of 0 means "free" and still supersedes the catalog.
  const free = loader.toTableRow({
    id: "openai/gpt-6-astra",
    input_price_per_million_tokens: 0,
    output_price_per_million_tokens: 0,
  }, index);
  assert.equal(free.inputPrice, 0);
  assert.equal(free.outputPrice, 0);
  assert.equal(free.blendedPrice, 0);
  // Catalog-only fields remain available for the fields the provider omitted.
  assert.equal(free.cachedInputPrice, 1);
  assert.equal(free.cacheWritePrice, 12.5);

  // 3. Omission falls back per field, so one model can mix the two sources and
  //    the blended price reflects the final (mixed) input/output.
  const mixed = loader.toTableRow({
    id: "openai/gpt-6-astra",
    output_price_per_million_tokens: 40, // input/cached/cache-write omitted
  }, index);
  assert.equal(mixed.inputPrice, 10);
  assert.equal(mixed.outputPrice, 40);
  assert.equal(mixed.cachedInputPrice, 1);
  assert.equal(mixed.cacheWritePrice, 12.5);
  assert.equal(mixed.blendedPrice, ((3 * 10) + 40) / 4);

  // 4. A blank explicit field is "missing", not zero: it falls back to the
  //    catalog rather than overriding it.
  const blank = loader.toTableRow({
    id: "openai/gpt-6-astra",
    input_price_per_million_tokens: "",
  }, index);
  assert.equal(blank.inputPrice, 10);
  assert.equal(blank.outputPrice, 50);

  // 5. Nested provider pricing also supersedes the catalog; tiny per-token
  //    values are scaled to per-million and used for the blended price.
  const nested = loader.toTableRow({
    id: "openai/gpt-6-astra",
    pricing: { prompt: 0.000002, completion: 0.000006 },
  }, index);
  assert.equal(nested.inputPrice, 2);
  assert.equal(nested.outputPrice, 6);
  assert.equal(nested.blendedPrice, ((3 * 2) + 6) / 4);

  // 6. An explicit per-million field wins over a nested ambiguous value.
  const explicitOverNested = loader.toTableRow({
    id: "openai/gpt-6-astra",
    input_price_per_million_tokens: 5,
    pricing: { prompt: 999 },
  }, index);
  assert.equal(explicitOverNested.inputPrice, 5);
});

test("normalizeModelId lowercases, collapses separators, and trims dashes", () => {
  const loader = loadModelLoader();

  assert.equal(loader.normalizeModelId("Qwen/Qwen3-Next-80B"), "qwen-qwen3-next-80b");
  assert.equal(loader.normalizeModelId("Nemotron-3_5-Lightning"), "nemotron-3-5-lightning");
  assert.equal(loader.normalizeModelId("--Weird--Name--"), "weird-name");
});

test("buildModelReference and findModelReference resolve ids, base names, and aliases", () => {
  const loader = loadModelLoader();
  const index = loader.buildModelReference(CATALOG);

  // Exact full id and vendor-less base name.
  assert.equal(loader.findModelReference("zai-org/GLM-5.3", index).name, "GLM-5.3");
  assert.equal(loader.findModelReference("GLM-5.3", index).name, "GLM-5.3");

  // A catalog aa_slug that is not also an exact id resolves as an alias.
  assert.equal(loader.findModelReference("deepseek-v4-pro-0424", index).name, "DeepSeek-V4-Pro");

  // Periods and underscores normalize to the same separator.
  assert.equal(loader.findModelReference("nvidia/Nemotron-3.5-Lightning", index).name, "Nemotron-3.5-Lightning");

  // HF repository ids are aliases.
  assert.equal(
    loader.findModelReference("nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16", index).name,
    "Nemotron-3.5-Lightning",
  );

  // "-fast" variants fall back to the base model.
  assert.equal(loader.findModelReference("zai-org/GLM-5.3-fast", index).name, "GLM-5.3");

  // Missing or unknown ids resolve to null.
  assert.equal(loader.findModelReference("", index), null);
  assert.equal(loader.findModelReference(null, index), null);
  assert.equal(loader.findModelReference("not-in-the-catalog", index), null);
});

test("findModelReference strips ISO and legacy date suffixes to the base id", () => {
  const loader = loadModelLoader();
  const index = loader.buildModelReference(CATALOG);

  // An ISO date suffix resolves to the catalogued base model.
  assert.equal(loader.findModelReference("deepseek-ai/DeepSeek-V4-Pro-2099-12-31", index).name, "DeepSeek-V4-Pro");
  assert.equal(loader.findModelReference("nvidia/Nemotron-3.5-Lightning-2026-08-11", index).name, "Nemotron-3.5-Lightning");

  // OpenAI's legacy -MMDD suffix resolves too, and combines with "-fast".
  assert.equal(loader.findModelReference("zai-org/GLM-5.3-0818", index).name, "GLM-5.3");
  assert.equal(loader.findModelReference("zai-org/GLM-5.3-0818-fast", index).name, "GLM-5.3");

  // A trailing number that is not a valid date is not stripped.
  assert.equal(loader.findModelReference("zai-org/GLM-5.3-2048", index), null);
  assert.equal(loader.findModelReference("zai-org/GLM-5.3-9999", index), null);

  // The exact catalogued dated snapshot still wins over the base fallback.
  assert.equal(loader.findModelReference("deepseek-ai/DeepSeek-V4-Pro-0813", index).aaIndex, 36);
});

test("stripModelDateSuffix recognises valid dates only", () => {
  const loader = loadModelLoader();

  assert.equal(loader.stripModelDateSuffix("gpt-4-1-2025-04-14"), "gpt-4-1");
  assert.equal(loader.stripModelDateSuffix("gpt-3-5-turbo-0125"), "gpt-3-5-turbo");
  assert.equal(loader.stripModelDateSuffix("gpt-3-5-turbo-1106"), "gpt-3-5-turbo");
  assert.equal(loader.stripModelDateSuffix("gpt-4o-2024-08-06"), "gpt-4o");

  // Not dates: unchanged.
  assert.equal(loader.stripModelDateSuffix("glm-5-3"), "glm-5-3");
  assert.equal(loader.stripModelDateSuffix("model-9999"), "model-9999");
  assert.equal(loader.stripModelDateSuffix("model-2025"), "model-2025");
  assert.equal(loader.stripModelDateSuffix("model-1349"), "model-1349");
});

test("a catalog alias shared by two entries is dropped, but exact ids still resolve", () => {
  const loader = loadModelLoader();
  const index = loader.buildModelReference(CATALOG);

  // "deepseek-v4-pro" is one entry's aa_slug and another's name, so the alias
  // is ambiguous and must not map to either model.
  assert.equal(index.aliases.has("deepseek-v4-pro"), false);
  assert.equal(loader.findModelReference("deepseek-ai/DeepSeek-V4-Pro-0813", index).aaIndex, 36);
  assert.equal(loader.findModelReference("deepseek-ai/DeepSeek-V4-Pro", index).aaIndex, 31);
});

test("buildModelReference converts catalog units and keeps null AA fields null", () => {
  const loader = loadModelLoader();
  const index = loader.buildModelReference(CATALOG);

  const glm = loader.findModelReference("zai-org/GLM-5.3", index);
  assert.equal(glm.aaIndex, 45);
  assert.equal(glm.paramCount, 753_000_000_000);
  assert.equal(glm.contextWindow, 1024 * 1024);
  assert.equal(glm.releaseDate, "2026-08-18");
  assert.equal(glm.type, "text2text");

  const embedding = loader.findModelReference("Qwen/Qwen3-Embedding-8B", index);
  assert.equal(embedding.aaIndex, null);
  assert.equal(embedding.type, "embedding");

  const nemotron = loader.findModelReference("nvidia/Nemotron-3.5-Lightning", index);
  assert.equal(nemotron.paramCount, 31_600_000_000);
});

test("isEmbeddingModel flags embedding descriptors and the catalog type", () => {
  const loader = loadModelLoader();

  assert.equal(loader.isEmbeddingModel({ id: "text-embedding-3-large" }, null), true);
  assert.equal(loader.isEmbeddingModel({ id: "nomic-embed-text" }, null), true);
  assert.equal(loader.isEmbeddingModel({ pipeline_tag: "embeddings" }, null), true);
  assert.equal(loader.isEmbeddingModel({ id: "gpt-oss-120b" }, { type: "text2text" }), false);

  // The catalog entry's own type flags a model whose id does not say "embed".
  const referenceOnly = loader.buildModelReference([
    { name: "Custom Reranker", model_id: "vendor/custom-reranker", type: "embedding" },
  ]);
  const reference = loader.findModelReference("vendor/custom-reranker", referenceOnly);
  assert.equal(loader.isEmbeddingModel({ id: "vendor/custom-reranker" }, reference), true);
});

test("isNonChatModel flags audio, image, TTS, transcription, realtime, and legacy models", () => {
  const loader = loadModelLoader();

  ["tts-1", "whisper-1", "dall-e-3", "gpt-image-1", "gpt-realtime", "omni-moderation-latest",
    "gpt-audio", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "sora-2", "babbage-002",
    "davinci-002", "gpt-live-1", "vendor/some-reranker", "text-embedding-3-small"]
    .forEach((id) => {
      const row = loader.isNonChatModel({ id }, null);
      // Embeddings are reported separately, so they are not counted as non-chat.
      if (id === "text-embedding-3-small") assert.equal(row, false, `${id} should stay an embedding`);
      else assert.equal(row, true, `${id} should be non-chat`);
    });

  // Chat models are never filtered, including multimodal ones whose catalog
  // type is image2text and search-enabled chat variants.
  ["gpt-4o", "gpt-5.4", "o3-mini", "gpt-4o-mini-search-preview", "gpt-5-chat-latest", "o1-pro"]
    .forEach((id) => assert.equal(loader.isNonChatModel({ id }, null), false, `${id} should be chat`));
  assert.equal(loader.isNonChatModel({ id: "gpt-6-astra" }, { type: "image2text" }), false);

  // A catalog type alone can flag a non-chat model whose id gives no hint.
  assert.equal(loader.isNonChatModel({ id: "vendor/voice" }, { type: "audio" }), true);
  assert.equal(loader.isNonChatModel({ id: "vendor/voice" }, { type: "text2text" }), false);
  assert.equal(loader.isNonChatModel({ id: "vendor/voice" }, { type: "embedding" }), false);
});

test("modalitiesFromTypeToken parses catalog and task tokens", () => {
  const loader = loadModelLoader();

  assert.deepEqual(plain(loader.modalitiesFromTypeToken("text2text")), { input: ["text"], output: ["text"] });
  assert.deepEqual(plain(loader.modalitiesFromTypeToken("image2text")), { input: ["image", "text"], output: ["text"] });
  assert.deepEqual(plain(loader.modalitiesFromTypeToken("embedding")), { input: ["text"], output: ["embedding"] });
  assert.deepEqual(plain(loader.modalitiesFromTypeToken("embeddings")), { input: ["text"], output: ["embedding"] });
  assert.deepEqual(plain(loader.modalitiesFromTypeToken("text->image")), { input: ["text"], output: ["image"] });
  assert.deepEqual(plain(loader.modalitiesFromTypeToken("text-to-speech")), { input: ["text"], output: ["audio"] });
  assert.deepEqual(plain(loader.modalitiesFromTypeToken("speech2text")), { input: ["audio"], output: ["text"] });
  assert.deepEqual(plain(loader.modalitiesFromTypeToken("audio2audio")), { input: ["audio"], output: ["audio"] });
  assert.deepEqual(plain(loader.modalitiesFromTypeToken("automatic-speech-recognition")), { input: ["audio"], output: ["text"] });
  assert.deepEqual(plain(loader.modalitiesFromTypeToken("image-text-to-text")), { input: ["image", "text"], output: ["text"] });

  // Unknown or missing tokens return null so the next source can be tried.
  assert.equal(loader.modalitiesFromTypeToken("mystery"), null);
  assert.equal(loader.modalitiesFromTypeToken(""), null);
  assert.equal(loader.modalitiesFromTypeToken(null), null);
});

test("modalitiesFromId infers input/output modalities from the id", () => {
  const loader = loadModelLoader();

  assert.deepEqual(plain(loader.modalitiesFromId("text-embedding-3-large")), { input: ["text"], output: ["embedding"] });
  assert.deepEqual(plain(loader.modalitiesFromId("gpt-4o-transcribe")), { input: ["audio"], output: ["text"] });
  assert.deepEqual(plain(loader.modalitiesFromId("gpt-4o-mini-tts")), { input: ["text"], output: ["audio"] });
  assert.deepEqual(plain(loader.modalitiesFromId("gpt-image-1")), { input: ["text"], output: ["image"] });
  assert.deepEqual(plain(loader.modalitiesFromId("sora-2")), { input: ["text"], output: ["video"] });
  assert.deepEqual(plain(loader.modalitiesFromId("omni-moderation-latest")), { input: ["text"], output: ["moderation"] });
  assert.deepEqual(plain(loader.modalitiesFromId("gpt-realtime")), { input: ["audio", "text"], output: ["audio", "text"] });

  // No signal: the caller falls back to the text-to-text default.
  assert.equal(loader.modalitiesFromId("mystery-model"), null);
  assert.equal(loader.modalitiesFromId("gpt-4o"), null);
});

test("getModelModalities prioritises declared, then type, then id, then defaults", () => {
  const loader = loadModelLoader();

  // Provider-declared arrays win over everything else.
  assert.deepEqual(
    plain(loader.getModelModalities({ id: "vendor/thing", input_modalities: ["text"], output_modalities: ["text"] }, { type: "embedding" })),
    { input: ["text"], output: ["text"] },
  );
  // OpenRouter-style `architecture.modality` string.
  assert.deepEqual(
    plain(loader.getModelModalities({ id: "vendor/thing", architecture: { modality: "text->image" } }, null)),
    { input: ["text"], output: ["image"] },
  );
  // Nebius-style compound input modality (`text+image->text`): a vision-capable
  // chat model, so text input is preserved alongside image.
  assert.deepEqual(
    plain(loader.getModelModalities({ id: "moonshotai/Kimi-K2.6", architecture: { modality: "text+image->text" } }, null)),
    { input: ["text", "image"], output: ["text"] },
  );
  assert.equal(
    loader.isTextInTextOutModel({ id: "zai-org/GLM-5.3-Flash", architecture: { modality: "text+image->text" } }, null),
    true,
  );
  // Unicode arrow.
  assert.deepEqual(
    plain(loader.getModelModalities({ id: "vendor/thing", architecture: { modality: "text → text" } }, null)),
    { input: ["text"], output: ["text"] },
  );
  // A provider `type` wins over the catalog type.
  assert.deepEqual(
    plain(loader.getModelModalities({ id: "vendor/thing", type: "text2text" }, { type: "embedding" })),
    { input: ["text"], output: ["text"] },
  );
  // Catalog type is used when the provider omits one.
  assert.deepEqual(
    plain(loader.getModelModalities({ id: "vendor/thing" }, { type: "image2text" })),
    { input: ["image", "text"], output: ["text"] },
  );
  // Id heuristics come next.
  assert.deepEqual(
    plain(loader.getModelModalities({ id: "gpt-4o-transcribe" }, null)),
    { input: ["audio"], output: ["text"] },
  );
  // With no signal at all, assume a text chat model.
  assert.deepEqual(
    plain(loader.getModelModalities({ id: "mystery-model" }, null)),
    { input: ["text"], output: ["text"] },
  );
});

test("getModelModalities fills a missing declared side from the inference chain", () => {
  const loader = loadModelLoader();

  // Input declared, output missing: the output is inferred from the type token.
  assert.deepEqual(
    plain(loader.getModelModalities({ id: "vendor/thing", input_modalities: ["text"] }, { type: "text2text" })),
    { input: ["text"], output: ["text"] },
  );
  // Output declared, input missing: the input is inferred from the catalog type.
  assert.deepEqual(
    plain(loader.getModelModalities({ id: "vendor/thing", output_modalities: ["text"] }, { type: "image2text" })),
    { input: ["image", "text"], output: ["text"] },
  );
  // Input declared, output missing, id heuristic says embedding -> still dropped.
  assert.equal(
    loader.isTextInTextOutModel({ id: "text-embedding-3-large", input_modalities: ["text"] }, null),
    false,
  );
  // A declared image-only input is trusted, not widened to text.
  assert.equal(
    loader.isTextInTextOutModel({ id: "vendor/vision", input_modalities: ["image"], output_modalities: ["text"] }, null),
    false,
  );
});

test("enrichModels keeps a model that declares only one modality side", () => {
  const loader = loadModelLoader();
  const index = loader.buildModelReference([
    { name: "Half Declared", model_id: "vendor/half-declared", type: "text2text" },
  ]);

  const result = loader.enrichModels(
    [{ id: "vendor/half-declared", input_modalities: ["text"] }],
    index,
  );

  assert.equal(result.models.length, 1);
  assert.equal(result.skippedNonText, 0);
  assert.deepEqual(plain(result.models[0].inputModalities), ["text"]);
  assert.deepEqual(plain(result.models[0].outputModalities), ["text"]);
});

test("isTextInTextOutModel keeps text-input/text-output models only", () => {
  const loader = loadModelLoader();

  assert.equal(loader.isTextInTextOutModel({ id: "gpt-4o" }, null), true);
  assert.equal(loader.isTextInTextOutModel({ id: "gpt-6-astra" }, { type: "image2text" }), true);
  assert.equal(loader.isTextInTextOutModel({ id: "zai-org/GLM-5.3" }, { type: "text2text" }), true);
  assert.equal(loader.isTextInTextOutModel({ id: "text-embedding-3-large" }, null), false);
  assert.equal(loader.isTextInTextOutModel({ id: "gpt-4o-transcribe" }, null), false);
  assert.equal(loader.isTextInTextOutModel({ id: "gpt-4o-mini-tts" }, null), false);
  assert.equal(loader.isTextInTextOutModel({ id: "gpt-image-1" }, null), false);
  assert.equal(loader.isTextInTextOutModel({ id: "sora-2" }, null), false);
});

test("collectModalities flattens arrays and compound separators", () => {
  const loader = loadModelLoader();

  assert.deepEqual(plain(loader.collectModalities([["text", "image"]])), ["text", "image"]);
  assert.deepEqual(plain(loader.collectModalities(["text+image"])), ["text", "image"]);
  assert.deepEqual(plain(loader.collectModalities(["text,image"])), ["text", "image"]);
  assert.deepEqual(plain(loader.collectModalities(["text/image"])), ["text", "image"]);
  assert.deepEqual(plain(loader.collectModalities(["TEXT", "Image"])), ["text", "image"]);
  assert.deepEqual(plain(loader.collectModalities(["text", "text"])), ["text"]);
  assert.deepEqual(plain(loader.collectModalities(["unknown"])), []);
  assert.deepEqual(plain(loader.collectModalities([null, undefined])), []);
});

test("normalizeReleaseDate accepts ISO dates and epoch timestamps", () => {
  const loader = loadModelLoader();

  assert.equal(loader.normalizeReleaseDate("2026-08-18"), "2026-08-18");
  assert.equal(loader.normalizeReleaseDate(1_750_000_000), "2025-06-15");
  assert.equal(loader.normalizeReleaseDate(1_750_000_000_000), "2025-06-15");
  assert.equal(loader.normalizeReleaseDate(null), null);
  assert.equal(loader.normalizeReleaseDate(""), null);
  assert.equal(loader.normalizeReleaseDate("not a date"), null);
});

test("toTableRow cross-references the catalog and prefers provider values", () => {
  const loader = loadModelLoader();
  const index = loader.buildModelReference(CATALOG);

  const row = loader.toTableRow({
    id: "zai-org/GLM-5.3",
    context_length: 200_000,
    input_price_per_million_tokens: 0.6,
    output_price_per_million_tokens: 1.8,
  }, index);

  assert.equal(row.modelId, "zai-org/GLM-5.3");
  assert.equal(row.name, "GLM-5.3");
  assert.equal(row.referenceMatched, true);
  assert.equal(row.isEmbedding, false);
  assert.equal(row.releaseDate, "2026-08-18");
  assert.equal(row.aaIndex, 45);
  assert.equal(row.contextWindow, 200_000); // provider value wins over the catalog
  assert.equal(row.parameterCount, 753_000_000_000);
  assert.equal(row.inputPrice, 0.6);
  assert.equal(row.outputPrice, 1.8);
  assert.equal(row.blendedPrice, ((3 * 0.6) + 1.8) / 4);
});

test("toTableRow falls back to the catalog context window, dates, and AA data", () => {
  const loader = loadModelLoader();
  const index = loader.buildModelReference(CATALOG);

  const row = loader.toTableRow({ id: "zai-org/GLM-5.3" }, index);
  assert.equal(row.contextWindow, 1024 * 1024);
  assert.equal(row.releaseDate, "2026-08-18");
  assert.equal(row.aaIndex, 45);
});

test("toTableRow reads metadata context windows and derives parameters from the id", () => {
  const loader = loadModelLoader();
  const index = loader.buildModelReference([]);

  const sized = loader.toTableRow({ id: "unknown/model", metadata: { context_window_k: 256 } }, index);
  assert.equal(sized.contextWindow, 256 * 1024);
  assert.equal(sized.referenceMatched, false);
  assert.equal(sized.name, null);
  assert.equal(sized.aaIndex, null);
  assert.equal(sized.blendedPrice, null);

  const fromId = loader.toTableRow({ id: "meta-llama/Llama-3.3-70B-Instruct" }, index);
  assert.equal(fromId.parameterCount, 70_000_000_000);
});

test("toTableRow converts tiny nested prices from per-token to per-million", () => {
  const loader = loadModelLoader();
  const index = loader.buildModelReference([]);

  const row = loader.toTableRow({
    id: "unknown/model",
    pricing: { prompt: 0.000002, completion: 0.000006 },
  }, index);

  assert.equal(row.inputPrice, 2);
  assert.equal(row.outputPrice, 6);
  assert.equal(row.blendedPrice, 3);
});

test("toTableRow marks embedding models from the id or the catalog type", () => {
  const loader = loadModelLoader();
  const empty = loader.buildModelReference([]);

  assert.equal(loader.toTableRow({ id: "Qwen/Qwen3-Embedding-8B" }, empty).isEmbedding, true);

  const index = loader.buildModelReference(CATALOG);
  assert.equal(loader.toTableRow({ id: "Qwen/Qwen3-Embedding-8B" }, index).isEmbedding, true);
});

test("enrichModels keeps only text-in/text-out models and starts them unselected", () => {
  const loader = loadModelLoader();
  const index = loader.buildModelReference(CATALOG);

  const result = loader.enrichModels(
    [
      { id: "zai-org/GLM-5.3" },            // chat: kept
      { id: "Qwen/Qwen3-Embedding-8B" },    // embedding: skipped
      { id: "gpt-4o-transcribe" },          // audio in, text out: skipped
      { id: "gpt-4o-mini-tts" },            // text in, audio out: skipped
      { id: "gpt-realtime" },               // text in/out by modality, non-chat by blacklist
      { id: "mystery-model" },              // no signal: assumed chat, kept
    ],
    index,
  );

  assert.equal(result.crossReferenced.length, 6);
  assert.equal(result.models.length, 2);
  assert.equal(result.skippedEmbeddings, 1);
  assert.equal(result.skippedNonText, 3);
  assert.deepEqual(plain(result.models.map((model) => model.modelId)), ["zai-org/GLM-5.3", "mystery-model"]);
  result.models.forEach((model) => assert.equal(model.selected, false));

  // Embedding rows are counted separately and never as non-text.
  const embedding = loader.enrichModels([{ id: "Qwen/Qwen3-Embedding-8B" }], index);
  assert.equal(embedding.skippedEmbeddings, 1);
  assert.equal(embedding.skippedNonText, 0);
  assert.equal(embedding.crossReferenced[0].isNonChat, false);

  // The combined filter drops a model that is text-to-text by modality but a
  // known non-chat endpoint.
  const realtime = loader.enrichModels([{ id: "gpt-realtime" }], index);
  assert.equal(realtime.skippedNonText, 1);
  assert.equal(realtime.models.length, 0);

  const emptyResult = loader.enrichModels([], index);
  assert.equal(emptyResult.models.length, 0);
  assert.equal(emptyResult.skippedEmbeddings, 0);
  assert.equal(emptyResult.skippedNonText, 0);
  assert.equal(emptyResult.crossReferenced.length, 0);
});

test("toTableRow exposes input/output modalities and the text-model verdict", () => {
  const loader = loadModelLoader();
  const index = loader.buildModelReference(CATALOG);

  const chat = loader.toTableRow({ id: "zai-org/GLM-5.3" }, index);
  assert.deepEqual(plain(chat.inputModalities), ["text"]);
  assert.deepEqual(plain(chat.outputModalities), ["text"]);
  assert.equal(chat.isTextModel, true);

  const embedding = loader.toTableRow({ id: "Qwen/Qwen3-Embedding-8B" }, index);
  assert.deepEqual(plain(embedding.inputModalities), ["text"]);
  assert.deepEqual(plain(embedding.outputModalities), ["embedding"]);
  assert.equal(embedding.isTextModel, false);

  const transcribe = loader.toTableRow({ id: "gpt-4o-transcribe" }, loader.buildModelReference([]));
  assert.deepEqual(plain(transcribe.inputModalities), ["audio"]);
  assert.deepEqual(plain(transcribe.outputModalities), ["text"]);
  assert.equal(transcribe.isTextModel, false);
});

test("getParameterCount and parseParameterCount handle catalog and provider units", () => {
  const loader = loadModelLoader();

  assert.equal(loader.getParameterCount({ size_b: 70.6 }), 70_600_000_000);
  assert.equal(loader.getParameterCount({ metadata: { size_b: 31.6 } }), 31_600_000_000);
  assert.equal(loader.getParameterCount({ parameter_count: 8_000_000_000 }), 8_000_000_000);
  assert.equal(loader.getParameterCount({}, 753_000_000_000), 753_000_000_000);
  assert.equal(loader.getParameterCount({ id: "meta-llama/Llama-3.3-70B-Instruct" }), 70_000_000_000);

  assert.equal(loader.parseParameterCount("235B"), 235_000_000_000);
  assert.equal(loader.parseParameterCount("1,200M"), 1_200_000_000);
  assert.equal(loader.parseParameterCount(8), 8);
  assert.equal(loader.parseParameterCount(null), null);
  assert.equal(loader.parseParameterCount("not a size"), null);
});

test("toNumber treats blanks and booleans as missing", () => {
  const loader = loadModelLoader();

  assert.equal(loader.toNumber(null), null);
  assert.equal(loader.toNumber(undefined), null);
  assert.equal(loader.toNumber(""), null);
  assert.equal(loader.toNumber(true), null);
  assert.equal(loader.toNumber("abc"), null);
  assert.equal(loader.toNumber("3.5"), 3.5);
  assert.equal(loader.toNumber(0), 0);
});

test("price helpers keep explicit per-million prices and scale tiny per-token ones", () => {
  const loader = loadModelLoader();

  assert.equal(loader.pricePerMillion(0.5, true), 0.5);
  assert.equal(loader.pricePerMillion(0.000002), 2);
  assert.equal(loader.pricePerMillion(3), 3);
  assert.equal(loader.pricePerMillion(0), 0);
  assert.equal(loader.pricePerMillion(null), null);

  // An explicit per-million field wins over the ambiguous nested value.
  assert.equal(loader.getPricePerMillion(0.000001, 999), 0.000001);
  assert.equal(loader.getPricePerMillion(undefined, 0.000003), 3);
});

test("the shipped catalog resolves real provider model ids and slugs", () => {
  const loader = loadModelLoader();
  const entries = JSON.parse(fs.readFileSync(path.join(projectRoot, "data", "models-generic.json"), "utf8"));
  const index = loader.buildModelReference(entries);

  const glm = loader.findModelReference("zai-org/GLM-5.3", index);
  assert.ok(glm, "zai-org/GLM-5.3 should resolve from the shipped catalog");
  assert.equal(glm.name, "GLM-5.3");

  // An aa_slug that does not collide with another entry is a usable alias.
  const pro = loader.findModelReference("deepseek-v4-pro-0424", index);
  assert.ok(pro, "deepseek-v4-pro-0424 should resolve from the shipped catalog");
  assert.equal(pro.name, "DeepSeek-V4-Pro");
});
