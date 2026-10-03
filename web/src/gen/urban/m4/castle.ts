/**
 * Castle / citadel (URBAN_LANDMARKS.md §2, URBAN_GEOMETRY.md §3.9).
 *
 * Siting (before the primary streets): candidate enceintes are tried along the enclosure line, each a convex
 * polygon of 4–8 straight curtains fitted to the hill brow around its centre (the curtain follows the edge of the
 * high ground), and scored by prominence, steep flanks, water wrapping round it (meander neck, confluence), the
 * site's citadel spot, distance from the nucleus and clearance from the roads. The chosen castle straddles the
 * town wall: the enclosure becomes E ∪ C, so its outer curtains are part of the town circuit (Caernarfon,
 * Carcassonne). Its lot = (C outset by ditch + esplanade) ∩ E: the esplanade (glacis) separates it from the houses,
 * the esplanade street runs along the lot's town side and one approach street leads to the gate.
 *
 * Plan (builder): enceinte, ditch or moat band, esplanade, causeway at the gate; inner and outer bailey separated
 * by a cross wall; keep at the far end of the inner bailey, gatehouse on the town side, hall, chapel and ranges
 * along the curtains. The curtain itself is a wall with towers at every vertex (walls.ts).
 */
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import { dist, polygonCentroid } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { UrbanCtx } from '../context';
import type { PhasePlan } from '../phases';
import { MultiPoly, unionS, intersectionS, differenceS, mpArea } from '../../geo/bool';
import { area, pointInRing, distToRing, convexHull, orientPos, inscribed, cleanRing } from '../../geo/poly';
import { disk } from '../../geo/offset';
import { outsetConvex } from '../streetops';
import { kasbah, type CompoundCtx } from '../compounds';
import { kremlinInterior } from '../russian';
import { TAU, wetFraction, fracInside, clearOfLines, inMP, rectAt, frameAt, scalePoly } from './lots';
import { Mask } from './site';
import { samplePoly, LineIndex } from './lots';
import { emptyOut, pieces, splitLine, largest, alongEdge, placeRect, minus, inter, fits, type Out } from './kit';

export type CastleVariant = 'castle' | 'kasbah' | 'motte' | 'inca-fortress' | 'kremlin';
/** Debug counters of the castle siting (rejections by reason). */
export const CASTLE_DBG: Record<string, number> = {};
const why = (k: string) => { CASTLE_DBG[k] = (CASTLE_DBG[k] ?? 0) + 1; };

export interface CastlePlan {
  variant: CastleVariant;
  /** Enceinte (convex, straight curtains). */
  C: Polygon;
  /** Lot: C + ditch + esplanade, inside the (extended) enclosure. */
  lot: Polygon;
  ditch: number;
  espl: number;
  /** Gate on the town side: point on C and outward unit normal. */
  gate: { p: Vec2; n: Vec2 };
  moat: boolean;
  /** C extends the enclosure (its outer curtains are part of the town wall). */
  outside: boolean;
  /** Extended enclosure E ∪ C. */
  enclosure: MultiPoly;
}

const unit = (a: Vec2, b: Vec2): Vec2 => { const l = dist(a, b) || 1; return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; };

/** Castle area (m²) by population and variant. */
export function castleArea(variant: CastleVariant, pop: number, rng: Rng): number {
  const j = rng.range(0.85, 1.2);
  if (variant === 'motte') return 1100 * j;
  if (variant === 'kasbah') return Math.min(26000, 6000 + pop * 0.4) * j;
  if (variant === 'inca-fortress') return Math.min(42000, 9000 + pop * 0.5) * j;
  if (variant === 'kremlin') return Math.min(150000, 20000 + pop * 2) * j;
  return Math.min(22000, 2600 + pop * 0.36) * j;
}

/**
 * The convex enceinte around p: radii to the brow of the high ground in 16 directions (where the ground falls
 * `drop` m below the centre), n vertices at jittered angles, convex hull, scaled to the target area.
 */
