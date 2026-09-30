/**
 * Exact partition primitives: splitting a (labelled) polygon by a chord polyline, ray casting and
 * polyline/boundary crossings. A chord runs from one boundary point to another with all interior points
 * strictly inside; the two resulting rings share the chord vertices bit-for-bit, so splitting never
 * creates gaps or overlaps.
 */
import type { Vec2, Polygon } from '../core/geom';
import { polygonArea, dist } from '../core/geom';
import { segSegT, distToSeg, pointInRing, snapPt } from './poly';

/** Polygon whose edge i (pts[i] → pts[i+1]) carries label lab[i] (street id ≥ 0, or a negative boundary code). */
export interface LPoly { pts: Vec2[]; lab: number[] }

export const lpoly = (pts: Vec2[], label: number): LPoly => ({ pts, lab: pts.map(() => label) });

/** Nearest boundary location of p: edge index, parameter and distance. */
export function locate(pts: Vec2[], p: Vec2): { edge: number; t: number; d: number } {
  let best = { edge: -1, t: 0, d: Infinity };
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const d = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    if (d < best.d) best = { edge: i, t, d };
  }
  return best;
}

/**
 * Inserts boundary point p into the ring (in place on copies) and returns its vertex index.
 * Reuses an existing vertex within `tol`.
 */
function insertBoundaryPoint(lp: LPoly, p: Vec2, tol: number): number {
  const n = lp.pts.length;
  for (let i = 0; i < n; i++) if (dist(lp.pts[i], p) <= tol) return i;
  const loc = locate(lp.pts, p);
  if (loc.edge < 0 || loc.d > Math.max(tol, 0.05)) return -1;
  lp.pts.splice(loc.edge + 1, 0, p);
  lp.lab.splice(loc.edge + 1, 0, lp.lab[loc.edge]);
  return loc.edge + 1;
}

/** Does segment ab cross the ring boundary anywhere except at the listed endpoint proximity? */
export function segCrossesRing(pts: Vec2[], a: Vec2, b: Vec2, eps = 1e-7): boolean {
  const n = pts.length;
  const x0 = Math.min(a.x, b.x) - 1e-6, x1 = Math.max(a.x, b.x) + 1e-6, y0 = Math.min(a.y, b.y) - 1e-6, y1 = Math.max(a.y, b.y) + 1e-6;
  for (let i = 0; i < n; i++) {
    const c = pts[i], d = pts[(i + 1) % n];
    if (Math.max(c.x, d.x) < x0 || Math.min(c.x, d.x) > x1 || Math.max(c.y, d.y) < y0 || Math.min(c.y, d.y) > y1) continue;
    const r = segSegT(a, b, c, d);
    if (r && r.t > eps && r.t < 1 - eps) return true;
  }
  return false;
}

/**
 * Splits `lp` by chord (≥ 2 points; chord[0] and chord[last] on the boundary, the rest strictly inside).
 * Chord edges get `label`. Returns null when the chord is invalid.
 */
export function splitByChord(lp: LPoly, chord: Vec2[], label: number, tol = 0.02): [LPoly, LPoly] | null {
  if (chord.length < 2) return null;
  const w: LPoly = { pts: lp.pts.slice(), lab: lp.lab.slice() };
  const p0 = chord[0], p1 = chord[chord.length - 1];
  let ia = insertBoundaryPoint(w, p0, tol);
  if (ia < 0) return null;
  const ib0 = insertBoundaryPoint(w, p1, tol);
  if (ib0 < 0) return null;
  // the second insertion may have shifted ia
  let ib = ib0;
  if (dist(w.pts[ia], p0) > tol) ia = w.pts.findIndex((q) => dist(q, p0) <= tol);
  if (ia < 0 || ia === ib) return null;
  const n = w.pts.length;
  const inner = chord.slice(1, -1);
  // validate: interior points inside, chord segments do not cross the boundary
  for (const q of inner) if (!pointInRing(w.pts, q)) return null;
  const full = [w.pts[ia], ...inner, w.pts[ib]];
  for (let i = 1; i < full.length; i++) if (segCrossesRing(w.pts, full[i - 1], full[i])) return null;
  if (inner.length === 0) {
    const mid = { x: (full[0].x + full[1].x) / 2, y: (full[0].y + full[1].y) / 2 };
    if (!pointInRing(w.pts, mid)) return null;
    // a chord along an existing edge is not a split
    if (Math.abs(ia - ib) === 1 || Math.abs(ia - ib) === n - 1) return null;
  }
  const A: LPoly = { pts: [], lab: [] }, B: LPoly = { pts: [], lab: [] };
  for (let k = ia; ; k = (k + 1) % n) {
    A.pts.push(w.pts[k]);
    if (k === ib) break;
    A.lab.push(w.lab[k]);
  }
  for (let k = inner.length - 1; k >= 0; k--) { A.lab.push(label); A.pts.push(inner[k]); }
  A.lab.push(label);
  for (let k = ib; ; k = (k + 1) % n) {
    B.pts.push(w.pts[k]);
    if (k === ia) break;
    B.lab.push(w.lab[k]);
  }
  for (let k = 0; k < inner.length; k++) { B.lab.push(label); B.pts.push(inner[k]); }
  B.lab.push(label);
  if (A.pts.length < 3 || B.pts.length < 3) return null;
  if (polygonArea(A.pts) <= 1e-6 || polygonArea(B.pts) <= 1e-6) return null;
  return [A, B];
}

