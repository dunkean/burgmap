/**
 * Ring camps: a central space ringed by rows of round dwellings, each row fronting a ring path on its inner side.
 * - kraal (Southern African homestead, umuzi / ikhanda): beehive huts in a horseshoe around the cattle byre
 *   (isibaya, with the grain pits inside), raised granaries, the great hut at the top facing the entrance, which
 *   opens downslope through the thorn fence;
 * - tipi (Plains camp circle): one great circle of lodges open to the east, doors east, the council lodge in the
 *   middle of the circle, horse herds grazing outside;
 * - nomad (steppe ordu / küriyen): concentric rings of gers around the chief's fenced orda, four lanes, livestock
 *   pens in the outer ring.
 *
 * Partition: quarter = the camp disc; cuts = the ring paths (annuli) and the radial lanes; row blocks are cut into
 * plots by angular wedges from the centre (exact cells), one dwelling per plot; the centre block is the byre, the
 * green or the orda compound.
 */
import type { Vec2, Polygon } from '../../core/geom';
import { dist } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { Range } from '../morphology';
import { area, orientPos, pointInRing, inscribed } from '../../geo/poly';
import { unionS, MultiPoly } from '../../geo/bool';
import type { CampCtx } from './index';
import { downhill } from './index';
import {
  CampOut, emptyCamp, street, at, normA, circlePts, annulus, carveBlocks, pathRibbons, cutByCells, FrontIndex, hut, rect,
  fits, fitIn, openRing,
} from './kit';

export interface RingVariant {
  id: 'kraal' | 'tipi' | 'nomad';
  /** Inhabitants per dwelling. */
  per: number;
  hutR: Range;
  /** Plot width along the row (m) and row depth (m). */
  arc: Range;
  depth: number;
  pathW: number;
  entW: number;
  /** Opening of the rows (degrees) on the entrance side. */
  gap: number;
  /** Approximate outer radius for a population (cluster placement). */
  radius: (pop: number) => number;
}

const ringN = (r: number) => Math.max(48, Math.min(360, Math.round((2 * Math.PI * r) / 3.5)));

export const RING_VARIANTS: Record<string, RingVariant> = {
  kraal: { id: 'kraal', per: 4.5, hutR: [2.5, 3.1], arc: [9, 10.5], depth: 9.5, pathW: 3, entW: 4.5, gap: 22, radius: (p) => 22 + Math.sqrt(p * 9 / Math.PI) + Math.sqrt((p / 4.5) * 9.75 * 12.5 / Math.PI) },
  tipi: { id: 'tipi', per: 7.5, hutR: [2.3, 3.0], arc: [9, 12], depth: 10, pathW: 4, entW: 6, gap: 36, radius: (p) => 34 + ((p / 7.5) * 10.5) / (2 * Math.PI * 0.9 * (p > 520 ? 2 : 1)) },
  nomad: { id: 'nomad', per: 5.5, hutR: [2.6, 3.4], arc: [10.5, 12.5], depth: 10.5, pathW: 3.5, entW: 6, gap: 0, radius: (p) => 30 + Math.sqrt((p / 5.5) * 11.5 * 14 / Math.PI) },
};

/** Tipi footprint: slightly egg-shaped (wider at the back), the door side toward `door`. */
function tipi(c: Vec2, r: number, door: number): Polygon {
  const pts: Vec2[] = [];
  const n = 12;
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) / n) * 2 * Math.PI;
    // radius a little larger at the back (away from the door)
    const k = 1 + 0.08 * Math.cos(t - door - Math.PI);
    pts.push(at(c, t, r * k));
  }
  return orientPos(pts);
}

