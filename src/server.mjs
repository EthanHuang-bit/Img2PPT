import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import express from "express";
import multer from "multer";
import { analyzeImage } from "./analyzer.mjs";
import { mapConcurrent, Semaphore } from "./async-pool.mjs";
import { convertImages, writePptx } from "./converter.mjs";
import { normalizeModelConfig } from "./model-client.mjs";
import { auditPptx } from "./pptx-audit.mjs";
import { evaluateDeckQuality } from "./qa.mjs";
import { AnalysisSessionCache, validateSessionId } from "./session-cache.mjs";
import { testTextModel } from "./text-model.mjs";
import { testVisionModel } from "./vision.mjs";

const VERSION = "0.7.0-recovery";
const app = express();
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 50 }
});
const preferredPort = Number(process.env.IMG2PPT_PORT || 4173);
const publicDir = path.join(appRoot, "public");
const sessionCache = new AnalysisSessionCache({
  ttlMs: 60 * 60 * 1000,
  maxSessions: 8
});
const pageLimiter = new Semaphore(20);

app.use(express.static(publicDir));
app.use(express.json({ limit: "64kb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    pageConcurrency: 20,
    ocrConcurrency: 4,
    qualityLoopMaximum: 10
  });
});

function visionOptions(req) {
  const enabled = req.body?.useVision === "true" || req.body?.useVision === true;
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
  const enabled = req.body?.useTextModel === "true" || req.body?.useTextModel === true;
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

function compactQualityReport(report, audit, cacheReused) {
  return {
    version: VERSION,
    cacheReused,
    audit: {
      passedTransparentText: audit.passedTransparentText,
      hasAppliedFontSizes: audit.hasAppliedFontSizes,
      passedEditablePages: audit.passedEditablePages
    },
    summary: report?.summary || {
      pageCount: audit.slides.length,
      passedPages: 0,
      allPassed: false,
      averageScore: null,
      validationLevel: "not-rendered"
    },
    reportAvailable: Boolean(report?.pages?.length),
    error: report?.error || null
  };
}

app.post("/api/session", (req, res) => {
  try {
    const session = sessionCache.create({
      sessionId: req.body?.sessionId || crypto.randomUUID(),
      total: Number(req.body?.total)
    });
    res.json({ sessionId: session.id, total: session.total });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/session/:sessionId", (req, res) => {
  try {
    res.json(sessionCache.status(req.params.sessionId));
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.get("/api/session/:sessionId/quality", (req, res) => {
  try {
    res.json(sessionCache.quality(req.params.sessionId));
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.delete("/api/session/:sessionId", (req, res) => {
  try {
    res.json({
      ok: sessionCache.delete(req.params.sessionId),
      sessionId: validateSessionId(req.params.sessionId)
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/analyze/page", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) throw new Error("请选择一张图片。");
    const total = Number(req.body?.total);
    const index = Number(req.body?.index);
    const session = sessionCache.create({
      sessionId: req.body?.sessionId,
      total
    });
    const vision = visionOptions(req);
    const textModel = textModelOptions(req);
    const analysis = await pageLimiter.run(() => analyzeImage(req.file.buffer, {
      sourceName: req.file.originalname,
      vision,
      textModel
    }));
    const status = sessionCache.setPage(session.id, index, {
      name: req.file.originalname,
      buffer: req.file.buffer,
      analysis
    });
    res.json({
      sessionId: session.id,
      index,
      total,
      completed: status.completed,
      progress: status.progress,
      analysis
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/analyze", upload.array("images", 50), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) throw new Error("请选择至少一张图片。");
    const vision = visionOptions(req);
    const textModel = textModelOptions(req);
    const analyses = await mapConcurrent(files, (file) =>
      pageLimiter.run(() => analyzeImage(file.buffer, {
        sourceName: file.originalname,
        vision,
        textModel
      })), { concurrency: 20 });
    res.json(analyses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/convert", upload.array("images", 50), async (req, res) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "img2ppt-"));
  const draftPath = path.join(tempDir, "Img2PPT-draft.pptx");
  const finalPath = path.join(tempDir, "Img2PPT-editable.pptx");
  try {
    const vision = visionOptions(req);
    const textModel = textModelOptions(req);
    const sessionId = String(req.body?.sessionId || "").trim();
    let items;
    let analyses;
    let cacheReused = false;
    if (sessionId) {
      const pages = sessionCache.orderedPages(sessionId);
      items = pages.map((page) => ({ name: page.name, buffer: page.buffer }));
      analyses = pages.map((page) => page.analysis);
      await writePptx(items, analyses, draftPath);
      cacheReused = true;
    } else {
      items = (req.files || []).map((file) => ({
        name: file.originalname,
        buffer: file.buffer
      }));
      analyses = await convertImages(items, draftPath, {
        vision,
        textModel,
        concurrency: 20
      });
    }

    const audit = await auditPptx(draftPath);
    let qualityReport;
    try {
      qualityReport = await evaluateDeckQuality({
        pptxPath: draftPath,
        renderDir: path.join(tempDir, "rendered"),
        items,
        analyses,
        audit,
        vision
      });
    } catch (error) {
      qualityReport = {
        error: error.message,
        pages: [],
        summary: {
          pageCount: items.length,
          passedPages: 0,
          allPassed: false,
          averageScore: null,
          validationLevel: "not-rendered"
        }
      };
    }

    if (qualityReport.pages.length === items.length) {
      await writePptx(items, analyses, finalPath, {
        qualityByPage: qualityReport.pages
      });
    } else {
      await fs.copyFile(draftPath, finalPath);
    }
    const finalAudit = await auditPptx(finalPath);
    const pptx = await fs.readFile(finalPath);
    const report = compactQualityReport(qualityReport, finalAudit, cacheReused);
    if (sessionId) {
      sessionCache.setQuality(sessionId, {
        ...qualityReport,
        version: VERSION,
        cacheReused,
        audit: report.audit
      });
    }
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
    res.setHeader("Content-Disposition", 'attachment; filename="Img2PPT-editable.pptx"');
    res.setHeader("X-Img2PPT-QA", Buffer.from(JSON.stringify(report)).toString("base64"));
    res.setHeader("X-Img2PPT-Cache-Reused", String(cacheReused));
    res.send(pptx);
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
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
    console.log(`Img2PPT v${VERSION} is running at ${url}`);
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
