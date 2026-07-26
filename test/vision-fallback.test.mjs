import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  analyzeWithVisionFallback,
  mergeQuadrantLayouts,
  quadrantRegions
} from "../src/vision.mjs";

function object(overrides = {}) {
  return {
    kind: "rect",
    bbox: { x: 100, y: 100, w: 300, h: 200 },
    label: "",
    iconKey: "other",
    foregroundColor: "333333",
    backgroundShape: "none",
    backgroundColor: "FFFFFF",
    confidence: 0.9,
    containsText: false,
    layer: 1,
    ...overrides
  };
}

test("quadrants overlap and cover all four page corners", () => {
  const regions = quadrantRegions(1000, 600);
  assert.equal(regions.length, 4);
  assert.equal(regions[0].left, 0);
  assert.equal(regions[0].top, 0);
  assert.equal(regions[3].left + regions[3].width, 1000);
  assert.equal(regions[3].top + regions[3].height, 600);
  assert.ok(regions[0].width + regions[1].width > 1000);
});

test("quadrant objects are restored to full-page coordinates", () => {
  const regions = quadrantRegions(1000, 600);
  const merged = mergeQuadrantLayouts([
    { objects: [object({ bbox: { x: 0, y: 0, w: 100, h: 100 } })] },
    null,
    null,
    null
  ], regions, { width: 1000, height: 600 });
  assert.equal(merged.objects[0].bbox.x, 0);
  assert.equal(merged.objects[0].bbox.y, 0);
  assert.ok(merged.objects[0].bbox.w < 100);
});

test("overlap duplicates from adjacent regions are merged", () => {
  const regions = [
    { label: "left", left: 0, top: 0, width: 600, height: 600 },
    { label: "right", left: 400, top: 0, width: 600, height: 600 }
  ];
  const merged = mergeQuadrantLayouts([
    { objects: [object({ label: "CRM", bbox: { x: 700, y: 100, w: 250, h: 200 } })] },
    { objects: [object({ label: "CRM", bbox: { x: 0, y: 100, w: 250, h: 200 } })] }
  ], regions, { width: 1000, height: 600 });
  assert.equal(merged.objects.length, 1);
  assert.ok(merged.objects[0].bbox.w >= 150);
});

test("successful full-page vision does not call split fallback", async () => {
  let calls = 0;
  const result = await analyzeWithVisionFallback(Buffer.from("unused"), {
    analyzeFn: async () => {
      calls += 1;
      return { objects: [], pageSummary: "", provider: "test", model: "test" };
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.fallback.used, false);
});

test("a timeout triggers four contextual crop requests and merges them", async () => {
  const image = await sharp({
    create: { width: 320, height: 180, channels: 3, background: "#ffffff" }
  }).png().toBuffer();
  let calls = 0;
  const regions = [];
  const result = await analyzeWithVisionFallback(image, {
    sourceName: "slide.png",
    analyzeFn: async (_buffer, options) => {
      calls += 1;
      if (calls === 1) throw new Error("request timeout");
      assert.ok(options.contextImageBuffer);
      regions.push(options.region.label);
      return {
        objects: [object({ label: options.region.label })],
        pageSummary: options.region.label,
        provider: "test",
        model: "test",
        apiStyle: "chat-completions"
      };
    }
  });
  assert.equal(calls, 5);
  assert.equal(new Set(regions).size, 4);
  assert.equal(result.fallback.used, true);
  assert.equal(result.fallback.successfulRegions, 4);
});

test("authentication errors do not multiply into four doomed requests", async () => {
  let calls = 0;
  await assert.rejects(
    analyzeWithVisionFallback(Buffer.from("unused"), {
      analyzeFn: async () => {
        calls += 1;
        throw new Error("401 Unauthorized API key");
      }
    }),
    /401/
  );
  assert.equal(calls, 1);
});
