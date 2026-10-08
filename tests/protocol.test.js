const test = require("node:test");
const assert = require("node:assert/strict");
const {
  COMMAND,
  buildFileDataRequest,
  buildRequest,
  bytesToHex,
  createControlFrameDecoder,
  parseControlFrame,
  parseDeviceInfo,
  parseFileRecord,
  parseWifiCredentials,
} = require("../src/utils/protocol");

test("builds confirmed Ai-M8 request frames", () => {
  assert.equal(bytesToHex(buildRequest(COMMAND.START_RECORDING)), "CAAC0400");
  assert.equal(bytesToHex(buildRequest(COMMAND.SET_ANC, [0x0f])), "CAAC0F010F");
  assert.equal(
    bytesToHex(buildFileDataRequest("20260915102115", 0x10000)),
    "CAAC0812323032363039313531303231313500010000",
  );
});

test("parses Ai-M8 Wi-Fi hotspot credentials", () => {
  assert.deepEqual(
    parseWifiCredentials(
      Uint8Array.from([0, ...Buffer.from("Ai-M8-1234,12345678")]),
    ),
    { ssid: "Ai-M8-1234", password: "12345678" },
  );
});

test("parses a captured file-list record", () => {
  const frame = parseControlFrame(
    "ACCA02180032303236303931353130323131350001B22D0000001B00",
  );
  assert.equal(frame.command, COMMAND.FILE_LIST);
  assert.deepEqual(parseFileRecord(frame.payload), {
    fileName: "20260915102115",
    size: 111149,
    duration: 27,
    fileType: 0,
  });
});

test("parses captured device information", () => {
  const frame = parseControlFrame(
    "ACCA01340077F7E00077F7C0004B000100060000010000000000000000000000000000000000000000020500000300000000000000000000",
  );
  const info = parseDeviceInfo(frame.payload);
  assert.equal(info.totalKb, 7862240);
  assert.equal(info.battery, 75);
  assert.equal(info.firmware, "v1.0.6");
  assert.equal(info.deviceMode, "1002");
  assert.equal(info.split, 3);
});

test("reassembles fragmented and consecutive control frames", () => {
  const decoder = createControlFrameDecoder();
  const deviceInfo =
    "ACCA01340077F7E00077F7C0004B000100060000010000000000000000000000000000000000000000020500000300000000000000000000";
  assert.deepEqual(decoder.push(deviceInfo.slice(0, 40)), []);
  assert.deepEqual(decoder.push(deviceInfo.slice(40, 80)), []);
  const frames = decoder.push(`${deviceInfo.slice(80)}ACCA040100`);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].command, COMMAND.DEVICE_INFO);
  assert.equal(frames[0].payload.length, 52);
  assert.equal(frames[1].command, COMMAND.START_RECORDING);
});

test("rejects malformed response headers and lengths", () => {
  assert.throws(() => parseControlFrame("CAAC0100"), /包头/);
  assert.throws(() => parseControlFrame("ACCA0102FF"), /不完整/);
});
