/**
 * Landmark placeholders: the market (reserved at level 1) and the parish church (or cathedral) on a block next to
 * the market, claimed before plots are cut (URBAN_GEOMETRY.md §2.3 / §3.4). The church is oriented east–west
 * (choir to the east) and fitted inside its lot, which becomes the churchyard.
 */
import type { Vec2, Polygon } from '../core/geom';
import { dist, polygonCentroid } from '../core/geom';
import type { Rng } from '../core/rng';
import type { Streets } from './streets';
import { area, inscribed, pointInRing, distToRing, orientPos, obb } from '../geo/poly';
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
/**
 * Orientation of a church on its lot: the choir points east; within ±20° the axis follows the lot's long side
 * (churches adapt to their site, never randomly).
 */
export function churchAxis(lot: Polygon): number {
  const o = obb(lot);
  let a = Math.atan2(o.u.y, o.u.x);
  // the lot direction closest to east (mod 90°: a square-ish lot may lie either way)
  while (a > Math.PI / 4) a -= Math.PI / 2;
  while (a < -Math.PI / 4) a += Math.PI / 2;
  return Math.max(-0.35, Math.min(0.35, a));
}

export function churchFootprint(lot: Polygon, pop: number, rng: Rng, main = true): { parts: Polygon[]; kind: 'church' | 'cathedral' } | null {
  const cathedral = main && pop > 15000;
  let L = cathedral ? rng.range(80, 110) : pop > 3000 && main ? rng.range(38, 55) : rng.range(24, 38);
  const ins = inscribed(lot, [], 0.5);
  const c = ins.c;
  const ax = churchAxis(lot), ca = Math.cos(ax), sa = Math.sin(ax);
  const T = (x: number, y: number) => ({ x: c.x + x * ca - y * sa, y: c.y + x * sa + y * ca });
  const inside = (pts: Polygon, margin: number) => pts.every((p) => pointInRing(lot, p) && distToRing(lot, p) >= margin);
  for (let it = 0; it < 14; it++) {
    const W = L * (cathedral ? 0.3 : 0.32);
    const rect = (x0: number, x1: number, h: number): Polygon => orientPos([T(x0, -h / 2), T(x1, -h / 2), T(x1, h / 2), T(x0, h / 2)]);
    // local x points east (±20°): nave centered, choir east, tower (west front) west
    const nave = rect(-L * 0.42, L * 0.2, W);
    const choir = rect(L * 0.2, L * 0.42, W * 0.68);
    const apse: Polygon = orientPos(Array.from({ length: 7 }, (_, k) => {
      const a = -Math.PI / 2 + (k / 6) * Math.PI;
      return T(L * 0.42 + Math.cos(a) * W * 0.34, Math.sin(a) * W * 0.34);
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
