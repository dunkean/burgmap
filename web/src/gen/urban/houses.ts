/**
 * Town houses on burgage plots (URBAN_GEOMETRY.md §4, POLISH "Building footprints"). Every footprint is still
 * plot ∩ half-planes of the plot's own frame (frontage, side lines, depth bands), so nothing leaves the plot; what
 * changes is the *program* of the plot, read from its geometry, its zone and its wealth — never from noise:
 *
 * - the front house: depth tied to its bays. Narrow plots (< 8.5 m) carry a gable-end house 1.3–1.9 × as deep as
 *   wide (two or three bays deep, more on rich plots); wider plots an eaves-side house one pile (6.5–8.5 m, poor) or
 *   two piles (9–14 m) deep. Very wide frontages are split into attached houses;
 * - the plan around a court (Vorderhaus / Seitenflügel / Hinterhaus): a side wing joins the front house as an L, a
 *   back house closes the court; neighbouring plots put their courts side by side (wings alternate by plot order),
 *   so courts pair up across the party wall, as in the cadastres. Rich plots: wings on both sides (a U), a stair
 *   turret in the court corner, a carriage passage through the front range;
 * - yards and gardens: a short L or T wing, then a clearly smaller outbuilding (shed, stable, workshop: 4.5–6.5 m
 *   deep, part of the plot width) across a yard, then the garden;
 * - façades: the street line is mostly continuous, with small jogs (0.4–1.2 m setbacks on some plots);
 * - corner plots: the front house wraps the corner (an L) and is chamfered where the streets meet at an acute angle.
 *
 * Wealth (Plot.wealth, 0–1: near the market and on the main streets → rich, back lanes and the edge → poor) drives
 * frontage widths (plots.ts) and the depth, wings, turrets and passages here, so sizes are long-tailed by zone.
 */
import type { Vec2, Polygon } from '../core/geom';
import { dist } from '../core/geom';
import type { Rng } from '../core/rng';
import type { MorphologyParams } from './morphology';
import type { Plot } from './plots';
import { clipPlot, courtyardRing, rectify, shapeOf, MIN_BW, MAX_ASPECT, type Bldg, type HalfPlane, type CourtHint } from './buildings';
import { area, cleanRing, interiorAngle, orientPos } from '../geo/poly';
import { isConvex, polyInside } from '../geo/split';
import { stitchUnion } from '../geo/stitch';
import { unionS } from '../geo/bool';
import { disk } from '../geo/offset';
import { truncateAcute } from './blocks';

const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Union of two touching footprints when the result is still a proper footprint (≥ 4.5 m wide, aspect ≤ 3). */
export function joinFoot(a: Polygon, b: Polygon): Polygon | null {
  let u = stitchUnion(a, b);
  if (!u) { const r = unionS(a, b); if (r.length === 1 && !r[0].holes.length) u = r[0].outer; }
  if (!u || u.length < 3) return null;
  u = cleanRing(u, 0.005, 0.5, 0.002, false);
  if (u.length < 3 || Math.abs(area(u) - area(a) - area(b)) > 0.05 * (area(a) + area(b))) return null;
  const s = shapeOf(u);
  return s.w >= MIN_BW && s.asp <= MAX_ASPECT ? u : null;
}

