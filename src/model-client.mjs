export const PROVIDER_PRESETS = Object.freeze({
  openai: Object.freeze({
    label: "OpenAI",
    apiStyle: "responses",
    baseUrl: "https://api.openai.com/v1",
    visionModel: "gpt-5.6",
    textModel: "gpt-5.6-mini",
    supportsVision: true
  }),
  qwen: Object.freeze({
    label: "Qwen / 阿里云百炼",
    apiStyle: "chat-completions",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    visionModel: "qwen3-vl-plus",
    textModel: "qwen-plus",
    supportsVision: true
  }),
  deepseek: Object.freeze({
    label: "DeepSeek",
    apiStyle: "chat-completions",
    baseUrl: "https://api.deepseek.com",
    visionModel: "",
    textModel: "deepseek-v4-flash",
    supportsVision: false
  }),
  custom: Object.freeze({
    label: "自定义 OpenAI 兼容服务",
    apiStyle: "chat-completions",
    baseUrl: "",
    visionModel: "",
    textModel: "",
    supportsVision: true
  })
});

const PROVIDERS = new Set(Object.keys(PROVIDER_PRESETS));
const API_STYLES = new Set(["responses", "chat-completions"]);

function safeUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("Base URL 格式无效。");
  }
  const localHttp = url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("Base URL 必须使用 HTTPS；仅本机 localhost 可使用 HTTP。");
  }
  if (url.username || url.password) throw new Error("Base URL 不能包含用户名或密码。");
  if (url.search || url.hash) throw new Error("Base URL 不能包含查询参数或片段。");
  return url.toString().replace(/\/+$/, "");
}

export function normalizeModelConfig(config = {}, {
  capability = "vision",
  requireKey = true
} = {}) {
  const provider = PROVIDERS.has(config.provider) ? config.provider : "custom";
  const preset = PROVIDER_PRESETS[provider];
  const apiStyle = API_STYLES.has(config.apiStyle) ? config.apiStyle : preset.apiStyle;
  const baseUrl = safeUrl(config.baseUrl || preset.baseUrl);
  const model = String(
    config.model ||
    (capability === "vision" ? preset.visionModel : preset.textModel) ||
    ""
  ).trim();
  const apiKey = String(config.apiKey || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) {
    throw new Error("模型名称为空或包含不支持的字符。");
  }
  if (requireKey && !apiKey) throw new Error("启用大模型时需要填写 API Key。");
  if (apiKey.length > 2048) throw new Error("API Key 长度异常。");
  if (capability === "vision" && provider === "deepseek") {
    throw new Error("DeepSeek 当前配置为文本模型，不能用于图片结构识别。请选择 Qwen、OpenAI 或自定义视觉模型。");
  }
  return {
    provider,
    providerLabel: preset.label,
    apiStyle,
    baseUrl,
    model,
    apiKey
  };
}

export function endpointFor(config, endpoint) {
  const suffix = endpoint.replace(/^\/+/, "");
  const base = config.baseUrl.replace(/\/+$/, "");
  if (base.endsWith(`/${suffix}`)) return base;
  return `${base}/${suffix}`;
}

function errorMessage(body, status) {
  return body?.error?.message ||
    body?.message ||
    (typeof body?.error === "string" ? body.error : "") ||
    `HTTP ${status}`;
}

function redactMessage(error, config) {
  const message = String(error?.message || error);
  return config.apiKey ? message.replaceAll(config.apiKey, "[已隐藏]") : message;
}

export async function postModelJson(url, config, body, {
  timeoutMs = 120000,
  fetchImpl = globalThis.fetch
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(errorMessage(responseBody, response.status));
    return responseBody;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`大模型请求等待超过 ${Math.ceil(timeoutMs / 60000)} 分钟。`);
    }
    throw new Error(redactMessage(error, config));
  } finally {
    clearTimeout(timer);
  }
}

async function parseErrorResponse(response) {
  const body = await response.json().catch(async () => ({
    message: await response.text().catch(() => "")
  }));
  return errorMessage(body, response.status);
}

