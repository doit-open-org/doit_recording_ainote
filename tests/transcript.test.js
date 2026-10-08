const test = require("node:test");
const assert = require("node:assert/strict");
const { extractTranscriptSegments } = require("../src/utils/transcript");

test("extracts the backend ASR segment list", () => {
  const segments = [
    {
      seq: 1,
      speaker: "Manager",
      start_ms: 0,
      end_ms: 5100,
      text: "Weekly project update.",
    },
    {
      seq: 2,
      speaker: "Developer",
      start_ms: 5200,
      end_ms: 9800,
      text: "Development is nearly complete.",
    },
  ];
  assert.deepEqual(extractTranscriptSegments({ asr: { segments } }), segments);
});

test("keeps compatibility with previous segment fields", () => {
  const segments = [{ seq: 1, text: "Legacy result" }];
  assert.deepEqual(extractTranscriptSegments({ segments }), segments);
  assert.deepEqual(extractTranscriptSegments({}, segments), segments);
});

test("returns an empty list for malformed segment data", () => {
  assert.deepEqual(extractTranscriptSegments({ asr: { segments: null } }), []);
});