function enceinte(ctx: UrbanCtx, p: Vec2, A: number, n: number, a0: number, rng: Rng, rect?: { ang: number; aspect: number }): Polygon {
  if (rect) {
    const L = Math.sqrt(A * rect.aspect), W = A / L;
    return rectAt(p, rect.ang, -L / 2, L / 2, -W / 2, W / 2);
  }
  const R = Math.sqrt(A / Math.PI);
  const hc = ctx.heightAt(p);
  const rad: number[] = [];
  for (let k = 0; k < 16; k++) {
    const th = (k / 16) * TAU;
    let r = 1.0 * R;
    for (let s = 0.6 * R; s <= 1.45 * R; s += 4) {
      if (ctx.heightAt({ x: p.x + Math.cos(th) * s, y: p.y + Math.sin(th) * s }) < hc - 2.5) { r = s; break; }
      r = 1.45 * R;
    }
    rad.push(r);
  }
  // smooth the radii (a brow, not a star)
  const sm = rad.map((_, k) => (rad[(k + 15) % 16] + 2 * rad[k] + rad[(k + 1) % 16]) / 4);
  const pts: Vec2[] = [];
  for (let k = 0; k < n; k++) {
    const th = a0 + (k / n) * TAU + rng.range(-0.18, 0.18) * (TAU / n);
    const f = ((((th % TAU) + TAU) % TAU) / TAU) * 16;
    const i0 = Math.floor(f) % 16, t = f - Math.floor(f);
    const r = (sm[i0] * (1 - t) + sm[(i0 + 1) % 16] * t) * rng.range(0.93, 1.07);
    pts.push({ x: p.x + Math.cos(th) * r, y: p.y + Math.sin(th) * r });
  }
  let C = orientPos(convexHull(pts));
  C = scalePoly(C, p, Math.sqrt(A / Math.max(1, area(C))));
  // curtains of at least 14 m (no stub between two towers)
  return removeStubs(C, 14, () => false);
}

/**
 * Removes the vertices that bound edges shorter than `min` (the one not protected by `keep`, else the one with the
 * flatter turn), so every curtain between two towers is a real wall.
 */
export function removeStubs(ring: Polygon, min: number, keep: (p: Vec2) => boolean): Polygon {
  let r = ring.slice();
  const turnAt = (q: Polygon, i: number) => {
    const n = q.length, p0 = q[(i - 1 + n) % n], p1 = q[i], p2 = q[(i + 1) % n];
    const ux = p1.x - p0.x, uy = p1.y - p0.y, vx = p2.x - p1.x, vy = p2.y - p1.y;
    return Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
  };
  for (let guard = 0; guard < 400 && r.length > 3; guard++) {
    const n = r.length;
    let drop = -1;
    for (let i = 0; i < n && drop < 0; i++) {
      const a = i, b = (i + 1) % n;
      if (dist(r[a], r[b]) >= min) continue;
      const ka = keep(r[a]), kb = keep(r[b]);
      if (ka && kb) continue;
      drop = ka ? b : kb ? a : turnAt(r, a) < turnAt(r, b) ? a : b;
    }
    if (drop < 0) break;
    r = r.filter((_, i) => i !== drop);
  }
  return r;
}

export interface CastleSiteIn {
  enclosure: MultiPoly;
  phases: PhasePlan[];
  roads: Polyline[];
  nucleus: Vec2;
  pop: number;
  variant: CastleVariant;
  walled: boolean;
  citadelSpot?: Vec2;
  /** Centres of the castles already sited (a further castle takes a distinct site, ≥ 300 m away). */
  avoid?: Vec2[];
  /** River crossings: a further castle prefers to guard one (bridgehead castle). */
  bridges?: Vec2[];
}

