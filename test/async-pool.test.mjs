import test from "node:test";
import assert from "node:assert/strict";
import {
  allSettledConcurrent,
  mapConcurrent,
  normalizeConcurrency,
  Semaphore
} from "../src/async-pool.mjs";

test("concurrency is clamped to the supported 1..20 range", () => {
  assert.equal(normalizeConcurrency(0), 1);
  assert.equal(normalizeConcurrency(99), 20);
  assert.equal(normalizeConcurrency("7"), 7);
});

test("mapConcurrent preserves input order while limiting active work", async () => {
  let active = 0;
  let maximum = 0;
  const values = await mapConcurrent([4, 3, 2, 1], async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active -= 1;
    return value * 2;
  }, { concurrency: 2 });
  assert.deepEqual(values, [8, 6, 4, 2]);
  assert.equal(maximum, 2);
});

test("allSettledConcurrent keeps processing after a page failure", async () => {
  const values = await allSettledConcurrent([1, 2, 3], async (value) => {
    if (value === 2) throw new Error("page failed");
    return value;
  }, { concurrency: 3 });
  assert.deepEqual(values.map((item) => item.status), [
    "fulfilled",
    "rejected",
    "fulfilled"
  ]);
});

test("Semaphore never exceeds its limit", async () => {
  const semaphore = new Semaphore(3);
  let active = 0;
  let maximum = 0;
  await Promise.all(Array.from({ length: 12 }, (_, index) =>
    semaphore.run(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, index % 3));
      active -= 1;
    })
  ));
  assert.equal(maximum, 3);
  assert.equal(semaphore.active, 0);
  assert.equal(semaphore.pending, 0);
});
