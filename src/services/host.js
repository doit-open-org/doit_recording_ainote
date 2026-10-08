import NativeLocalStorage from "../../specs/NativeLocalStorage";
import {
  DeviceEventEmitter,
  NativeEventEmitter,
  NativeModules,
  Platform,
} from "react-native";

function sendHostType(type, deviceId = "") {
  if (!NativeLocalStorage?.sendDataByType) {
    return;
  }
  try {
    NativeLocalStorage.sendDataByType(
      JSON.stringify({ cmd: 3, type: String(type), device_id: deviceId, msg: {} })
    );
  } catch (error) {
    console.warn("[AiNotePanel] host action failed", type, error);
  }
}

function closePanel(deviceId) {
  sendHostType(2000, deviceId);
}

function editPanel(deviceId) {
  sendHostType(2001, deviceId);
}

function notifyPanelReady(deviceId) {
  sendHostType(2002, deviceId);
}

function parseHostEvent(raw) {
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) {
    return null;
  }
}

function getDeviceNameFromEvent(raw) {
  const event = parseHostEvent(raw);
  if (!event || Number(event.type) !== 2003) return "";
  const message = parseHostEvent(event.msg) || {};
  const data = parseHostEvent(message.data) || message?.msg?.data || {};
  const name = String(data["2003"] || data.deviceName || "");
  try {
    return decodeURIComponent(name);
  } catch (_) {
    return name;
  }
}

function onDeviceNameChange(listener) {
  const handleEvent = (raw) => {
    const name = getDeviceNameFromEvent(raw);
    if (name) listener(name);
  };
  const subscriptions = [
    DeviceEventEmitter.addListener("getDeviceData", handleEvent),
  ];
  if (Platform.OS === "ios" && NativeModules?.NativeEventSendModule) {
    NativeModules.NativeEventSendModule.myInit?.();
    const emitter = new NativeEventEmitter(NativeModules.NativeEventSendModule);
    subscriptions.push(emitter.addListener("getDeviceData", handleEvent));
  }
  return () => subscriptions.forEach((subscription) => subscription.remove());
}

export {
  closePanel,
  editPanel,
  getDeviceNameFromEvent,
  notifyPanelReady,
  onDeviceNameChange,
};
