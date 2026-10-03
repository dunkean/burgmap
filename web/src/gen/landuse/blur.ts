import type { Grid } from '../core/grid';

/** Separable box blur with running sums (O(1) per cell, whatever the radius); same edge handling as `blurGrid` (mean over the cells inside). */
export function blurFast(g: Grid, radius: number, passes = 2): Grid {
  const w = g.w, h = g.h;
  let src = Float32Array.from(g.data);
  let tmp = new Float32Array(w * h);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let s = 0;
      for (let x = 0; x <= Math.min(w - 1, radius - 1); x++) s += src[row + x];
      for (let x = 0; x < w; x++) {
        const add = x + radius, rem = x - radius - 1;
        if (add < w) s += src[row + add];
        if (rem >= 0) s -= src[row + rem];
        const lo = Math.max(0, x - radius), hi = Math.min(w - 1, x + radius);
        tmp[row + x] = s / (hi - lo + 1);
      }
    }
    const out = new Float32Array(w * h);
    const col = new Float64Array(w);
    for (let y = 0; y < h; y++) {
      // column sums over the window [y - radius, y + radius], updated row by row
      if (y === 0) { for (let yy = 0; yy <= Math.min(h - 1, radius); yy++) for (let x = 0; x < w; x++) col[x] += tmp[yy * w + x]; }
      else {
        const add = y + radius, rem = y - radius - 1;
        if (add < h) for (let x = 0; x < w; x++) col[x] += tmp[add * w + x];
        if (rem >= 0) for (let x = 0; x < w; x++) col[x] -= tmp[rem * w + x];
      }
      const cnt = Math.min(h - 1, y + radius) - Math.max(0, y - radius) + 1;
      for (let x = 0; x < w; x++) out[y * w + x] = col[x] / cnt;
    }
    src = out;
  }
  return { w, h, cell: g.cell, data: src };
}
