import fs from "node:fs/promises";
import path from "node:path";
import { convertImages } from "../src/converter.mjs";
import { renderPptx, compareImages } from "../src/qa.mjs";
import { closeOcr } from "../src/ocr.mjs";
import { auditPptx } from "../src/pptx-audit.mjs";

const inputDir = path.resolve(process.argv[2] || "upload");
const outputDir = path.resolve("output/regression");
await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });
const names = (await fs.readdir(inputDir))
  .filter((name) => /\.(png|jpe?g|webp)$/i.test(name))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

const rows = [];
try {
  for (const name of names) {
    const sourcePath = path.join(inputDir, name);
    const stem = path.basename(name, path.extname(name));
    const pptxPath = path.join(outputDir, `${stem}.pptx`);
    const renderDir = path.join(outputDir, `${stem}-render`);
    const diffPath = path.join(outputDir, `${stem}-diff.png`);
    const buffer = await fs.readFile(sourcePath);
    const [analysis] = await convertImages([{ name, buffer }], pptxPath);
    const audit = await auditPptx(pptxPath);
    const [rendered] = await renderPptx(pptxPath, renderDir);
    const metrics = await compareImages(sourcePath, rendered, diffPath);
    rows.push({ name, analysis, audit, metrics, rendered: path.relative(outputDir, rendered), diff: path.relative(outputDir, diffPath) });
    console.log(`${name}: similarity=${metrics.similarity.toFixed(4)}, native=${analysis.summary.nativeShapeCount}, text=${analysis.summary.textCount}`);
  }
} finally {
  await closeOcr();
}

const html = `<!doctype html><meta charset="utf-8"><title>Img2PPT Regression</title><style>body{font-family:Arial;margin:24px;color:#172033}table{border-collapse:collapse;width:100%}th,td{padding:9px;border:1px solid #d9dee8;text-align:left}img{width:320px;height:auto}td.good{color:#14753a}td.warn{color:#a43c13}</style><h1>Img2PPT regression report</h1><p>Generated ${new Date().toISOString()}. Large filled fallback must remain 0 and filled text boxes must remain 0.</p><table><thead><tr><th>Source</th><th>Similarity</th><th>Text</th><th>Native shapes</th><th>Small SVG</th><th>Large fallback</th><th>Filled text boxes</th><th>Font range</th><th>Rendered</th><th>Difference</th></tr></thead><tbody>${rows.map(({ name, analysis, audit, metrics, rendered, diff }) => `<tr><td>${name}</td><td>${metrics.similarity.toFixed(4)}</td><td>${analysis.summary.textCount}</td><td>${analysis.summary.nativeShapeCount}</td><td>${analysis.summary.iconCount}</td><td class="good">0</td><td class="${audit.passedTransparentText ? "good" : "warn"}">${audit.slides[0].filledTextShapeCount}</td><td>${audit.slides[0].minFontPt ?? "—"}–${audit.slides[0].maxFontPt ?? "—"} pt</td><td><img src="${rendered}"></td><td><img src="${diff}"></td></tr>`).join("")}</tbody></table>`;
await fs.writeFile(path.join(outputDir, "report.html"), html);
await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(rows, null, 2));
console.log(`Report: ${path.join(outputDir, "report.html")}`);
