import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Alert,
  Easing,
  Image,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import Slider from "@react-native-community/slider";
import Feather from "react-native-vector-icons/Feather";
import Video from "react-native-video";
import RNFS from "react-native-fs";
import NativeLocalStorage from "./specs/NativeLocalStorage";
import AiWorkspace from "./src/components/AiWorkspace";
import { createAiM8BleClient } from "./src/services/aiM8Ble";
import {
  activeFiles,
  trashFiles,
  restoreFiles,
} from "./src/utils/fileOrganization";
import {
  closePanel,
  editPanel,
  notifyPanelReady,
  onDeviceNameChange,
} from "./src/services/host";
import {
  ANC_LEVELS,
  COMMAND,
  SPLIT_OPTIONS,
  parseDeviceStatus,
  parseQuery,
  parseRecordingInfo,
} from "./src/utils/protocol";

type DeviceFile = {
  fileName: string;
  size: number;
  duration: number;
  fileType: number;
  onDevice?: boolean;
};

type DeviceInfo = {
  totalKb: number;
  remainingKb: number;
  charging: boolean;
  battery: number;
  recordingState: number;
  recordingType: number;
  firmware: string;
  lightsEnabled: boolean;
  deviceMode: string;
  shutdownMinutes: number;
  ancLevel: number;
  split: number;
};

type Option = { label: string; value: number };
type TabKey = "record" | "files" | "settings";
type AiTab = "transcript" | "summary" | "mindmap";
const LIVE_WAVE_BARS = [
  18, 31, 24, 46, 29, 58, 38, 67, 42, 54, 33, 62, 40, 71, 35, 57, 27, 49, 22,
  39, 18,
];

const DELETE_AFTER_DOWNLOAD_KEY = "ainote.deleteAfterDownload";
const AUTO_DOWNLOAD_KEY = "ainote.autoDownload";
const FILE_ALIASES_KEY = "ainote.fileAliases";
const LOCAL_FILES_KEY = "ainote.localFiles";
const ORGANIZATION_KEY = "ainote.organization.v1";
const AI_M8_WIFI_DEFAULT = Object.freeze({ host: "192.168.10.1", port: 22000 });
type Folder = { id: string; name: string };
const EMPTY_INFO: DeviceInfo = {
  totalKb: 0,
  remainingKb: 0,
  charging: false,
  battery: 0,
  recordingState: 0,
  recordingType: 0,
  firmware: "--",
  lightsEnabled: false,
  deviceMode: "--",
  shutdownMinutes: 0,
  ancLevel: 0,
  split: 3,
};

function firstValue(...values: unknown[]) {
  return values.find(
    (value) => value !== undefined && value !== null && value !== "",
  );
}

function resolveLaunchProps(props: any) {
  const query = parseQuery(props?.query) as Record<string, any>;
  const status = firstValue(
    query.connectStatus,
    query.connect_status,
    query.isOnline,
    props?.connectStatus,
    props?.isOnline,
  );
  const requestedWifiPort = Number(
    firstValue(
      query.wifiPort,
      query.wifi_port,
      query.tcpPort,
      props?.wifiPort,
      props?.wifi_port,
      props?.tcpPort,
    ),
  );
  return {
    mac: String(
      firstValue(query.mac, query.macAddress, props?.mac, props?.macAddress) ||
        "",
    ),
    deviceId: String(
      firstValue(
        query.deviceId,
        query.device_id,
        props?.deviceId,
        props?.device_id,
      ) || "",
    ),
    deviceName: String(
      firstValue(
        query.deviceName,
        query.device_name,
        props?.deviceName,
        props?.device_name,
      ) || "Ai-M8",
    ),
    broadcastData: String(
      firstValue(query.broadcastData, props?.broadcastData) || "",
    ),
    pid: String(
      firstValue(
        query.pid,
        query.productId,
        query.deviceProductId,
        props?.pid,
        props?.productId,
        props?.deviceProductId,
      ) || "",
    ),
    token: String(firstValue(query.token, props?.token) || ""),
    domain: String(firstValue(query.domain, props?.domain) || ""),
    lang: String(firstValue(query.lang, props?.lang) || "zh"),
    wifiHost: String(
      firstValue(
        query.wifiHost,
        query.wifi_host,
        query.tcpHost,
        props?.wifiHost,
        props?.wifi_host,
        props?.tcpHost,
      ) || AI_M8_WIFI_DEFAULT.host,
    ),
    wifiPort:
      Number.isInteger(requestedWifiPort) &&
      requestedWifiPort > 0 &&
      requestedWifiPort <= 65535
        ? requestedWifiPort
        : AI_M8_WIFI_DEFAULT.port,
    connected: String(status) === "1" || status === true,
  };
}

function parseBroadcastSn(value: string) {
  const hex = String(value || "")
    .replace(/[^0-9a-f]/gi, "")
    .toUpperCase();
  const marker = hex.indexOf("350A");
  if (marker < 0 || marker + 36 > hex.length) return "";
  const snHex = hex.slice(marker + 16, marker + 36);
  let text = "";
  for (let index = 0; index < snHex.length; index += 2) {
    const code = Number.parseInt(snHex.slice(index, index + 2), 16);
    if (code < 0x20 || code > 0x7e) return "";
    text += String.fromCharCode(code);
  }
  return text;
}

function formatClock(seconds = 0) {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = value % 60;
  return [hours, minutes, rest]
    .map((item) => String(item).padStart(2, "0"))
    .join(":");
}

function formatSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatCapacity(kb = 0) {
  if (!kb) return "--";
  return `${(kb / 1024 / 1024).toFixed(1)} GB`;
}

function formatFileDate(fileName: string) {
  if (!/^\d{14}$/.test(fileName)) return fileName;
  return `${fileName.slice(0, 4)}-${fileName.slice(4, 6)}-${fileName.slice(
    6,
    8,
  )} ${fileName.slice(8, 10)}:${fileName.slice(10, 12)}:${fileName.slice(
    12,
    14,
  )}`;
}

function getOptionLabel(options: readonly Option[], value: number) {
  return options.find((option) => option.value === value)?.label || "--";
}

function readStoredJson(key: string) {
  try {
    const value = NativeLocalStorage?.getItem(key);
    return value ? JSON.parse(value) : {};
  } catch (_) {
    return {};
  }
}

function resolvePlaybackDuration(file: DeviceFile, nativeDuration: number) {
  const protocolDuration = Number(file.duration || 0);
  const playerDuration = Number(nativeDuration || 0);
  if (protocolDuration > 0) {
    // Ai-M8 stores raw ADTS AAC. Native players can underestimate its duration
    // from an early bitrate sample, while the device reports recording seconds.
    return Math.max(protocolDuration, playerDuration);
  }
  return Math.max(0, playerDuration);
}

function normalizePlaybackPosition(value: number, duration: number) {
  const position = Math.max(0, Number(value || 0));
  const total = Math.max(0, Number(duration || 0));
  if (total > 0 && position > total * 4 && position / 1000 <= total * 1.25) {
    return position / 1000;
  }
  return position;
}

