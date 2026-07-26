import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";

const port = 43177;
const baseUrl = `http://127.0.0.1:${port}`;
const outputDir = path.resolve("output/e2e-smoke");
await fs.mkdir(outputDir, { recursive: true });
const sourceBuffer = await sharp(Buffer.from(
  `<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg">
    <rect width="1280" height="720" fill="#ffffff"/>
    <rect x="80" y="70" width="1120" height="100" rx="18" fill="#12325C"/>
    <text x="120" y="135" font-family="Arial" font-size="42" font-weight="700" fill="#ffffff">IMG2PPT QUALITY SMOKE TEST</text>
    <rect x="120" y="250" width="300" height="190" rx="20" fill="#0E67D1"/>
    <rect x="490" y="250" width="300" height="190" rx="20" fill="#17A673"/>
    <rect x="860" y="250" width="300" height="190" rx="20" fill="#E55B38"/>
    <text x="195" y="350" font-family="Arial" font-size="38" fill="#ffffff">INPUT</text>
    <text x="555" y="350" font-family="Arial" font-size="38" fill="#ffffff">EDIT</text>
    <text x="920" y="350" font-family="Arial" font-size="38" fill="#ffffff">CHECK</text>
    <line x1="420" y1="345" x2="490" y2="345" stroke="#293A52" stroke-width="10"/>
    <line x1="790" y1="345" x2="860" y2="345" stroke="#293A52" stroke-width="10"/>
  </svg>`
)).png().toBuffer();

const server = spawn(process.execPath, ["src/server.mjs"], {
  cwd: path.resolve("."),
  env: {
    ...process.env,
    IMG2PPT_PORT: String(port),
    IMG2PPT_NO_BROWSER: "1"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk; });
server.stderr.on("data", (chunk) => { serverOutput += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Smoke server did not start.\n${serverOutput}`);
}

function commonFields(data) {
  data.append("useVision", "false");
  data.append("useTextModel", "false");
  return data;
}

try {
  const health = await waitForServer();
  assert.equal(health.version, "0.7.0-recovery");
  assert.equal(health.pageConcurrency, 20);

  const sessionId = "smoke_session_070";
  const createResponse = await fetch(`${baseUrl}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, total: 1 })
  });
  assert.equal(createResponse.ok, true);

  const analyzeData = commonFields(new FormData());
  analyzeData.append("sessionId", sessionId);
  analyzeData.append("index", "0");
  analyzeData.append("total", "1");
  analyzeData.append("image", new Blob([sourceBuffer], { type: "image/png" }), "smoke.png");
  const analyzeResponse = await fetch(`${baseUrl}/api/analyze/page`, {
    method: "POST",
    body: analyzeData
  });
  const analyzeBody = await analyzeResponse.json();
  assert.equal(analyzeResponse.ok, true, analyzeBody.error);
  assert.equal(analyzeBody.progress, 100);

  const convertData = commonFields(new FormData());
  convertData.append("sessionId", sessionId);
  const convertResponse = await fetch(`${baseUrl}/api/convert`, {
    method: "POST",
    body: convertData
  });
  if (!convertResponse.ok) {
    throw new Error(await convertResponse.text().catch(() => "PPT conversion failed"));
  }
  assert.equal(convertResponse.headers.get("X-Img2PPT-Cache-Reused"), "true");
  const qaHeader = convertResponse.headers.get("X-Img2PPT-QA");
  assert.ok(qaHeader);
  const qa = JSON.parse(Buffer.from(qaHeader, "base64").toString("utf8"));
  assert.equal(qa.cacheReused, true);
  assert.equal(qa.audit.passedTransparentText, true);
  const qualityResponse = await fetch(`${baseUrl}/api/session/${sessionId}/quality`);
  assert.equal(qualityResponse.ok, true);
  const fullQuality = await qualityResponse.json();
  assert.equal(fullQuality.pages.length, 1);
  const pptx = Buffer.from(await convertResponse.arrayBuffer());
  assert.equal(pptx.subarray(0, 2).toString("ascii"), "PK");
  await fs.writeFile(path.join(outputDir, "Img2PPT-smoke.pptx"), pptx);
  await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify({
    health,
    analysis: analyzeBody.analysis.summary,
    qa: fullQuality
  }, null, 2));
  console.log(`E2E smoke passed: cacheReused=true, pages=${qa.summary.pageCount}`);
} catch (error) {
  throw new Error(
    `${error.message}\nSmoke server output:\n${serverOutput || "(no output)"}`,
    { cause: error }
  );
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => {
    server.once("close", resolve);
    setTimeout(resolve, 2000);
  });
}
