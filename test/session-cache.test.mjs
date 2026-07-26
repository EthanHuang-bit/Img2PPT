import test from "node:test";
import assert from "node:assert/strict";
import {
  AnalysisSessionCache,
  validateSessionId
} from "../src/session-cache.mjs";

test("session cache accepts out-of-order completed pages and restores order", () => {
  const cache = new AnalysisSessionCache();
  cache.create({ sessionId: "session_12345678", total: 3 });
  cache.setPage("session_12345678", 2, { name: "c.png", analysis: { summary: {} } });
  cache.setPage("session_12345678", 0, { name: "a.png", analysis: { summary: {} } });
  cache.setPage("session_12345678", 1, { name: "b.png", analysis: { summary: {} } });
  assert.deepEqual(
    cache.orderedPages("session_12345678").map((page) => page.name),
    ["a.png", "b.png", "c.png"]
  );
});

test("session status reports completed count and exact percentage", () => {
  const cache = new AnalysisSessionCache();
  cache.create({ sessionId: "session_abcdefgh", total: 4 });
  cache.setPage("session_abcdefgh", 3, { name: "d.png", analysis: { summary: {} } });
  const status = cache.status("session_abcdefgh");
  assert.equal(status.completed, 1);
  assert.equal(status.progress, 25);
  assert.equal(status.complete, false);
});

test("incomplete sessions cannot generate a full deck", () => {
  const cache = new AnalysisSessionCache();
  cache.create({ sessionId: "session_incomplete", total: 2 });
  cache.setPage("session_incomplete", 0, { name: "a.png" });
  assert.throws(
    () => cache.orderedPages("session_incomplete"),
    /仍有 1 页未完成/
  );
});

test("session total cannot silently change", () => {
  const cache = new AnalysisSessionCache();
  cache.create({ sessionId: "session_consistent", total: 2 });
  assert.throws(
    () => cache.create({ sessionId: "session_consistent", total: 3 }),
    /总数不一致/
  );
});

test("expired analysis buffers are pruned", () => {
  let now = 1000;
  const cache = new AnalysisSessionCache({ ttlMs: 50, now: () => now });
  cache.create({ sessionId: "session_expiring", total: 1 });
  now = 1100;
  assert.equal(cache.get("session_expiring"), null);
});

test("unsafe session identifiers are rejected", () => {
  assert.throws(() => validateSessionId("../../secret"), /标识无效/);
  assert.equal(validateSessionId("safe_session-123"), "safe_session-123");
});

test("quality report is stored separately from page summaries", () => {
  const cache = new AnalysisSessionCache();
  cache.create({ sessionId: "session_quality", total: 1 });
  const report = { summary: { averageScore: 0.98 }, pages: [{ index: 0 }] };
  cache.setQuality("session_quality", report);
  assert.equal(cache.quality("session_quality"), report);
  assert.equal(cache.status("session_quality").pages[0].status, "pending");
});
