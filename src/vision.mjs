import sharp from "sharp";
import { ICON_KEYS, normalizeIconKey } from "./icons.mjs";
import {
  createChatCompletion,
  endpointFor,
  extractChatText,
  normalizeModelConfig,
  parseJsonText,
  postModelJson
} from "./model-client.mjs";

const DEFAULT_MODEL = "gpt-5.6";
const OBJECT_KINDS = ["icon", "image", "rect", "roundRect", "ellipse", "line"];
const BACKGROUND_SHAPES = ["none", "rect", "roundRect", "ellipse"];

const layoutSchema = {
  type: "object",
  properties: {
    pageSummary: { type: "string" },
    objects: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: OBJECT_KINDS },
          bbox: {
            type: "object",
            properties: {
              x: { type: "integer", minimum: 0, maximum: 1000 },
              y: { type: "integer", minimum: 0, maximum: 1000 },
              w: { type: "integer", minimum: 1, maximum: 1000 },
              h: { type: "integer", minimum: 1, maximum: 1000 }
            },
            required: ["x", "y", "w", "h"],
            additionalProperties: false
          },
          label: { type: "string" },
          iconKey: { type: "string", enum: ICON_KEYS },
          foregroundColor: { type: "string", pattern: "^[0-9A-Fa-f]{6}$" },
          backgroundShape: { type: "string", enum: BACKGROUND_SHAPES },
          backgroundColor: { type: "string", pattern: "^[0-9A-Fa-f]{6}$" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          containsText: { type: "boolean" },
          layer: { type: "integer", minimum: 0, maximum: 20 }
        },
        required: [
          "kind",
          "bbox",
          "label",
          "iconKey",
          "foregroundColor",
          "backgroundShape",
          "backgroundColor",
          "confidence",
          "containsText",
          "layer"
        ],
        additionalProperties: false
      }
    }
  },
  required: ["pageSummary", "objects"],
  additionalProperties: false
};

const systemPrompt = `Analyze a presentation-slide image for faithful reconstruction as editable PowerPoint objects.
Return only the semantic objects that improve reconstruction. Use coordinates normalized to 0..1000.
Rules:
- Do not return text objects. Text is already rebuilt by local OCR. Read visible text only to understand icon semantics and object grouping.
- Icon: tight box around the icon artwork only, excluding its text label. If it sits on a badge, describe the badge with backgroundShape/backgroundColor; otherwise backgroundShape is none.
- Pick the closest iconKey from the allowed catalog. Use other only when none is semantically close.
- Image: a genuine photo, illustration, logo, or complex raster that should remain an image.
- rect/roundRect/ellipse/line: return only meaningful containers, connectors or grouped backgrounds that local pixel analysis may miss. Skip tiny decoration and repeated simple fragments.
- A grouped badge must be one icon entry, not duplicate icon plus ellipse entries.
- containsText is true only when raster text is visually embedded inside that object's pixels and must be removed before placing editable text.
- Colors are six-digit RGB without #. Keep only objects with confidence >= 0.55.
- Prefer a short, accurate object list over speculative fragments. Return at most 120 objects.`;

function extractOutputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  throw new Error("Vision model returned no structured text.");
}

function schemaPrompt() {
  return `${systemPrompt}
Return JSON only. It must match this JSON Schema:
${JSON.stringify(layoutSchema)}`;
}

function cleanHex(value, fallback) {
  return /^[0-9a-f]{6}$/i.test(String(value || "")) ? String(value).toUpperCase() : fallback;
}

function sanitizeLayout(layout) {
  const objects = (layout?.objects || []).flatMap((object) => {
    if (!OBJECT_KINDS.includes(object.kind) || Number(object.confidence) < 0.55) return [];
    const x = Math.max(0, Math.min(999, Math.round(object.bbox.x)));
    const y = Math.max(0, Math.min(999, Math.round(object.bbox.y)));
    const w = Math.max(1, Math.min(1000 - x, Math.round(object.bbox.w)));
    const h = Math.max(1, Math.min(1000 - y, Math.round(object.bbox.h)));
    return [{
      kind: object.kind,
      bbox: { x, y, w, h },
      label: String(object.label || "").slice(0, 160),
      iconKey: normalizeIconKey(object.iconKey),
      foregroundColor: cleanHex(object.foregroundColor, "333333"),
      backgroundShape: BACKGROUND_SHAPES.includes(object.backgroundShape) ? object.backgroundShape : "none",
      backgroundColor: cleanHex(object.backgroundColor, "FFFFFF"),
      confidence: Math.max(0, Math.min(1, Number(object.confidence) || 0)),
      containsText: Boolean(object.containsText),
      layer: Math.max(0, Math.min(20, Math.round(object.layer || 0)))
    }];
  });
  return {
    pageSummary: String(layout?.pageSummary || "").slice(0, 500),
    objects
  };
}

