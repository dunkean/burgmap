/** Decorative hairlines: physical widths with a bounded screen weight. */
export const MAP_STROKES = {
  contour: { meters: 0.55, minPx: 0.55, maxPx: 0.8 },
  contourIndex: { meters: 0.88, minPx: 0.88, maxPx: 1.4 },
  strip: { meters: 0.28, minPx: 0.28, maxPx: 0.65 },
  furlong: { meters: 0.45, minPx: 0.45, maxPx: 0.85 },
  furrow: { meters: 0.35, minPx: 0.3, maxPx: 0.55 },
  headland: { meters: 0.6, minPx: 0.4, maxPx: 0.85 },
} as const;

/** Canvas keeps its historical minimum screen weights; the same upper bounds cap large maps and close zoom. */
export const CANVAS_MAP_STROKES = {
  ...MAP_STROKES,
  contour: { ...MAP_STROKES.contour, minPx: 0.7 },
  // Weighted by paletteIndexW/1.6, this is the previous 0.63*paletteIndexW pixels.
  contourIndex: { ...MAP_STROKES.contourIndex, minPx: 0.63 * 1.6 },
  strip: { ...MAP_STROKES.strip, minPx: 0.5 },
  furlong: { ...MAP_STROKES.furlong, minPx: 0.6 },
  headland: { ...MAP_STROKES.headland, minPx: 0.5 },
} as const;

export type MapStroke = { meters: number; minPx: number; maxPx: number };
/** Canvas world->screen scale; independent of map extent and device pixel ratio. */
export const mapStrokeWidth = (s: MapStroke, scale: number, weight = 1): number =>
  Math.min(s.maxPx * weight, Math.max(s.minPx * weight, s.meters * scale * weight)) / scale;
/** Portable SVG world widths for the actual export scale; resvg does not implement non-scaling-stroke. */
export const svgMapStroke = (s: MapStroke, scale: number, weight = 1): string =>
  `stroke-width="${Math.round(mapStrokeWidth(s, scale, weight) * 10000) / 10000}"`;
