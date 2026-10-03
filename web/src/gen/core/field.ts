import type { Vec2 } from './geom';

export const smoothstep = (x: number, a: number, b: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1e-9)));
  return t * t * (3 - 2 * t);
};

/**
 * Two-pass chamfer distance transform (meters). `mask` != 0 marks sources. When `carry` is given,
 * `val` holds the carried value of the (approximately) nearest source.
 */
export function distanceField(
  mask: ArrayLike<number>, w: number, h: number, cell: number, carry?: ArrayLike<number>,
): { dist: Float32Array; val?: Float32Array } {
  const N = w * h;
  const dist = new Float32Array(N).fill(1e9);
  const val = carry ? new Float32Array(N) : undefined;
  for (let i = 0; i < N; i++) if (mask[i]) { dist[i] = 0; if (val) val[i] = carry![i]; }
  const S2 = Math.SQRT2;
  // (the relaxations are written out: same order and arithmetic as dist[i] = min(dist[i], dist[j] + w))
  if (!val) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let di = dist[i], d: number;
        if (x > 0) { d = dist[i - 1] + 1; if (d < di) { dist[i] = d; di = dist[i]; } }
        if (y > 0) {
          d = dist[i - w] + 1; if (d < di) { dist[i] = d; di = dist[i]; }
          if (x > 0) { d = dist[i - w - 1] + S2; if (d < di) { dist[i] = d; di = dist[i]; } }
          if (x < w - 1) { d = dist[i - w + 1] + S2; if (d < di) { dist[i] = d; di = dist[i]; } }
        }
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        let di = dist[i], d: number;
        if (x < w - 1) { d = dist[i + 1] + 1; if (d < di) { dist[i] = d; di = dist[i]; } }
        if (y < h - 1) {
          d = dist[i + w] + 1; if (d < di) { dist[i] = d; di = dist[i]; }
          if (x < w - 1) { d = dist[i + w + 1] + S2; if (d < di) { dist[i] = d; di = dist[i]; } }
          if (x > 0) { d = dist[i + w - 1] + S2; if (d < di) { dist[i] = d; di = dist[i]; } }
        }
      }
    }
    for (let i = 0; i < N; i++) dist[i] *= cell;
    return { dist, val };
  }
  const relax = (i: number, j: number, wgt: number) => {
    const d = dist[j] + wgt;
    if (d < dist[i]) { dist[i] = d; if (val) val[i] = val[j]; }
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) relax(i, i - 1, 1);
      if (y > 0) {
        relax(i, i - w, 1);
        if (x > 0) relax(i, i - w - 1, S2);
        if (x < w - 1) relax(i, i - w + 1, S2);
      }
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x < w - 1) relax(i, i + 1, 1);
      if (y < h - 1) {
        relax(i, i + w, 1);
        if (x < w - 1) relax(i, i + w + 1, S2);
        if (x > 0) relax(i, i + w - 1, S2);
      }
    }
  }
  for (let i = 0; i < N; i++) dist[i] *= cell;
  return { dist, val };
}

/** Calls fn(cellIndex) for every cell whose center is within `radius` of the polyline. */
export function forCellsNearPolyline(
  pl: Vec2[], w: number, h: number, cell: number, radius: number, fn: (idx: number, d: number) => void,
): void {
  const seen = new Set<number>();
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1], b = pl[i];
    const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - radius) / cell)), x1 = Math.min(w - 1, Math.floor((Math.max(a.x, b.x) + radius) / cell));
    const y0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - radius) / cell)), y1 = Math.min(h - 1, Math.floor((Math.max(a.y, b.y) + radius) / cell));
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = (x + 0.5) * cell, py = (y + 0.5) * cell;
      const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2));
      const d = Math.hypot(px - a.x - t * dx, py - a.y - t * dy);
      if (d <= radius) {
        const idx = y * w + x;
        if (pl.length > 2 && seen.has(idx)) continue;
        seen.add(idx);
        fn(idx, d);
      }
    }
  }
}

/** Cell index containing a world point (clamped). */
export const cellIndex = (g: { w: number; h: number; cell: number }, p: Vec2): number =>
  Math.min(g.h - 1, Math.max(0, Math.floor(p.y / g.cell))) * g.w + Math.min(g.w - 1, Math.max(0, Math.floor(p.x / g.cell)));
