import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { analyzeWithVision } from "../src/vision.mjs";
import { smallDetailSvg } from "../src/svg.mjs";

test("vision request uses image input, strict schema and ephemeral storage", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (_url, options) => {
    captured = {
      headers: options.headers,
      body: JSON.parse(options.body)
    };
    return {
      ok: true,
      async json() {
        return {
          output: [{
            type: "message",
            content: [{
              type: "output_text",
              text: JSON.stringify({
                pageSummary: "Architecture slide",
                objects: [{
                  kind: "icon",
                  bbox: { x: 100, y: 100, w: 120, h: 120 },
                  label: "database",
                  iconKey: "database",
                  foregroundColor: "FFFFFF",
                  backgroundShape: "ellipse",
                  backgroundColor: "008B95",
                  confidence: 0.96,
                  containsText: false,
                  layer: 3
                }]
              })
            }]
          }]
        };
      }
    };
  };
  try {
    const image = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: "#ffffff"
      }
    }).png().toBuffer();
    const result = await analyzeWithVision(image, {
      apiKey: "test-key",
      model: "gpt-5.6"
    });
    assert.equal(result.objects[0].iconKey, "database");
    assert.equal(captured.body.store, false);
    assert.equal(captured.body.text.format.strict, true);
    assert.equal(captured.body.input[1].content[1].type, "input_image");
    assert.match(captured.body.input[1].content[1].image_url, /^data:image\/jpeg;base64,/);
    assert.equal(captured.headers.Authorization, "Bearer test-key");
    assert.doesNotMatch(JSON.stringify(captured.body), /test-key/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Qwen vision uses OpenAI-compatible chat completions with JSON mode", async () => {
  let captured;
  const image = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 3,
      background: "#ffffff"
    }
  }).png().toBuffer();
  const result = await analyzeWithVision(image, {
    apiKey: "qwen-test-key",
    provider: "qwen",
    apiStyle: "chat-completions",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    model: "qwen3-vl-plus",
    fetchImpl: async (url, options) => {
      captured = { url, headers: options.headers, body: JSON.parse(options.body) };
      return {
        ok: true,
        async json() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  pageSummary: "Simple slide",
                  objects: []
                })
              }
            }]
          };
        }
      };
    }
  });
  assert.equal(result.provider, "qwen");
  assert.equal(result.apiStyle, "chat-completions");
  assert.match(captured.url, /\/chat\/completions$/);
  assert.equal(captured.body.response_format.type, "json_object");
  assert.equal(captured.body.stream, true);
  assert.equal(captured.body.enable_thinking, false);
  assert.equal(captured.body.max_tokens, 8192);
  assert.equal(captured.body.messages[1].content[1].type, "image_url");
  assert.match(captured.body.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.doesNotMatch(JSON.stringify(captured.body), /qwen-test-key/);
});

test("Qwen streaming vision collects split SSE JSON without timing out", async () => {
  const image = await sharp({
    create: {
      width: 48,
      height: 32,
      channels: 3,
      background: "#ffffff"
    }
  }).png().toBuffer();
  const payload = JSON.stringify({
    pageSummary: "Streamed slide",
    objects: [{
      kind: "icon",
      bbox: { x: 100, y: 100, w: 120, h: 120 },
      label: "database",
      iconKey: "database",
      foregroundColor: "FFFFFF",
      backgroundShape: "ellipse",
      backgroundColor: "008B95",
      confidence: 0.92,
      containsText: false,
      layer: 3
    }]
  });
  const midpoint = Math.floor(payload.length / 2);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        choices: [{ delta: { content: payload.slice(0, midpoint) }, finish_reason: null }]
      })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        choices: [{ delta: { content: payload.slice(midpoint) }, finish_reason: "stop" }]
      })}\n\ndata: [DONE]\n\n`));
      controller.close();
    }
  });
  const result = await analyzeWithVision(image, {
    apiKey: "qwen-stream-key",
    provider: "qwen",
    apiStyle: "chat-completions",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3-vl-plus",
    fetchImpl: async () => new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    })
  });
  assert.equal(result.pageSummary, "Streamed slide");
  assert.equal(result.objects[0].iconKey, "database");
});

test("icon cleaning removes text box pixels and always returns pure vector markup", async () => {
  const source = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80">
    <rect width="120" height="80" fill="white"/>
    <path d="M15 55h35V20H15z" fill="#008B95"/>
    <circle cx="20" cy="10" r="1" fill="#008B95"/>
    <text x="62" y="48" font-size="24" fill="#008B95">ABC</text>
  </svg>`);
  const image = await sharp(source).png().toBuffer();
  const svg = await smallDetailSvg(
    image,
    { x0: 0, y0: 0, x1: 120, y1: 80 },
    "008B95",
    {
      colorVariance: 0,
      groupedParts: 1,
      textLines: [{ bbox: { x0: 58, y0: 25, x1: 118, y1: 55 } }],
      foregroundColorHex: "008B95"
    }
  );
  assert.match(svg, /<svg/);
  assert.doesNotMatch(svg, /<image/);
  assert.doesNotMatch(svg, />ABC</);
});
