function activeFiles(
  files,
  trashed = {},
  folderId = "all",
  assignments = {},
  dismissed = {}
) {
  return files.filter((file) => {
    if (trashed[file.fileName] || dismissed[file.fileName]) return false;
    return folderId === "all" || assignments[file.fileName] === folderId;
  });
}

function trashFiles(trashed, files) {
  const next = { ...trashed };
  files.forEach((file) => {
    next[file.fileName] = { ...file, deletedAt: Date.now() };
  });
  return next;
}

function restoreFiles(trashed, names) {
  const next = { ...trashed };
  names.forEach((name) => delete next[name]);
  return next;
}

module.exports = { activeFiles, trashFiles, restoreFiles };
