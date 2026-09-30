/** Offsets, ribbons (street buffers), one-sided sweeps and convex insets. */
import type { Vec2, Polygon, Polyline } from '../core/geom';
import { dist, polygonArea } from '../core/geom';
import { isSimple, orientPos } from './poly';
import { repairRing } from './bool';

export function disk(c: Vec2, r: number, sides = 12): Polygon {
  const out: Vec2[] = [];
  for (let i = 0; i < sides; i++) {
    const a = ((i + 0.5) / sides) * 2 * Math.PI;
    out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return orientPos(out);
}

/** Unit left normals per vertex, mitered so the offset stays at distance 1 from both adjacent segments (capped). */
export function miterNormals(pl: Polyline, maxMiter = 2): Vec2[] {
  const n = pl.length;
  const segN: Vec2[] = [];
  for (let i = 1; i < n; i++) {
    const dx = pl[i].x - pl[i - 1].x, dy = pl[i].y - pl[i - 1].y, l = Math.hypot(dx, dy) || 1;
    segN.push({ x: -dy / l, y: dx / l });
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) { out.push(segN[0]); continue; }
    if (i === n - 1) { out.push(segN[n - 2]); continue; }
    const a = segN[i - 1], b = segN[i];
    let mx = a.x + b.x, my = a.y + b.y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) { out.push(a); continue; }
    mx /= ml; my /= ml;
    const cosH = mx * a.x + my * a.y;
    const k = Math.min(maxMiter, 1 / Math.max(1e-6, cosH));
    out.push({ x: mx * k, y: my * k });
  }
  return out;
}

/**
 * Ribbon polygon around a polyline with per-vertex full widths. Flat caps. Self-intersections on tight
 * bends are repaired with a union. Returns a positively oriented ring.
 */
export function ribbon(pl: Polyline, width: number | number[]): Polygon {
  if (pl.length < 2) return [];
  const nr = miterNormals(pl, 2.5);
  const L: Vec2[] = [], R: Vec2[] = [];
  for (let i = 0; i < pl.length; i++) {
    const h = (typeof width === 'number' ? width : width[i]) / 2;
    L.push({ x: pl[i].x + nr[i].x * h, y: pl[i].y + nr[i].y * h });
    R.push({ x: pl[i].x - nr[i].x * h, y: pl[i].y - nr[i].y * h });
  }
  let ring = orientPos(L.concat(R.reverse()));
  if (!isSimple(ring)) ring = repairRing(ring);
  return ring;
}

/**
 * One-sided sweep of an open polyline towards its LEFT by per-vertex depths, i.e. the region between the
 * polyline and its offset. `startDir`/`endDir` (optional, unit) replace the end normals so that sweeps of
 * adjacent runs can meet along a corner bisector or along the neighbouring street.
 */
export function sweepLeft(pl: Polyline, depth: number[], startDir?: Vec2, endDir?: Vec2, startLen?: number, endLen?: number): Polygon {
  const nr = miterNormals(pl, 1.6);
  const off: Vec2[] = pl.map((p, i) => ({ x: p.x + nr[i].x * depth[i], y: p.y + nr[i].y * depth[i] }));
  const n = pl.length;
  if (startDir) { const l = startLen ?? depth[0]; off[0] = { x: pl[0].x + startDir.x * l, y: pl[0].y + startDir.y * l }; }
  if (endDir) { const l = endLen ?? depth[n - 1]; off[n - 1] = { x: pl[n - 1].x + endDir.x * l, y: pl[n - 1].y + endDir.y * l }; }
  let ring = pl.concat(off.slice().reverse());
  if (polygonArea(ring) < 0) ring = ring.slice().reverse();
  if (!isSimple(ring)) ring = repairRing(ring);
  return ring;
}

/**
 * Inset of a convex (or nearly convex) polygon by d: intersect the inward-shifted edge lines.
 * Returns [] if the inset collapses or flips.
 */
export function insetConvex(p: Polygon, d: number | number[]): Polygon {
  const n = p.length;
  const lines: { px: number; py: number; dx: number; dy: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    const l = dist(a, b) || 1;
    const dx = (b.x - a.x) / l, dy = (b.y - a.y) / l;
    const dd = typeof d === 'number' ? d : d[i];
    lines.push({ px: a.x - dy * dd, py: a.y + dx * dd, dx, dy });
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const A = lines[(i - 1 + n) % n], B = lines[i];
    const den = A.dx * B.dy - A.dy * B.dx;
    if (Math.abs(den) < 1e-9) { out.push({ x: B.px, y: B.py }); continue; }
    const t = ((B.px - A.px) * B.dy - (B.py - A.py) * B.dx) / den;
    out.push({ x: A.px + A.dx * t, y: A.py + A.dy * t });
  }
  // validity: every edge keeps its direction and the ring stays positive and simple
  for (let i = 0; i < n; i++) {
    const a = out[i], b = out[(i + 1) % n];
    if ((b.x - a.x) * lines[i].dx + (b.y - a.y) * lines[i].dy <= 0.05) return [];
  }
  if (polygonArea(out) <= 0 || !isSimple(out)) return [];
  return out;
}
