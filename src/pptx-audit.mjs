import fs from "node:fs/promises";
import JSZip from "jszip";

function blocks(xml, tag) {
  const expression = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "g");
  return xml.match(expression) || [];
}

export async function auditPptx(pptxPath) {
  const zip = await JSZip.loadAsync(await fs.readFile(pptxPath));
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const slides = [];
  for (const name of slideNames) {
    const xml = await zip.file(name).async("string");
    const shapeBlocks = blocks(xml, "p:sp");
    const textShapes = shapeBlocks.filter((shape) => /<a:t>/.test(shape));
    const filledTextShapes = textShapes.filter((shape) => {
      const properties = shape.match(/<p:spPr(?:\s[^>]*)?>([\s\S]*?)<\/p:spPr>/)?.[1] || "";
      return /<a:(?:solidFill|gradFill|blipFill)>/.test(properties);
    });
    const fontSizes = [];
    for (const shape of textShapes) {
      for (const match of shape.matchAll(/\bsz="(\d+)"/g)) {
        fontSizes.push(Number(match[1]) / 100);
      }
    }
    slides.push({
      name,
      shapeCount: shapeBlocks.length,
      textShapeCount: textShapes.length,
      filledTextShapeCount: filledTextShapes.length,
      pictureCount: (xml.match(/<p:pic>/g) || []).length,
      minFontPt: fontSizes.length ? Math.min(...fontSizes) : null,
      maxFontPt: fontSizes.length ? Math.max(...fontSizes) : null
    });
  }
  return {
    slides,
    passedTransparentText: slides.every((slide) => slide.filledTextShapeCount === 0),
    hasAppliedFontSizes: slides.every((slide) => slide.textShapeCount === 0 || slide.minFontPt !== null)
  };
}