/** Sites the castle on the most defensible spot at the edge of the enclosure; null when nothing fits. */
export function siteCastle(ctx: UrbanCtx, inp: CastleSiteIn, rng: Rng): CastlePlan | null {
  let main = inp.enclosure[0];
  for (const ph of inp.enclosure) if (area(ph.outer) > area(main.outer)) main = ph;
  if (!main) return null;
  const ring = main.outer;
  const A = castleArea(inp.variant, inp.pop, rng);
  const R = Math.sqrt(A / Math.PI);
  const encR = Math.sqrt(mpArea(inp.enclosure) / Math.PI);
  if (encR < 2.2 * R) { why('small'); return null; }
  const ditch = inp.variant === 'kasbah' || inp.variant === 'inca-fortress' ? 0 : inp.variant === 'motte' ? 7 : inp.variant === 'kremlin' ? rng.range(12, 16) : rng.range(9, 13);
  const espl = inp.variant === 'kasbah' ? rng.range(12, 18) : inp.variant === 'motte' ? 8 : inp.variant === 'inca-fortress' ? rng.range(10, 16) : inp.variant === 'kremlin' ? rng.range(34, 52) : Math.min(38, rng.range(16, 24) + R * 0.12);
  const core = inp.phases.length > 1 ? inp.phases[0].region : [];
  const roads = new LineIndex(inp.roads.map((path) => ({ path, hw: 5 })));
  // local relief statistics
  const ring2 = (p: Vec2, r: number): number => { let s = 0; for (let k = 0; k < 12; k++) s += ctx.heightAt({ x: p.x + Math.cos((k / 12) * TAU) * r, y: p.y + Math.sin((k / 12) * TAU) * r }); return s / 12; };
  // (a kremlin: a triangle or a quadrilateral on its spur between the rivers)
  const nSides = inp.variant === 'kasbah' ? 4 : inp.variant === 'motte' ? 8 : inp.variant === 'kremlin' ? rng.int(3, 4) : rng.int(5, 8);
  const a0 = rng.range(0, TAU);
  const cands: Vec2[] = [];
  const L = ring.length;
  const encM = new Mask(ctx.mapSize, inp.enclosure, 5);
  const fracIn = (P: Polygon): number => { const sm = samplePoly(P, 8); let k = 0; for (const q of sm) if (encM.has(q)) k++; return sm.length ? k / sm.length : 0; };
  for (let i = 0; i < L; i++) {
    const a = ring[i], b = ring[(i + 1) % L];
    const l = dist(a, b);
    const m = Math.max(1, Math.ceil(l / 30));
    const t = unit(a, b);
    let nIn = { x: -t.y, y: t.x };
    const mid = { x: (a.x + b.x) / 2 + nIn.x * 2, y: (a.y + b.y) / 2 + nIn.y * 2 };
    if (!pointInRing(ring, mid)) nIn = { x: t.y, y: -t.x };
    for (let k = 0; k < m; k++) {
      const q = { x: a.x + (b.x - a.x) * ((k + 0.5) / m), y: a.y + (b.y - a.y) * ((k + 0.5) / m) };
      for (const o of [0.5, 0.05, -0.4]) cands.push({ x: q.x + nIn.x * o * R, y: q.y + nIn.y * o * R });
    }
  }
  if (inp.citadelSpot && distToRing(ring, inp.citadelSpot) < 1.5 * R) cands.push(inp.citadelSpot);
  let best: { C: Polygon; s: number } | null = null;
  const sr = rng.fork('jit');
  for (const p of cands) {
    if (ctx.isWater(p)) continue;
    const dN = dist(p, inp.nucleus);
    if (dN < Math.max(90, 0.32 * encR)) { why('near'); continue; }
    if (inp.avoid?.some((q) => dist(q, p) < 300)) { why('other'); continue; }
    // a rectangle (kasbah) is aligned with the nearest wall edge so one curtain lies on it
    let rect: { ang: number; aspect: number } | undefined;
    if (inp.variant === 'kasbah') {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < L; i++) { const d = distSegP(p, ring[i], ring[(i + 1) % L]); if (d < bd) { bd = d; bi = i; } }
      const t = unit(ring[bi], ring[(bi + 1) % L]);
      rect = { ang: Math.atan2(t.y, t.x), aspect: 1.35 };
    }
    const C = enceinte(ctx, p, A, nSides, a0, sr, rect);
    if (C.length < 3) continue;
    const fin = fracIn(C);
    if (fin < 0.42 || fin > 0.93) { why('fin'); continue; }
    if (wetFraction(ctx, C, 6) > 0) { why('wet'); continue; }
    const outer = outsetConvex(C, ditch + espl * 0.6);
    if (!roads.clear(outer, 2)) { why('roads'); continue; }
    // score: prominence, steep flanks outside, water wrap, citadel spot, away from the old core
    const hp = ctx.heightAt(p);
    const prom = Math.max(-1, Math.min(2.2, (hp - ring2(p, 2.2 * R)) / 5));
    let flank = 0, nf = 0, wrap = 0;
    for (let k = 0; k < 16; k++) {
      const th = (k / 16) * TAU;
      const q = { x: p.x + Math.cos(th) * R * 1.25, y: p.y + Math.sin(th) * R * 1.25 };
      if (!inMP(inp.enclosure, q)) { flank += ctx.slopeAt(q); nf++; }
      for (const s of [1.2, 1.8, 2.6]) { const w = { x: p.x + Math.cos(th) * (R * s + 20), y: p.y + Math.sin(th) * (R * s + 20) }; if (ctx.isWater(w)) { wrap++; break; } }
    }
    flank = nf ? flank / nf : 0;
    const wet = wetFraction(ctx, outsetConvex(C, ditch), 6);
    let s = prom + 4 * Math.min(0.25, flank) + 1.4 * Math.min(1, wrap / 7) - 3 * wet;
    if (inp.citadelSpot && !inp.avoid?.length) s += 1.0 * Math.exp(-dist(p, inp.citadelSpot) / 160);
    if (inp.avoid?.length && inp.bridges?.length) s += 1.5 * Math.exp(-Math.min(...inp.bridges.map((b) => dist(b, p))) / 150);
    if (core.length) s -= 1.5 * fracInside(core, C, 10);
    s += 0.25 * Math.min(1, dN / encR) + 0.15 * sr.float();
    if (!best || s > best.s) best = { C, s };
  }
  if (!best) { why('nobest'); return null; }
  const C = orientPos(cleanRing(best.C, 0.5, 2));
  // extended enclosure; must stay one hole-free piece holding the nucleus
  // (the junctions of the town wall with the castle curtains leave no stub between two towers)
  // (only near the castle: the rest of the town wall is left as it is)
  const encX = unionS(inp.enclosure, C).map((ph) => ({ outer: orientPos(removeStubs(ph.outer, 9, (q) => C.some((c) => dist(c, q) < 0.05) || distToRing(C, q) > 70)), holes: [] as Polygon[] }));
  const mainX = encX.find((ph) => pointInRing(ph.outer, polygonCentroid(C)));
  if (!mainX) { why('mainX'); return null; }
  // the gate faces the town: the curtain whose outward normal points most to the nucleus, inside the enclosure
  const P = orientPos(C);
  let gate: { p: Vec2; n: Vec2 } | null = null, gs = -Infinity;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    if (dist(a, b) < 14) continue;
    const t = unit(a, b), n = { x: t.y, y: -t.x }; // outward normal of a CCW ring
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const probe = { x: m.x + n.x * (ditch + espl + 6), y: m.y + n.y * (ditch + espl + 6) };
    if (!inMP(inp.enclosure, probe) || ctx.isWater(probe)) continue;
    const toN = unit(m, inp.nucleus);
    const sc = n.x * toN.x + n.y * toN.y + dist(a, b) / 400;
    if (sc > gs) { gs = sc; gate = { p: m, n }; }
  }
  if (!gate) { why('gate'); return null; }
  // the lot: C plus its ditch and esplanade, within the extended enclosure, on dry land
  const L0 = outsetConvex(C, ditch + espl);
  let lotM = intersectionS(L0, [mainX]);
  if (ctx.water.length) lotM = differenceS(lotM, ctx.water);
  const cc = polygonCentroid(C);
  const lotPh = lotM.find((ph) => pointInRing(ph.outer, cc));
  if (!lotPh) { why('lot'); return null; }
  const lot = orientPos(cleanRing(lotPh.outer, 0.3, 1));
  const lowAt = (q: Vec2) => (ctx.site.fields?.hab ? sampleHab(ctx, q) : 99);
  const moat = inp.variant !== 'kasbah' && inp.variant !== 'inca-fortress' && (lowAt(cc) < 7 || wetFraction(ctx, outsetConvex(C, ditch + 25), 8) > 0.04);
  return {
    variant: inp.variant, C, lot, ditch, espl, gate, moat,
    outside: fracInside(inp.enclosure, C, 7) < 0.98, enclosure: [mainX, ...encX.filter((ph) => ph !== mainX)],
  };
}

