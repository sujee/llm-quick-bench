# Repository Instructions

## Testing

After every change, run the full test suite before reporting the work complete:

```bash
node --test tests/*.test.js
```

If the tests fail, fix the failure and rerun the full suite. If the suite cannot be run, clearly report why.

When a change alters behavior, treat the tests as part of the change:

- Review the existing tests that cover the affected code before and after the change.
- Update any test that asserts the old behavior.
- Add new tests for the new or changed behavior when coverage is missing.
- A behavior change with no matching test change is incomplete.

## Versioning

The application version is the positive integer `LLM_QUICK_BENCH_VERSION` value in `js/version.js`. It is displayed with a `v` prefix, such as `v2`.

Do not increment the version for ordinary commits. Increment it by exactly one only when publishing. Use integers only—never semantic versions, decimals, or dotted version strings. A publish must contain exactly one version increment, regardless of how many commits it includes.

## Git Discipline

Never commit or push automatically. Always ask the user for explicit approval before each commit and before each push.

- Get explicit permission for every commit, push, merge, or pull request; never perform one automatically.
- Keep ordinary work commits on the working branch. Ordinary work commits do not change the version.
- Publish only by merging the completed, tested work into the `main` worktree and pushing from there. Never push a feature or working branch in place of `main`.

## Publishing

Publishing happens only from the `main` branch and its worktree.

After the user explicitly approves publishing completed and tested work from another branch:

1. Ensure the completed work is committed on the working branch. Ordinary work commits do not change the version.
2. Increment the version by exactly one and commit that publishing change on the working branch, after obtaining explicit commit approval.
3. Verify that the `main` worktree is clean.
4. Merge the working branch into `main` from the `main` worktree.
5. Run the full test suite in the `main` worktree.
6. Ask for explicit push approval, then push `main` to `origin`.

Do not publish by pushing a feature or working branch instead of `main`.

## Live Provider Loading Tests

Use this to verify the model-loading pipeline (`js/model-loader.js`) against a real provider `/models` endpoint. It runs the shipped loader code in Node, so it exercises the same catalog cross-reference and filtering as the browser app. Run it after changing the loader, the filters, or a catalog.

API keys come from `.env` and are never hard-coded:

```
OPENAI_API_KEY=...
NEBIUS_API_KEY=...
```

Keep throwaway scripts outside the repo (for example in the session temp directory) so they are never committed.

Read a key without adding a dependency:

```js
function readEnvKey(name) {
  const text = fs.readFileSync(".env", "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() === name) {
      return line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return null;
}
```

Load the real pipeline with the same globals the browser provides. A `diskFetch` shim serves the catalog files from disk and forwards every HTTP request to the real `fetch`:

```js
const diskFetch = (url, options) => {
  const name = String(url);
  if (!/^https?:/i.test(name) && fs.existsSync(path.join(projectRoot, name))) {
    const body = fs.readFileSync(path.join(projectRoot, name), "utf8");
    return Promise.resolve({
      ok: true, status: 200, statusText: "OK",
      text: () => Promise.resolve(body),
      json: () => Promise.resolve(JSON.parse(body)),
    });
  }
  return fetch(url, options);
};

const context = vm.createContext({
  AbortController, Blob, DOMException, Headers, ReadableStream, Response,
  TextDecoder, URL, clearTimeout, console, performance, setTimeout, fetch: diskFetch,
});
vm.runInContext(fs.readFileSync("js/bench-utils.js", "utf8"), context);
vm.runInContext(`${fs.readFileSync("js/model-loader.js", "utf8")}
this.__modelLoader = { fetchProviderModels, loadModelReference, enrichModels, buildModelsUrl, getModelModalities };`, context);
```

Then drive the pipeline:

```js
const loader = context.__modelLoader;
const returned = await loader.fetchProviderModels("https://api.openai.com/v1", "openai", readEnvKey("OPENAI_API_KEY"));
const reference = await loader.loadModelReference("openai");
const { models, skippedEmbeddings, skippedNonText, crossReferenced } = loader.enrichModels(returned, reference);
```

Report every drop with its reason (`isEmbedding`, `isNonChat`, or the `inputModalities -> outputModalities` pair) so the filtering is explainable, not just a count. Nebius is fetched with `?verbose=true` and returns `architecture.modality` strings such as `text+image->text`.

Run it against each provider, for example `node <script>.js openai` and `node <script>.js nebius`.

## Provider Model Catalogs

Provider-specific metadata lives in the `MODELS_PROVIDER_FILES` map in `js/model-loader.js` (`openai` -> `data/models-openai.json`). Entries are layered after `data/models-generic.json` and win on matching ids.

To add or update a model, append an object to the JSON array in `data/models-openai.json`:

```json
{
  "name": "GPT-5.7",
  "type": "image2text",
  "vendor": "openai",
  "aa_slug": "gpt-5-7",
  "aa_intelligence_index": 50,
  "model_id": "openai/gpt-5.7",
  "model_release_date": "2026-10-01",
  "context_window_K": 1025.390625,
  "huggingface_url": null,
  "param_count_B": null,
  "input_price_per_million_tokens": 2,
  "cached_input_price_per_million_tokens": 0.2,
  "cache_write_price_per_million_tokens": 2.5,
  "output_price_per_million_tokens": 10
}
```

- `model_id` matches the provider id or its base name after normalization (lowercase, non-alphanumerics -> `-`). Dated snapshots such as `gpt-5.7-2026-10-01` resolve to the base entry.
- `type` drives classification: `image2text` (multimodal chat, kept), `text2text` (kept), `embedding` (filtered).
- `model_release_date` powers "Select 5 newest"; `aa_intelligence_index` powers "Select top 5 intelligent".
- `*_price_per_million_tokens` is the only price source for OpenAI, whose `/models` response has none.
- The file must remain a JSON array.

Research the values from public sources, and note which source you used so the metadata stays consistent across catalogs:

- **Artificial Analysis** (https://artificialanalysis.ai/) - `aa_intelligence_index` and the `aa_slug` alias. Keep the index aligned with the AA version you read.
- **Hugging Face** (https://huggingface.co/) - `huggingface_url` and `param_count_B`, plus architecture and context details from the model card.
- **models.dev** (https://models.dev/) - cross-reference for `context_window_K`, pricing, and release dates.
- **Provider docs and pricing pages** (for example OpenAI's pricing page) - authoritative `*_price_per_million_tokens` and `model_release_date`.
- **Provider `/models` output** - the source of truth for which ids exist; use the live loading test above to see what is missing or unmatched.

This matches the shared catalog's collection note in `dev-notes.md` ("multiple sources: models.dev, Artificial Analysis, Hugging Face").

Find drift with the live loading test above: unmatched models show `-` in the table and are absent from the matched count. Validate with `node --test tests/*.test.js`; the unit tests use their own fixtures, so catalog edits do not require test changes.
