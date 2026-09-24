// LLM Quick Bench — shared model loading pipeline.
//
// Turns a provider /models response into enriched model rows: the /models URL
// builder, the provider fetch with error mapping and shape validation, the
// response reader, the catalog cross-reference (models-generic.json plus any
// provider-specific catalog, exact ids plus aliases) that fills in friendly
// names, release dates, context windows, parameter counts, and prices, and the
// embedding-model detection used to filter the list. Owns the shared MODELS
// array. The connection form in speed-test1.js drives the pipeline (status
// messages, console logging, resets) and writes the loaded rows into MODELS;
// every other script reads MODELS. Loaded with `defer` after bench-utils.js
// (for buildApiUrl/buildApiHeaders) and before speed-test1.js.

function buildModelsUrl(rawEndpoint, provider) {
  const url = buildApiUrl(rawEndpoint, "models");
  if (provider === "nebius") url.searchParams.set("verbose", "true");
  return url.toString();
}

async function readResponse(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 180)}`);
    throw new Error("The endpoint returned a non-JSON response.");
  }
}

// Fetches the provider's model list from its /models endpoint. Throws a
// readable Error when the request fails, the payload is not JSON, or the
// payload is neither a model array nor an OpenAI-style { data: [] } response.
async function fetchProviderModels(endpoint, provider, apiKey) {
  const url = buildModelsUrl(endpoint, provider);
  const response = await fetch(url, {
    method: "GET",
    headers: buildApiHeaders(apiKey, { accept: "application/json" }),
  });

  const payload = await readResponse(response);
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || response.statusText;
    throw new Error(`${response.status} ${message}`.trim());
  }

  const returnedModels = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(returnedModels)) {
    throw new Error("The endpoint did not return a model array or an OpenAI-style { data: [] } response.");
  }
  return returnedModels;
}

function toTableRow(model, modelReference) {
  const modelId = model.id ?? model.model_id ?? model.name;
  const reference = findModelReference(modelId, modelReference);
  const providerInputPrice = getPricePerMillion(
    model.input_price_per_million_tokens,
    model.pricing?.prompt ?? model.pricing?.input,
  );
  const providerOutputPrice = getPricePerMillion(
    model.output_price_per_million_tokens,
    model.pricing?.completion ?? model.pricing?.output,
  );
  const providerCachedInputPrice = getPricePerMillion(
    model.cached_input_price_per_million_tokens,
    model.pricing?.cached_input ?? model.pricing?.cache_read,
  );
  const providerCacheWritePrice = getPricePerMillion(
    model.cache_write_price_per_million_tokens,
    model.pricing?.cache_write,
  );
  // The provider's own prices win; otherwise fall back to the catalog so
  // providers like OpenAI (whose /models response has no pricing) still show
  // the release date, AA index, context window, and prices from its catalog.
  const inputPrice = providerInputPrice ?? reference?.inputPrice ?? null;
  const outputPrice = providerOutputPrice ?? reference?.outputPrice ?? null;
  const cachedInputPrice = providerCachedInputPrice ?? reference?.cachedInputPrice ?? null;
  const cacheWritePrice = providerCacheWritePrice ?? reference?.cacheWritePrice ?? null;
  const modalities = getModelModalities(model, reference);

  return {
    modelId,
    name: reference?.name ?? null,
    referenceMatched: reference != null,
    isEmbedding: isEmbeddingModel(model, reference),
    isNonChat: isNonChatModel(model, reference),
    inputModalities: modalities.input,
    outputModalities: modalities.output,
    isTextModel: modalities.input.includes("text") && modalities.output.includes("text"),
    releaseDate: normalizeReleaseDate(reference?.releaseDate),
    aaIndex: reference?.aaIndex ?? null,
    contextWindow: toNumber(
      model.context_length
        ?? model.context_window
        ?? model.max_model_len
        ?? (model.metadata?.context_window_k != null
          ? Number(model.metadata.context_window_k) * 1024
          : null)
        ?? reference?.contextWindow,
    ),
    parameterCount: getParameterCount(model, reference?.paramCount),
    inputPrice,
    cachedInputPrice,
    cacheWritePrice,
    outputPrice,
    blendedPrice: inputPrice != null && outputPrice != null
      ? ((3 * inputPrice) + outputPrice) / 4
      : null,
  };
}

// Cross-references the returned provider models against the catalog and
// produces the rows the models table renders. A model is kept only when it
// accepts text input and returns text output (isTextModel) and is not a known
// non-chat endpoint (isNonChat). Embeddings are counted separately; every other
// dropped row is counted as non-text. Every kept row starts unselected.
// `crossReferenced` keeps one enriched row per returned model (filtered models
// included) so callers can report what was filtered and why.
function enrichModels(returnedModels, modelReference) {
  const crossReferenced = returnedModels.map((model) => toTableRow(model, modelReference));
  const models = [];
  let skippedEmbeddings = 0;
  let skippedNonText = 0;
  for (const row of crossReferenced) {
    if (row.isEmbedding) {
      skippedEmbeddings += 1;
      continue;
    }
    if (row.isNonChat || !row.isTextModel) {
      skippedNonText += 1;
      continue;
    }
    models.push({ ...row, selected: false });
  }
  return {
    models,
    skippedEmbeddings,
    skippedNonText,
    crossReferenced,
  };
}

// The complete list of models loaded from the active provider, each enriched
// by the catalog. This array is the single source of truth for every script:
// speed-test1.js writes it through setModels(), and the benchmark scripts read
// it directly. `setModels` replaces the contents in place so references held by
// render functions stay live.
const MODELS = [];

function setModels(nextModels) {
  MODELS.length = 0;
  if (Array.isArray(nextModels)) MODELS.push(...nextModels);
}

// True when at least one model carries a usable (non-missing) value for `key`.
// Gates the selection shortcuts that depend on a given field: "Select 5 newest"
// needs releaseDate, "Select top 5 intelligent" needs aaIndex.
function hasAnyModelField(models, key) {
  return Array.isArray(models) && models.some((model) => !isMissing(model?.[key]));
}

// The shared model catalog cross-referenced against the provider's model list
// (friendly names, release dates, context windows, parameter counts, prices).
// The fetch, the load-status message, and every error name the file only
// through this constant.
const MODELS_GENERIC_FILE = "models-generic.json";

// Provider-specific catalogs layered over the shared catalog. Entries from
// these files are appended after models-generic.json, so they take precedence
// on matching ids and add provider-only details (such as OpenAI pricing).
const MODELS_PROVIDER_FILES = {
  openai: "models-openai.json",
};

function providerCatalogFile(provider) {
  return MODELS_PROVIDER_FILES[provider] ?? null;
}

async function loadCatalogFile(filename) {
  let response;
  try {
    response = await fetch(filename, { headers: { Accept: "application/json" } });
  } catch {
    throw new Error(`Unable to load ${filename}. Serve the app over HTTP instead of opening index.html directly.`);
  }
  if (!response.ok) {
    throw new Error(`Unable to load ${filename} (${response.status}).`);
  }

  let entries;
  try {
    entries = await response.json();
  } catch {
    throw new Error(`${filename} contains invalid JSON.`);
  }
  if (!Array.isArray(entries)) {
    throw new Error(`${filename} must contain an array of models.`);
  }
  return entries;
}

// Loads the shared catalog plus the selected provider's catalog, then merges
// them into one lookup index. The provider file is optional: custom endpoints
// and providers without a dedicated catalog fall back to models-generic.json.
async function loadModelReference(provider = null) {
  const files = [MODELS_GENERIC_FILE];
  const providerFile = providerCatalogFile(provider);
  if (providerFile) files.push(providerFile);

  const catalogs = await Promise.all(files.map(loadCatalogFile));
  return buildModelReference(catalogs.flat());
}

function buildModelReference(entries) {
  const exact = new Map();
  const aliases = new Map();
  const ambiguousAliases = new Set();

  function addAlias(candidate, reference) {
    if (!candidate) return;
    const key = normalizeModelId(candidate);
    if (ambiguousAliases.has(key)) return;
    if (aliases.has(key) && aliases.get(key) !== reference) {
      aliases.delete(key);
      ambiguousAliases.add(key);
      return;
    }
    aliases.set(key, reference);
  }

  entries.forEach((entry) => {
    const score = toNumber(entry.aa_intelligence_index);
    const paramCountBillions = toNumber(entry.param_count_B);
    const contextWindow = toNumber(entry.context_window_K) != null
      ? toNumber(entry.context_window_K) * 1024
      : null;
    const reference = {
      aaIndex: score,
      paramCount: paramCountBillions === null ? null : paramCountBillions * 1_000_000_000,
      contextWindow,
      type: entry.type ?? null,
      releaseDate: normalizeReleaseDate(entry.model_release_date),
      name: entry.name ?? null,
      inputPrice: toNumber(entry.input_price_per_million_tokens),
      outputPrice: toNumber(entry.output_price_per_million_tokens),
      cachedInputPrice: toNumber(entry.cached_input_price_per_million_tokens),
      cacheWritePrice: toNumber(entry.cache_write_price_per_million_tokens),
    };

    const name = String(entry.name ?? "");
    const fullName = entry.model_id ?? (name.includes("/") ? name : `${entry.vendor ?? ""}/${name}`);
    const repositoryId = String(entry.huggingface_url ?? "")
      .replace(/^https?:\/\/huggingface\.co\//i, "")
      .replace(/\/+$/, "");
    const baseName = String(fullName).split("/").at(-1);
    [fullName, baseName].forEach((candidate) => {
      if (candidate) exact.set(normalizeModelId(candidate), reference);
    });
    [
      repositoryId,
      repositoryId.split("/").at(-1),
      name,
      entry.aa_slug,
    ].forEach((candidate) => addAlias(candidate, reference));
  });
  return { exact, aliases };
}

function findModelReference(modelId, index) {
  if (!modelId) return null;
  const fullId = normalizeModelId(modelId);
  const baseId = normalizeModelId(String(modelId).split("/").at(-1));
  const candidates = [];
  for (const candidate of [fullId, baseId]) {
    if (!candidate) continue;
    const fastStripped = candidate.replace(/-fast$/, "");
    const variants = [candidate, fastStripped, stripModelDateSuffix(candidate), stripModelDateSuffix(fastStripped)];
    for (const variant of variants) {
      if (variant && !candidates.includes(variant)) candidates.push(variant);
    }
  }

  for (const candidate of candidates) {
    if (index.exact.has(candidate)) return index.exact.get(candidate);
  }
  for (const candidate of candidates) {
    if (index.aliases.has(candidate)) return index.aliases.get(candidate);
  }

  return null;
}

// Provider snapshots often append a date to the catalogued base id (for
// example `gpt-4.1-2025-04-14`). Two date shapes are recognised: an ISO
// `-YYYY-MM-DD` suffix and OpenAI's legacy `-MMDD` form (for example
// `gpt-3.5-turbo-0125`). The MMDD form is only stripped when the month and day
// are valid, so an ordinary trailing number is left untouched.
function stripModelDateSuffix(modelId) {
  const withoutIsoDate = modelId.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (withoutIsoDate !== modelId) return withoutIsoDate;

  const monthDay = modelId.match(/-(\d{2})(\d{2})$/);
  if (monthDay) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return modelId.slice(0, -5);
    }
  }
  return modelId;
}

function normalizeModelId(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function isEmbeddingModel(model, reference) {
  const descriptors = [
    model.id,
    model.model_id,
    model.name,
    model.type,
    model.model_type,
    model.task,
    model.pipeline_tag,
    model.metadata?.type,
    model.metadata?.task,
    model.metadata?.pipeline_tag,
    reference?.type,
  ];

  return descriptors.some((value) => (
    value != null && /(^|[^a-z])(embedding|embeddings|embed)([^a-z]|$)/i.test(String(value))
  ));
}

// Catalog types that are known to be non-chat. The catalog's chat types
// (`text2text`, `image2text`) are deliberately absent, so a multimodal chat
// model is never filtered just because its type mentions "image".
const NON_CHAT_REFERENCE_TYPES = new Set([
  "embedding",
  "embeddings",
  "audio",
  "speech",
  "tts",
  "transcription",
  "image",
  "video",
  "rerank",
  "moderation",
]);

// Known non-chat endpoints (embeddings, audio, image, TTS, transcription,
// realtime, moderation, and legacy completions) cannot serve chat/completions.
// This id/type blacklist complements the modality classifier in
// getModelModalities: modality decides text-in/text-out, while the blacklist
// also drops models that look text-to-text but target another endpoint (legacy
// completions such as babbage/davinci, or realtime/audio models).
// Embeddings are excluded here and reported through isEmbeddingModel so the two
// counts stay separate.
function isNonChatModel(model, reference) {
  if (isEmbeddingModel(model, reference)) return false;

  const idFields = [model.id, model.model_id, model.name];
  const idPattern = /(^|[^a-z])(embedding|embeddings|embed|tts|whisper|transcri[a-z]*|diariz[a-z]*|dall-e|dalle|sora|moderation|re-?rank[a-z]*|realtime|speech|audio|image|diffusion|babbage|davinci|curie|gpt-live)([^a-z]|$)/i;
  if (idFields.some((value) => value != null && idPattern.test(String(value)))) return true;

  return reference?.type != null && NON_CHAT_REFERENCE_TYPES.has(String(reference.type).toLowerCase());
}

// Canonical modality vocabulary. Only text input and text output matter to the
// models table, which benchmarks chat/completions endpoints.
const MODALITY_ALIASES = {
  text: "text",
  language: "text",
  prompt: "text",
  image: "image",
  vision: "image",
  audio: "audio",
  speech: "audio",
  sound: "audio",
  video: "video",
  embedding: "embedding",
  embeddings: "embedding",
  vector: "embedding",
  score: "score",
  scores: "score",
  logits: "score",
  moderation: "moderation",
  labels: "moderation",
  document: "document",
  pdf: "document",
  file: "document",
};

// Catalog/provider type tokens that do not use the `<input>2<output>` or
// `<input>-><output>` form.
const NAMED_MODALITY_TYPES = {
  "text-generation": { input: ["text"], output: ["text"] },
  "text2text-generation": { input: ["text"], output: ["text"] },
  "text-to-text": { input: ["text"], output: ["text"] },
  "automatic-speech-recognition": { input: ["audio"], output: ["text"] },
  "text-to-speech": { input: ["text"], output: ["audio"] },
  "text-to-image": { input: ["text"], output: ["image"] },
  "image-to-text": { input: ["image", "text"], output: ["text"] },
  "image-text-to-text": { input: ["image", "text"], output: ["text"] },
  "feature-extraction": { input: ["text"], output: ["embedding"] },
  "sentence-similarity": { input: ["text"], output: ["embedding"] },
};

// Modality sources that describe a model without naming an input/output pair.
const SINGLE_MODALITY_TYPES = {
  embedding: { input: ["text"], output: ["embedding"] },
  embeddings: { input: ["text"], output: ["embedding"] },
  chat: { input: ["text"], output: ["text"] },
  image: { input: ["text"], output: ["image"] },
  video: { input: ["text"], output: ["video"] },
  tts: { input: ["text"], output: ["audio"] },
  speech: { input: ["text"], output: ["audio"] },
  moderation: { input: ["text"], output: ["moderation"] },
  rerank: { input: ["text"], output: ["score"] },
  realtime: { input: ["audio", "text"], output: ["audio", "text"] },
  audio: { input: ["audio", "text"], output: ["audio", "text"] },
};

// Parses a catalog/provider type or task token (for example `image2text`,
// `text->text`, `text-to-image`, `automatic-speech-recognition`) into input and
// output modality arrays. Returns null when the token is not recognised.
function modalitiesFromTypeToken(token) {
  if (token == null) return null;
  const value = String(token).toLowerCase().trim().replaceAll("_", "-");
  if (!value) return null;

  if (NAMED_MODALITY_TYPES[value]) return NAMED_MODALITY_TYPES[value];
  if (SINGLE_MODALITY_TYPES[value]) return SINGLE_MODALITY_TYPES[value];

  const pair = value.split(/\s*(?:->|→|2| to )\s*/).filter(Boolean);
  if (pair.length !== 2) return null;
  const input = MODALITY_ALIASES[pair[0]];
  const output = MODALITY_ALIASES[pair[1]];
  if (!input || !output) return null;
  // An image-capable chat model also accepts text, so vision inputs imply text.
  return { input: input === "image" ? ["image", "text"] : [input], output: [output] };
}

// Infers modalities from a model id when no type or declared modality exists.
function modalitiesFromId(modelId) {
  if (modelId == null) return null;
  const value = String(modelId).toLowerCase();
  const matches = (pattern) => pattern.test(value);

  if (matches(/(^|[^a-z])(embedding|embeddings|embed)([^a-z]|$)/)) return { input: ["text"], output: ["embedding"] };
  if (matches(/(^|[^a-z])(whisper|transcri[a-z]*|diariz[a-z]*)([^a-z]|$)/)) return { input: ["audio"], output: ["text"] };
  if (matches(/(^|[^a-z])(tts|speech)([^a-z]|$)/)) return { input: ["text"], output: ["audio"] };
  if (matches(/(^|[^a-z])(sora)([^a-z]|$)/)) return { input: ["text"], output: ["video"] };
  if (matches(/(^|[^a-z])(dall-e|dalle|diffusion|image)([^a-z]|$)/)) return { input: ["text"], output: ["image"] };
  if (matches(/(^|[^a-z])(moderation)([^a-z]|$)/)) return { input: ["text"], output: ["moderation"] };
  if (matches(/(^|[^a-z])(re-?rank[a-z]*)([^a-z]|$)/)) return { input: ["text"], output: ["score"] };
  if (matches(/(^|[^a-z])(realtime|live)([^a-z]|$)/)) return { input: ["audio", "text"], output: ["audio", "text"] };
  if (matches(/(^|[^a-z])(audio)([^a-z]|$)/)) return { input: ["audio", "text"], output: ["audio", "text"] };
  return null;
}

// Flattens modality values (arrays, `+`/comma/slash lists, or single strings)
// into the canonical vocabulary, dropping anything unrecognised and
// de-duplicating.
function collectModalities(sources) {
  const found = [];
  const add = (value) => {
    if (value == null) return;
    const parts = Array.isArray(value) ? value : String(value).split(/[,/|+&]/);
    for (const part of parts) {
      const token = MODALITY_ALIASES[String(part).toLowerCase().trim().replaceAll("_", "-")];
      if (token && !found.includes(token)) found.push(token);
    }
  };
  sources.forEach(add);
  return found;
}

// Reads modalities a provider declares on the model object (OpenRouter-style
// arrays or an `architecture.modality` string). Returns null when none exist.
function declaredModalities(model) {
  const input = collectModalities([
    model.input_modalities,
    model.inputModalities,
    model.input_modality,
    model.modalities?.input,
    model.architecture?.input_modalities,
    model.architecture?.modality?.input,
  ]);
  const output = collectModalities([
    model.output_modalities,
    model.outputModalities,
    model.output_modality,
    model.modalities?.output,
    model.architecture?.output_modalities,
    model.architecture?.modality?.output,
  ]);
  if (input.length || output.length) return { input, output };

  const combined = model.architecture?.modality ?? model.modality;
  if (typeof combined === "string" && (combined.includes("->") || combined.includes("→"))) {
    const [inputToken, outputToken] = combined.split(/\s*(?:->|→)\s*/);
    const parsed = {
      input: collectModalities([inputToken]),
      output: collectModalities([outputToken]),
    };
    if (parsed.input.length || parsed.output.length) return parsed;
  }
  return null;
}

// Resolves a model's input and output modalities. Precedence per side:
// provider-declared modalities, then provider/first-class type tokens, then the
// catalog type, then id heuristics. A provider that declares only one side (for
// example input modalities without output) keeps the declared side and fills
// the other from the inference chain, so a partial declaration cannot drop a
// valid model. Models with no modality signal at all default to text in / text
// out, because they are most likely chat models on a chat-completions endpoint.
function getModelModalities(model, reference) {
  const inferred = modalitiesFromTypeToken(model.type)
    ?? modalitiesFromTypeToken(model.model_type)
    ?? modalitiesFromTypeToken(model.task)
    ?? modalitiesFromTypeToken(model.pipeline_tag)
    ?? modalitiesFromTypeToken(model.metadata?.type)
    ?? modalitiesFromTypeToken(model.metadata?.task)
    ?? modalitiesFromTypeToken(model.metadata?.pipeline_tag)
    ?? modalitiesFromTypeToken(reference?.type)
    ?? modalitiesFromId(model.id ?? model.model_id ?? model.name)
    ?? { input: ["text"], output: ["text"] };

  const declared = declaredModalities(model);
  if (!declared) return inferred;
  return {
    input: declared.input.length > 0 ? declared.input : inferred.input,
    output: declared.output.length > 0 ? declared.output : inferred.output,
  };
}

// True only for models that accept text input and return text output - the
// models the chat/completions benchmarks can actually call.
function isTextInTextOutModel(model, reference) {
  const { input, output } = getModelModalities(model, reference);
  return input.includes("text") && output.includes("text");
}


function normalizeReleaseDate(value) {
  if (value == null || value === "") return null;

  const numericValue = Number(value);
  const date = Number.isFinite(numericValue)
    ? new Date(numericValue < 1_000_000_000_000 ? numericValue * 1000 : numericValue)
    : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function getParameterCount(model, referenceParamCount = null) {
  const billionValue = model.size_b
    ?? model.metadata?.size_b
    ?? model.architecture?.size_b
    ?? model.parameter_count_b;
  if (billionValue != null && Number.isFinite(Number(billionValue)) && Number(billionValue) > 0) {
    return Number(billionValue) * 1_000_000_000;
  }

  const directValue = model.parameter_count
    ?? model.parameters_count
    ?? model.num_parameters
    ?? model.architecture?.parameter_count
    ?? model.architecture?.parameters;
  const parsedDirectValue = parseParameterCount(directValue);
  if (parsedDirectValue != null) return parsedDirectValue;
  if (referenceParamCount != null) return referenceParamCount;

  return parseParameterCount(model.id ?? model.model_id ?? model.name);
}

function parseParameterCount(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const text = String(value).replaceAll(",", "");
  const sizedMatch = text.match(/(\d+(?:\.\d+)?)\s*([BM])\b/i);
  if (sizedMatch) {
    const multiplier = sizedMatch[2].toUpperCase() === "B" ? 1_000_000_000 : 1_000_000;
    return Number(sizedMatch[1]) * multiplier;
  }

  const numericValue = Number(text);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getPricePerMillion(explicitPerMillion, ambiguousPrice) {
  if (explicitPerMillion != null) {
    return pricePerMillion(explicitPerMillion, true);
  }
  return pricePerMillion(ambiguousPrice);
}

function pricePerMillion(value, isAlreadyPerMillion = false) {
  const price = toNumber(value);
  // `null` means "no price published" (downstream treat as Unpriced).
  // A literal `0` means "free at point of use" (downstream treat as $0.00).
  if (price === null || price === 0) return price;
  if (isAlreadyPerMillion) return price;

  // Nested pricing fields do not consistently declare their unit. Tiny values
  // are normally per-token amounts; explicit *_per_million_tokens fields skip
  // this heuristic via getPricePerMillion().
  return Math.abs(price) < 0.001 ? price * 1_000_000 : price;
}