function distSegP(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function sampleHab(ctx: UrbanCtx, q: Vec2): number {
  const g = ctx.terrain.height, n = g.w;
  const ix = Math.min(n - 1, Math.max(0, Math.floor(q.x / g.cell))), iy = Math.min(g.h - 1, Math.max(0, Math.floor(q.y / g.cell)));
  return ctx.site.fields.hab[iy * n + ix];
}

// ---------------------------------------------------------------- builder

/** Castle plan inside its carved lot `B` (the lot minus the street and wall bands). */
export function buildCastle(B: Polygon, cx: CompoundCtx): Out {
  const plan = cx.data as CastlePlan | undefined;
  const out = emptyOut();
  if (!plan) { out.parcels.push({ poly: B, use: 'compound:castle' }); return out; }
  if (plan.variant === 'kasbah') return buildKasbah(B, plan, cx);
  if (plan.variant === 'inca-fortress') return buildIncaFortress(B, plan, cx);
  const Cin = largest(inter(plan.C, B));
  if (!Cin || area(Cin) < 300) { out.parcels.push({ poly: B, use: 'esplanade' }); return out; }
  const g = plan.gate, n = g.n, ang = Math.atan2(n.y, n.x);
  // causeway strip from the gate across the ditch and the esplanade
  const cw = plan.variant === 'motte' ? 4 : 6.5;
  const S = rectAt(g.p, ang, 0, 400, -cw / 2, cw / 2);
  const D = outsetConvex(plan.C, plan.ditch);
  // ---- exact partition of the lot: enceinte (baileys), ditch, causeway, esplanade
  const rest = minus(B, Cin);
  const ditchP: Polygon[] = [], causeway: Polygon[] = [], espl: Polygon[] = [];
  for (const r of rest) {
    for (const q of minus(r, S)) {
      for (const d of inter(q, D)) ditchP.push(d);
      for (const e of minus(q, D)) espl.push(e);
    }
    for (const q of inter(r, S)) causeway.push(q);
  }
  // baileys: the enceinte split across the gate axis (inner bailey away from the gate)
  const u = { x: -n.x, y: -n.y };
  let tMax = 0;
  for (const q of Cin) tMax = Math.max(tMax, (q.x - g.p.x) * u.x + (q.y - g.p.y) * u.y);
  const twoBaileys = plan.variant === 'castle' && area(Cin) > 4200;
  const kremlin = plan.variant === 'kremlin';
  let outerB: Polygon | null = null, innerB: Polygon = Cin;
  if (twoBaileys) {
    const f = cx.rng.range(0.42, 0.55);
    const sp = { x: g.p.x + u.x * tMax * f, y: g.p.y + u.y * tMax * f };
    const [inn, outr] = splitLine(Cin, sp, u);
    const ib = largest(inn), ob = largest(outr);
    if (ib && ob && area(ib) > 1200 && area(ob) > 900 && inn.length === 1 && outr.length === 1) {
      innerB = ib; outerB = ob;
      // the cross wall (chord of the enceinte)
      const chord = ib.filter((q) => Math.abs((q.x - sp.x) * u.x + (q.y - sp.y) * u.y) < 0.05);
      if (chord.length >= 2) out.lines.push({ kind: 'citadel-wall', path: [chord[0], chord[chord.length - 1]], width: 2 });
    }
  }
  const iInner = out.parcels.length;
  out.parcels.push({ poly: innerB, use: 'bailey' });
  const iOuter = outerB ? out.parcels.length : iInner;
  if (outerB) out.parcels.push({ poly: outerB, use: 'bailey' });
  for (const d of ditchP) { out.parcels.push({ poly: d, use: plan.moat ? 'moat' : 'ditch' }); if (plan.moat) out.water.push(d); }
  for (const c of causeway) out.parcels.push({ poly: c, use: 'causeway' });
  for (const e of espl) out.parcels.push({ poly: e, use: 'esplanade' });
  const bld = (poly: Polygon | null, parcel: number, arch: string, storeys: number, roof: Out['buildings'][number]['roof'] = 'gable') => {
    if (poly && fits(out.parcels[parcel].poly, poly, 0.3)) out.buildings.push({ poly, kind: 'landmark', parcel, arch, roof, material: 'stone', storeys, orientation: ang });
  };
  // keep: at the far end of the inner bailey (the strongest point), square or round
  const inner = out.parcels[iInner].poly;
  const K = Math.max(9, Math.min(plan.variant === 'motte' ? 12 : 22, Math.sqrt(area(inner)) * 0.3));
  const far = { x: g.p.x + u.x * tMax, y: g.p.y + u.y * tMax };
  let keep: Polygon | null = null;
  const round = plan.variant === 'motte' || cx.rng.chance(0.3);
  const ins = inscribed(inner, [], 1).c;
  for (let k = 0.25; k <= 1.0001 && !keep && !kremlin; k += 0.15) {
    const c = { x: far.x + (ins.x - far.x) * k, y: far.y + (ins.y - far.y) * k };
    const cand = round ? orientPos(disk(c, K / 2, 16)) : rectAt(c, ang, -K / 2, K / 2, -K / 2, K / 2);
    if (fits(inner, cand, 2.5)) keep = cand;
  }
  if (keep) {
    bld(keep, iInner, round ? 'round-keep' : 'keep', 5, round ? 'dome' : 'pyramidal');
    out.landmarks.push({ kind: 'keep', poly: keep });
  }
  // gatehouse astride the gate, inside the curtain (twin towers)
  const gp = out.parcels[iOuter].poly;
  bld(placeRect(gp, frameAt(g.p, ang, -5.5, 0), ang, 5, 7, 0.4), iOuter, 'gatehouse', 3, 'flat');
  // hall and chapel in the inner bailey, along its longest curtain away from the keep; ranges in the outer bailey
  const curtainEdge = (poly: Polygon) => {
    let bi = -1, bl = 0;
    const P = orientPos(poly);
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (distToRing(plan.C, m) > 3.5) continue; // not a curtain (cross wall or wall band)
      if (keep && distToRing(keep, m) < 8) continue;
      const l = dist(a, b);
      if (l > bl) { bl = l; bi = i; }
    }
    return bi;
  };
  if (kremlin) {
    kremlinInterior(inner, out, iInner, g.p, cx.rng);
    out.landmarks.push({ kind: 'kremlin', poly: plan.C });
  }
  if (plan.variant === 'castle') {
    const e = curtainEdge(inner);
    if (e >= 0) bld(alongEdge(orientPos(inner), e, cx.rng.range(9, 12), cx.rng.range(24, 36), 2.5), iInner, 'great-hall', 2);
    const ch = placeRect(inner, ins, 0, 7, 3.6, 2);
    if (ch) bld(ch, iInner, 'castle-chapel', 1);
    if (outerB) {
      const e2 = curtainEdge(outerB);
      if (e2 >= 0) bld(alongEdge(orientPos(outerB), e2, cx.rng.range(6.5, 8), cx.rng.range(20, 40), 2.5), iOuter, 'stables', 1);
    }
  }
  out.landmarks.push({ kind: 'castle', poly: plan.C });
  // the curtain: a wall with towers at every vertex; the stretches on the town wall are drawn by the town wall
  out.walls = [{ ring: plan.C, gates: [{ p: g.p, dir: { x: -n.x, y: -n.y }, width: cw }], role: 'castle' }];
  return out;
}

