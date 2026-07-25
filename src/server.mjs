import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { convertImages } from "./converter.mjs";
import { auditPptx } from "./pptx-audit.mjs";
import { normalizeModelConfig } from "./model-client.mjs";
import { testTextModel } from "./text-model.mjs";
import { testVisionModel } from "./vision.mjs";

const app = express();
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 50 }
});
const preferredPort = Number(process.env.IMG2PPT_PORT || 4173);
const publicDir = path.join(appRoot, "public");

app.use(express.static(publicDir));
app.use(express.json({ limit: "64kb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, version: "0.5.1" });
});

function visionOptions(req) {
  const enabled = req.body?.useVision === "true";
  const apiKey = String(req.body?.visionApiKey || req.body?.apiKey || "").trim();
  const requestedModel = String(req.body?.visionModel || "gpt-5.6").trim();
  const options = {
    enabled,
    apiKey,
    model: requestedModel,
    provider: String(req.body?.visionProvider || "openai"),
    apiStyle: String(req.body?.visionApiStyle || "responses"),
    baseUrl: String(req.body?.visionBaseUrl || "https://api.openai.com/v1")
  };
  if (enabled) normalizeModelConfig(options, { capability: "vision" });
  return options;
}

function textModelOptions(req) {
  const enabled = req.body?.useTextModel === "true";
  const options = {
    enabled,
    apiKey: String(req.body?.textApiKey || "").trim(),
    model: String(req.body?.textModel || "").trim(),
    provider: String(req.body?.textProvider || "deepseek"),
    apiStyle: "chat-completions",
    baseUrl: String(req.body?.textBaseUrl || "https://api.deepseek.com")
  };
  if (enabled) normalizeModelConfig(options, { capability: "text" });
  return options;
}

app.post("/api/convert", upload.array("images", 50), async (req, res) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "img2ppt-"));
  const pptxPath = path.join(tempDir, "Img2PPT-editable.pptx");
  try {
    const items = (req.files || []).map((file) => ({
      name: file.originalname,
      buffer: file.buffer
    }));
    const analyses = await convertImages(items, pptxPath, {
      vision: visionOptions(req),
      textModel: textModelOptions(req)
    });
    const audit = await auditPptx(pptxPath);
    const pptx = await fs.readFile(pptxPath);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", 'attachment; filename="Img2PPT-editable.pptx"');
    res.setHeader("X-Img2PPT-QA", Buffer.from(JSON.stringify({
      analyses: analyses.map((a) => a.summary),
      audit
    })).toString("base64"));
    res.send(pptx);
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

app.post("/api/analyze", upload.array("images", 50), async (req, res) => {
  try {
    const { analyzeImage } = await import("./analyzer.mjs");
    const analyses = [];
    const vision = visionOptions(req);
    const textModel = textModelOptions(req);
    for (const file of req.files || []) {
      analyses.push(await analyzeImage(file.buffer, {
        sourceName: file.originalname,
        vision,
        textModel
      }));
    }
    res.json(analyses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/model/test", async (req, res) => {
  try {
    const capability = req.body?.capability === "text" ? "text" : "vision";
    const config = normalizeModelConfig(req.body?.config || {}, { capability });
    const result = capability === "vision"
      ? await testVisionModel(config, { timeoutMs: 60000 })
      : await testTextModel(config, { timeoutMs: 60000 });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

function openBrowser(url) {
  if (process.platform !== "win32" || process.env.IMG2PPT_NO_BROWSER === "1") return;
  const child = spawn("cmd.exe", ["/d", "/s", "/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function startServer(port, attemptsLeft = 20) {
  const server = app.listen(port, "127.0.0.1");
  server.once("listening", () => {
    const url = `http://127.0.0.1:${port}`;
    console.log("");
    console.log(`Img2PPT v0.5.1 is running at ${url}`);
    console.log("Keep this window open while using Img2PPT.");
    console.log("Press Ctrl+C or close this window to stop.");
    openBrowser(url);
  });
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
      startServer(port + 1, attemptsLeft - 1);
      return;
    }
    console.error(`Unable to start Img2PPT: ${error.message}`);
    process.exitCode = 1;
  });
}

startServer(preferredPort);
