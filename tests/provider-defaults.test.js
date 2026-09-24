const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(projectRoot, "js", "presets.js"), "utf8");

function loadPresets() {
  const context = vm.createContext({});
  vm.runInContext(`${source}\nthis.__presets = {
    resolveTestRequestDefaults,
  };`, context);
  return context.__presets;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test("provider request defaults resolve per provider and test", () => {
  const { resolveTestRequestDefaults } = loadPresets();

  assert.deepEqual(
    plain(resolveTestRequestDefaults("speed", "nebius")),
    { temperature: 0, minTokens: 1024, maxTokens: 1024, disableThinking: true },
  );
  assert.deepEqual(
    plain(resolveTestRequestDefaults("speed", "custom")),
    { temperature: 0, minTokens: 1024, maxTokens: 1024, disableThinking: true },
  );
  assert.deepEqual(
    plain(resolveTestRequestDefaults("speed", "openai")),
    { temperature: null, minTokens: null, maxTokens: 1024, disableThinking: false },
  );
  assert.deepEqual(
    plain(resolveTestRequestDefaults("decode", "openai")),
    { temperature: null, disableThinking: false, fixedOutput: false },
  );
  assert.deepEqual(
    plain(resolveTestRequestDefaults("decode", "nebius")),
    { temperature: 0, disableThinking: true, fixedOutput: true },
  );
  assert.deepEqual(
    plain(resolveTestRequestDefaults("thinking", "nebius")),
    { temperature: 0, disableThinking: false },
  );
  assert.deepEqual(
    plain(resolveTestRequestDefaults("thinking", "custom")),
    { temperature: 0, disableThinking: false },
  );
  assert.deepEqual(
    plain(resolveTestRequestDefaults("thinking", "openai")),
    { temperature: null, disableThinking: false },
  );
  // The long-context tests expose only temperature, blank for OpenAI.
  assert.deepEqual(plain(resolveTestRequestDefaults("needle", "nebius")), { temperature: 0 });
  assert.deepEqual(plain(resolveTestRequestDefaults("needle", "openai")), { temperature: null });
  assert.deepEqual(plain(resolveTestRequestDefaults("prefill", "nebius")), { temperature: 0 });
  assert.deepEqual(plain(resolveTestRequestDefaults("prefill", "openai")), { temperature: null });
  assert.deepEqual(plain(resolveTestRequestDefaults("unknown", "openai")), {});
});
