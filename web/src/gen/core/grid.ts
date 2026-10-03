export interface Grid { w: number; h: number; cell: number; data: Float32Array }

/**
 * Optional side table: a box (cells, inclusive) outside which a grid's data is known to be Infinity (bounded cost
 * fields of the secondary settlements). Loops may skip the rest; absent = no such knowledge.
 */
export const FINITE_BOX = new WeakMap<Float32Array, { x0: number; y0: number; x1: number; y1: number }>();

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

/**
 * Can a running (sliding-window) sum over the float32 values `a[off + k*stride]`, k < len, be computed exactly in
 * doubles? True when every value is a multiple of 2^E (E = lowest set bit over the line) and the largest partial
 * sum, bounded by (2r+2)·max|v|, stays below 2^(53+E): all sums are then exact, so the sliding window gives the
 * same doubles as summing each window from scratch.
 */
const F32 = new Float32Array(1), U32 = new Uint32Array(F32.buffer);
function exactLine(a: Float32Array, off: number, stride: number, len: number, radius: number): boolean {
  let E = 1e9, M = 0;
  for (let k = 0, i = off; k < len; k++, i += stride) {
    const v = a[i];
    if (v === 0) continue;
    F32[0] = v;
    const b = U32[0];
    const e = (b >>> 23) & 255;
    if (e === 255) return false;
    let m = b & 0x7fffff;
    if (e) m |= 0x800000;
    const low = (e ? e - 150 : -149) + (31 - Math.clz32(m & -m));
    if (low < E) E = low;
    const av = v < 0 ? -v : v;
    if (av > M) M = av;
  }
  if (M === 0) return true;
  return (2 * radius + 2) * M <= Math.pow(2, 53 + E);
}

/** Separable box blur; returns a new grid. */
export function blurGrid(g: Grid, radius: number, passes = 2): Grid {
  const w = g.w, h = g.h;
  let src = Float32Array.from(g.data);
  const tmp = new Float32Array(w * h);
  const acc = new Float64Array(w);
  const colOk = new Uint8Array(w);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      if (exactLine(src, row, 1, w, radius)) {
        // sliding window (exact): same sums as the per-pixel loop below
        let s = 0;
        for (let k = 0; k <= radius && k < w; k++) s += src[row + k];
        for (let x = 0; x < w; x++) {
          const n = Math.min(w - 1, x + radius) - Math.max(0, x - radius) + 1;
          tmp[row + x] = s / n;
          if (x + radius + 1 < w) s += src[row + x + radius + 1];
          if (x - radius >= 0) s -= src[row + x - radius];
        }
        continue;
      }
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -radius; k <= radius; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += src[y * w + xx]; n++; } }
        tmp[y * w + x] = s / n;
      }
    }
    const out = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      colOk[x] = exactLine(tmp, x, w, h, radius) ? 1 : 0;
      if (!colOk[x]) continue;
      let s = 0;
      for (let k = 0; k <= radius && k < h; k++) s += tmp[k * w + x];
      acc[x] = s;
    }
    for (let y = 0; y < h; y++) {
      const n = Math.min(h - 1, y + radius) - Math.max(0, y - radius) + 1;
      const add = y + radius + 1 < h ? (y + radius + 1) * w : -1, sub = y - radius >= 0 ? (y - radius) * w : -1;
      for (let x = 0; x < w; x++) {
        if (colOk[x]) {
          out[y * w + x] = acc[x] / n;
          if (add >= 0) acc[x] += tmp[add + x];
          if (sub >= 0) acc[x] -= tmp[sub + x];
          continue;
        }
        let s = 0, nn = 0;
        for (let k = -radius; k <= radius; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; nn++; } }
        out[y * w + x] = s / nn;
      }
    }
    src = out;
  }
  return { w, h, cell: g.cell, data: src };
}
