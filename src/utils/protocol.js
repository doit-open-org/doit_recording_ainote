const UUIDS = Object.freeze({
  service: "0000d0d0-0000-1000-8000-00805f9b34fb",
  write: "0000d0d1-0000-1000-8000-00805f9b34fb",
  control: "0000d0d3-0000-1000-8000-00805f9b34fb",
  offline: "0000d0d4-0000-1000-8000-00805f9b34fb",
});

const COMMAND = Object.freeze({
  DEVICE_INFO: 0x01,
  FILE_LIST: 0x02,
  SET_TIME: 0x03,
  START_RECORDING: 0x04,
  STOP_RECORDING: 0x05,
  PAUSE_RECORDING: 0x06,
  RESUME_RECORDING: 0x07,
  FILE_DATA: 0x08,
  STOP_FILE_DATA: 0x09,
  DELETE_FILE: 0x0a,
  RECORDING_INFO: 0x0d,
  SET_SPLIT: 0x0e,
  SET_ANC: 0x0f,
  SET_PHONE_TYPE: 0x10,
  DEVICE_STATUS: 0x44,
  WIFI_SWITCH: 0xf3,
});

const ANC_LEVELS = Object.freeze([
  { label: "关", value: 0x00 },
  { label: "低", value: 0x05 },
  { label: "中", value: 0x0a },
  { label: "高", value: 0x0f },
]);

const SPLIT_OPTIONS = Object.freeze([
  { label: "30分钟", value: 0x00 },
  { label: "1小时", value: 0x01 },
  { label: "2小时", value: 0x02 },
  { label: "3小时", value: 0x03 },
]);

function normalizeHex(value) {
  const hex = String(value || "")
    .replace(/[^0-9a-f]/gi, "")
    .toUpperCase();
  if (hex.length % 2 !== 0) {
    throw new Error("十六进制数据长度无效");
  }
  return hex;
}

