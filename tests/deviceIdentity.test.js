const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveAiM8Identity } = require("../src/utils/deviceIdentity");

test("converts a temporary Ai-M8 id to the host persistent convention", () => {
  assert.deepEqual(
    resolveAiM8Identity("Ai-M8_C8478C9ED55A", "5A:D5:9E:8C:47:C8"),
    {
      mac: "C8:47:8C:9E:D5:5A",
      persistentDeviceId: "Ai-M85ad59e8c47c8",
    }
  );
});

test("keeps an already canonical device identity stable", () => {
  assert.deepEqual(
    resolveAiM8Identity("Ai-M85ad59e8c47c8", "C8:47:8C:9E:D5:5A"),
    {
      mac: "C8:47:8C:9E:D5:5A",
      persistentDeviceId: "Ai-M85ad59e8c47c8",
    }
  );
});
