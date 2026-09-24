# Dev Notes

## Architecture

Zero dependencies, no build step. All scripts live in `js/`; classic `<script defer>` files share global lexical scope, so load order matters:

1. `js/bench-utils.js` — shared pure + DOM helpers (streaming, tables, column picker, styled confirm dialog, long-context task generation)
2. `js/presets.js` — pure provider configuration (endpoint presets consumed by the connection form)
3. `js/model-loader.js` — the model-loading pipeline (provider `/models` fetch plus the data/models-generic.json cross-reference) and the shared `MODELS` array every other script reads
4. `js/speed-test1.js`, `js/thinking-test1.js`, `js/decode-test1.js` — the three independent benchmarks
5. `js/context-bench.js` — the shared long-context engine (`createContextBenchmark`)
6. `js/needle-test1.js`, `js/prefill-test1.js` — thin configs that instantiate the engine

The Needle Test sizes each document at a fill percent of the model's advertised context window and varies the needle position; the Prefill Test varies the input size with the needle pinned near the end. Needle Test models run strictly one at a time (uncontended prefill keeps TTFT comparable), and `showBenchmarkConfirm` (js/bench-utils.js) renders the styled pre-run dialog that totals planned requests, input tokens, and estimated input cost. Pure helpers live in `js/bench-utils.js` so they can be unit-tested without a DOM.

## Local testing

```bash
cd llm-quick-bench
python3 -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000).

Your API key is used only for the current browser session and is not saved. Requests are sent directly from your browser to the selected endpoint.

## Env

For local testings (with coding agents) `.env` file is used to read API keys

```
# example API keys
NEBIUS_API_KEY=xxxx
OPENAI_API_KEY=yyyy
```

## Test

```bash
node --test tests/*.test.js
```

## Model Info

Gathered from multiple sources  https://models.dev/, artificial analysis,  hugging face

Models meta data is in : [data/models-generic.json](data/models-generic.json), fetched and cross-referenced by `js/model-loader.js`
