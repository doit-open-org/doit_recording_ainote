import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Feather from "react-native-vector-icons/Feather";
import { WebView } from "react-native-webview";
import NativeLocalStorage from "../../specs/NativeLocalStorage";
import { createAudioAiApi } from "../services/audioAiApi";
import { addMindmapTitle } from "../utils/mindmap";
import { extractTranscriptSegments } from "../utils/transcript";

type AiTab = "transcript" | "summary" | "mindmap";
type DeviceFile = {
  fileName: string;
  duration: number;
  fileType: number;
  size: number;
};
type Template = {
  template_id: string;
  name: string;
  description?: string;
  labels?: string[];
};
type Category = { category_id: string; name: string; templates: Template[] };
type Language = { language_id: number; code: string; name: string };

const TASKS_KEY = "ainote.aiTasks.v1";

function readTasks() {
  try {
    return JSON.parse(NativeLocalStorage?.getItem(TASKS_KEY) || "{}");
  } catch (_) {
    return {};
  }
}

function writeTask(key: string, value: any) {
  const next = { ...readTasks(), [key]: value };
  NativeLocalStorage?.setItem(TASKS_KEY, JSON.stringify(next));
}

function parseTimestamp(fileName: string) {
  if (!/^\d{14}$/.test(fileName)) return undefined;
  const date = new Date(
    Number(fileName.slice(0, 4)),
    Number(fileName.slice(4, 6)) - 1,
    Number(fileName.slice(6, 8)),
    Number(fileName.slice(8, 10)),
    Number(fileName.slice(10, 12)),
    Number(fileName.slice(12, 14))
  );
  return Math.floor(date.getTime() / 1000);
}

function resultObject(detail: any) {
  const result = detail?.result;
  if (!result) return {};
  if (typeof result === "object") return result;
  try {
    return JSON.parse(result);
  } catch (_) {
    return {};
  }
}

function getSegments(detail: any) {
  const result = resultObject(detail);
  return extractTranscriptSegments(result, detail?.segments);
}

function getSummary(detail: any) {
  const result = resultObject(detail);
  return String(
    result.summary_md ||
      result.summaryMarkdown ||
      result.markdown ||
      detail?.summary_md ||
      ""
  );
}

function getMindmap(detail: any) {
  const result = resultObject(detail);
  const sourceMarkdown = String(
    result.mindmap_md || result.mindmapMarkdown || getSummary(detail)
  );
  return {
    markdown: addMindmapTitle(sourceMarkdown, result.title),
    hasMarkdown: Boolean(sourceMarkdown.trim()),
    url: String(result.mindmap_url || detail?.mindmap_url || ""),
  };
}

function statusLabel(status: string) {
  return (
    {
      pending: "排队中",
      processing: "AI 正在整理",
      done: "已整理",
      failed: "整理失败",
    }[status] || "正在准备"
  );
}

function InlineMarkdown({
  text,
  style,
  prefix = "",
}: {
  text: string;
  style: any;
  prefix?: string;
}) {
  const parts = String(text || "").split(/(\*\*[^*]+\*\*)/g);
  return (
    <Text style={style}>
      {prefix}
      {parts.map((part, index) =>
        part.startsWith("**") && part.endsWith("**") ? (
          <Text key={index} style={styles.mdStrong}>
            {part.slice(2, -2)}
          </Text>
        ) : (
          part
        )
      )}
    </Text>
  );
}

function recordingTitle(fileName: string) {
  if (!/^\d{14}$/.test(fileName)) return fileName;
  return `${fileName.slice(0, 4)}-${fileName.slice(4, 6)}-${fileName.slice(
    6,
    8
  )} ${fileName.slice(8, 10)}:${fileName.slice(10, 12)}`;
}

function segmentSpeaker(segment: any, index: number) {
  const speaker = String(segment.speaker || segment.speaker_name || "").trim();
  if (!speaker || speaker.toLowerCase() === "unknown") return "未识别说话人";
  return speaker || `说话人 ${index + 1}`;
}

