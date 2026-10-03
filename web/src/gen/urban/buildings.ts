/**
 * Level 4 — built / unbuilt inside each plot (URBAN_GEOMETRY.md §4). Every footprint is plot ∩ (a convex region
 * defined by half-planes relative to the plot's own frontage and side lines), so buildings never leave their
 * plot nor overlap a neighbour; adjacent buildings share walls exactly.
 *
 * The burgage cycle (URBAN_MORPHOLOGY.md §4b) is driven by a coverage target per plot:
 * - FULL (oldest phase, ≥ 0.84): the plot is built over its whole depth in consecutive ranges (front house, rear
 *   ranges, back buildings), each a separate footprint sharing party walls; about one plot in 4–5 keeps a small
 *   court (≥ 3 × 3 m), placed at a depth shared along the frontage run so that neighbours' courts join.
 * - YARD (≥ 0.66): front house, back building, and a wing of at least half the plot width along one side; the
 *   yard beside it is ≥ 3 m wide (else the wing takes the full width).
 * - GARDEN (≥ 0.45): front house, a rear wing, then the garden.
 * - OPEN (faubourgs): front house, sometimes a shed behind a yard, garden.
 * Front depths vary per plot (jagged rear lines), corner plots get L-houses wrapping the corner, and wide plots
 * in dense zones occasionally hold a large courtyard building (inn, hall, hôtel). No footprint is narrower than
 * 4.5 m or longer than 4× its width (long ranges are split, slivers merged).
 */
import type { Vec2, Polygon } from '../core/geom';
import { dist } from '../core/geom';
import type { Rng } from '../core/rng';
import type { MorphologyParams } from './morphology';
import type { Plot } from './plots';
import { clipHalfPlaneConvex, isConvex, polyInside } from '../geo/split';
import { intersection, intersectionS, difference, differenceS, unionS } from '../geo/bool';
import { area, cleanRing, isSimple, obb, orientPos, bboxOf, segSegT, pointInRing, distToRing } from '../geo/poly';
import { ribbon } from '../geo/offset';
import { stitchUnion } from '../geo/stitch';
import { truncateAcute } from './blocks';
import { burgageHouse } from './houses';

export interface HalfPlane { p: Vec2; n: Vec2 }
export type BldgKind = 'house' | 'rear' | 'back' | 'barn' | 'shed' | 'garden' | 'hall' | 'landmark' | 'church' | 'cathedral' | 'hut';
export interface Bldg { poly: Polygon; kind: BldgKind }

export const BLD_STATS = { on: false, zone: 'core', plot: 0, raw: 0, norm: 0, fin: 0 };

/** Min footprint width and max aspect (no matchsticks). */
export const MIN_BW = 4.5;
export const MAX_ASPECT = 3;

/** plot ∩ ⋂ half-planes (exact Sutherland–Hodgman when the plot is convex, polygon-clipping otherwise). */
export function clipPlot(plot: Polygon, hps: HalfPlane[], convex: boolean): Polygon[] {
  // Sutherland–Hodgman against a convex region is exact and never leaves the subject; for a concave subject it
  // may produce a zero-width bridge when the result is disconnected: detect that and use a boolean instead.
  let cur = plot;
  for (const h of hps) { cur = clipHalfPlaneConvex(cur, h.p, h.n); if (cur.length < 3) return []; }
  // a concave subject may give a simple result that bridges across a concavity: accept it only when it stays inside
  if (convex || (isSimple(cur) && polyInside(plot, cur))) return [cur];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of plot) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); }
  const m = 5;
  let reg: Polygon = [{ x: minX - m, y: minY - m }, { x: maxX + m, y: minY - m }, { x: maxX + m, y: maxY + m }, { x: minX - m, y: maxY + m }];
  for (const h of hps) { reg = clipHalfPlaneConvex(reg, h.p, h.n); if (reg.length < 3) return []; }
  return intersection(plot, reg).map((ph) => ph.outer);
}

const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;

/** True when some edge of either convex polygon separates them (touching allowed within 1 cm). */
function separated(A: Polygon, B: Polygon): boolean {
  for (const [P, Q] of [[A, B], [B, A]] as [Polygon, Polygon][]) {
    const n = P.length;
    for (let i = 0; i < n; i++) {
      const a = P[i], b = P[(i + 1) % n];
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      let all = true;
      for (const q of Q) if (((b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x)) / l > 0.01) { all = false; break; }
      if (all) return true;
    }
  }
  return false;
}

