import {
  DeviceEventEmitter,
  NativeEventEmitter,
  NativeModules,
  Platform,
} from "react-native";
import RNFS from "react-native-fs";
import NativeLocalStorage from "../../specs/NativeLocalStorage";
import {
  COMMAND,
  UUIDS,
  buildDeleteFileRequest,
  buildFileDataRequest,
  buildRequest,
  buildSetTimeRequest,
  bytesToHex,
  concatBytes,
  createControlFrameDecoder,
  hexToBytes,
  normalizeHex,
  parseDeviceInfo,
  parseDeviceStatus,
  parseFileRecord,
  parseRecordingInfo,
  parseWifiCredentials,
  readUInt32BE,
} from "../utils/protocol";
import { parseJsonValue, parseNativeBleMessage } from "../utils/nativeBleEvent";
import { resolveAiM8Identity } from "../utils/deviceIdentity";

const NATIVE_EVENT = "callJsRnBle";
const NATIVE_WIFI_EVENT = "callJsRnWifi";
const DEFAULT_MTU = 23;
const REQUESTED_MTU = 512;
const MIN_CONTROL_MTU = 59;
const MTU_TIMEOUT_MS = 4000;
const RESPONSE_TIMEOUT_MS = 6000;
const NOTIFY_SETTLE_MS = 900; // Android legacy bridge fallback only
const READY_TIMEOUT_MS = 6000;
const POLL_INTERVAL_MS = 150;
const DOWNLOAD_IDLE_TIMEOUT_MS = 12000;
const DOWNLOAD_FLUSH_BYTES = 48 * 1024;
const WIFI_CONNECT_TIMEOUT_MS = 35000;
const WIFI_RESPONSE_TIMEOUT_MS = 8000;
const WIFI_DOWNLOAD_FINISH_DELAY_MS = 700;
const PANEL_URL = "2026091513500001";
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function sameMac(left, right) {
  return (
    String(left || "")
      .replace(/[^0-9a-f]/gi, "")
      .toUpperCase() ===
    String(right || "")
      .replace(/[^0-9a-f]/gi, "")
      .toUpperCase()
  );
}

function sameUuid(left, right) {
  const normalize = (value) => {
    let uuid = String(value || "").toLowerCase();
    if (uuid.length === 4) uuid = `0000${uuid}`;
    if (uuid.length === 8) uuid += "-0000-1000-8000-00805f9b34fb";
    return uuid;
  };
  return normalize(left) === normalize(right);
}

function bytesToBase64(bytes) {
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset];
    const second = offset + 1 < bytes.length ? bytes[offset + 1] : 0;
    const third = offset + 2 < bytes.length ? bytes[offset + 2] : 0;
    const value = (first << 16) | (second << 8) | third;
    output += BASE64_ALPHABET[(value >>> 18) & 63];
    output += BASE64_ALPHABET[(value >>> 12) & 63];
    output +=
      offset + 1 < bytes.length ? BASE64_ALPHABET[(value >>> 6) & 63] : "=";
    output += offset + 2 < bytes.length ? BASE64_ALPHABET[value & 63] : "=";
  }
  return output;
}

function base64ToBytes(value) {
  const text = String(value || "").replace(/\s/g, "");
  if (!text) return new Uint8Array();
  const output = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    if (char === "=") break;
    const index = BASE64_ALPHABET.indexOf(char);
    if (index < 0) continue;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(output);
}

