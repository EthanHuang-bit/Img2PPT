import test from "node:test";
import assert from "node:assert/strict";
import { normalizeModelConfig, parseJsonText } from "../src/model-client.mjs";
import { enhanceTextLines } from "../src/text-model.mjs";

test("model config permits HTTPS and local HTTP but blocks remote plaintext HTTP", () => {
  const secure = normalizeModelConfig({
    provider: "custom",
    apiStyle: "chat-completions",
    baseUrl: "https://models.example.com/v1/",
    model: "vision-model",
    apiKey: "secret"
  });
  assert.equal(secure.baseUrl, "https://models.example.com/v1");
  const local = normalizeModelConfig({
    provider: "custom",
    apiStyle: "chat-completions",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5-vl:7b",
    apiKey: "local"
  });
  assert.equal(local.model, "qwen2.5-vl:7b");
  assert.throws(() => normalizeModelConfig({
    provider: "custom",
    apiStyle: "chat-completions",
    baseUrl: "http://models.example.com/v1",
    model: "unsafe",
    apiKey: "secret"
  }), /HTTPS/);
});

test("DeepSeek is accepted for text but rejected for vision", () => {
  const text = normalizeModelConfig({
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    apiKey: "secret"
  }, { capability: "text" });
  assert.equal(text.apiStyle, "chat-completions");
  assert.throws(() => normalizeModelConfig({
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    apiKey: "secret"
  }, { capability: "vision" }), /不能用于图片/);
});

test("JSON parser accepts fenced provider output", () => {
  assert.deepEqual(parseJsonText("```json\n{\"ok\":true}\n```"), { ok: true });
});

test("text enhancement corrects OCR while preserving line geometry", async () => {
  const lines = [{
    text: "Network Archltecture",
    confidence: 72,
    bbox: { x0: 10, y0: 20, x1: 140, y1: 40 }
  }];
  const result = await enhanceTextLines(lines, {
    provider: "deepseek",
    apiStyle: "chat-completions",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    apiKey: "secret"
  }, {
    fetchImpl: async (_url, options) => {
      assert.doesNotMatch(options.body, /secret/);
      return {
        ok: true,
        async json() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  lines: [{ id: 0, text: "Network Architecture", role: "title" }]
                })
              }
            }]
          };
        }
      };
    }
  });
  assert.equal(result.lines[0].text, "Network Architecture");
  assert.deepEqual(result.lines[0].bbox, lines[0].bbox);
  assert.equal(result.lines[0].textRole, "title");
  assert.equal(result.correctionCount, 1);
});
