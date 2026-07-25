import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited ${code}: ${stderr}`)));
  });
}

async function resolveCommand(name) {
  const candidates = name === "soffice"
    ? ["soffice", "/opt/codex/runtimes/codex-primary-runtime/dependencies/bin/override/soffice"]
    : [name, `/opt/codex/runtimes/codex-primary-runtime/dependencies/bin/override/${name}`];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  return candidates[0];
}

export async function renderPptx(pptxPath, renderDir) {
  await fs.mkdir(renderDir, { recursive: true });
  const soffice = await resolveCommand("soffice");
  const pdftoppm = await resolveCommand("pdftoppm");
  const profileDir = path.join(renderDir, "lo-profile");
  await fs.mkdir(profileDir, { recursive: true });
  await run(soffice, [
    `-env:UserInstallation=file://${profileDir}`,
    "--headless",
    "--convert-to",
    "pdf",
    "--outdir",
    renderDir,
    pptxPath
  ]);
  const pdfPath = path.join(renderDir, `${path.basename(pptxPath, path.extname(pptxPath))}.pdf`);
  await run(pdftoppm, ["-png", "-r", "120", pdfPath, path.join(renderDir, "slide")]);
  return (await fs.readdir(renderDir))
    .filter((file) => /^slide-\d+\.png$/.test(file))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((file) => path.join(renderDir, file));
}

export async function compareImages(referencePath, renderedPath, diffPath) {
  const reference = sharp(referencePath).removeAlpha();
  const metadata = await reference.metadata();
  const rendered = sharp(renderedPath).resize(metadata.width, metadata.height, { fit: "fill" }).removeAlpha();
  const [refRaw, renderRaw] = await Promise.all([
    reference.raw().toBuffer(),
    rendered.raw().toBuffer()
  ]);
  let absoluteError = 0;
  let changed = 0;
  const diff = Buffer.alloc(refRaw.length);
  for (let i = 0; i < refRaw.length; i += 3) {
    const dr = Math.abs(refRaw[i] - renderRaw[i]);
    const dg = Math.abs(refRaw[i + 1] - renderRaw[i + 1]);
    const db = Math.abs(refRaw[i + 2] - renderRaw[i + 2]);
    const value = (dr + dg + db) / 3;
    absoluteError += value;
    if (value > 24) changed += 1;
    diff[i] = Math.min(255, value * 3);
    diff[i + 1] = Math.max(0, 255 - value * 2);
    diff[i + 2] = Math.max(0, 255 - value * 2);
  }
  await sharp(diff, { raw: { width: metadata.width, height: metadata.height, channels: 3 } }).png().toFile(diffPath);
  const pixels = metadata.width * metadata.height;
  return {
    meanAbsoluteError: absoluteError / pixels,
    changedPixelRatio: changed / pixels,
    similarity: Math.max(0, 1 - absoluteError / (pixels * 255))
  };
}