export async function analyzeWithVision(imageBuffer, {
  apiKey,
  model = DEFAULT_MODEL,
  provider = "openai",
  apiStyle,
  baseUrl,
  sourceName = "image",
  timeoutMs = 360000,
  fetchImpl,
  contextImageBuffer,
  region
} = {}) {
  const config = normalizeModelConfig({
    apiKey,
    model,
    provider,
    apiStyle,
    baseUrl
  }, { capability: "vision" });
  const prepared = await sharp(imageBuffer)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 84, chromaSubsampling: "4:2:0", mozjpeg: true })
    .toBuffer();
  const preparedContext = contextImageBuffer
    ? await sharp(contextImageBuffer)
      .rotate()
      .resize({ width: 960, height: 960, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 72, chromaSubsampling: "4:2:0", mozjpeg: true })
      .toBuffer()
    : null;
  const regionInstruction = preparedContext
    ? `The first image is a low-resolution full-slide context. The second image is the high-resolution crop ${region?.label || ""}. Analyze the crop without losing full-slide semantics. Return every bbox relative to the crop itself in 0..1000 coordinates; do not return full-slide coordinates. Objects crossing a crop boundary may be partial and will be merged later.`
    : `Reconstruct object layers for ${sourceName}.`;
  try {
    let body;
    if (config.apiStyle === "responses") {
      body = await postModelJson(endpointFor(config, "responses"), config, {
        model: config.model,
        store: false,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }]
          },
          {
            role: "user",
            content: [
              { type: "input_text", text: regionInstruction },
              ...(preparedContext ? [{
                type: "input_image",
                image_url: `data:image/jpeg;base64,${preparedContext.toString("base64")}`,
                detail: "low"
              }] : []),
              {
                type: "input_image",
                image_url: `data:image/jpeg;base64,${prepared.toString("base64")}`,
                detail: "high"
              }
            ]
          }
        ],
        text: {
          verbosity: "low",
          format: {
            type: "json_schema",
            name: "slide_layout",
            strict: true,
            schema: layoutSchema
          }
        }
      }, { timeoutMs, fetchImpl });
      return {
        ...sanitizeLayout(JSON.parse(extractOutputText(body))),
        provider: config.provider,
        model: config.model,
        apiStyle: config.apiStyle
      };
    }
    body = await createChatCompletion(config, {
      messages: [
        { role: "system", content: schemaPrompt() },
        {
          role: "user",
          content: [
            { type: "text", text: `${regionInstruction} Return JSON only.` },
            ...(preparedContext ? [{
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${preparedContext.toString("base64")}`
              }
            }] : []),
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${prepared.toString("base64")}`
              }
            }
          ]
        }
      ],
      responseFormat: true,
      temperature: 0,
      timeoutMs,
      idleTimeoutMs: 180000,
      stream: config.provider === "qwen",
      maxTokens: 8192,
      extraBody: config.provider === "qwen"
        ? { enable_thinking: false }
        : undefined,
      fetchImpl
    });
    return {
      ...sanitizeLayout(parseJsonText(extractChatText(body))),
      provider: config.provider,
      model: config.model,
      apiStyle: config.apiStyle
    };
  } catch (error) {
    throw new Error(`大模型视觉增强失败：${error.message}`);
  }
}

export function quadrantRegions(width, height, overlapRatio = 0.08) {
  const overlapX = Math.max(1, Math.round(width * overlapRatio));
  const overlapY = Math.max(1, Math.round(height * overlapRatio));
  const middleX = Math.floor(width / 2);
  const middleY = Math.floor(height / 2);
  const leftEnd = Math.min(width, middleX + Math.ceil(overlapX / 2));
  const rightStart = Math.max(0, middleX - Math.floor(overlapX / 2));
  const topEnd = Math.min(height, middleY + Math.ceil(overlapY / 2));
  const bottomStart = Math.max(0, middleY - Math.floor(overlapY / 2));
  return [
    { label: "top-left", left: 0, top: 0, width: leftEnd, height: topEnd },
    { label: "top-right", left: rightStart, top: 0, width: width - rightStart, height: topEnd },
    { label: "bottom-left", left: 0, top: bottomStart, width: leftEnd, height: height - bottomStart },
    { label: "bottom-right", left: rightStart, top: bottomStart, width: width - rightStart, height: height - bottomStart }
  ];
}

function mapQuadrantObject(object, region, image) {
  const left = region.left + object.bbox.x / 1000 * region.width;
  const top = region.top + object.bbox.y / 1000 * region.height;
  const width = object.bbox.w / 1000 * region.width;
  const height = object.bbox.h / 1000 * region.height;
  const x = Math.max(0, Math.min(999, Math.round(left / image.width * 1000)));
  const y = Math.max(0, Math.min(999, Math.round(top / image.height * 1000)));
  const w = Math.max(1, Math.min(1000 - x, Math.round(width / image.width * 1000)));
  const h = Math.max(1, Math.min(1000 - y, Math.round(height / image.height * 1000)));
  return { ...object, bbox: { x, y, w, h }, sourceRegion: region.label };
}

