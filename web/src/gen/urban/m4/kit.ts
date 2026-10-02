/**
 * Building kit of the M4 landmark plans: exact partition helpers (half-plane splits, hole-free pieces), footprints
 * fitted inside a parcel (rectangles along an edge, at a point, scaled to fit) and the output record of a builder.
 * Every footprint is tested against its parcel, so a landmark plan can never leave its lot.
 */
import type { Vec2, Polygon } from '../../core/geom';
import { dist, polygonCentroid } from '../../core/geom';
import { area, pointInRing, distToRing, orientPos, inscribed, obb, cleanRing } from '../../geo/poly';
import { intersectionS, differenceS, MultiPoly } from '../../geo/bool';
import { polyInside } from '../../geo/split';
import { openHoles } from '../plots';
import { rectAt } from './lots';
import type { CompoundOut } from '../compounds';

export type Out = CompoundOut;
export const emptyOut = (): Out => ({ parcels: [], buildings: [], lines: [], water: [], landmarks: [] });

/** Hole-free, non-degenerate pieces of a boolean result (holes are opened by a cut). */
export function pieces(m: MultiPoly, minA = 2): Polygon[] {
  const out: Polygon[] = [];
  for (const ph of m) for (const q of ph.holes.length ? openHoles(ph) : [ph]) {
    if (q.holes.length) continue;
    const r = cleanRing(q.outer, 0.05, 0.5, Infinity, false);
    if (r.length >= 3 && area(r) > minA) out.push(r);
  }
  return out;
}

/** Large rectangle covering the half-plane n·(x − p) ≥ 0 (within `R` m). */
export function halfRect(p: Vec2, n: Vec2, R = 3000): Polygon {
  const t = { x: -n.y, y: n.x };
  return orientPos([
    { x: p.x - t.x * R, y: p.y - t.y * R }, { x: p.x + t.x * R, y: p.y + t.y * R },
    { x: p.x + t.x * R + n.x * R, y: p.y + t.y * R + n.y * R }, { x: p.x - t.x * R + n.x * R, y: p.y - t.y * R + n.y * R },
  ]);
}

/** Splits a polygon by the line through p with normal n: [side n·(x−p) ≥ 0, other side]. */
export function splitLine(poly: Polygon, p: Vec2, n: Vec2): [Polygon[], Polygon[]] {
  const a = pieces(intersectionS(poly, halfRect(p, n)));
  const b = pieces(intersectionS(poly, halfRect(p, { x: -n.x, y: -n.y })));
  return [a, b];
}

export const largest = (ps: Polygon[]): Polygon | null => ps.reduce<Polygon | null>((b, p) => (!b || area(p) > area(b) ? p : b), null);

/** All points inside the parcel at ≥ margin from its boundary. */
export const fits = (parcel: Polygon, poly: Polygon, margin: number): boolean => poly.every((q) => pointInRing(parcel, q) && distToRing(parcel, q) >= margin) && polyInside(parcel, poly);

/**
 * Rectangle of depth `d` along edge i of the parcel (inside it), centred on the edge at `t` with length `len`,
 * shrunk until it fits with `margin`. Returns null if it cannot fit at half size.
 */
export function alongEdge(parcel: Polygon, i: number, d: number, len: number, margin: number, t = 0.5): Polygon | null {
  const P = orientPos(parcel);
  const a = P[i % P.length], b = P[(i + 1) % P.length];
  const L = dist(a, b);
  if (L < 4) return null;
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const m = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  // inward normal of a CCW ring is the left normal
  for (let k = 1; k >= 0.5; k -= 0.1) {
    const l = Math.min(len, L - 2 * margin) * k, dd = d * Math.min(1, k + 0.2);
    if (l < 4) break;
    const r = rectAt(m, ang, -l / 2, l / 2, margin, margin + dd);
    if (fits(parcel, r, margin * 0.5)) return r;
  }
  return null;
}

/** Index of the longest edge of a polygon satisfying `ok` (edge i = P[i] → P[i+1] of the CCW ring). */
export function longestEdge(poly: Polygon, ok: (a: Vec2, b: Vec2) => boolean = () => true): number {
  const P = orientPos(poly);
  let bi = -1, bl = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    const l = dist(a, b);
    if (l > bl && ok(a, b)) { bl = l; bi = i; }
  }
  return bi;
}

/** Rectangle of size (2hu × 2hv) at angle `ang`, placed at c or pulled toward the parcel's inscribed centre until it fits. */
export function placeRect(parcel: Polygon, c: Vec2, ang: number, hu: number, hv: number, margin: number): Polygon | null {
  const ins = inscribed(parcel, [], 1).c;
  for (let s = 1; s >= 0.55; s -= 0.15) for (let k = 0; k <= 1.0001; k += 0.2) {
    const p = { x: c.x + (ins.x - c.x) * k, y: c.y + (ins.y - c.y) * k };
    const r = rectAt(p, ang, -hu * s, hu * s, -hv * s, hv * s);
    if (fits(parcel, r, margin)) return r;
  }
  return null;
}

/** Main axis angle of a polygon (its OBB long side). */
export const axisOf = (p: Polygon): number => { const o = obb(p); return Math.atan2(o.u.y, o.u.x); };

/** Difference keeping hole-free pieces. */
export const minus = (a: Polygon, ...b: Polygon[]): Polygon[] => pieces(differenceS(a, ...b.map((q): MultiPoly => [{ outer: q, holes: [] }])));
export const inter = (a: Polygon, b: Polygon): Polygon[] => pieces(intersectionS(a, b));

export { polygonCentroid, inscribed, area, dist };