/** Drops pieces that overlap earlier ones (fanned plots narrow with depth, so side wings may collide). */
/**
 * Cheap proof that two simple polygons do not overlap (they may touch): disjoint boxes, or no proper edge crossing
 * and no vertex of either strictly inside the other (≥ 1 cm from its boundary). False means "maybe".
 */
export function clearOf(A: Polygon, B: Polygon): boolean {
  const a = bboxOf(A), b = bboxOf(B);
  if (a.x0 >= b.x1 - 0.01 || b.x0 >= a.x1 - 0.01 || a.y0 >= b.y1 - 0.01 || b.y0 >= a.y1 - 0.01) return true;
  for (let i = 0; i < A.length; i++) {
    const p = A[i], q = A[(i + 1) % A.length];
    for (let j = 0; j < B.length; j++) {
      const r = segSegT(p, q, B[j], B[(j + 1) % B.length]);
      if (r && r.t > 1e-6 && r.t < 1 - 1e-6 && r.u > 1e-6 && r.u < 1 - 1e-6) return false;
    }
  }
  const inQ = (Q: Polygon, v: Vec2) => pointInRing(Q, v) && distToRing(Q, v) > 0.01;
  // vertices, and points along the edges (collinear overlaps put every vertex on the other's boundary)
  const strictlyIn = (P: Polygon, Q: Polygon) => P.some((v, i) => {
    if (inQ(Q, v)) return true;
    const w = P[(i + 1) % P.length];
    for (const t of [0.25, 0.5, 0.75]) if (inQ(Q, { x: v.x + (w.x - v.x) * t, y: v.y + (w.y - v.y) * t })) return true;
    return false;
  });
  if (strictlyIn(A, B) || strictlyIn(B, A)) return false;
  // all vertices on or outside the other, no crossing: overlapping only when one lies on the other (shared ring)
  const cA = { x: A.reduce((s, v) => s + v.x, 0) / A.length, y: A.reduce((s, v) => s + v.y, 0) / A.length };
  return !(pointInRing(B, cA) && distToRing(B, cA) > 0.01 && pointInRing(A, cA));
}

export function dropOverlaps(list: Bldg[]): Bldg[] {
  const kept: Bldg[] = [];
  for (const b of list) {
    let ok = true;
    for (const k of kept) {
      if (clearOf(b.poly, k.poly)) continue;
      if (isConvex(b.poly, 1e-3) && isConvex(k.poly, 1e-3) && separated(b.poly, k.poly)) continue;
      const r = intersectionS(b.poly, k.poly);
      if (r.length && r.reduce((s, ph) => s + area(ph.outer), 0) > 0.02) { ok = false; break; }
    }
    if (ok) kept.push(b);
  }
  return kept;
}

/**
 * Overlapping pieces are trimmed rather than dropped: each later piece loses what earlier pieces already cover
 * (exact difference), and the remainders that are still proper footprints are kept (then checked by dropOverlaps).
 */
export function trimOverlaps(list: Bldg[]): Bldg[] {
  const kept: Bldg[] = [];
  for (const b of list) {
    let pieces: Polygon[] = [b.poly];
    for (const k of kept) {
      const next: Polygon[] = [];
      const kb = bboxOf(k.poly);
      for (const p of pieces) {
        const pb = bboxOf(p);
        if (pb.x0 >= kb.x1 - 0.01 || pb.x1 <= kb.x0 + 0.01 || pb.y0 >= kb.y1 - 0.01 || pb.y1 <= kb.y0 + 0.01) { next.push(p); continue; }
        if (clearOf(p, k.poly) || (isConvex(p, 1e-3) && isConvex(k.poly, 1e-3) && separated(p, k.poly))) { next.push(p); continue; }
        const r = intersectionS(p, k.poly);
        if (!r.length || r.reduce((s2, ph) => s2 + area(ph.outer), 0) <= 0.02) { next.push(p); continue; }
        for (const ph of differenceS(p, k.poly)) if (!ph.holes.length && area(ph.outer) > 1) next.push(cleanRing(ph.outer, 0.005, 0.5, 0.002, false));
      }
      pieces = next.filter((p) => p.length >= 3);
      if (!pieces.length) break;
    }
    for (const p of pieces) if (shapeOK(p)) kept.push({ poly: p, kind: b.kind });
  }
  return dropOverlaps(kept);
}

