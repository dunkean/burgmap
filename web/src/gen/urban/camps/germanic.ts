/**
 * Germanic villages of the Roman Iron Age and the Migration period, two plans:
 * - the street village (Vorbasse, Flögeln): fenced farmyards in rows on both sides of a village street, the
 *   houses parallel to it (roughly east–west); one, two or four arms from the thing place, which opens where they
 *   meet; the chief's yard by the place, two or three times the size of the others;
 * - the wurt (Feddersen Wierde): on wet lowland by the water, the farms stand on an artificial mound round an open
 *   central place, the houses radial with their gables to it; the Herrenhof (the chief's yard) apart on its side.
 * Yards are sized by the household hierarchy: the longhouse length (11–48 m) sets the yard's frontage, its status
 * the depth; ordinary farms, large farms and cottars mix along the rows.
 *
 * Partition: the quarter is the union of the yard cells (and the place, and the street ribbons); blocks = quarter \
 * street ribbons; lots = block ∩ yard cell (exact convex cells: each arm's yards are clipped to its sector).
 */
import type { Vec2, Polygon } from '../../core/geom';
import { dist } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { UrbanStreet } from '../../types';
import { area, orientPos, pointInRing, inscribed, bboxOf, isSimple } from '../../geo/poly';
import { unionS, differenceS, unionMany, MultiPoly } from '../../geo/bool';
import type { CampCtx } from './index';
import { Curv, roadPolylines, wanderLine, snapRing, CampOut, emptyCamp, street, carveBlocks, pathRibbons, cutByCells, FrontIndex, mergeSmall, at, hachures, pieces } from './kit';
import { statusLadder, houseSize, fillFarm, fences, Status } from './farms';
import { Noise2D } from '../../core/noise';

/** Share of water samples round p within radius R (rings at R/3, 2R/3, R). */
export function wetness(cc: CampCtx, p: Vec2, R: number): number {
  let w = 0, n = 0;
  for (const f of [1 / 3, 2 / 3, 1]) for (let k = 0; k < 24; k++) {
    const q = at(p, (k / 24) * 2 * Math.PI, R * f);
    n++;
    if (cc.ctx.isWater(q)) w++;
  }
  return w / n;
}

export type GermanicForm = 'street' | 'wurt';

export function germanicVillage(cc: CampCtx, c: Vec2, pop: number, rng: Rng, form?: GermanicForm): CampOut {
  const wet = wetness(cc, c, 260);
  // (a wurt holds up to ~30 farms: a larger village by the water spreads along its streets)
  const f = form ?? (wet > 0.04 && pop >= 120 && pop <= 340 ? 'wurt' : 'street');
  return f === 'wurt' ? wurtVillage(cc, c, pop, rng) : streetVillage(cc, c, pop, rng);
}

const yardDepth = (s: Status, r: Rng): number => [r.range(62, 78), r.range(46, 58), r.range(36, 48), r.range(24, 32)][s];

/**
 * The street village: rows of fenced yards on both sides of the village street (the regional roads through the
 * place, else a street along the main direction), side lanes branching off it as the village grows.
 */
