/** Farmstead drawing helpers shared by the SVG and Canvas renderers (lots, plots, ridges from the roof metadata). */
import type { Farmstead, FarmBuilding, Polygon, Polyline, Vec2 } from '../gen/types';

/** Ridge lines of the farm buildings from their roof kind: full-length ridge for gables, shortened for hips, none for flat or round roofs. */
export function farmRidges(f: Farmstead): Polyline[] {
  const out: Polyline[] = [];
  for (const b of f.parts ?? []) {
    const r = ridge(b);
    if (r) out.push(r);
  }
  return out;
}

function ridge(b: FarmBuilding): Polyline | null {
  if (b.roof === 'flat' || b.roof === 'none' || b.poly.length !== 4) return null;
  const [p0, p1, p2, p3] = b.poly;
  const l01 = Math.hypot(p1.x - p0.x, p1.y - p0.y), l12 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  // midpoints of the two short sides
  const m = (a: Vec2, c: Vec2): Vec2 => ({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 });
  let a: Vec2, c: Vec2, short: number;
  if (l01 >= l12) { a = m(p1, p2); c = m(p3, p0); short = l12; } else { a = m(p0, p1); c = m(p2, p3); short = l01; }
  if (b.roof === 'pyramidal' || b.roof === 'conical') return null;
  if (b.roof === 'hip' || b.roof === 'tiled-hip') {
    const L = Math.hypot(c.x - a.x, c.y - a.y), k = Math.min(0.45, (0.5 * short) / (L || 1));
    if (k >= 0.45) return null;
    return [{ x: a.x + (c.x - a.x) * k, y: a.y + (c.y - a.y) * k }, { x: c.x + (a.x - c.x) * k, y: c.y + (a.y - c.y) * k }];
  }
  return [a, c];
}

/** Small round tree crowns as polygons (Canvas batches). */
export function treePolys(pts: Vec2[], r = 2.2): Polygon[] {
  return pts.map((p) => {
    const out: Polygon = [];
    for (let i = 0; i < 8; i++) { const a = (i / 8) * 2 * Math.PI; out.push({ x: p.x + r * Math.cos(a), y: p.y + r * Math.sin(a) }); }
    return out;
  });
}

/** Plots of a given kind of all farms. */
export function farmPlots(fs: Farmstead[], kind: string): Polygon[] {
  const out: Polygon[] = [];
  for (const f of fs) for (const p of f.plots ?? []) if (p.kind === kind) out.push(p.poly);
  return out;
}