export function burgageHouse(pl: Plot, cov: number, P: MorphologyParams, rng: Rng, hint?: CourtHint): Bldg[] {
  const poly = pl.poly;
  const convex = isConvex(poly, 1e-3);
  const [fa, fb] = pl.front;
  const W = dist(fa, fb);
  if (W < 2.5) return [];
  const t = { x: (fb.x - fa.x) / W, y: (fb.y - fa.y) / W };
  let n = { x: -t.y, y: t.x };
  if (dot(n, pl.nrm) < 0) n = { x: -n.x, y: -n.y };
  let D = 0;
  for (const q of poly) D = Math.max(D, (q.x - fa.x) * n.x + (q.y - fa.y) * n.y);
  if (D < 4) return [];
  const sideN = (s: { p: Vec2; d: Vec2 }, towards: Vec2): HalfPlane => {
    let m = { x: -s.d.y, y: s.d.x };
    if (dot(m, towards) < 0) m = { x: -m.x, y: -m.y };
    return { p: s.p, n: m };
  };
  const sides = [sideN(pl.sideA, t), sideN(pl.sideB, { x: -t.x, y: -t.y })];
  const shift = (h: HalfPlane, g: number): HalfPlane => ({ p: { x: h.p.x + h.n.x * g, y: h.p.y + h.n.y * g }, n: h.n });
  const flip = (h: HalfPlane): HalfPlane => ({ p: h.p, n: { x: -h.n.x, y: -h.n.y } });
  const band = (d0: number, d1: number): HalfPlane[] => [
    { p: { x: fa.x + n.x * d0, y: fa.y + n.y * d0 }, n },
    { p: { x: fa.x + n.x * d1, y: fa.y + n.y * d1 }, n: { x: -n.x, y: -n.y } },
  ];
  /** Strip of width w along side k (k = 0: side A, 1: side B); `from` > 0 leaves a strip free first. */
  const strip = (k: number, w: number, from = 0): HalfPlane[] => [...(from > 0 ? [shift(sides[k], from)] : [sides[k]]), flip(shift(sides[k], from + w))];
  const lat = (u0: number, u1: number): HalfPlane[] => [
    { p: { x: fa.x + t.x * u0, y: fa.y + t.y * u0 }, n: t },
    { p: { x: fa.x + t.x * u1, y: fa.y + t.y * u1 }, n: { x: -t.x, y: -t.y } },
  ];
  const zone = pl.zone;
  const wl = clamp(pl.wealth ?? 0.5, 0, 1);
  const dense = zone === 'core' || zone === 'middle';
  const conform = P.footprintConformity?.[zone] ?? 1;
  const cornerFill = P.cornerFill?.[zone] ?? 1;
  const A = area(poly);
  /** plot ∩ half-planes, cleaned (the largest piece; rectified when the culture wants orthogonal footprints). */
  const cut = (hps: HalfPlane[], min = 6): Polygon | null => {
    let best: Polygon | null = null;
    for (let r of clipPlot(poly, [...hps, ...excl], convex)) {
      if (!rng.chance(conform)) { const rect = rectify(r, fa, t, n); if (rect && !rng.chance(cornerFill)) r = rect; }
      let c = cleanRing(r, 0.005, 0.5, 0.002, false);
      if (c.length < 3) continue;
      c = truncateAcute(c, (20 * Math.PI) / 180, 2);
      if (c.length < 3 || area(c) < min) continue;
      if (!best || area(c) > area(best)) best = c;
    }
    return best;
  };
  const out: Bldg[] = [];
  /** Half-planes every later piece keeps to (beside the corner wings). */
  const excl: HalfPlane[] = [];
  const push = (p: Polygon | null, kind: Bldg['kind']) => { if (p) out.push({ poly: p, kind }); };
  const garden = (from: number) => {
    if (D - from < 3) return;
    for (const r of clipPlot(poly, band(from, D + 1), convex)) if (area(r) > 20) out.push({ poly: r, kind: 'garden' });
  };

  // ---- the street line: mostly continuous, small jogs on some plots, set back outside the core
  const fade = pl.fade ?? 0;
  if (fade > 0 && rng.chance(0.5 * Math.pow(fade, 1.4))) { garden(0); return out; }
  const [sb0, sb1] = P.setback[zone];
  let sb = dense && rng.chance(zone === 'core' ? 0.14 : 0.24) ? rng.range(0.4, 1.1) : rng.range(sb0, sb1);
  if (fade > 0) sb += rng.range(0, 3.5) * fade;

  // ---- front house: depth by bays (gable-end on narrow plots, one or two piles deep on wide ones)
  const [bd0, bd1] = P.buildDepth[zone];
  const gable = W < 8.5;
  let hd = gable
    ? Math.min(2.1 * W, W * Math.exp(Math.log(1.22 + 0.42 * wl) + 0.12 * rng.gauss()))
    : wl < 0.35 && rng.chance(0.7 - wl) ? rng.range(6.5, 8.5) : rng.range(9, 11.5) + 2.5 * wl * rng.float();
  hd = clamp(hd, Math.max(6.5, bd0 * 0.7), bd1 * 1.3);
  hd = Math.min(hd, D - sb);
  if (hd < 4) { garden(0); return out; }
  let rest = D - sb - hd;
  if (rest < 4.5 && cov >= 0.45) { hd = D - sb; rest = 0; } // shallow plot: the house takes the whole depth

  // ---- large courtyard building on wide rich plots of dense zones (inn, hall, hôtel)
  if (cov >= 0.66 && W >= 11 && D >= 20 && A > 320 && rng.chance((P.bigCourtChance ?? 0.3) * (0.3 + 1.4 * wl))) {
    const Lc = Math.min(D - sb, rng.range(18, 26));
    const Q = clipPlot(poly, band(sb, sb + Lc), convex);
    const ring = Q.length === 1 ? courtyardRing(Q[0], rng.range(4.5, 6), n) : null;
    if (ring) {
      for (const pc of ring.pieces) out.push({ poly: pc, kind: 'hall' });
      const r2 = D - sb - Lc;
      if (r2 >= MIN_BW) {
        if (cov >= 0.84) push(cut(band(sb + Lc, D + 1)), 'back');
        else if (r2 > 9) { const bd = Math.min(r2 - 3, rng.range(5, 7)); push(cut([...band(sb + Lc + 3, sb + Lc + 3 + bd), ...strip(0, Math.min(W, W * rng.range(0.5, 0.9)))]), 'shed'); garden(sb + Lc + 3 + bd + 1); }
      }
      return out;
    }
  }

  // courts pair up across party walls: the wing side alternates along the run
  const k = (pl.order + (hint && hint.f > 0.5 ? 1 : 0)) % 2, c = 1 - k;
  // a carriage passage through the front range of a rich wide plot, on the court side
  const passage = dense && cov >= 0.66 && wl > 0.6 && W >= 12 && rest >= 8 && rng.chance(0.6) ? rng.range(2.8, 3.4) : 0;
  // faubourg gaps between houses (rows → gaps → scattered houses)
  const gapW = zone === 'faubourg' ? Math.min(W - MIN_BW - 0.5, W * (fade * rng.range(0.25, 0.55) + (cov < 0.45 && rng.chance(0.35) ? 0.15 : 0))) : 0;
  // the way in to the court and the back buildings: a gateway (allée, 1.6 m) through the front range on the court
  // side, or the carriage passage; the access stage then has nothing to cut
  // (paired courts share one gateway: every other plot of the run opens it)
  // (gardens: a side gate to the yard and the outbuilding behind the house)
  const gate = cov >= 0.66 && rest >= 4.5 ? passage || (pl.order % 2 === 0 ? 1.6 : 0) : cov >= 0.45 && rest >= 10 && gapW <= 1 ? 1.6 : 0;
  if ((cov >= 0.66 && rest >= 4.5) || gate) pl.gated = true;
  // the house, split into attached houses when the frontage is very long for its depth
  const houses: Polygon[] = [];
  {
    const free = gate || (gapW > 1 ? gapW : 0);
    const hp = free ? [shift(sides[gate ? c : k], free)] : [];
    const Wh = W - free;
    const parts = Wh > 2.8 * hd && Wh > 18 ? Math.ceil(Wh / (2.4 * hd)) : 1;
    for (let j = 0; j < parts; j++) {
      const u0 = (gate && c === 0 ? free : 0) + (Wh * j) / parts, u1 = u0 + Wh / parts;
      const lim = parts > 1 ? lat(j === 0 ? -50 : u0, j === parts - 1 ? W + 50 : u1) : [];
      const h = cut([...band(sb, sb + hd), ...hp, ...lim], 12);
      if (h) houses.push(h);
    }
  }
  if (!houses.length) { garden(0); return out; }
  // corner plots: the front house wraps the corner (an L along the side street), chamfered at an acute corner
  if (pl.sideFronts.length && cov < 0.84) {
    for (const [a, b] of pl.sideFronts) {
      const l = dist(a, b);
      const u = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
      let m = { x: -u.y, y: u.x };
      let cx = 0, cy = 0;
      for (const q of poly) { cx += q.x; cy += q.y; }
      cx /= poly.length; cy /= poly.length;
      if ((cx - a.x) * m.x + (cy - a.y) * m.y < 0) m = { x: -m.x, y: -m.y };
      const d2 = Math.max(MIN_BW + 1, Math.min(hd, rng.range(bd0, bd1)));
      const wing = cut([{ p: a, n: m }, { p: { x: a.x + m.x * d2, y: a.y + m.y * d2 }, n: { x: -m.x, y: -m.y } }, ...band(sb + hd, D + 1)], 12);
      if (!wing) continue;
      excl.push({ p: { x: a.x + m.x * d2, y: a.y + m.y * d2 }, n: m });
      let joined = false;
      for (let j = 0; j < houses.length && !joined; j++) { const u2 = joinFoot(houses[j], wing); if (u2) { houses[j] = u2; joined = true; } }
      if (!joined && shapeOf(wing).w >= MIN_BW) push(wing, 'rear');
    }
  }
  const chamfer = (h: Polygon): Polygon => {
    if (!pl.sideFronts.length) return h;
    let cur = h;
    for (const q of [fa, fb]) {
      if (!pl.sideFronts.some(([a, b]) => dist(a, q) < 0.6 || dist(b, q) < 0.6)) continue;
      let vi = -1;
      for (let i = 0; i < cur.length; i++) if (dist(cur[i], q) < 0.6) vi = i;
      if (vi < 0) continue;
      const th = interiorAngle(cur, vi);
      if (th >= (80 * Math.PI) / 180) continue;
      const v = cur[vi], a = cur[(vi - 1 + cur.length) % cur.length], b = cur[(vi + 1) % cur.length];
      const ua = { x: (a.x - v.x) / (dist(a, v) || 1), y: (a.y - v.y) / (dist(a, v) || 1) }, ub = { x: (b.x - v.x) / (dist(b, v) || 1), y: (b.y - v.y) / (dist(b, v) || 1) };
      let bis = { x: ua.x + ub.x, y: ua.y + ub.y };
      const bl = Math.hypot(bis.x, bis.y) || 1;
      bis = { x: bis.x / bl, y: bis.y / bl };
      const L = Math.min(rng.range(1.8, 3), 0.4 * Math.min(dist(a, v), dist(b, v)));
      const r = clipPlot(cur, [{ p: { x: v.x + bis.x * L * Math.cos(th / 2), y: v.y + bis.y * L * Math.cos(th / 2) }, n: bis }], isConvex(cur, 1e-3));
      if (r.length === 1 && area(r[0]) > 0.8 * area(cur)) cur = cleanRing(r[0], 0.005, 0.5, 0.002, false);
    }
    return cur;
  };
  for (let j = 0; j < houses.length; j++) houses[j] = chamfer(houses[j]);
  const d0 = sb + hd;
  /** Joins the wing to the front house (an L) when the result is a proper footprint; else keeps it apart. */
  const attach = (wing: Polygon | null, kind: Bldg['kind']): boolean => {
    if (!wing) return false;
    for (let j = 0; j < houses.length; j++) { const u2 = joinFoot(houses[j], wing); if (u2) { houses[j] = u2; return true; } }
    if (shapeOf(wing).w >= MIN_BW) { push(wing, kind); return true; }
    return false;
  };
  /**
   * A wing [a, b] × (strip of width ww along side `side`, or the lateral interval `mid`): joined to the house when
   * that gives a proper footprint, else standing alone at least MIN_BW wide.
   */
  const wingAt = (a: number, b: number, side: number, ww: number, join: boolean, mid?: number): boolean => {
    const mk = (w: number) => cut([...band(a, b), ...(mid !== undefined ? lat(mid - w / 2, mid + w / 2) : strip(side, w))]);
    const w1 = mk(ww);
    if (join && w1) for (let j = 0; j < houses.length; j++) { const u2 = joinFoot(houses[j], w1); if (u2) { houses[j] = u2; return true; } }
    const wMin = MIN_BW + 0.1;
    const w2 = ww >= wMin ? w1 : W - wMin >= 2.4 ? mk(wMin) : null;
    if (w2 && shapeOf(w2).w >= MIN_BW) { push(w2, 'rear'); return true; }
    return false;
  };
  /** A stair turret in the inner corner of the court (rich houses): an octagon on the house–wing corner. */
  const turret = (ww: number, side: number) => {
    // (only into a court wide enough to keep its light and the way through)
    if (wl < 0.75 || W - ww < 4.2 || !rng.chance(0.55)) return;
    // the corner: depth d0 on the wing's inner edge (side line shifted by ww)
    const s = shift(sides[side], ww);
    const den = s.n.x * n.y - s.n.y * n.x;
    if (Math.abs(den) < 1e-6) return;
    const c1 = s.n.x * s.p.x + s.n.y * s.p.y, c2 = n.x * (fa.x + n.x * d0) + n.y * (fa.y + n.y * d0);
    const p = { x: (c1 * n.y - s.n.y * c2) / den, y: (s.n.x * c2 - c1 * n.x) / den };
    const r = Math.min(rng.range(1.5, 2), 0.35 * (W - ww));
    // The side frame can survive a later parcel merge while the actual lot tapers or has a notch.
    // Partition the turret from the lot too: clipping only its depth band can extend a house across a party wall.
    const octagon = orientPos(disk(p, r, 8));
    const old = clipPlot(octagon, band(sb, D), true);
    if (old.length === 1 && polyInside(poly, old[0])) {
      for (let j = 0; j < houses.length; j++) { const u2 = joinFoot(houses[j], old[0]); if (u2) { houses[j] = u2; return; } }
      return;
    }
    const hps = band(sb, D);
    for (let i = 0; i < octagon.length; i++) {
      const a = octagon[i], b = octagon[(i + 1) % octagon.length];
      hps.push({ p: a, n: { x: -(b.y - a.y), y: b.x - a.x } });
    }
    for (const oct of clipPlot(poly, hps, convex)) {
      for (let j = 0; j < houses.length; j++) { const u2 = joinFoot(houses[j], oct); if (u2) { houses[j] = u2; return; } }
    }
  };

  if (rest >= 4.5 && cov >= 0.84) {
    // FULL: house, then court segments (a wing on one side, the court beside it) alternating with ranges to the back
    // (one court behind the house; a second one only on very deep plots)
    const segs: { d0: number; d1: number; court: boolean }[] = [];
    let d = d0, courts = 0;
    while (D - d > 0.5) {
      if (D - d <= 10) { segs.push({ d0: d, d1: D + 1, court: false }); break; }
      if (courts === 0 || (courts === 1 && D - d > 24)) {
        let Lc = rng.range(3, 5.5);
        if (D - d - Lc < 5) Lc = D - d - 5;
        if (Lc >= 3) { segs.push({ d0: d, d1: d + Lc, court: true }); d += Lc; courts++; }
      }
      const Lr = D - d <= 15 ? D + 1 - d : rng.range(7, 11);
      segs.push({ d0: d, d1: d + Lr, court: false });
      d += Lr;
    }
    const Lsum = segs.filter((s) => s.court).reduce((s2, x) => s2 + x.d1 - x.d0, 0);
    // (the gateway the access stage cuts through the front range, 1.6 m, opens into the court: it counts as unbuilt)
    const U = Math.max(8, (1 - cov) * A - (passage || 1.6) * hd - sb * W);
    // (courts pair up across the party wall: each plot gives ≥ 2.4 m)
    const cw = Lsum > 0 ? clamp(U / Lsum, 2.4, W - 3.6) : 0;
    const both = wl > 0.7 && W >= 12 && rng.chance(0.6);
    // An attached room range may be 3.6 m wide; standalone buildings and carved gateway ranges need MIN_BW.
    // Keep the rich-house draw, but use one full-width wing when dividing it would leave two thin arms.
    const pair = both && (W - cw) / 2 >= 3.6 - 1e-9;
    let first = true;
    for (const s of segs) {
      if (!s.court) { push(cut(band(s.d0, s.d1)), s.d1 > D ? 'back' : 'rear'); continue; }
      // The clamped court leaves exactly 3.6 m for its wings; floating subtraction must not turn that equality
      // into a cross-plot court with no wing or stair turret.
      if (W - cw < 3.6 - 1e-9 || cw < 2.4) {
        // narrow plot: a court across the whole width, short (one light court)
        const Lc = clamp(U / Math.max(1, W), 3, s.d1 - s.d0);
        if (s.d1 - s.d0 - Lc >= MIN_BW) push(cut(band(s.d0 + Lc, s.d1)), 'rear');
        else if (s.d1 - s.d0 - Lc > 0.5) { /* the rest of the segment joins the court */ }
        continue;
      }
      if (pair) {
        const w1 = (W - cw) / 2;
        wingAt(s.d0, s.d1, k, w1, first); wingAt(s.d0, s.d1, c, w1, first);
      } else {
        wingAt(s.d0, s.d1, k, W - cw, first);
      }
      if (first) turret(pair ? (W - cw) / 2 : W - cw, k);
      first = false;
    }
    for (const h of houses) out.unshift({ poly: h, kind: 'house' });
    return out;
  }
  if (rest >= 4.5 && cov >= 0.66) {
    // YARD: the yard is what the coverage leaves unbuilt (the access gateway, 1.6 m through the front range, opens
    // into it). Wide plots: an L (wing along one side) with the yard beside it; narrow plots: a rear range, the yard
    // across the plot. A smaller outbuilding (or, on dense plots, a back house) closes the yard at the back.
    // (the access stage and the shape rules take a few % more: aim slightly higher)
    const U = Math.max(9, (1 - cov - 0.06) * A - 1.6 * hd - sb * W);
    const backD = rest >= 4.5 + 3 + 4.5 ? Math.min(rest - 7.5, cov >= 0.75 ? rng.range(5.5, 8) : rng.range(4.5, 6.5)) : 0;
    const L = rest - backD;
    let yw = clamp(U / Math.max(1, L), 3, W);
    const cross = W - yw < 3.6;
    // the outbuilding spans the plot when the yard is narrow, else the wing side only
    const bw = backD ? (cross || cov >= 0.75 ? W : clamp(W * rng.range(0.55, 1), MIN_BW, W)) : 0;
    const back = backD ? cut([...band(D - backD, D + 1), ...(W - bw >= 3 ? strip(k, bw) : [])]) : null;
    if (!cross) {
      if (back && bw < W) yw = clamp((U - (W - bw) * backD) / Math.max(1, L), 3, W - 3.6);
      const ww = W - yw;
      wingAt(d0, d0 + L, k, ww, true);
      turret(ww, k);
    } else {
      const yl = clamp(U / W, 3, L);
      // the yard sits behind the house when the range would be too shallow, else between range and back house
      if (L - yl >= MIN_BW) {
        const r = cut([...band(d0, d0 + L - yl), shift(sides[c], gate)]);
        if (!attach(r, 'rear')) push(r, 'rear');
      }
    }
    if (back) push(back, 'back');
    for (const h of houses) out.unshift({ poly: h, kind: 'house' });
    return out;
  }
  if (rest >= 3) {
    // GARDEN / OPEN: a short wing (an L, or a T behind a wide detached house), a small outbuilding across a yard
    const houseA = houses.reduce((s2, h) => s2 + area(h), 0);
    let need = cov * A - houseA;
    let end = d0;
    if (cov >= 0.45 || (wl > 0.5 && need > 20)) {
      const ww = clamp(W * rng.range(0.38, 0.55), 3.6, 6);
      const len = clamp((cov >= 0.45 ? 0.8 : 1) * need / ww, 0, cov >= 0.45 ? rest - 3 - MIN_BW : Math.min(rest - 3, rng.range(4, 9)));
      if (len >= 3 && W - ww >= 2) {
        const tee = !dense && W >= 11 && rng.chance(0.5);
        if (wingAt(d0, d0 + len, k, ww, true, tee ? W / 2 : undefined)) { need -= Math.max(ww, MIN_BW) * len; end = d0 + len; }
      }
    }
    // the outbuilding: shed, stable or workshop, clearly smaller than the house. Gardens (cov ≥ 0.45): a barn or
    // workshop across the back of the plot (on the back lane), sized by what the coverage still asks; open plots: a
    // small shed across a yard behind the house
    const houseA2 = houses.reduce((s2, h) => s2 + area(h), 0);
    if (cov >= 0.45 && need > 15 && D - end >= MIN_BW + 2.5) {
      const sd = Math.min(D - end - 2.5, rng.range(MIN_BW + 0.2, 7));
      const sw = Math.max(MIN_BW + 0.1, Math.min(need, 0.75 * houseA2) / sd);
      const full = sw >= W - 2;
      push(cut([...band(D - sd, D + 1), ...(full ? [] : strip(c, sw))]), 'barn');
    } else {
      const y = rng.range(3, 6);
      if (need > 12 && D - end - y >= MIN_BW + 1.5) {
        const sd = Math.min(D - end - y - 1, rng.range(MIN_BW, 6.5));
        const sw = clamp(Math.min(need / sd, rng.range(4.5, 7)), MIN_BW, W);
        if (sd >= MIN_BW) { push(cut([...band(end + y, end + y + sd), ...(sw < W - 1 ? strip(c, sw, W - sw > 2 ? rng.range(0, Math.min(1.5, W - sw - 1)) : 0) : [])]), 'shed'); end += y + sd; }
      }
    }
    for (const h of houses) out.unshift({ poly: h, kind: 'house' });
    garden(end + 1);
    return out;
  }
  for (const h of houses) out.unshift({ poly: h, kind: 'house' });
  if (rest >= 3) garden(d0 + 1);
  return out;
}
