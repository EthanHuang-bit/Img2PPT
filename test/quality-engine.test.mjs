import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  calibrateEditableSimilarity,
  compareVisualBuffers,
  evaluateContent,
  evaluatePageQuality
} from "../src/quality-engine.mjs";

async function slide({
  x = 40,
  color = "#0E67D1",
  includeCircle = true
} = {}) {
  const circle = includeCircle
    ? '<circle cx="250" cy="90" r="28" fill="#E33D56"/>'
    : "";
  return sharp(Buffer.from(
    `<svg width="320" height="180" xmlns="http://www.w3.org/2000/svg">
      <rect width="320" height="180" fill="#ffffff"/>
      <rect x="${x}" y="45" width="130" height="70" rx="10" fill="${color}"/>
      ${circle}
    </svg>`
  )).png().toBuffer();
}

test("identical images receive a perfect foreground-aware score", async () => {
  const image = await slide();
  const metrics = await compareVisualBuffers(image, image);
  assert.ok(metrics.similarity > 0.9999);
  assert.ok(metrics.edgeSimilarity > 0.9999);
});

test("missing foreground objects cannot be hidden by a white background", async () => {
  const reference = await slide();
  const missing = await slide({ includeCircle: false });
  const metrics = await compareVisualBuffers(reference, missing);
  assert.ok(metrics.similarity < 0.99);
  assert.ok(metrics.foregroundCoverage < 0.99);
});

test("meaningful object movement reduces layout score", async () => {
  const reference = await slide();
  const shifted = await slide({ x: 90 });
  const metrics = await compareVisualBuffers(reference, shifted);
  assert.ok(metrics.layoutScore < 0.9);
});

test("wrong foreground color reduces appearance score", async () => {
  const reference = await slide();
  const wrongColor = await slide({ color: "#17A673" });
  const metrics = await compareVisualBuffers(reference, wrongColor);
  assert.ok(metrics.appearanceScore < 0.95);
});

test("content gate reports missing text and critical numbers", () => {
  const result = evaluateContent(
    [{ text: "Revenue 2026" }, { text: "AI Platform" }],
    ["Revenue", "Platform"]
  );
  assert.ok(result.missing.length >= 1);
  assert.deepEqual(result.criticalNumbersMissing, ["2026"]);
});

test("hard editability failures override a high visual score", () => {
  const quality = evaluatePageQuality({
    analysis: { textLines: [{ text: "AI" }] },
    auditSlide: {
      textValues: ["AI"],
      textShapeCount: 1,
      filledTextShapeCount: 1,
      minFontPt: 18,
      imageOnlyPage: false,
      rasterPictureCount: 0,
      shapeCount: 2
    },
    visual: { similarity: 1, layoutScore: 1, appearanceScore: 1 }
  });
  assert.equal(quality.passed, false);
  assert.ok(quality.diagnostics.some((item) => item.category === "editability"));
});

test("a structurally editable exact page passes local precheck", () => {
  const quality = evaluatePageQuality({
    analysis: { textLines: [{ text: "AI" }] },
    auditSlide: {
      textValues: ["AI"],
      textShapeCount: 1,
      filledTextShapeCount: 0,
      minFontPt: 18,
      imageOnlyPage: false,
      rasterPictureCount: 0,
      shapeCount: 2
    },
    visual: { similarity: 1, layoutScore: 1, appearanceScore: 1 }
  });
  assert.equal(quality.passed, true);
  assert.equal(quality.validationLevel, "local-precheck");
});

test("editable-render calibration is monotonic and never exceeds one", () => {
  assert.ok(calibrateEditableSimilarity(0.94) > calibrateEditableSimilarity(0.9));
  assert.equal(calibrateEditableSimilarity(2), 1);
  assert.equal(calibrateEditableSimilarity(0.5), 0.5);
});
