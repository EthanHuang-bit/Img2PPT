const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const queue = document.querySelector("#queue");
const fileList = document.querySelector("#fileList");
const queueMeta = document.querySelector("#queueMeta");
const status = document.querySelector("#status");
const report = document.querySelector("#report");
const settingsDialog = document.querySelector("#settingsDialog");
const analyzeButton = document.querySelector("#analyzeButton");
const convertButton = document.querySelector("#convertButton");
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
let pageStates = [];
let pageResults = [];
let analysisSessionId = null;
let analyzedSignature = null;
let busy = false;

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
    hint: "每页独立流式分析；整页失败时自动四分块并携带整页上下文。"
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

function currentSignature() {
  return files.map((file) => `${file.name}:${file.size}:${file.lastModified}`).join("|");
}

function pageStatus(state) {
  if (state === "processing") return "分析中";
  if (state === "completed") return "已完成";
  if (state === "failed") return "失败";
  return "等待";
}

function renderFiles() {
  queue.hidden = files.length === 0;
  queueMeta.textContent = `${files.length} 张图片 · ${files
    .map((file) => file.size / 1024 / 1024)
    .reduce((a, b) => a + b, 0)
    .toFixed(1)} MB · 最高 20 页并发`;
  fileList.replaceChildren(...files.map((file, index) => {
    const card = document.createElement("article");
    card.className = `file-card state-${pageStates[index] || "pending"}`;
    const image = document.createElement("img");
    image.src = URL.createObjectURL(file);
    image.onload = () => URL.revokeObjectURL(image.src);
    const footer = document.createElement("div");
    footer.className = "file-footer";
    const label = document.createElement("span");
    label.className = "file-name";
    label.textContent = file.name;
    const badge = document.createElement("strong");
    badge.className = "page-state";
    badge.textContent = pageStatus(pageStates[index]);
    footer.append(label, badge);
    const summary = pageResults[index]?.summary;
    if (summary) {
      const detail = document.createElement("small");
      detail.textContent = `文字 ${summary.textCount} · 形状 ${summary.nativeShapeCount} · 图标 ${summary.iconCount}${summary.visionFallbackUsed ? " · 四分块回退" : ""}`;
      card.append(image, footer, detail);
    } else {
      card.append(image, footer);
    }
    return card;
  }));
}

function resetAnalysisState() {
  if (analysisSessionId) {
    fetch(`/api/session/${encodeURIComponent(analysisSessionId)}`, {
      method: "DELETE"
    }).catch(() => {});
  }
  analysisSessionId = null;
  analyzedSignature = null;
  pageStates = files.map(() => "pending");
  pageResults = files.map(() => null);
}

function acceptFiles(list) {
  const incoming = [...list].filter((file) => file.type.startsWith("image/"));
  if (!incoming.length) return;
  files = [...files, ...incoming].slice(0, 50);
  resetAnalysisState();
  renderFiles();
}

dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => acceptFiles(fileInput.files));
for (const event of ["dragenter", "dragover"]) {
  dropZone.addEventListener(event, (e) => {
    e.preventDefault();
    dropZone.classList.add("drag");
  });
}
for (const event of ["dragleave", "drop"]) {
  dropZone.addEventListener(event, (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag");
  });
}
dropZone.addEventListener("drop", (e) => acceptFiles(e.dataTransfer.files));

function setBusy(value) {
  busy = value;
  analyzeButton.disabled = value;
  convertButton.disabled = value;
  document.querySelector("#clearButton").disabled = value;
}

function showProgress(completed, total, message) {
  const percent = total ? Math.round(completed / total * 10000) / 100 : 0;
  status.hidden = false;
  status.innerHTML = `<div class="status-line"><strong>${escapeHtml(message)}</strong><span>${completed}/${total} · ${percent.toFixed(2)}%</span></div><div class="progress-track"><span style="width:${percent}%"></span></div>`;
}

function modelFields(data) {
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
  return data;
}

