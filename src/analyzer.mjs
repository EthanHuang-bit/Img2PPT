import sharp from "sharp";
import { RECONSTRUCTION_POLICY } from "./policy.mjs";
import { colorDistance, luminance, medianColor, quantize, rgbHex } from "./color.mjs";
import { boxArea, expandBox, intersects, mergeBoxes } from "./geometry.mjs";
import { PSM, recognizeText } from "./ocr.mjs";

function pixelAt(data, channels, width, x, y) {
  const offset = (y * width + x) * channels;
  return [data[offset], data[offset + 1], data[offset + 2], channels === 4 ? data[offset + 3] : 255];
}

function sampleTextColor(data, channels, width, height, bbox) {
  const histogram = new Map();
  const box = expandBox(bbox, 1, width, height);
  for (let y = box.y0; y < box.y1; y += 1) {
    for (let x = box.x0; x < box.x1; x += 1) {
      const p = pixelAt(data, channels, width, x, y);
      if (p[3] <= 100) continue;
      const q = quantize(p, 16);
      const key = q.join(",");
      const entry = histogram.get(key) || { color: q, count: 0 };
      entry.count += 1;
      histogram.set(key, entry);
    }
  }
  const clusters = [...histogram.values()].sort((a, b) => b.count - a.count);
  if (!clusters.length) return [0, 0, 0];
  const ringHistogram = new Map();
  const outer = expandBox(bbox, 4, width, height);
  for (let y = outer.y0; y < outer.y1; y += 1) {
    for (let x = outer.x0; x < outer.x1; x += 1) {
      if (x >= bbox.x0 && x < bbox.x1 && y >= bbox.y0 && y < bbox.y1) continue;
      const p = pixelAt(data, channels, width, x, y);
      if (p[3] <= 100) continue;
      const q = quantize(p, 16);
      const key = q.join(",");
      const entry = ringHistogram.get(key) || { color: q, count: 0 };
      entry.count += 1;
      ringHistogram.set(key, entry);
    }
  }
  const ringClusters = [...ringHistogram.values()].sort((a, b) => b.count - a.count);
  const background = ringClusters[0]?.color || clusters[0].color;
  const minimumCount = Math.max(2, Math.round((box.x1 - box.x0) * (box.y1 - box.y0) * 0.004));
  const candidates = clusters
    .filter((entry) => entry.count >= minimumCount && colorDistance(entry.color, background) >= 42)
    .map((entry) => ({
      ...entry,
      score: colorDistance(entry.color, background)
    }))
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.color || (luminance(background) > 170 ? [20, 20, 20] : [255, 255, 255]);
}

function estimateFont(text, bbox, imageHeight, slideHeight, densityScale = 1) {
  const glyphHeight = Math.max(1, bbox.y1 - bbox.y0);
  const width = Math.max(1, bbox.x1 - bbox.x0);
  const rawPt = glyphHeight * slideHeight * 72 / imageHeight;
  const upperRatio = (text.match(/[A-Z0-9]/g) || []).length / Math.max(1, text.replace(/\s/g, "").length);
  const isTitle = rawPt >= 18 || (upperRatio > 0.55 && rawPt > 12);
  const fontSize = Math.max(
    RECONSTRUCTION_POLICY.minFontPt,
    Math.min(RECONSTRUCTION_POLICY.maxFontPt, rawPt * (isTitle ? 0.92 : 0.86) * densityScale)
  );
  return {
    fontFace: RECONSTRUCTION_POLICY.defaultFontFace,
    fontSize: Math.round(fontSize * 10) / 10,
    bold: isTitle || (upperRatio > 0.72 && rawPt > 10.5),
    margin: 0,
    breakLine: false,
    fit: "shrink",
    valign: "mid"
  };
}

function intersectionOverUnion(a, b) {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = boxArea(a) + boxArea(b) - intersection;
  return union ? intersection / union : 0;
}

