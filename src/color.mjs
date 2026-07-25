export function luminance([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function colorDistance(a, b) {
  return Math.sqrt(
    (a[0] - b[0]) ** 2 +
    (a[1] - b[1]) ** 2 +
    (a[2] - b[2]) ** 2
  );
}

export function rgbHex(rgb) {
  return rgb.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function quantize(rgb, step = 24) {
  return rgb.slice(0, 3).map((v) => Math.min(255, Math.round(v / step) * step));
}

export function medianColor(pixels) {
  if (!pixels.length) return [255, 255, 255];
  const channels = [0, 1, 2].map((channel) =>
    pixels.map((p) => p[channel]).sort((a, b) => a - b)[Math.floor(pixels.length / 2)]
  );
  return channels;
}

