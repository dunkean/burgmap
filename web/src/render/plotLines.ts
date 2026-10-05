/** Cadastre keeps real lot divisions, but an administrative settlement edge has no ink of its own. */
import type { UrbanLayer, PolyH, Polyline, Vec2 } from '../gen/types';
import { bboxOf } from '../gen/geo/poly';

export function plotLines(u: UrbanLayer, boundary = u.footprintH.length ? u.footprintH : u.footprint.map((outer) => ({ outer, holes: [] }))): Polyline[] {
  if (u.renderHints?.plotLines === false) return [];
  const edges = boundary.flatMap((p: PolyH) => [p.outer, ...p.holes]).flatMap((ring) => ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length]; return { a, b, box: bboxOf([a, b]) };
  }));
  const out: Polyline[] = [], epsilon = 1e-7;
  const cells = new Map<string, typeof edges>(), cell = 128;
  for (const edge of edges) {
    const b = edge.box;
    if (![b.x0, b.y0, b.x1, b.y1].every(Number.isFinite)) continue;
    for (let y = Math.floor(b.y0 / cell); y <= Math.floor(b.y1 / cell); y++) for (let x = Math.floor(b.x0 / cell); x <= Math.floor(b.x1 / cell); x++) {
      const key = `${x},${y}`, list = cells.get(key) ?? []; list.push(edge); cells.set(key, list);
    }
  }
  for (const parcel of u.parcels) if (parcel.use === 'plot') {
    for (let i = 0; i < parcel.poly.length; i++) {
      const a = parcel.poly[i], b = parcel.poly[(i + 1) % parcel.poly.length], dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy), len2 = len * len;
      if (len <= epsilon) continue;
      const box = bboxOf([a, b]), cut: [number, number][] = [];
      if (![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)) continue;
      const near = new Set<typeof edges[number]>();
      for (let y = Math.floor((box.y0 - epsilon) / cell); y <= Math.floor((box.y1 + epsilon) / cell); y++) {
        for (let x = Math.floor((box.x0 - epsilon) / cell); x <= Math.floor((box.x1 + epsilon) / cell); x++) {
          for (const edge of cells.get(`${x},${y}`) ?? []) near.add(edge);
        }
      }
      const projection = (p: Vec2): number => ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
      for (const edge of near) {
        if (box.x0 > edge.box.x1 + epsilon || box.x1 < edge.box.x0 - epsilon || box.y0 > edge.box.y1 + epsilon || box.y1 < edge.box.y0 - epsilon) continue;
        if ([edge.a, edge.b].some((p) => Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) > epsilon * len)) continue;
        const t0 = projection(edge.a), t1 = projection(edge.b), lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(1, Math.max(t0, t1));
        if (hi > lo) cut.push([lo, hi]);
      }
      const at = (t: number): Vec2 => ({ x: a.x + t * dx, y: a.y + t * dy });
      let start = 0;
      for (const [lo, hi] of cut.sort((x, y) => x[0] - y[0])) {
        if (lo > start + epsilon / len) out.push([at(start), at(lo)]);
        start = Math.max(start, hi);
      }
      if (start < 1 - epsilon / len) out.push([at(start), b]);
    }
  }
  return out;
}
