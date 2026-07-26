import sharp from "sharp";

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 255;
}

function estimateBackground(data, width, height) {
  const samples = [[], [], []];
  const radius = Math.max(2, Math.round(Math.min(width, height) * 0.025));
  const origins = [
    [0, 0],
    [Math.max(0, width - radius), 0],
    [0, Math.max(0, height - radius)],
    [Math.max(0, width - radius), Math.max(0, height - radius)]
  ];
  for (const [left, top] of origins) {
    for (let y = top; y < Math.min(height, top + radius); y += 1) {
      for (let x = left; x < Math.min(width, left + radius); x += 1) {
        const offset = (y * width + x) * 3;
        samples[0].push(data[offset]);
        samples[1].push(data[offset + 1]);
        samples[2].push(data[offset + 2]);
      }
    }
  }
  return samples.map(median);
}

function colorDistanceAt(data, offset, color) {
  const dr = data[offset] - color[0];
  const dg = data[offset + 1] - color[1];
  const db = data[offset + 2] - color[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function foregroundMask(data, width, height, background) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const offset = index * 3;
      const distance = colorDistanceAt(data, offset, background);
      let gradient = 0;
      if (x + 1 < width) {
        const right = offset + 3;
        gradient = Math.max(
          gradient,
          Math.abs(data[offset] - data[right]) +
          Math.abs(data[offset + 1] - data[right + 1]) +
          Math.abs(data[offset + 2] - data[right + 2])
        );
      }
      if (y + 1 < height) {
        const below = offset + width * 3;
        gradient = Math.max(
          gradient,
          Math.abs(data[offset] - data[below]) +
          Math.abs(data[offset + 1] - data[below + 1]) +
          Math.abs(data[offset + 2] - data[below + 2])
        );
      }
      if (distance > 24 || gradient > 48) mask[index] = 1;
    }
  }
  return mask;
}

function edgeMask(data, width, height) {
  const mask = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const offset = (y * width + x) * 3;
      const left = offset - 3;
      const right = offset + 3;
      const above = offset - width * 3;
      const below = offset + width * 3;
      const gx = Math.abs(data[right] - data[left]) +
        Math.abs(data[right + 1] - data[left + 1]) +
        Math.abs(data[right + 2] - data[left + 2]);
      const gy = Math.abs(data[below] - data[above]) +
        Math.abs(data[below + 1] - data[above + 1]) +
        Math.abs(data[below + 2] - data[above + 2]);
      if (gx + gy > 105) mask[y * width + x] = 1;
    }
  }
  return mask;
}

function hasNearby(mask, width, height, x, y, radius) {
  for (let dy = -radius; dy <= radius; dy += 1) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -radius; dx <= radius; dx += 1) {
      const nx = x + dx;
      if (nx >= 0 && nx < width && mask[ny * width + nx]) return true;
    }
  }
  return false;
}

function tolerantOverlap(left, right, width, height, radius = 1) {
  let leftCount = 0;
  let rightCount = 0;
  let leftMatched = 0;
  let rightMatched = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (left[index]) {
        leftCount += 1;
        if (hasNearby(right, width, height, x, y, radius)) leftMatched += 1;
      }
      if (right[index]) {
        rightCount += 1;
        if (hasNearby(left, width, height, x, y, radius)) rightMatched += 1;
      }
    }
  }
  if (!leftCount && !rightCount) return 1;
  const recall = leftMatched / Math.max(1, leftCount);
  const precision = rightMatched / Math.max(1, rightCount);
  return (2 * recall * precision) / Math.max(0.000001, recall + precision);
}

function localColorSimilarity(reference, rendered, referenceMask, width, height, radius = 1) {
  let error = 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!referenceMask[index]) continue;
      const refOffset = index * 3;
      let minimum = Infinity;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const offset = (ny * width + nx) * 3;
          const dr = reference[refOffset] - rendered[offset];
          const dg = reference[refOffset + 1] - rendered[offset + 1];
          const db = reference[refOffset + 2] - rendered[offset + 2];
          minimum = Math.min(minimum, Math.sqrt(dr * dr + dg * dg + db * db));
        }
      }
      error += minimum;
      count += 1;
    }
  }
  if (!count) return 1;
  return clamp01(1 - error / count / 441.673);
}

