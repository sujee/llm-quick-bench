// LLM Quick Bench — shared endpoint presets.
//
// Pure provider configuration data (no DOM, no side effects). Loaded before
// speed-test1.js so the connection form can populate the endpoint field from a
// selected provider.

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
