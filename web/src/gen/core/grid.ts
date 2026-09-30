export interface Grid { w: number; h: number; cell: number; data: Float32Array }

export function createGrid(w: number, h: number, cell: number, fill = 0): Grid {
  const data = new Float32Array(w * h);
  if (fill !== 0) data.fill(fill);
  return { w, h, cell, data };
}
export const gget = (g: Grid, x: number, y: number): number => g.data[y * g.w + x];
export const gset = (g: Grid, x: number, y: number, v: number): void => { g.data[y * g.w + x] = v; };
export const inBounds = (g: { w: number; h: number }, x: number, y: number): boolean => x >= 0 && y >= 0 && x < g.w && y < g.h;

/** Cell centers sit at (i+0.5)*cell in world coordinates. */
export function sampleGrid(g: Grid, wx: number, wy: number): number {
  const fx = wx / g.cell - 0.5, fy = wy / g.cell - 0.5;
  let x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  let x1 = x0 + 1, y1 = y0 + 1;
  x0 = Math.max(0, Math.min(g.w - 1, x0)); x1 = Math.max(0, Math.min(g.w - 1, x1));
  y0 = Math.max(0, Math.min(g.h - 1, y0)); y1 = Math.max(0, Math.min(g.h - 1, y1));
  const d = g.data, w = g.w;
  const a = d[y0 * w + x0], b = d[y0 * w + x1], c = d[y1 * w + x0], e = d[y1 * w + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
}

/** Central-difference gradient (dz/dx, dz/dy) in value per meter at cell coords. */
export function gradientAt(g: Grid, x: number, y: number): [number, number] {
  const xl = Math.max(0, x - 1), xr = Math.min(g.w - 1, x + 1);
  const yu = Math.max(0, y - 1), yd = Math.min(g.h - 1, y + 1);
  const d = g.data, w = g.w;
  return [(d[y * w + xr] - d[y * w + xl]) / ((xr - xl) * g.cell), (d[yd * w + x] - d[yu * w + x]) / ((yd - yu) * g.cell)];
}

/** Slope as rise/run. */
export function slopeGrid(height: Grid): Grid {
  const s = createGrid(height.w, height.h, height.cell);
  for (let y = 0; y < height.h; y++) for (let x = 0; x < height.w; x++) {
    const [gx, gy] = gradientAt(height, x, y);
    s.data[y * height.w + x] = Math.hypot(gx, gy);
  }
  return s;
}

export const D8: readonly (readonly [number, number])[] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];
export const D8_DIST = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];

export function neighbors4(g: { w: number; h: number }, i: number, out: number[]): number {
  const x = i % g.w, y = (i / g.w) | 0; let n = 0;
  if (x > 0) out[n++] = i - 1;
  if (x < g.w - 1) out[n++] = i + 1;
  if (y > 0) out[n++] = i - g.w;
  if (y < g.h - 1) out[n++] = i + g.w;
  return n;
}
export function neighbors8(g: { w: number; h: number }, i: number, out: number[]): number {
  const x = i % g.w, y = (i / g.w) | 0; let n = 0;
  for (const [dx, dy] of D8) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < g.w && ny < g.h) out[n++] = ny * g.w + nx;
  }
  return n;
}

/** Separable box blur; returns a new grid. */
export function blurGrid(g: Grid, radius: number, passes = 2): Grid {
  const w = g.w, h = g.h;
  let src = Float32Array.from(g.data);
  const tmp = new Float32Array(w * h);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -radius; k <= radius; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += src[y * w + xx]; n++; } }
        tmp[y * w + x] = s / n;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -radius; k <= radius; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; n++; } }
        out[y * w + x] = s / n;
      }
    }
    src = out;
  }
  return { w, h, cell: g.cell, data: src };
}
