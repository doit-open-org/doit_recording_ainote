function normalizeMindmapTitle(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function addMindmapTitle(markdown, value) {
  const content = String(markdown || "");
  const title = normalizeMindmapTitle(value);
  if (!title) return content;

  const heading = `# ${title}`;
  if (!content.trim()) return heading;

  const lines = content.split(/\r?\n/);
  const firstContentLine = lines.findIndex((line) => line.trim());
  if (/^#(?!#)(?:\s|$)/.test(lines[firstContentLine].trim())) {
    lines[firstContentLine] = heading;
  } else {
    lines.splice(firstContentLine, 0, heading, "");
  }
  return lines.join("\n");
}

module.exports = { addMindmapTitle, normalizeMindmapTitle };
