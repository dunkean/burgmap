/**
 * Landmark placeholders: the market (reserved at level 1) and the parish church (or cathedral) on a block next to
 * the market, claimed before plots are cut (URBAN_GEOMETRY.md §2.3 / §3.4). The church is oriented east–west
 * (choir to the east) and fitted inside its lot, which becomes the churchyard.
 */
import type { Vec2, Polygon } from '../core/geom';
import { dist, polygonCentroid } from '../core/geom';
import type { Rng } from '../core/rng';
import type { Streets } from './streets';
import { area, inscribed, pointInRing, distToRing, orientPos } from '../geo/poly';
import { unionS, MultiPoly } from '../geo/bool';

export interface ChurchPick { block: number; footprint: Polygon[]; kind: 'church' | 'cathedral' }

/** Picks the block for the church: adjacent to the market street, of a suitable size, close to the nucleus. */
export function pickChurchBlock(
  blocks: { poly: Polygon; kind: string }[], marketStreet: number, streets: Streets, nucleus: Vec2, pop: number,
): number {
  const [amin, amax] = pop > 15000 ? [2500, 12000] : pop > 3000 ? [1200, 7000] : [700, 5000];
  let best = -1, bs = -Infinity;
  blocks.forEach((b, i) => {
    if (b.kind !== 'block') return;
    const a = area(b.poly);
    if (a < amin * 0.7 || a > amax * 1.6) return;
    // does the block front the market?
    let front = 0;
    for (let k = 0; k < b.poly.length; k++) {
      const p = b.poly[k], q = b.poly[(k + 1) % b.poly.length];
      const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      const ns = streets.nearest(m, 8);
      if (ns && marketStreet >= 0 && ns.s === marketStreet) front += dist(p, q);
    }
    const d = dist(polygonCentroid(b.poly), nucleus);
    if (front <= 8 && d > 400) return;
    const fit = a >= amin && a <= amax ? 1 : 0.4;
    const s = (front > 8 ? 2 : 0) + fit - d / 250 + Math.min(1, inscribed(b.poly, [], 2).r / 25);
    if (s > bs) { bs = s; best = i; }
  });
  return best;
}

/** East-oriented church footprint (nave + choir + west tower) scaled to fit inside the lot with a margin. */
export function churchFootprint(lot: Polygon, pop: number, rng: Rng): { parts: Polygon[]; kind: 'church' | 'cathedral' } | null {
  const cathedral = pop > 15000;
  let L = cathedral ? rng.range(80, 110) : pop > 3000 ? rng.range(38, 55) : rng.range(22, 34);
  const ins = inscribed(lot, [], 0.5);
  const c = ins.c;
  const inside = (pts: Polygon, margin: number) => pts.every((p) => pointInRing(lot, p) && distToRing(lot, p) >= margin);
  for (let it = 0; it < 14; it++) {
    const W = L * (cathedral ? 0.3 : 0.32);
    const rect = (x0: number, x1: number, h: number): Polygon => orientPos([{ x: c.x + x0, y: c.y - h / 2 }, { x: c.x + x1, y: c.y - h / 2 }, { x: c.x + x1, y: c.y + h / 2 }, { x: c.x + x0, y: c.y + h / 2 }]);
    // x grows to the east (map right); nave centered, choir east, tower west
    const nave = rect(-L * 0.42, L * 0.2, W);
    const choir = rect(L * 0.2, L * 0.42, W * 0.68);
    const apse: Polygon = orientPos(Array.from({ length: 7 }, (_, k) => {
      const a = -Math.PI / 2 + (k / 6) * Math.PI;
      return { x: c.x + L * 0.42 + Math.cos(a) * W * 0.34, y: c.y + Math.sin(a) * W * 0.34 };
    }));
    const tower = rect(-L * 0.5, -L * 0.42, W * 0.62);
    const parts = [nave, choir, tower];
    const all = parts.flat().concat(apse);
    if (inside(all, 3)) {
      const transept = cathedral ? [rect(-L * 0.02, L * 0.12, W * 1.9)] : [];
      if (transept.length && !inside(transept[0], 3)) transept.length = 0;
      const ps = [...parts, apse, ...transept].map((p): MultiPoly => [{ outer: p, holes: [] }]);
      const u = unionS(ps[0], ...ps.slice(1));
      return { parts: u.map((ph) => ph.outer), kind: cathedral ? 'cathedral' : 'church' };
    }
    L *= 0.88;
    if (L < 14) break;
  }
  return null;
}
