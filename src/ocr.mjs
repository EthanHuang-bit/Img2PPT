import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorker, PSM } from "tesseract.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_OCR_WORKERS = 4;
const workers = new Set();
const idleWorkers = [];
const waiters = [];
let creatingWorkers = 0;

async function makeWorker() {
  const worker = await createWorker("eng", 1, {
    logger: () => {},
    langPath: appRoot,
    gzip: false,
    cacheMethod: "none"
  });
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    preserve_interword_spaces: "1"
  });
  workers.add(worker);
  return worker;
}

async function acquireWorker() {
  const idle = idleWorkers.pop();
  if (idle) return idle;
  if (workers.size + creatingWorkers < MAX_OCR_WORKERS) {
    creatingWorkers += 1;
    try {
      return await makeWorker();
    } finally {
      creatingWorkers -= 1;
    }
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function releaseWorker(worker) {
  const next = waiters.shift();
  if (next) next(worker);
  else idleWorkers.push(worker);
}

function normalizeText(value) {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function collectLines(blocks = []) {
  const lines = [];
  for (const block of blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        const text = normalizeText(line.text || "");
        if (!text) continue;
        lines.push({
          text,
          confidence: line.confidence ?? block.confidence ?? 0,
          bbox: {
            x0: line.bbox.x0,
            y0: line.bbox.y0,
            x1: line.bbox.x1,
            y1: line.bbox.y1
          },
          words: (line.words || []).map((word) => ({
            text: normalizeText(word.text || ""),
            confidence: word.confidence ?? 0,
            bbox: { ...word.bbox }
          })).filter((word) => word.text)
        });
      }
    }
  }
  return lines;
}

export async function recognizeText(imageBuffer, { psm = PSM.SPARSE_TEXT } = {}) {
  const worker = await acquireWorker();
  try {
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const result = await worker.recognize(imageBuffer, {}, { blocks: true });
    return collectLines(result.data.blocks);
  } finally {
    releaseWorker(worker);
  }
}

export { PSM };

export async function closeOcr() {
  if (waiters.length) throw new Error("Cannot close OCR while requests are waiting.");
  const current = [...workers];
  workers.clear();
  idleWorkers.length = 0;
  await Promise.all(current.map((worker) => worker.terminate()));
}

export function ocrPoolStatus() {
  return {
    maximum: MAX_OCR_WORKERS,
    created: workers.size,
    idle: idleWorkers.length,
    waiting: waiters.length
  };
}
