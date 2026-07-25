const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const queue = document.querySelector("#queue");
const fileList = document.querySelector("#fileList");
const queueMeta = document.querySelector("#queueMeta");
const status = document.querySelector("#status");
const report = document.querySelector("#report");
const settingsDialog = document.querySelector("#settingsDialog");
const useVisionInput = document.querySelector("#useVision");
const visionProviderInput = document.querySelector("#visionProvider");
const visionApiStyleInput = document.querySelector("#visionApiStyle");
const visionBaseUrlInput = document.querySelector("#visionBaseUrl");
const visionModelInput = document.querySelector("#visionModel");
const visionApiKeyInput = document.querySelector("#visionApiKey");
const useTextModelInput = document.querySelector("#useTextModel");
const textProviderInput = document.querySelector("#textProvider");
const textBaseUrlInput = document.querySelector("#textBaseUrl");
const textModelInput = document.querySelector("#textModel");
const textApiKeyInput = document.querySelector("#textApiKey");
let files = [];

const presets = {
  openai: {
    apiStyle: "responses",
    baseUrl: "https://api.openai.com/v1",
    visionModel: "gpt-5.6",
    textModel: "gpt-5.6-mini",
    hint: "使用 OpenAI Responses API；视觉请求采用严格 JSON Schema。"
  },
  qwen: {
    apiStyle: "chat-completions",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    visionModel: "qwen3-vl-plus",
    textModel: "qwen-plus",
    hint: "正式分析使用流式响应，复杂页面可能需要 2–5 分钟。建议使用百炼控制台提供的 Workspace 专属 Base URL，以提高稳定性。"
  },
  deepseek: {
    apiStyle: "chat-completions",
    baseUrl: "https://api.deepseek.com",
    textModel: "deepseek-v4-flash",
    hint: "DeepSeek 用于 OCR 文本纠错；当前不作为图片视觉识别模型。"
  },
  custom: {
    apiStyle: "chat-completions",
    baseUrl: "",
    visionModel: "",
    textModel: "",
    hint: "填写兼容 OpenAI Responses 或 Chat Completions 的服务地址和模型名称。"
  }
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function applyVisionPreset() {
  const preset = presets[visionProviderInput.value];
  visionApiStyleInput.value = preset.apiStyle;
  visionBaseUrlInput.value = preset.baseUrl;
  visionModelInput.value = preset.visionModel;
  document.querySelector("#visionProviderHint").textContent = preset.hint;
}

function applyTextPreset() {
  const preset = presets[textProviderInput.value];
  textBaseUrlInput.value = preset.baseUrl;
  textModelInput.value = preset.textModel;
  document.querySelector("#textProviderHint").textContent = preset.hint;
}

visionProviderInput.addEventListener("change", applyVisionPreset);
textProviderInput.addEventListener("change", applyTextPreset);
applyVisionPreset();
applyTextPreset();

function renderFiles() {
  queue.hidden = files.length === 0;
  queueMeta.textContent = `${files.length} 张图片 · ${files.map((f) => (f.size / 1024 / 1024)).reduce((a, b) => a + b, 0).toFixed(1)} MB`;
  fileList.replaceChildren(...files.map((file) => {
    const card = document.createElement("article");
    card.className = "file-card";
    const image = document.createElement("img");
    image.src = URL.createObjectURL(file);
    image.onload = () => URL.revokeObjectURL(image.src);
    const label = document.createElement("div");
    label.textContent = file.name;
    card.append(image, label);
    return card;
  }));
}

function acceptFiles(list) {
  files = [...files, ...[...list].filter((file) => file.type.startsWith("image/"))];
  renderFiles();
}

dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => acceptFiles(fileInput.files));
for (const event of ["dragenter", "dragover"]) {
  dropZone.addEventListener(event, (e) => { e.preventDefault(); dropZone.classList.add("drag"); });
}
for (const event of ["dragleave", "drop"]) {
  dropZone.addEventListener(event, (e) => { e.preventDefault(); dropZone.classList.remove("drag"); });
}
dropZone.addEventListener("drop", (e) => acceptFiles(e.dataTransfer.files));
document.querySelector("#clearButton").addEventListener("click", () => {
  files = [];
  fileInput.value = "";
  renderFiles();
  report.hidden = true;
  status.hidden = true;
});
document.querySelector("#settingsButton").addEventListener("click", () => settingsDialog.showModal());

