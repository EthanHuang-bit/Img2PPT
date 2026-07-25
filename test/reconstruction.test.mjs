import test from "node:test";
import assert from "node:assert/strict";
import { estimateFont, suppressDuplicateLines } from "../src/analyzer.mjs";
import { catalogIconSvg, normalizeIconKey } from "../src/icons.mjs";

test("font estimation is width constrained and does not enlarge long OCR text", () => {
  const style = estimateFont({
    text: "Enterprise Digital Industry Solutions and Transformation",
    bbox: { x0: 100, y0: 100, x1: 420, y1: 145 },
    words: [
      { text: "Enterprise", confidence: 95, bbox: { x0: 100, y0: 105, x1: 185, y1: 128 } },
      { text: "Transformation", confidence: 95, bbox: { x0: 270, y0: 105, x1: 420, y1: 128 } }
    ]
  }, 1000, 500, 13.333, 6.6665);
  assert.ok(style.fontSize >= 4.5);
  assert.ok(style.fontSize < 20);
  assert.equal(style.widthLimited, true);
});

test("overlapping band OCR and general OCR are deduplicated", () => {
  const lines = suppressDuplicateLines([
    {
      text: "Business Architecture",
      confidence: 86,
      bbox: { x0: 240, y0: 194, x1: 405, y1: 225 }
    },
    {
      text: "Business Architecture",
      confidence: 78,
      forcedColorHex: "FFFFFF",
      bbox: { x0: 245, y0: 197, x1: 404, y1: 228 }
    }
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].forcedColorHex, "FFFFFF");
});

test("semantic icon aliases map to a clean built-in SVG", () => {
  assert.equal(normalizeIconKey("Customer 360"), "customer");
  const svg = catalogIconSvg("database", "008B95");
  assert.match(svg, /<svg/);
  assert.match(svg, /#008B95/);
  assert.doesNotMatch(svg, /<image/);
});