/** Kasbah: the walled citadel palace (existing builder) inside its rectangle, an esplanade around it. */
function buildKasbah(B: Polygon, plan: CastlePlan, cx: CompoundCtx): Out {
  const Cin = largest(inter(plan.C, B));
  if (!Cin) return { ...emptyOut(), parcels: [{ poly: B, use: 'esplanade' }] };
  const k = kasbah(Cin, { ...cx, angle: Math.atan2(plan.gate.n.y, plan.gate.n.x) });
  const out: Out = { parcels: [...k.parcels], buildings: [...k.buildings], lines: [...k.lines], water: [], landmarks: [...k.landmarks, { kind: 'kasbah', poly: plan.C }] };
  for (const e of minus(B, Cin)) out.parcels.push({ poly: e, use: 'esplanade' });
  // gate tower pair at the town-side gate
  const g = plan.gate, ang = Math.atan2(g.n.y, g.n.x);
  const gh = placeRect(Cin, frameAt(g.p, ang, -5, 0), ang, 4.5, 6.5, 0.4);
  if (gh && !out.buildings.some((b) => intersectionS(b.poly, gh).length)) out.buildings.push({ poly: gh, kind: 'landmark', parcel: 0, arch: 'kasbah-gate', roof: 'flat', material: 'mud', storeys: 2 });
  out.lines = out.lines.filter((l) => l.kind !== 'citadel-wall');
  out.walls = [{ ring: plan.C, gates: [{ p: g.p, dir: { x: -g.n.x, y: -g.n.y }, width: 5 }], role: 'castle' }];
  return out;
}

