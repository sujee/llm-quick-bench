# Dev Notes

## Architecture

Zero dependencies, no build step. Classic `<script defer>` files share global lexical scope, so load order matters:

1. `bench-utils.js` — shared pure + DOM helpers (streaming, tables, column picker, styled confirm dialog, long-context task generation)
2. `speed-test1.js`, `thinking-test1.js`, `decode-test1.js` — the three independent benchmarks
3. `context-bench.js` — the shared long-context engine (`createContextBenchmark`)
4. `needle-test1.js`, `prefill-test1.js` — thin configs that instantiate the engine

The Needle Test sizes each document at a fill percent of the model's advertised context window and varies the needle position; the Prefill Test varies the input size with the needle pinned near the end. Needle Test models run strictly one at a time (uncontended prefill keeps TTFT comparable), and `showBenchmarkConfirm` (bench-utils.js) renders the styled pre-run dialog that totals planned requests, input tokens, and estimated input cost. Pure helpers live in `bench-utils.js` so they can be unit-tested without a DOM.

## Local testing

```bash
cd llm-quick-bench
python3 -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000).

Your API key is used only for the current browser session and is not saved. Requests are sent directly from your browser to the selected endpoint.

## Test

```bash
node --test tests/*.test.js
```

## Model Info

Models meta data is in : [model-info.json](model-info.json)
