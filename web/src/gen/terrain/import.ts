import { Grid, createGrid, blurGrid } from '../core/grid';

export interface ImportOptions {
  /** Height in meters for luminance 0 and 1. */
  minHeight?: number;
  maxHeight?: number;
  /** Output grid resolution (cells per side); defaults to min(w, h, 512). */
  gridSize?: number;
  /** Map size in meters (for the grid's cell size). */
  mapSize: number;
  invert?: boolean;
}

/** Grayscale luminance -> meters, resampled (box filter) into a square grid. */
export function heightFromImage(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, opts: ImportOptions): Grid {
  const lo = opts.minHeight ?? 0, hi = opts.maxHeight ?? 100;
  const n = opts.gridSize ?? Math.min(512, Math.max(16, Math.min(w, h)));
  const g = createGrid(n, n, opts.mapSize / n);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4], gg = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    let l = (0.2126 * r + 0.7152 * gg + 0.0722 * b) / 255;
    if (opts.invert) l = 1 - l;
    lum[i] = l;
  }
  // center-crop to square
  const side = Math.min(w, h);
  const ox = Math.floor((w - side) / 2), oy = Math.floor((h - side) / 2);
  const step = side / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const x0 = Math.floor(x * step), x1 = Math.max(x0 + 1, Math.floor((x + 1) * step));
      const y0 = Math.floor(y * step), y1 = Math.max(y0 + 1, Math.floor((y + 1) * step));
      let s = 0, c = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { s += lum[(oy + yy) * w + ox + xx]; c++; }
      g.data[y * n + x] = lo + (hi - lo) * (s / c);
    }
  }
  return g;
}

/** Pixels of an imported heightmap (RGBA, row-major). Serializable (structured clone) so it can cross into the worker. */
export interface ImportedHeight { w: number; h: number; rgba: Uint8ClampedArray | Uint8Array; name?: string }

export interface ImportedPlan {
  downSide: 'N' | 'E' | 'S' | 'W';
  seaSide: 'N' | 'E' | 'S' | 'W' | null;
  relief: 'flat' | 'hills' | 'valley' | 'mountains';
  amp: number;
  seaCover: number;
  k: number;
}

/**
 * Terrain-stage hook: turn an imported image into the height grid (meters, sea <= 0) and a matching HeightPlan.
 * `heightScale` = meters of a white pixel, `seaLevel` = meters below which the land is sea (0 = no sea).
 * Deterministic: no randomness involved.
 */
export function importedHeightfield(img: ImportedHeight, mapSize: number, n: number, heightScale = 120, seaLevel = 0): { height: Grid; plan: ImportedPlan } {
  const g = heightFromImage(img.rgba, img.w, img.h, { mapSize, gridSize: n, minHeight: 0, maxHeight: heightScale });
  const N = n * n;
  // a coarse source is upsampled with nearest neighbour above: soften the steps
  const side = Math.min(img.w, img.h);
  const H = side < n ? blurGrid(g, Math.max(1, Math.round(n / side)), 2).data : g.data;
  for (let i = 0; i < N; i++) {
    const raw = H[i];
    g.data[i] = raw < seaLevel ? raw - seaLevel - 0.05 : Math.max(0.3, raw - seaLevel);
  }
  const sorted = Float32Array.from(g.data).sort();
  const p99 = sorted[Math.floor(N * 0.99)], p01 = sorted[Math.floor(N * 0.01)];
  // where is the sea, where does the land drain to?
  const strip = Math.max(2, Math.round(n * 0.08));
  const score: Record<'N' | 'E' | 'S' | 'W', { sea: number; mean: number; c: number }> = { N: { sea: 0, mean: 0, c: 0 }, E: { sea: 0, mean: 0, c: 0 }, S: { sea: 0, mean: 0, c: 0 }, W: { sea: 0, mean: 0, c: 0 } };
  let seaCells = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = g.data[y * n + x];
    if (v <= 0) seaCells++;
    const sides: ('N' | 'E' | 'S' | 'W')[] = [];
    if (y < strip) sides.push('N');
    if (y >= n - strip) sides.push('S');
    if (x < strip) sides.push('W');
    if (x >= n - strip) sides.push('E');
    for (const s of sides) { const e = score[s]; e.c++; e.mean += v; if (v <= 0) e.sea++; }
  }
  let seaSide: 'N' | 'E' | 'S' | 'W' | null = null;
  let downSide: 'N' | 'E' | 'S' | 'W' = 'S';
  let bestSea = 0, lowest = Infinity;
  for (const s of ['N', 'E', 'S', 'W'] as const) {
    const e = score[s];
    if (e.sea / e.c > bestSea) { bestSea = e.sea / e.c; if (bestSea > 0.25 && seaCells / N > 0.02) seaSide = s; }
    if (e.mean / e.c < lowest) { lowest = e.mean / e.c; downSide = s; }
  }
  if (seaSide) downSide = seaSide;
  const span = p99 - Math.max(0, p01);
  const relief = span < 35 ? 'flat' : span < 160 ? 'hills' : 'mountains';
  return {
    height: g,
    plan: { downSide, seaSide, relief, amp: Math.max(p99, 10), seaCover: seaSide ? seaCells / N : 0, k: Math.max(0.25, Math.min(14, Math.pow(mapSize / 2400, 0.85))) },
  };
}