function segmentTime(segment: any) {
  const seconds = Math.max(
    0,
    Math.floor(
      Number(segment.start_ms ?? segment.start_time ?? 0) /
        (segment.start_ms !== undefined ? 1000 : 1)
    )
  );
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(
    2,
    "0"
  )}`;
}

function recordingDuration(seconds: number) {
  const value = Math.max(0, Math.floor(Number(seconds || 0)));
  const minutes = Math.floor(value / 60);
  return `${String(minutes).padStart(2, "0")}m ${String(value % 60).padStart(
    2,
    "0"
  )}s`;
}

function recordingDate(fileName: string) {
  if (!/^\d{14}$/.test(fileName)) return fileName;
  return `${fileName.slice(4, 6)}-${fileName.slice(6, 8)} ${fileName.slice(
    8,
    10
  )}:${fileName.slice(10, 12)}`;
}

function MarkdownView({ markdown }: { markdown: string }) {
  if (!markdown.trim()) return <Text style={styles.emptyText}>还没有摘要</Text>;
  return (
    <View style={styles.markdown}>
      {markdown.split(/\r?\n/).map((line, index) => {
        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
          const level = heading[1].length;
          return (
            <InlineMarkdown
              key={index}
              text={heading[2]}
              style={[styles.mdHeading, level > 1 && styles.mdSubheading]}
            />
          );
        }
        const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
        if (bullet) {
          return (
            <InlineMarkdown
              key={index}
              text={bullet[1]}
              prefix="• "
              style={styles.mdParagraph}
            />
          );
        }
        if (!line.trim()) return <View key={index} style={styles.mdGap} />;
        return (
          <InlineMarkdown key={index} text={line} style={styles.mdParagraph} />
        );
      })}
    </View>
  );
}

function markmapHtml(markdown: string) {
  const encoded = JSON.stringify(markdown || "# 还没有导图内容");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>html,body,#map{width:100%;height:100%;margin:0;background:#fff}svg{width:100%;height:100%}.markmap-link{stroke:#a4a9b3}.markmap-node circle{fill:#3478f6}</style></head><body><svg id="map"></svg><script src="https://cdn.jsdelivr.net/npm/d3@7.9.0"></script><script src="https://cdn.jsdelivr.net/npm/markmap-view@0.15.4"></script><script src="https://cdn.jsdelivr.net/npm/markmap-lib@0.15.4"></script><script>try{const t=new markmap.Transformer();const r=t.transform(${encoded}).root;const m=markmap.Markmap.create(document.querySelector('#map'),{autoFit:true,duration:250,maxWidth:260},r);setTimeout(()=>m.fit(),100)}catch(e){document.body.innerHTML='<div style="padding:24px;font:14px sans-serif;color:#68736e">导图加载失败</div>'}</script></body></html>`;
}

