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
  MODELS_GENERIC_FILE,
  buildModelsUrl,
  buildModelReference,
  enrichModels,
  fetchProviderModels,
  findModelReference,
  getParameterCount,
  getPricePerMillion,
  isEmbeddingModel,
  loadModelReference,
  normalizeModelId,
  normalizeReleaseDate,
  parseParameterCount,
  pricePerMillion,
  readResponse,
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
    "isEmbeddingModel", "normalizeReleaseDate", "getParameterCount", "parseParameterCount",
    "toNumber", "getPricePerMillion", "pricePerMillion",
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
  assert.equal((loaderSource.match(/"models-generic\.json"/g) ?? []).length, 1);
  assert.match(speedSource, /\$\{MODELS_GENERIC_FILE\}/);
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
  assert.equal(loader.MODELS_GENERIC_FILE, "models-generic.json");
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

  assert.equal(calls[0].url, "models-generic.json");
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
    /Unable to load models-generic\.json\. Serve the app over HTTP instead of opening index\.html directly\./,
  );

  const notFoundLoader = loadModelLoader({
    fetch: async () => fakeResponse({ ok: false, status: 404 }),
  });
  await assert.rejects(
    notFoundLoader.loadModelReference(),
    /Unable to load models-generic\.json \(404\)\./,
  );

  const invalidJsonLoader = loadModelLoader({
    fetch: async () => fakeResponse({ body: "not json" }),
  });
  await assert.rejects(
    invalidJsonLoader.loadModelReference(),
    /models-generic\.json contains invalid JSON\./,
  );

  const notArrayLoader = loadModelLoader({
    fetch: async () => fakeResponse({ body: '{"models":[]}' }),
  });
  await assert.rejects(
    notArrayLoader.loadModelReference(),
    /models-generic\.json must contain an array of models\./,
  );
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

test("enrichModels drops embedding rows and starts every kept model unselected", () => {
  const loader = loadModelLoader();
  const index = loader.buildModelReference(CATALOG);

  const result = loader.enrichModels(
    [{ id: "zai-org/GLM-5.3" }, { id: "Qwen/Qwen3-Embedding-8B" }],
    index,
  );

  assert.equal(result.crossReferenced.length, 2);
  assert.equal(result.models.length, 1);
  assert.equal(result.skippedEmbeddings, 1);
  assert.equal(result.models[0].modelId, "zai-org/GLM-5.3");
  assert.equal(result.models[0].selected, false);
  assert.equal(result.models[0].referenceMatched, true);
  assert.equal(result.crossReferenced[1].isEmbedding, true);

  const emptyResult = loader.enrichModels([], index);
  assert.equal(emptyResult.models.length, 0);
  assert.equal(emptyResult.skippedEmbeddings, 0);
  assert.equal(emptyResult.crossReferenced.length, 0);
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
  const entries = JSON.parse(fs.readFileSync(path.join(projectRoot, "models-generic.json"), "utf8"));
  const index = loader.buildModelReference(entries);

  const glm = loader.findModelReference("zai-org/GLM-5.3", index);
  assert.ok(glm, "zai-org/GLM-5.3 should resolve from the shipped catalog");
  assert.equal(glm.name, "GLM-5.3");

  // An aa_slug that does not collide with another entry is a usable alias.
  const pro = loader.findModelReference("deepseek-v4-pro-0424", index);
  assert.ok(pro, "deepseek-v4-pro-0424 should resolve from the shipped catalog");
  assert.equal(pro.name, "DeepSeek-V4-Pro");
});
