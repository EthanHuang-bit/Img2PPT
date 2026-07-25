import fs from "node:fs/promises";
import path from "node:path";
import { convertImages } from "../src/converter.mjs";
import { auditPptx } from "../src/pptx-audit.mjs";
import { closeOcr } from "../src/ocr.mjs";

const inputDir = path.resolve(process.argv[2] || "upload");
const outputPath = path.resolve(process.argv[3] || "output/Img2PPT-validation-12-pages.pptx");
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const names = (await fs.readdir(inputDir))
  .filter((name) => /\.(png|jpe?g|webp)$/i.test(name))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const items = await Promise.all(names.map(async (name) => ({
  name,
  buffer: await fs.readFile(path.join(inputDir, name))
})));
try {
  await convertImages(items, outputPath, { title: "Img2PPT 12-page validation" });
  const audit = await auditPptx(outputPath);
  await fs.writeFile(`${outputPath}.audit.json`, JSON.stringify(audit, null, 2));
  console.log(`Validation deck: ${outputPath}`);
  console.log(`Transparent text: ${audit.passedTransparentText}; applied font sizes: ${audit.hasAppliedFontSizes}`);
} finally {
  await closeOcr();
}