/**
 * Casts a ray from boundary point p (on the ring) in direction u (unit) and returns the first boundary hit
 * beyond `minT` meters, or null.
 */
export function rayHit(pts: Vec2[], p: Vec2, u: Vec2, maxLen = 1e5, minT = 0.05): { p: Vec2; t: number; edge: number } | null {
  const q = { x: p.x + u.x * maxLen, y: p.y + u.y * maxLen };
  let best: { p: Vec2; t: number; edge: number } | null = null;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const c = pts[i], d = pts[(i + 1) % n];
    const r = segSegT(p, q, c, d);
    if (!r) continue;
    const t = r.t * maxLen;
    if (t < minT) continue;
    if (!best || t < best.t) best = { p: { x: p.x + u.x * t, y: p.y + u.y * t }, t, edge: i };
  }
  return best;
}

/** First crossing of the open polyline (from its start) with the ring boundary; returns index of segment & point. */
export function firstCrossing(pts: Vec2[], line: Vec2[]): { seg: number; p: Vec2 } | null {
  for (let s = 1; s < line.length; s++) {
    const a = line[s - 1], b = line[s];
    let bt = Infinity, bp: Vec2 | null = null;
    for (let i = 0; i < pts.length; i++) {
      const r = segSegT(a, b, pts[i], pts[(i + 1) % pts.length]);
      if (r && r.t > 1e-9 && r.t < bt) { bt = r.t; bp = { x: a.x + (b.x - a.x) * r.t, y: a.y + (b.y - a.y) * r.t }; }
    }
    if (bp) return { seg: s, p: bp };
  }
  return null;
}

/**
 * Portions of an open polyline that lie inside the ring (each a chord candidate from boundary to boundary).
 * Pieces starting or ending inside the ring (polyline endpoints inside) are returned with `open` flags.
 */
export function insidePieces(ring: Vec2[], line: Vec2[]): { pts: Vec2[]; startOn: boolean; endOn: boolean }[] {
  const out: { pts: Vec2[]; startOn: boolean; endOn: boolean }[] = [];
  let cur: Vec2[] | null = pointInRing(ring, line[0]) ? [line[0]] : null;
  let curStartOn = false;
  for (let s = 1; s < line.length; s++) {
    const a = line[s - 1], b = line[s];
    const hits: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const r = segSegT(a, b, ring[i], ring[(i + 1) % ring.length]);
      if (r && r.t > 1e-9 && r.t < 1 - 1e-9) hits.push(r.t);
    }
    hits.sort((x, y) => x - y);
    for (const t of hits) {
      const p = snapPt({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      if (cur) { cur.push(p); out.push({ pts: cur, startOn: curStartOn, endOn: true }); cur = null; }
      else { cur = [p]; curStartOn = true; }
    }
    if (cur) cur.push(b);
  }
  if (cur && cur.length >= 2) out.push({ pts: cur, startOn: curStartOn, endOn: false });
  return out;
}

/** Distance from p to the ring boundary and the label of the nearest edge. */
export function nearestLabel(lp: LPoly, p: Vec2): { d: number; label: number; edge: number } {
  let best = { d: Infinity, label: -1, edge: -1 };
  const n = lp.pts.length;
  for (let i = 0; i < n; i++) {
    const d = distToSeg(p, lp.pts[i], lp.pts[(i + 1) % n]);
    if (d < best.d) best = { d, label: lp.lab[i], edge: i };
  }
  return best;
}

/** True when polygon Q lies inside polygon P: every vertex inside or on it (1 cm), no edge properly crossing it. */
export function polyInside(P: Vec2[], Q: Vec2[]): boolean {
  for (const q of Q) if (!pointInRing(P, q) && distToSeg(q, P[0], P[0]) >= 0 && !onRing(P, q, 0.01)) return false;
  for (let i = 0; i < Q.length; i++) {
    const a = Q[i], b = Q[(i + 1) % Q.length];
    if (segCrossesRing(P, a, b, 1e-4)) {
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (!pointInRing(P, m) && !onRing(P, m, 0.01)) return false;
      // a crossing with both halves inside can only touch; test quarter points too
      for (const t of [0.25, 0.75]) { const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; if (!pointInRing(P, q) && !onRing(P, q, 0.01)) return false; }
    }
  }
  return true;
}
function onRing(P: Vec2[], q: Vec2, tol: number): boolean {
  for (let i = 0; i < P.length; i++) if (distToSeg(q, P[i], P[(i + 1) % P.length]) < tol) return true;
  return false;
}

/** Sutherland–Hodgman clip of a CONVEX polygon by the half-plane n·(x − p) ≥ 0. */
export function clipHalfPlaneConvex(poly: Polygon, p: Vec2, n: Vec2): Polygon {
  const out: Vec2[] = [];
  const m = poly.length;
  for (let i = 0; i < m; i++) {
    const a = poly[i], b = poly[(i + 1) % m];
    const da = (a.x - p.x) * n.x + (a.y - p.y) * n.y, db = (b.x - p.x) * n.x + (b.y - p.y) * n.y;
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

export function isConvex(p: Polygon, tolSin = 1e-6): boolean {
  const n = p.length;
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n], c = p[(i + 2) % n];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cr < -tolSin * dist(a, b) * dist(b, c)) return false;
  }
  return true;
}