async function createSession() {
  const sessionId = globalThis.crypto?.randomUUID?.() ||
    `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, total: files.length })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "无法创建分析会话");
  return body.sessionId;
}

async function analyzePage(file, index, total, sessionId) {
  const data = modelFields(new FormData());
  data.append("image", file);
  data.append("index", String(index));
  data.append("total", String(total));
  data.append("sessionId", sessionId);
  const response = await fetch("/api/analyze/page", { method: "POST", body: data });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "页面分析失败");
  return body.analysis;
}

async function mapLimit(items, limit, worker, onSettled) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        const value = await worker(items[index], index);
        await onSettled({ index, status: "fulfilled", value });
      } catch (reason) {
        await onSettled({ index, status: "rejected", reason });
      }
    }
  });
  await Promise.all(runners);
}

function analysisReport() {
  report.hidden = false;
  report.innerHTML = `<table><thead><tr><th>页面</th><th>状态</th><th>文字</th><th>原生形状</th><th>矢量图标</th><th>视觉模型</th><th>回退</th></tr></thead><tbody>${files.map((file, index) => {
    const analysis = pageResults[index];
    const summary = analysis?.summary;
    const visionState = summary?.visionUsed
      ? `${summary.visionProvider} / ${summary.visionModel}`
      : (summary?.visionError ? `本地回退：${summary.visionError}` : "未启用");
    return `<tr><td>${escapeHtml(file.name)}</td><td>${pageStatus(pageStates[index])}</td><td>${summary?.textCount ?? "—"}</td><td>${summary?.nativeShapeCount ?? "—"}</td><td>${summary?.iconCount ?? "—"}</td><td>${escapeHtml(visionState)}</td><td>${summary?.visionFallbackUsed ? `四分块（成功 ${summary.visionFallbackSuccessfulRegions}/4）` : "—"}</td></tr>`;
  }).join("")}</tbody></table>`;
}

async function runAnalysis() {
  if (!files.length) throw new Error("请先选择图片。");
  setBusy(true);
  resetAnalysisState();
  analysisSessionId = await createSession();
  const signature = currentSignature();
  let settled = 0;
  let failed = 0;
  showProgress(0, files.length, "正在并发分析，每张图片单独处理");
  await mapLimit(files, 20, async (file, index) => {
    pageStates[index] = "processing";
    renderFiles();
    try {
      return await analyzePage(file, index, files.length, analysisSessionId);
    } catch (firstError) {
      return analyzePage(file, index, files.length, analysisSessionId)
        .catch(() => { throw firstError; });
    }
  }, async (event) => {
    settled += 1;
    if (event.status === "fulfilled") {
      pageStates[event.index] = "completed";
      pageResults[event.index] = event.value;
    } else {
      failed += 1;
      pageStates[event.index] = "failed";
      pageResults[event.index] = {
        error: String(event.reason?.message || event.reason)
      };
    }
    renderFiles();
    analysisReport();
    showProgress(settled, files.length, failed
      ? `已处理 ${settled} 页，其中 ${failed} 页失败`
      : "分析结果已逐页保存并刷新");
  });
  if (failed) {
    analyzedSignature = null;
    throw new Error(`${failed} 页在自动重试后仍失败；其他页面结果已保留，可再次点击“先分析”重试。`);
  }
  analyzedSignature = signature;
  showProgress(files.length, files.length, "分析完成；生成 PPT 将直接复用缓存");
  return true;
}

function decodeQaHeader(value) {
  if (!value) return null;
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function renderQualityReport(qa) {
  if (!qa) return;
  const table = `<h3>逐页质量门禁</h3><p>完整验证需要本机 PowerPoint 渲染和已启用的视觉模型；未调用模型时标记为“本地预检”。</p><table><thead><tr><th>页面</th><th>综合</th><th>内容</th><th>版式</th><th>观感</th><th>可编辑</th><th>验证级别</th><th>结果</th></tr></thead><tbody>${(qa.pages || []).map((page) => `<tr><td>${escapeHtml(page.sourceName)}</td><td>${(page.overallScore * 100).toFixed(2)}%</td><td>${(page.contentScore * 100).toFixed(2)}%</td><td>${(page.layoutScore * 100).toFixed(2)}%</td><td>${(page.appearanceScore * 100).toFixed(2)}%</td><td>${(page.editabilityScore * 100).toFixed(2)}%</td><td>${escapeHtml(page.validationLevel)}</td><td class="${page.passed ? "good" : "warn"}">${page.passed ? "通过" : "需复核"}</td></tr>`).join("")}</tbody></table>${qa.error ? `<p class="warning">未能完成渲染评分：${escapeHtml(qa.error)}</p>` : ""}`;
  report.hidden = false;
  report.innerHTML += table;
}

function downloadBlob(blob, name) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.append(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(link.href);
    link.remove();
  }, 1000);
}

document.querySelector("#clearButton").addEventListener("click", () => {
  resetAnalysisState();
  files = [];
  pageStates = [];
  pageResults = [];
  fileInput.value = "";
  renderFiles();
  report.hidden = true;
  report.innerHTML = "";
  status.hidden = true;
});

document.querySelector("#settingsButton").addEventListener("click", () => settingsDialog.showModal());

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

analyzeButton.addEventListener("click", async () => {
  if (busy) return;
  try {
    await runAnalysis();
  } catch (error) {
    status.hidden = false;
    status.textContent = `错误：${error.message}`;
  } finally {
    setBusy(false);
  }
});

convertButton.addEventListener("click", async () => {
  if (busy) return;
  try {
    if (analyzedSignature !== currentSignature() ||
        pageStates.some((state) => state !== "completed")) {
      await runAnalysis();
    }
    setBusy(true);
    status.hidden = false;
    status.textContent = "正在使用已缓存分析生成 PPT，并渲染每页进行质量评估…";
    const data = modelFields(new FormData());
    data.append("sessionId", analysisSessionId);
    const response = await fetch("/api/convert", { method: "POST", body: data });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(body.error || "生成失败");
    }
    const qa = decodeQaHeader(response.headers.get("X-Img2PPT-QA"));
    const blob = await response.blob();
    downloadBlob(blob, "Img2PPT-editable.pptx");
    let fullQa = qa;
    if (qa?.reportAvailable) {
      const qualityResponse = await fetch(
        `/api/session/${encodeURIComponent(analysisSessionId)}/quality`
      );
      if (qualityResponse.ok) fullQa = await qualityResponse.json();
    }
    analysisReport();
    renderQualityReport(fullQa);
    const average = fullQa?.summary?.averageScore;
    status.textContent = Number.isFinite(average)
      ? `生成完成，已复用分析缓存；平均相似度 ${(average * 100).toFixed(2)}%，${fullQa.summary.allPassed ? "全部通过门禁" : "存在需复核页面"}。`
      : "生成完成，已复用分析缓存；当前环境无法渲染 PPT，因此未伪造相似度分数。";
  } catch (error) {
    status.hidden = false;
    status.textContent = `错误：${error.message}`;
  } finally {
    setBusy(false);
  }
});
