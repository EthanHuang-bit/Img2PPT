import test from "node:test";
import assert from "node:assert/strict";
import { runQualityLoop } from "../src/iteration-loop.mjs";

test("quality loop stops as soon as all gates pass", async () => {
  const result = await runQualityLoop({
    initialCandidate: 1,
    validate: async (candidate) => ({ score: candidate / 2, passed: candidate >= 2 }),
    develop: async ({ candidate }) => candidate + 1
  });
  assert.equal(result.iterations, 2);
  assert.equal(result.stopReason, "quality-gates-passed");
});

test("quality loop has an absolute ten-iteration ceiling", async () => {
  const result = await runQualityLoop({
    initialCandidate: 0,
    validate: async (candidate) => ({ score: candidate, passed: false }),
    develop: async ({ candidate }) => candidate + 1,
    stagnationLimit: 99,
    maxIterations: 99
  });
  assert.equal(result.iterations, 10);
  assert.equal(result.stopReason, "iteration-limit");
});

test("quality loop stops after two stagnant validations", async () => {
  const result = await runQualityLoop({
    initialCandidate: 0,
    validate: async () => ({ score: 0.8, passed: false }),
    develop: async ({ candidate }) => candidate + 1,
    stagnationLimit: 2
  });
  assert.equal(result.iterations, 3);
  assert.equal(result.stopReason, "stagnated");
});

test("quality loop retains the best candidate instead of the latest regression", async () => {
  const scores = [0.8, 0.9, 0.7];
  const result = await runQualityLoop({
    initialCandidate: 0,
    validate: async (candidate) => ({ score: scores[candidate], passed: false }),
    develop: async ({ candidate }) => candidate + 1,
    maxIterations: 3,
    stagnationLimit: 10
  });
  assert.equal(result.bestCandidate, 1);
  assert.equal(result.bestScore, 0.9);
});