function streetVillage(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  const out = emptyCamp();
  const ctx = cc.ctx;
  const sk = Math.sqrt(cc.sprawl);
  const nF = Math.max(2, Math.round(pop / 12));
  const sr = rng.fork('status');
  const st = statusLadder(nF, sr);
  const yards = st.map((s) => {
    const { L } = houseSize(s, 'germanic', sr);
    return { s, L, w: (L + sr.range(9, 17) + (s === 0 ? 16 : s === 1 ? 6 : 0)) * sk, D: yardDepth(s, sr) * sk };
  });
  const sw = 5, lw = 4;
  const Rp = Math.min(28, 8 + nF * 0.4);
  const cap = nF <= 8 ? 4 : nF <= 20 ? 6 : 7;
  const ar = rng.fork('arms');
  const dryAlong = (pl: Vec2[]): number => {
    let ok = 0, n = 0;
    const cv = new Curv(pl);
    for (let s = Rp; s <= cv.L; s += 12) for (const v of [-30, 0, 30]) {
      const p = cv.at(s), nn = cv.normal(s);
      const q = { x: p.x + nn.x * v, y: p.y + nn.y * v };
      n++;
      if (!ctx.isWater(q) && ctx.slopeAt(q) < 0.2 && q.x > 20 && q.y > 20 && q.x < ctx.mapSize - 20 && q.y < ctx.mapSize - 20) ok++;
    }
    return n ? ok / n : 0;
  };
  // ---- the ways: the roads through the place; else (and to make a through street) wandering streets
  interface Row { side: 1 | -1; list: number[]; s: number[]; len: number }
  interface Way { cv: Curv; s0: number; w: number; branch: boolean; rows: [Row, Row] }
  const ways: Way[] = [];
  const mkWay = (pl: Vec2[], s0: number, w: number, branch: boolean): Way => {
    const way: Way = { cv: new Curv(pl), s0, w, branch, rows: [{ side: 1, list: [], s: [], len: 0 }, { side: -1, list: [], s: [], len: 0 }] };
    ways.push(way);
    return way;
  };
  const est = (yards.reduce((a, y) => a + y.w, 0) / 4) + Rp + 40;
  for (const pl of roadPolylines(cc, c, Math.min(400, est)).slice(0, 3)) mkWay(pl, Rp + 1, sw, false);
  const a0 = cc.main ? cc.roadAngle : Math.atan2(ctx.center.y - c.y, ctx.center.x - c.x);
  const angGap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  const dirOfWay = (w: Way) => { const q = w.cv.at(Math.min(60, w.cv.L)); return Math.atan2(q.y - c.y, q.x - c.x); };
  while (ways.length < 2) {
    const base = ways.length ? dirOfWay(ways[0]) + Math.PI : a0;
    let best: Vec2[] | null = null, bs = -Infinity;
    for (const d of [0, -0.25, 0.25, -0.5, 0.5]) {
      const a = base + d + ar.range(-0.12, 0.12);
      if (ways.some((w) => angGap(a, dirOfWay(w)) < 1.2)) continue;
      const pl = wanderLine(c, a, est, ar, 18, 0.06);
      const sc = dryAlong(pl) - Math.abs(d) * 0.2;
      if (sc > bs) { bs = sc; best = pl; }
    }
    if (!best) break;
    mkWay(best, Rp + 1, sw, false);
  }
  // ---- the yards along the rows: the chief's by the place, the others to the shortest row; side lanes when full
  const push = (row: Row, w: Way, yi: number) => { row.s.push(w.s0 + row.len); row.list.push(yi); row.len += yards[yi].w; };
  push(ways[0].rows[0], ways[0], 0);
  const order = yards.map((_, i) => i).slice(1);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(ar.float() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const usedBranch = new Set<string>();
  for (const yi of order) {
    let best: { row: Row; w: Way } | null = null;
    for (const w of ways) for (const row of w.rows) if (row.list.length < cap && (!best || row.len < best.row.len)) best = { row, w };
    if (!best) {
      // a side lane from a full row (at a yard boundary, away from the place), else longer rows
      const cands: { w: Way; row: Row; j: number }[] = [];
      for (const w of ways) for (const row of w.rows) for (let j = 2; j < row.list.length; j++) {
        const key = (k: number) => ways.indexOf(w) + ':' + row.side + ':' + k;
        if (!usedBranch.has(key(j)) && !usedBranch.has(key(j - 1)) && !usedBranch.has(key(j + 1))) cands.push({ w, row, j });
      }
      if (cands.length) {
        const pick = cands[Math.floor(ar.float() * cands.length)];
        usedBranch.add(ways.indexOf(pick.w) + ':' + pick.row.side + ':' + pick.j);
        const s = pick.row.s[pick.j];
        const o = pick.w.cv.at(s), nn = pick.w.cv.normal(s);
        const a = Math.atan2(nn.y * pick.row.side, nn.x * pick.row.side) + ar.range(-0.45, 0.45);
        const depth = Math.max(yards[pick.row.list[pick.j - 1]].D, yards[pick.row.list[pick.j]].D) + sw / 2 + 2;
        const bw = mkWay(wanderLine(o, a, est, ar, 16, 0.08), depth, lw, true);
        best = { row: bw.rows[0], w: bw };
      } else for (const w of ways) for (const row of w.rows) if (!best || row.len < best.row.len) best = { row, w };
    }
    push(best!.row, best!.w, yi);
  }
  // ---- cells: skewed quadrilaterals along each row (curvilinear frame of its way), disjoint by priority
  const sk2 = rng.fork('skew');
  const rot = (v: Vec2, a: number): Vec2 => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });
  const nz = new Noise2D(rng.fork('place'));
  const place = orientPos(Array.from({ length: 18 }, (_, i) => { const t = (i / 18) * 2 * Math.PI; return at(c, t, (Rp + 2) * (1 + 0.12 * nz.noise(Math.cos(t) + 3, Math.sin(t) + 3))); }));
  const cells: { poly: Polygon; tag: number }[] = [];
  const prev: { poly: Polygon; bb: ReturnType<typeof bboxOf> }[] = [{ poly: place, bb: bboxOf(place) }];
  const wayOf = new Map<number, Way>();
  for (const w of ways) for (const row of w.rows) {
    let phi = 0;
    row.list.forEach((yi, j) => {
      const y = yards[yi];
      const sa = row.s[j], sb = sa + y.w;
      const phi2 = sk2.range(-0.12, 0.12);
      const V = sw / 2 + y.D;
      const A = w.cv.at(sa), B = w.cv.at(sb);
      const S = row.side;
      const na = rot(w.cv.normal(sa), phi * S), nb = rot(w.cv.normal(sb), phi2 * S);
      let q: Polygon = [A, B, { x: B.x + nb.x * V * S, y: B.y + nb.y * V * S }, { x: A.x + na.x * V * S, y: A.y + na.y * V * S }];
      phi = phi2;
      if (!isSimple(q)) return;
      q = orientPos(q.map((p) => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 })));
      const bb = bboxOf(q);
      const near = prev.filter((p) => !(p.bb.x0 > bb.x1 || p.bb.x1 < bb.x0 || p.bb.y0 > bb.y1 || p.bb.y1 < bb.y0));
      let poly: Polygon | null = q;
      if (near.length) {
        const ps = pieces(differenceS([{ outer: q, holes: [] }], ...near.map((p): MultiPoly => [{ outer: p.poly, holes: [] }])), 20);
        poly = ps.length ? ps.reduce((a2, b2) => (area(b2) > area(a2) ? b2 : a2)) : null;
        if (poly && area(poly) < area(q) * 0.45) poly = null;
      }
      if (!poly) return;
      cells.push({ poly, tag: yi });
      prev.push({ poly, bb: bboxOf(poly) });
      wayOf.set(yi, w);
    });
  }
  // ---- streets: each way from its origin to past its last yard
  const streets: UrbanStreet[] = [];
  ways.forEach((w, k) => {
    if (!w.rows[0].list.length && !w.rows[1].list.length) return;
    const end = w.s0 + Math.max(w.rows[0].len, w.rows[1].len) + 8;
    streets.push(street(w.cv.slice(0, end), w.w + (k === 0 ? 0.6 : 0), w.branch ? 3 : k === 0 ? 1 : 2, w.branch ? 'lane' : 'radial'));
  });
  out.streets.push(...streets);
  const rib = pathRibbons(streets);
  const Qm: MultiPoly = unionMany([[{ outer: place, holes: [] }], ...cells.map((x): MultiPoly => [{ outer: x.poly, holes: [] }]), ...rib.map((r): MultiPoly => [r])], 24, true);
  const quarters = pieces(Qm, 200).map(snapRing);
  const front = new FrontIndex(out.streets);
  const yardRings: { ring: Polygon; gates: { p: Vec2; width: number }[] }[] = [];
  const fr0 = rng.fork('farms');
  const seen = new Set<number>();
  for (const Q of quarters) {
    const qi = out.quarters.length;
    out.quarters.push(Q); out.outline.push(Q);
    const qbb = bboxOf(Q);
    const qCells = cells.filter((x) => { const b = bboxOf(x.poly); return !(b.x0 > qbb.x1 || b.x1 < qbb.x0 || b.y0 > qbb.y1 || b.y1 < qbb.y0); });
    for (const blk of carveBlocks(Q, rib, ctx.water)) {
      const bi = out.blocks.length;
      out.blocks.push({ poly: blk, kind: 'block', quarter: qi });
      let parts = cutByCells(blk, qCells);
      const A = area(blk), S = parts.reduce((s2, p) => s2 + area(p.poly), 0);
      if (S < A * 0.997) {
        const rest = pieces(parts.length ? differenceS([{ outer: blk, holes: [] }], ...parts.map((p): MultiPoly => [{ outer: p.poly, holes: [] }])) : [{ outer: blk, holes: [] }], 0.5);
        parts = mergeSmall([...parts, ...rest.map((poly) => ({ poly, tag: -1 }))]);
      }
      // (a yard cut by a side lane: its largest piece is the farm, the rest garden)
      parts.sort((p, q) => area(q.poly) - area(p.poly));
      for (const pc of parts) {
        const pi = out.parcels.length;
        const fr = front.frontage(pc.poly);
        const ic = inscribed(pc.poly, [], 1).c;
        const inPlace = pointInRing(place, ic);
        if (pc.tag < 0 || inPlace) {
          out.parcels.push({ poly: pc.poly, use: inPlace || dist(ic, c) < Rp * 2.2 ? 'meadow' : 'garden', block: bi });
          continue;
        }
        if (seen.has(pc.tag) || fr.len < 3.2 || area(pc.poly) < 150) { out.parcels.push({ poly: pc.poly, use: 'garden', block: bi }); continue; }
        seen.add(pc.tag);
        out.parcels.push({ poly: pc.poly, use: 'plot', block: bi });
        const y = yards[pc.tag];
        const w = wayOf.get(pc.tag)!;
        // the house parallel to its street
        let sBest = 0, dBest = Infinity;
        for (let s = 0; s < w.cv.L + 40; s += 4) { const d = dist(w.cv.at(s), ic); if (d < dBest) { dBest = d; sBest = s; } }
        const n = w.cv.normal(sBest);
        const axis = Math.atan2(n.x, -n.y);
        fillFarm(out, pi, pc.poly, y.s, { kind: 'germanic', axis, fence: 'yard-fence', L: y.L }, fr.mid, fr0.fork('f' + pc.tag));
        yardRings.push({ ring: pc.poly, gates: fr.mid ? [{ p: fr.mid, width: y.s === 0 ? 5 : 3.5 }] : [] });
        if (y.s === 0) out.sites.push({ id: 'chief', kind: 'chieftain-farm', role: 'power', lot: pc.poly, anchor: ic });
      }
    }
  }
  out.lines.push(...fences(yardRings, 'yard-fence', 0.4));
  // the thing place: an old tree in the middle
  out.trees = out.trees ?? [];
  out.trees.push({ x: c.x + Rp * 0.35, y: c.y - Rp * 0.3, r: Math.min(7, 3.5 + Rp * 0.12) });
  out.squares.push(place);
  out.sites.push({ id: 'thing', kind: 'thing-place', role: 'civic', lot: place, anchor: c });
  return out;
}

