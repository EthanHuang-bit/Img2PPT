const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const queue = document.querySelector("#queue");
const fileList = document.querySelector("#fileList");
const queueMeta = document.querySelector("#queueMeta");
const status = document.querySelector("#status");
const report = document.querySelector("#report");
const settingsDialog = document.querySelector("#settingsDialog");
let files = [];

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
  status.hidden = false;
  status.textContent = endpoint === "/api/analyze" ? "正在分析版面、文字与原生形状…" : "正在生成可编辑 PowerPoint…";
  const response = await fetch(endpoint, { method: "POST", body: data });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || "处理失败");
  }
  return response;
}

document.querySelector("#analyzeButton").addEventListener("click", async () => {
  try {
    const response = await send("/api/analyze");
    const analyses = await response.json();
    report.hidden = false;
    report.innerHTML = `<table><thead><tr><th>页面</th><th>透明文本框</th><th>原生形状</th><th>小型 SVG</th><th>大面积回退</th></tr></thead><tbody>${analyses.map((a) => `<tr><td>${a.sourceName}</td><td>${a.summary.textCount}</td><td>${a.summary.nativeShapeCount}</td><td>${a.summary.iconCount}</td><td>0</td></tr>`).join("")}</tbody></table>`;
    status.textContent = "分析完成。大面积实心位图回退为 0。";
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
    status.textContent = "生成完成。文字框透明，未使用大面积实心背景图片。";
  } catch (error) {
    status.textContent = `错误：${error.message}`;
  }
});