async function send(endpoint) {
  const data = new FormData();
  files.forEach((file) => data.append("images", file));
  data.append("useVision", useVisionInput.checked ? "true" : "false");
  data.append("visionProvider", visionProviderInput.value);
  data.append("visionApiStyle", visionApiStyleInput.value);
  data.append("visionBaseUrl", visionBaseUrlInput.value.trim());
  data.append("visionModel", visionModelInput.value.trim());
  if (useVisionInput.checked) data.append("visionApiKey", visionApiKeyInput.value.trim());
  data.append("useTextModel", useTextModelInput.checked ? "true" : "false");
  data.append("textProvider", textProviderInput.value);
  data.append("textBaseUrl", textBaseUrlInput.value.trim());
  data.append("textModel", textModelInput.value.trim());
  if (useTextModelInput.checked) data.append("textApiKey", textApiKeyInput.value.trim());
  status.hidden = false;
  const enhancements = [
    useVisionInput.checked ? "视觉分层" : "",
    useTextModelInput.checked ? "OCR 纠错" : ""
  ].filter(Boolean);
  const cloud = enhancements.length ? `，并调用大模型进行${enhancements.join("与")}` : "";
  status.textContent = endpoint === "/api/analyze"
    ? `正在分析版面、文字、图标与原生形状${cloud}。复杂页面的大模型分层可能需要 2–5 分钟，请勿关闭窗口…`
    : `正在生成可编辑 PowerPoint${cloud}…`;
  const response = await fetch(endpoint, { method: "POST", body: data });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || "处理失败");
  }
  return response;
}

function modelConfig(capability) {
  if (capability === "vision") {
    return {
      provider: visionProviderInput.value,
      apiStyle: visionApiStyleInput.value,
      baseUrl: visionBaseUrlInput.value.trim(),
      model: visionModelInput.value.trim(),
      apiKey: visionApiKeyInput.value.trim()
    };
  }
  return {
    provider: textProviderInput.value,
    apiStyle: "chat-completions",
    baseUrl: textBaseUrlInput.value.trim(),
    model: textModelInput.value.trim(),
    apiKey: textApiKeyInput.value.trim()
  };
}

async function testModel(capability) {
  const output = document.querySelector(capability === "vision" ? "#visionTestStatus" : "#textTestStatus");
  output.className = "test-status";
  output.textContent = capability === "vision"
    ? "正在测试图片输入与 JSON 输出…"
    : "正在测试文本纠错与 JSON 输出…";
  try {
    const response = await fetch("/api/model/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability, config: modelConfig(capability) })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "连接失败");
    output.className = "test-status success";
    output.textContent = result.message;
  } catch (error) {
    output.className = "test-status error";
    output.textContent = `失败：${error.message}`;
  }
}

document.querySelector("#testVisionButton").addEventListener("click", () => testModel("vision"));
document.querySelector("#testTextButton").addEventListener("click", () => testModel("text"));

document.querySelector("#analyzeButton").addEventListener("click", async () => {
  try {
    const response = await send("/api/analyze");
    const analyses = await response.json();
    report.hidden = false;
    report.innerHTML = `<table><thead><tr><th>页面</th><th>可编辑文字</th><th>原生形状</th><th>矢量图标</th><th>内容图片</th><th>视觉模型</th><th>文本模型</th></tr></thead><tbody>${analyses.map((a) => {
      const visionState = a.summary.visionUsed
        ? `${a.summary.visionProvider} / ${a.summary.visionModel}`
        : (a.summary.visionError ? `回退：${a.summary.visionError}` : "未启用");
      const textState = a.summary.textModelUsed
        ? `${a.summary.textModelProvider} / ${a.summary.textModelName}（修正 ${a.summary.textCorrectionCount}）`
        : (a.summary.textModelError ? `回退：${a.summary.textModelError}` : "未启用");
      return `<tr><td>${escapeHtml(a.sourceName)}</td><td>${a.summary.textCount}</td><td>${a.summary.nativeShapeCount}</td><td>${a.summary.iconCount}</td><td>${a.summary.pictureCount}</td><td>${escapeHtml(visionState)}</td><td>${escapeHtml(textState)}</td></tr>`;
    }).join("")}</tbody></table>`;
    status.textContent = "分析完成。文字、图标背景与图标前景已分层。";
  } catch (error) {
    status.textContent = `错误：${error.message}`;
  }
});

document.querySelector("#convertButton").addEventListener("click", async () => {
  try {
    const response = await send("/api/convert");
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "Img2PPT-editable.pptx";
    link.click();
    URL.revokeObjectURL(link.href);
    status.textContent = "生成完成。文字已去重，图标与背景已分层并纯色化。";
  } catch (error) {
    status.textContent = `错误：${error.message}`;
  }
});