function plausibleTextLine(line) {
  const text = line.text.trim();
  const compact = text.replace(/\s/g, "");
  if (!compact) return false;
  if (line.confidence < 48) return false;
  if (/^[^A-Za-z0-9]+$/.test(compact)) return false;
  if (line.confidence < 72 && /[©®#~{}\\]/.test(text)) return false;
  if (/^(\d)(?:\s+\1){2,}\.?$/.test(text)) return false;
  if (/^\d{4,}$/.test(compact) && !/^(?:19|20)\d{2}$/.test(compact)) return false;
  if (/^\d$/.test(compact) && (line.confidence < 80 || (line.bbox.x1 - line.bbox.x0) < 6 || (line.bbox.y1 - line.bbox.y0) < 8)) return false;
  if (compact.length <= 3 && !/^\d{1,3}$/.test(compact) && !/^(AI|IoT|API|CRM|CBS|CSB|SMB|VAS)$/i.test(compact)) return false;
  return true;
}

function normalizeLineFromWords(line) {
  const candidateWords = (line.words || []).filter((word) =>
    word.confidence >= 42 && /[A-Za-z0-9]/.test(word.text)
  );
  if (!candidateWords.length) return line;
  const heights = candidateWords
    .map((word) => word.bbox.y1 - word.bbox.y0)
    .filter((height) => height > 0)
    .sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 1;
  let words = candidateWords.filter((word) => {
    const height = word.bbox.y1 - word.bbox.y0;
    return height <= medianHeight * 1.65 || (word.text.replace(/\W/g, "").length >= 4 && word.confidence >= 78);
  });
  if (!words.length) words = candidateWords;
  const bbox = {
    x0: Math.min(...words.map((word) => word.bbox.x0)),
    y0: Math.min(...words.map((word) => word.bbox.y0)),
    x1: Math.max(...words.map((word) => word.bbox.x1)),
    y1: Math.max(...words.map((word) => word.bbox.y1))
  };
  return {
    ...line,
    text: words.map((word) => word.text).join(" ").replace(/\s+/g, " ").trim(),
    bbox,
    words
  };
}

function suppressDuplicateLines(lines) {
  const accepted = [];
  for (const line of [...lines].sort((a, b) => b.confidence - a.confidence)) {
    const duplicate = accepted.some((other) => {
      const sameBand = Math.abs(other.bbox.y0 - line.bbox.y0) <= 2 && Math.abs(other.bbox.y1 - line.bbox.y1) <= 2;
      return intersectionOverUnion(other.bbox, line.bbox) > 0.62 ||
        (sameBand && other.text.toLowerCase() === line.text.toLowerCase());
    });
    if (!duplicate) accepted.push(line);
  }
  return accepted.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
}

function buildTextMask(lines, width, height) {
  const mask = new Uint8Array(width * height);
  for (const line of lines) {
    const box = expandBox(line.bbox, RECONSTRUCTION_POLICY.textPaddingPx, width, height);
    for (let y = box.y0; y < box.y1; y += 1) {
      mask.fill(1, y * width + box.x0, y * width + box.x1);
    }
  }
  return mask;
}

function isForeground(p) {
  return p[3] > 80 && luminance(p) < RECONSTRUCTION_POLICY.backgroundLuminance;
}

function componentStats(component, data, channels, width, height) {
  const bboxArea = Math.max(1, (component.x1 - component.x0 + 1) * (component.y1 - component.y0 + 1));
  const pixels = component.samples.length ? component.samples : [[0, 0, 0]];
  const fillRatio = component.count / bboxArea;
  const avg = pixels.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]).map((v) => v / pixels.length);
  let variance = 0;
  for (const p of pixels) variance += colorDistance(p, avg) ** 2;
  variance = Math.sqrt(variance / pixels.length);
  const boxWidth = component.x1 - component.x0 + 1;
  const boxHeight = component.y1 - component.y0 + 1;
  const aspect = boxWidth / Math.max(1, boxHeight);
  const interiorPixels = [];
  const insetX = Math.max(1, Math.round(boxWidth * 0.18));
  const insetY = Math.max(1, Math.round(boxHeight * 0.18));
  for (let y = component.y0 + insetY; y <= component.y1 - insetY; y += Math.max(1, Math.round(boxHeight / 12))) {
    for (let x = component.x0 + insetX; x <= component.x1 - insetX; x += Math.max(1, Math.round(boxWidth / 12))) {
      interiorPixels.push(pixelAt(data, channels, width, x, y));
    }
  }
  const exteriorPixels = [];
  const pad = 3;
  for (let x = component.x0; x <= component.x1; x += Math.max(1, Math.round(boxWidth / 16))) {
    if (component.y0 - pad >= 0) exteriorPixels.push(pixelAt(data, channels, width, x, component.y0 - pad));
    if (component.y1 + pad < height) exteriorPixels.push(pixelAt(data, channels, width, x, component.y1 + pad));
  }
  for (let y = component.y0; y <= component.y1; y += Math.max(1, Math.round(boxHeight / 12))) {
    if (component.x0 - pad >= 0) exteriorPixels.push(pixelAt(data, channels, width, component.x0 - pad, y));
    if (component.x1 + pad < width) exteriorPixels.push(pixelAt(data, channels, width, component.x1 + pad, y));
  }
  const interiorColor = medianColor(interiorPixels);
  const exteriorColor = medianColor(exteriorPixels);
  const cornerProbe = Math.max(1, Math.round(Math.min(boxWidth, boxHeight) * 0.04));
  const cornerPoints = [
    [component.x0 + cornerProbe, component.y0 + cornerProbe],
    [component.x1 - cornerProbe, component.y0 + cornerProbe],
    [component.x0 + cornerProbe, component.y1 - cornerProbe],
    [component.x1 - cornerProbe, component.y1 - cornerProbe]
  ];
  const matchingCorners = cornerPoints.filter(([x, y]) =>
    x >= 0 && x < width && y >= 0 && y < height &&
    colorDistance(pixelAt(data, channels, width, x, y), avg) < 65
  ).length;
  return {
    bbox: { x0: component.x0, y0: component.y0, x1: component.x1 + 1, y1: component.y1 + 1 },
    width: boxWidth,
    height: boxHeight,
    count: component.count,
    fillRatio,
    color: avg,
    colorHex: rgbHex(avg),
    colorVariance: variance,
    aspect,
    interiorColor,
    interiorColorHex: rgbHex(interiorColor),
    exteriorColor,
    hasDistinctInterior: colorDistance(interiorColor, exteriorColor) > 18,
    hasSharpCorners: matchingCorners >= 2
  };
}

