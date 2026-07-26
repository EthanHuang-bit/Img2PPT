import sharp from "sharp";
import {
  createChatCompletion,
  endpointFor,
  extractChatText,
  normalizeModelConfig,
  parseJsonText,
  postModelJson
} from "./model-client.mjs";

const evaluationSchema = {
  type: "object",
  properties: {
    layoutScore: { type: "number", minimum: 0, maximum: 1 },
    contentScore: { type: "number", minimum: 0, maximum: 1 },
    appearanceScore: { type: "number", minimum: 0, maximum: 1 },
    semanticScore: { type: "number", minimum: 0, maximum: 1 },
    criticalErrors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string" },
          severity: { type: "string", enum: ["minor", "major", "critical"] },
          region: { type: "string" },
          description: { type: "string" }
        },
        required: ["category", "severity", "region", "description"],
        additionalProperties: false
      }
    }
  },
  required: [
    "layoutScore",
    "contentScore",
    "appearanceScore",
    "semanticScore",
    "criticalErrors"
  ],
  additionalProperties: false
};

const evaluatorPrompt = `Compare two images of the same presentation slide.
The first image is the original reference. The second image is the rendered editable PowerPoint result.
Judge whether a business user would regard the result as the same slide, without demanding pixel-identical font antialiasing.
Do not reward large white or flat-color backgrounds. Inspect foreground objects, every visible text item, key numbers, icons, connectors, relative spacing, alignment, colors, hierarchy and overall visual balance.
Scores are 0..1. A score above 0.98 means extremely faithful. Missing or wrong text, wrong key numbers, missing objects, wrong icon meaning, incorrect connectors, or a major layout shift must be a critical error.
Return JSON only.`;

async function prepare(buffer) {
  return sharp(buffer)
    .rotate()
    .resize({ width: 1400, height: 1400, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 84, chromaSubsampling: "4:2:0", mozjpeg: true })
    .toBuffer();
}

function responsesText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  for (const output of response?.output || []) {
    for (const content of output?.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }
  throw new Error("相似度评测模型没有返回可读取的 JSON。");
}

const clamp = (value) => Math.max(0, Math.min(1, Number(value) || 0));

function sanitizeEvaluation(value, config) {
  const result = {
    layoutScore: clamp(value?.layoutScore),
    contentScore: clamp(value?.contentScore),
    appearanceScore: clamp(value?.appearanceScore),
    semanticScore: clamp(value?.semanticScore),
    criticalErrors: (value?.criticalErrors || []).slice(0, 20).map((error) => ({
      category: String(error?.category || "semantic").slice(0, 40),
      severity: ["minor", "major", "critical"].includes(error?.severity)
        ? error.severity
        : "major",
      region: String(error?.region || "unknown").slice(0, 100),
      description: String(error?.description || "").slice(0, 300)
    })),
    provider: config.provider,
    model: config.model
  };
  result.overallScore = (
    result.contentScore * 0.3 +
    result.layoutScore * 0.28 +
    result.appearanceScore * 0.22 +
    result.semanticScore * 0.2
  );
  return result;
}

export async function evaluateWithVisionModel(referenceBuffer, renderedBuffer, {
  timeoutMs = 360000,
  fetchImpl,
  ...modelConfig
} = {}) {
  const config = normalizeModelConfig(modelConfig, { capability: "vision" });
  const [reference, rendered] = await Promise.all([
    prepare(referenceBuffer),
    prepare(renderedBuffer)
  ]);
  const referenceUrl = `data:image/jpeg;base64,${reference.toString("base64")}`;
  const renderedUrl = `data:image/jpeg;base64,${rendered.toString("base64")}`;
  let value;
  if (config.apiStyle === "responses") {
    const response = await postModelJson(endpointFor(config, "responses"), config, {
      model: config.model,
      store: false,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: evaluatorPrompt },
          { type: "input_text", text: "Original reference:" },
          { type: "input_image", image_url: referenceUrl, detail: "high" },
          { type: "input_text", text: "Rendered editable PowerPoint:" },
          { type: "input_image", image_url: renderedUrl, detail: "high" }
        ]
      }],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "slide_similarity_evaluation",
          strict: true,
          schema: evaluationSchema
        }
      }
    }, { timeoutMs, fetchImpl });
    value = JSON.parse(responsesText(response));
  } else {
    const response = await createChatCompletion(config, {
      messages: [
        {
          role: "system",
          content: `${evaluatorPrompt}\nJSON Schema:\n${JSON.stringify(evaluationSchema)}`
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Compare the original reference and rendered editable PowerPoint." },
            { type: "text", text: "Original reference:" },
            { type: "image_url", image_url: { url: referenceUrl } },
            { type: "text", text: "Rendered editable PowerPoint:" },
            { type: "image_url", image_url: { url: renderedUrl } }
          ]
        }
      ],
      responseFormat: true,
      temperature: 0,
      timeoutMs,
      idleTimeoutMs: 180000,
      stream: config.provider === "qwen",
      maxTokens: 4096,
      extraBody: config.provider === "qwen" ? { enable_thinking: false } : undefined,
      fetchImpl
    });
    value = parseJsonText(extractChatText(response));
  }
  return sanitizeEvaluation(value, config);
}

export { evaluationSchema };