/**
 * Inca fortress (Sacsayhuamán): on the hill above the town, three zigzag terrace walls across the side facing the
 * town (salients every ~12 m, like saw teeth), the summit with a round tower (Muyuqmarka), two square towers and
 * rows of storehouses (qollqa). No curtain towers: the walls are terraces of fitted stone.
 */
function buildIncaFortress(B: Polygon, plan: CastlePlan, cx: CompoundCtx): Out {
  const Cin = largest(inter(plan.C, B));
  if (!Cin) return { ...emptyOut(), parcels: [{ poly: B, use: 'esplanade' }] };
  const out = emptyOut();
  out.parcels.push({ poly: Cin, use: 'compound:inca-fortress' });
  for (const e of minus(B, Cin)) out.parcels.push({ poly: e, use: 'esplanade' });
  const g = plan.gate, n = g.n, u = { x: -n.y, y: n.x }, inward = { x: -n.x, y: -n.y };
  let depth = 0, half = 0;
  for (const q of Cin) { depth = Math.max(depth, (q.x - g.p.x) * inward.x + (q.y - g.p.y) * inward.y); half = Math.max(half, Math.abs((q.x - g.p.x) * u.x + (q.y - g.p.y) * u.y)); }
  // three zigzag walls, 9 m apart, the salients pointing to the town
  const per = 12, amp = 4.5;
  for (let k = 0; k < 3; k++) {
    const v0 = 6 + k * 9;
    if (v0 + amp > depth * 0.55) break;
    const pts: Vec2[] = [];
    for (let s = -half - per; s <= half + per; s += per / 2) {
      const tooth = (Math.round(s / (per / 2)) % 2 === 0) ? 0 : amp;
      pts.push({ x: g.p.x + u.x * s + inward.x * (v0 + amp - tooth), y: g.p.y + u.y * s + inward.y * (v0 + amp - tooth) });
    }
    // keep the runs inside the enceinte (2 m clear of its line)
    let run: Vec2[] = [];
    const flush = () => { if (run.length >= 3) out.lines.push({ kind: 'zigzag-wall', path: run, width: 2.4 }); run = []; };
    for (const q of pts) { if (pointInRing(Cin, q) && distToRing(Cin, q) > 2) run.push(q); else flush(); }
    flush();
  }
  const ang = Math.atan2(u.y, u.x);
  const far = { x: g.p.x + inward.x * depth * 0.72, y: g.p.y + inward.y * depth * 0.72 };
  const R0 = Math.max(6, Math.min(11, Math.sqrt(area(Cin)) * 0.07));
  const placed: Polygon[] = [];
  const add = (poly: Polygon | null, arch: string, storeys: number, roof: Out['buildings'][number]['roof']) => {
    if (!poly || !fits(Cin, poly, 1.5) || placed.some((p) => intersectionS(p, poly).length)) return false;
    placed.push(poly);
    out.buildings.push({ poly, kind: 'landmark', parcel: 0, arch, roof, material: 'stone', storeys, orientation: ang });
    return true;
  };
  add(orientPos(disk(far, R0, 20)), 'round-tower', 4, 'dome');
  out.landmarks.push({ kind: 'fortress', poly: plan.C });
  for (const sg of [-1, 1]) add(placeRect(Cin, { x: far.x + u.x * sg * (R0 + 16), y: far.y + u.y * sg * (R0 + 16) }, ang, 9, 6.5, 1.5), 'square-tower', 3, 'gable');
  // storehouses: a row behind the towers
  for (let i = -3; i <= 3; i++) {
    const c = { x: far.x + inward.x * (R0 + 12) + u.x * i * 9, y: far.y + inward.y * (R0 + 12) + u.y * i * 9 };
    add(rectAt(c, ang, -3.2, 3.2, -2.5, 2.5), 'qollqa', 1, 'gable');
  }
  out.lines.push({ kind: 'citadel-wall', path: Cin.concat([Cin[0]]), width: 2 });
  return out;
}

