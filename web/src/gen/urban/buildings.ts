/**
 * Level 4 — built / unbuilt inside each plot (URBAN_GEOMETRY.md §4). Every footprint is plot ∩ (a convex region
 * defined by half-planes relative to the plot's own frontage and side lines), so buildings never leave their
 * plot nor overlap a neighbour; adjacent buildings share walls exactly.
 */
import type { Vec2, Polygon } from '../core/geom';
import { dist } from '../core/geom';
import type { Rng } from '../core/rng';
import type { MorphologyParams } from './morphology';
import type { Plot } from './plots';
import { clipHalfPlaneConvex, isConvex } from '../geo/split';
import { intersection } from '../geo/bool';
import { area, inscribed, cleanRing, isSimple, convexWidth } from '../geo/poly';
import { truncateAcute } from './blocks';

export interface HalfPlane { p: Vec2; n: Vec2 }
export interface Bldg { poly: Polygon; kind: 'house' | 'rear' | 'back' | 'barn' | 'shed' | 'garden' }

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
      // positive orientation: inside is to the left; Q is separated if all its vertices are right of (or on) the edge
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
      const r = intersection(b.poly, k.poly);
      if (r.length && r.reduce((s, ph) => s + area(ph.outer), 0) > 0.02) { ok = false; break; }
    }
    if (ok) kept.push(b);
  }
  return kept;
}

/** Buildings of a plot plus its rear garden (kind 'garden', not a building). */
export function buildPlot(pl: Plot, infill: number, P: MorphologyParams, rng: Rng): Bldg[] {
  const raw = buildPlotRaw(pl, infill, P, rng);
  const gardens = raw.filter((b) => b.kind === 'garden');
  return dropOverlaps(raw.filter((b) => b.kind !== 'garden')).concat(gardens);
}

