import sharp from "sharp";
import potrace from "potrace";
import { colorDistance, medianColor } from "./color.mjs";

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

  let options = {};
  if (typeof colorVariance === "object") {
    options = colorVariance;
    colorVariance = options.colorVariance || 0;
    groupedParts = options.groupedParts || 1;
  }
  const textLines = options.textLines || [];
  const backgroundHex = options.backgroundColorHex;
  const foregroundHex = options.foregroundColorHex || colorHex;
  const { data, info } = await cropped.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgb = (hex) => /^[0-9A-F]{6}$/i.test(hex || "")
    ? [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
    : null;
  const border = [];
  const stride = Math.max(1, Math.round(Math.min(width, height) / 20));
  for (let x = 0; x < width; x += stride) {
    border.push([data[x * 3], data[x * 3 + 1], data[x * 3 + 2]]);
    const bottom = ((height - 1) * width + x) * 3;
    border.push([data[bottom], data[bottom + 1], data[bottom + 2]]);
  }
  for (let y = 0; y < height; y += stride) {
    const left = y * width * 3;
    const right = (y * width + width - 1) * 3;
    border.push([data[left], data[left + 1], data[left + 2]]);
    border.push([data[right], data[right + 1], data[right + 2]]);
  }
  const background = rgb(backgroundHex) || medianColor(border);
  const foreground = rgb(foregroundHex);
  const selected = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const pixel = [data[offset], data[offset + 1], data[offset + 2]];
      const fromBackground = colorDistance(pixel, background);
      const targetDistance = foreground ? colorDistance(pixel, foreground) : Infinity;
      selected[y * width + x] = (
        foreground
          ? targetDistance <= Math.max(58, colorVariance * 1.5) && fromBackground >= 24
          : fromBackground >= Math.max(34, colorVariance * 0.65)
      ) ? 1 : 0;
    }
  }

  // Erase every OCR region intersecting this crop before vectorization. This is
  // the key guarantee that editable text never remains baked into an icon asset.
  for (const line of textLines) {
    const overlapX0 = Math.max(bbox.x0, line.bbox.x0);
    const overlapY0 = Math.max(bbox.y0, line.bbox.y0);
    const overlapX1 = Math.min(bbox.x1, line.bbox.x1);
    const overlapY1 = Math.min(bbox.y1, line.bbox.y1);
    if (overlapX1 <= overlapX0 || overlapY1 <= overlapY0) continue;
    const pad = Math.max(2, Math.round((line.bbox.y1 - line.bbox.y0) * 0.16));
    const x0 = Math.max(0, Math.floor(line.bbox.x0 - bbox.x0 - pad));
    const y0 = Math.max(0, Math.floor(line.bbox.y0 - bbox.y0 - pad));
    const x1 = Math.min(width, Math.ceil(line.bbox.x1 - bbox.x0 + pad));
    const y1 = Math.min(height, Math.ceil(line.bbox.y1 - bbox.y0 + pad));
    for (let y = y0; y < y1; y += 1) selected.fill(0, y * width + x0, y * width + x1);
  }

  // Remove compression speckles and OCR crumbs by keeping only meaningful
  // 8-connected components. This produces a crisp, single-color glyph.
  const visited = new Uint8Array(selected.length);
  const kept = new Uint8Array(selected.length);
  const minimum = Math.max(3, Math.round(width * height * 0.0012));
  const directions = [-1, 0, 1];
  for (let seed = 0; seed < selected.length; seed += 1) {
    if (!selected[seed] || visited[seed]) continue;
    const queue = [seed];
    const component = [];
    visited[seed] = 1;
    for (let head = 0; head < queue.length; head += 1) {
      const index = queue[head];
      component.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      for (const dy of directions) {
        for (const dx of directions) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const next = ny * width + nx;
          if (selected[next] && !visited[next]) {
            visited[next] = 1;
            queue.push(next);
          }
        }
      }
    }
    if (component.length >= minimum) for (const index of component) kept[index] = 1;
  }
  const monochrome = Buffer.alloc(width * height, 255);
  for (let i = 0; i < kept.length; i += 1) if (kept[i]) monochrome[i] = 0;
  const maskPng = await sharp(monochrome, {
    raw: { width, height, channels: 1 }
  }).png().toBuffer();

  try {
    return await trace(maskPng, {
      color: `#${foregroundHex}`,
      background: "transparent",
      threshold: 128,
      turdSize: minimum,
      optCurve: true,
      optTolerance: groupedParts > 1 ? 0.24 : 0.18
    });
  } catch {
    const rgba = Buffer.alloc(width * height * 4);
    const pure = rgb(foregroundHex) || [51, 51, 51];
    for (let i = 0; i < kept.length; i += 1) {
      rgba[i * 4] = pure[0];
      rgba[i * 4 + 1] = pure[1];
      rgba[i * 4 + 2] = pure[2];
      rgba[i * 4 + 3] = kept[i] ? 255 : 0;
    }
    const transparent = await sharp(rgba, {
      raw: { width, height, channels: 4 }
    }).png().toBuffer();
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${escapeXml("Cleaned icon detail")}</title><image width="${width}" height="${height}" href="data:image/png;base64,${transparent.toString("base64")}"/></svg>`;
  }
}

export async function cleanPictureData(imageBuffer, bbox, textLines = []) {
  const left = Math.max(0, Math.round(bbox.x0));
  const top = Math.max(0, Math.round(bbox.y0));
  const width = Math.max(1, Math.round(bbox.x1 - bbox.x0));
  const height = Math.max(1, Math.round(bbox.y1 - bbox.y0));
  const crop = sharp(imageBuffer)
    .extract({ left, top, width, height })
    .ensureAlpha();
  const { data, info } = await crop.raw().toBuffer({ resolveWithObject: true });
  for (const line of textLines) {
    const x0 = Math.max(0, Math.floor(line.bbox.x0 - bbox.x0));
    const y0 = Math.max(0, Math.floor(line.bbox.y0 - bbox.y0));
    const x1 = Math.min(width, Math.ceil(line.bbox.x1 - bbox.x0));
    const y1 = Math.min(height, Math.ceil(line.bbox.y1 - bbox.y0));
    if (x1 <= x0 || y1 <= y0) continue;
    const samples = [];
    const pad = Math.max(2, Math.round((y1 - y0) * 0.2));
    for (let x = Math.max(0, x0 - pad); x < Math.min(width, x1 + pad); x += 2) {
      for (const y of [Math.max(0, y0 - pad), Math.min(height - 1, y1 + pad)]) {
        const offset = (y * width + x) * info.channels;
        samples.push([data[offset], data[offset + 1], data[offset + 2]]);
      }
    }
    const fill = medianColor(samples);
    for (let y = Math.max(0, y0 - 1); y < Math.min(height, y1 + 1); y += 1) {
      for (let x = Math.max(0, x0 - 1); x < Math.min(width, x1 + 1); x += 1) {
        const offset = (y * width + x) * info.channels;
        data[offset] = fill[0];
        data[offset + 1] = fill[1];
        data[offset + 2] = fill[2];
        data[offset + 3] = 255;
      }
    }
  }
  const png = await sharp(data, { raw: info }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}