/** Footprint shape measures: width (short side of the minimum-area OBB) and aspect (long / short). */
export function shapeOf(p: Polygon): { w: number; asp: number; hu: number } {
  const o = obb(p);
  return { w: 2 * o.hv, asp: o.hu / Math.max(1e-6, o.hv), hu: o.hu };
}
const shapeOK = (p: Polygon) => { const s = shapeOf(p); return s.w >= MIN_BW && s.asp <= MAX_ASPECT && area(p) >= MIN_BW * MIN_BW * 0.6; };

/**
 * No matchsticks: pieces longer than MAX_ASPECT × their width are cut across their long axis; pieces thinner
 * than MIN_BW join a neighbouring piece of the same plot when the union is well shaped, else they stay unbuilt.
 */
export function normalizeFootprints(list: Bldg[]): Bldg[] {
  const queue = list.map((b) => ({ b, depth: 0 }));
  const out: Bldg[] = [];
  let guard = 0;
  while (queue.length && guard++ < 200) {
    const { b, depth } = queue.shift()!;
    const s = shapeOf(b.poly);
    // cut long pieces across their long axis (at most twice: an L-shaped piece may keep a long OBB)
    if (s.asp > MAX_ASPECT && s.w >= MIN_BW * 0.8 && depth < 3) {
      const o = obb(b.poly);
      const k = Math.ceil(s.asp / (MAX_ASPECT * 0.85));
      const conv = isConvex(b.poly, 1e-3);
      for (let j = 0; j < k; j++) {
        const s0 = -o.hu + (2 * o.hu * j) / k, s1 = -o.hu + (2 * o.hu * (j + 1)) / k;
        const hps: HalfPlane[] = [];
        if (j > 0) hps.push({ p: { x: o.c.x + o.u.x * s0, y: o.c.y + o.u.y * s0 }, n: o.u });
        if (j < k - 1) hps.push({ p: { x: o.c.x + o.u.x * s1, y: o.c.y + o.u.y * s1 }, n: { x: -o.u.x, y: -o.u.y } });
        for (const r of clipPlot(b.poly, hps, conv)) { const c = cleanRing(r, 0.005, 0.5, 0.002, false); if (c.length >= 3 && area(c) > 1) queue.push({ b: { poly: c, kind: b.kind }, depth: depth + 1 }); }
      }
      continue;
    }
    out.push(b);
  }
  // thin pieces: merge into a neighbour of the same plot
  const res: (Bldg | null)[] = out.slice();
  for (let i = 0; i < res.length; i++) {
    const b = res[i];
    if (!b || shapeOK(b.poly)) continue;
    let merged = false;
    for (let j = 0; j < res.length && !merged; j++) {
      const o = res[j];
      if (!o || j === i) continue;
      const u = stitchUnion(o.poly, b.poly);
      if (!u) continue;
      const su = shapeOf(u);
      if (su.w >= MIN_BW && su.asp <= MAX_ASPECT) { res[j] = { poly: u, kind: o.kind }; res[i] = null; merged = true; }
    }
    if (!merged) res[i] = null;
  }
  return res.filter((b): b is Bldg => !!b && shapeOK(b.poly));
}

/**
 * Courtyard building on a polygon Q: the ring of rooms (depth rd) around an inner court, returned as two simple
 * U-shaped pieces (split along `axis` through the court). Null when the court would be smaller than 3 × 3 m.
 */