function buildPlotRaw(pl: Plot, infill: number, P: MorphologyParams, rng: Rng): Bldg[] {
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
  const addGarden = () => {
    if (infill > 0.7 && zone !== 'faubourg') return;
    let far = 0;
    for (const b of out) for (const q of b.poly) far = Math.max(far, (q.x - fa.x) * n.x + (q.y - fa.y) * n.y);
    const g0 = far + rng.range(1.5, 4);
    if (D - g0 < 6) return;
    for (const r of clipPlot(poly, band(g0, D + 1), convex)) if (area(r) > 20) out.push({ poly: r, kind: 'garden' });
  };
  const add = (hps: HalfPlane[], kind: Bldg['kind']) => {
    for (const r of clipPlot(poly, hps, convex)) {
      let c = cleanRing(r, 0.005, 0.5, 0.002, false);
      if (c.length < 3) continue;
      c = truncateAcute(c, (20 * Math.PI) / 180, 2);
      if (c.length < 3 || area(c) < 10) continue;
      if ((isConvex(c, 1e-3) ? convexWidth(c) / 2 : inscribed(c, [], 0.25).r) < 1.1) continue;
      out.push({ poly: c, kind });
    }
  };
  const [sb0, sb1] = P.setback[zone];
  const [gp0, gp1] = P.sideGap[zone];
  const [bd0, bd1] = P.buildDepth[zone];
  if (zone === 'village') {
    // farmstead: house along the street, barn at the side/rear around a yard
    const sb = rng.range(sb0, sb1);
    const hd = rng.range(7, 10), hw = Math.min(W - 2, rng.range(12, 18));
    const left = rng.chance(0.5);
    const x0 = left ? rng.range(1, 3) : W - hw - rng.range(1, 3);
    const lat = (u0: number, u1: number): HalfPlane[] => [
      { p: { x: fa.x + t.x * u0, y: fa.y + t.y * u0 }, n: t },
      { p: { x: fa.x + t.x * u1, y: fa.y + t.y * u1 }, n: { x: -t.x, y: -t.y } },
    ];
    add([...band(sb, sb + hd), ...lat(x0, x0 + hw)], 'house');
    const bdp = rng.range(8, 12), bl = Math.min(D - sb - hd - 6, rng.range(14, 24));
    if (bl > 6) {
      const bx0 = left ? W - bdp - rng.range(1, 3) : rng.range(1, 3);
      add([...band(sb + hd + 5, sb + hd + 5 + bl), ...lat(bx0, bx0 + bdp)], 'barn');
    }
    if (rng.chance(0.5) && D > sb + 30) add([...band(sb + hd + 2, sb + hd + 8), ...lat(W / 2 - 3, W / 2 + 4)], 'shed');
    addGarden();
    return out;
  }
  const core = zone === 'core';
  const sb = rng.range(sb0, sb1);
  const db = Math.min(D - sb, rng.range(bd0, bd1) * (pl.wide ? 1.15 : 1));
  const gA = core || infill > 0.8 ? 0 : rng.chance(0.55) ? rng.range(gp0, gp1) : 0;
  const gB = core || infill > 0.8 ? 0 : rng.chance(0.55) ? rng.range(gp0, gp1) : 0;
  if (W - gA - gB < 3.5) return [];
  const sides = [shift(hA, gA), shift(hB, gB)];
  add([...band(sb, sb + db), ...sides], 'house');
  // corner plots: a range along the other street as well (behind the main house)
  for (const [a, b] of pl.sideFronts) {
    const l = dist(a, b);
    const u = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
    // inward normal of that edge: towards the plot interior (the plot centroid side)
    let m = { x: -u.y, y: u.x };
    let cx = 0, cy = 0;
    for (const q of poly) { cx += q.x; cy += q.y; }
    cx /= poly.length; cy /= poly.length;
    if ((cx - a.x) * m.x + (cy - a.y) * m.y < 0) m = { x: -m.x, y: -m.y };
    const d2 = Math.min(db, rng.range(bd0, bd1));
    add([
      { p: a, n: m }, { p: { x: a.x + m.x * d2, y: a.y + m.y * d2 }, n: { x: -m.x, y: -m.y } },
      { p: { x: fa.x + n.x * (sb + db), y: fa.y + n.y * (sb + db) }, n },
    ], 'house');
  }
  const rest = D - sb - db;
  if (rest < 4) return out;
  // burgage cycle
  const wingW = Math.min(rng.range(3, 5), (W - 3) / 2);
  const hasBack = infill > 0.6 && rest > 12;
  const backD = hasBack ? Math.min(rest - 5, rng.range(6, 10)) : 0;
  const wingEnd = hasBack ? D - backD : sb + db + rest * rng.range(0.55, 0.9);
  const sideFirst = rng.chance(0.5) ? 0 : 1;
  const narrowDense = infill > 0.85 && W - 2 * wingW < 3 && rest > 10;
  if (hasBack && backD > 3) add([...band(D - backD, D + 1), ...sides], 'back');
  if (narrowDense) {
    // narrow, fully built plot: front house, a light well across the plot, then a rear range
    const well = rng.range(3, 4.5);
    const r0 = sb + db + well, r1 = hasBack ? D - backD : wingEnd;
    if (r1 - r0 > 3) add([...band(r0, r1), ...sides], 'rear');
    return out;
  }
  if (infill > 0.3 && wingW >= 2.6 && rng.chance(Math.min(1, 0.3 + infill))) {
    const s = sides[sideFirst];
    add([...band(sb + db, wingEnd), s, flip(shift(s, wingW))], 'rear');
  }
  if (infill > 0.6 && W - 2 * wingW >= 3 && rng.chance(infill > 0.85 ? 0.9 : 0.45)) {
    const s = sides[1 - sideFirst];
    const e2 = infill > 0.85 ? wingEnd : sb + db + (wingEnd - sb - db) * rng.range(0.4, 0.8);
    add([...band(sb + db, e2), s, flip(shift(s, wingW))], 'rear');
  }
  addGarden();
  return out;
}
