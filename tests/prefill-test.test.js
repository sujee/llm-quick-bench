const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
const prefillSource = fs.readFileSync(path.join(projectRoot, "prefill-test1.js"), "utf8");
const engineSource = fs.readFileSync(path.join(projectRoot, "context-bench.js"), "utf8");

test("Prefill Test form defaults follow the bench conventions", () => {
  const panel = html.slice(html.indexOf('id="prefill-test-panel"'));
  assert.match(panel, /id="prefill-sizes"[^>]*value="10000,50000,100000,250000,500000,1000000"/);
  assert.match(panel, /<label for="prefill-position">Needle position \(%\)<\/label>/);
  assert.match(panel, /id="prefill-position"[^>]*min="0" max="100" value="90"/);
  assert.match(panel, /<label for="prefill-runs">Number of runs per size<\/label>/);
  assert.match(panel, /id="prefill-runs"[^>]*min="1" max="20" value="1"/);
  assert.match(panel, /id="prefill-require-server-tokens"[^>]*checked/);

  // No thinking toggle by design, and no accuracy matrix: the prefill curve
  // is the detail table sorted by input size.
  assert.doesNotMatch(panel, /prefill-disable-thinking/);
  assert.doesNotMatch(panel, /prefill-matrix/);
  assert.doesNotMatch(prefillSource, /disableThinking|enable_thinking|renderMatrix: true/);

  // Config: parsed sizes with fallback, one fixed position, runs per size.
  assert.match(prefillSource, /const DEFAULT_PREFILL_INPUT_TOKENS = \[10000, 50000, 100000, 250000, 500000, 1000000\];/);
  assert.match(prefillSource, /sizes\.length > 0 \? sizes : \[\.\.\.DEFAULT_PREFILL_INPUT_TOKENS\]/);
  assert.equal(
    (prefillSource.match(/DEFAULT_PREFILL_INPUT_TOKENS/g) ?? []).length,
    2,
    "DEFAULT_PREFILL_INPUT_TOKENS should appear only in its declaration and the empty-field fallback",
  );
  assert.match(prefillSource, /positionPercents: \[clampInteger\(prefillPositionInput\.value, 0, 100\)\]/);
  assert.match(prefillSource, /clampInteger\(prefillRunsInput\.value, 1, 20\)/);
  assert.match(prefillSource, /parseContextInputTokenOptions\(prefillSizesInput\?\.value\)/);
});

test("Prefill Test headline is the effective input rate across sizes", () => {
  const panel = html.slice(html.indexOf('id="prefill-test-panel"'));
  assert.match(panel, /What the Prefill Test measures/);
  assert.match(panel, /<strong>Effective input processing rate<\/strong>/);
  assert.match(panel, /watch how the rate holds \(or collapses\) as inputs grow/);
  assert.match(panel, /One row per model × input size · Warm-up excluded/);
  assert.match(panel, /<span>Best input rate<\/span><strong id="summary-prefill-best">/);
  // Methodology documents the fixed needle position and the rate formula.
  assert.match(panel, /needle position is fixed<\/strong> \(default 90%\)/);
  assert.match(panel, /= p50 input tokens ÷ p50 TTFT per size row - the headline metric/);
  // The template preview names every size and the fixed position.
  assert.match(prefillSource, /One request per input size: \$\{config\.inputTokenSizes\.map\(formatContextSize\)\.join\(", "\)\} with the needle at \$\{config\.positionPercents\[0\]\}%\./);
  // Oversized combinations are skipped without a request.
  assert.match(engineSource, /combo\.inputTokens > contextWindowTokens/);
  assert.match(engineSource, /return buildSkippedContextMeasurement\(combo\);/);
});
