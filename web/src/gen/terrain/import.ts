import { Grid, createGrid } from '../core/grid';

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
