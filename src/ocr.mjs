import { createWorker, PSM } from "tesseract.js";

let workerPromise;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker("eng", 1, {
        logger: () => {}
      });
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        preserve_interword_spaces: "1"
      });
      return worker;
    })();
  }
  return workerPromise;
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
  const worker = await getWorker();
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const result = await worker.recognize(imageBuffer, {}, { blocks: true });
  return collectLines(result.data.blocks);
}

export { PSM };

export async function closeOcr() {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = undefined;
  }
}
