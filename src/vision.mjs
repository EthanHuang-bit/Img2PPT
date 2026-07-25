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
  fetchImpl
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
              { type: "input_text", text: `Reconstruct object layers for ${sourceName}.` },
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
            { type: "text", text: `Reconstruct object layers for ${sourceName} as JSON.` },
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
