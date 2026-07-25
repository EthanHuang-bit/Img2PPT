import {
  createChatCompletion,
  extractChatText,
  normalizeModelConfig,
  parseJsonText
} from "./model-client.mjs";

const ROLES = new Set(["title", "subtitle", "body", "label"]);

function normalizedText(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function similarity(left, right) {
  const a = normalizedText(left);
  const b = normalizedText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const aSet = new Set(a);
  const bSet = new Set(b);
  const shared = [...aSet].filter((char) => bSet.has(char)).length;
  return shared / Math.max(aSet.size, bSet.size, 1);
}

function sanitizeCorrections(lines, payload) {
  const byId = new Map((payload?.lines || []).map((item) => [Number(item.id), item]));
  return lines.map((line, id) => {
    const correction = byId.get(id);
    if (!correction) return line;
    const candidate = String(correction.text || "").replace(/\s+/g, " ").trim();
    const maximumLength = Math.max(16, line.text.length * 1.8);
    const safeText = candidate &&
      candidate.length <= maximumLength &&
      similarity(line.text, candidate) >= 0.34
      ? candidate
      : line.text;
    return {
      ...line,
      text: safeText,
      textRole: ROLES.has(correction.role) ? correction.role : "body",
      textEnhanced: safeText !== line.text
    };
  });
}

export async function enhanceTextLines(lines, rawConfig = {}, {
  timeoutMs = 90000,
  fetchImpl
} = {}) {
  if (!lines.length) return {
    lines,
    used: false,
    error: null,
    provider: null,
    model: null,
    correctionCount: 0
  };
  const config = normalizeModelConfig(rawConfig, { capability: "text" });
  const compactLines = lines.slice(0, 300).map((line, id) => ({
    id,
    text: line.text,
    confidence: Math.round(Number(line.confidence) || 0),
    y: Math.round(line.bbox?.y0 || 0),
    height: Math.round((line.bbox?.y1 || 0) - (line.bbox?.y0 || 0))
  }));
  const response = await createChatCompletion(config, {
    messages: [
      {
        role: "system",
        content: `You correct OCR text extracted from presentation slides.
Return JSON only in this exact shape: {"lines":[{"id":0,"text":"corrected text","role":"title|subtitle|body|label"}]}.
Keep every input id exactly once and in order. Correct only obvious OCR errors, spacing and punctuation.
Never translate, summarize, add facts, merge lines or invent missing text. Preserve product names, acronyms and numbers.`
      },
      {
        role: "user",
        content: `Return corrected OCR lines as JSON:\n${JSON.stringify(compactLines)}`
      }
    ],
    responseFormat: true,
    temperature: 0,
    timeoutMs,
    fetchImpl
  });
  const enhanced = sanitizeCorrections(lines, parseJsonText(extractChatText(response)));
  return {
    lines: enhanced,
    used: true,
    error: null,
    provider: config.provider,
    model: config.model,
    correctionCount: enhanced.filter((line) => line.textEnhanced).length
  };
}

export async function testTextModel(rawConfig, options = {}) {
  const sample = [{
    text: "Network Archltecture",
    confidence: 72,
    bbox: { x0: 0, y0: 0, x1: 100, y1: 20 }
  }];
  const result = await enhanceTextLines(sample, rawConfig, options);
  return {
    ok: result.used,
    provider: result.provider,
    model: result.model,
    message: "文本模型连接成功，JSON 输出可正常解析。"
  };
}
