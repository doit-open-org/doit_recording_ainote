const test = require("node:test");
const assert = require("node:assert/strict");
const {
  activeFiles,
  trashFiles,
  restoreFiles,
} = require("../src/utils/fileOrganization");

test("folders filter without removing files from all recordings", () => {
  const files = [{ fileName: "a" }, { fileName: "b" }];
  assert.deepEqual(activeFiles(files, {}, "meeting", { a: "meeting" }), [
    files[0],
  ]);
  assert.deepEqual(activeFiles(files), files);
});

test("trash hides files across all folders and preserves their metadata", () => {
  const files = [{ fileName: "a", size: 123 }, { fileName: "b" }];
  const trash = trashFiles({}, [files[0]]);
  assert.equal(trash.a.size, 123);
  assert.deepEqual(activeFiles(files, trash), [files[1]]);
  assert.deepEqual(activeFiles(files, restoreFiles(trash, ["a"])), files);
});

test("permanently removed local entries stay hidden until explicitly imported", () => {
  const files = [{ fileName: "recording" }];
  assert.deepEqual(activeFiles(files, {}, "all", {}, { recording: true }), []);
  assert.deepEqual(activeFiles(files, {}, "all", {}, {}), files);
});
