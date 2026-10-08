import RNFS from "react-native-fs";

const API_PREFIX = "/api/app/audio_recording_translate";

function normalizeBaseUrl(domain) {
  let value = String(domain || "").trim();
  if (!value) return "";
  try {
    value = decodeURIComponent(value);
  } catch (_) {}
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  value = value.replace(/\/+$/, "");
  const apiIndex = value.indexOf("/api/");
  return apiIndex > 0 ? value.slice(0, apiIndex) : value;
}

function parseResponseBody(body) {
  try {
    return typeof body === "string" ? JSON.parse(body) : body;
  } catch (_) {
    throw new Error("服务器返回了无效数据");
  }
}

function unwrapResponse(response) {
  const payload = parseResponseBody(response);
  if (String(payload?.ret) !== "1") {
    const error = new Error(payload?.desc || "请求失败");
    error.code = String(payload?.ret || "");
    error.payload = payload;
    throw error;
  }
  return payload;
}

function createAudioAiApi({ domain, token, lang = "zh" }) {
  const baseUrl = normalizeBaseUrl(domain);

  function assertReady() {
    if (!baseUrl) throw new Error("宿主 App 未提供服务器域名");
    if (!token) throw new Error("登录信息已失效，请重新登录");
  }

  function buildUrl(path, params = {}) {
    assertReady();
    const query = { token, lang, ...params };
    const pairs = Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    return `${baseUrl}${path}${pairs.length ? `?${pairs.join("&")}` : ""}`;
  }

  async function request(path, { method = "GET", params, body } = {}) {
    const response = await fetch(buildUrl(path, params), {
      method,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify({ token, lang, ...body }) } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`网络请求失败（${response.status}）`);
    return unwrapResponse(text);
  }

  function getTemplates() {
    return request(`${API_PREFIX}/template/list`);
  }

  function getLanguages() {
    return request(`${API_PREFIX}/language/list`);
  }

  function getTaskInfo(taskId) {
    return request(`${API_PREFIX}/task/info`, { params: { task_id: taskId } });
  }

  function getAudioList(page = 1, pageCount = 20) {
    return request(`${API_PREFIX}/audio/list`, {
      params: { page, page_count: pageCount },
    });
  }

  function retranscribe({ taskId, taskVersion, sourceLang }) {
    return request(`${API_PREFIX}/task/retranscribe`, {
      method: "POST",
      body: {
        task_id: taskId,
        task_version: taskVersion,
        ...(sourceLang ? { source_lang: sourceLang } : {}),
      },
    });
  }

  function resummarize({ taskId, taskVersion, templateId }) {
    return request(`${API_PREFIX}/task/resummarize`, {
      method: "POST",
      body: {
        task_id: taskId,
        task_version: taskVersion,
        template_id: templateId,
      },
    });
  }

  function createTask({
    filePath,
    fileName,
    templateId,
    sourceLang = "auto",
    fileSource = "note",
    fileCreateTimestamp,
    onProgress,
  }) {
    assertReady();
    const path = String(filePath || "").replace(/^file:\/\//, "");
    if (!path) throw new Error("录音文件尚未下载到手机");
    const upload = RNFS.uploadFiles({
      toUrl: `${baseUrl}${API_PREFIX}/task/create`,
      method: "POST",
      headers: { Accept: "application/json" },
      fields: {
        token: String(token),
        lang: String(lang || "zh"),
        template_id: String(templateId),
        source_lang: String(sourceLang || "auto"),
        file_source: String(fileSource),
        ...(fileCreateTimestamp !== undefined
          ? { file_create_timestamp: String(fileCreateTimestamp) }
          : {}),
      },
      files: [
        {
          name: "file",
          filename: `${fileName || "recording"}.aac`,
          filepath: path,
          filetype: "audio/aac",
        },
      ],
      begin: () => onProgress?.(0),
      progress: ({ totalBytesSent, totalBytesExpectedToSend }) => {
        const progress = totalBytesExpectedToSend
          ? Math.min(99, Math.round((totalBytesSent / totalBytesExpectedToSend) * 100))
          : 0;
        onProgress?.(progress);
      },
    });
    return {
      jobId: upload.jobId,
      promise: upload.promise.then((result) => {
        if (Number(result.statusCode) < 200 || Number(result.statusCode) >= 300) {
          throw new Error(`文件上传失败（${result.statusCode}）`);
        }
        onProgress?.(100);
        return unwrapResponse(result.body);
      }),
    };
  }

  return {
    baseUrl,
    createTask,
    getAudioList,
    getLanguages,
    getTaskInfo,
    getTemplates,
    resummarize,
    retranscribe,
  };
}

module.exports = { createAudioAiApi, normalizeBaseUrl, unwrapResponse };