function connectedComponents(data, channels, width, height, textMask) {
  const visited = new Uint8Array(width * height);
  const components = [];
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const minPixels = Math.max(10, Math.round(width * height * 0.000004));

  for (let sy = 0; sy < height; sy += 2) {
    for (let sx = 0; sx < width; sx += 2) {
      const seedIndex = sy * width + sx;
      if (visited[seedIndex] || textMask[seedIndex]) continue;
      const seed = pixelAt(data, channels, width, sx, sy);
      if (!isForeground(seed)) continue;
      const target = quantize(seed);
      const queue = [[sx, sy]];
      visited[seedIndex] = 1;
      const component = { x0: sx, y0: sy, x1: sx, y1: sy, count: 0, samples: [] };
      let head = 0;
      while (head < queue.length) {
        const [x, y] = queue[head++];
        const p = pixelAt(data, channels, width, x, y);
        if (!isForeground(p) || colorDistance(quantize(p), target) > RECONSTRUCTION_POLICY.colorDistance) continue;
        component.count += 1;
        component.x0 = Math.min(component.x0, x);
        component.y0 = Math.min(component.y0, y);
        component.x1 = Math.max(component.x1, x);
        component.y1 = Math.max(component.y1, y);
        if (component.samples.length < 250) component.samples.push(p);
        for (const [dx, dy] of directions) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const ni = ny * width + nx;
          if (visited[ni] || textMask[ni]) continue;
          const np = pixelAt(data, channels, width, nx, ny);
          if (isForeground(np) && colorDistance(quantize(np), target) <= RECONSTRUCTION_POLICY.colorDistance) {
            visited[ni] = 1;
            queue.push([nx, ny]);
          }
        }
      }
      if (component.count >= minPixels) components.push(componentStats(component, data, channels, width, height));
    }
  }
  return components;
}

