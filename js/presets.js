// LLM Quick Bench — shared endpoint presets and provider request defaults.
//
// Pure provider configuration data plus a tiny registry so the benchmark tests
// can reset their option controls from provider-specific defaults. Loaded
// before speed-test1.js so the connection form can populate the endpoint field
// from a selected provider.

const endpointPresets = {
  nebius: {
    endpoint: "https://api.tokenfactory.nebius.com/v1",
    hint: "Nebius OpenAI-compatible API base URL.",
  },
  openai: {
    endpoint: "https://api.openai.com/v1",
    hint: "OpenAI API base URL.",
  },
  togetherai: {
    endpoint: "https://api.together.ai/v1",
    hint: "Together AI OpenAI-compatible API base URL.",
  },
  fireworks: {
    endpoint: "https://api.fireworks.ai/inference/v1",
    hint: "Fireworks AI OpenAI-compatible API base URL.",
  },
  baseten: {
    endpoint: "https://inference.baseten.co/v1",
    hint: "Baseten OpenAI-compatible API base URL.",
  },
  ollama: {
    endpoint: "http://localhost:11434/v1",
    hint: "Local Ollama OpenAI-compatible API base URL.",
  },
  ollamacloud: {
    endpoint: "https://ollama.com/v1",
    hint: "Ollama Cloud OpenAI-compatible API base URL.",
  },
  lmstudio: {
    endpoint: "http://localhost:1234/v1",
    hint: "Local LM Studio OpenAI-compatible API base URL.",
  },
};

// Shared option defaults for every benchmark test. A `null` value means the
// option is omitted from the request body entirely.
const TEST_REQUEST_DEFAULTS = {
  speed: { temperature: 0, minTokens: 1024, maxTokens: 1024, disableThinking: true },
  thinking: { temperature: 0, disableThinking: false },
  decode: { temperature: 0, disableThinking: true, fixedOutput: true },
  needle: { temperature: 0 },
  prefill: { temperature: 0 },
  cache: { temperature: 0 },
};

// Per-provider overrides layered over TEST_REQUEST_DEFAULTS. Providers not
// listed here use the shared defaults unchanged.
const PROVIDER_TEST_REQUEST_OVERRIDES = {
  openai: {
    speed: { temperature: null, minTokens: null, disableThinking: false },
    thinking: { temperature: null },
    decode: { temperature: null, disableThinking: false, fixedOutput: false },
    needle: { temperature: null },
    prefill: { temperature: null },
    cache: { temperature: null },
  },
};

function resolveTestRequestDefaults(testKey, provider) {
  const base = TEST_REQUEST_DEFAULTS[testKey] ?? {};
  const override = PROVIDER_TEST_REQUEST_OVERRIDES[provider]?.[testKey] ?? {};
  return { ...base, ...override };
}

// Each benchmark registers an applier that resets its option controls for a
// provider. speed-test1.js owns the provider select and triggers the sweep.
const providerDefaultsAppliers = [];

function registerProviderDefaultsApplier(applier) {
  if (typeof applier === "function") providerDefaultsAppliers.push(applier);
}

function applyProviderDefaults(provider) {
  providerDefaultsAppliers.forEach((applier) => applier(provider));
}
