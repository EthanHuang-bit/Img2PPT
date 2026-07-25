export const RECONSTRUCTION_POLICY = Object.freeze({
  // Filled fallback assets at or above this share of a slide are a hard failure.
  maxFilledFallbackAreaRatio: 0.25,
  // Small connected components are treated as icon/detail candidates.
  maxIconAreaRatio: 0.035,
  minNativeShapeAreaRatio: 0.00008,
  colorDistance: 30,
  backgroundLuminance: 244,
  textPaddingPx: 3,
  textPaddingRatio: 0.18,
  defaultFontFace: "Arial",
  minFontPt: 4.5,
  maxFontPt: 42,
  slideWidthIn: 13.333
});

export function isForbiddenFilledFallback({ width, height, filledRatio = 1 }, image) {
  const areaRatio = (width * height) / (image.width * image.height);
  return filledRatio > 0.15 && areaRatio >= RECONSTRUCTION_POLICY.maxFilledFallbackAreaRatio;
}