function createAiM8BleClient({
  mac,
  deviceId,
  connected = false,
  wifiHost,
  wifiPort,
}) {
  const identity = resolveAiM8Identity(deviceId, mac);
  mac = identity.mac || mac;
  // The Android launch flag may outlive the native GATT connection.
  let isConnected = Platform.OS === "android" ? false : Boolean(connected);
  let negotiatedMtu = DEFAULT_MTU;
  let subscription = null;
  let wifiSubscription = null;
  let nativeEmitter = null;
  let serial = 0;
  let waiters = [];
  let sessionVersion = 0;
  let lifecycleVersion = 0;
  let stopped = false;
  let preparedConnection = -1;
  let readySession = -1;
  let connectPromise = null;
  let prepareTask = null;
  let readyTask = null;
  let writeType = "withoutResponse";
  const nativeRequests = new Map();
  const notificationTasks = new Map();
  let writeRequests = new Map();
  let activeDownload = null;
  let wifiState = "idle";
  let wifiConnectedAt = 0;
  let wifiSessionId = "";
  let wifiInfo = null;
  let wifiControlBuffer = new Uint8Array();
  let wifiRequests = new Map();
  let wifiFrameWaiters = [];
  let operationQueue = Promise.resolve();
  const controlDecoder = createControlFrameDecoder();
  const connectionListeners = new Set();
  const controlListeners = new Set();
  const wifiStateListeners = new Set();
  const connectionTrace = [];
  let traceWrite = Promise.resolve();
  function traceConnection(event, details = {}) {
    connectionTrace.push({ time: new Date().toISOString(), event, ...details });
    if (connectionTrace.length > 60) connectionTrace.shift();
    const report = JSON.stringify(connectionTrace);
    traceWrite = traceWrite
      .catch(() => undefined)
      .then(() =>
        RNFS.writeFile(
          `${RNFS.DocumentDirectoryPath}/ainote-connection.json`,
          report,
          "utf8"
        )
      );
    traceWrite.catch(() => undefined);
  }

  function wait(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  function cancellationError() {
    const error = new Error("设备连接已改变，操作已取消");
    error.code = "BLE_SESSION_CHANGED";
    return error;
  }

  function assertLifecycle(version) {
    if (stopped || version !== lifecycleVersion) throw cancellationError();
  }

  function assertSession(version) {
    if (stopped || !isConnected || version !== sessionVersion)
      throw cancellationError();
  }

  async function waitInSession(delayMs, version) {
    await wait(delayMs);
    assertSession(version);
  }

  function sendNative(type, data) {
    if (!NativeLocalStorage?.sendThirdBleData) {
      throw new Error("宿主 App 未注册第三方蓝牙接口");
    }
    const promise = Promise.resolve(
      NativeLocalStorage.sendThirdBleData(
        JSON.stringify({ type, device_id: deviceId, data })
      )
    ).then((result) => {
      const parsed = parseJsonValue(result);
      if (parsed?.ret === "0" || parsed?.ret === 0 || parsed?.ret === false) {
        throw new Error(`宿主未处理蓝牙请求 ${type}`);
      }
      return result;
    });
    // Some legacy fire-and-forget callers do not await the bridge Promise.
    promise.catch((error) =>
      traceConnection("native-error", { type, message: error.message })
    );
    return promise;
  }

  function nativeRequest(
    type,
    data,
    responseTypes,
    timeoutMs,
    label,
    version = null,
    uncorrelated = false
  ) {
    const requestId = `ainote-native-${Date.now()}-${++serial}`;
    if ([1007, 1009, 1008].includes(type))
      traceConnection("ble-request", { type, requestId });
    return new Promise((resolve, reject) => {
      const finish = (error, message) => {
        const pending = nativeRequests.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        nativeRequests.delete(requestId);
        if ([1007, 1009, 1008].includes(type))
          traceConnection("ble-request-result", {
            type,
            requestId,
            responseType: message?.type,
            error: error?.message,
          });
        error ? reject(error) : resolve(message);
      };
      const timer = setTimeout(() => finish(new Error(label)), timeoutMs);
      nativeRequests.set(requestId, {
        responseTypes,
        version,
        uncorrelated,
        timer,
        finish,
      });
      try {
        sendNative(type, { ...data, requestId }).catch((error) =>
          finish(error)
        );
      } catch (error) {
        finish(error);
      }
    });
  }

  function rejectNativeRequests(error, all = false) {
    for (const pending of Array.from(nativeRequests.values())) {
      if (all || pending.version !== null) pending.finish(error);
    }
  }

  function settleNativeRequests(message, data) {
    for (const [requestId, pending] of Array.from(nativeRequests)) {
      if (!pending.responseTypes.includes(Number(message.type))) continue;
      if (Number(message.type) === 2007 && Number(data.connectStatus) === 3)
        continue;
      const legacyInfo = Number(message.type) === 2010 && !data.requestId;
      if (
        !pending.uncorrelated &&
        Platform.OS === "ios" &&
        data.requestId !== requestId &&
        !legacyInfo
      )
        continue;
      if (pending.version !== null && pending.version !== sessionVersion)
        continue;
      pending.finish(null, { type: Number(message.type), data });
    }
  }

  function invalidateBleSession(error) {
    sessionVersion += 1;
    preparedConnection = -1;
    readySession = -1;
    readyTask = null;
    notificationTasks.clear();
    negotiatedMtu = DEFAULT_MTU;
    controlDecoder.reset();
    rejectWaiters(error);
    rejectNativeRequests(error);
    for (const pending of writeRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    writeRequests.clear();
    operationQueue = Promise.resolve();
    if (activeDownload?.transport !== "wifi") failDownload(error);
  }

  async function getServices(version, timeoutMs = MTU_TIMEOUT_MS) {
    assertSession(version);
    const result = await nativeRequest(
      1004,
      { mac },
      [2009],
      timeoutMs,
      "查询蓝牙服务超时",
      version
    );
    assertSession(version);
    return Array.isArray(result.data.services) ? result.data.services : [];
  }

  function findCharacteristic(services, uuid) {
    const service = services.find((item) => sameUuid(item.uuid, UUIDS.service));
    return service?.chacs?.find((item) => sameUuid(item.uuid, uuid));
  }

  async function discoverControlCharacteristics(version) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const services = await getServices(
        version,
        Math.max(1, Math.min(MTU_TIMEOUT_MS, deadline - Date.now()))
      );
      const writer = findCharacteristic(services, UUIDS.write);
      const control = findCharacteristic(services, UUIDS.control);
      if (writer && control) {
        const properties = Number(writer.properties);
        if (properties & 0x04) writeType = "withoutResponse";
        else if (properties & 0x08) writeType = "withResponse";
        else throw new Error("设备控制特征值不支持写入");
        if (!(Number(control.properties) & 0x30))
          throw new Error("设备控制特征值不支持通知");
        return;
      }
      await waitInSession(POLL_INTERVAL_MS, version);
    }
    const error = new Error("设备服务或控制特征值发现超时");
    error.code = "BLE_DISCOVERY_TIMEOUT";
    throw error;
  }

  function ensureReady(version = sessionVersion) {
    assertSession(version);
    if (readySession === version) return Promise.resolve();
    if (readyTask?.version === version) return readyTask.promise;
    const task = { version, promise: null };
    task.promise = (async () => {
      await discoverControlCharacteristics(version);
      const mtu = await requestMtu(version);
      assertSession(version);
      if (mtu < MIN_CONTROL_MTU)
        throw new Error(`蓝牙 MTU 过小（${mtu}），无法读取完整设备信息`);
      await enableNotification(UUIDS.control, version);
      assertSession(version);
      readySession = version;
      traceConnection("ble-ready", { version, mtu, writeType });
    })().finally(() => {
      if (readyTask === task) readyTask = null;
    });
    readyTask = task;
    return task.promise;
  }

  function setWifiState(state, details = {}) {
    traceConnection("wifi-state", { state, message: details.message });
    wifiState = state;
    wifiStateListeners.forEach((listener) =>
      listener({ state, sessionId: wifiSessionId, ...details })
    );
  }

  function waitForWifiRequest(requestId, timeoutMs, timeoutText) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        wifiRequests.delete(requestId);
        reject(new Error(timeoutText));
      }, timeoutMs);
      wifiRequests.set(requestId, { resolve, reject, timer });
    });
  }

  function sendWifiNative(type, data, timeoutMs, timeoutText) {
    const requestId = data.requestId || `ainote-wifi-${Date.now()}-${++serial}`;
    const reply = waitForWifiRequest(requestId, timeoutMs, timeoutText);
    try {
      sendNative(type, { ...data, requestId }).catch((error) => {
        const pending = wifiRequests.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        wifiRequests.delete(requestId);
        pending.reject(error);
      });
    } catch (error) {
      const pending = wifiRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        wifiRequests.delete(requestId);
        pending.reject(error);
      }
    }
    return reply;
  }

  function rejectWifiRequests(error) {
    const pending = Array.from(wifiRequests.values());
    wifiRequests.clear();
    pending.forEach((request) => {
      clearTimeout(request.timer);
      request.reject(error);
    });
  }

  function persistDevice({
    deviceName,
    pid,
    bindTimestamp = Math.floor(Date.now() / 1000),
  }) {
    if (!mac || !deviceId || !pid) {
      console.warn(
        "[AiNotePanel] skip device persistence: missing launch parameters",
        {
          hasMac: Boolean(mac),
          hasDeviceId: Boolean(deviceId),
          hasPid: Boolean(pid),
        }
      );
      return null;
    }
    return sendNative(1012, {
      bindTimestamp: String(bindTimestamp),
      deviceId: identity.persistentDeviceId,
      deviceName: String(deviceName || "Ai-M8"),
      mac,
      mpaasUrl: PANEL_URL,
      pid: String(pid),
    });
  }

  function emitConnection(next) {
    const value = Boolean(next);
    if (isConnected === value) return;
    isConnected = value;
    traceConnection("ble-state", { connected: value });
    if (!value) invalidateBleSession(cancellationError());
    connectionListeners.forEach((listener) => listener(value));
  }

  function settleWaiters(frame) {
    waiters = waiters.filter((waiter) => {
      if (!waiter.predicate(frame)) return true;
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return false;
    });
  }

  function rejectWaiters(error) {
    const pending = waiters;
    waiters = [];
    pending.forEach((waiter) => {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    });
  }

  async function requestMtu(version = sessionVersion) {
    assertSession(version);
    if (negotiatedMtu >= MIN_CONTROL_MTU) return negotiatedMtu;
    const result = await nativeRequest(
      1006,
      { mac, size: REQUESTED_MTU },
      [2205],
      MTU_TIMEOUT_MS,
      "蓝牙 MTU 协商超时",
      version
    );
    assertSession(version);
    negotiatedMtu = Number(result.data.mtu) || DEFAULT_MTU;
    return negotiatedMtu;
  }

  function waitForControl(
    predicate,
    timeoutMs = RESPONSE_TIMEOUT_MS,
    timeoutText = "等待设备响应超时"
  ) {
    let waiter;
    const promise = new Promise((resolve, reject) => {
      waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        waiters = waiters.filter((item) => item !== waiter);
        const error = new Error(timeoutText);
        error.code = "BLE_RESPONSE_TIMEOUT";
        reject(error);
      }, timeoutMs);
      waiters.push(waiter);
    });
    promise.cancel = (error) => {
      if (!waiters.includes(waiter)) return;
      clearTimeout(waiter.timer);
      waiters = waiters.filter((item) => item !== waiter);
      waiter.reject(error);
    };
    promise.catch(() => undefined);
    return promise;
  }

  async function exchange(frame, predicate, label, version = sessionVersion) {
    await ensureReady(version);
    assertSession(version);
    const reply = waitForControl(predicate, RESPONSE_TIMEOUT_MS, label);
    try {
      const [, response] = await Promise.all([
        sendFrame(frame, version),
        reply,
      ]);
      assertSession(version);
      return response;
    } catch (error) {
      reply.cancel(error);
      throw error;
    }
  }

  function flushDownload() {
    const task = activeDownload;
    if (!task || !task.bufferHex) return;
    const hex = task.bufferHex;
    task.bufferHex = "";
    task.bufferedBytes = 0;
    task.writeChain = task.writeChain.then(() =>
      RNFS.appendFile(task.tempPath, bytesToBase64(hexToBytes(hex)), "base64")
    );
  }

  function armDownloadTimeout() {
    const task = activeDownload;
    if (!task) return;
    clearTimeout(task.timer);
    task.timer = setTimeout(() => {
      if (task.transport === "wifi") {
        const phase = task.wifiPhase === "start" ? "等待开始包" : "接收文件";
        const progress = `${task.received}/${task.expectedSize}`;
        const probe = task.wifiProbeHex
          ? `，首包 ${task.wifiProbeHex}`
          : "，未收到数据";
        failDownload(new Error(`Wi-Fi ${phase}超时（${progress}${probe}）`));
        return;
      }
      failDownload(new Error("文件数据接收超时"));
    }, DOWNLOAD_IDLE_TIMEOUT_MS);
  }

  function receiveFileData(pkg) {
    const task = activeDownload;
    if (!task) return;
    const hex = normalizeHex(pkg);
    if (!hex) return;
    const bytes = hex.length / 2;
    if (task.expectedSize && task.received + bytes > task.expectedSize) {
      failDownload(new Error("设备返回的文件数据超过声明大小"));
      return;
    }
    task.bufferHex += hex;
    task.bufferedBytes += bytes;
    task.received += bytes;
    if (task.bufferedBytes >= DOWNLOAD_FLUSH_BYTES) flushDownload();
    task.onProgress?.({
      received: task.received,
      total: task.expectedSize,
      progress: task.expectedSize
        ? Math.min(99, Math.round((task.received / task.expectedSize) * 100))
        : 0,
    });
    armDownloadTimeout();
  }

  async function finishDownload() {
    const task = activeDownload;
    if (!task || task.finishing) return;
    task.finishing = true;
    clearTimeout(task.timer);
    clearTimeout(task.completionTimer);
    flushDownload();
    try {
      await task.writeChain;
      if (!task.expectedSize || task.received !== task.expectedSize) {
        throw new Error(
          `文件大小不一致：${task.received}/${task.expectedSize}`
        );
      }
      if (await RNFS.exists(task.finalPath)) await RNFS.unlink(task.finalPath);
      await RNFS.moveFile(task.tempPath, task.finalPath);
      activeDownload = null;
      task.onProgress?.({
        received: task.received,
        total: task.expectedSize,
        progress: 100,
      });
      task.resolve({ path: task.finalPath, size: task.received });
    } catch (error) {
      activeDownload = null;
      task.reject(error);
    }
  }

  function failDownload(error) {
    const task = activeDownload;
    if (!task) return;
    activeDownload = null;
    clearTimeout(task.timer);
    clearTimeout(task.completionTimer);
    if (task.tempPath) {
      void RNFS.exists(task.tempPath)
        .then((exists) => (exists ? RNFS.unlink(task.tempPath) : undefined))
        .catch(() => undefined);
    }
    task.reject(error);
  }

  function handleControl(pkg) {
    let frames;
    try {
      frames = controlDecoder.push(pkg);
    } catch (_) {
      return;
    }
    frames.forEach((frame) => {
      for (const [sn, pending] of writeRequests) {
        if (
          pending.version !== sessionVersion ||
          pending.command !== frame.command
        )
          continue;
        clearTimeout(pending.timer);
        writeRequests.delete(sn);
        pending.resolve();
      }
      settleWaiters(frame);
      controlListeners.forEach((listener) => listener(frame));
      if (
        activeDownload &&
        frame.command === COMMAND.FILE_DATA &&
        frame.payload.length === 1 &&
        frame.payload[0] === 2
      ) {
        void finishDownload();
      }
    });
  }

  function settleWifiFrameWaiters(frame) {
    wifiFrameWaiters = wifiFrameWaiters.filter((waiter) => {
      if (!waiter.predicate(frame)) return true;
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return false;
    });
  }

  function waitForWifiFrame(predicate, timeoutText) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        wifiFrameWaiters = wifiFrameWaiters.filter((item) => item !== waiter);
        reject(new Error(timeoutText));
      }, WIFI_RESPONSE_TIMEOUT_MS);
      wifiFrameWaiters.push(waiter);
    });
  }

  function rejectWifiFrameWaiters(error) {
    const pending = wifiFrameWaiters;
    wifiFrameWaiters = [];
    pending.forEach((waiter) => {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    });
  }

  function handleWifiControlBytes(bytes) {
    wifiControlBuffer = concatBytes(wifiControlBuffer, bytes);
    while (wifiControlBuffer.length >= 4) {
      let header = -1;
      for (let index = 0; index + 2 < wifiControlBuffer.length; index += 1) {
        if (
          ((wifiControlBuffer[index] === 0xca &&
            wifiControlBuffer[index + 1] === 0xac) ||
            (wifiControlBuffer[index] === 0xac &&
              wifiControlBuffer[index + 1] === 0xca)) &&
          [COMMAND.FILE_DATA, COMMAND.DELETE_FILE].includes(
            wifiControlBuffer[index + 2]
          )
        ) {
          header = index;
          break;
        }
      }
      if (header < 0) {
        wifiControlBuffer = new Uint8Array();
        return;
      }
      if (header > 0) wifiControlBuffer = wifiControlBuffer.slice(header);
      if (wifiControlBuffer.length < 4) return;
      const frameLength = 4 + wifiControlBuffer[3];
      if (wifiControlBuffer.length < frameLength) return;
      const frame = {
        command: wifiControlBuffer[2],
        payload: wifiControlBuffer.slice(4, frameLength),
      };
      wifiControlBuffer = wifiControlBuffer.slice(frameLength);
      settleWifiFrameWaiters(frame);
    }
  }

  function scheduleWifiDownloadFinish(task) {
    clearTimeout(task.completionTimer);
    task.completionTimer = setTimeout(() => {
      if (activeDownload === task) void finishDownload();
    }, WIFI_DOWNLOAD_FINISH_DELAY_MS);
  }

  function handleWifiDownloadBytes(task, incoming) {
    if (task.wifiProbeHex.length < 96) {
      task.wifiProbeHex = `${task.wifiProbeHex}${bytesToHex(incoming)}`.slice(
        0,
        96
      );
    }
    task.wifiBuffer = concatBytes(task.wifiBuffer, incoming);
    while (activeDownload === task && task.wifiBuffer.length) {
      if (task.wifiPhase === "start") {
        if (task.wifiBuffer.length < 3) return;
        let header = -1;
        for (let index = 0; index + 2 < task.wifiBuffer.length; index += 1) {
          if (
            ((task.wifiBuffer[index] === 0xca &&
              task.wifiBuffer[index + 1] === 0xac) ||
              (task.wifiBuffer[index] === 0xac &&
                task.wifiBuffer[index + 1] === 0xca)) &&
            task.wifiBuffer[index + 2] === COMMAND.FILE_DATA
          ) {
            header = index;
            break;
          }
        }
        if (header < 0) {
          console.log(
            "[AiNotePanel] waiting for Wi-Fi download header",
            bytesToHex(task.wifiBuffer.slice(0, 24))
          );
          task.wifiBuffer = task.wifiBuffer.slice(
            Math.max(0, task.wifiBuffer.length - 2)
          );
          return;
        }
        if (header > 0) {
          console.log(
            "[AiNotePanel] ignored bytes before Wi-Fi download header",
            bytesToHex(task.wifiBuffer.slice(0, Math.min(header, 24)))
          );
          task.wifiBuffer = task.wifiBuffer.slice(header);
        }
        if (task.wifiBuffer.length < 4) return;
        const packetLength = 4 + task.wifiBuffer[3];
        if (task.wifiBuffer.length < packetLength) return;
        const packet = task.wifiBuffer.slice(0, packetLength);
        task.wifiBuffer = task.wifiBuffer.slice(packetLength);
        const standardResponse = packet[0] === 0xac && packet[1] === 0xca;
        let declaredSize = 0;
        if (standardResponse) {
          if (packet[3] !== 5 || packet.length < 9 || packet[4] !== 0) {
            failDownload(
              new Error(
                `设备拒绝通过 Wi-Fi 发送这条录音（${packet[4] ?? "未知"}）`
              )
            );
            return;
          }
          declaredSize = readUInt32BE(packet, 5);
        } else {
          if (packet[3] !== 6 || packet.length < 10) {
            failDownload(new Error("设备拒绝通过 Wi-Fi 发送这条录音"));
            return;
          }
          declaredSize = readUInt32BE(packet, 6);
        }
        if (!declaredSize || declaredSize !== task.expectedSize) {
          failDownload(
            new Error(
              `Wi-Fi 文件大小不一致：${declaredSize}/${task.expectedSize}`
            )
          );
          return;
        }
        task.wifiPhase = "data";
        console.log("[AiNotePanel] Wi-Fi start", { size: declaredSize });
        armDownloadTimeout();
        continue;
      }

      if (task.wifiPhase === "data") {
        const remaining = task.expectedSize - task.received;
        if (remaining <= 0) {
          task.wifiPhase = "end";
          scheduleWifiDownloadFinish(task);
          continue;
        }
        const count = Math.min(remaining, task.wifiBuffer.length);
        const chunk = task.wifiBuffer.slice(0, count);
        task.wifiBuffer = task.wifiBuffer.slice(count);
        receiveFileData(bytesToHex(chunk));
        if (task.received === task.expectedSize) {
          task.wifiPhase = "end";
          scheduleWifiDownloadFinish(task);
        }
        continue;
      }

      if (task.wifiPhase === "end") {
        if (task.wifiBuffer.length < 5) return;
        if (
          task.wifiBuffer[0] === 0xac &&
          task.wifiBuffer[1] === 0xca &&
          task.wifiBuffer[2] === COMMAND.FILE_DATA &&
          task.wifiBuffer[3] === 1 &&
          task.wifiBuffer[4] === 2
        ) {
          task.wifiBuffer = task.wifiBuffer.slice(5);
          void finishDownload();
          return;
        }
        if (task.wifiBuffer.length < 6) return;
        if (
          task.wifiBuffer[0] === 0xca &&
          task.wifiBuffer[1] === 0xac &&
          task.wifiBuffer[2] === COMMAND.FILE_DATA &&
          task.wifiBuffer[3] === 2 &&
          task.wifiBuffer[4] === 2 &&
          task.wifiBuffer[5] === 0
        ) {
          task.wifiBuffer = task.wifiBuffer.slice(6);
          void finishDownload();
          return;
        }
        task.wifiBuffer = task.wifiBuffer.slice(1);
      }
    }
  }

  function handleWifiBytes(bytes) {
    const task = activeDownload;
    if (task?.transport === "wifi") {
      handleWifiDownloadBytes(task, bytes);
      return;
    }
    handleWifiControlBytes(bytes);
  }

  function handleNativeWifiEvent(raw) {
    const message = parseNativeBleMessage(raw);
    const data = parseJsonValue(message?.data) || {};
    if (!message || Number(message.type) !== 2512) return;
    const state = String(data.state || "");
    const requestId = String(data.requestId || "");
    if (state !== "data")
      traceConnection("native-wifi", {
        state,
        requestId,
        sessionId: data.sessionId,
        code: data.code,
        message: data.message,
      });
    if (data.sessionId) wifiSessionId = String(data.sessionId);

    if (state === "data") {
      handleWifiBytes(base64ToBytes(data.base64));
      return;
    }
    if (state === "wifiConnecting" || state === "wifiConnected") {
      setWifiState("connecting", { nativeState: state });
    } else if (state === "tcpConnecting") {
      setWifiState("connecting", { nativeState: state });
    } else if (state === "tcpConnected") {
      wifiConnectedAt = Date.now();
      setWifiState("ready", { nativeState: state, ...wifiInfo });
    } else if (state === "closed") {
      wifiSessionId = "";
      setWifiState("idle");
      rejectWifiFrameWaiters(new Error("Wi-Fi 快传已关闭"));
      if (activeDownload?.transport === "wifi") {
        failDownload(new Error("Wi-Fi 快传已关闭"));
      }
    } else if (state === "error") {
      const error = new Error(data.message || "Wi-Fi 快传连接失败");
      wifiSessionId = "";
      setWifiState("error", { code: data.code, message: error.message });
      rejectWifiFrameWaiters(error);
      if (activeDownload?.transport === "wifi") failDownload(error);
    }

    if (requestId) {
      const pending = wifiRequests.get(requestId);
      if (
        pending &&
        ["tcpConnected", "writeComplete", "closed", "error"].includes(state)
      ) {
        clearTimeout(pending.timer);
        wifiRequests.delete(requestId);
        state === "error"
          ? pending.reject(new Error(data.message || "Wi-Fi 操作失败"))
          : pending.resolve(data);
      }
    }
  }

  function handleNativeEvent(raw) {
    if (stopped) return;
    const message = parseNativeBleMessage(raw);
    const data = parseJsonValue(message?.data) || {};
    const eventMac = data.mac || data.macAddress;
    if ([2007, 2010, 2012].includes(Number(message?.type)))
      traceConnection("ble-event", {
        type: Number(message.type),
        connectStatus: data.connectStatus,
        macMatches: !eventMac || !mac || sameMac(eventMac, mac),
      });
    if (!message || (eventMac && mac && !sameMac(eventMac, mac))) return;
    const type = Number(message.type);
    // Ignore late replies to queries from a previous connection or closed page.
    if (
      [2010, 2009, 2205].includes(type) &&
      data.requestId &&
      !nativeRequests.has(String(data.requestId))
    )
      return;
    if (type === 2007 || type === 2010) {
      emitConnection(Number(data.connectStatus) === 1);
      settleNativeRequests(message, data);
      return;
    }
    if (type === 2012) {
      emitConnection(false);
      settleNativeRequests(message, data);
      return;
    }
    settleNativeRequests(message, data);
    if (type === 2203 && data.sn) {
      const pending = writeRequests.get(String(data.sn));
      if (pending) {
        clearTimeout(pending.timer);
        writeRequests.delete(String(data.sn));
        Number(data.status) === 1
          ? pending.resolve()
          : pending.reject(new Error("蓝牙指令发送失败"));
      }
      return;
    }
    if (type !== 2200 || !isConnected) return;
    if (data.serviceUuid && !sameUuid(data.serviceUuid, UUIDS.service)) return;
    if (sameUuid(data.chacUuid, UUIDS.control)) handleControl(data.pkg);
    if (sameUuid(data.chacUuid, UUIDS.offline)) receiveFileData(data.pkg);
  }

  function enableNotification(
    notifyUuid,
    version = sessionVersion,
    force = false
  ) {
    assertSession(version);
    const key = String(notifyUuid).toLowerCase();
    const existing = notificationTasks.get(key);
    if (!force && existing?.version === version) return existing.promise;
    const task = { version, promise: null };
    task.promise = (async () => {
      const subscription = sendNative(1003, {
        mac,
        serviceUuid: UUIDS.service,
        notifyUuid,
        enable: true,
      });
      // Android's legacy bridge dispatches this request but never settles its Promise.
      if (Platform.OS === "ios") await subscription;
      assertSession(version);
      if (Platform.OS !== "ios") {
        await waitInSession(NOTIFY_SETTLE_MS, version);
        return;
      }
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const services = await getServices(
          version,
          Math.max(1, Math.min(MTU_TIMEOUT_MS, deadline - Date.now()))
        );
        const characteristic = findCharacteristic(services, notifyUuid);
        if (characteristic && characteristic.isNotifying === undefined)
          throw new Error("宿主 App 尚不支持查询通知订阅状态，请更新 App");
        if (characteristic && Number(characteristic.isNotifying) === 1) {
          traceConnection("notify-ready", { uuid: notifyUuid, version });
          return;
        }
        await waitInSession(POLL_INTERVAL_MS, version);
      }
      const error = new Error(
        `设备通知订阅超时（${
          sameUuid(notifyUuid, UUIDS.control) ? "控制通道" : "文件通道"
        }）`
      );
      error.code = "BLE_NOTIFY_TIMEOUT";
      throw error;
    })().catch((error) => {
      if (notificationTasks.get(key) === task) notificationTasks.delete(key);
      throw error;
    });
    notificationTasks.set(key, task);
    return task.promise;
  }

  function start() {
    stopped = false;
    if (!subscription) {
      const eventModule = NativeModules?.NativeEventSendModule;
      if (Platform.OS === "ios" && eventModule) {
        eventModule.myInit?.();
        nativeEmitter = new NativeEventEmitter(eventModule);
        subscription = nativeEmitter.addListener(
          NATIVE_EVENT,
          handleNativeEvent
        );
        wifiSubscription = nativeEmitter.addListener(
          NATIVE_WIFI_EVENT,
          handleNativeWifiEvent
        );
      } else {
        subscription = DeviceEventEmitter.addListener(
          NATIVE_EVENT,
          handleNativeEvent
        );
        wifiSubscription = DeviceEventEmitter.addListener(
          NATIVE_WIFI_EVENT,
          handleNativeWifiEvent
        );
      }
    }
  }

  function stop() {
    traceConnection("panel-stop", { sessionId: wifiSessionId });
    if (wifiSessionId) {
      try {
        sendNative(1514, {
          requestId: `ainote-wifi-close-${Date.now()}`,
          sessionId: wifiSessionId,
          removeWifi: true,
        });
      } catch (_) {}
    }
    subscription?.remove();
    wifiSubscription?.remove();
    subscription = null;
    wifiSubscription = null;
    nativeEmitter = null;
    stopped = true;
    lifecycleVersion += 1;
    isConnected = false;
    invalidateBleSession(cancellationError());
    rejectNativeRequests(cancellationError(), true);
    connectPromise = null;
    prepareTask = null;
    writeRequests.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(new Error("页面已关闭"));
    });
    writeRequests.clear();
    controlDecoder.reset();
    wifiControlBuffer = new Uint8Array();
    rejectWifiRequests(new Error("页面已关闭"));
    rejectWifiFrameWaiters(new Error("页面已关闭"));
    failDownload(new Error("页面已关闭"));
  }

  async function queryConnectionState() {
    const lifecycle = lifecycleVersion;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!stopped && Date.now() < deadline) {
      const result = await nativeRequest(
        1007,
        { mac },
        [2010],
        Math.max(1, Math.min(MTU_TIMEOUT_MS, deadline - Date.now())),
        "查询设备连接状态超时"
      );
      assertLifecycle(lifecycle);
      if (Number(result.data.peripheralState) !== 3) return result;
      await wait(POLL_INTERVAL_MS);
    }
    if (stopped) throw cancellationError();
    throw new Error("设备断开连接尚未完成");
  }

  async function reconnectForPreparation() {
    const lifecycle = lifecycleVersion;
    assertLifecycle(lifecycle);
    traceConnection("ble-prepare-reconnect", {});
    if (Platform.OS === "ios") {
      await sendNative(1008, { mac });
    } else {
      const disconnected = await nativeRequest(
        1008,
        { mac },
        [2007],
        RESPONSE_TIMEOUT_MS,
        "断开旧蓝牙连接超时",
        null,
        true
      );
      if (Number(disconnected.data.connectStatus) !== 2)
        throw new Error("设备蓝牙连接尚未断开");
    }
    if (stopped) throw cancellationError();
    const state = await queryConnectionState();
    assertLifecycle(lifecycle);
    if (
      Platform.OS === "ios"
        ? Number(state.data.peripheralState) !== 0
        : Number(state.data.connectStatus) !== 2
    )
      throw new Error("设备连接未断开，无法重新准备蓝牙服务");
    await connect();
  }

  function connect() {
    if (!mac) return Promise.reject(new Error("宿主 App 未提供设备 MAC"));
    if (connectPromise) return connectPromise;
    if (!stopped && isConnected && preparedConnection === sessionVersion)
      return Promise.resolve();
    start();
    const lifecycle = lifecycleVersion;
    const task = (async () => {
      if (Platform.OS === "ios") {
        await queryConnectionState();
        assertLifecycle(lifecycle);
      } else {
        if (isConnected) {
          preparedConnection = sessionVersion;
          return;
        }
        try {
          const status = await nativeRequest(
            1007,
            { mac },
            [2010],
            MTU_TIMEOUT_MS,
            "查询设备连接状态超时"
          );
          assertLifecycle(lifecycle);
          if (Number(status.data.connectStatus) === 1) {
            preparedConnection = sessionVersion;
            return;
          }
        } catch (error) {
          assertLifecycle(lifecycle);
          traceConnection("ble-state-query-failed", { message: error.message });
        }
      }
      const result = await nativeRequest(
        1009,
        { mac, timeout: 10000, prepare: true },
        [2007, 2012],
        12000,
        "连接设备超时",
        null,
        true
      );
      if (result.type === 2012 || Number(result.data.connectStatus) !== 1)
        throw new Error("设备蓝牙连接失败");
      assertLifecycle(lifecycle);
      if (!isConnected) throw cancellationError();
      preparedConnection = sessionVersion;
    })().finally(() => {
      if (connectPromise === task) connectPromise = null;
    });
    connectPromise = task;
    return task;
  }

  function sendFrame(frame, version = sessionVersion) {
    assertSession(version);
    const sn = `ainote-${Date.now()}-${++serial}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        writeRequests.delete(sn);
        reject(new Error("蓝牙写入超时"));
      }, RESPONSE_TIMEOUT_MS);
      writeRequests.set(sn, {
        resolve,
        reject,
        timer,
        command: frame[2],
        version,
      });
      try {
        sendNative(1000, {
          mac,
          serviceUuid: UUIDS.service,
          chacUuid: UUIDS.write,
          pkgs: [bytesToHex(frame)],
          sn,
          mtu: negotiatedMtu,
          timeout: RESPONSE_TIMEOUT_MS,
          needFaq: true,
          fastMode: false,
          ...(Platform.OS === "ios" ? { writeType, autoNotify: false } : {}),
        }).catch((error) => {
          const pending = writeRequests.get(sn);
          if (!pending) return;
          clearTimeout(pending.timer);
          writeRequests.delete(sn);
          pending.reject(error);
        });
      } catch (error) {
        clearTimeout(timer);
        writeRequests.delete(sn);
        reject(error);
      }
    });
  }

  function enqueue(operation, requiresBle = true) {
    const version = sessionVersion;
    const next = operationQueue
      .catch(() => undefined)
      .then(() => {
        if (requiresBle) assertSession(version);
        else if (stopped) throw cancellationError();
        return operation(version);
      });
    operationQueue = next.catch(() => undefined);
    return next;
  }

  function request(
    command,
    data = new Uint8Array(),
    predicate = () => true,
    label = `命令 0x${command.toString(16).padStart(2, "0").toUpperCase()}`
  ) {
    return enqueue((version) =>
      exchange(
        buildRequest(command, data),
        (frame) => frame.command === command && predicate(frame.payload),
        `${label}响应超时`,
        version
      )
    );
  }

  function setPhoneType() {
    return request(
      COMMAND.SET_PHONE_TYPE,
      Uint8Array.from([0]),
      () => true,
      "设置手机类型"
    );
  }

  function setTime(date = new Date()) {
    return enqueue((version) =>
      exchange(
        buildSetTimeRequest(date),
        (frame) => frame.command === COMMAND.SET_TIME,
        "同步设备时间响应超时",
        version
      )
    );
  }

  async function queryDeviceInfo() {
    const frame = await request(
      COMMAND.DEVICE_INFO,
      new Uint8Array(),
      () => true,
      "读取设备信息"
    );
    return parseDeviceInfo(frame.payload);
  }

  async function queryRecordingInfo() {
    const frame = await request(
      COMMAND.RECORDING_INFO,
      new Uint8Array(),
      () => true,
      "读取录音状态"
    );
    return parseRecordingInfo(frame.payload, frame.command);
  }

  function queryFileList() {
    return enqueue(async (version) => {
      const files = [];
      let end;
      try {
        end = await exchange(
          buildRequest(COMMAND.FILE_LIST),
          (frame) => {
            if (frame.command !== COMMAND.FILE_LIST) return false;
            if (frame.payload.length === 1) {
              return frame.payload[0] === 2 || frame.payload[0] === 1;
            }
            const file = parseFileRecord(frame.payload);
            if (file) files.push(file);
            return false;
          },
          "读取设备文件列表超时",
          version
        );
      } catch (error) {
        if (error.code !== "BLE_RESPONSE_TIMEOUT" || !files.length) throw error;
        assertSession(version);
        traceConnection("ble-file-list-partial", { count: files.length });
        return files;
      }
      if (end.payload[0] !== 2) throw new Error("设备文件列表读取失败");
      return files;
    });
  }

  async function simpleRecordingCommand(command) {
    const frame = await request(command);
    if (frame.payload[0] !== 0) throw new Error("设备拒绝录音操作");
    return parseRecordingInfo(frame.payload, command);
  }

  async function setOption(command, value) {
    const frame = await request(command, Uint8Array.from([value]));
    if (frame.payload.length !== 1 || frame.payload[0] !== 0) {
      throw new Error("设备拒绝修改设置");
    }
  }

  async function openWifiTransport() {
    if (wifiState === "ready") return { ...wifiInfo, sessionId: wifiSessionId };
    if (!isConnected) throw new Error("请先连接录音笔");
    if (activeDownload) throw new Error("文件传输结束后再开启 Wi-Fi 快传");
    if (
      !String(wifiHost || "").trim() ||
      !Number.isInteger(Number(wifiPort)) ||
      Number(wifiPort) < 1 ||
      Number(wifiPort) > 65535
    ) {
      throw new Error("Wi-Fi 快传地址未配置");
    }
    setWifiState("opening");
    try {
      const frame = await request(
        COMMAND.WIFI_SWITCH,
        Uint8Array.from([1]),
        () => true,
        "开启 Wi-Fi 快传"
      );
      wifiInfo = parseWifiCredentials(frame.payload);
      start();
      // The AP can acknowledge F3 before its TCP listener has started.
      await wait(1500);
      const result = await sendWifiNative(
        1512,
        {
          deviceId,
          ssid: wifiInfo.ssid,
          password: wifiInfo.password,
          security: "WPA2",
          host: wifiHost,
          port: wifiPort,
          timeout: 30000,
        },
        WIFI_CONNECT_TIMEOUT_MS,
        "连接设备热点超时"
      );
      wifiSessionId = String(result.sessionId || wifiSessionId);
      setWifiState("ready", wifiInfo);
      return { ...wifiInfo, sessionId: wifiSessionId };
    } catch (error) {
      setWifiState("error", {
        message: error?.message || "Wi-Fi 快传连接失败",
      });
      traceConnection("open-failed", { message: error?.message });
      throw error;
    }
  }

  async function closeWifiTransport() {
    if (wifiState === "idle" && !wifiSessionId) return;
    setWifiState("closing");
    if (activeDownload?.transport === "wifi") {
      failDownload(new Error("Wi-Fi 下载已取消"));
    }
    if (isConnected) {
      await request(
        COMMAND.WIFI_SWITCH,
        Uint8Array.from([0]),
        () => true,
        "关闭 Wi-Fi 快传"
      ).catch(() => undefined);
    }
    const sessionId = wifiSessionId;
    if (sessionId) {
      await sendWifiNative(
        1514,
        { sessionId, removeWifi: true },
        WIFI_RESPONSE_TIMEOUT_MS,
        "关闭 Wi-Fi 快传超时"
      ).catch(() => undefined);
    }
    wifiSessionId = "";
    wifiInfo = null;
    wifiControlBuffer = new Uint8Array();
    setWifiState("idle");
  }

  function sendWifiFrame(frame) {
    if (wifiState !== "ready" || !wifiSessionId) {
      return Promise.reject(new Error("Wi-Fi 快传尚未连接"));
    }
    return sendWifiNative(
      1513,
      { sessionId: wifiSessionId, base64: bytesToBase64(frame) },
      WIFI_RESPONSE_TIMEOUT_MS,
      "Wi-Fi 数据发送超时"
    );
  }

  function downloadFileOverBle(file, onProgress) {
    return enqueue(async (version) => {
      if (activeDownload) throw new Error("已有文件正在下载");
      await ensureReady(version);
      await enableNotification(UUIDS.offline, version);
      const directory = `${RNFS.DocumentDirectoryPath}/AiNote`;
      const finalPath = `${directory}/${file.fileName}.aac`;
      const tempPath = `${finalPath}.part`;
      await RNFS.mkdir(directory);
      if (await RNFS.exists(tempPath)) await RNFS.unlink(tempPath);
      await RNFS.writeFile(tempPath, "", "base64");
      assertSession(version);
      let resolveDone;
      let rejectDone;
      const done = new Promise((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });
      done.catch(() => undefined);
      activeDownload = {
        bufferHex: "",
        bufferedBytes: 0,
        expectedSize: file.size,
        finalPath,
        finishing: false,
        onProgress,
        received: 0,
        reject: rejectDone,
        resolve: resolveDone,
        tempPath,
        timer: null,
        completionTimer: null,
        transport: "ble",
        writeChain: Promise.resolve(),
      };
      armDownloadTimeout();
      try {
        await exchange(
          buildFileDataRequest(file.fileName, 0),
          (frame) =>
            frame.command === COMMAND.FILE_DATA &&
            frame.payload.length === 5 &&
            frame.payload[0] === 0,
          "开始下载响应超时",
          version
        );
        return await done;
      } catch (error) {
        failDownload(error);
        throw error;
      }
    });
  }

  function downloadFileOverWifi(file, onProgress) {
    return enqueue(async () => {
      if (activeDownload) throw new Error("已有文件正在下载");
      if (wifiState !== "ready" || !wifiSessionId) {
        throw new Error("Wi-Fi 快传尚未连接");
      }
      const directory = `${RNFS.DocumentDirectoryPath}/AiNote`;
      const finalPath = `${directory}/${file.fileName}.aac`;
      const tempPath = `${finalPath}.part`;
      await RNFS.mkdir(directory);
      if (await RNFS.exists(tempPath)) await RNFS.unlink(tempPath);
      await RNFS.writeFile(tempPath, "", "base64");
      let resolveDone;
      let rejectDone;
      const done = new Promise((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });
      activeDownload = {
        bufferHex: "",
        bufferedBytes: 0,
        completionTimer: null,
        expectedSize: Number(file.size || 0),
        finalPath,
        finishing: false,
        onProgress,
        received: 0,
        reject: rejectDone,
        resolve: resolveDone,
        tempPath,
        timer: null,
        transport: "wifi",
        wifiBuffer: new Uint8Array(),
        wifiPhase: "start",
        wifiProbeHex: "",
        writeChain: Promise.resolve(),
      };
      armDownloadTimeout();
      try {
        const settleDelay = 1000 - (Date.now() - wifiConnectedAt);
        if (settleDelay > 0) await wait(settleDelay);
        await sendWifiFrame(buildFileDataRequest(file.fileName, 0));
        return await done;
      } catch (error) {
        failDownload(error);
        throw error;
      }
    }, false);
  }

  function downloadFile(file, onProgress) {
    return wifiState === "ready"
      ? downloadFileOverWifi(file, onProgress)
      : downloadFileOverBle(file, onProgress);
  }

  async function cancelDownload() {
    const transport = activeDownload?.transport;
    failDownload(new Error("下载已取消"));
    if (transport === "wifi") {
      await sendWifiFrame(buildRequest(COMMAND.STOP_FILE_DATA)).catch(
        () => undefined
      );
    } else {
      await request(COMMAND.STOP_FILE_DATA).catch(() => undefined);
    }
  }

  async function deleteFile(fileName) {
    if (wifiState === "ready") {
      const reply = waitForWifiFrame(
        (frame) => frame.command === COMMAND.DELETE_FILE,
        "通过 Wi-Fi 删除设备文件超时"
      );
      await sendWifiFrame(buildDeleteFileRequest(fileName));
      const frame = await reply;
      if (frame.payload.length && frame.payload[0] !== 0) {
        throw new Error("设备文件删除失败");
      }
      return;
    }
    return enqueue(async (version) => {
      const frame = await exchange(
        buildDeleteFileRequest(fileName),
        (reply) => reply.command === COMMAND.DELETE_FILE,
        "删除设备文件响应超时",
        version
      );
      if (frame.payload.length !== 1 || frame.payload[0] !== 0)
        throw new Error("设备文件删除失败");
    });
  }

  function getLocalFilePath(fileName) {
    return `${RNFS.DocumentDirectoryPath}/AiNote/${fileName}.aac`;
  }

  async function findLocalFile(file) {
    const path = getLocalFilePath(file.fileName);
    if (!(await RNFS.exists(path))) return null;
    const stat = await RNFS.stat(path);
    return Number(stat.size) === Number(file.size) ? path : null;
  }

  function onConnectionChange(listener) {
    connectionListeners.add(listener);
    return () => connectionListeners.delete(listener);
  }

  function onControl(listener) {
    controlListeners.add(listener);
    return () => controlListeners.delete(listener);
  }

  function onWifiStateChange(listener) {
    wifiStateListeners.add(listener);
    listener({ state: wifiState, sessionId: wifiSessionId, ...wifiInfo });
    return () => wifiStateListeners.delete(listener);
  }

  function prepare() {
    if (
      prepareTask &&
      (prepareTask.version === null || prepareTask.version === sessionVersion)
    )
      return prepareTask.promise;
    const task = { version: null, promise: null };
    const lifecycle = lifecycleVersion;
    task.promise = (async () => {
      await connect();
      assertLifecycle(lifecycle);
      task.version = sessionVersion;
      try {
        await ensureReady(task.version);
      } catch (error) {
        assertSession(task.version);
        const recoverable =
          Platform.OS === "ios" &&
          ["BLE_NOTIFY_TIMEOUT", "BLE_DISCOVERY_TIMEOUT"].includes(error.code);
        if (!recoverable) throw error;
        // One recovery attempt clears a stale reused connection; no reconnect loop.
        task.version = null;
        await reconnectForPreparation();
        assertLifecycle(lifecycle);
        task.version = sessionVersion;
        await ensureReady(task.version);
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        assertSession(task.version);
        try {
          return await queryDeviceInfo();
        } catch (error) {
          assertSession(task.version);
          if (error.code !== "BLE_RESPONSE_TIMEOUT" || attempt === 1)
            throw error;
          await enableNotification(UUIDS.control, task.version, true);
        }
      }
    })().finally(() => {
      if (prepareTask === task) prepareTask = null;
    });
    prepareTask = task;
    return task.promise;
  }

  return {
    cancelDownload,
    connect,
    deleteFile,
    downloadFile,
    findLocalFile,
    getLocalFilePath,
    isConnected: () => isConnected,
    getSessionVersion: () => sessionVersion,
    isSessionCurrent: (version) =>
      !stopped && isConnected && version === sessionVersion,
    isWifiReady: () => wifiState === "ready",
    closeWifiTransport,
    onConnectionChange,
    onControl,
    onWifiStateChange,
    openWifiTransport,
    pauseRecording: () => simpleRecordingCommand(COMMAND.PAUSE_RECORDING),
    prepare,
    persistDevice,
    queryDeviceInfo,
    queryFileList,
    queryRecordingInfo,
    resumeRecording: () => simpleRecordingCommand(COMMAND.RESUME_RECORDING),
    setAnc: (value) => setOption(COMMAND.SET_ANC, value),
    setPhoneType,
    setSplit: (value) => setOption(COMMAND.SET_SPLIT, value),
    setTime,
    start,
    startRecording: () => simpleRecordingCommand(COMMAND.START_RECORDING),
    stop,
    stopRecording: () => simpleRecordingCommand(COMMAND.STOP_RECORDING),
  };
}

export { createAiM8BleClient };
