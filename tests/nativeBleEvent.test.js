const test = require("node:test");
const assert = require("node:assert/strict");
const { parseNativeBleMessage } = require("../src/utils/nativeBleEvent");

test("parses direct and wrapped native BLE messages", () => {
  assert.equal(parseNativeBleMessage({ type: 2200 }).type, 2200);
  assert.equal(
    parseNativeBleMessage({ msg: JSON.stringify({ type: 2007, data: {} }) }).type,
    2007
  );
  assert.equal(
    parseNativeBleMessage(JSON.stringify({ payload: { msg: '{"type":2205}' } })).type,
    2205
  );
});
