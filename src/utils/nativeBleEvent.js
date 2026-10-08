function parseJsonValue(value) {
  if (value && typeof value === "object") {
    return value;
  }
  try {
    return JSON.parse(String(value || ""));
  } catch (_) {
    return null;
  }
}

function parseNativeBleMessage(raw) {
  let message = parseJsonValue(raw);
  for (let depth = 0; depth < 3 && message; depth += 1) {
    if (message.type !== undefined && message.type !== null) {
      return message;
    }
    const wrapped =
      message.msg ??
      message.data?.msg ??
      message.payload?.msg ??
      message.payload;
    const next = parseJsonValue(wrapped);
    if (!next || next === message) {
      break;
    }
    message = next;
  }
  return message;
}

module.exports = { parseJsonValue, parseNativeBleMessage };
