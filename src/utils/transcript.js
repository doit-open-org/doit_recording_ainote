function extractTranscriptSegments(result, fallback = []) {
  const values =
    result?.asr?.segments ||
    result?.segments ||
    result?.transcript_segments ||
    result?.timeline_list ||
    result?.timelineList ||
    result?.transcript?.segments ||
    fallback;
  return Array.isArray(values) ? values : [];
}

module.exports = { extractTranscriptSegments };
