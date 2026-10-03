/**
 * Iroquoian palisaded village (Draper, Mantle, Kanata, Ganondagan): parallel bark longhouses of 20–60 m inside a
 * double palisade, an open plaza, cornfields around.
 *
 * Partition: quarter = the oval inside the palisade. Lanes run across the oval at the ends of the house rows (the
 * longhouses open at their gable ends); they cut the oval into bands; each band is cut into strips by lines along
 * the house axis (one strip per longhouse, 9–15 m wide). A longhouse with rounded ends fills its strip less a
 * margin, so its length follows the band (20–60 m, shorter at the ends of the oval). Two strips in the middle stay
 * open: the plaza. Gates are where lanes meet the palisade, nearest the road.
 */
import type { Vec2, Polygon } from '../../core/geom';
import { dist } from '../../core/geom';
import type { Rng } from '../../core/rng';
import { area, orientPos, pointInRing, inscribed } from '../../geo/poly';
import { MultiPoly, differenceS, intersectionS } from '../../geo/bool';
import type { CampCtx } from './index';
import { CampOut, emptyCamp, street, ellipse, carveBlocks, pathRibbons, cutByCells, FrontIndex, apsidal, hut, fitIn, rect, pieces } from './kit';
import { wallFeatures } from '../walls';
import { Noise2D } from '../../core/noise';

