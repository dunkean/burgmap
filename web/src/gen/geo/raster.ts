/** Scanline rasterization of polygons (with holes, even-odd) onto a grid of cell centers. */
import type { Polygon } from '../core/geom';

export function rasterizePolys(polys: Polygon[], w: number, h: number, cell: number, out: Uint8Array = new Uint8Array(w * h)): Uint8Array {
  // all rings together with even-odd parity: outer rings and holes both toggle
  let y0 = Infinity, y1 = -Infinity;
  for (const p of polys) for (const q of p) { y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
  if (!isFinite(y0)) return out;
  const r0 = Math.max(0, Math.floor(y0 / cell - 0.5)), r1 = Math.min(h - 1, Math.ceil(y1 / cell - 0.5));
  const xs: number[] = [];
  for (let r = r0; r <= r1; r++) {
    const y = (r + 0.5) * cell;
    xs.length = 0;
    for (const p of polys) {
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const a = p[i], b = p[j];
        if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] / cell - 0.5)), c1 = Math.min(w - 1, Math.floor(xs[k + 1] / cell - 0.5));
      for (let c = c0; c <= c1; c++) out[r * w + c] = 1;
    }
  }
  return out;
}
