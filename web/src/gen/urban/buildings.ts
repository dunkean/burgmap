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
import { clipHalfPlaneConvex, isConvex } from '../geo/split';
import { intersection, intersectionS, difference, unionS } from '../geo/bool';
import { area, cleanRing, isSimple, obb, orientPos } from '../geo/poly';
import { ribbon } from '../geo/offset';
import { stitchUnion } from '../geo/stitch';
import { truncateAcute } from './blocks';

export interface HalfPlane { p: Vec2; n: Vec2 }
export type BldgKind = 'house' | 'rear' | 'back' | 'barn' | 'shed' | 'garden' | 'hall' | 'landmark' | 'church' | 'cathedral';
export interface Bldg { poly: Polygon; kind: BldgKind }

/** Min footprint width and max aspect (no matchsticks). */
export const MIN_BW = 4.5;
export const MAX_ASPECT = 4;

/** plot ∩ ⋂ half-planes (exact Sutherland–Hodgman when the plot is convex, polygon-clipping otherwise). */
export function clipPlot(plot: Polygon, hps: HalfPlane[], convex: boolean): Polygon[] {
  // Sutherland–Hodgman against a convex region is exact and never leaves the subject; for a concave subject it
  // may produce a zero-width bridge when the result is disconnected: detect that and use a boolean instead.
  let cur = plot;
  for (const h of hps) { cur = clipHalfPlaneConvex(cur, h.p, h.n); if (cur.length < 3) return []; }
  if (convex || isSimple(cur)) return [cur];
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
function dropOverlaps(list: Bldg[]): Bldg[] {
  const kept: Bldg[] = [];
  for (const b of list) {
    let ok = true;
    for (const k of kept) {
      if (isConvex(b.poly, 1e-3) && isConvex(k.poly, 1e-3) && separated(b.poly, k.poly)) continue;
      const r = intersectionS(b.poly, k.poly);
      if (r.length && r.reduce((s, ph) => s + area(ph.outer), 0) > 0.02) { ok = false; break; }
    }
    if (ok) kept.push(b);
  }
  return kept;
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
    if (s.asp > MAX_ASPECT && s.w >= MIN_BW * 0.8 && depth < 2) {
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
export function courtyardRing(Q: Polygon, rd: number, axis: Vec2): { pieces: Polygon[]; court: Polygon } | null {
  const q = orientPos(Q);
  let court: Polygon = [];
  if (isConvex(q, 1e-3)) {
    const inset = insetConvexSafe(q, rd);
    if (inset.length >= 3) court = inset;
  } else {
    const r = difference(q, ribbon(q.concat([q[0]]), 2 * rd));
    let best: Polygon = [];
    for (const ph of r) if (!ph.holes.length && area(ph.outer) > area(best)) best = ph.outer;
    court = best;
  }
  if (court.length < 3 || area(court) < 9 || shapeOf(court).w < 3) return null;
  let cx = 0, cy = 0;
  for (const p of court) { cx += p.x; cy += p.y; }
  const c = { x: cx / court.length, y: cy / court.length };
  const m = { x: -axis.y, y: axis.x };
  const pieces: Polygon[] = [];
  for (const nrm of [m, { x: -m.x, y: -m.y }]) {
    const half = clipPlot(q, [{ p: c, n: nrm }], isConvex(q, 1e-3));
    const ch = clipHalfPlaneConvex(court, c, nrm);
    for (const h of half) {
      const d = ch.length >= 3 ? difference(h, ch) : [{ outer: h, holes: [] }];
      for (const ph of d) if (!ph.holes.length && area(ph.outer) > 4) pieces.push(ph.outer);
    }
  }
  if (!pieces.length) return null;
  return { pieces, court };
}

/** Convex inset by d (edge lines shifted inward); [] when it collapses. */
function insetConvexSafe(p: Polygon, d: number): Polygon {
  const n = p.length;
  const lines: { px: number; py: number; dx: number; dy: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    const l = dist(a, b) || 1;
    const dx = (b.x - a.x) / l, dy = (b.y - a.y) / l;
    lines.push({ px: a.x - dy * d, py: a.y + dx * d, dx, dy });
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const A = lines[(i - 1 + n) % n], B = lines[i];
    const den = A.dx * B.dy - A.dy * B.dx;
    if (Math.abs(den) < 1e-9) { out.push({ x: B.px, y: B.py }); continue; }
    const t = ((B.px - A.px) * B.dy - (B.py - A.py) * B.dx) / den;
    out.push({ x: A.px + A.dx * t, y: A.py + A.dy * t });
  }
  for (let i = 0; i < n; i++) {
    const a = out[i], b = out[(i + 1) % n];
    if ((b.x - a.x) * lines[i].dx + (b.y - a.y) * lines[i].dy <= 0.05) return [];
  }
  return cleanRing(out, 0.05, 0.5, 0.002, false);
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
  const raw = buildPlotRaw(pl, cov, P, rng, hint);
  const gardens = raw.filter((b) => b.kind === 'garden');
  return dropOverlaps(normalizeFootprints(raw.filter((b) => b.kind !== 'garden'))).concat(gardens);
}

function buildPlotRaw(pl: Plot, cov: number, P: MorphologyParams, rng: Rng, hint?: CourtHint): Bldg[] {
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
  // side-line normals pointing into the plot
  const sideN = (s: { p: Vec2; d: Vec2 }, towards: Vec2): HalfPlane => {
    let m = { x: -s.d.y, y: s.d.x };
    if (dot(m, towards) < 0) m = { x: -m.x, y: -m.y };
    return { p: s.p, n: m };
  };
  const hA = sideN(pl.sideA, t), hB = sideN(pl.sideB, { x: -t.x, y: -t.y });
  const shift = (h: HalfPlane, g: number): HalfPlane => ({ p: { x: h.p.x + h.n.x * g, y: h.p.y + h.n.y * g }, n: h.n });
  const flip = (h: HalfPlane): HalfPlane => ({ p: h.p, n: { x: -h.n.x, y: -h.n.y } });
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
  if (zone === 'village') { farmstead(pl, poly, convex, fa, t, n, W, D, band, add, addGarden, rng); return out; }
  const sb = rng.range(sb0, sb1);
  // front depth varies plot by plot: the rear line of the street front is jagged
  const hd = Math.min(D - sb, rng.range(bd0, bd1) * (pl.wide ? 1.15 : 1) * rng.range(0.85, 1.15));
  const A = area(poly);
  const sides = [hA, hB];
  const s0 = rng.chance(0.5) ? 0 : 1;
  const wingOn = (k: number, ww: number): HalfPlane[] => [sides[k], flip(shift(sides[k], ww))];
  // wing width: at least half the plot, or the full width when the yard beside it would be < 3 m
  const wingW = (want: number) => { const ww = Math.max(MIN_BW, want, W / 2); return W - ww < 3 ? W : ww; };
  // corner plots: the front house wraps the corner (an L along the side street)
  const cornerRanges = () => {
    for (const [a, b] of pl.sideFronts) {
      const l = dist(a, b);
      const u = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
      let m = { x: -u.y, y: u.x };
      let cx = 0, cy = 0;
      for (const q of poly) { cx += q.x; cy += q.y; }
      cx /= poly.length; cy /= poly.length;
      if ((cx - a.x) * m.x + (cy - a.y) * m.y < 0) m = { x: -m.x, y: -m.y };
      const d2 = Math.max(MIN_BW + 1, Math.min(hd, rng.range(bd0, bd1)));
      const before = out.length;
      add([{ p: a, n: m }, { p: { x: a.x + m.x * d2, y: a.y + m.y * d2 }, n: { x: -m.x, y: -m.y } }, ...band(sb + hd, D + 1)], 'house');
      // join it to the front house: one L-shaped footprint
      if (out.length > before && out[0]?.kind === 'house') {
        const u2 = stitchUnion(out[0].poly, out[before].poly);
        if (u2) { out[0] = { poly: u2, kind: 'house' }; out.splice(before, 1); }
      }
    }
  };

  // large courtyard building on wide plots of dense zones (inn, hall, hôtel)
  if (cov >= 0.66 && W >= 11 && D >= 20 && A > 320 && rng.chance(P.bigCourtChance ?? 0.3)) {
    const Lc = Math.min(D - sb, rng.range(18, 26));
    const Q = clipPlot(poly, band(sb, sb + Lc), convex);
    const ring = Q.length === 1 ? courtyardRing(Q[0], rng.range(4.5, 6), n) : null;
    if (ring) {
      for (const pc of ring.pieces) out.push({ poly: pc, kind: 'hall' });
      const rest = D - sb - Lc;
      if (rest >= MIN_BW) {
        if (cov >= 0.84) add(band(sb + Lc, D + 1), 'back');
        else if (rest > 9) { add(band(sb + Lc + 3, sb + Lc + 3 + Math.min(rest - 3, rng.range(6, 9))), 'back'); addGarden(sb + Lc + 3 + rng.range(6, 9) + 1); }
      }
      return out;
    }
  }

  if (cov >= 0.84) {
    // FULL: consecutive ranges over the whole depth
    const cuts = [sb, sb + hd];
    let d = sb + hd + rng.range(8, 13);
    while (d < D - 6) { cuts.push(d); d += rng.range(8, 13); }
    cuts.push(D + 1);
    let courtAt = -1, courtD = 0;
    if (hint?.court && cuts.length >= 3) {
      const target = sb + hd + (D - sb - hd) * hint.f;
      let bk = 1, bdv = Infinity;
      for (let k = 1; k < cuts.length - 1; k++) { const dv = Math.abs(cuts[k] - target); if (dv < bdv) { bdv = dv; bk = k; } }
      const segL = Math.min(cuts[bk + 1], D) - cuts[bk];
      courtD = Math.min(rng.range(3.2, 5), segL);
      if (segL - courtD < MIN_BW) courtD = segL;
      if (courtD >= 3) courtAt = bk;
    }
    for (let k = 0; k + 1 < cuts.length; k++) {
      const kind = k === 0 ? 'house' : k === cuts.length - 2 ? 'back' : 'rear';
      if (k !== courtAt) { add(band(cuts[k], cuts[k + 1]), kind); continue; }
      const c1 = cuts[k] + courtD;
      if (W >= 9) {
        // partial court against one side; the other side of the band stays built (a wing ≥ half the width)
        const ww = wingW(W - Math.max(3.2, W * 0.45));
        if (ww < W) add([...band(cuts[k], c1), ...wingOn(1 - s0, ww)], 'rear');
      }
      if (cuts[k + 1] - c1 >= 1) add(band(c1, cuts[k + 1]), kind);
    }
    cornerRanges();
    return out;
  }
  add([...band(sb, sb + hd), ...(cov < 0.45 && zone === 'faubourg' && rng.chance(0.35) ? [shift(sides[s0], rng.range(1.5, 2.5))] : [])], 'house');
  cornerRanges();
  const rest = D - sb - hd;
  if (rest < 3) return out;
  const frontA = Math.min(A, W * hd);
  if (cov >= 0.66) {
    // YARD: back building + a wing, the yard beside the wing ≥ 3 m wide
    if (rest < MIN_BW + 3) { add(band(sb + hd, D + 1), 'rear'); return out; }
    let rd = rest >= MIN_BW + 3 + MIN_BW ? Math.min(rest - 3 - MIN_BW, rng.range(6, 10)) : 0;
    if (rd < MIN_BW) rd = 0;
    const m0 = sb + hd, m1 = D - rd;
    if (rd > 0) add(band(m1, D + 1), 'back');
    const Lm = m1 - m0;
    const unbuilt = Math.max(9, (1 - cov) * A);
    const yardW = unbuilt / Math.max(1, Lm);
    if (yardW >= 3 && W - yardW >= MIN_BW) add([...band(m0, m1), ...wingOn(s0, W - yardW)], 'rear');
    else {
      // yard across the plot: built part next to the front house, then the yard (≥ 3 m deep)
      const yl = Math.max(3, Math.min(Lm, unbuilt / W));
      if (Lm - yl >= MIN_BW) add(band(m0, m1 - yl), 'rear');
    }
    return out;
  }
  if (cov >= 0.45) {
    // GARDEN: rear wing, then the garden
    const need = cov * A - frontA;
    const ww = wingW(W * rng.range(0.5, 0.65));
    const lw = Math.min(rest - 3, need / ww);
    let end = sb + hd;
    if (lw >= MIN_BW) { add([...band(sb + hd, sb + hd + lw), ...(ww < W ? wingOn(s0, ww) : [])], 'rear'); end = sb + hd + lw; }
    addGarden(end + (ww < W ? 0 : 0.01));
    return out;
  }
  // OPEN: sometimes a shed behind a yard, then the garden
  const need = cov * A - frontA;
  let end = sb + hd;
  if (need > 25 && rest > 3 + MIN_BW + 3) {
    const y = rng.range(3, 6), sd = Math.min(rest - y - 3, rng.range(MIN_BW, 7));
    const ww = wingW(Math.min(W, need / sd));
    if (sd >= MIN_BW) { add([...band(sb + hd + y, sb + hd + y + sd), ...(ww < W ? wingOn(s0, ww) : [])], 'shed'); end = sb + hd + y + sd; }
  }
  addGarden(end + 1);
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