export function longhouseVillage(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  const out = emptyCamp();
  const ctx = cc.ctx;
  const NL = Math.max(2, Math.round(pop / 42));
  const sr = rng.fork('shape');
  // ---- the oval: sized for the house slots (house + lane share) and the plaza
  const sf = Math.log2(cc.sprawl);
  const slot = 40 * 12.5 * (1 + 0.3 * sf);
  const A = (NL + 2.5) * slot * 1.25;
  const aspect = sr.range(1.25, 1.6);
  const a = Math.sqrt((A * aspect) / Math.PI), b = Math.sqrt(A / (Math.PI * aspect));
  // houses along the oval's long axis (roughly NW–SE, along the prevailing wind) unless the road says otherwise
  const ang = -Math.PI / 4 + sr.range(-0.35, 0.35);
  const nz = new Noise2D(sr.fork('noise'));
  const wob = (t: number) => 0.05 * nz.noise(Math.cos(t) * 1.2 + 3, Math.sin(t) * 1.2 + 3);
  const oval = ellipse(c, a, b, ang, 96, wob);
  out.quarters.push(oval);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const U = (p: Vec2) => (p.x - c.x) * ca + (p.y - c.y) * sa;
  const V = (p: Vec2) => -(p.x - c.x) * sa + (p.y - c.y) * ca;
  const P = (u: number, v: number): Vec2 => ({ x: c.x + u * ca - v * sa, y: c.y + u * sa + v * ca });
  // ---- bands along u (row lengths 26–58 m), lanes between them
  const laneW = 4.2;
  const span = 2 * a * 1.06;
  const K = Math.max(1, Math.round(span / 46));
  const lens = Array.from({ length: K }, () => sr.range(0.8, 1.2));
  const tl = lens.reduce((s, x) => s + x, 0);
  const cuts: number[] = [];
  let acc = -span / 2;
  for (let k = 0; k < K - 1; k++) { acc += (span * lens[k]) / tl; cuts.push(acc); }
  const lanes = cuts.map((u) => street([P(u, -b * 1.4), P(u, b * 1.4)], laneW, 3, 'lane'));
  // a path along the axis joins the lanes (between the two middle rows of houses), and the gate paths
  const axisV = sr.range(-0.12, 0.12) * b;
  const axis = street([P(-a * 1.2, axisV), P(a * 1.2, axisV)], 3.6, 3, 'street');
  // ---- gates: lane ends (and the axis ends) nearest the roads
  const roadsIn = cc.roads.filter((pl) => dist(pl[pl.length - 1], ctx.center) < 15);
  const ends: { p: Vec2; s: number }[] = [];
  const edgeAlong = (u0: number, v0: number, du: number, dv: number): Vec2 => {
    let lo = 0, hi = Math.max(a, b) * 2;
    for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (pointInRing(oval, P(u0 + du * m, v0 + dv * m))) lo = m; else hi = m; }
    return P(u0 + du * lo, v0 + dv * lo);
  };
  for (const u of cuts) for (const dv of [-1, 1]) ends.push({ p: edgeAlong(u, 0, 0, dv), s: 0 });
  for (const du of [-1, 1]) ends.push({ p: edgeAlong(0, axisV, du, 0), s: 0 });
  for (const e of ends) {
    let d = 1e9;
    for (const pl of roadsIn) for (const q of pl) d = Math.min(d, dist(q, e.p));
    e.s = d;
  }
  ends.sort((x, y) => x.s - y.s);
  const gates = ends.slice(0, pop > 400 ? 2 : 1).map((e) => e.p);
  const streets = [...lanes, axis];
  out.streets.push(...streets);
  // the main path: the gate end of its lane / axis is the radial (rank 1)
  const gateStreets = gates.map((g) => street([g, { x: c.x + (g.x - c.x) * 1.12, y: c.y + (g.y - c.y) * 1.12 }], 4.5, 1, 'radial'));
  out.streets.push(...gateStreets);
  const rib = pathRibbons([...streets, ...gateStreets]);
  const front = new FrontIndex(out.streets);
  // ---- blocks (half-bands) cut into house strips along u
  const blocks = carveBlocks(oval, rib, ctx.water);
  const hr = rng.fork('houses');
  let houses = 0;
  const plazaBand = Math.floor(K / 2);
  const bandOf = (p: Vec2): number => { const u = U(p); let k = 0; for (const cu of cuts) if (u > cu) k++; return k; };
  blocks.forEach((blk, bi0) => {
    const bi = out.blocks.length;
    out.blocks.push({ poly: blk, kind: 'block', quarter: 0 });
    const ic = inscribed(blk, [], 0.5).c;
    const k = bandOf(ic);
    const side = V(ic) > axisV ? 1 : -1;
    // strips: from the axis outward, each a house width plus its eaves gap (exact cells: rectangles in u × v)
    const cellsK: { poly: Polygon; tag: number }[] = [];
    let v0 = axisV - side * 3;
    for (let j = 0; Math.abs(v0 - axisV) < b * 1.3 && j < 40; j++) {
      const v1 = (j === 0 ? axisV : v0) + side * ((j === 0 ? 1.8 : 0) + hr.range(9.5, 14) * (1 + 0.3 * sf));
      const lo = Math.min(v0, v1), hi = Math.max(v0, v1);
      cellsK.push({ poly: orientPos([P(-a * 1.5, lo), P(a * 1.5, lo), P(a * 1.5, hi), P(-a * 1.5, hi)]), tag: j });
      v0 = v1;
    }
    for (const pc of cutByCells(blk, cellsK)) {
      const pi = out.parcels.length;
      const fr = front.frontage(pc.poly);
      // the plaza: the strips nearest the axis in the middle band, on one side
      if (k === plazaBand && side === 1 && pc.tag <= (NL > 10 ? 1 : 0) && K >= 1 && NL > 3) { out.parcels.push({ poly: pc.poly, use: 'meadow', block: bi }); out.squares.push(pc.poly); continue; }
      if (fr.len < 3.2) { out.parcels.push({ poly: pc.poly, use: 'garden', block: bi }); continue; }
      out.parcels.push({ poly: pc.poly, use: 'plot', block: bi });
      // the longhouse: along u, filling the strip less the lane margins (20–60 m)
      const us = pc.poly.map(U), vs = pc.poly.map(V);
      const u0 = Math.min(...us), u1 = Math.max(...us), vm = (Math.min(...vs) + Math.max(...vs)) / 2;
      const W = hr.range(6.2, 7.6);
      const L = Math.min(60, u1 - u0 - 4);
      const um = (u0 + u1) / 2 + hr.range(-1, 1);
      const lh = L >= 20 ? fitIn(pc.poly, (q, s) => apsidal(q, ang, Math.max(20, L * s), W, 4), [], { margin: 0.8, gap: 0, minScale: 0.45, cands: [P(um, vm), P(um - 3, vm), P(um + 3, vm)] }) : null;
      if (lh) {
        out.buildings.push({ poly: lh, kind: 'house', parcel: pi, arch: 'longhouse', roof: 'barrel', storeys: 1, material: 'bark', orientation: ang });
        houses++;
      } else {
        // a short strip at the end of the oval: a storage hut or a sweat lodge
        const g = fitIn(pc.poly, (q, s) => (hr.chance(0.5) ? hut(q, 2.4 * s, 10) : rect(q, ang, 5 * s, 4 * s)), [], { margin: 0.8, gap: 0, minScale: 0.8 });
        if (g) out.buildings.push({ poly: g, kind: 'outbuilding', parcel: pi, arch: g.length > 4 ? 'sweat-lodge' : 'storage-hut', roof: 'dome', storeys: 1, material: 'bark' });
      }
    }
    void bi0;
  });
  // ---- the double palisade (two rows of posts 3–4 m apart), open at the gates
  const gs = gates.map((g) => ({ p: g, width: 4 }));
  for (const [off, th] of [[1.6, 1], [5.2, 0.8]] as const) {
    const ring = ellipse(c, a + off, b + off, ang, 96, wob);
    const gg = gs.map((g) => ({ p: nearest(ring, g.p), width: g.width + off * 0.6 }));
    const wf = wallFeatures(ring, gg, rng.fork('pal' + off), ctx.isWater, () => false, 1e9);
    out.walls.push({ path: ring, closed: true, towers: [], gates: gg.map((g) => g.p), thickness: th, gateInfo: gg.map((g) => ({ p: g.p, dir: { x: (c.x - g.p.x) / (dist(c, g.p) || 1), y: (c.y - g.p.y) / (dist(c, g.p) || 1) }, width: g.width })), pieces: wf.pieces, gateTowers: [], towerScale: [], curtains: [], towerShape: 'round', role: 'town' });
  }
  out.outline.push(ellipse(c, a + 8, b + 8, ang, 96, wob));
  // ---- cornfields round the village (the main village only): irregular clearings of corn hills
  if (cc.main) {
    const fr = rng.fork('fields');
    const Rf0 = Math.max(a, b) + 25, Rf1 = Rf0 + Math.min(260, 70 + pop * 0.22);
    let ringM: MultiPoly = [{ outer: ellipse(c, a + Rf1 - Math.max(a, b), b + Rf1 - Math.max(a, b), ang, 64), holes: [ellipse(c, a + Rf0 - Math.max(a, b), b + Rf0 - Math.max(a, b), ang, 64)] }];
    if (ctx.water.length) ringM = differenceS(ringM, ctx.water);
    const roadRb = cc.roads.map((pl) => pathRibbons([street(pl, 14, 1, 'radial')])).flat();
    if (roadRb.length) ringM = differenceS(ringM, roadRb);
    const nF = 4 + fr.int(0, 3);
    const R0 = Math.max(a, b);
    for (let k = 0; k < nF; k++) {
      // an irregular clearing: an annular sector with wobbly inner and outer edges
      if (fr.chance(0.25)) continue;
      const w = (2 * Math.PI) / nF;
      const t0 = k * w + fr.range(0.04, 0.35) * w, t1 = (k + 1) * w - fr.range(0.04, 0.3) * w;
      const r0 = Rf0 + fr.range(0, 40), r1 = r0 + (Rf1 - Rf0) * fr.range(0.4, 1);
      const ph = fr.range(0, 6);
      const outerE: Vec2[] = [], innerE: Vec2[] = [];
      for (let i = 0; i <= 12; i++) {
        const t = t0 + ((t1 - t0) * i) / 12;
        const wo = 1 + 0.12 * Math.sin(t * 5 + ph) + 0.06 * Math.sin(t * 11 + ph * 2);
        outerE.push({ x: c.x + Math.cos(t) * r1 * wo, y: c.y + Math.sin(t) * r1 * wo });
        innerE.push({ x: c.x + Math.cos(t) * r0, y: c.y + Math.sin(t) * r0 });
      }
      const sector = orientPos(outerE.concat(innerE.reverse()));
      for (const p of pieces(intersectionS(ringM, sector), 2500)) {
        if (p.some((q) => ctx.slopeAt(q) > 0.3)) continue;
        out.landmarks.push({ kind: 'cornfield', poly: p });
      }
    }
    void R0;
  }
  out.sites.push({ id: 'palisade', kind: 'palisaded-village', role: 'power', lot: oval, anchor: c, tags: { longhouses: String(houses) } });
  void area;
  return out;
}

function nearest(ring: Polygon, p: Vec2): Vec2 {
  let best = ring[0], bd = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = dist(q, p);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}
