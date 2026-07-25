import sharp from "sharp";
import potrace from "potrace";

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    "\"": "&quot;"
  })[char]);
}

// Creates an SVG wrapper around a tightly cropped raster detail. This is only used
// for small icon/detail candidates. Large filled fallback is blocked by policy.
function trace(buffer, options) {
  return new Promise((resolve, reject) => {
    potrace.trace(buffer, options, (error, svg) => error ? reject(error) : resolve(svg));
  });
}

export async function smallDetailSvg(imageBuffer, bbox, colorHex = "333333", colorVariance = 0, groupedParts = 1) {
  const width = Math.max(1, Math.round(bbox.x1 - bbox.x0));
  const height = Math.max(1, Math.round(bbox.y1 - bbox.y0));
  const cropped = sharp(imageBuffer)
    .extract({ left: Math.max(0, Math.round(bbox.x0)), top: Math.max(0, Math.round(bbox.y0)), width, height })
    .flatten({ background: "#ffffff" });
  async function transparentRasterSvg() {
    const { data, info } = await cropped.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i] > 246 && data[i + 1] > 246 && data[i + 2] > 246) data[i + 3] = 0;
    }
    const transparent = await sharp(data, { raw: info }).png().toBuffer();
    const encoded = transparent.toString("base64");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${escapeXml("Detected icon detail")}</title><image width="${width}" height="${height}" href="data:image/png;base64,${encoded}"/></svg>`;
  }
  if (colorVariance > 28 || groupedParts > 1) return transparentRasterSvg();
  try {
    const monochrome = await cropped.grayscale().normalize().png().toBuffer();
    return await trace(monochrome, {
      color: `#${colorHex}`,
      background: "transparent",
      threshold: 215,
      turdSize: 2,
      optCurve: true,
      optTolerance: 0.3
    });
  } catch {
    return transparentRasterSvg();
  }
}
