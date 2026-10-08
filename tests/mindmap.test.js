const test = require("node:test");
const assert = require("node:assert/strict");
const { addMindmapTitle } = require("../src/utils/mindmap");

test("prepends the result title as the mind-map root", () => {
  assert.equal(
    addMindmapTitle("## Topic\n- Detail", "Weekly meeting"),
    "# Weekly meeting\n\n## Topic\n- Detail"
  );
});

test("replaces an existing level-one heading", () => {
  assert.equal(
    addMindmapTitle("# Old title\n## Topic", "Generated title"),
    "# Generated title\n## Topic"
  );
});

test("keeps markdown unchanged when the result title is empty", () => {
  assert.equal(addMindmapTitle("# Existing", ""), "# Existing");
});

test("normalizes and limits the generated title", () => {
  const title = `  A\n  B ${"x".repeat(100)}  `;
  const heading = addMindmapTitle("", title);
  assert.equal(heading.slice(0, 6), "# A B ");
  assert.equal(heading.length, 82);
});
