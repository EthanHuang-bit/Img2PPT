import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import multer from "multer";
import { convertImages } from "./converter.mjs";
import { auditPptx } from "./pptx-audit.mjs";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 50 }
});
const port = Number(process.env.IMG2PPT_PORT || 4173);
const publicDir = path.resolve("public");

app.use(express.static(publicDir));

app.post("/api/convert", upload.array("images", 50), async (req, res) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "img2ppt-"));
  const pptxPath = path.join(tempDir, "Img2PPT-editable.pptx");
  try {
    const items = (req.files || []).map((file) => ({
      name: file.originalname,
      buffer: file.buffer
    }));
    const analyses = await convertImages(items, pptxPath);
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
    for (const file of req.files || []) {
      analyses.push(await analyzeImage(file.buffer, { sourceName: file.originalname }));
    }
    res.json(analyses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Img2PPT running at http://127.0.0.1:${port}`);
});