function boxIou(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? intersection / union : 0;
}

function normalizedLabel(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function unionBox(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(1, x1 - x), h: Math.max(1, y1 - y) };
}

export function mergeQuadrantLayouts(results, regions, image) {
  const candidates = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (!result || result.error) continue;
    for (const object of result.objects || []) {
      candidates.push(mapQuadrantObject(object, regions[index], image));
    }
  }
  const accepted = [];
  for (const candidate of candidates.sort((a, b) => b.confidence - a.confidence)) {
    const label = normalizedLabel(candidate.label);
    const duplicate = accepted.find((other) => {
      if (other.kind !== candidate.kind) return false;
      const overlap = boxIou(other.bbox, candidate.bbox);
      const sameLabel = label && label === normalizedLabel(other.label);
      return overlap >= 0.42 || (sameLabel && overlap >= 0.08);
    });
    if (!duplicate) {
      accepted.push({ ...candidate });
      continue;
    }
    duplicate.bbox = unionBox(duplicate.bbox, candidate.bbox);
    duplicate.confidence = Math.max(duplicate.confidence, candidate.confidence);
    duplicate.layer = Math.min(duplicate.layer, candidate.layer);
    duplicate.sourceRegion = `${duplicate.sourceRegion},${candidate.sourceRegion}`;
  }
  return {
    pageSummary: results
      .filter((result) => result && !result.error && result.pageSummary)
      .map((result) => result.pageSummary)
      .join(" ")
      .slice(0, 500),
    objects: accepted.map(({ sourceRegion, ...object }) => object)
  };
}

function nonRetriableVisionError(error) {
  return /(401|403|api key|authentication|unauthorized|forbidden|余额|欠费|无权限)/i
    .test(String(error?.message || error));
}

export async function analyzeWithVisionFallback(imageBuffer, options = {}) {
  const analyzeFn = options.analyzeFn || analyzeWithVision;
  const cleanOptions = { ...options };
  delete cleanOptions.analyzeFn;
  try {
    const result = await analyzeFn(imageBuffer, cleanOptions);
    return {
      ...result,
      fallback: {
        used: false,
        reason: null,
        successfulRegions: 0,
        failedRegions: 0
      }
    };
  } catch (mainError) {
    if (nonRetriableVisionError(mainError)) throw mainError;
    const metadata = await sharp(imageBuffer).metadata();
    const image = { width: metadata.width, height: metadata.height };
    const regions = quadrantRegions(image.width, image.height);
    const settled = await Promise.allSettled(regions.map(async (region) => {
      const crop = await sharp(imageBuffer)
        .extract({
          left: region.left,
          top: region.top,
          width: region.width,
          height: region.height
        })
        .toBuffer();
      return analyzeFn(crop, {
        ...cleanOptions,
        sourceName: `${cleanOptions.sourceName || "image"}#${region.label}`,
        contextImageBuffer: imageBuffer,
        region
      });
    }));
    const results = settled.map((result) => result.status === "fulfilled"
      ? result.value
      : { error: String(result.reason?.message || result.reason), objects: [], pageSummary: "" });
    const successful = results.filter((result) => !result.error);
    if (!successful.length) {
      throw new Error(`整页视觉分析失败，四分块回退也全部失败：${mainError.message}`);
    }
    const merged = mergeQuadrantLayouts(results, regions, image);
    const first = successful[0];
    return {
      ...merged,
      provider: first.provider || cleanOptions.provider || null,
      model: first.model || cleanOptions.model || null,
      apiStyle: first.apiStyle || cleanOptions.apiStyle || null,
      fallback: {
        used: true,
        reason: mainError.message,
        successfulRegions: successful.length,
        failedRegions: results.length - successful.length
      }
    };
  }
}

export async function testVisionModel(config, options = {}) {
  const image = await sharp({
    create: {
      width: 96,
      height: 64,
      channels: 3,
      background: "#ffffff"
    }
  })
    .composite([{
      input: Buffer.from('<svg width="96" height="64"><rect x="12" y="12" width="72" height="40" rx="6" fill="#0E67D1"/></svg>'),
      top: 0,
      left: 0
    }])
    .png()
    .toBuffer();
  const result = await analyzeWithVision(image, {
    ...config,
    sourceName: "connection-test.png",
    ...options
  });
  return {
    ok: true,
    provider: result.provider,
    model: result.model,
    apiStyle: result.apiStyle,
    message: "视觉模型连接成功，图片输入与 JSON 输出均可正常使用。"
  };
}

export const VISION_DEFAULT_MODEL = DEFAULT_MODEL;