/** The wurt village: radial farms round a central place on a mound by the water. */
function wurtVillage(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  const out = emptyCamp();
  const ctx = cc.ctx;
  const sk = Math.sqrt(cc.sprawl);
  const nF = Math.max(4, Math.min(30, Math.round(pop / 10)));
  const sr = rng.fork('status');
  const st = statusLadder(nF, sr);
  // the Herrenhof stands apart: the ring is made of the other farms
  const ring = st.slice(1).map((s) => ({ s, L: houseSize(s, 'germanic', sr).L }));
  const pw = 4.2;
  const D = Math.max(...ring.map((y) => y.L)) + 12 * sk;
  // angular widths: house width + margins at mid depth
  const widthOf = (s: Status) => [26, 21, 17, 13][s] * sk * sr.range(0.9, 1.15);
  const ws = ring.map((y) => widthOf(y.s));
  const Wtot = ws.reduce((a, b) => a + b, 0) + widthOf(0) * 2.2;
  const Rmid = Math.max(D / 2 + 22, Wtot / (2 * Math.PI));
  const Rp = Rmid - D / 2 - pw;
  const R = Rmid + D / 2;
  const wr = rng.fork('warp');
  const ph = wr.range(0, 6), ecc = wr.range(0.04, 0.1);
  const W = (t: number) => 1 + ecc * Math.cos(2 * (t - ph));
  const ringPoly = (r0: number, n = 96): Polygon => orientPos(Array.from({ length: n }, (_, i) => { const t = (i / n) * 2 * Math.PI; return at(c, t, r0 * W(t)); }));
  const quarter = snapRing(ringPoly(R));
  out.quarters.push(quarter);
  out.outline.push(ringPoly(R + 10));
  // ---- paths: the ring round the place, lanes out (toward the roads and the water), the Herrenhof's side
  const ringPl = ringPoly(Rp + pw / 2);
  const streets: UrbanStreet[] = [street(ringPl.concat([ringPl[0]]), pw, 2, 'ring')];
  const aRoad = cc.main ? cc.roadAngle : Math.atan2(ctx.center.y - c.y, ctx.center.x - c.x);
  // the Herrenhof: the side away from the road (east if it is free)
  const aChief = aRoad + Math.PI + wr.range(-0.5, 0.5);
  // the roads up the mound are its lanes; more lanes spread round the ring
  const roadPl = roadPolylines(cc, c, R + 30);
  const lanes: { a: number; pl: Vec2[] }[] = roadPl.map((pl) => { const cv = new Curv(pl); const q = cv.at(R); return { a: Math.atan2(q.y - c.y, q.x - c.x), pl: cv.slice(Rp, R + 8) }; });
  const want = nF > 14 ? 3 : 2;
  for (const a of [aRoad, aRoad + Math.PI * wr.range(0.55, 0.8), aRoad - Math.PI * wr.range(0.55, 0.8), aRoad + Math.PI]) {
    if (lanes.length >= want) break;
    if (lanes.some((l) => Math.abs(Math.atan2(Math.sin(a - l.a), Math.cos(a - l.a))) < 0.8)) continue;
    lanes.push({ a, pl: [at(c, a, (Rp + pw / 2) * W(a)), at(c, a, (R + 8) * W(a))] });
  }
  lanes.forEach((l, k) => streets.push(street(l.pl, k === 0 ? 4.6 : 3.6, k === 0 ? 1 : 2, 'radial')));
  out.streets.push(...streets);
  const cuts: MultiPoly = [{ outer: ringPoly(Rp + pw), holes: [ringPoly(Rp)] }, ...pathRibbons(streets.slice(1))];
  const blocks = carveBlocks(quarter, unionMany(cuts.map((x): MultiPoly => [x]), 16, true), ctx.water);
  // ---- wedges: the Herrenhof (a double wedge at aChief), the farms round the rest
  const chiefSpan = (widthOf(0) * 2.2) / Rmid;
  const rest = 2 * Math.PI - chiefSpan;
  const tot = ws.reduce((a, b) => a + b, 0);
  const bounds: number[] = [aChief + chiefSpan / 2];
  for (const w of ws) bounds.push(bounds[bounds.length - 1] + (rest * w) / tot);
  const wedge = (t0: number, t1: number): Polygon => {
    const steps = Math.max(1, Math.ceil((t1 - t0) / 0.25));
    const pts: Vec2[] = [c];
    for (let i = 0; i <= steps; i++) pts.push(at(c, t0 + ((t1 - t0) * i) / steps, R * 2 + 40));
    return orientPos(pts);
  };
  const cells: { poly: Polygon; tag: number }[] = [{ poly: wedge(aChief - chiefSpan / 2, aChief + chiefSpan / 2), tag: 0 }];
  for (let j = 0; j < ws.length; j++) cells.push({ poly: wedge(bounds[j], bounds[j + 1]), tag: j + 1 });
  const front = new FrontIndex(out.streets);
  const fr0 = rng.fork('farms');
  const yardRings: { ring: Polygon; gates: { p: Vec2; width: number }[] }[] = [];
  for (const blk of blocks) {
    const bi = out.blocks.length;
    out.blocks.push({ poly: blk, kind: 'block', quarter: 0 });
    if (pointInRing(blk, c)) {
      // the central place: open ground with the well
      out.parcels.push({ poly: blk, use: 'meadow', block: bi });
      out.squares.push(blk);
      continue;
    }
    for (const pc of cutByCells(blk, cells)) {
      const pi = out.parcels.length;
      const fr = front.frontage(pc.poly);
      if (fr.len < 3.2 || area(pc.poly) < 150) { out.parcels.push({ poly: pc.poly, use: 'garden', block: bi }); continue; }
      out.parcels.push({ poly: pc.poly, use: 'plot', block: bi });
      const s = pc.tag === 0 ? 0 : ring[pc.tag - 1].s;
      const ic = inscribed(pc.poly, [], 1).c;
      // radial houses, gable to the place
      const axis = Math.atan2(ic.y - c.y, ic.x - c.x);
      fillFarm(out, pi, pc.poly, s as Status, { kind: 'germanic', axis, fence: 'yard-fence', L: pc.tag === 0 ? undefined : ring[pc.tag - 1].L }, fr.mid, fr0.fork('f' + pc.tag + ':' + bi));
      yardRings.push({ ring: pc.poly, gates: fr.mid ? [{ p: fr.mid, width: 3.5 }] : [] });
      if (s === 0) out.sites.push({ id: 'herrenhof', kind: 'herrenhof', role: 'power', lot: pc.poly, anchor: ic });
    }
  }
  out.lines.push(...fences(yardRings, 'yard-fence', 0.4));
  // the mound: its foot hachured, the slope down to the marsh
  out.lines.push(...hachures(ringPoly(R + 1.5), 2.6, 5, -1, (p) => lanes.some((l) => dist(p, at(c, l.a, (R + 1.5) * W(l.a))) < 8)));
  out.sites.push({ id: 'wurt', kind: 'wurt', role: 'civic', lot: quarter, anchor: c });
  void dist;
  return out;
}
