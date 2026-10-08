function normalizeMacHex(value) {
  const hex = String(value || "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  return hex.length === 12 ? hex : "";
}

function reverseMacBytes(hex) {
  const pairs = String(hex || "").match(/.{2}/g);
  return pairs ? pairs.reverse().join("") : "";
}

function formatMac(hex) {
  return String(hex || "").match(/.{2}/g)?.join(":") || "";
}

function resolveAiM8Identity(deviceId, mac) {
  const rawDeviceId = String(deviceId || "");
  const legacyMatch = rawDeviceId.match(/^(.*)_([0-9a-f]{12})$/i);
  if (legacyMatch) {
    const actualMacHex = legacyMatch[2].toUpperCase();
    return {
      mac: formatMac(actualMacHex),
      persistentDeviceId: `${legacyMatch[1]}${reverseMacBytes(actualMacHex).toLowerCase()}`,
    };
  }
  return {
    mac: formatMac(normalizeMacHex(mac)),
    persistentDeviceId: rawDeviceId,
  };
}

module.exports = { normalizeMacHex, resolveAiM8Identity, reverseMacBytes };