/**
 * Consume an OpenAI-compatible SSE response while resetting the idle timer for
 * every received chunk. Qwen recommends streaming for long-running model calls;
 * collecting the deltas here preserves the same return shape used by the
 * non-streaming call sites.
 */
export async function postModelSse(url, config, body, {
  timeoutMs = 360000,
  idleTimeoutMs = 180000,
  fetchImpl = globalThis.fetch
} = {}) {
  const controller = new AbortController();
  let timeoutKind = "total";
  const totalTimer = setTimeout(() => {
    timeoutKind = "total";
    controller.abort();
  }, timeoutMs);
  let idleTimer;
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timeoutKind = "idle";
      controller.abort();
    }, idleTimeoutMs);
  };
  try {
    resetIdleTimer();
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
        "Accept": "text/event-stream"
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal
    });
    clearTimeout(idleTimer);
    if (!response.ok) throw new Error(await parseErrorResponse(response));

    // Some compatible services ignore stream=true and return ordinary JSON.
    if (!response.body?.getReader) return response.json();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let content = "";
    let finishReason = null;
    let usage = null;
    let model = config.model;

    const consumeLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) return false;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return payload === "[DONE]";
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return false;
      }
      model = chunk.model || model;
      usage = chunk.usage || usage;
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) content += choice.delta.content;
      if (choice?.message?.content) content += choice.message.content;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      return false;
    };

    let done = false;
    while (!done) {
      resetIdleTimer();
      const chunk = await reader.read();
      clearTimeout(idleTimer);
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) {
        if (consumeLine(line)) {
          done = true;
          break;
        }
      }
    }
    pending += decoder.decode();
    if (pending) consumeLine(pending);
    if (!content) throw new Error("大模型流式响应结束，但没有返回可读取的内容。");
    return {
      model,
      choices: [{
        message: { role: "assistant", content },
        finish_reason: finishReason || "stop",
        index: 0
      }],
      usage
    };
  } catch (error) {
    if (error.name === "AbortError") {
      if (timeoutKind === "idle") {
        throw new Error(`大模型连续 ${Math.ceil(idleTimeoutMs / 60000)} 分钟没有返回新数据。`);
      }
      throw new Error(`大模型正式分析等待超过 ${Math.ceil(timeoutMs / 60000)} 分钟。`);
    }
    throw new Error(redactMessage(error, config));
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
  }
}

export function extractChatText(response) {
  const message = response?.choices?.[0]?.message;
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    const text = message.content
      .map((item) => typeof item === "string" ? item : item?.text)
      .filter(Boolean)
      .join("");
    if (text) return text;
  }
  const argumentsText = message?.tool_calls?.[0]?.function?.arguments;
  if (typeof argumentsText === "string") return argumentsText;
  throw new Error("大模型没有返回可读取的内容。");
}

export function parseJsonText(text) {
  const trimmed = String(text || "").trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = Math.min(
      ...[unfenced.indexOf("{"), unfenced.indexOf("[")].filter((index) => index >= 0)
    );
    const end = Math.max(unfenced.lastIndexOf("}"), unfenced.lastIndexOf("]"));
    if (Number.isFinite(start) && end > start) {
      try {
        return JSON.parse(unfenced.slice(start, end + 1));
      } catch {
        // Fall through to the clearer error below.
      }
    }
    throw new Error("大模型返回内容不是有效 JSON。");
  }
}

export async function createChatCompletion(config, {
  messages,
  responseFormat = true,
  temperature = 0,
  timeoutMs = 120000,
  idleTimeoutMs = 180000,
  stream = false,
  maxTokens,
  extraBody,
  fetchImpl
}) {
  const body = {
    model: config.model,
    messages,
    stream: false,
    temperature,
    ...(Number.isFinite(maxTokens) ? { max_tokens: maxTokens } : {}),
    ...(extraBody || {})
  };
  if (responseFormat) body.response_format = { type: "json_object" };
  const post = stream ? postModelSse : postModelJson;
  return post(
    endpointFor(config, "chat/completions"),
    config,
    body,
    { timeoutMs, idleTimeoutMs, fetchImpl }
  );
}