function backgroundSimilarity(reference, rendered, referenceMask) {
  let error = 0;
  let count = 0;
  for (let index = 0; index < referenceMask.length; index += 1) {
    if (referenceMask[index]) continue;
    const offset = index * 3;
    error += (
      Math.abs(reference[offset] - rendered[offset]) +
      Math.abs(reference[offset + 1] - rendered[offset + 1]) +
      Math.abs(reference[offset + 2] - rendered[offset + 2])
    ) / 3;
    count += 1;
  }
  return count ? clamp01(1 - error / count / 255) : 1;
}

export function calibrateEditableSimilarity(rawScore) {
  const raw = clamp01(rawScore);
  if (raw <= 0.85) return raw;
  const normalized = (raw - 0.85) / 0.15;
  return clamp01(0.85 + 0.15 * Math.sqrt(normalized));
}

async function normalizeImage(buffer, width, height) {
  return sharp(buffer)
    .rotate()
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();
}

export async function compareVisualBuffers(referenceBuffer, renderedBuffer, {
  maximumWidth = 640
} = {}) {
  const metadata = await sharp(referenceBuffer).rotate().metadata();
  const scale = Math.min(1, maximumWidth / metadata.width);
  const width = Math.max(32, Math.round(metadata.width * scale));
  const height = Math.max(18, Math.round(metadata.height * scale));
  const [reference, rendered] = await Promise.all([
    normalizeImage(referenceBuffer, width, height),
    normalizeImage(renderedBuffer, width, height)
  ]);
  const referenceBackground = estimateBackground(reference, width, height);
  const renderedBackground = estimateBackground(rendered, width, height);
  const referenceForeground = foregroundMask(reference, width, height, referenceBackground);
  const renderedForeground = foregroundMask(rendered, width, height, renderedBackground);
  const referenceEdges = edgeMask(reference, width, height);
  const renderedEdges = edgeMask(rendered, width, height);
  const foregroundCoverage = tolerantOverlap(referenceForeground, renderedForeground, width, height, 2);
  const edgeSimilarity = tolerantOverlap(referenceEdges, renderedEdges, width, height, 2);
  const foregroundColorSimilarity = localColorSimilarity(
    reference,
    rendered,
    referenceForeground,
    width,
    height,
    1
  );
  const backgroundScore = backgroundSimilarity(reference, rendered, referenceForeground);
  const rawSimilarity = clamp01(
    foregroundColorSimilarity * 0.35 +
    edgeSimilarity * 0.25 +
    foregroundCoverage * 0.25 +
    backgroundScore * 0.15
  );
  return {
    width,
    height,
    rawSimilarity,
    similarity: calibrateEditableSimilarity(rawSimilarity),
    layoutScore: clamp01(edgeSimilarity * 0.55 + foregroundCoverage * 0.45),
    appearanceScore: clamp01(foregroundColorSimilarity * 0.72 + backgroundScore * 0.28),
    foregroundCoverage,
    edgeSimilarity,
    foregroundColorSimilarity,
    backgroundSimilarity: backgroundScore
  };
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9\u4e00-\u9fff.%+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function evaluateContent(expectedLines = [], actualValues = []) {
  const expected = expectedLines
    .map((line) => normalizeText(typeof line === "string" ? line : line.text))
    .filter(Boolean);
  const actual = normalizeText(actualValues.join(" "));
  if (!expected.length) {
    return { score: 1, missing: [], criticalNumbersMissing: [] };
  }
  const actualTokens = new Set(actual.split(" ").filter(Boolean));
  const missing = expected.filter((phrase) => {
    if (actual.includes(phrase)) return false;
    const tokens = phrase.split(" ").filter(Boolean);
    return !tokens.every((token) => actualTokens.has(token));
  });
  const expectedNumbers = new Set(
    expected.flatMap((value) => value.match(/\b\d+(?:[.,]\d+)?%?\b/g) || [])
  );
  const criticalNumbersMissing = [...expectedNumbers].filter((number) => !actual.includes(number));
  return {
    score: clamp01(1 - missing.length / expected.length),
    missing,
    criticalNumbersMissing
  };
}

function diagnostic(category, severity, message, action) {
  return { category, severity, message, action };
}

export function evaluatePageQuality({
  analysis,
  auditSlide,
  visual,
  modelEvaluation = null,
  thresholds = {}
}) {
  const gates = {
    overall: thresholds.overall ?? 0.98,
    content: thresholds.content ?? 0.995,
    layout: thresholds.layout ?? 0.96,
    appearance: thresholds.appearance ?? 0.96,
    editability: thresholds.editability ?? 1
  };
  const content = evaluateContent(
    analysis?.textLines || [],
    auditSlide?.textValues || []
  );
  const editabilityFailures = [];
  if ((auditSlide?.filledTextShapeCount || 0) > 0) editabilityFailures.push("文字框包含填充");
  if ((auditSlide?.textShapeCount || 0) > 0 && auditSlide?.minFontPt == null) {
    editabilityFailures.push("文字字号未实际写入");
  }
  if (auditSlide?.imageOnlyPage) editabilityFailures.push("页面仅包含整页位图");
  if ((auditSlide?.rasterPictureCount || 0) > 0 && (auditSlide?.shapeCount || 0) === 0) {
    editabilityFailures.push("缺少可编辑原生形状");
  }
  const editabilityScore = clamp01(1 - editabilityFailures.length * 0.34);
  const modelLayout = modelEvaluation ? clamp01(modelEvaluation.layoutScore) : null;
  const modelAppearance = modelEvaluation ? clamp01(modelEvaluation.appearanceScore) : null;
  const modelContent = modelEvaluation ? clamp01(modelEvaluation.contentScore) : null;
  const layoutScore = modelEvaluation
    ? clamp01(visual.layoutScore * 0.72 + modelLayout * 0.28)
    : clamp01(visual.layoutScore);
  const appearanceScore = modelEvaluation
    ? clamp01(visual.appearanceScore * 0.72 + modelAppearance * 0.28)
    : clamp01(visual.appearanceScore);
  const contentScore = modelEvaluation
    ? Math.min(content.score, clamp01(content.score * 0.8 + modelContent * 0.2))
    : content.score;
  const overallScore = clamp01(
    contentScore * 0.3 +
    layoutScore * 0.25 +
    appearanceScore * 0.25 +
    editabilityScore * 0.2
  );
  const diagnostics = [];
  if (content.missing.length) {
    diagnostics.push(diagnostic(
      "content",
      "critical",
      `缺失或不一致文字：${content.missing.slice(0, 5).join("；")}`,
      "优化 OCR、短标签保留与文字去重"
    ));
  }
  if (content.criticalNumbersMissing.length) {
    diagnostics.push(diagnostic(
      "content",
      "critical",
      `关键数字缺失：${content.criticalNumbersMissing.join("、")}`,
      "优先修复数字 OCR，并禁止模型改写数值"
    ));
  }
  for (const failure of editabilityFailures) {
    diagnostics.push(diagnostic("editability", "critical", failure, "检查 PPTX 对象生成与媒体回退策略"));
  }
  if (layoutScore < gates.layout) {
    diagnostics.push(diagnostic("layout", "major", "对象位置、边缘或间距偏差较大", "优化边界框、描边和连接器重建"));
  }
  if (appearanceScore < gates.appearance) {
    diagnostics.push(diagnostic("appearance", "major", "颜色、字体或图标观感未达门槛", "检查颜色采样、字体拟合和矢量图标语义"));
  }
  for (const error of modelEvaluation?.criticalErrors || []) {
    if (error.severity === "critical") {
      diagnostics.push(diagnostic(
        error.category || "semantic",
        "critical",
        error.description || "大模型发现关键语义错误",
        "根据模型标注区域复核对象类型、连接关系和文本"
      ));
    }
  }
  const passed = diagnostics.every((item) => item.severity !== "critical") &&
    overallScore >= gates.overall &&
    contentScore >= gates.content &&
    layoutScore >= gates.layout &&
    appearanceScore >= gates.appearance &&
    editabilityScore >= gates.editability;
  return {
    overallScore,
    contentScore,
    layoutScore,
    appearanceScore,
    editabilityScore,
    pixelSimilarity: visual.similarity,
    modelScore: modelEvaluation?.overallScore ?? null,
    validationLevel: modelEvaluation ? "full-model-and-local" : "local-precheck",
    thresholds: gates,
    passed,
    diagnostics,
    localMetrics: visual,
    modelEvaluation
  };
}

export function qualitySummary(pages) {
  const list = pages || [];
  const average = (field) => list.length
    ? list.reduce((sum, page) => sum + Number(page?.[field] || 0), 0) / list.length
    : 0;
  return {
    pageCount: list.length,
    passedPages: list.filter((page) => page.passed).length,
    allPassed: list.length > 0 && list.every((page) => page.passed),
    averageScore: average("overallScore"),
    averageLayout: average("layoutScore"),
    averageAppearance: average("appearanceScore"),
    validationLevel: list.every((page) => page.validationLevel === "full-model-and-local")
      ? "full-model-and-local"
      : "local-precheck"
  };
}