function hexToBytes(value) {
  const hex = normalizeHex(value);
  const result = new Uint8Array(hex.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function bytesToHex(bytes) {
  return Array.from(bytes || [], (value) =>
    Number(value).toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase();
}

function concatBytes(...parts) {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  parts.forEach((part) => {
    result.set(part, offset);
    offset += part.length;
  });
  return result;
}

function writeUInt32BE(value) {
  const normalized = Number(value);
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 0 ||
    normalized > 0xffffffff
  ) {
    throw new Error("32位无符号整数越界");
  }
  return Uint8Array.from([
    (normalized >>> 24) & 0xff,
    (normalized >>> 16) & 0xff,
    (normalized >>> 8) & 0xff,
    normalized & 0xff,
  ]);
}

function readUInt32BE(bytes, offset = 0) {
  if (!bytes || offset < 0 || offset + 4 > bytes.length) {
    throw new Error("32位整数数据不足");
  }
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function asciiToBytes(value, expectedLength) {
  const text = String(value || "");
  if (expectedLength !== undefined && text.length !== expectedLength) {
    throw new Error(`字段必须为 ${expectedLength} 个 ASCII 字符`);
  }
  const bytes = Uint8Array.from(Array.from(text, (char) => char.charCodeAt(0)));
  if (Array.from(bytes).some((value) => value > 0x7f)) {
    throw new Error("字段必须使用 ASCII");
  }
  return bytes;
}

function bytesToAscii(bytes) {
  return String.fromCharCode(...Array.from(bytes || []));
}

function buildRequest(command, data = new Uint8Array()) {
  const payload = data instanceof Uint8Array ? data : Uint8Array.from(data);
  if (payload.length > 0xff) {
    throw new Error("请求数据超过单帧长度");
  }
  return concatBytes(
    Uint8Array.from([0xca, 0xac, command, payload.length]),
    payload,
  );
}

function parseControlFrame(value) {
  const bytes = value instanceof Uint8Array ? value : hexToBytes(value);
  if (bytes.length < 4) {
    throw new Error("控制帧长度不足");
  }
  if (bytes[0] !== 0xac || bytes[1] !== 0xca) {
    throw new Error("控制帧包头无效");
  }
  const length = bytes[3];
  if (bytes.length < 4 + length) {
    throw new Error("控制帧数据不完整");
  }
  return { command: bytes[2], payload: bytes.slice(4, 4 + length) };
}

function createControlFrameDecoder() {
  let buffer = "";

  return {
    push(value) {
      buffer += normalizeHex(value);
      const frames = [];

      while (buffer.length >= 2) {
        const headerIndex = buffer.indexOf("ACCA");
        if (headerIndex < 0) {
          buffer = buffer.endsWith("AC") ? "AC" : "";
          break;
        }
        if (headerIndex > 0) buffer = buffer.slice(headerIndex);
        if (buffer.length < 8) break;

        const payloadLength = Number.parseInt(buffer.slice(6, 8), 16);
        const frameLength = (4 + payloadLength) * 2;
        if (buffer.length < frameLength) break;

        frames.push(parseControlFrame(buffer.slice(0, frameLength)));
        buffer = buffer.slice(frameLength);
      }

      return frames;
    },
    reset() {
      buffer = "";
    },
  };
}

function parseFileRecord(payload) {
  if (!payload || payload.length < 24 || payload[0] !== 0) {
    return null;
  }
  const fileName = bytesToAscii(payload.slice(1, 15));
  return {
    fileName,
    size: readUInt32BE(payload, 15),
    duration: readUInt32BE(payload, 19),
    fileType: payload[23],
  };
}

function parseRecordingInfo(payload, command = COMMAND.RECORDING_INFO) {
  if (!payload || payload.length < 24) {
    return { state: 0, file: null };
  }
  const normalizedPayload = payload.slice();
  normalizedPayload[0] = 0;
  const file = parseFileRecord(normalizedPayload);
  const state =
    command === COMMAND.RECORDING_INFO
      ? payload[0] === 0
        ? 1
        : payload[0] === 2
          ? 2
          : 0
      : command === COMMAND.PAUSE_RECORDING
        ? 2
        : command === COMMAND.STOP_RECORDING
          ? 0
          : 1;
  return { state, file };
}

function parseDeviceInfo(payload) {
  if (!payload || payload.length < 52) {
    throw new Error("设备信息长度不足");
  }
  const modelBytes = payload.slice(17, 38);
  const modelSuffix = bytesToHex(modelBytes.slice(-2));
  return {
    totalKb: readUInt32BE(payload, 0),
    remainingKb: readUInt32BE(payload, 4),
    charging: payload[8] === 1,
    battery: payload[9],
    recordingState: payload[10],
    firmware: `v${payload[11]}.${payload[12]}.${payload[13]}`,
    usbEnabled: payload[14] === 1,
    recordingType: payload[15],
    lightsEnabled: payload[16] === 1,
    deviceMode: String(1000 + Number.parseInt(modelSuffix || "0", 10)),
    shutdownMinutes: payload[38],
    ancLevel: payload[39],
    voiceControl: payload[40] === 1,
    split: payload[41],
  };
}

function parseDeviceStatus(payload) {
  if (!payload || payload.length < 37) {
    throw new Error("设备状态长度不足");
  }
  return {
    charging: payload[0] === 1,
    battery: payload[1],
    recordingType: payload[3],
    ancLevel: payload[5],
    voiceControl: payload[6] === 1,
    split: payload[8],
    totalKb: readUInt32BE(payload, 9),
    remainingKb: readUInt32BE(payload, 13),
  };
}

function buildSetTimeRequest(date = new Date()) {
  return buildRequest(
    COMMAND.SET_TIME,
    Uint8Array.from([
      date.getFullYear() - 2000,
      date.getMonth() + 1,
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
      date.getSeconds(),
    ]),
  );
}

function buildFileDataRequest(fileName, seek = 0) {
  return buildRequest(
    COMMAND.FILE_DATA,
    concatBytes(asciiToBytes(fileName, 14), writeUInt32BE(seek)),
  );
}

function buildDeleteFileRequest(fileName) {
  return buildRequest(COMMAND.DELETE_FILE, asciiToBytes(fileName, 14));
}

function parseWifiCredentials(payload) {
  if (!payload?.length || payload[0] !== 0) {
    throw new Error("设备无法开启 Wi-Fi 快传");
  }
  const text = bytesToAscii(payload.slice(1)).replace(/\0+$/g, "");
  const separator = text.lastIndexOf(",");
  if (separator <= 0) throw new Error("设备返回的热点信息无效");
  const ssid = text.slice(0, separator).trim();
  const password = text.slice(separator + 1).trim();
  if (!ssid || password.length < 8) {
    throw new Error("设备返回的热点信息不完整");
  }
  return { ssid, password };
}

function parseQuery(query) {
  return String(query || "")
    .split("&")
    .reduce((result, pair) => {
      const separator = pair.indexOf("=");
      if (separator < 0) return result;
      const decode = (text) => {
        try {
          return decodeURIComponent(text.replace(/\+/g, " "));
        } catch (_) {
          return text;
        }
      };
      result[decode(pair.slice(0, separator))] = decode(
        pair.slice(separator + 1),
      );
      return result;
    }, {});
}

module.exports = {
  ANC_LEVELS,
  COMMAND,
  SPLIT_OPTIONS,
  UUIDS,
  asciiToBytes,
  buildDeleteFileRequest,
  buildFileDataRequest,
  buildRequest,
  buildSetTimeRequest,
  bytesToHex,
  concatBytes,
  createControlFrameDecoder,
  hexToBytes,
  normalizeHex,
  parseControlFrame,
  parseDeviceInfo,
  parseDeviceStatus,
  parseFileRecord,
  parseQuery,
  parseRecordingInfo,
  parseWifiCredentials,
  readUInt32BE,
  writeUInt32BE,
};
