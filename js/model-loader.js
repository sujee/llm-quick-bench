// LLM Quick Bench — shared model loading pipeline.
//
// Turns a provider /models response into enriched model rows: the /models URL
// builder, the provider fetch with error mapping and shape validation, the
// response reader, the models-generic.json catalog cross-reference (exact ids
// plus aliases) that fills in friendly names, release dates, context windows,
// parameter counts, and prices, and the embedding-model detection used to
// filter the list. Pure data pipeline — the connection form in speed-test1.js
// drives it (status messages, console logging, resets) and owns the loaded
// `models` state. Loaded with `defer` after bench-utils.js (for
// buildApiUrl/buildApiHeaders) and before speed-test1.js.

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
  const inputPrice = getPricePerMillion(
    model.input_price_per_million_tokens,
    model.pricing?.prompt ?? model.pricing?.input,
  );
  const outputPrice = getPricePerMillion(
    model.output_price_per_million_tokens,
    model.pricing?.completion ?? model.pricing?.output,
  );

  return {
    modelId,
    name: reference?.name ?? null,
    referenceMatched: reference != null,
    isEmbedding: isEmbeddingModel(model, reference),
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
    outputPrice,
    blendedPrice: inputPrice != null && outputPrice != null
      ? ((3 * inputPrice) + outputPrice) / 4
      : null,
  };
}

// Cross-references the returned provider models against the catalog and
// produces the rows the models table renders: embedding models are dropped
// (counted separately) and every kept row starts unselected. `crossReferenced`
// keeps one enriched row per returned model (embeddings included) so callers
// can report what was filtered and why.
function enrichModels(returnedModels, modelReference) {
  const crossReferenced = returnedModels.map((model) => toTableRow(model, modelReference));
  const models = crossReferenced
    .filter((model) => !model.isEmbedding)
    .map((model) => ({ ...model, selected: false }));
  return {
    models,
    skippedEmbeddings: crossReferenced.length - models.length,
    crossReferenced,
  };
}

// The shared model catalog cross-referenced against the provider's model list
// (friendly names, release dates, context windows, parameter counts, prices).
// The fetch, the load-status message, and every error name the file only
// through this constant.
const MODELS_GENERIC_FILE = "models-generic.json";

async function loadModelReference() {
  let response;
  try {
    response = await fetch(MODELS_GENERIC_FILE, { headers: { Accept: "application/json" } });
  } catch {
    throw new Error(`Unable to load ${MODELS_GENERIC_FILE}. Serve the app over HTTP instead of opening index.html directly.`);
  }
  if (!response.ok) {
    throw new Error(`Unable to load ${MODELS_GENERIC_FILE} (${response.status}).`);
  }

  let entries;
  try {
    entries = await response.json();
  } catch {
    throw new Error(`${MODELS_GENERIC_FILE} contains invalid JSON.`);
  }
  if (!Array.isArray(entries)) {
    throw new Error(`${MODELS_GENERIC_FILE} must contain an array of models.`);
  }
  return buildModelReference(entries);
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
  const candidates = [fullId, baseId, fullId.replace(/-fast$/, ""), baseId.replace(/-fast$/, "")];

  for (const candidate of candidates) {
    if (index.exact.has(candidate)) return index.exact.get(candidate);
  }
  for (const candidate of candidates) {
    if (index.aliases.has(candidate)) return index.aliases.get(candidate);
  }

  return null;
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