function OptionSheet({
  title,
  visible,
  options,
  selected,
  onClose,
  onSelect,
}: {
  title: string;
  visible: boolean;
  options: readonly Option[];
  selected: number;
  onClose: () => void;
  onSelect: (value: number) => void;
}) {
  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
    >
      <TouchableOpacity
        activeOpacity={1}
        style={styles.modalBackdrop}
        onPress={onClose}
      >
        <View style={styles.optionSheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <TouchableOpacity
              accessibilityLabel="关闭"
              style={styles.iconButton}
              onPress={onClose}
            >
              <Feather name="x" size={21} color="#1D2622" />
            </TouchableOpacity>
          </View>
          {options.map((option) => {
            const active = selected === option.value;
            return (
              <TouchableOpacity
                key={option.value}
                style={styles.optionRow}
                onPress={() => onSelect(option.value)}
              >
                <Text
                  style={[styles.optionText, active && styles.optionTextActive]}
                >
                  {option.label}
                </Text>
                <View style={[styles.radio, active && styles.radioActive]}>
                  {active ? <View style={styles.radioDot} /> : null}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

export default function App(props: any) {
  const { height: viewportHeight } = useWindowDimensions();
  const launch = useMemo(() => resolveLaunchProps(props), [props]);
  const client = useMemo(
    () =>
      createAiM8BleClient({
        mac: launch.mac,
        deviceId: launch.deviceId,
        connected: launch.connected,
        wifiHost: launch.wifiHost,
        wifiPort: launch.wifiPort,
      }),
    [
      launch.connected,
      launch.deviceId,
      launch.mac,
      launch.wifiHost,
      launch.wifiPort,
    ],
  );
  const mountedRef = useRef(true);
  const recordingWaveProgress = useRef(new Animated.Value(0)).current;
  const initialConnectAttemptedRef = useRef(false);
  const playerRef = useRef<any>(null);
  const recordBaseRef = useRef(0);
  const recordStartedAtRef = useRef<number | null>(null);
  const downloadQueueRef = useRef<DeviceFile[]>([]);
  const downloadRunningRef = useRef(false);
  const downloadedPathsRef = useRef<Record<string, string>>({});
  const autoDownloadRef = useRef(false);
  const deleteAfterDownloadRef = useRef(false);
  const localFilesRef = useRef<Record<string, DeviceFile>>({});
  const trashedFilesRef = useRef<
    Record<string, DeviceFile & { deletedAt: number }>
  >({});
  const dismissedFilesRef = useRef<Record<string, boolean>>({});
  const selectionModeRef = useRef(false);
  const devicePersistedRef = useRef(false);
  const [connected, setConnected] = useState(
    Platform.OS === "android" ? false : launch.connected,
  );
  const [wifiTransfer, setWifiTransfer] = useState<{
    state: string;
    ssid?: string;
    message?: string;
  }>({ state: "idle" });
  const [deviceTitle, setDeviceTitle] = useState(launch.deviceName || "Ai-M8");
  const [tab, setTab] = useState<TabKey>("files");
  const [info, setInfo] = useState<DeviceInfo>(EMPTY_INFO);
  const [files, setFiles] = useState<DeviceFile[]>([]);
  const [deviceFileNames, setDeviceFileNames] = useState<
    Record<string, boolean>
  >({});
  const [recordState, setRecordState] = useState(0);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [currentFileName, setCurrentFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [action, setAction] = useState("");
  const [notice, setNotice] = useState("");
  const [downloadProgress, setDownloadProgress] = useState<
    Record<string, number>
  >({});
  const [downloadedPaths, setDownloadedPaths] = useState<
    Record<string, string>
  >({});
  const [autoDownload, setAutoDownload] = useState(false);
  const [deleteAfterDownload, setDeleteAfterDownload] = useState(false);
  const [downloadQueueCount, setDownloadQueueCount] = useState(0);
  const [activeDownloadName, setActiveDownloadName] = useState("");
  const [fileAliases, setFileAliases] = useState<Record<string, string>>({});
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderAssignments, setFolderAssignments] = useState<
    Record<string, string>
  >({});
  const [trashedFiles, setTrashedFiles] = useState<
    Record<string, DeviceFile & { deletedAt: number }>
  >({});
  const [dismissedFiles, setDismissedFiles] = useState<Record<string, boolean>>(
    {},
  );
  const [importCandidates, setImportCandidates] = useState<DeviceFile[] | null>(
    null,
  );
  const [fileLocation, setFileLocation] = useState("all");
  const [folderDrawerVisible, setFolderDrawerVisible] = useState(false);
  const [folderDialog, setFolderDialog] = useState<Folder | "new" | null>(null);
  const [folderDraft, setFolderDraft] = useState("");
  const [moveFiles, setMoveFiles] = useState<DeviceFile[] | null>(null);
  const [searchText, setSearchText] = useState("");
  const [fileFilter, setFileFilter] = useState<"all" | "call" | "note">("all");
  const [sortNewestFirst, setSortNewestFirst] = useState(true);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Record<string, boolean>>(
    {},
  );
  const [detailFile, setDetailFile] = useState<DeviceFile | null>(null);
  const [renameFile, setRenameFile] = useState<DeviceFile | null>(null);
  const [aiWorkspace, setAiWorkspace] = useState<{
    file: DeviceFile;
    tab: AiTab;
  } | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [ancSheetVisible, setAncSheetVisible] = useState(false);
  const [splitSheetVisible, setSplitSheetVisible] = useState(false);
  const [playingFile, setPlayingFile] = useState<DeviceFile | null>(null);
  const [playerPaused, setPlayerPaused] = useState(true);
  const [playerDuration, setPlayerDuration] = useState(0);
  const [playerPosition, setPlayerPosition] = useState(0);

  const busy = Boolean(action);
  const downloading = Boolean(activeDownloadName);
  const recording = recordState === 1;
  const paused = recordState === 2;
  const wifiReady = wifiTransfer.state === "ready";
  const wifiBusy = ["opening", "connecting", "closing"].includes(
    wifiTransfer.state,
  );
  const playerMax = Math.max(1, playerDuration);
  const playerDisplayPosition = Math.min(playerPosition, playerMax);
  const visibleFiles = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();
    const available =
      fileLocation === "trash"
        ? Object.values(trashedFiles)
        : activeFiles(
            files,
            trashedFiles,
            fileLocation,
            folderAssignments,
            dismissedFiles,
          );
    return available
      .filter((file) => {
        if (fileFilter === "call" && file.fileType !== 0) return false;
        if (fileFilter === "note" && file.fileType !== 1) return false;
        const alias = fileAliases[file.fileName] || "";
        return (
          !keyword ||
          `${file.fileName} ${alias} ${formatFileDate(file.fileName)}`
            .toLowerCase()
            .includes(keyword)
        );
      })
      .sort((left, right) =>
        sortNewestFirst
          ? right.fileName.localeCompare(left.fileName)
          : left.fileName.localeCompare(right.fileName),
      );
  }, [
    dismissedFiles,
    fileAliases,
    fileFilter,
    files,
    folderAssignments,
    fileLocation,
    searchText,
    sortNewestFirst,
    trashedFiles,
  ]);
  const deviceSn = useMemo(
    () => parseBroadcastSn(launch.broadcastData),
    [launch.broadcastData],
  );
  const deviceFileCount = Object.keys(deviceFileNames).length;
  const selectedCount = getSelectedDeviceFiles().length;
  const selectedDeviceCount = visibleFiles.filter(
    (file) => selectedFiles[file.fileName],
  ).length;
  const selectedDownloadCount = files.filter(
    (file) =>
      selectedFiles[file.fileName] &&
      deviceFileNames[file.fileName] &&
      !downloadedPaths[file.fileName],
  ).length;
  const allVisibleSelected =
    visibleFiles.length > 0 &&
    visibleFiles.every((file) => selectedFiles[file.fileName]);

  function persistLocalFile(file: DeviceFile) {
    const next = {
      ...localFilesRef.current,
      [file.fileName]: { ...file, onDevice: false },
    };
    localFilesRef.current = next;
    try {
      NativeLocalStorage?.setItem(LOCAL_FILES_KEY, JSON.stringify(next));
    } catch (_) {}
  }

  function storeOrganization(
    nextFolders: Folder[],
    nextAssignments: Record<string, string>,
    nextTrash: Record<string, DeviceFile & { deletedAt: number }>,
    nextDismissed = dismissedFiles,
  ) {
    trashedFilesRef.current = nextTrash;
    dismissedFilesRef.current = nextDismissed;
    setFolders(nextFolders);
    setFolderAssignments(nextAssignments);
    setTrashedFiles(nextTrash);
    setDismissedFiles(nextDismissed);
    try {
      NativeLocalStorage?.setItem(
        `${ORGANIZATION_KEY}.${launch.deviceId || launch.mac}`,
        JSON.stringify({
          folders: nextFolders,
          assignments: nextAssignments,
          trash: nextTrash,
          dismissed: nextDismissed,
        }),
      );
    } catch (error) {
      console.warn("[AiNotePanel] file organization was not saved", error);
    }
  }

  function markDeviceFileDeleted(fileName: string) {
    setDeviceFileNames((previous) => {
      const next = { ...previous };
      delete next[fileName];
      return next;
    });
    setFiles((previous) =>
      previous
        .map((file) =>
          file.fileName === fileName ? { ...file, onDevice: false } : file,
        )
        .filter(
          (file) =>
            file.onDevice !== false ||
            downloadedPathsRef.current[file.fileName],
        ),
    );
  }

  function showNotice(message: string) {
    if (!mountedRef.current) return;
    setNotice(message);
    setTimeout(() => mountedRef.current && setNotice(""), 2800);
  }

  async function runAction(name: string, operation: () => Promise<void>) {
    if (busy) return;
    setAction(name);
    try {
      await operation();
    } catch (error: any) {
      if (error?.code !== "BLE_SESSION_CHANGED")
        showNotice(error?.message || "操作失败，请重试");
    } finally {
      if (mountedRef.current) setAction("");
    }
  }

  function applyRecordingState(state: number, duration = 0, fileName = "") {
    const normalizedDuration = Math.max(0, Number(duration || 0));
    setRecordState(state);
    if (state === 0) {
      recordBaseRef.current = 0;
      recordStartedAtRef.current = null;
      setRecordSeconds(0);
      setCurrentFileName("");
      return;
    }
    recordBaseRef.current = normalizedDuration;
    recordStartedAtRef.current = state === 1 ? Date.now() : null;
    setRecordSeconds(normalizedDuration);
    if (fileName) setCurrentFileName(fileName);
  }

  function storeDownloadedPaths(next: Record<string, string>) {
    downloadedPathsRef.current = next;
    if (mountedRef.current) setDownloadedPaths(next);
  }

  async function reconcileLocalFiles(deviceFiles: DeviceFile[]) {
    const entries = await Promise.all(
      deviceFiles.map(
        async (file) =>
          [file.fileName, await client.findLocalFile(file)] as const,
      ),
    );
    const next = { ...downloadedPathsRef.current };
    entries.forEach(([fileName, path]) => {
      if (path) next[fileName] = path;
      else delete next[fileName];
    });
    storeDownloadedPaths(next);
    return next;
  }

  function enqueueDownloads(deviceFiles: DeviceFile[], prioritize = false) {
    const queuedNames = new Set(
      downloadQueueRef.current.map((file) => file.fileName),
    );
    if (activeDownloadName) queuedNames.add(activeDownloadName);
    const additions = deviceFiles.filter(
      (file) =>
        !downloadedPathsRef.current[file.fileName] &&
        !queuedNames.has(file.fileName),
    );
    if (!additions.length) return;
    downloadQueueRef.current = prioritize
      ? [...additions, ...downloadQueueRef.current]
      : [...downloadQueueRef.current, ...additions];
    setDownloadQueueCount(downloadQueueRef.current.length);
    void processDownloadQueue();
  }

  async function processDownloadQueue() {
    if (downloadRunningRef.current) return;
    downloadRunningRef.current = true;
    try {
      while (downloadQueueRef.current.length && mountedRef.current) {
        const file = downloadQueueRef.current[0];
        setActiveDownloadName(file.fileName);
        setDownloadQueueCount(downloadQueueRef.current.length);
        try {
          const result = await client.downloadFile(
            file,
            ({ progress }: { progress: number }) => {
              if (mountedRef.current) {
                setDownloadProgress((previous) =>
                  previous[file.fileName] === progress
                    ? previous
                    : { ...previous, [file.fileName]: progress },
                );
              }
            },
          );
          storeDownloadedPaths({
            ...downloadedPathsRef.current,
            [file.fileName]: result.path,
          });
          persistLocalFile(file);
          setDownloadProgress((previous) => ({
            ...previous,
            [file.fileName]: 100,
          }));
          if (deleteAfterDownloadRef.current) {
            await client.deleteFile(file.fileName);
            markDeviceFileDeleted(file.fileName);
          }
        } catch (error: any) {
          if (error?.message !== "下载已取消") {
            showNotice(error?.message || "文件下载失败");
          }
          if (!client.isConnected()) {
            downloadQueueRef.current = [];
          }
        } finally {
          downloadQueueRef.current = downloadQueueRef.current.filter(
            (item) => item.fileName !== file.fileName,
          );
          setDownloadQueueCount(downloadQueueRef.current.length);
          setActiveDownloadName("");
        }
      }
    } finally {
      downloadRunningRef.current = false;
    }
  }

  async function refreshDevice(silent = false) {
    if (!silent && (downloading || downloadRunningRef.current)) {
      showNotice("文件传输完成后再刷新设备");
      return;
    }
    if (!client.isConnected()) {
      if (!silent) reconnect();
      return;
    }
    const version = client.getSessionVersion();
    if (!silent) setRefreshing(true);
    try {
      const [infoResult, recordingResult, filesResult] =
        await Promise.allSettled([
          client.queryDeviceInfo(),
          client.queryRecordingInfo(),
          client.queryFileList(),
        ]);
      if (!mountedRef.current || !client.isSessionCurrent(version)) return;
      if (infoResult.status === "fulfilled") setInfo(infoResult.value);
      if (recordingResult.status === "fulfilled") {
        const recordingInfo = recordingResult.value;
        applyRecordingState(
          recordingInfo.state,
          Number(recordingInfo.file?.duration || 0),
          recordingInfo.file?.fileName || "",
        );
      }
      if (filesResult.status === "fulfilled") {
        const remoteFiles = filesResult.value
          .map((file: DeviceFile) => ({ ...file, onDevice: true }))
          .sort((left: DeviceFile, right: DeviceFile) =>
            right.fileName.localeCompare(left.fileName),
          );
        setDeviceFileNames(
          Object.fromEntries(
            remoteFiles.map((file: DeviceFile) => [file.fileName, true]),
          ),
        );
        const merged = new Map<string, DeviceFile>();
        Object.values(localFilesRef.current).forEach((file) =>
          merged.set(file.fileName, { ...file, onDevice: false }),
        );
        remoteFiles.forEach((file: DeviceFile) =>
          merged.set(file.fileName, file),
        );
        const mergedFiles = Array.from(merged.values());
        setFiles(mergedFiles);
        const localPaths = await reconcileLocalFiles(mergedFiles);
        if (!mountedRef.current || !client.isSessionCurrent(version)) return;
        if (
          autoDownloadRef.current &&
          recordingResult.status === "fulfilled" &&
          recordingResult.value.state === 0
        ) {
          enqueueDownloads(
            remoteFiles.filter(
              (file: DeviceFile) =>
                !localPaths[file.fileName] &&
                !trashedFilesRef.current[file.fileName] &&
                !dismissedFilesRef.current[file.fileName],
            ),
          );
        }
      }
      const failure = [filesResult, infoResult, recordingResult].find(
        (result) =>
          result.status === "rejected" &&
          result.reason?.code !== "BLE_SESSION_CHANGED",
      );
      if (!silent && failure?.status === "rejected")
        showNotice(failure.reason?.message || "设备状态刷新失败");
    } catch (error: any) {
      if (!silent && error?.code !== "BLE_SESSION_CHANGED")
        showNotice(error?.message || "设备状态刷新失败");
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    initialConnectAttemptedRef.current = false;
    const removeConnection = client.onConnectionChange(setConnected);
    const removeWifiState = client.onWifiStateChange(setWifiTransfer);
    const removeDeviceName = onDeviceNameChange(setDeviceTitle);
    const removeControl = client.onControl((frame: any) => {
      try {
        if (frame.command === COMMAND.DEVICE_STATUS) {
          const status = parseDeviceStatus(frame.payload);
          setInfo((previous) => ({ ...previous, ...status }));
          return;
        }
        if (
          [
            COMMAND.START_RECORDING,
            COMMAND.STOP_RECORDING,
            COMMAND.PAUSE_RECORDING,
            COMMAND.RESUME_RECORDING,
          ].includes(frame.command)
        ) {
          const next = parseRecordingInfo(frame.payload, frame.command);
          applyRecordingState(
            next.state,
            Number(next.file?.duration || 0),
            next.file?.fileName || "",
          );
          if (frame.command === COMMAND.STOP_RECORDING) {
            setTimeout(() => void refreshDevice(true), 700);
          }
        }
      } catch (_) {}
    });
    client.start();
    notifyPanelReady(launch.deviceId);
    if (!devicePersistedRef.current) {
      try {
        const persistence = client.persistDevice({
          deviceName: deviceTitle,
          pid: launch.pid,
        });
        devicePersistedRef.current = Boolean(persistence);
        Promise.resolve(persistence).catch((error) => {
          devicePersistedRef.current = false;
          console.warn("[AiNotePanel] device persistence failed", error);
        });
      } catch (error) {
        console.warn("[AiNotePanel] device persistence failed", error);
      }
    }
    try {
      const nextDeleteAfterDownload =
        NativeLocalStorage?.getItem(DELETE_AFTER_DOWNLOAD_KEY) === "1";
      deleteAfterDownloadRef.current = nextDeleteAfterDownload;
      setDeleteAfterDownload(nextDeleteAfterDownload);
      const storedAutoDownload = NativeLocalStorage?.getItem(AUTO_DOWNLOAD_KEY);
      const nextAutoDownload = storedAutoDownload === "1";
      autoDownloadRef.current = nextAutoDownload;
      setAutoDownload(nextAutoDownload);
      setFileAliases(readStoredJson(FILE_ALIASES_KEY));
      const organization = readStoredJson(
        `${ORGANIZATION_KEY}.${launch.deviceId || launch.mac}`,
      );
      setFolders(
        Array.isArray(organization.folders) ? organization.folders : [],
      );
      setFolderAssignments(organization.assignments || {});
      trashedFilesRef.current = organization.trash || {};
      dismissedFilesRef.current = organization.dismissed || {};
      setTrashedFiles(trashedFilesRef.current);
      setDismissedFiles(dismissedFilesRef.current);
      const storedLocalFiles = readStoredJson(LOCAL_FILES_KEY);
      localFilesRef.current = storedLocalFiles;
      const localFiles = Object.values(storedLocalFiles) as DeviceFile[];
      if (localFiles.length) {
        setFiles(localFiles.map((file) => ({ ...file, onDevice: false })));
        void reconcileLocalFiles(localFiles);
      }
    } catch (_) {}
    return () => {
      mountedRef.current = false;
      removeConnection();
      removeWifiState();
      removeDeviceName();
      removeControl();
      client.stop();
    };
  }, [client, launch.deviceId]);

  useEffect(() => {
    if (
      connected ||
      wifiReady ||
      wifiBusy ||
      !launch.mac ||
      initialConnectAttemptedRef.current
    )
      return;
    initialConnectAttemptedRef.current = true;
    const timer = setTimeout(() => {
      if (!mountedRef.current) return;
      if (client.isConnected()) {
        setConnected(true);
        return;
      }
      setAction("connect");
      void client
        .connect()
        .catch((error: any) => {
          if (mountedRef.current && error?.code !== "BLE_SESSION_CHANGED")
            showNotice(error?.message || "连接设备失败");
        })
        .finally(() => {
          if (mountedRef.current) setAction("");
        });
    }, 500);
    return () => clearTimeout(timer);
  }, [client, connected, launch.mac, wifiBusy, wifiReady]);

  useEffect(() => {
    if (!connected) return;
    initialConnectAttemptedRef.current = true;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!mountedRef.current || cancelled) return;
      setLoading(true);
      void (async () => {
        try {
          const initialInfo = await client.prepare();
          if (!mountedRef.current || cancelled) return;
          const version = client.getSessionVersion();
          setInfo(initialInfo);
          await client.setPhoneType();
          if (cancelled || !client.isSessionCurrent(version)) return;
          try {
            await client.setTime(new Date());
          } catch (error) {
            console.warn("[AiNotePanel] device time sync failed", error);
          }
          if (cancelled || !client.isSessionCurrent(version)) return;
          await refreshDevice(true);
        } catch (error: any) {
          if (
            !cancelled &&
            mountedRef.current &&
            error?.code !== "BLE_SESSION_CHANGED"
          ) {
            showNotice(error?.message || "设备初始化失败");
          }
        } finally {
          if (!cancelled && mountedRef.current) setLoading(false);
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, connected]);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      const startedAt = recordStartedAtRef.current;
      if (startedAt === null) return;
      setRecordSeconds(
        recordBaseRef.current + Math.floor((Date.now() - startedAt) / 1000),
      );
    }, 250);
    return () => clearInterval(timer);
  }, [recording]);

  useEffect(() => {
    recordingWaveProgress.stopAnimation();
    if (!recording || tab !== "record") {
      recordingWaveProgress.setValue(0);
      return;
    }
    const animation = Animated.loop(
      Animated.timing(recordingWaveProgress, {
        toValue: 1,
        duration: 1100,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [recording, recordingWaveProgress, tab]);

  function applyRecordingResult(result: any) {
    applyRecordingState(
      result.state,
      Number(result.file?.duration || 0),
      result.file?.fileName || "",
    );
  }

  function startRecording() {
    if (wifiReady || wifiBusy) {
      showNotice("关闭 Wi-Fi 快传后再开始录音");
      return;
    }
    if (downloading) {
      showNotice("文件传输完成后才能开始录音");
      return;
    }
    if (info.battery > 0 && info.battery < 10) {
      showNotice("设备电量过低，暂不能开始录音");
      return;
    }
    if (info.remainingKb > 0 && info.remainingKb < 1024) {
      showNotice("设备剩余空间不足");
      return;
    }
    void runAction("record", async () => {
      applyRecordingResult(await client.startRecording());
    });
  }

  function pauseRecording() {
    void runAction("pause", async () => {
      applyRecordingResult(await client.pauseRecording());
    });
  }

  function resumeRecording() {
    void runAction("resume", async () => {
      applyRecordingResult(await client.resumeRecording());
    });
  }

  function stopRecording() {
    void runAction("stop", async () => {
      const result = await client.stopRecording();
      applyRecordingResult(result);
      setTab("files");
    });
  }

  function openRecorder() {
    setTab("record");
    if (recordState === 0) startRecording();
  }

  function reconnect() {
    void runAction("connect", async () => {
      await client.connect();
    });
  }

  function toggleWifiTransfer() {
    if (recordState !== 0) {
      showNotice("停止录音后再使用 Wi-Fi 快传");
      return;
    }
    if (downloading) {
      showNotice("文件传输完成后再切换 Wi-Fi 快传");
      return;
    }
    void runAction("wifi", async () => {
      if (wifiReady) {
        await client.closeWifiTransport();
        showNotice("Wi-Fi 快传已关闭");
      } else {
        await client.openWifiTransport();
        showNotice("Wi-Fi 快传已连接");
      }
    });
  }

  function downloadFile(file: DeviceFile) {
    if (recordState !== 0) {
      showNotice("停止录音后才能下载文件");
      return;
    }
    enqueueDownloads([file], true);
  }

  function cancelDownload(fileName: string) {
    downloadQueueRef.current = [];
    setDownloadQueueCount(0);
    setActiveDownloadName("");
    setDownloadProgress((previous) => {
      const next = { ...previous };
      delete next[fileName];
      return next;
    });
    showNotice("下载已取消");
    void client.cancelDownload().catch(() => undefined);
  }

  function confirmDelete(file: DeviceFile) {
    if (
      downloading ||
      (recordState !== 0 && file.fileName === currentFileName)
    ) {
      showNotice("当前录音或下载中的文件不能移入回收站");
      return;
    }
    storeOrganization(
      folders,
      folderAssignments,
      trashFiles(trashedFiles, [file]),
    );
    showNotice("已移入回收站");
  }

  function restoreFromTrash(names: string[]) {
    const restored = names.map((name) => trashedFiles[name]).filter(Boolean);
    setFiles((previous) => {
      const merged = new Map(previous.map((file) => [file.fileName, file]));
      restored.forEach((file) => {
        if (!merged.has(file.fileName)) merged.set(file.fileName, file);
      });
      return Array.from(merged.values());
    });
    storeOrganization(
      folders,
      folderAssignments,
      restoreFiles(trashedFiles, names),
    );
    showNotice(
      names.length > 1 ? `已恢复 ${names.length} 条录音` : "已恢复录音",
    );
  }

  function permanentlyDelete(targets: DeviceFile[]) {
    if (downloading) {
      showNotice("下载期间不能永久删除");
      return;
    }
    Alert.alert(
      "永久删除",
      `确定从手机永久删除 ${targets.length} 条录音？录音笔中的原件仍会保留，可再次导入。`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "永久删除",
          style: "destructive",
          onPress: () =>
            void runAction("permanentDelete", async () => {
              const nextTrash = { ...trashedFiles };
              const nextAssignments = { ...folderAssignments };
              const nextDismissed = { ...dismissedFiles };
              for (const file of targets) {
                const path =
                  downloadedPathsRef.current[file.fileName] ||
                  client.getLocalFilePath(file.fileName);
                if (await RNFS.exists(path)) await RNFS.unlink(path);
                const nextLocal = { ...localFilesRef.current };
                delete nextLocal[file.fileName];
                localFilesRef.current = nextLocal;
                NativeLocalStorage?.setItem(
                  LOCAL_FILES_KEY,
                  JSON.stringify(nextLocal),
                );
                const nextPaths = { ...downloadedPathsRef.current };
                delete nextPaths[file.fileName];
                storeDownloadedPaths(nextPaths);
                setFiles((previous) =>
                  previous.filter((entry) => entry.fileName !== file.fileName),
                );
                delete nextTrash[file.fileName];
                delete nextAssignments[file.fileName];
                nextDismissed[file.fileName] = true;
                storeOrganization(
                  folders,
                  { ...nextAssignments },
                  { ...nextTrash },
                  { ...nextDismissed },
                );
              }
              leaveSelectionMode();
              showNotice("已永久删除");
            }),
        },
      ],
    );
  }

  function browseDeviceFiles() {
    if (recordState !== 0 || downloading)
      return showNotice("录音或下载结束后再导入设备文件");
    if (!client.isConnected()) return showNotice("连接录音笔后才能导入");
    void runAction("browseDevice", async () => {
      const remote = await client.queryFileList();
      setImportCandidates(remote);
      setFolderDrawerVisible(false);
    });
  }

  function importDeviceFile(file: DeviceFile) {
    const nextDismissed = { ...dismissedFiles };
    delete nextDismissed[file.fileName];
    const nextTrash = restoreFiles(trashedFiles, [file.fileName]);
    storeOrganization(folders, folderAssignments, nextTrash, nextDismissed);
    setFiles((previous) => {
      const merged = new Map(previous.map((entry) => [entry.fileName, entry]));
      merged.set(file.fileName, { ...file, onDevice: true });
      return Array.from(merged.values());
    });
    setImportCandidates(null);
    if (recordState === 0) enqueueDownloads([file], true);
    showNotice(
      recordState === 0 ? "已加入下载队列" : "已加入文件列表，录音结束后可下载",
    );
  }

  function saveFolder() {
    const name = folderDraft.trim();
    if (!name) return showNotice("请输入文件夹名称");
    if (
      folders.some(
        (folder) =>
          folder.name === name &&
          folder.id !== (folderDialog === "new" ? "" : folderDialog?.id),
      )
    ) {
      return showNotice("文件夹名称已存在");
    }
    const next =
      folderDialog === "new"
        ? [...folders, { id: `folder-${Date.now()}`, name }]
        : folders.map((folder) =>
            folder.id === folderDialog?.id ? { ...folder, name } : folder,
          );
    storeOrganization(next, folderAssignments, trashedFiles);
    setFolderDialog(null);
    setFolderDraft("");
  }

  function deleteFolder(folder: Folder) {
    Alert.alert(
      "删除文件夹",
      `删除“${folder.name}”后，其中的录音会回到全部文件，不会删除录音。`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "删除文件夹",
          onPress: () => {
            const next = { ...folderAssignments };
            Object.keys(next).forEach((name) => {
              if (next[name] === folder.id) delete next[name];
            });
            storeOrganization(
              folders.filter((item) => item.id !== folder.id),
              next,
              trashedFiles,
            );
            if (fileLocation === folder.id) setFileLocation("all");
          },
        },
      ],
    );
  }

  function assignFolder(folderId: string | null) {
    if (!moveFiles) return;
    const next = { ...folderAssignments };
    moveFiles.forEach((file) => {
      if (folderId) next[file.fileName] = folderId;
      else delete next[file.fileName];
    });
    storeOrganization(folders, next, trashedFiles);
    setMoveFiles(null);
    setDetailFile(null);
    leaveSelectionMode();
    showNotice("已整理到文件夹");
  }

  function openFolderDialog(folder: Folder | "new") {
    setFolderDrawerVisible(false);
    setFolderDraft(folder === "new" ? "" : folder.name);
    setTimeout(() => mountedRef.current && setFolderDialog(folder), 320);
  }

  function openMoveDialog(file: DeviceFile) {
    setDetailFile(null);
    setTimeout(() => mountedRef.current && setMoveFiles([file]), 320);
  }

  function selectAnc(value: number) {
    setAncSheetVisible(false);
    if (recordState !== 0 || downloading) {
      showNotice("录音或文件传输期间不能修改设置");
      return;
    }
    void runAction("anc", async () => {
      await client.setAnc(value);
      setInfo((previous) => ({ ...previous, ancLevel: value }));
      showNotice("降噪等级已更新");
    });
  }

  function selectSplit(value: number) {
    setSplitSheetVisible(false);
    if (recordState !== 0 || downloading) {
      showNotice("录音或文件传输期间不能修改设置");
      return;
    }
    void runAction("split", async () => {
      await client.setSplit(value);
      setInfo((previous) => ({ ...previous, split: value }));
      showNotice("分段时长已更新");
    });
  }

  function updateDeletePolicy(value: boolean) {
    deleteAfterDownloadRef.current = value;
    setDeleteAfterDownload(value);
    try {
      NativeLocalStorage?.setItem(DELETE_AFTER_DOWNLOAD_KEY, value ? "1" : "0");
    } catch (_) {}
  }

  function updateAutoDownload(value: boolean) {
    autoDownloadRef.current = value;
    setAutoDownload(value);
    try {
      NativeLocalStorage?.setItem(AUTO_DOWNLOAD_KEY, value ? "1" : "0");
    } catch (_) {}
    if (value && recordState === 0) {
      enqueueDownloads(files.filter((file) => deviceFileNames[file.fileName]));
    }
  }

  function beginRename(file: DeviceFile) {
    setDetailFile(null);
    setRenameFile(file);
    setRenameDraft(fileAliases[file.fileName] || "");
  }

  function saveAlias() {
    if (!renameFile) return;
    const alias = renameDraft.trim().slice(0, 40);
    const next = { ...fileAliases };
    if (alias) next[renameFile.fileName] = alias;
    else delete next[renameFile.fileName];
    setFileAliases(next);
    try {
      NativeLocalStorage?.setItem(FILE_ALIASES_KEY, JSON.stringify(next));
    } catch (_) {}
    setRenameFile(null);
    setRenameDraft("");
  }

  function toggleFileSelection(fileName: string) {
    setSelectedFiles((previous) => ({
      ...previous,
      [fileName]: !previous[fileName],
    }));
  }

  function enterSelectionMode(fileName = "") {
    selectionModeRef.current = true;
    setSelectionMode(true);
    if (fileName) toggleFileSelection(fileName);
  }

  function toggleSelectAllVisible() {
    setSelectedFiles((previous) => {
      const next = { ...previous };
      visibleFiles.forEach((file) => {
        if (allVisibleSelected) delete next[file.fileName];
        else next[file.fileName] = true;
      });
      return next;
    });
  }

  function leaveSelectionMode() {
    selectionModeRef.current = false;
    setSelectionMode(false);
    setSelectedFiles({});
  }

  function getSelectedDeviceFiles() {
    return visibleFiles.filter((file) => selectedFiles[file.fileName]);
  }

  function downloadSelectedFiles() {
    if (recordState !== 0) {
      showNotice("停止录音后才能下载文件");
      return;
    }
    const selected = getSelectedDeviceFiles().filter(
      (file) => deviceFileNames[file.fileName],
    );
    if (!selected.length) {
      showNotice("请先选择文件");
      return;
    }
    enqueueDownloads(selected, true);
    leaveSelectionMode();
  }

  function deleteSelectedFiles() {
    if (downloading) {
      showNotice("下载期间不能移动文件");
      return;
    }
    const selected = getSelectedDeviceFiles();
    if (!selected.length) {
      showNotice("请先选择文件");
      return;
    }
    if (fileLocation === "trash") permanentlyDelete(selected);
    else {
      if (
        selected.some(
          (file) => recordState !== 0 && file.fileName === currentFileName,
        )
      ) {
        return showNotice("当前录音不能移入回收站");
      }
      storeOrganization(
        folders,
        folderAssignments,
        trashFiles(trashedFiles, selected),
      );
      leaveSelectionMode();
      showNotice(`已将 ${selected.length} 条录音移入回收站`);
    }
  }

  function openFutureFeature(tab: AiTab, file: DeviceFile) {
    setDetailFile(null);
    setAiWorkspace({ file, tab });
  }

  function openFileDetails(file: DeviceFile) {
    if (selectionModeRef.current) {
      toggleFileSelection(file.fileName);
      return;
    }
    setDetailFile(file);
  }

  function openPlayer(file: DeviceFile) {
    const path = downloadedPaths[file.fileName];
    if (!path) {
      downloadFile(file);
      return;
    }
    setPlayingFile(file);
    setPlayerPaused(false);
    setPlayerPosition(0);
    setPlayerDuration(file.duration || 0);
  }

  function renderFile(file: DeviceFile) {
    const progress = downloadProgress[file.fileName] || 0;
    const path = downloadedPaths[file.fileName];
    const downloading = activeDownloadName === file.fileName;
    return (
      <View
        key={file.fileName}
        style={[
          styles.fileCard,
          selectionMode &&
            selectedFiles[file.fileName] &&
            styles.fileCardSelected,
        ]}
      >
        <TouchableOpacity
          style={styles.fileMain}
          onPress={() => openFileDetails(file)}
        >
          <View style={styles.fileIcon}>
            <Feather name={path ? "play" : "mic"} size={20} color="#3478F6" />
          </View>
          <View style={styles.fileText}>
            <Text numberOfLines={1} style={styles.fileTitle}>
              {fileAliases[file.fileName] || formatFileDate(file.fileName)}
            </Text>
            <Text numberOfLines={1} style={styles.fileMeta}>
              {formatClock(file.duration)} · {formatSize(file.size)} ·{" "}
              {file.fileType === 0 ? "通话" : "笔记"} ·{" "}
              {path ? "本机" : deviceFileNames[file.fileName] ? "设备" : "本机"}
            </Text>
            {downloading ? (
              <View style={styles.progressTrack}>
                <View
                  style={[styles.progressFill, { width: `${progress}%` }]}
                />
              </View>
            ) : null}
          </View>
        </TouchableOpacity>
        {selectionMode ? (
          <TouchableOpacity
            accessibilityLabel={
              selectedFiles[file.fileName] ? "取消选择" : "选择文件"
            }
            style={styles.selectionHitArea}
            onPress={() => toggleFileSelection(file.fileName)}
          >
            <View
              style={[
                styles.selectionCircle,
                selectedFiles[file.fileName] && styles.selectionCircleActive,
              ]}
            >
              {selectedFiles[file.fileName] ? (
                <Feather name="check" size={15} color="#FFFFFF" />
              ) : null}
            </View>
          </TouchableOpacity>
        ) : (
          <View style={styles.fileActions}>
            <TouchableOpacity
              accessibilityLabel={
                downloading ? "取消下载" : path ? "播放录音" : "下载录音"
              }
              disabled={busy && !downloading}
              style={styles.iconButton}
              onPress={() =>
                downloading ? cancelDownload(file.fileName) : openPlayer(file)
              }
            >
              {downloading ? (
                <Feather name="x-circle" size={20} color="#B43B3B" />
              ) : (
                <Feather
                  name={path ? "play-circle" : "download"}
                  size={20}
                  color="#34423C"
                />
              )}
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityLabel="移入回收站"
              disabled={busy}
              style={styles.iconButton}
              onPress={() => confirmDelete(file)}
            >
              <Feather name="trash-2" size={19} color="#8A3434" />
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  }

  function renderRecordTab() {
    return (
      <View
        style={[
          styles.recordPage,
          { minHeight: Math.max(520, viewportHeight - 148) },
        ]}
      >
        <View style={styles.recordStage}>
          <Text numberOfLines={1} style={styles.recordStageTitle}>
            {currentFileName ? formatFileDate(currentFileName) : deviceTitle}
          </Text>
          <View style={styles.recordStageTrack}>
            {recordState !== 0 ? (
              <View style={styles.liveWaveform}>
                {LIVE_WAVE_BARS.map((baseHeight, index) => {
                  const alternate =
                    LIVE_WAVE_BARS[(index * 7 + 5) % LIVE_WAVE_BARS.length];
                  const height = recording
                    ? recordingWaveProgress.interpolate({
                        inputRange: [0, 0.25, 0.5, 0.75, 1],
                        outputRange: [
                          baseHeight,
                          alternate,
                          Math.max(16, 76 - baseHeight),
                          LIVE_WAVE_BARS[(index + 11) % LIVE_WAVE_BARS.length],
                          baseHeight,
                        ],
                      })
                    : baseHeight;
                  return (
                    <Animated.View
                      key={index}
                      style={[styles.liveWaveBar, { height }]}
                    />
                  );
                })}
              </View>
            ) : (
              <Feather name="mic" size={34} color="#AFB9C7" />
            )}
          </View>
        </View>
        <View style={styles.recordConsole}>
          <Text style={styles.recordStateText}>
            {recording
              ? "正在录音"
              : paused
                ? "已暂停"
                : connected
                  ? "准备录音"
                  : "设备未连接"}
          </Text>
          <Text style={styles.timer}>{formatClock(recordSeconds)}</Text>
          {!connected ? (
            <TouchableOpacity style={styles.connectButton} onPress={reconnect}>
              {action === "connect" ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Feather name="bluetooth" size={18} color="#FFFFFF" />
              )}
              <Text style={styles.connectButtonText}>重新连接</Text>
            </TouchableOpacity>
          ) : recordState === 0 ? (
            <TouchableOpacity
              accessibilityLabel="开始录音"
              disabled={busy || downloading}
              style={[
                styles.recordButton,
                (busy || downloading) && styles.buttonDisabled,
              ]}
              onPress={startRecording}
            >
              {action === "record" ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Feather name="mic" size={29} color="#FFFFFF" />
              )}
            </TouchableOpacity>
          ) : (
            <View style={styles.recordControls}>
              <TouchableOpacity
                accessibilityLabel={paused ? "继续录音" : "暂停录音"}
                disabled={busy}
                style={styles.recordPauseButton}
                onPress={paused ? resumeRecording : pauseRecording}
              >
                <Feather
                  name={paused ? "play" : "pause"}
                  size={29}
                  color="#FFFFFF"
                />
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityLabel="停止录音"
                disabled={busy}
                style={styles.recordFinishButton}
                onPress={stopRecording}
              >
                {action === "stop" ? (
                  <ActivityIndicator color="#3478F6" />
                ) : (
                  <Text style={styles.recordFinishText}>结束</Text>
                )}
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    );
  }

  function renderFilesTab() {
    return (
      <>
        <View style={styles.sectionHeader}>
          <View>
            <View style={styles.fileHeading}>
              {!selectionMode ? (
                <TouchableOpacity
                  accessibilityLabel="文件夹和回收站"
                  style={styles.folderMenuButton}
                  onPress={() => setFolderDrawerVisible(true)}
                >
                  <Feather name="menu" size={21} color="#27313A" />
                </TouchableOpacity>
              ) : null}
              <Text style={styles.pageTitle}>
                {selectionMode
                  ? `已选择 ${selectedCount} 项`
                  : fileLocation === "trash"
                    ? `回收站（${Object.keys(trashedFiles).length}）`
                    : fileLocation === "all"
                      ? `全部文件（${
                          activeFiles(
                            files,
                            trashedFiles,
                            "all",
                            folderAssignments,
                            dismissedFiles,
                          ).length
                        }）`
                      : `${
                          folders.find((folder) => folder.id === fileLocation)
                            ?.name || "文件夹"
                        }（${visibleFiles.length}）`}
              </Text>
            </View>
            <Text style={styles.pageSubtitle}>
              {selectionMode
                ? "点击文件可切换选择"
                : fileLocation === "trash"
                  ? "永久删除只影响手机，录音笔原件仍保留"
                  : `手机 ${
                      Object.keys(downloadedPaths).length
                    } · 设备 ${deviceFileCount}${
                      wifiReady ? " · Wi-Fi 快传" : ""
                    }${
                      downloadQueueCount
                        ? ` · ${downloadQueueCount} 个待下载`
                        : ""
                    }`}
            </Text>
          </View>
          <View style={styles.headerActions}>
            {selectionMode ? (
              <>
                <TouchableOpacity
                  style={styles.headerTextButton}
                  onPress={toggleSelectAllVisible}
                >
                  <Text style={styles.headerTextButtonLabel}>
                    {allVisibleSelected ? "取消全选" : "全选"}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.headerTextButton}
                  onPress={leaveSelectionMode}
                >
                  <Text style={styles.headerCancelLabel}>完成</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                {fileLocation !== "trash" ? (
                  <TouchableOpacity
                    accessibilityLabel={
                      wifiReady ? "关闭 Wi-Fi 快传" : "开启 Wi-Fi 快传"
                    }
                    disabled={wifiBusy || downloading || recordState !== 0}
                    style={styles.iconButton}
                    onPress={toggleWifiTransfer}
                  >
                    {wifiBusy ? (
                      <ActivityIndicator size="small" color="#3478F6" />
                    ) : (
                      <Feather
                        name="wifi"
                        size={20}
                        color={wifiReady ? "#3478F6" : "#34423C"}
                      />
                    )}
                  </TouchableOpacity>
                ) : null}
                {fileLocation === "trash" &&
                Object.keys(trashedFiles).length ? (
                  <TouchableOpacity
                    accessibilityLabel="清空回收站"
                    style={styles.iconButton}
                    onPress={() =>
                      permanentlyDelete(Object.values(trashedFiles))
                    }
                  >
                    <Feather name="trash-2" size={19} color="#963F46" />
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity
                  style={styles.headerTextButton}
                  onPress={() => enterSelectionMode()}
                >
                  <Text style={styles.headerTextButtonLabel}>选择</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityLabel="刷新文件列表"
                  style={styles.iconButton}
                  onPress={() => void refreshDevice()}
                >
                  {refreshing ? (
                    <ActivityIndicator size="small" color="#34423C" />
                  ) : (
                    <Feather name="refresh-cw" size={19} color="#34423C" />
                  )}
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
        {!selectionMode ? (
          <>
            <View style={styles.searchBox}>
              <Feather name="search" size={17} color="#7A8580" />
              <TextInput
                value={searchText}
                onChangeText={setSearchText}
                placeholder="搜索名称或时间"
                placeholderTextColor="#9AA39F"
                style={styles.searchInput}
              />
              {searchText ? (
                <TouchableOpacity
                  accessibilityLabel="清除搜索"
                  onPress={() => setSearchText("")}
                >
                  <Feather name="x-circle" size={17} color="#8B9590" />
                </TouchableOpacity>
              ) : null}
            </View>
            <View style={styles.filterRow}>
              {[
                { key: "all", label: "全部" },
                { key: "call", label: "通话" },
                { key: "note", label: "笔记" },
              ].map((item) => (
                <TouchableOpacity
                  key={item.key}
                  style={[
                    styles.filterButton,
                    fileFilter === item.key && styles.filterButtonActive,
                  ]}
                  onPress={() =>
                    setFileFilter(item.key as "all" | "call" | "note")
                  }
                >
                  <Text
                    style={[
                      styles.filterText,
                      fileFilter === item.key && styles.filterTextActive,
                    ]}
                  >
                    {item.label}
                  </Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                accessibilityLabel={
                  sortNewestFirst ? "当前最新优先" : "当前最早优先"
                }
                style={styles.sortButton}
                onPress={() => setSortNewestFirst((value) => !value)}
              >
                <Feather
                  name={sortNewestFirst ? "arrow-down" : "arrow-up"}
                  size={16}
                  color="#52605A"
                />
                <Text style={styles.sortText}>
                  {sortNewestFirst ? "最新" : "最早"}
                </Text>
              </TouchableOpacity>
            </View>
          </>
        ) : null}
        {visibleFiles.length ? (
          visibleFiles.map((file) =>
            fileLocation === "trash" ? (
              <View key={file.fileName} style={styles.fileCard}>
                <TouchableOpacity
                  style={styles.fileMain}
                  onPress={() =>
                    selectionMode
                      ? toggleFileSelection(file.fileName)
                      : restoreFromTrash([file.fileName])
                  }
                >
                  <View style={styles.fileIcon}>
                    <Feather name="file-text" size={20} color="#89909A" />
                  </View>
                  <View style={styles.fileText}>
                    <Text numberOfLines={1} style={styles.fileTitle}>
                      {fileAliases[file.fileName] ||
                        formatFileDate(file.fileName)}
                    </Text>
                    <Text style={styles.fileMeta}>
                      {formatClock(file.duration)} · {formatSize(file.size)}
                    </Text>
                  </View>
                </TouchableOpacity>
                {selectionMode ? (
                  <TouchableOpacity
                    style={styles.selectionHitArea}
                    onPress={() => toggleFileSelection(file.fileName)}
                  >
                    <Feather
                      name={
                        selectedFiles[file.fileName] ? "check-circle" : "circle"
                      }
                      size={23}
                      color="#3478F6"
                    />
                  </TouchableOpacity>
                ) : (
                  <View style={styles.fileActions}>
                    <TouchableOpacity
                      accessibilityLabel="恢复录音"
                      style={styles.iconButton}
                      onPress={() => restoreFromTrash([file.fileName])}
                    >
                      <Feather name="rotate-ccw" size={19} color="#3478F6" />
                    </TouchableOpacity>
                    <TouchableOpacity
                      accessibilityLabel="永久删除"
                      style={styles.iconButton}
                      onPress={() => permanentlyDelete([file])}
                    >
                      <Feather name="trash-2" size={19} color="#963F46" />
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            ) : (
              renderFile(file)
            ),
          )
        ) : (
          <Text style={styles.emptyText}>
            {fileLocation === "trash" ? "回收站是空的" : "没有符合条件的录音"}
          </Text>
        )}
      </>
    );
  }

  function renderSettingRow(
    title: string,
    value: string,
    onPress?: () => void,
  ) {
    const settingDisabled =
      Boolean(onPress) && (busy || downloading || recordState !== 0);
    return (
      <TouchableOpacity
        disabled={!onPress || settingDisabled}
        style={[
          styles.settingRow,
          settingDisabled && styles.settingRowDisabled,
        ]}
        onPress={onPress}
      >
        <Text style={styles.settingTitle}>{title}</Text>
        <Text style={styles.settingValue}>{value}</Text>
        {onPress ? (
          <Feather name="chevron-right" size={19} color="#9AA39F" />
        ) : null}
      </TouchableOpacity>
    );
  }

  function renderSettingsTab() {
    return (
      <>
        <View style={styles.deviceOverview}>
          <Image
            source={require("../../WorkSpace/NewCozylifeCN/src/assets/ai-m8.png")}
            style={styles.devicePhoto}
            resizeMode="contain"
          />
          <Text numberOfLines={1} style={styles.deviceOverviewTitle}>
            {deviceTitle}
          </Text>
          <View
            style={[
              styles.deviceStatusBadge,
              !connected && !wifiReady && styles.deviceStatusBadgeOffline,
            ]}
          >
            <View
              style={[
                styles.deviceStatusDot,
                !connected && !wifiReady && styles.deviceStatusDotOffline,
              ]}
            />
            <Text
              style={[
                styles.deviceStatusLabel,
                !connected && !wifiReady && styles.deviceStatusLabelOffline,
              ]}
            >
              {wifiReady ? "Wi-Fi 快传已连接" : connected ? "已连接" : "未连接"}
            </Text>
          </View>
        </View>
        <View style={styles.settingGroup}>
          <View style={styles.settingRow}>
            <View style={styles.settingTextBlock}>
              <Text style={styles.settingTitle}>电池电量</Text>
            </View>
            <Text style={styles.deviceBatteryValue}>
              {info.firmware === "--" ? "--" : `${info.battery}%`}
            </Text>
          </View>
        </View>

        <Text style={styles.settingsGroupTitle}>通用</Text>
        <View style={styles.settingGroup}>
          {renderSettingRow("名称", deviceTitle, () =>
            editPanel(launch.deviceId),
          )}
          {renderSettingRow("序列号", deviceSn || "--")}
          {renderSettingRow("固件版本", info.firmware)}
        </View>

        <Text style={styles.settingsGroupTitle}>高级录音设置</Text>
        <View style={styles.settingGroup}>
          {renderSettingRow(
            "降噪等级",
            getOptionLabel(ANC_LEVELS, info.ancLevel),
            () => setAncSheetVisible(true),
          )}
          {renderSettingRow(
            "分段录音时长",
            getOptionLabel(SPLIT_OPTIONS, info.split),
            () => setSplitSheetVisible(true),
          )}
        </View>

        <Text style={styles.settingsGroupTitle}>文件管理</Text>
        <View style={styles.settingGroup}>
          {renderSettingRow(
            "Wi-Fi 快传",
            wifiReady
              ? "已连接"
              : wifiBusy
                ? "连接中"
                : wifiTransfer.state === "error"
                  ? "连接失败"
                  : "未连接",
            toggleWifiTransfer,
          )}
          <View style={styles.settingRow}>
            <View style={styles.settingTextBlock}>
              <Text style={styles.settingTitle}>自动下载新录音</Text>
              <Text style={styles.settingHint}>
                设备连接后保存尚未下载的录音
              </Text>
            </View>
            <Switch
              value={autoDownload}
              onValueChange={updateAutoDownload}
              trackColor={{ false: "#D8DDDA", true: "#79A7FF" }}
              thumbColor={autoDownload ? "#2467E8" : "#FFFFFF"}
            />
          </View>
          <View style={styles.settingRow}>
            <View style={styles.settingTextBlock}>
              <Text style={styles.settingTitle}>下载后清理设备</Text>
              <Text style={styles.settingHint}>
                文件完整保存到手机后删除设备原件
              </Text>
            </View>
            <Switch
              value={deleteAfterDownload}
              onValueChange={updateDeletePolicy}
              trackColor={{ false: "#D8DDDA", true: "#79A7FF" }}
              thumbColor={deleteAfterDownload ? "#2467E8" : "#FFFFFF"}
            />
          </View>
        </View>
      </>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#F5F7F5" />
      <View style={styles.header}>
        <View style={styles.panelHeaderSide}>
          <TouchableOpacity
            accessibilityLabel="返回"
            style={styles.iconButton}
            onPress={() =>
              tab === "settings" ? setTab("files") : closePanel(launch.deviceId)
            }
          >
            <Feather name="chevron-left" size={25} color="#17201C" />
          </TouchableOpacity>
        </View>
        <View style={styles.headerTitleBlock}>
          <Text numberOfLines={1} style={styles.headerTitle}>
            {tab === "settings" ? "设备详情" : deviceTitle}
          </Text>
          {tab !== "settings" ? (
            <View style={styles.connectionLine}>
              <View
                style={[
                  styles.statusDot,
                  !connected && !wifiReady && styles.statusDotOffline,
                ]}
              />
              <Text style={styles.connectionText}>
                {wifiReady
                  ? "Wi-Fi 快传已连接"
                  : connected
                    ? "已连接"
                    : "未连接"}
              </Text>
            </View>
          ) : null}
        </View>
        <View style={styles.panelHeaderActions}>
          {tab !== "settings" ? (
            <TouchableOpacity
              accessibilityLabel="设备设置"
              style={styles.iconButton}
              onPress={() => editPanel(launch.deviceId)}
            >
              <Feather name="settings" size={19} color="#34423C" />
            </TouchableOpacity>
          ) : null}
          {tab !== "settings" ? (
            <TouchableOpacity
              accessibilityLabel="刷新设备"
              style={styles.iconButton}
              onPress={() => void refreshDevice()}
            >
              {loading || refreshing || action === "connect" ? (
                <ActivityIndicator size="small" color="#34423C" />
              ) : (
                <Feather name="rotate-cw" size={19} color="#34423C" />
              )}
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {notice ? (
        <View style={styles.noticeBar}>
          <Feather name="info" size={16} color="#FFFFFF" />
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      ) : null}

      <ScrollView
        contentContainerStyle={[
          styles.content,
          tab === "record" && styles.recordContent,
        ]}
        showsVerticalScrollIndicator={false}
      >
        {tab === "record"
          ? renderRecordTab()
          : tab === "files"
            ? renderFilesTab()
            : renderSettingsTab()}
      </ScrollView>

      {tab === "files" && selectionMode ? (
        <View style={styles.selectionBottomBar}>
          {fileLocation !== "trash" ? (
            <TouchableOpacity
              disabled={!selectedCount}
              style={styles.selectionBottomAction}
              onPress={() => setMoveFiles(getSelectedDeviceFiles())}
            >
              <Feather
                name="folder"
                size={22}
                color={selectedCount ? "#3478F6" : "#B3BBB7"}
              />
              <Text style={styles.selectionBottomLabel}>移动</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            disabled={
              fileLocation === "trash"
                ? !selectedCount
                : !selectedDownloadCount || downloading
            }
            style={styles.selectionBottomAction}
            onPress={
              fileLocation === "trash"
                ? () => {
                    restoreFromTrash(
                      getSelectedDeviceFiles().map((file) => file.fileName),
                    );
                    leaveSelectionMode();
                  }
                : downloadSelectedFiles
            }
          >
            <Feather
              name={fileLocation === "trash" ? "rotate-ccw" : "download"}
              size={22}
              color={
                (fileLocation === "trash"
                  ? selectedCount
                  : selectedDownloadCount) && !downloading
                  ? "#2467E8"
                  : "#B3BBB7"
              }
            />
            <Text
              style={[
                styles.selectionBottomLabel,
                (!selectedDownloadCount || downloading) &&
                  styles.selectionBottomLabelDisabled,
              ]}
            >
              {fileLocation === "trash" ? "恢复" : "下载"}
              {(
                fileLocation === "trash" ? selectedCount : selectedDownloadCount
              )
                ? ` (${
                    fileLocation === "trash"
                      ? selectedCount
                      : selectedDownloadCount
                  })`
                : ""}
            </Text>
          </TouchableOpacity>
          <View style={styles.selectionBottomDivider} />
          <TouchableOpacity
            disabled={!selectedDeviceCount || downloading}
            style={styles.selectionBottomAction}
            onPress={deleteSelectedFiles}
          >
            <Feather
              name="trash-2"
              size={22}
              color={
                selectedDeviceCount && !downloading ? "#A13D3D" : "#B3BBB7"
              }
            />
            <Text
              style={[
                styles.selectionBottomLabel,
                styles.selectionBottomDeleteLabel,
                (!selectedDeviceCount || downloading) &&
                  styles.selectionBottomLabelDisabled,
              ]}
            >
              {fileLocation === "trash" ? "永久删除" : "回收站"}
              {selectedDeviceCount ? ` (${selectedDeviceCount})` : ""}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.tabBar}>
          {[
            { key: "files" as TabKey, label: "文件", icon: "folder" },
            { key: "record" as TabKey, label: "录音", icon: "mic" },
            { key: "settings" as TabKey, label: "设置", icon: "sliders" },
          ].map((item) => {
            const active = tab === item.key;
            const recorder = item.key === "record";
            return (
              <TouchableOpacity
                key={item.key}
                accessibilityLabel={item.label}
                style={[styles.tabButton, recorder && styles.recorderTabButton]}
                onPress={() => (recorder ? openRecorder() : setTab(item.key))}
              >
                {recorder ? (
                  <View
                    style={[
                      styles.recorderTabIcon,
                      active && styles.recorderTabIconActive,
                    ]}
                  >
                    <Feather name="mic" size={26} color="#FFFFFF" />
                  </View>
                ) : (
                  <>
                    <Feather
                      name={item.icon}
                      size={21}
                      color={active ? "#3478F6" : "#8A8F98"}
                    />
                    <Text
                      style={[styles.tabLabel, active && styles.tabLabelActive]}
                    >
                      {item.label}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      <OptionSheet
        title="降噪等级"
        visible={ancSheetVisible}
        options={ANC_LEVELS}
        selected={info.ancLevel}
        onClose={() => setAncSheetVisible(false)}
        onSelect={selectAnc}
      />
      <OptionSheet
        title="分段录音时长"
        visible={splitSheetVisible}
        options={SPLIT_OPTIONS}
        selected={info.split}
        onClose={() => setSplitSheetVisible(false)}
        onSelect={selectSplit}
      />

      <Modal
        transparent
        animationType="slide"
        visible={Boolean(detailFile)}
        onRequestClose={() => setDetailFile(null)}
      >
        <TouchableOpacity
          activeOpacity={1}
          style={styles.modalBackdrop}
          onPress={() => setDetailFile(null)}
        >
          <View style={styles.detailSheet}>
            <View style={styles.sheetHeader}>
              <View style={styles.playerTitleBlock}>
                <Text numberOfLines={1} style={styles.sheetTitle}>
                  {detailFile
                    ? fileAliases[detailFile.fileName] ||
                      formatFileDate(detailFile.fileName)
                    : "录音详情"}
                </Text>
                <Text style={styles.playerFileName}>
                  {detailFile
                    ? `${formatClock(detailFile.duration)} · ${formatSize(
                        detailFile.size,
                      )} · ${detailFile.fileType === 0 ? "通话" : "笔记"}`
                    : ""}
                </Text>
              </View>
              <TouchableOpacity
                accessibilityLabel="关闭详情"
                style={styles.iconButton}
                onPress={() => setDetailFile(null)}
              >
                <Feather name="x" size={21} color="#1D2622" />
              </TouchableOpacity>
            </View>
            {detailFile ? (
              <>
                <View style={styles.detailActions}>
                  <TouchableOpacity
                    style={styles.detailPrimaryAction}
                    onPress={() => {
                      const file = detailFile;
                      setDetailFile(null);
                      openPlayer(file);
                    }}
                  >
                    <Feather
                      name={
                        downloadedPaths[detailFile.fileName]
                          ? "play"
                          : "download"
                      }
                      size={19}
                      color="#FFFFFF"
                    />
                    <Text style={styles.detailPrimaryText}>
                      {downloadedPaths[detailFile.fileName]
                        ? "播放录音"
                        : "下载到手机"}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.detailSecondaryAction}
                    onPress={() => beginRename(detailFile)}
                  >
                    <Feather name="edit-3" size={18} color="#34423C" />
                    <Text style={styles.detailSecondaryText}>重命名</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.detailIconAction}
                    accessibilityLabel="移动到文件夹"
                    onPress={() => openMoveDialog(detailFile)}
                  >
                    <Feather name="folder" size={19} color="#3478F6" />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.detailIconAction}
                    accessibilityLabel="移入回收站"
                    onPress={() => {
                      const file = detailFile;
                      setDetailFile(null);
                      confirmDelete(file);
                    }}
                  >
                    <Feather name="trash-2" size={19} color="#8A3434" />
                  </TouchableOpacity>
                </View>
                <Text style={styles.futureTitle}>AI 内容</Text>
                <View style={styles.futureGrid}>
                  {[
                    { tab: "transcript", title: "转写", icon: "file-text" },
                    { tab: "summary", title: "AI 总结", icon: "align-left" },
                    { tab: "mindmap", title: "思维导图", icon: "share-2" },
                  ].map((item) => (
                    <TouchableOpacity
                      key={item.tab}
                      style={styles.futureAction}
                      onPress={() =>
                        openFutureFeature(item.tab as AiTab, detailFile)
                      }
                    >
                      <View style={styles.futureIcon}>
                        <Feather name={item.icon} size={20} color="#3478F6" />
                      </View>
                      <Text style={styles.futureActionTitle}>{item.title}</Text>
                      <Text style={styles.futureActionState}>
                        {downloadedPaths[detailFile.fileName]
                          ? "打开"
                          : "下载后可用"}
                      </Text>
                      <Feather name="chevron-right" size={18} color="#9AA39F" />
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            ) : null}
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={folderDrawerVisible}
        onRequestClose={() => setFolderDrawerVisible(false)}
      >
        <View style={styles.drawerBackdrop}>
          <View style={styles.folderDrawer}>
            <Text style={styles.drawerTitle}>文件</Text>
            <TouchableOpacity
              style={styles.drawerRow}
              onPress={() => {
                setFileLocation("all");
                setFolderDrawerVisible(false);
                leaveSelectionMode();
              }}
            >
              <Feather name="folder" size={19} color="#3478F6" />
              <Text style={styles.drawerRowText}>全部文件</Text>
              <Text style={styles.drawerCount}>
                {
                  activeFiles(
                    files,
                    trashedFiles,
                    "all",
                    folderAssignments,
                    dismissedFiles,
                  ).length
                }
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.drawerRow}
              onPress={() => {
                setFileLocation("trash");
                setFolderDrawerVisible(false);
                leaveSelectionMode();
              }}
            >
              <Feather name="trash-2" size={19} color="#35A8A7" />
              <Text style={styles.drawerRowText}>回收站</Text>
              <Text style={styles.drawerCount}>
                {Object.keys(trashedFiles).length}
              </Text>
            </TouchableOpacity>
            <Text style={styles.drawerSection}>文件夹</Text>
            <ScrollView style={styles.folderScroll}>
              {folders.map((folder) => (
                <View key={folder.id} style={styles.drawerRow}>
                  <TouchableOpacity
                    style={styles.drawerFolderHit}
                    onPress={() => {
                      setFileLocation(folder.id);
                      setFolderDrawerVisible(false);
                      leaveSelectionMode();
                    }}
                  >
                    <Feather name="folder" size={18} color="#8C949D" />
                    <Text numberOfLines={1} style={styles.drawerRowText}>
                      {folder.name}
                    </Text>
                    <Text style={styles.drawerCount}>
                      {
                        activeFiles(
                          files,
                          trashedFiles,
                          folder.id,
                          folderAssignments,
                          dismissedFiles,
                        ).length
                      }
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityLabel={`${folder.name}选项`}
                    style={styles.drawerMore}
                    onPress={() =>
                      Alert.alert(folder.name, "管理文件夹", [
                        {
                          text: "重命名",
                          onPress: () => openFolderDialog(folder),
                        },
                        {
                          text: "删除文件夹",
                          style: "destructive",
                          onPress: () => {
                            setFolderDrawerVisible(false);
                            deleteFolder(folder);
                          },
                        },
                        { text: "取消", style: "cancel" },
                      ])
                    }
                  >
                    <Feather name="more-horizontal" size={20} color="#8C949D" />
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>
            <TouchableOpacity
              style={styles.drawerRow}
              onPress={() => openFolderDialog("new")}
            >
              <Feather name="plus" size={19} color="#3478F6" />
              <Text style={[styles.drawerRowText, styles.blueText]}>
                新建文件夹
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.drawerRow}
              onPress={browseDeviceFiles}
            >
              <Feather name="download-cloud" size={19} color="#3478F6" />
              <Text style={[styles.drawerRowText, styles.blueText]}>
                从设备导入
              </Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={styles.drawerDismiss}
            activeOpacity={1}
            onPress={() => setFolderDrawerVisible(false)}
          />
        </View>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={Boolean(folderDialog)}
        onRequestClose={() => setFolderDialog(null)}
      >
        <View style={styles.centeredBackdrop}>
          <View style={styles.renameDialog}>
            <Text style={styles.sheetTitle}>
              {folderDialog === "new" ? "新建文件夹" : "重命名文件夹"}
            </Text>
            <TextInput
              autoFocus
              maxLength={30}
              value={folderDraft}
              onChangeText={setFolderDraft}
              placeholder="文件夹名称"
              placeholderTextColor="#9AA39F"
              style={styles.renameInput}
            />
            <View style={styles.renameActions}>
              <TouchableOpacity
                style={styles.renameCancel}
                onPress={() => setFolderDialog(null)}
              >
                <Text style={styles.renameCancelText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.renameSave} onPress={saveFolder}>
                <Text style={styles.renameSaveText}>保存</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        transparent
        animationType="slide"
        visible={Boolean(moveFiles)}
        onRequestClose={() => setMoveFiles(null)}
      >
        <TouchableOpacity
          activeOpacity={1}
          style={styles.modalBackdrop}
          onPress={() => setMoveFiles(null)}
        >
          <View style={styles.optionSheet}>
            <Text style={styles.sheetTitle}>移动到文件夹</Text>
            <TouchableOpacity
              style={styles.optionRow}
              onPress={() => assignFolder(null)}
            >
              <Text style={styles.optionText}>全部文件</Text>
            </TouchableOpacity>
            {folders.map((folder) => (
              <TouchableOpacity
                key={folder.id}
                style={styles.optionRow}
                onPress={() => assignFolder(folder.id)}
              >
                <Text style={styles.optionText}>{folder.name}</Text>
              </TouchableOpacity>
            ))}
            {!folders.length ? (
              <Text style={styles.settingHint}>可在文件菜单中新建文件夹</Text>
            ) : null}
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal
        transparent
        animationType="slide"
        visible={Boolean(importCandidates)}
        onRequestClose={() => setImportCandidates(null)}
      >
        <View style={styles.centeredBackdrop}>
          <View style={styles.importSheet}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>从设备导入</Text>
              <TouchableOpacity
                accessibilityLabel="关闭"
                style={styles.iconButton}
                onPress={() => setImportCandidates(null)}
              >
                <Feather name="x" size={21} color="#28343D" />
              </TouchableOpacity>
            </View>
            <ScrollView>
              {importCandidates?.length ? (
                importCandidates.map((file) => (
                  <TouchableOpacity
                    key={file.fileName}
                    style={styles.optionRow}
                    onPress={() => importDeviceFile(file)}
                  >
                    <Feather name="file-text" size={18} color="#3478F6" />
                    <Text
                      numberOfLines={1}
                      style={[styles.optionText, { marginLeft: 12 }]}
                    >
                      {formatFileDate(file.fileName)}
                    </Text>
                    <Feather name="download" size={18} color="#3478F6" />
                  </TouchableOpacity>
                ))
              ) : (
                <Text style={styles.emptyText}>设备中没有录音</Text>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <AiWorkspace
        visible={Boolean(aiWorkspace)}
        initialTab={aiWorkspace?.tab || "transcript"}
        file={aiWorkspace?.file || null}
        localPath={
          aiWorkspace ? downloadedPaths[aiWorkspace.file.fileName] : undefined
        }
        deviceId={launch.deviceId}
        domain={launch.domain}
        token={launch.token}
        lang={launch.lang}
        onClose={() => setAiWorkspace(null)}
        onNeedDownload={(file) => enqueueDownloads([file], true)}
      />

      <Modal
        transparent
        animationType="fade"
        visible={Boolean(renameFile)}
        onRequestClose={() => setRenameFile(null)}
      >
        <View style={styles.centeredBackdrop}>
          <View style={styles.renameDialog}>
            <Text style={styles.sheetTitle}>录音名称</Text>
            <Text style={styles.renameHint}>
              设备文件名保持不变，仅修改 App 中的显示名称。
            </Text>
            <TextInput
              autoFocus
              maxLength={40}
              value={renameDraft}
              onChangeText={setRenameDraft}
              placeholder={
                renameFile ? formatFileDate(renameFile.fileName) : "输入名称"
              }
              placeholderTextColor="#9AA39F"
              style={styles.renameInput}
            />
            <View style={styles.renameActions}>
              <TouchableOpacity
                style={styles.renameCancel}
                onPress={() => setRenameFile(null)}
              >
                <Text style={styles.renameCancelText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.renameSave} onPress={saveAlias}>
                <Text style={styles.renameSaveText}>保存</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        transparent
        animationType="slide"
        visible={Boolean(playingFile)}
        onRequestClose={() => setPlayingFile(null)}
      >
        <TouchableOpacity
          activeOpacity={1}
          style={styles.modalBackdrop}
          onPress={() => setPlayingFile(null)}
        >
          <View style={styles.playerSheet}>
            <View style={styles.sheetHeader}>
              <View style={styles.playerTitleBlock}>
                <Text style={styles.sheetTitle}>录音播放</Text>
                <Text numberOfLines={1} style={styles.playerFileName}>
                  {playingFile
                    ? fileAliases[playingFile.fileName] ||
                      formatFileDate(playingFile.fileName)
                    : ""}
                </Text>
              </View>
              <TouchableOpacity
                accessibilityLabel="关闭播放器"
                style={styles.iconButton}
                onPress={() => setPlayingFile(null)}
              >
                <Feather name="x" size={21} color="#1D2622" />
              </TouchableOpacity>
            </View>
            {playingFile ? (
              <Video
                ref={playerRef}
                source={{
                  uri: `file://${downloadedPaths[playingFile.fileName]}`,
                }}
                paused={playerPaused}
                playInBackground={false}
                onLoad={(event: any) =>
                  setPlayerDuration(
                    resolvePlaybackDuration(
                      playingFile,
                      Number(event.duration || 0),
                    ),
                  )
                }
                onProgress={(event: any) =>
                  setPlayerPosition(
                    normalizePlaybackPosition(
                      Number(event.currentTime || 0),
                      playerDuration,
                    ),
                  )
                }
                onEnd={() => {
                  setPlayerPaused(true);
                  setPlayerPosition(0);
                }}
                style={styles.hiddenPlayer}
              />
            ) : null}
            <Slider
              minimumValue={0}
              maximumValue={playerMax}
              value={playerDisplayPosition}
              minimumTrackTintColor="#3478F6"
              maximumTrackTintColor="#D8DDDA"
              thumbTintColor="#3478F6"
              onSlidingComplete={(value) => playerRef.current?.seek(value)}
            />
            <View style={styles.playerTimeRow}>
              <Text style={styles.playerTime}>
                {formatClock(playerDisplayPosition)}
              </Text>
              <Text style={styles.playerTime}>
                {formatClock(playerDuration)}
              </Text>
            </View>
            <TouchableOpacity
              accessibilityLabel={playerPaused ? "播放" : "暂停"}
              style={styles.playerButton}
              onPress={() => setPlayerPaused((value) => !value)}
            >
              <Feather
                name={playerPaused ? "play" : "pause"}
                size={27}
                color="#FFFFFF"
              />
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#F5F6FA" },
  header: {
    height: 58,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E5E7EC",
    backgroundColor: "#F5F6FA",
  },
  iconButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitleBlock: { flex: 1, alignItems: "center", minWidth: 0 },
  panelHeaderSide: { width: 84, alignItems: "flex-start" },
  panelHeaderActions: {
    width: 84,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
  },
  headerTitle: {
    color: "#17201C",
    fontSize: 17,
    fontWeight: "700",
    letterSpacing: 0,
  },
  connectionLine: { flexDirection: "row", alignItems: "center", marginTop: 3 },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "#2E8B57",
    marginRight: 6,
  },
  statusDotOffline: { backgroundColor: "#A7AEAA" },
  connectionText: { color: "#6E7974", fontSize: 11, letterSpacing: 0 },
  noticeBar: {
    minHeight: 40,
    paddingHorizontal: 18,
    backgroundColor: "#35463E",
    flexDirection: "row",
    alignItems: "center",
  },
  noticeText: {
    flex: 1,
    marginLeft: 9,
    color: "#FFFFFF",
    fontSize: 13,
    letterSpacing: 0,
  },
  content: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 36 },
  recordContent: { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0 },
  recordPage: { flexGrow: 1 },
  recordStage: {
    flexGrow: 1,
    minHeight: 280,
    paddingTop: 20,
    alignItems: "center",
    backgroundColor: "#FFFFFF",
  },
  recordStageTitle: {
    maxWidth: "88%",
    color: "#46515C",
    fontSize: 15,
    letterSpacing: 0,
  },
  recordStageTrack: {
    flex: 1,
    width: "100%",
    minHeight: 230,
    alignItems: "center",
    justifyContent: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#DFE4ED",
  },
  liveWaveform: {
    width: "88%",
    height: 116,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  liveWaveBar: {
    width: 3,
    marginHorizontal: 3,
    borderRadius: 2,
    backgroundColor: "#3478F6",
  },
  recordConsole: {
    minHeight: 245,
    paddingTop: 23,
    paddingBottom: 26,
    alignItems: "center",
    backgroundColor: "#F5F6FA",
  },
  recordStateText: { color: "#697583", fontSize: 13, letterSpacing: 0 },
  timer: {
    marginTop: 9,
    color: "#15201B",
    fontSize: 38,
    fontWeight: "500",
    fontVariant: ["tabular-nums"],
    letterSpacing: 0,
  },
  recordButton: {
    width: 72,
    height: 72,
    marginTop: 22,
    borderRadius: 36,
    backgroundColor: "#3478F6",
    alignItems: "center",
    justifyContent: "center",
  },
  recordPauseButton: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: "#3478F6",
    alignItems: "center",
    justifyContent: "center",
  },
  recordControls: {
    width: "100%",
    minHeight: 86,
    marginTop: 19,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  recordFinishButton: {
    position: "absolute",
    right: 25,
    height: 60,
    minWidth: 65,
    alignItems: "center",
    justifyContent: "center",
  },
  recordFinishText: {
    color: "#3478F6",
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 0,
  },
  buttonDisabled: { opacity: 0.55 },
  connectButton: {
    minWidth: 150,
    height: 46,
    marginTop: 26,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#3478F6",
    borderRadius: 6,
  },
  connectButtonText: {
    marginLeft: 8,
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "600",
    letterSpacing: 0,
  },
  sectionHeader: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerActions: { flexDirection: "row", alignItems: "center" },
  headerTextButton: {
    minWidth: 48,
    height: 42,
    paddingHorizontal: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTextButtonLabel: {
    color: "#2467E8",
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0,
  },
  headerCancelLabel: {
    color: "#4F5B55",
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0,
  },
  pageTitle: {
    color: "#1D2823",
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: 0,
  },
  fileHeading: { flexDirection: "row", alignItems: "center", flexShrink: 1 },
  folderMenuButton: { width: 34, height: 42, justifyContent: "center" },
  pageSubtitle: {
    marginTop: 3,
    color: "#7A8580",
    fontSize: 12,
    letterSpacing: 0,
  },
  emptyText: {
    paddingVertical: 44,
    textAlign: "center",
    color: "#8C9691",
    fontSize: 13,
    letterSpacing: 0,
  },
  searchBox: {
    height: 44,
    marginTop: 8,
    marginBottom: 10,
    paddingHorizontal: 13,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#E9EBF1",
    borderRadius: 7,
  },
  searchInput: {
    flex: 1,
    height: 42,
    marginHorizontal: 9,
    paddingVertical: 0,
    color: "#25312C",
    fontSize: 13,
    letterSpacing: 0,
  },
  filterRow: {
    height: 38,
    marginBottom: 13,
    flexDirection: "row",
    alignItems: "center",
  },
  filterButton: {
    minWidth: 54,
    height: 30,
    marginRight: 7,
    paddingHorizontal: 13,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 15,
    backgroundColor: "transparent",
  },
  filterButtonActive: { backgroundColor: "#E1EAFF" },
  filterText: { color: "#69746F", fontSize: 12, letterSpacing: 0 },
  filterTextActive: { color: "#2467E8", fontWeight: "700" },
  sortButton: {
    height: 30,
    marginLeft: "auto",
    paddingHorizontal: 9,
    flexDirection: "row",
    alignItems: "center",
  },
  sortText: { marginLeft: 4, color: "#52605A", fontSize: 12, letterSpacing: 0 },
  fileCard: {
    minHeight: 84,
    marginBottom: 10,
    paddingLeft: 12,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 7,
  },
  fileCardSelected: { backgroundColor: "#EDF3FF" },
  fileMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
  },
  fileIcon: {
    width: 38,
    height: 38,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#EEF3FF",
  },
  fileText: { flex: 1, minWidth: 0, marginLeft: 11 },
  fileTitle: {
    color: "#25312C",
    fontSize: 14,
    fontWeight: "600",
    letterSpacing: 0,
  },
  fileMeta: { marginTop: 5, color: "#7A8580", fontSize: 11, letterSpacing: 0 },
  fileActions: { flexDirection: "row", paddingRight: 4 },
  selectionHitArea: {
    width: 58,
    minHeight: 82,
    alignItems: "center",
    justifyContent: "center",
  },
  selectionCircle: {
    width: 23,
    height: 23,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "#AAB3AE",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
  },
  selectionCircleActive: { borderColor: "#3478F6", backgroundColor: "#3478F6" },
  progressTrack: {
    height: 3,
    marginTop: 8,
    overflow: "hidden",
    backgroundColor: "#E5E8E6",
    borderRadius: 2,
  },
  progressFill: { height: 3, backgroundColor: "#3478F6" },
  settingsGroupTitle: {
    marginTop: 22,
    marginBottom: 10,
    color: "#7A8580",
    fontSize: 13,
    letterSpacing: 0,
  },
  deviceOverview: { alignItems: "center", paddingTop: 16, paddingBottom: 10 },
  devicePhoto: { width: "90%", height: 212 },
  deviceOverviewTitle: {
    maxWidth: "90%",
    marginTop: 8,
    fontSize: 18,
    fontWeight: "600",
    color: "#25312C",
    letterSpacing: 0,
  },
  deviceStatusBadge: {
    minHeight: 28,
    marginTop: 12,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#E5EEFF",
    borderRadius: 14,
  },
  deviceStatusBadgeOffline: { backgroundColor: "#E7E9EC" },
  deviceStatusDot: {
    width: 6,
    height: 6,
    marginRight: 7,
    borderRadius: 3,
    backgroundColor: "#3478F6",
  },
  deviceStatusDotOffline: { backgroundColor: "#9399A3" },
  deviceStatusLabel: { color: "#2467E8", fontSize: 12, letterSpacing: 0 },
  deviceStatusLabelOffline: { color: "#77808A" },
  deviceBatteryValue: { color: "#2467E8", fontSize: 15, fontWeight: "600" },
  settingGroup: {
    overflow: "hidden",
    backgroundColor: "#FFFFFF",
    borderRadius: 7,
  },
  settingRow: {
    minHeight: 58,
    paddingHorizontal: 15,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E6E8EC",
  },
  settingRowDisabled: { opacity: 0.5 },
  settingTitle: {
    flexShrink: 1,
    color: "#25312C",
    fontSize: 14,
    letterSpacing: 0,
  },
  settingValue: {
    flex: 1,
    marginLeft: 12,
    textAlign: "right",
    color: "#737E79",
    fontSize: 13,
    letterSpacing: 0,
  },
  settingTextBlock: { flex: 1, paddingVertical: 11, paddingRight: 10 },
  settingHint: {
    marginTop: 4,
    color: "#8A948F",
    fontSize: 11,
    lineHeight: 17,
    letterSpacing: 0,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(15,22,19,0.38)",
  },
  drawerBackdrop: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: "rgba(22,30,42,0.42)",
  },
  folderDrawer: {
    width: "82%",
    maxWidth: 340,
    paddingTop: 52,
    paddingHorizontal: 16,
    paddingBottom: 26,
    backgroundColor: "#F5F6FA",
  },
  drawerDismiss: { flex: 1 },
  drawerTitle: {
    marginBottom: 16,
    fontSize: 20,
    fontWeight: "700",
    color: "#27313A",
  },
  drawerRow: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
  },
  drawerFolderHit: {
    flex: 1,
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
  },
  drawerRowText: {
    flex: 1,
    minWidth: 0,
    marginLeft: 15,
    color: "#28343D",
    fontSize: 15,
  },
  drawerCount: { color: "#8C949D", fontSize: 13 },
  drawerSection: {
    marginTop: 18,
    marginBottom: 6,
    paddingLeft: 10,
    fontSize: 14,
    color: "#75808A",
  },
  drawerMore: {
    width: 40,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  folderScroll: { flexGrow: 0, maxHeight: 280 },
  blueText: { color: "#3478F6", fontWeight: "600" },
  importSheet: {
    width: "100%",
    maxHeight: "68%",
    padding: 20,
    backgroundColor: "#FFFFFF",
    borderRadius: 8,
  },
  optionSheet: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 28,
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
  },
  sheetHeader: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sheetTitle: {
    color: "#1D2622",
    fontSize: 17,
    fontWeight: "700",
    letterSpacing: 0,
  },
  optionRow: {
    height: 54,
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#E2E6E4",
  },
  optionText: { flex: 1, color: "#4C5852", fontSize: 14, letterSpacing: 0 },
  optionTextActive: { color: "#2467E8", fontWeight: "700" },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: "#AEB6B2",
    alignItems: "center",
    justifyContent: "center",
  },
  radioActive: { borderColor: "#2467E8" },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#3478F6",
  },
  tabBar: {
    height: 68,
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#D7DCDA",
    backgroundColor: "#FFFFFF",
  },
  selectionBottomBar: {
    height: 72,
    paddingHorizontal: 28,
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#D4DAD7",
    backgroundColor: "#FFFFFF",
  },
  selectionBottomAction: {
    flex: 1,
    height: 62,
    alignItems: "center",
    justifyContent: "center",
  },
  selectionBottomDivider: {
    width: StyleSheet.hairlineWidth,
    height: 32,
    backgroundColor: "#DCE1DE",
  },
  selectionBottomLabel: {
    marginTop: 4,
    color: "#2467E8",
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0,
  },
  selectionBottomDeleteLabel: { color: "#A13D3D" },
  selectionBottomLabelDisabled: { color: "#B3BBB7" },
  tabButton: { flex: 1, alignItems: "center", justifyContent: "center" },
  recorderTabButton: { justifyContent: "flex-start" },
  recorderTabIcon: {
    width: 62,
    height: 62,
    marginTop: -18,
    borderRadius: 31,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#4E8CFF",
    borderWidth: 6,
    borderColor: "#FFFFFF",
  },
  recorderTabIconActive: { backgroundColor: "#2467E8" },
  tabLabel: { marginTop: 4, color: "#7A8580", fontSize: 11, letterSpacing: 0 },
  tabLabelActive: { color: "#2467E8", fontWeight: "700" },
  playerSheet: {
    minHeight: 260,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 30,
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
  },
  detailSheet: {
    minHeight: 330,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 30,
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
  },
  detailActions: {
    minHeight: 54,
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
  },
  detailPrimaryAction: {
    height: 44,
    paddingHorizontal: 17,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#3478F6",
    borderRadius: 6,
  },
  detailPrimaryText: {
    marginLeft: 7,
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0,
  },
  detailSecondaryAction: {
    height: 44,
    marginLeft: 9,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#EEF1EF",
    borderRadius: 6,
  },
  detailSecondaryText: {
    marginLeft: 6,
    color: "#34423C",
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0,
  },
  detailIconAction: {
    width: 44,
    height: 44,
    marginLeft: "auto",
    alignItems: "center",
    justifyContent: "center",
  },
  futureTitle: {
    marginTop: 25,
    marginBottom: 10,
    color: "#6D7873",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0,
  },
  futureGrid: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#E0E4E2",
  },
  futureAction: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E0E4E2",
  },
  futureIcon: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: "#EDF3FF",
  },
  futureActionTitle: {
    flex: 1,
    marginLeft: 11,
    color: "#34423C",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0,
  },
  futureActionState: {
    marginRight: 4,
    color: "#98A19D",
    fontSize: 11,
    letterSpacing: 0,
  },
  centeredBackdrop: {
    flex: 1,
    paddingHorizontal: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(15,22,19,0.38)",
  },
  renameDialog: {
    width: "100%",
    padding: 20,
    backgroundColor: "#FFFFFF",
    borderRadius: 8,
  },
  renameHint: {
    marginTop: 7,
    color: "#7D8782",
    fontSize: 11,
    lineHeight: 17,
    letterSpacing: 0,
  },
  renameInput: {
    height: 46,
    marginTop: 17,
    paddingHorizontal: 12,
    color: "#25312C",
    fontSize: 14,
    borderWidth: 1,
    borderColor: "#CCD4D0",
    borderRadius: 6,
    letterSpacing: 0,
  },
  renameActions: {
    marginTop: 18,
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  renameCancel: {
    height: 40,
    paddingHorizontal: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  renameCancelText: {
    color: "#65716B",
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0,
  },
  renameSave: {
    height: 40,
    marginLeft: 8,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#3478F6",
    borderRadius: 5,
  },
  renameSaveText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0,
  },
  playerTitleBlock: { flex: 1, minWidth: 0, paddingRight: 10 },
  playerFileName: {
    marginTop: 4,
    color: "#7A8580",
    fontSize: 11,
    letterSpacing: 0,
  },
  hiddenPlayer: { width: 1, height: 1, opacity: 0 },
  playerTimeRow: { flexDirection: "row", justifyContent: "space-between" },
  playerTime: {
    color: "#77827D",
    fontSize: 11,
    fontVariant: ["tabular-nums"],
    letterSpacing: 0,
  },
  playerButton: {
    width: 58,
    height: 58,
    marginTop: 20,
    alignSelf: "center",
    borderRadius: 29,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#3478F6",
  },
});