export function courtyardRing(Q: Polygon, rd: number, axis: Vec2, opt: { minCourt?: number; memo?: Map<number, Polygon> } = {}): { pieces: Polygon[]; court: Polygon } | null {
  const q = orientPos(Q);
  // (the court depends on Q and rd only: callers trying several axes share it through `memo`)
  let court = opt.memo?.get(rd);
  if (!court) {
    court = courtOf(q, rd);
    opt.memo?.set(rd, court);
  }
  if (court.length < 3 || area(court) < 9 || shapeOf(court).w < 3) return null;
  // (a court smaller than the caller's minimum is a failure for it: the ring is not built)
  if (opt.minCourt !== undefined && !(area(court) >= opt.minCourt)) return null;
  let cx = 0, cy = 0;
  for (const p of court) { cx += p.x; cy += p.y; }
  const c = { x: cx / court.length, y: cy / court.length };
  const m = { x: -axis.y, y: axis.x };
  const pieces: Polygon[] = [];
  for (const nrm of [m, { x: -m.x, y: -m.y }]) {
    const half = clipPlot(q, [{ p: c, n: nrm }], isConvex(q, 1e-3));
    const ch = isConvex(court, 1e-3) ? clipHalfPlaneConvex(court, c, nrm) : (clipPlot(court, [{ p: c, n: nrm }], false)[0] ?? []);
    for (const h of half) {
      // convex lot: the U is built exactly (outer chain of the half, then the court chain backwards)
      const u = ch.length >= 3 && isConvex(q, 1e-3) ? uPiece(h, ch, c, nrm) : null;
      if (u && area(u) > 4 && polyInside(q, u)) { pieces.push(u); continue; }
      const d = ch.length >= 3 ? difference(h, ch) : [{ outer: h, holes: [] }];
      // (a boolean that fell back to coarse snapping may leave cm slivers outside the lot: keep exact pieces only)
      for (const ph of d) if (!ph.holes.length && area(ph.outer) > 4 && polyInside(q, ph.outer)) pieces.push(ph.outer);
    }
  }
  if (!pieces.length) return null;
  return { pieces, court };
}

/** The court of a courtyard ring of room depth rd on the positively oriented lot q ([] when none). */
function courtOf(q: Polygon, rd: number): Polygon {
  if (isConvex(q, 1e-3)) {
    const inset = insetConvexSafe(q, rd);
    return inset.length >= 3 ? inset : [];
  }
  const r = difference(q, ribbon(q.concat([q[0]]), 2 * rd));
  let best: Polygon = [];
  for (const ph of r) if (!ph.holes.length && area(ph.outer) > area(best)) best = ph.outer;
  return best;
}

/**
 * Half of a courtyard ring, exactly: h (a convex half of the lot) minus ch (the court's half), both with an edge on
 * the split line through p (normal n). Null when either has no edge on the line.
 */
function uPiece(h0: Polygon, ch0: Polygon, p: Vec2, n: Vec2): Polygon | null {
  const H = orientPos(h0), C = orientPos(ch0);
  const onL = (v: Vec2) => Math.abs((v.x - p.x) * n.x + (v.y - p.y) * n.y) < 1e-6;
  const hi = H.findIndex((v, i) => onL(v) && onL(H[(i + 1) % H.length]));
  const ci = C.findIndex((v, i) => onL(v) && onL(C[(i + 1) % C.length]));
  if (hi < 0 || ci < 0) return null;
  const out: Vec2[] = [];
  for (let k = 1; k <= H.length; k++) out.push(H[(hi + k) % H.length]); // b … a
  for (let k = 0; k < C.length; k++) out.push(C[(ci - k + C.length) % C.length]); // c0, backwards … c1
  const r = cleanRing(out, 0.005, 0.5, 0.002, false);
  return r.length >= 3 && isSimple(r) ? r : null;
}

/**
 * Convex inset by d: the lot clipped by every edge line shifted inward (exact; short edges that collapse simply
 * drop out); [] when it vanishes.
 */
