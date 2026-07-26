import fs from "node:fs/promises";
import JSZip from "jszip";

function blocks(xml, tag) {
  const expression = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "g");
  return xml.match(expression) || [];
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function relationshipTargets(xml) {
  const targets = new Map();
  for (const match of xml.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/?>/g)) {
    targets.set(match[1], match[2]);
  }
  return targets;
}

function pictureMedia(picture, targets) {
  const ids = [...picture.matchAll(/\br:embed="([^"]+)"/g)].map((match) => match[1]);
  const resolved = ids.map((id) => targets.get(id)).filter(Boolean);
  return {
    vector: resolved.some((target) => /\.svg(?:$|\?)/i.test(target)),
    targets: resolved
  };
}

function pictureAreaRatio(picture, slideWidth, slideHeight) {
  const match = picture.match(
    /<a:xfrm(?:\s[^>]*)?>[\s\S]*?<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"[^>]*\/>[\s\S]*?<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"[^>]*\/>/
  );
  if (!match || !slideWidth || !slideHeight) return 0;
  return Number(match[3]) * Number(match[4]) / (slideWidth * slideHeight);
}

export async function auditPptx(pptxPath) {
  const zip = await JSZip.loadAsync(await fs.readFile(pptxPath));
  const presentationXml = await zip.file("ppt/presentation.xml")?.async("string") || "";
  const slideSize = presentationXml.match(/<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/);
  const slideWidth = Number(slideSize?.[1] || 0);
  const slideHeight = Number(slideSize?.[2] || 0);
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const slides = [];
  for (const name of slideNames) {
    const xml = await zip.file(name).async("string");
    const relationshipName = name.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels";
    const relationshipXml = await zip.file(relationshipName)?.async("string") || "";
    const targets = relationshipTargets(relationshipXml);
    const shapeBlocks = blocks(xml, "p:sp");
    const pictureBlocks = blocks(xml, "p:pic");
    const media = pictureBlocks.map((picture) => pictureMedia(picture, targets));
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
      pictureCount: pictureBlocks.length,
      vectorPictureCount: media.filter((item) => item.vector).length,
      rasterPictureCount: media.filter((item) => !item.vector).length,
      maximumPictureAreaRatio: Math.max(
        0,
        ...pictureBlocks.map((picture) => pictureAreaRatio(picture, slideWidth, slideHeight))
      ),
      imageOnlyPage: pictureBlocks.length > 0 &&
        shapeBlocks.length === 0 &&
        Math.max(0, ...pictureBlocks.map((picture) =>
          pictureAreaRatio(picture, slideWidth, slideHeight)
        )) >= 0.9,
      textValues: [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
        .map((match) => decodeXml(match[1])),
      minFontPt: fontSizes.length ? Math.min(...fontSizes) : null,
      maxFontPt: fontSizes.length ? Math.max(...fontSizes) : null
    });
  }
  return {
    slides,
    passedTransparentText: slides.every((slide) => slide.filledTextShapeCount === 0),
    hasAppliedFontSizes: slides.every((slide) => slide.textShapeCount === 0 || slide.minFontPt !== null),
    passedEditablePages: slides.every((slide) => !slide.imageOnlyPage)
  };
}