function saturation([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function detectSolidBands(data, channels, width, height) {
  const rows = [];
  const maxGap = Math.max(5, Math.round(width * 0.012));
  const minWidth = Math.max(60, Math.round(width * 0.09));
  for (let y = 0; y < height; y += 2) {
    const points = [];
    for (let x = 0; x < width; x += 2) {
      const p = pixelAt(data, channels, width, x, y);
      if (p[3] > 100 && saturation(p) > 0.22 && luminance(p) < 224) points.push({ x, p });
    }
    if (!points.length) continue;
    let start = 0;
    for (let i = 1; i <= points.length; i += 1) {
      const ended = i === points.length || points[i].x - points[i - 1].x > maxGap;
      if (!ended) continue;
      const group = points.slice(start, i);
      const x0 = group[0].x;
      const x1 = group[group.length - 1].x + 2;
      const span = x1 - x0;
      const density = group.length * 2 / Math.max(1, span);
      if (span >= minWidth && density >= 0.52) {
        rows.push({ y, x0, x1, color: medianColor(group.map((point) => point.p)) });
      }
      start = i;
    }
  }

  const bands = [];
  for (const row of rows) {
    const candidate = [...bands].reverse().find((band) => {
      if (row.y - band.y1 > 4) return false;
      const overlap = Math.max(0, Math.min(row.x1, band.x1) - Math.max(row.x0, band.x0));
      const minSpan = Math.min(row.x1 - row.x0, band.x1 - band.x0);
      const maxSpan = Math.max(row.x1 - row.x0, band.x1 - band.x0);
      return overlap / Math.max(1, minSpan) > 0.72 &&
        minSpan / Math.max(1, maxSpan) > 0.68 &&
        colorDistance(row.color, band.color) < 85;
    });
    if (candidate) {
      candidate.x0 = Math.min(candidate.x0, row.x0);
      candidate.x1 = Math.max(candidate.x1, row.x1);
      candidate.y1 = row.y + 2;
      candidate.colors.push(row.color);
      candidate.color = medianColor(candidate.colors);
    } else {
      bands.push({
        x0: row.x0,
        y0: row.y,
        x1: row.x1,
        y1: row.y + 2,
        color: row.color,
        colors: [row.color]
      });
    }
  }

  function refineVerticalBounds(band) {
    const probes = [0.08, 0.18, 0.82, 0.92].map((ratio) =>
      Math.max(0, Math.min(width - 1, Math.round(band.x0 + (band.x1 - band.x0) * ratio)))
    );
    const matches = (y) => probes.filter((x) => {
      const p = pixelAt(data, channels, width, x, y);
      return p[3] > 100 && saturation(p) > 0.18 &&
        luminance(p) < 235 && colorDistance(p, band.color) < 105;
    }).length >= 2;
    let y0 = band.y0;
    let y1 = band.y1;
    while (y0 > 0 && matches(y0 - 1)) y0 -= 1;
    while (y1 < height && matches(y1)) y1 += 1;
    return { ...band, y0, y1 };
  }

  const refinedBands = bands
    .map(refineVerticalBounds)
    .filter((band) => band.y1 - band.y0 >= Math.max(8, height * 0.012))
    .sort((a, b) => ((b.x1 - b.x0) * (b.y1 - b.y0)) - ((a.x1 - a.x0) * (a.y1 - a.y0)));
  const nonOverlappingBands = [];
  for (const band of refinedBands) {
    const area = (band.x1 - band.x0) * (band.y1 - band.y0);
    const duplicate = nonOverlappingBands.some((other) => {
      const overlapX = Math.max(0, Math.min(band.x1, other.x1) - Math.max(band.x0, other.x0));
      const overlapY = Math.max(0, Math.min(band.y1, other.y1) - Math.max(band.y0, other.y0));
      return overlapX * overlapY / Math.max(1, area) > 0.72 &&
        colorDistance(band.color, other.color) < 45;
    });
    if (!duplicate) nonOverlappingBands.push(band);
  }

  return nonOverlappingBands
    .map((band) => {
      const widthPx = band.x1 - band.x0;
      const heightPx = band.y1 - band.y0;
      let colored = 0;
      let sampled = 0;
      for (let y = band.y0; y < band.y1; y += 2) {
        for (let x = band.x0; x < band.x1; x += 2) {
          const p = pixelAt(data, channels, width, x, y);
          sampled += 1;
          if (p[3] > 100 && saturation(p) > 0.18 && luminance(p) < 235) colored += 1;
        }
      }
      return {
        bbox: { x0: band.x0, y0: band.y0, x1: band.x1, y1: band.y1 },
        width: widthPx,
        height: heightPx,
        count: widthPx * heightPx,
        fillRatio: 1,
        color: band.color,
        colorHex: rgbHex(band.color),
        colorVariance: 0,
        aspect: widthPx / Math.max(1, heightPx),
        type: "roundRect",
        areaRatio: widthPx * heightPx / (width * height),
        gradientCandidate: true,
        source: "solidBand",
        bandDensity: colored / Math.max(1, sampled)
      };
    })
    .filter((band) => band.bandDensity >= 0.46 && band.aspect >= 3.2);
}

function classifyComponent(component, image) {
  const slideArea = image.width * image.height;
  const areaRatio = boxArea(component.bbox) / slideArea;
  const { width, height, fillRatio, aspect, colorVariance } = component;
  const isThin = height <= Math.max(4, image.height * 0.006) || width <= Math.max(4, image.width * 0.004);
  if (isThin && (aspect > 5 || aspect < 0.2)) return { type: "line", areaRatio };
  if (fillRatio > 0.72 && areaRatio >= RECONSTRUCTION_POLICY.minNativeShapeAreaRatio) {
    if (aspect > 0.78 && aspect < 1.28 && fillRatio > 0.68 && fillRatio < 0.9) {
      return { type: "ellipse", areaRatio };
    }
    return { type: "roundRect", areaRatio, gradientCandidate: colorVariance > 14 };
  }
  const perimeterRatio = component.count / Math.max(1, 2 * (width + height));
  if (fillRatio < 0.28 && perimeterRatio > 0.35 && areaRatio > 0.0004 && width > 12 && height > 8) {
    return { type: "outlineRect", areaRatio };
  }
  if (areaRatio <= RECONSTRUCTION_POLICY.maxIconAreaRatio) return { type: "icon", areaRatio };
  return { type: "fragment", areaRatio };
}

function deduplicate(components, textLines) {
  return components.filter((component, index) => {
    if (textLines.some((line) => intersects(component.bbox, line.bbox) && boxArea(component.bbox) < boxArea(line.bbox) * 1.4)) return false;
    return !components.slice(0, index).some((other) =>
      Math.abs(other.bbox.x0 - component.bbox.x0) < 2 &&
      Math.abs(other.bbox.y0 - component.bbox.y0) < 2 &&
      Math.abs(other.bbox.x1 - component.bbox.x1) < 2 &&
      Math.abs(other.bbox.y1 - component.bbox.y1) < 2
    );
  });
}

function groupIconComponents(components, image) {
  const icons = components.filter((component) => component.type === "icon");
  const others = components.filter((component) => component.type !== "icon");
  const groupedBoxes = mergeBoxes(icons.map((icon) => icon.bbox), Math.max(4, Math.round(image.width * 0.004)));
  const groupedIcons = groupedBoxes
    .flatMap((bbox) => {
      const members = icons.filter((icon) => intersects(icon.bbox, bbox));
      if (boxArea(bbox) / (image.width * image.height) > RECONSTRUCTION_POLICY.maxIconAreaRatio) {
        return members;
      }
      const width = bbox.x1 - bbox.x0;
      const height = bbox.y1 - bbox.y0;
      const color = medianColor(members.map((member) => member.color));
      return [{
        bbox,
        width,
        height,
        count: members.reduce((sum, member) => sum + member.count, 0),
        fillRatio: members.reduce((sum, member) => sum + member.count, 0) / Math.max(1, boxArea(bbox)),
        color,
        colorHex: rgbHex(color),
        colorVariance: Math.max(0, ...members.map((member) => member.colorVariance)),
        aspect: width / Math.max(1, height),
        type: "icon",
        areaRatio: boxArea(bbox) / (image.width * image.height),
        groupedParts: members.length
      }];
    });
  return [...others, ...groupedIcons];
}

export async function analyzeImage(imageBuffer, { sourceName = "image" } = {}) {
  const normalized = sharp(imageBuffer).ensureAlpha();
  const { data, info } = await normalized.raw().toBuffer({ resolveWithObject: true });
  const image = { width: info.width, height: info.height, channels: info.channels };
  const slideHeight = RECONSTRUCTION_POLICY.slideWidthIn * image.height / image.width;
  const solidBands = detectSolidBands(data, info.channels, image.width, image.height);
  // White text placed on dark/gradient banners is handled with targeted
  // single-line OCR. Region coordinates are mapped back to the full image.
  const bandTextLines = [];
  for (const band of solidBands.filter((item) => item.width / image.width > 0.12 && item.height > image.height * 0.018)) {
    const left = Math.max(0, Math.floor(band.bbox.x0));
    const top = Math.max(0, Math.floor(band.bbox.y0));
    const width = Math.min(image.width - left, Math.max(1, Math.ceil(band.bbox.x1 - band.bbox.x0)));
    const isTopLogo = top < image.height * 0.15 && width / image.width < 0.5 &&
      (band.bbox.y1 - band.bbox.y0) > image.height * 0.05;
    const fullHeight = Math.max(1, Math.ceil(band.bbox.y1 - band.bbox.y0));
    const height = Math.min(image.height - top, isTopLogo ? Math.ceil(fullHeight * 0.67) : fullHeight);
    const crop = await sharp(imageBuffer)
      .extract({ left, top, width, height })
      .grayscale()
      .threshold(185)
      .negate({ alpha: false })
      .resize({ width: width * 2, height: height * 2 })
      .png()
      .toBuffer();
    const lines = await recognizeText(crop, { psm: isTopLogo ? PSM.SINGLE_LINE : PSM.SINGLE_BLOCK });
    for (const line of lines) {
      const scale = 0.5;
      let validWords = (line.words || []).filter((word) =>
        word.confidence >= 55 && /[A-Za-z0-9]/.test(word.text)
      );
      if (validWords.length > 2 && validWords[0].text.length === 1) {
        const first = validWords[0];
        const second = validWords[1];
        const gap = second.bbox.x0 - first.bbox.x1;
        const wordHeight = Math.max(1, first.bbox.y1 - first.bbox.y0);
        if (gap > wordHeight * 0.7) validWords = validWords.slice(1);
      }
      if (!validWords.length) continue;
      const wordBox = {
        x0: Math.min(...validWords.map((word) => word.bbox.x0)),
        y0: Math.min(...validWords.map((word) => word.bbox.y0)),
        x1: Math.max(...validWords.map((word) => word.bbox.x1)),
        y1: Math.max(...validWords.map((word) => word.bbox.y1))
      };
      bandTextLines.push({
        ...line,
        text: validWords.map((word) => word.text).join(" "),
        confidence: validWords.reduce((sum, word) => sum + word.confidence, 0) / validWords.length,
        forcedColorHex: "FFFFFF",
        bbox: {
          x0: left + wordBox.x0 * scale,
          y0: top + wordBox.y0 * scale,
          x1: left + wordBox.x1 * scale,
          y1: top + wordBox.y1 * scale
        }
      });
    }
  }
  const generalLines = (await recognizeText(imageBuffer)).map(normalizeLineFromWords);
  const filteredGeneralLines = generalLines.filter((line) => !bandTextLines.some((bandLine) => {
    const overlapX = Math.max(0, Math.min(line.bbox.x1, bandLine.bbox.x1) - Math.max(line.bbox.x0, bandLine.bbox.x0));
    const overlapY = Math.max(0, Math.min(line.bbox.y1, bandLine.bbox.y1) - Math.max(line.bbox.y0, bandLine.bbox.y0));
    const lineArea = Math.max(1, boxArea(line.bbox));
    return overlapX * overlapY / lineArea > 0.32;
  }));
  const rawLines = suppressDuplicateLines(
    [
      ...filteredGeneralLines,
      ...bandTextLines
    ]
      .filter(plausibleTextLine)
      .filter((line) => {
        if (!/^\d$/.test(line.text.trim())) return true;
        return line.bbox.x0 < image.width * 0.08 ||
          line.bbox.x1 > image.width * 0.92 ||
          line.bbox.y0 > image.height * 0.9;
      })
  );
  const textLines = rawLines
    .map((line) => {
      const color = line.forcedColorHex ? null : sampleTextColor(data, info.channels, info.width, info.height, line.bbox);
      const densityScale = rawLines.length > 95 ? 0.78 : rawLines.length > 72 ? 0.88 : 1;
      return {
        ...line,
        colorHex: line.forcedColorHex || rgbHex(color),
        style: estimateFont(line.text, line.bbox, image.height, slideHeight, densityScale)
      };
    });
  const textMask = buildTextMask(textLines, image.width, image.height);
  const connected = connectedComponents(data, info.channels, image.width, image.height, textMask)
      .map((component) => ({ ...component, ...classifyComponent(component, image) }))
      .filter((component) => component.areaRatio >= RECONSTRUCTION_POLICY.minNativeShapeAreaRatio)
      .filter((component) => !solidBands.some((band) => {
        const overlapX = Math.max(0, Math.min(component.bbox.x1, band.bbox.x1) - Math.max(component.bbox.x0, band.bbox.x0));
        const overlapY = Math.max(0, Math.min(component.bbox.y1, band.bbox.y1) - Math.max(component.bbox.y0, band.bbox.y0));
        return overlapX * overlapY / Math.max(1, boxArea(component.bbox)) > 0.84;
      }));
  const components = groupIconComponents(deduplicate(
    [...solidBands, ...connected],
    textLines
  ), image);
  return {
    sourceName,
    image,
    slide: { width: RECONSTRUCTION_POLICY.slideWidthIn, height: slideHeight },
    textLines,
    components,
    summary: {
      textCount: textLines.length,
      componentCount: components.length,
      nativeShapeCount: components.filter((c) => ["roundRect", "ellipse", "outlineRect", "line"].includes(c.type)).length,
      iconCount: components.filter((c) => c.type === "icon").length,
      fragmentCount: components.filter((c) => c.type === "fragment").length,
      maxFragmentAreaRatio: Math.max(0, ...components.filter((c) => c.type === "fragment").map((c) => c.areaRatio))
    }
  };
}