export { minus, pieces, mpArea };

/**
 * The outer wall of a double enceinte: the curtain polygon offset outward by d (each straight curtain shifted, mitred
 * corners, self-intersections resolved), with no stub curtain.
 */
export function outerRing(ring: Polygon, d: number): Polygon | null {
  const P = orientPos(ring), n = P.length;
  const lines = P.map((a, i) => {
    const b = P[(i + 1) % n], l = dist(a, b) || 1, dx = (b.x - a.x) / l, dy = (b.y - a.y) / l;
    return { px: a.x + dy * d, py: a.y - dx * d, dx, dy };
  });
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const A = lines[(i - 1 + n) % n], B = lines[i];
    const den = A.dx * B.dy - A.dy * B.dx;
    if (Math.abs(den) < 1e-6) { out.push({ x: B.px, y: B.py }); continue; }
    const t = ((B.px - A.px) * B.dy - (B.py - A.py) * B.dx) / den;
    const q = { x: A.px + A.dx * t, y: A.py + A.dy * t };
    // very sharp corners: bevel instead of a long spike
    if (dist(q, P[i]) > 3 * d) { out.push({ x: P[i].x + A.dy * d, y: P[i].y - A.dx * d }, { x: P[i].x + B.dy * d, y: P[i].y - B.dx * d }); continue; }
    out.push(q);
  }
  const u = unionS(out);
  if (!u.length) return null;
  const big = u.reduce((x, y) => (area(y.outer) > area(x.outer) ? y : x));
  if (!pointInRing(big.outer, polygonCentroid(P))) return null;
  return orientPos(removeStubs(cleanRing(big.outer, 0.3, 1), 9, () => false));
}
