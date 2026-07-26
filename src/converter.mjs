import PptxGenJS from "pptxgenjs";
import { analyzeImage } from "./analyzer.mjs";
import { mapConcurrent, normalizeConcurrency } from "./async-pool.mjs";
import { RECONSTRUCTION_POLICY, isForbiddenFilledFallback } from "./policy.mjs";
import { catalogIconSvg } from "./icons.mjs";
import { cleanPictureData, smallDetailSvg } from "./svg.mjs";

function toSlideBox(bbox, analysis) {
  const sx = analysis.slide.width / analysis.image.width;
  const sy = analysis.slide.height / analysis.image.height;
  return {
    x: bbox.x0 * sx,
    y: bbox.y0 * sy,
    w: Math.max(0.01, (bbox.x1 - bbox.x0) * sx),
    h: Math.max(0.01, (bbox.y1 - bbox.y0) * sy)
  };
}

function svgDataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function overlapRatio(a, b) {
  const width = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const height = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const intersection = width * height;
  const bArea = Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0));
  return intersection / bArea;
}

function addNativeShape(slide, component, analysis, pptx) {
  const box = toSlideBox(component.bbox, analysis);
  const fill = { color: component.colorHex, transparency: 0 };
  const noLine = { color: component.colorHex, transparency: 100 };
  if (component.type === "rect") {
    slide.addShape(pptx.ShapeType.rect, { ...box, fill, line: noLine });
  } else if (component.type === "roundRect") {
    slide.addShape(pptx.ShapeType.roundRect, { ...box, fill, line: noLine, radius: 0.08 });
  } else if (component.type === "ellipse") {
    slide.addShape(pptx.ShapeType.ellipse, { ...box, fill, line: noLine });
  } else if (component.type === "outlineRect") {
    slide.addShape(component.areaRatio > 0.5 || component.hasSharpCorners ? pptx.ShapeType.rect : pptx.ShapeType.roundRect, {
      ...box,
      fill: component.areaRatio < 0.5 && component.hasDistinctInterior
        ? { color: component.interiorColorHex, transparency: 0 }
        : { color: "FFFFFF", transparency: 100 },
      line: { color: component.colorHex, width: 0.65 }
    });
  } else if (component.type === "line") {
    const horizontal = component.width >= component.height;
    slide.addShape(pptx.ShapeType.line, {
      x: box.x,
      y: box.y,
      w: horizontal ? box.w : 0,
      h: horizontal ? 0 : box.h,
      line: { color: component.colorHex, width: Math.max(0.45, Math.min(2.5, (horizontal ? box.h : box.w) * 72)) }
    });
  }
}

function addText(slide, line, analysis) {
  const box = toSlideBox(line.bbox, analysis);
  const widthPadding = Math.max(0.025, Math.min(0.09, box.w * 0.035));
  const heightPadding = Math.max(0.012, box.h * 0.08);
  slide.addText(line.text, {
    x: Math.max(0, box.x - widthPadding / 2),
    y: Math.max(0, box.y - heightPadding),
    w: Math.min(analysis.slide.width - box.x + widthPadding / 2, box.w + widthPadding),
    h: Math.min(analysis.slide.height - box.y, box.h + heightPadding * 2),
    fontFace: line.style.fontFace,
    fontSize: line.style.fontSize,
    bold: line.style.bold,
    color: line.colorHex,
    margin: 0,
    breakLine: false,
    fit: "shrink",
    valign: "mid",
    paraSpaceAfterPt: 0,
    lineSpacingMultiple: 1
    // Intentionally no fill, no line and no text transparency:
    // the text box itself is transparent while glyphs remain visible.
  });
}

function addIconBackground(slide, component, analysis, pptx) {
  if (!component.backgroundShape || component.backgroundShape === "none") return;
  const box = toSlideBox(component.bbox, analysis);
  const shapeType = {
    rect: pptx.ShapeType.rect,
    roundRect: pptx.ShapeType.roundRect,
    ellipse: pptx.ShapeType.ellipse
  }[component.backgroundShape];
  if (!shapeType) return;
  slide.addShape(shapeType, {
    ...box,
    fill: { color: component.backgroundColorHex, transparency: 0 },
    line: { color: component.backgroundColorHex, transparency: 100 }
  });
}

export async function convertImages(items, outputPath, {
  title = "Img2PPT editable export",
  vision = {},
  textModel = {},
  concurrency = 20,
  onPageComplete,
  qualityByPage = []
} = {}) {
  if (!items.length) throw new Error("At least one image is required.");
  const analyses = await mapConcurrent(items, async (item) =>
    analyzeImage(item.buffer, {
      sourceName: item.name,
      vision,
      textModel
    }), {
    concurrency: normalizeConcurrency(concurrency, 20, 20),
    onSettled: async (event) => {
      if (event.status === "fulfilled") {
        await onPageComplete?.({
          index: event.index,
          item: event.item,
          analysis: event.value
        });
      }
    }
  });
  await writePptx(items, analyses, outputPath, { title, qualityByPage });
  return analyses;
}