function insetConvexSafe(p: Polygon, d: number): Polygon {
  const q = orientPos(p);
  const n = q.length;
  let cur: Polygon = q;
  for (let i = 0; i < n && cur.length >= 3; i++) {
    const a = q[i], b = q[(i + 1) % n];
    const l = dist(a, b);
    if (l < 1e-6) continue;
    // inward normal of a positive ring: left of the edge
    const nn = { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
    cur = clipHalfPlaneConvex(cur, { x: a.x + nn.x * d, y: a.y + nn.y * d }, nn);
  }
  return cur.length >= 3 ? cleanRing(cur, 0.05, 0.5, 0.002, false) : [];
}

/**
 * Largest rectangle of a piece in the frontage frame (t along the street, n inward), spanning the piece's depth:
 * the lateral bounds are the innermost of the side edges at the near and far depths. Null when it would be
 * narrower than MIN_BW or not a strict subset worth using.
 */
export function rectify(Q: Polygon, o: Vec2, t: Vec2, n: Vec2): Polygon | null {
  const tc = (p: Vec2) => (p.x - o.x) * t.x + (p.y - o.y) * t.y;
  const nc = (p: Vec2) => (p.x - o.x) * n.x + (p.y - o.y) * n.y;
  let d0 = Infinity, d1 = -Infinity;
  for (const p of Q) { const d = nc(p); d0 = Math.min(d0, d); d1 = Math.max(d1, d); }
  if (d1 - d0 < 2) return null;
  // t-interval of the cross-section at depth d
  const section = (d: number): [number, number] | null => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < Q.length; i++) {
      const a = Q[i], b = Q[(i + 1) % Q.length];
      const da = nc(a) - d, db = nc(b) - d;
      if ((da <= 0 && db >= 0) || (da >= 0 && db <= 0)) {
        const k = da === db ? 0 : da / (da - db);
        const tt = tc(a) + (tc(b) - tc(a)) * k;
        lo = Math.min(lo, tt); hi = Math.max(hi, tt);
      }
    }
    return lo < hi ? [lo, hi] : null;
  };
  const e = Math.min(0.3, (d1 - d0) * 0.05);
  const s0 = section(d0 + e), s1 = section(d1 - e);
  if (!s0 || !s1) return null;
  const u0 = Math.max(s0[0], s1[0]), u1 = Math.min(s0[1], s1[1]);
  if (u1 - u0 < MIN_BW) return null;
  const at = (u: number, d: number): Vec2 => ({ x: o.x + t.x * u + n.x * d, y: o.y + t.y * u + n.y * d });
  const R = orientPos([at(u0, d0), at(u1, d0), at(u1, d1), at(u0, d1)]);
  // keep it inside the piece (exact when the piece is convex)
  const hps: HalfPlane[] = [];
  for (let i = 0; i < R.length; i++) {
    const a = R[i], b = R[(i + 1) % R.length];
    hps.push({ p: a, n: { x: -(b.y - a.y), y: b.x - a.x } });
  }
  const inside = clipPlot(Q, hps, isConvex(Q, 1e-3));
  if (inside.length !== 1 || area(inside[0]) < 0.97 * area(R) || area(inside[0]) > 0.995 * area(Q)) return null;
  return inside[0];
}

/** Court decision shared along a frontage run (neighbouring plots' courts join). */
export interface CourtHint { court: boolean; f: number }

/** Buildings of a plot plus its unbuilt garden (kind 'garden', not a building). */
export function buildPlot(pl: Plot, cov: number, P: MorphologyParams, rng: Rng, hint?: CourtHint): Bldg[] {
  let raw = buildPlotRaw(pl, cov, P, rng, hint);
  // dense zones: an irregular plot whose layout falls far short of the target is built over its whole depth
  if (cov >= 0.66 && pl.zone !== 'village') {
    const built = raw.filter((b) => b.kind !== 'garden').reduce((s, b) => s + area(b.poly), 0);
    if (built < (cov - 0.2) * area(pl.poly)) raw = buildPlotRaw(pl, 0.9, P, rng, { court: false, f: 0.5 });
  }
  const gardens = raw.filter((b) => b.kind === 'garden');
  const rawB = raw.filter((b) => b.kind !== 'garden');
  const norm = normalizeFootprints(rawB);
  const fin = trimOverlaps(norm);
  if (BLD_STATS.on && pl.zone === BLD_STATS.zone) {
    BLD_STATS.plot += area(pl.poly);
    BLD_STATS.raw += rawB.reduce((s2, b) => s2 + area(b.poly), 0);
    BLD_STATS.norm += norm.reduce((s2, b) => s2 + area(b.poly), 0);
    BLD_STATS.fin += fin.reduce((s2, b) => s2 + area(b.poly), 0);
  }
  return fin.concat(gardens);
}

