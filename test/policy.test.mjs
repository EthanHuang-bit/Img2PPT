import test from "node:test";
import assert from "node:assert/strict";
import { isForbiddenFilledFallback } from "../src/policy.mjs";

test("blocks a filled fallback covering one quarter of the slide", () => {
  assert.equal(isForbiddenFilledFallback(
    { width: 500, height: 250, filledRatio: 0.8 },
    { width: 1000, height: 500 }
  ), true);
});

test("allows a large hollow line frame", () => {
  assert.equal(isForbiddenFilledFallback(
    { width: 800, height: 400, filledRatio: 0.04 },
    { width: 1000, height: 500 }
  ), false);
});