export function ringCamp(cc: CampCtx, c: Vec2, pop: number, v: RingVariant, rng: Rng): CampOut {
  const out = emptyCamp();
  const ctx = cc.ctx;
  const N = Math.max(5, Math.round(pop / v.per));
  // sprawl: dwellings further apart along the rows, deeper rows
  const sf = Math.log2(cc.sprawl);
  v = { ...v, arc: [v.arc[0] * (1 + 0.32 * sf), v.arc[1] * (1 + 0.32 * sf)], depth: v.depth * (1 + 0.15 * sf) };
  // ---- the opening: tipi circles open to the east; kraals open downslope (else toward the road); gers face south
  let alpha: number;
  if (v.id === 'tipi') alpha = 0;
  else if (v.id === 'nomad') alpha = Math.PI / 2;
  else alpha = downhill(ctx, c, 40) ?? (cc.main ? cc.roadAngle : rng.range(0, 2 * Math.PI));
  // irregular outline: one low-frequency warp of the polar radius shared by every ring (an oval, slightly lobed
  // homestead; a near-perfect camp circle), so rows stay parallel and the wedges stay exact rays
  const wr = rng.fork('warp');
  const ecc = v.id === 'kraal' ? (pop > 300 ? wr.range(0.08, 0.15) : wr.range(0.04, 0.08)) : v.id === 'tipi' ? wr.range(0.015, 0.035) : wr.range(0.03, 0.06);
  const ph2 = alpha + wr.range(-0.4, 0.4), ph3 = wr.range(0, 2 * Math.PI), a3 = wr.range(0.01, 0.025);
  const W = (t: number): number => 1 + ecc * Math.cos(2 * (t - ph2)) + a3 * Math.cos(3 * t + ph3);
  const P = (t: number, r: number): Vec2 => at(c, t, r * W(t));
  const wring = (r: number, n: number): Polygon => orientPos(Array.from({ length: n }, (_, i) => P((i / n) * 2 * Math.PI, r)));
  const wann = (r0: number, r1: number, n: number) => ({ outer: wring(r1, n), holes: [wring(r0, n)] });
  const gapF = (v.id === 'kraal' && pop < 300 ? 55 : v.gap) / 360;
  const arc = () => rng.range(v.arc[0], v.arc[1]);
  const arcM = (v.arc[0] + v.arc[1]) / 2;
  // ---- the centre
  let Rc: number;
  if (v.id === 'kraal') Rc = Math.max(10, Math.sqrt((pop * 0.8 * 9) / Math.PI));
  else if (v.id === 'nomad') Rc = Math.min(30, 15 + pop / 90);
  else {
    // one great circle (two rows for the largest camps): the circle's radius follows from the lodge count
    const rows = N > 160 ? 3 : N > 70 ? 2 : 1;
    const perRow = Math.ceil(N / rows);
    const mid = (perRow * arcM) / (2 * Math.PI * (1 - gapF));
    Rc = Math.max(18, mid - v.depth / 2 - v.pathW);
  }
  // ---- rows: inner edge a_k, dwelling count n_k (rows filled outward; the last one may be looser)
  const rows: { a: number; n: number }[] = [];
  let a = Rc + v.pathW, left = N;
  while (left > 0 && rows.length < 8) {
    const mid = a + v.depth / 2;
    const cap = Math.max(4, Math.floor((2 * Math.PI * mid * (1 - gapF)) / arcM));
    const take = Math.min(cap, left);
    rows.push({ a, n: take });
    left -= take;
    a += v.depth + v.pathW;
  }
  // a nearly empty outer row is folded into the others (denser rows rather than a scatter)
  if (rows.length > 1 && rows[rows.length - 1].n < 6) { const last = rows.pop()!; rows[rows.length - 1].n += last.n; }
  const Rout = rows[rows.length - 1].a + v.depth;
  const quarter = wring(Rout, ringN(Rout));
  out.quarters.push(quarter);
  out.outline.push(wring(Rout + (v.id === 'kraal' ? 4 : 2), ringN(Rout)));
  // ---- paths: one ring path inside each row, the entrance (and the lanes of a nomad camp)
  const cuts: MultiPoly = [];
  rows.forEach((row, k) => {
    const rho = row.a - v.pathW / 2;
    const n = ringN(row.a);
    const pl = wring(rho, n);
    out.streets.push(street(pl.concat([pl[0]]), v.pathW, 3, 'ring'));
    cuts.push(wann(row.a - v.pathW, row.a, n));
  });
  const rho0 = rows[0].a - v.pathW / 2;
  const radials: { ang: number; w: number; main: boolean }[] = [{ ang: alpha, w: v.entW, main: true }];
  if (v.id === 'nomad') for (const d of [1, 2, 3]) radials.push({ ang: alpha + (d * Math.PI) / 2, w: v.pathW + 0.5, main: false });
  const radialStreets = radials.map((r) => street([P(r.ang, Rout + 6), P(r.ang, rho0)], r.w, r.main ? 1 : 3, r.main ? 'radial' : 'lane'));
  out.streets.push(...radialStreets);
  const rb = pathRibbons(radialStreets);
  const allCuts = rb.length ? unionS(cuts, rb) : unionS(cuts);
  const blocks = carveBlocks(quarter, allCuts, ctx.water);
  const front = new FrontIndex(out.streets);
  // ---- the centre block and the row blocks
  let centreBi = -1;
  blocks.forEach((b, i) => { if (pointInRing(b, c)) centreBi = i; });
  if (centreBi < 0) blocks.forEach((b, i) => { if (centreBi < 0 && dist(inscribed(b, [], 1).c, c) < Rc) centreBi = i; });
  const rowOf = (b: Polygon): number => {
    const q = inscribed(b, [], 0.5).c;
    const r = dist(q, c) / W(Math.atan2(q.y - c.y, q.x - c.x));
    for (let k = rows.length - 1; k >= 0; k--) if (r >= rows[k].a - 0.5) return k;
    return -1;
  };
  // wedge cells per row (one per dwelling), the opening as one cell of its own
  const wedge = (t0: number, t1: number): Polygon => {
    const R = Rout * 2 + 50;
    const steps = Math.max(1, Math.ceil((t1 - t0) / 0.3));
    const pts: Vec2[] = [c];
    for (let i = 0; i <= steps; i++) pts.push(at(c, t0 + ((t1 - t0) * i) / steps, R));
    return orientPos(pts);
  };
  const cellsOf = rows.map((row, k) => {
    const cr = rng.fork('row:' + k);
    const span = 2 * Math.PI * (1 - gapF);
    const start = alpha + Math.PI * gapF + (v.gap ? 0 : cr.range(0, (2 * Math.PI) / row.n));
    const ws = Array.from({ length: row.n }, () => arc());
    const tot = ws.reduce((s, x) => s + x, 0);
    const bounds = [start];
    let acc = 0;
    for (const w of ws) { acc += w; bounds.push(start + (span * acc) / tot); }
    const cells: { poly: Polygon; tag: number }[] = [];
    for (let j = 0; j < row.n; j++) cells.push({ poly: wedge(bounds[j], bounds[j + 1]), tag: j });
    if (v.gap) cells.push({ poly: wedge(start + span, start + 2 * Math.PI), tag: -1 });
    return cells;
  });
  // the great hut / chief's lodge: row 0, opposite the entrance
  const topAng = normA(alpha + Math.PI);
  const pens = v.id === 'nomad' && rows.length >= 2;
  const lastRow = rows.length - 1;
  blocks.forEach((b, bi) => {
    if (bi === centreBi) return;
    const k = rowOf(b);
    const blockIdx = out.blocks.length;
    out.blocks.push({ poly: b, kind: 'block', quarter: 0 });
    if (k < 0) { out.parcels.push({ poly: b, use: 'green', block: blockIdx }); return; }
    const row = rows[k];
    const parts = cutByCells(b, cellsOf[k]);
    for (const pc of parts) {
      const pi = out.parcels.length;
      const fr = front.frontage(pc.poly);
      if (pc.tag < 0 || fr.len < 3.2) { out.parcels.push({ poly: pc.poly, use: 'green', block: blockIdx }); continue; }
      // the dwelling: on the inner side of the plot, at the middle of its angular span
      const ins = inscribed(pc.poly, [], 0.3);
      const th = Math.atan2(ins.c.y - c.y, ins.c.x - c.x);
      const pr = rng.fork('d:' + k + ':' + pc.tag + ':' + bi);
      const isPen = pens && k === lastRow && pc.tag % 3 === 1;
      // a few plots stay open (a cooking place, a small pen, a gap in the row)
      // (a Plains circle is made of band segments: a gap after every band of 7–13 lodges)
      const bandGap = v.id === 'tipi' && row.n > 14 && pc.tag % (7 + (k * 3 + bi) % 7) === 6;
      if (!isPen && (bandGap || pr.chance(v.id === 'tipi' ? 0.02 : 0.07))) { out.parcels.push({ poly: pc.poly, use: 'green', block: blockIdx }); continue; }
      if (isPen) {
        out.parcels.push({ poly: pc.poly, use: 'pen', block: blockIdx });
        out.lines.push({ kind: 'pen-fence', path: pc.poly.concat([pc.poly[0]]), width: 0.5 });
        continue;
      }
      out.parcels.push({ poly: pc.poly, use: 'plot', block: blockIdx });
      const great = k === 0 && Math.abs(normA(th - topAng + Math.PI) - Math.PI) < (Math.PI / row.n) * 1.05;
      let r = pr.range(v.hutR[0], v.hutR[1]) * (great ? 1.45 : 1);
      const placed: Polygon[] = [];
      const shape = (q: Vec2, s: number): Polygon => (v.id === 'tipi' ? tipi(q, r * s, 0) : hut(q, r * s, 14, th));
      let fp: Polygon | null = null;
      for (let tries = 0; tries < 3 && !fp; tries++) {
        const q = P(th, row.a + 1 + r + pr.range(0, v.id === 'kraal' ? 1.2 : 0.6));
        const cand = shape(q, 1);
        fp = fits(pc.poly, cand, [], 0.5, 0) ? cand : fitIn(pc.poly, shape, [], { margin: 0.5, gap: 0, minScale: 0.75, step: 2 });
        if (!fp) r *= 0.85;
      }
      if (!fp) { out.parcels[pi].use = 'green'; continue; }
      placed.push(fp);
      const arch = v.id === 'kraal' ? (great ? 'great-hut' : 'beehive-hut') : v.id === 'tipi' ? 'tipi' : 'ger';
      const roof = v.id === 'tipi' ? 'conical' : v.id === 'kraal' ? 'thatch-round' : 'dome';
      const material = v.id === 'tipi' ? 'hide' : v.id === 'kraal' ? 'thatch' : 'felt';
      out.buildings.push({ poly: fp, kind: 'house', parcel: pi, arch, roof, storeys: 1, material, orientation: v.id === 'tipi' ? 0 : th + Math.PI });
      // outbuildings: a raised granary behind the kraal hut, a cart or store tent behind the ger
      if (v.id === 'kraal' && pr.chance(great ? 1 : 0.55)) {
        const g = fitIn(pc.poly, (q, s) => hut(q, 1.3 * s, 8), placed, { margin: 0.4, gap: 0.8, minScale: 0.85, cands: [P(th + pr.range(-0.04, 0.04), row.a + v.depth - 1.9), P(th + 0.06, row.a + v.depth - 1.9), P(th - 0.06, row.a + v.depth - 1.9)] });
        if (g) { placed.push(g); out.buildings.push({ poly: g, kind: 'outbuilding', parcel: pi, arch: 'raised-granary', roof: 'thatch-round', storeys: 1, material: 'thatch' }); }
      }
      if (v.id === 'nomad' && pr.chance(0.45)) {
        const g = fitIn(pc.poly, (q, s) => rect(q, th + Math.PI / 2, 3.4 * s, 2.2 * s), placed, { margin: 0.4, gap: 0.8, minScale: 0.9, cands: [P(th, row.a + v.depth - 1.8)] });
        if (g) { placed.push(g); out.buildings.push({ poly: g, kind: 'outbuilding', parcel: pi, arch: 'store-tent', roof: 'gable', storeys: 1, material: 'felt' }); }
      }
      if (great) out.sites.push({ id: 'great-hut', kind: v.id === 'kraal' ? 'great-hut' : 'chief-lodge', role: 'power', lot: pc.poly, anchor: ins.c });
    }
  });
  // ---- the centre: byre, green with the council lodge, or the orda
  if (centreBi >= 0) {
    const b = blocks[centreBi];
    const bi = out.blocks.length;
    if (v.id === 'kraal') {
      out.blocks.push({ poly: b, kind: 'compound', compound: 'cattle-kraal', quarter: 0 });
      out.parcels.push({ poly: b, use: 'compound:cattle-kraal', block: bi });
      const pi = out.parcels.length - 1;
      // the byre fence (stout posts), its gate toward the homestead entrance; grain pits inside near the gate
      const fr = Rc - 0.8;
      const fence = wring(fr, ringN(fr));
      out.lines.push(...openRing(fence, [{ p: P(alpha, fr), width: 3.5 }]).map((pl) => ({ kind: 'kraal-fence', path: pl, width: 1.1 })));
      const placed: Polygon[] = [];
      const pits = Math.max(2, Math.min(9, Math.round(pop / 60)));
      const pr = rng.fork('pits');
      for (let k = 0; k < pits; k++) {
        const g = fitIn(b, (q, s) => hut(q, 1.15 * s, 8), placed, { margin: 2, gap: 1.2, minScale: 0.95, cands: [at(c, alpha + pr.range(-0.6, 0.6), pr.range(0.25, 0.65) * Rc)] });
        if (g) { placed.push(g); out.buildings.push({ poly: g, kind: 'pit', parcel: pi, arch: 'grain-pit', roof: 'none', storeys: 0, material: 'earth' }); }
      }
      // calf pens against the fence at the top
      if (Rc > 16) {
        const cp = orientPos(circlePts(at(c, topAng, Rc * 0.62), Math.min(7, Rc * 0.22), 16));
        if (cp.every((q) => pointInRing(b, q))) out.lines.push({ kind: 'pen-fence', path: cp.concat([cp[0]]), width: 0.6 });
      }
      out.sites.push({ id: 'cattle-kraal', kind: 'cattle-kraal', role: 'civic', lot: b, anchor: c });
      out.landmarks.push({ kind: 'cattle-kraal', poly: b });
    } else if (v.id === 'tipi') {
      out.blocks.push({ poly: b, kind: 'block', quarter: 0 });
      out.parcels.push({ poly: b, use: 'commons', block: bi });
      const pi = out.parcels.length - 1;
      // the council lodge (two lodge covers joined) in the middle of the circle, door east
      const big = Math.min(7.5, 4.5 + pop / 200);
      const lodge = fitIn(b, (q, s) => tipi(q, big * s, 0), [], { margin: 2, gap: 0, minScale: 0.6, cands: [c] });
      if (lodge) {
        out.buildings.push({ poly: lodge, kind: 'landmark', parcel: pi, arch: 'council-lodge', roof: 'conical', storeys: 1, material: 'hide', orientation: 0 });
        out.landmarks.push({ kind: 'council-lodge', poly: lodge });
        out.sites.push({ id: 'council-lodge', kind: 'council-lodge', role: 'civic', lot: b, anchor: c });
      }
      out.squares.push(b);
    } else {
      out.blocks.push({ poly: b, kind: 'compound', compound: 'orda', quarter: 0 });
      out.parcels.push({ poly: b, use: 'compound:orda', block: bi });
      const pi = out.parcels.length - 1;
      const fr = Rc - 1.2;
      const fence = wring(fr, ringN(fr));
      out.lines.push(...openRing(fence, [{ p: P(alpha, fr), width: 4 }]).map((pl) => ({ kind: 'orda-fence', path: pl, width: 0.9 })));
      const placed: Polygon[] = [];
      const R0 = Math.min(7.5, Math.max(5, Rc * 0.3));
      const chief = fitIn(b, (q, s) => hut(q, R0 * s, 18), [], { margin: 2.5, gap: 0, minScale: 0.6, cands: [at(c, alpha + Math.PI, Rc * 0.18)] });
      if (chief) {
        placed.push(chief);
        out.buildings.push({ poly: chief, kind: 'landmark', parcel: pi, arch: 'chief-ger', roof: 'dome', storeys: 1, material: 'felt', orientation: alpha });
        out.landmarks.push({ kind: 'chief-ger', poly: chief });
        out.sites.push({ id: 'orda', kind: 'orda', role: 'power', lot: b, anchor: c });
      }
      // the wives' and guards' gers in an arc behind the chief's
      const pr = rng.fork('orda');
      for (let k = 0; k < 5; k++) {
        const ang = alpha + Math.PI + (k - 2) * 0.55;
        const g = fitIn(b, (q, s) => hut(q, 3 * s, 14), placed, { margin: 2.2, gap: 1.6, minScale: 0.8, cands: [at(c, ang, Rc * pr.range(0.55, 0.68))] });
        if (g) { placed.push(g); out.buildings.push({ poly: g, kind: 'house', parcel: pi, arch: 'ger', roof: 'dome', storeys: 1, material: 'felt' }); }
      }
    }
  }
  // ---- fences: the kraal's thorn fence round the huts, open at the entrance
  if (v.id === 'kraal') {
    const R = Rout + 1.6;
    const fence = wring(R, ringN(R));
    out.lines.push(...openRing(fence, [{ p: P(alpha, R), width: v.entW + 1.5 }]).map((pl) => ({ kind: 'thorn-fence', path: pl, width: 2.2 })));
  }
  // horse herds of a Plains camp graze outside the circle, away from the opening
  if (v.id === 'tipi' && cc.main) {
    const hr = rng.fork('herds');
    for (let k = 0; k < Math.min(4, 1 + Math.floor(pop / 250)); k++) {
      const ang = alpha + Math.PI * hr.range(0.45, 1.55);
      const p = P(ang, Rout + hr.range(45, 110));
      if (ctx.isWater(p)) continue;
      const herd: Polygon = orientPos(circlePts(p, hr.range(22, 38), 20).map((q, i) => ({ x: p.x + (q.x - p.x) * (1 + 0.18 * Math.sin(i * 2.1)), y: p.y + (q.y - p.y) * (0.75 + 0.15 * Math.cos(i * 1.7)) })));
      out.landmarks.push({ kind: 'horse-herd', poly: herd });
    }
  }
  void area;
  return out;
}