export default function AiWorkspace({
  visible,
  initialTab,
  file,
  localPath,
  deviceId,
  domain,
  token,
  lang,
  onClose,
  onNeedDownload,
}: {
  visible: boolean;
  initialTab: AiTab;
  file: DeviceFile | null;
  localPath?: string;
  deviceId: string;
  domain: string;
  token: string;
  lang: string;
  onClose: () => void;
  onNeedDownload: (file: DeviceFile) => void;
}) {
  const api = useMemo(
    () => createAudioAiApi({ domain, token, lang }),
    [domain, token, lang]
  );
  const pollTimer = useRef<any>(null);
  const submittingRef = useRef(false);
  const [tab, setTab] = useState<AiTab>(initialTab);
  const [categories, setCategories] = useState<Category[]>([]);
  const [languages, setLanguages] = useState<Language[]>([]);
  const [templateId, setTemplateId] = useState("meeting_minutes");
  const [sourceLang, setSourceLang] = useState("auto");
  const [taskId, setTaskId] = useState("");
  const [detail, setDetail] = useState<any>(null);
  const [phase, setPhase] = useState<
    "loading" | "setup" | "uploading" | "result"
  >("loading");
  const [setupMode, setSetupMode] = useState<"create" | "summary">("create");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState("");
  const taskKey = file ? `${deviceId}:${file.fileName}` : "";

  function persistTask(info: any) {
    if (!taskKey || !info?.task_id) return;
    writeTask(taskKey, {
      taskId: info.task_id,
      taskVersion: Number(info.task_version || 1),
      status: info.status || "pending",
      templateId: info.template_id || templateId,
    });
  }

  async function refreshTask(id = taskId, silent = false) {
    if (!id) return;
    try {
      if (!silent) setPhase("loading");
      const response = await api.getTaskInfo(id);
      setDetail(response.info);
      persistTask(response.info);
      setPhase("result");
      setError("");
    } catch (nextError: any) {
      setError(nextError?.message || "内容刷新失败");
      setPhase("result");
    }
  }

  useEffect(() => {
    if (!visible || !file) return;
    setTab(initialTab);
    setError("");
    setPhase("loading");
    setSetupMode("create");
    const cached = readTasks()[`${deviceId}:${file.fileName}`];
    const cachedTaskId = String(cached?.taskId || "");
    setTaskId(cachedTaskId);
    void Promise.all([
      api.getTemplates(),
      api.getLanguages(),
      api.getAudioList(1, 50).catch(() => ({ info: { list: [] } })),
    ])
      .then(([templateResponse, languageResponse, listResponse]) => {
        const nextCategories = templateResponse.info?.categories || [];
        const nextLanguages = languageResponse.info?.languages || [];
        const remoteTask = (listResponse.info?.list || []).find(
          (item: any) =>
            item.filename === file.fileName ||
            item.filename === `${file.fileName}.aac`
        );
        const restoredTaskId =
          cachedTaskId || String(remoteTask?.task_id || "");
        setCategories(nextCategories);
        setLanguages(nextLanguages);
        const firstTemplate = nextCategories[0]?.templates?.[0]?.template_id;
        setTemplateId(
          cached?.templateId ||
            remoteTask?.template_id ||
            firstTemplate ||
            "meeting_minutes"
        );
        setSourceLang("auto");
        setTaskId(restoredTaskId);
        if (restoredTaskId) {
          if (!cachedTaskId) persistTask(remoteTask);
          void refreshTask(restoredTaskId);
        } else setPhase("setup");
      })
      .catch((nextError) => {
        setError(nextError?.message || "AI 整理服务暂时不可用");
        setPhase(cachedTaskId ? "result" : "setup");
      });
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [visible, file?.fileName, initialTab]);

  useEffect(() => {
    if (
      !visible ||
      !taskId ||
      !["pending", "processing"].includes(detail?.status)
    )
      return;
    pollTimer.current = setInterval(() => void refreshTask(taskId, true), 3000);
    return () => clearInterval(pollTimer.current);
  }, [visible, taskId, detail?.status]);

  async function createTask() {
    if (!file || submittingRef.current) return;
    if (!localPath) {
      onNeedDownload(file);
      setError("正在下载这段录音，完成后即可整理");
      return;
    }
    setPhase("uploading");
    submittingRef.current = true;
    setUploadProgress(0);
    setError("");
    try {
      const upload = api.createTask({
        filePath: localPath,
        fileName: file.fileName,
        templateId,
        sourceLang,
        fileSource: file.fileType === 0 ? "call" : "note",
        fileCreateTimestamp: parseTimestamp(file.fileName),
        onProgress: setUploadProgress,
      });
      const response = await upload.promise;
      const id = String(response.info?.task_id || "");
      if (!id) throw new Error("暂时无法开始整理，请稍后重试");
      setTaskId(id);
      setDetail(response.info);
      persistTask(response.info);
      setPhase("result");
    } catch (nextError: any) {
      setError(nextError?.message || "录音上传失败");
      setPhase("setup");
    } finally {
      submittingRef.current = false;
    }
  }

  async function submitSetup() {
    if (setupMode === "create") {
      await createTask();
      return;
    }
    if (!taskId || !detail?.task_version) return;
    setPhase("loading");
    setError("");
    try {
      const response = await api.resummarize({
        taskId,
        taskVersion: detail.task_version,
        templateId,
      });
      const info = response.info || {
        ...detail,
        status: "pending",
        operation: "summarize",
        task_version: detail.task_version + 1,
      };
      setDetail(info);
      persistTask({ ...info, task_id: taskId, template_id: templateId });
      setPhase("result");
    } catch (nextError: any) {
      setError(nextError?.message || "摘要更新失败");
      setPhase("result");
    }
  }

  async function restart(kind: "transcript" | "summary") {
    if (!taskId || !detail?.task_version) return;
    setPhase("loading");
    setError("");
    try {
      const response =
        kind === "transcript"
          ? await api.retranscribe({
              taskId,
              taskVersion: detail.task_version,
              sourceLang,
            })
          : await api.resummarize({
              taskId,
              taskVersion: detail.task_version,
              templateId,
            });
      const info = response.info || {
        ...detail,
        status: "pending",
        task_version: detail.task_version + 1,
      };
      setDetail(info);
      persistTask({ ...info, task_id: taskId });
      setPhase("result");
    } catch (nextError: any) {
      setError(nextError?.message || "重新整理失败");
      setPhase("result");
    }
  }

  if (!file) return null;
  const segments = getSegments(detail);
  const summary = getSummary(detail);
  const mindmap = getMindmap(detail);
  const processing = ["pending", "processing"].includes(detail?.status);
  const contentTitle = String(resultObject(detail).title || "").trim();

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="dark-content" backgroundColor="#F7F8F7" />
        <View style={styles.header}>
          <TouchableOpacity
            accessibilityLabel="关闭"
            style={styles.iconButton}
            onPress={onClose}
          >
            <Feather name="chevron-left" size={25} color="#1E2823" />
          </TouchableOpacity>
          <View style={styles.headerText}>
            <Text numberOfLines={1} style={styles.title}>
              {contentTitle || recordingTitle(file.fileName)}
            </Text>
            <Text style={styles.subtitle}>
              {detail ? statusLabel(detail.status) : "AI 整理"}
            </Text>
          </View>
          <TouchableOpacity
            accessibilityLabel="刷新"
            style={styles.iconButton}
            onPress={() => void refreshTask()}
          >
            <Feather name="refresh-cw" size={19} color="#52605A" />
          </TouchableOpacity>
        </View>

        {phase === "loading" ? (
          <View style={styles.center}>
            <ActivityIndicator color="#3478F6" />
            <Text style={styles.centerText}>正在打开这段录音</Text>
          </View>
        ) : null}

        {phase === "setup" ? (
          <ScrollView contentContainerStyle={styles.setup}>
            <Text style={styles.setupTitle}>
              {setupMode === "create" ? "整理这段录音" : "更换摘要样式"}
            </Text>
            <Text style={styles.setupHint}>
              {setupMode === "create"
                ? "选择录音语言和摘要样式，之后可随时查看文字、摘要和导图。"
                : "文字内容保持不变，只更新摘要和导图。"}
            </Text>
            {setupMode === "create" ? (
              <>
                <Text style={styles.groupTitle}>录音语言</Text>
                <View style={styles.chips}>
                  {languages.map((item) => (
                    <TouchableOpacity
                      key={item.code}
                      style={[
                        styles.chip,
                        sourceLang === item.code && styles.chipActive,
                      ]}
                      onPress={() => setSourceLang(item.code)}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          sourceLang === item.code && styles.chipTextActive,
                        ]}
                      >
                        {item.name}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            ) : null}
            <Text style={styles.groupTitle}>摘要样式</Text>
            {categories.map((category) => (
              <View key={category.category_id} style={styles.category}>
                <Text style={styles.categoryTitle}>{category.name}</Text>
                {category.templates.map((template) => (
                  <TouchableOpacity
                    key={template.template_id}
                    style={[
                      styles.templateRow,
                      templateId === template.template_id &&
                        styles.templateRowActive,
                    ]}
                    onPress={() => setTemplateId(template.template_id)}
                  >
                    <View style={styles.templateIcon}>
                      <Feather name="file-text" size={18} color="#536A60" />
                    </View>
                    <View style={styles.templateText}>
                      <Text style={styles.templateName}>{template.name}</Text>
                      <Text numberOfLines={1} style={styles.templateLabels}>
                        {template.labels?.join(" · ") || template.description}
                      </Text>
                    </View>
                    {templateId === template.template_id ? (
                      <Feather
                        name="check"
                        size={18}
                        color="#3478F6"
                        style={styles.templateCheck}
                      />
                    ) : null}
                  </TouchableOpacity>
                ))}
              </View>
            ))}
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => void submitSetup()}
            >
              <Feather name="check" size={18} color="#FFFFFF" />
              <Text style={styles.primaryButtonText}>
                {setupMode === "create" ? "开始整理" : "更新摘要"}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        ) : null}

        {phase === "uploading" ? (
          <View style={styles.center}>
            <View style={styles.uploadProgress}>
              <View style={styles.uploadProgressHeader}>
                <Text style={styles.uploadProgressTitle}>正在上传录音</Text>
                <Text style={styles.progressValue}>{uploadProgress}%</Text>
              </View>
              <View style={styles.progressTrack}>
                <View
                  style={[styles.progressFill, { width: `${uploadProgress}%` }]}
                />
              </View>
            </View>
            <Text style={styles.centerText}>上传完成后会自动开始 AI 整理</Text>
          </View>
        ) : null}

        {phase === "result" ? (
          <>
            <View style={styles.tabs}>
              {(
                [
                  ["transcript", "转写"],
                  ["summary", "AI总结"],
                  ["mindmap", "思维导图"],
                ] as const
              ).map(([key, label]) => (
                <TouchableOpacity
                  key={key}
                  style={[styles.tab, tab === key && styles.tabActive]}
                  onPress={() => setTab(key)}
                >
                  <Text
                    style={[
                      styles.tabText,
                      tab === key && styles.tabTextActive,
                    ]}
                  >
                    {label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.metaRow}>
              <View style={styles.metaItem}>
                <Feather name="clock" size={15} color="#9398A1" />
                <Text style={styles.metaText}>
                  {recordingDuration(file.duration)}
                </Text>
              </View>
              <View style={styles.metaItem}>
                <Feather name="calendar" size={15} color="#9398A1" />
                <Text style={styles.metaText}>
                  {recordingDate(file.fileName)}
                </Text>
              </View>
              <View style={styles.metaItem}>
                <Feather name="mic" size={15} color="#9398A1" />
                <Text style={styles.metaText}>
                  {file.fileType === 0 ? "通话" : "录音笔"}
                </Text>
              </View>
            </View>
            {processing ? (
              <View style={styles.processing}>
                <ActivityIndicator color="#3478F6" />
                <Text style={styles.centerTitle}>
                  {statusLabel(detail.status)}
                </Text>
                <Text style={styles.centerText}>
                  {Number(detail.progress || 0)}% · 可以关闭页面，稍后再查看
                </Text>
                <View style={styles.taskProgressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      {
                        width: `${Math.max(
                          0,
                          Math.min(100, Number(detail.progress || 0))
                        )}%`,
                      },
                    ]}
                  />
                </View>
              </View>
            ) : null}
            {detail?.status === "failed" ? (
              <View style={styles.processing}>
                <Feather name="alert-circle" size={34} color="#A13D3D" />
                <Text style={styles.centerTitle}>整理失败</Text>
                <Text style={styles.centerText}>
                  {detail.fail_message || detail.fail_reason || "请稍后重试"}
                </Text>
                <TouchableOpacity
                  style={styles.retryButton}
                  onPress={() => void restart("transcript")}
                >
                  <Text style={styles.retryText}>再试一次</Text>
                </TouchableOpacity>
              </View>
            ) : null}
            {!processing &&
            detail?.status !== "failed" &&
            tab === "transcript" ? (
              <ScrollView contentContainerStyle={styles.resultContent}>
                {segments.length ? (
                  segments.map((segment: any, index: number) => (
                    <View
                      key={`${segment.start_ms || segment.start_time || index}`}
                      style={styles.segment}
                    >
                      <View style={styles.segmentMeta}>
                        <Text style={styles.speaker}>
                          {segmentSpeaker(segment, index)}
                        </Text>
                        <Text style={styles.time}>{segmentTime(segment)}</Text>
                      </View>
                      <Text style={styles.segmentText}>
                        {segment.text || segment.content || ""}
                      </Text>
                    </View>
                  ))
                ) : (
                  <Text style={styles.emptyText}>这段录音还没有文字内容</Text>
                )}
                <TouchableOpacity
                  style={styles.textAction}
                  onPress={() => void restart("transcript")}
                >
                  <Feather name="rotate-ccw" size={16} color="#3478F6" />
                  <Text style={styles.textActionLabel}>重新整理文字</Text>
                </TouchableOpacity>
              </ScrollView>
            ) : null}
            {!processing && detail?.status !== "failed" && tab === "summary" ? (
              <ScrollView contentContainerStyle={styles.resultContent}>
                <MarkdownView markdown={summary} />
                <TouchableOpacity
                  style={styles.textAction}
                  onPress={() => {
                    setSetupMode("summary");
                    setPhase("setup");
                  }}
                >
                  <Feather name="repeat" size={16} color="#3478F6" />
                  <Text style={styles.textActionLabel}>更换摘要样式</Text>
                </TouchableOpacity>
              </ScrollView>
            ) : null}
            {!processing && detail?.status !== "failed" && tab === "mindmap" ? (
              <View style={styles.webContainer}>
                {!mindmap.hasMarkdown && mindmap.url ? (
                  <WebView
                    source={{ uri: mindmap.url }}
                    originWhitelist={["*"]}
                  />
                ) : (
                  <WebView
                    source={{ html: markmapHtml(mindmap.markdown) }}
                    originWhitelist={["*"]}
                    javaScriptEnabled
                    domStorageEnabled
                  />
                )}
              </View>
            ) : null}
            {error ? (
              <View style={styles.errorBar}>
                <Text style={styles.errorBarText}>{error}</Text>
              </View>
            ) : null}
          </>
        ) : null}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    paddingTop: Platform.OS === "android" ? StatusBar.currentHeight || 0 : 0,
    backgroundColor: "#F5F6FA",
  },
  header: {
    height: 58,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E2E5E3",
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  headerText: { flex: 1, minWidth: 0, alignItems: "center" },
  title: {
    color: "#202B26",
    fontSize: 17,
    fontWeight: "700",
    letterSpacing: 0,
  },
  subtitle: { marginTop: 2, color: "#7A8580", fontSize: 11, letterSpacing: 0 },
  center: {
    flex: 1,
    paddingHorizontal: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  centerTitle: {
    marginTop: 15,
    color: "#26322D",
    fontSize: 17,
    fontWeight: "700",
    letterSpacing: 0,
  },
  centerText: {
    marginTop: 8,
    color: "#7A8580",
    fontSize: 12,
    lineHeight: 19,
    textAlign: "center",
    letterSpacing: 0,
  },
  setup: { paddingHorizontal: 22, paddingTop: 24, paddingBottom: 40 },
  setupTitle: {
    color: "#202B26",
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: 0,
  },
  setupHint: {
    marginTop: 8,
    color: "#77817C",
    fontSize: 13,
    lineHeight: 20,
    letterSpacing: 0,
  },
  groupTitle: {
    marginTop: 24,
    marginBottom: 10,
    color: "#6E7873",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0,
  },
  chips: { flexDirection: "row", flexWrap: "wrap" },
  chip: {
    height: 34,
    marginRight: 8,
    marginBottom: 8,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 0,
    borderRadius: 17,
    backgroundColor: "#F0F2F0",
  },
  chipActive: { backgroundColor: "#E1EAFF" },
  chipText: { color: "#69746F", fontSize: 12, letterSpacing: 0 },
  chipTextActive: { color: "#2467E8", fontWeight: "700" },
  category: {
    marginBottom: 12,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
  },
  categoryTitle: {
    width: "100%",
    marginBottom: 6,
    color: "#89928E",
    fontSize: 11,
    letterSpacing: 0,
  },
  templateRow: {
    width: "48.5%",
    minHeight: 94,
    marginBottom: 9,
    padding: 11,
    alignItems: "flex-start",
    backgroundColor: "#FFFFFF",
    borderRadius: 6,
  },
  templateRowActive: {
    borderWidth: 2,
    borderColor: "#3478F6",
    padding: 9,
  },
  templateIcon: {
    width: 30,
    height: 30,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#E9EFEB",
  },
  templateText: { minWidth: 0, marginTop: 8 },
  templateCheck: { position: "absolute", top: 10, right: 10 },
  templateName: {
    color: "#29352F",
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0,
  },
  templateLabels: {
    marginTop: 4,
    color: "#8A948F",
    fontSize: 10,
    letterSpacing: 0,
  },
  primaryButton: {
    height: 48,
    marginTop: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 5,
    backgroundColor: "#3478F6",
  },
  primaryButtonText: {
    marginLeft: 8,
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 0,
  },
  error: {
    marginTop: 14,
    color: "#A13D3D",
    fontSize: 12,
    lineHeight: 18,
    letterSpacing: 0,
  },
  uploadProgress: {
    width: "100%",
    maxWidth: 360,
  },
  uploadProgressHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  uploadProgressTitle: {
    color: "#26322D",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0,
  },
  progressValue: {
    color: "#2467E8",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0,
  },
  progressTrack: {
    height: 4,
    marginTop: 12,
    overflow: "hidden",
    backgroundColor: "#E3E7E4",
    borderRadius: 2,
  },
  progressFill: { height: 4, backgroundColor: "#3478F6" },
  taskProgressTrack: {
    width: 180,
    height: 3,
    marginTop: 18,
    overflow: "hidden",
    backgroundColor: "#E3E7E4",
    borderRadius: 2,
  },
  tabs: {
    height: 46,
    paddingHorizontal: 18,
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#DCE1DE",
    backgroundColor: "#FFFFFF",
  },
  metaRow: {
    minHeight: 46,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E5E7EC",
  },
  metaItem: { flexDirection: "row", alignItems: "center", marginRight: 18 },
  metaText: {
    marginLeft: 5,
    color: "#8A8F98",
    fontSize: 11,
    letterSpacing: 0,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: { borderBottomColor: "#3478F6" },
  tabText: { color: "#7B8580", fontSize: 13, letterSpacing: 0 },
  tabTextActive: { color: "#3478F6", fontWeight: "700" },
  processing: {
    flex: 1,
    paddingHorizontal: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  resultContent: {
    paddingHorizontal: 22,
    paddingTop: 16,
    paddingBottom: 40,
    backgroundColor: "#FFFFFF",
  },
  segment: {
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#DDE2DF",
  },
  segmentMeta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  speaker: {
    color: "#3478F6",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0,
  },
  time: {
    color: "#8C9691",
    fontSize: 11,
    fontVariant: ["tabular-nums"],
    letterSpacing: 0,
  },
  segmentText: {
    marginTop: 7,
    color: "#303B36",
    fontSize: 15,
    lineHeight: 24,
    letterSpacing: 0,
  },
  emptyText: {
    paddingVertical: 48,
    color: "#8A948F",
    fontSize: 13,
    textAlign: "center",
    letterSpacing: 0,
  },
  markdown: { paddingBottom: 8 },
  mdHeading: {
    marginTop: 10,
    marginBottom: 7,
    color: "#202B26",
    fontSize: 20,
    fontWeight: "700",
    lineHeight: 28,
    letterSpacing: 0,
  },
  mdSubheading: { fontSize: 16, lineHeight: 23 },
  mdStrong: { color: "#20252D", fontWeight: "700" },
  mdParagraph: {
    marginBottom: 7,
    color: "#36413C",
    fontSize: 14,
    lineHeight: 22,
    letterSpacing: 0,
  },
  mdGap: { height: 8 },
  webContainer: { flex: 1, overflow: "hidden", backgroundColor: "#FFFFFF" },
  textAction: {
    height: 44,
    marginTop: 20,
    flexDirection: "row",
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  textActionLabel: {
    marginLeft: 7,
    color: "#3478F6",
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0,
  },
  retryButton: {
    height: 42,
    marginTop: 20,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    backgroundColor: "#3478F6",
  },
  retryText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0,
  },
  errorBar: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    backgroundColor: "#8E3C3C",
  },
  errorBarText: {
    color: "#FFFFFF",
    fontSize: 12,
    textAlign: "center",
    letterSpacing: 0,
  },
});