function buildPlotRaw(pl: Plot, cov: number, P: MorphologyParams, rng: Rng, hint?: CourtHint): Bldg[] {
  // town plots: houses.ts; village plots: farmsteads
  if (pl.zone !== 'village') return burgageHouse(pl, cov, P, rng, hint);
  const poly = pl.poly;
  const convex = isConvex(poly, 1e-3);
  const [fa, fb] = pl.front;
  const W = dist(fa, fb);
  if (W < 2.5) return [];
  const t = { x: (fb.x - fa.x) / W, y: (fb.y - fa.y) / W };
  // inward normal: perpendicular to the frontage chord, oriented like the stored normal
  let n = { x: -t.y, y: t.x };
  if (dot(n, pl.nrm) < 0) n = { x: -n.x, y: -n.y };
  let D = 0;
  for (const q of poly) D = Math.max(D, (q.x - fa.x) * n.x + (q.y - fa.y) * n.y);
  if (D < 4) return [];
  const band = (d0: number, d1: number): HalfPlane[] => [
    { p: { x: fa.x + n.x * d0, y: fa.y + n.y * d0 }, n },
    { p: { x: fa.x + n.x * d1, y: fa.y + n.y * d1 }, n: { x: -n.x, y: -n.y } },
  ];
  const zone = pl.zone;
  const out: Bldg[] = [];
  // footprint conformity: 1 = the footprint is the plot geometry within its depth band (trapezoids where plots fan,
  // skewed quads, polygonal corners); 0 = an orthogonal rectangle in the frontage frame, the leftover corner wedges
  // being filled with probability cornerFill
  const conform = P.footprintConformity?.[zone] ?? 1;
  const cornerFill = P.cornerFill?.[zone] ?? 1;
  const add = (hps: HalfPlane[], kind: Bldg['kind'], min = 10) => {
    for (let r of clipPlot(poly, hps, convex)) {
      if (!rng.chance(conform)) {
        const rect = rectify(r, fa, t, n);
        if (rect && !rng.chance(cornerFill)) r = rect;
      }
      let c = cleanRing(r, 0.005, 0.5, 0.002, false);
      if (c.length < 3) continue;
      c = truncateAcute(c, (20 * Math.PI) / 180, 2);
      if (c.length < 3 || area(c) < min) continue;
      out.push({ poly: c, kind });
    }
  };
  const addGarden = (from: number) => {
    if (D - from < 3) return;
    for (const r of clipPlot(poly, band(from, D + 1), convex)) if (area(r) > 20) out.push({ poly: r, kind: 'garden' });
  };
  const [sb0, sb1] = P.setback[zone];
  const [bd0, bd1] = P.buildDepth[zone];
  farmstead(pl, poly, convex, fa, t, n, W, D, band, add, addGarden, rng);
  return out;
}

/**
 * Farmstead around a yard (Hakenhof / Dreiseithof): house along the street, barn along one side from the street
 * backwards (an L), and on larger farms a shed closing the back of the yard (a U).
 */
function farmstead(
  pl: Plot, poly: Polygon, convex: boolean, fa: Vec2, t: Vec2, n: Vec2, W: number, D: number,
  band: (d0: number, d1: number) => HalfPlane[], add: (h: HalfPlane[], k: Bldg['kind'], min?: number) => void,
  addGarden: (from: number) => void, rng: Rng,
): Bldg[] {
  void pl; void poly; void convex; void n;
  const out: Bldg[] = [];
  const sb = rng.range(1, 4);
  const lat = (u0: number, u1: number): HalfPlane[] => [
    { p: { x: fa.x + t.x * u0, y: fa.y + t.y * u0 }, n: t },
    { p: { x: fa.x + t.x * u1, y: fa.y + t.y * u1 }, n: { x: -t.x, y: -t.y } },
  ];
  void out;
  const g = rng.range(1, 2.5);
  const bw = Math.max(MIN_BW + 0.5, Math.min(rng.range(8, 11), W * 0.35));
  const hd = rng.range(7.5, 10);
  const barnLeft = rng.chance(0.5);
  const houseW = Math.min(rng.range(12, 17), W - bw - 2 * g - 3);
  const yardD = Math.min(D - sb - 6, rng.range(18, 28));
  if (houseW < 6 || yardD < 10) {
    add([...band(sb, sb + hd), ...lat(g, Math.min(W - g, g + rng.range(9, 14)))], 'house');
    addGarden(sb + hd + rng.range(1.5, 4));
    return [];
  }
  const bx0 = barnLeft ? g : W - g - bw;
  const hx0 = barnLeft ? g + bw + 1.5 : W - g - bw - 1.5 - houseW;
  add([...band(sb, sb + hd), ...lat(hx0, hx0 + houseW)], 'house');
  add([...band(sb, sb + Math.min(yardD, bw * MAX_ASPECT * 0.95)), ...lat(bx0, bx0 + bw)], 'barn');
  let far = sb + yardD;
  if (W > 24 && rng.chance(0.55)) {
    const s0 = sb + yardD - rng.range(6, 8);
    add([...band(s0, sb + yardD), ...lat(barnLeft ? bx0 + bw + 1 : hx0, barnLeft ? hx0 + houseW : bx0 - 1)], 'shed');
    far = sb + yardD;
  }
  addGarden(far + rng.range(1.5, 4));
  return [];
}

export { unionS };