export async function writePptx(items, analyses, outputPath, {
  title = "Img2PPT editable export",
  qualityByPage = []
} = {}) {
  if (!items.length || items.length !== analyses.length) {
    throw new Error("PPT generation requires one cached analysis per image.");
  }
  const pptx = new PptxGenJS();
  const first = analyses[0];
  pptx.defineLayout({ name: "IMG2PPT", width: first.slide.width, height: first.slide.height });
  pptx.layout = "IMG2PPT";
  pptx.author = "Img2PPT";
  pptx.subject = "Editable reconstruction from image";
  pptx.title = title;
  pptx.company = "Local conversion";
  pptx.lang = "en-US";
  pptx.theme = {
    headFontFace: RECONSTRUCTION_POLICY.defaultFontFace,
    bodyFontFace: RECONSTRUCTION_POLICY.defaultFontFace,
    lang: "en-US"
  };

  for (let index = 0; index < analyses.length; index += 1) {
    const analysis = analyses[index];
    const item = items[index];
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };

    // Draw structural shapes first so all text stays above them.
    for (const component of analysis.components) {
      if (["rect", "roundRect", "ellipse", "outlineRect", "line"].includes(component.type)) {
        addNativeShape(slide, component, analysis, pptx);
      }
    }

    for (const component of analysis.components.filter((c) => c.type === "picture")) {
      const forbidden = isForbiddenFilledFallback({
        width: component.width,
        height: component.height,
        filledRatio: 1
      }, analysis.image);
      // A model-confirmed content image is not a page-background fallback, but
      // still cap it to keep the reconstruction editable.
      if (forbidden && component.areaRatio > 0.6) continue;
      const relevantText = component.containsText
        ? analysis.textLines.filter((line) => overlapRatio(component.bbox, line.bbox) > 0)
        : [];
      const data = await cleanPictureData(item.buffer, component.bbox, relevantText);
      slide.addImage({ data, ...toSlideBox(component.bbox, analysis) });
    }

    for (const component of analysis.components.filter((c) => ["icon", "semanticIcon"].includes(c.type))) {
      // Never preserve raster glyphs inside an icon crop when OCR has already
      // reconstructed that content as editable text.
      if (component.type === "icon" && analysis.textLines.some((line) => {
        const componentArea = Math.max(1, (component.bbox.x1 - component.bbox.x0) * (component.bbox.y1 - component.bbox.y0));
        const lineArea = Math.max(1, (line.bbox.x1 - line.bbox.x0) * (line.bbox.y1 - line.bbox.y0));
        return overlapRatio(component.bbox, line.bbox) > 0.62 && componentArea < lineArea * 1.25;
      })) continue;
      const forbidden = isForbiddenFilledFallback({
        width: component.width,
        height: component.height,
        filledRatio: component.fillRatio
      }, analysis.image);
      if (forbidden) continue;
      if (component.type === "semanticIcon") addIconBackground(slide, component, analysis, pptx);
      const svg = component.type === "semanticIcon" && !["other", "none"].includes(component.iconKey)
        ? catalogIconSvg(
          component.iconKey,
          component.foregroundColorHex,
          component.label || "Recommended vector icon"
        )
        : await smallDetailSvg(
          item.buffer,
          component.bbox,
          component.foregroundColorHex || component.colorHex,
          {
            colorVariance: component.colorVariance,
            groupedParts: component.groupedParts,
            textLines: analysis.textLines,
            foregroundColorHex: component.foregroundColorHex || component.colorHex,
            backgroundColorHex: component.backgroundShape !== "none"
              ? component.backgroundColorHex
              : undefined
          }
        );
      slide.addImage({ data: svgDataUri(svg), ...toSlideBox(component.bbox, analysis) });
    }

    for (const line of analysis.textLines) addText(slide, line, analysis);

    const quality = qualityByPage[index];
    const scoreNotes = quality
      ? `\nSimilarity: ${Number(quality.overallScore * 100).toFixed(2)}%\nValidation level: ${quality.validationLevel}\nQuality gates: ${quality.passed ? "passed" : "review required"}`
      : "\nSimilarity: not evaluated";
    slide.addNotes(`Img2PPT QA summary\nSource: ${analysis.sourceName}\nNative shapes: ${analysis.summary.nativeShapeCount}\nText boxes: ${analysis.summary.textCount}\nVector icons: ${analysis.summary.iconCount}\nContent images: ${analysis.summary.pictureCount}\nCloud vision used: ${analysis.summary.visionUsed}\nVision fallback split: ${analysis.summary.visionFallbackUsed || false}\nVision provider: ${analysis.summary.visionProvider || "none"}\nText model used: ${analysis.summary.textModelUsed}\nOCR corrections: ${analysis.summary.textCorrectionCount || 0}\nLarge filled fallback: 0${scoreNotes}`);
  }

  await pptx.writeFile({ fileName: outputPath });
}
