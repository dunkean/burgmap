/**
 * Halfling shire (Hobbiton, Bywater): smials dug into the sunny flank of a hill, in rows along lanes that follow
 * the contours (Bagshot Row), each with its round door to the lane below and its garden in front, hedges round the
 * gardens; the lane up the hill to the grandest smial at the top (Bag End); at the foot, by the road and the
 * stream, the inn at the crossroads, the mill on the water and the party field with its great tree; farms with
 * their fields round about. A large shire is a scatter of such villages and farm hamlets.
 *
 * Partition: quarter = a sector of the hill round its top (the rows of smials on the sunny side); cuts = the contour
 * lanes (arcs round the top) and the lane up the hill; blocks = the bands between the lanes, cut into gardens by
 * wedges from the top (each band its own widths); the foot buildings are single lots of their own.
 */
import type { Vec2, Polygon } from '../../core/geom';
import { dist } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { UrbanStreet } from '../../types';
import { area, orientPos, pointInRing, inscribed, obb } from '../../geo/poly';
import { unionMany, differenceS, MultiPoly } from '../../geo/bool';
import type { CampCtx } from './index';
import { snapRing, CampOut, emptyCamp, street, carveBlocks, pathRibbons, cutExact, FrontIndex, at, rect, hut, fitIn, openRing, pieces, roadPolylines } from './kit';
import { roundedRect, statusLadder, fences, Status } from './farms';
import { dispersedFarms, waterDist } from './homesteads';
import { nearestOn } from './norse';

/** A smial: a low turf mound along the slope, rounded, its round door to the front (`door` direction). */
function smial(c: Vec2, along: number, L: number, W: number): Polygon {
  return roundedRect(c, along, L, W, W * 0.45, 3);
}

export function shireVillage(cc: CampCtx, c0: Vec2, pop: number, rng: Rng): CampOut {
  const out = emptyCamp();
  const ctx = cc.ctx;
  const sk = Math.sqrt(cc.sprawl);
  // ---- the hill: the highest ground near the site; its sunny (southern) flank
  let top = c0, hTop = ctx.heightAt(c0);
  for (let r = 30; r <= 260; r += 30) for (let k = 0; k < 16; k++) {
    const p = at(c0, (k / 16) * 2 * Math.PI, r);
    if (ctx.isWater(p) || p.x < 150 || p.y < 150 || p.x > ctx.mapSize - 150 || p.y > ctx.mapSize - 150) continue;
    const h = ctx.heightAt(p);
    if (h > hTop + 0.5 * (r / 60)) { hTop = h; top = p; }
  }
  // the facing: the downhill direction nearest to south (y grows southward)
  let face = Math.PI / 2, best = -Infinity;
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * 2 * Math.PI;
    const drop = hTop - ctx.heightAt(at(top, a, 70));
    const s = drop + 4 * Math.sin(a);
    if (s > best) { best = s; face = a; }
  }
  const nS = Math.max(3, Math.round(pop / 5.5));
  const D = 24 * sk, lw = 3.4, r0 = 22 * sk;
  const step = D + lw;
  // ---- the lanes follow the contours: on every direction of the sunny flank, where the ground falls to the lane's
  // level (on a gentle hill, a wavering ring at the row spacing)
  const NA = 56;
  const spanMax = Math.min(1.75, 0.95 + nS / 90);
  const th = (i: number) => face - spanMax + (2 * spanMax * i) / (NA - 1);
  const hAt = (a: number, r: number) => ctx.heightAt(at(top, a, r));
  const drop = Math.max(0, hTop - hAt(face, 120));
  const flat = drop < 3;
  const nz = rng.fork('wobble');
  const ph = nz.range(0, 6);
  const R: number[][] = [Array.from({ length: NA }, (_, i) => r0 * (1 + 0.08 * Math.sin(i * 0.45 + ph)))];
  let cap = 0;
  while (cap < nS * 1.1 && R.length < 9) {
    const k = R.length;
    const prev = R[k - 1];
    const h = hTop - (drop * (r0 + k * step)) / 120;
    let row = prev.map((rp, i) => {
      if (flat) return rp + step * (1 + 0.12 * Math.sin(i * 0.33 + ph * k));
      for (let r = rp + 0.75 * step; r <= rp + 1.8 * step; r += 2) if (hAt(th(i), r) <= h) return r;
      return rp + step;
    });
    for (let pass = 0; pass < 3; pass++) row = row.map((_, i) => (row[Math.max(0, i - 1)] + 2 * row[i] + row[Math.min(NA - 1, i + 1)]) / 4);
    row = row.map((r, i) => Math.max(r, prev[i] + 0.85 * step));
    R.push(row);
    const midLen = row.reduce((s, r, i) => s + (i ? Math.abs(th(i) - th(i - 1)) * (r + prev[i]) / 2 : 0), 0);
    cap += Math.floor(midLen / (21 * sk)) * 0.75;
  }
  let K = R.length - 1;
  // each band's own span (the inner rows shorter, the outer ones as long as the households need): indices [i0, i1]
  const sp = rng.fork('spans');
  const spans: [number, number][] = [[0, NA - 1]];
  const bandCap = (b: number, i0: number, i1: number): number => {
    let L = 0;
    for (let i = i0 + 1; i <= i1; i++) L += Math.abs(th(i) - th(i - 1)) * (R[b][i] + R[b - 1][i]) / 2;
    return L / (22 * sk);
  };
  let left = nS - 1;
  for (let b = 1; b <= K; b++) {
    let f = Math.min(1, 0.5 + 0.22 * b) * sp.range(0.85, 1);
    const ctr = Math.round((NA - 1) / 2 + sp.range(-0.12, 0.12) * NA);
    const span = (ff: number): [number, number] => { const half = Math.floor(((NA - 1) / 2) * ff); return [Math.max(0, ctr - half), Math.min(NA - 1, ctr + half)]; };
    // (the last band only as long as the households left: no row of empty gardens)
    const c = bandCap(b, ...span(f));
    if (c > left * 1.08) f = Math.max(0.18, f * ((left * 1.08) / c));
    spans.push(span(f));
    left -= Math.floor(bandCap(b, ...span(f)));
    if (left <= 0) { K = b; break; }
  }
  const P = (k: number, i: number) => at(top, th(i), R[k][i]);
  // ---- the quarter: the top (inside the first lane, all round) and the bands, less the water
  const cap0 = orientPos(Array.from({ length: 32 }, (_, i) => at(top, (i / 32) * 2 * Math.PI, r0 * (1 + 0.08 * Math.sin(i * 0.8 + ph)))));
  const bands: Polygon[] = [];
  for (let b = 1; b <= K; b++) {
    const [i0, i1] = spans[b];
    const inner: Vec2[] = [], outer: Vec2[] = [];
    for (let i = i0; i <= i1; i++) { inner.push(P(b - 1, i)); outer.push(P(b, i)); }
    bands.push(orientPos([...inner, ...outer.reverse()]));
  }
  let Qm: MultiPoly = unionMany([[{ outer: cap0, holes: [] }], ...bands.map((p): MultiPoly => [{ outer: p, holes: [] }])], 16, true);
  if (ctx.water.length) Qm = differenceS(Qm, ctx.water);
  const quarters = pieces(Qm, 300).map(snapRing);
  // ---- lanes: each contour lane along the spans of the bands it serves; the lane up the hill
  const streets: UrbanStreet[] = [];
  for (let k = 0; k <= K; k++) {
    const a = spans[Math.min(K, k + 1)], b2 = spans[k];
    const i0 = Math.max(0, Math.min(a[0], k ? b2[0] : a[0]) - 1), i1 = Math.min(NA - 1, Math.max(a[1], k ? b2[1] : a[1]) + 1);
    const pts: Vec2[] = [];
    for (let i = i0; i <= i1; i++) pts.push(P(k, i));
    streets.push(street(pts, k === K ? 4.2 : lw, k === K ? 2 : 3, k === K ? 'radial' : 'lane'));
  }
  const Rout = Math.max(...R[K]) + lw / 2 + 2;
  R.length = K + 1;
  const mi = Math.round((NA - 1) / 2);
  const climbPts: Vec2[] = [];
  for (let k = 0; k <= K; k++) climbPts.push(P(k, mi));
  climbPts.unshift(at(top, face, r0 * 0.35));
  climbPts.push(at(top, face, R[K][mi] + 30));
  const climb = street(climbPts, 4.2, 1, 'radial');
  streets.push(climb);
  out.streets.push(...streets);
  const rib = unionMany(pathRibbons(streets).map((ph2): MultiPoly => [ph2]), 16, true);
  const front = new FrontIndex(out.streets);
  // garden wedges per band (rays from the top, each band its own widths)
  const wr = rng.fork('wedges');
  const wedgesOf = (k: number): { poly: Polygon; tag: number }[] => {
    const mid = (R[Math.max(0, k - 1)][mi] + R[Math.min(K, k)][mi]) / 2;
    const cells: { poly: Polygon; tag: number }[] = [];
    let t = face - spanMax - 0.3;
    let tag = 0;
    while (t < face + spanMax + 0.3) {
      const w = (wr.range(17, 27) * sk) / Math.max(20, mid);
      const steps = Math.max(1, Math.ceil(w / 0.1));
      const pts: Vec2[] = [top];
      for (let i = 0; i <= steps; i++) pts.push(at(top, t + (w * i) / steps, Rout * 2 + 50));
      cells.push({ poly: orientPos(pts), tag: tag++ });
      t += w;
    }
    return cells;
  };
  const bandWedges = R.map((_, k) => wedgesOf(k));
  // the band of a point: the first contour row beyond it
  const bandOf = (p: Vec2): number => {
    const a = Math.atan2(p.y - top.y, p.x - top.x);
    let d = a - (face - spanMax);
    d = ((d % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const i = Math.max(0, Math.min(NA - 1, Math.round((d / (2 * spanMax)) * (NA - 1))));
    const r = dist(p, top);
    for (let k = 0; k <= K; k++) if (r < R[k][i]) return k;
    return K;
  };
  const st = statusLadder(nS, rng.fork('status'));
  let si = 1;
  const fr0 = rng.fork('smials');
  const hedges: { ring: Polygon; gates: { p: Vec2; width: number }[] }[] = [];
  out.trees = out.trees ?? [];
  for (const Q of quarters) {
    const qi = out.quarters.length;
    out.quarters.push(Q); out.outline.push(Q);
    for (const blk of carveBlocks(Q, rib, ctx.water)) {
      const bi = out.blocks.length;
      out.blocks.push({ poly: blk, kind: 'block', quarter: qi });
      const ic = inscribed(blk, [], 1).c;
      const kb = bandOf(ic);
      if (kb === 0) {
        // the top: the grandest smial (Bag End) in its garden
        const pi = out.parcels.length;
        const fr = front.frontage(blk);
        out.parcels.push({ poly: blk, use: fr.len >= 3.2 ? 'plot' : 'garden', block: bi });
        if (fr.len >= 3.2) fillSmial(out, pi, blk, 0, top, face, fr.mid, fr0.fork('top'), hedges);
        continue;
      }
      for (const pc of cutExact(blk, bandWedges[kb] ?? bandWedges[0])) {
        const pi = out.parcels.length;
        const fr = front.frontage(pc.poly);
        if (fr.len < 3.2 || area(pc.poly) < 120 || si > nS + 2) { out.parcels.push({ poly: pc.poly, use: 'garden', block: bi }); continue; }
        out.parcels.push({ poly: pc.poly, use: 'plot', block: bi });
        fillSmial(out, pi, pc.poly, st[Math.min(st.length - 1, si++)], top, face, fr.mid, fr0.fork('s' + pi), hedges);
      }
    }
  }
  out.lines.push(...fences(hedges, 'garden-hedge', 1.2));
  // ---- the foot of the hill: the inn at the crossroads, the party field, the mill on the water
  const foot = at(top, face, R[K][mi] + 34);
  const lots: { kind: 'inn' | 'party' | 'mill'; p: Vec2; r: number }[] = [];
  lots.push({ kind: 'inn', p: at(foot, face + Math.PI / 2, 26), r: 20 });
  lots.push({ kind: 'party', p: at(foot, face - Math.PI / 2, 40), r: 34 });
  const wd = waterDist(cc, foot, 260);
  if (wd < 260) {
    // the mill: toward the nearest water
    let wa = face;
    for (let k = 0; k < 24; k++) { const a = (k / 24) * 2 * Math.PI; if (ctx.isWater(at(foot, a, wd))) { wa = a; break; } }
    lots.push({ kind: 'mill', p: at(foot, wa, Math.max(30, wd - 18)), r: 16 });
  }
  const used: Polygon[] = [...out.quarters];
  for (const L of lots) {
    const ring = orientPos(Array.from({ length: 20 }, (_, i) => at(L.p, (i / 20) * 2 * Math.PI, L.r * (1 + 0.06 * Math.sin(i * 1.9)))));
    let m: MultiPoly = [{ outer: ring, holes: [] }];
    if (ctx.water.length) m = differenceS(m, ctx.water);
    for (const u of used) m = differenceS(m, [{ outer: u, holes: [] }]);
    const ps = pieces(m, 150);
    if (!ps.length) continue;
    const Q = snapRing(ps.reduce((a, b) => (area(b) > area(a) ? b : a)));
    used.push(Q);
    const qi = out.quarters.length;
    out.quarters.push(Q); out.outline.push(Q);
    // its lane stub toward the hill's lane
    const g = nearestOn(Q, foot);
    const ins = inscribed(Q, [], 1);
    const lx = ins.c.x - g.x, ly = ins.c.y - g.y, ll = Math.hypot(lx, ly) || 1;
    const stub = street([{ x: g.x - (lx / ll) * 4, y: g.y - (ly / ll) * 4 }, { x: g.x + (lx / ll) * Math.max(5, ll * 0.4), y: g.y + (ly / ll) * Math.max(5, ll * 0.4) }], 3.2, 3, 'lane');
    out.streets.push(stub);
    // the way to the foot of the hill
    if (dist(g, foot) > 6) out.lines.push({ kind: 'footpath', path: [g, foot], width: 2 });
    const fi = new FrontIndex([stub]);
    const blocks = carveBlocks(Q, pathRibbons([stub]), []).sort((a, b) => area(b) - area(a));
    blocks.forEach((b, j) => {
      const bi = out.blocks.length;
      out.blocks.push({ poly: b, kind: 'block', quarter: qi });
      const pi = out.parcels.length;
      const fr = fi.frontage(b);
      if (j > 0 || fr.len < 3.2) { out.parcels.push({ poly: b, use: 'garden', block: bi }); return; }
      if (L.kind === 'party') {
        out.parcels.push({ poly: b, use: 'meadow', block: bi });
        out.squares.push(b);
        const pc = inscribed(b, [], 1);
        out.trees!.push({ x: pc.c.x, y: pc.c.y, r: Math.min(10, pc.r * 0.32) });
        out.landmarks.push({ kind: 'party-field', poly: b });
        return;
      }
      out.parcels.push({ poly: b, use: 'plot', block: bi });
      const ang = Math.atan2(fr.mid ? fr.mid.y - pcOf(b).y : 0, fr.mid ? fr.mid.x - pcOf(b).x : 1) + Math.PI / 2;
      if (L.kind === 'inn') {
        const h = fitIn(b, (q, s) => roundedRect(q, ang, 22 * s, 11 * s, 3, 3), [], { margin: 2, gap: 0, minScale: 0.6 });
        if (h) { out.buildings.push({ poly: h, kind: 'landmark', parcel: pi, arch: 'inn', roof: 'gable', storeys: 2, material: 'timber' }); out.landmarks.push({ kind: 'inn', poly: h }); out.sites.push({ id: 'inn', kind: 'inn', role: 'market', lot: b, anchor: inscribed(h, [], 0.5).c }); }
      } else {
        const h = fitIn(b, (q, s) => rect(q, ang, 13 * s, 8 * s), [], { margin: 1.5, gap: 0, minScale: 0.6 });
        if (h) { out.buildings.push({ poly: h, kind: 'landmark', parcel: pi, arch: 'watermill', roof: 'gable', storeys: 2, material: 'timber' }); out.landmarks.push({ kind: 'mill', poly: h }); }
      }
    });
  }
  out.sites.push({ id: 'hill', kind: 'smial-hill', role: 'civic', lot: quarters[0] ?? cap0, anchor: top });
  void roadPolylines;
  return out;
}

const pcOf = (p: Polygon): Vec2 => inscribed(p, [], 1).c;

/** A smial in its garden: dug into the bank at the back, its door to the lane below, the garden and the trees. */
function fillSmial(out: CampOut, pi: number, lot: Polygon, s: Status, top: Vec2, face: number, gate: Vec2 | null, r: Rng, hedges: { ring: Polygon; gates: { p: Vec2; width: number }[] }[]): void {
  const ins = inscribed(lot, [], 0.5);
  // uphill: toward the top; the smial along the contour, at the uphill side of the garden
  const up = Math.atan2(top.y - ins.c.y, top.x - ins.c.x);
  const along = up + Math.PI / 2;
  const L0 = s === 0 ? r.range(22, 28) : [0, r.range(15, 18), r.range(11, 15), r.range(8, 10)][s], W0 = s === 0 ? 11 : r.range(6.5, 8);
  const back = at(ins.c, up, ins.r * 0.45);
  const sm = fitIn(lot, (q, k) => smial(q, along, L0 * k, W0 * Math.max(0.85, k)), [], { margin: 1.6, gap: 0, minScale: 0.6, cands: [back, ins.c] });
  if (!sm) return;
  const placed: Polygon[] = [sm];
  out.buildings.push({ poly: sm, kind: s === 0 ? 'landmark' : 'house', parcel: pi, arch: s === 0 ? 'great-smial' : 'smial', roof: 'dome', storeys: 1, material: 'turf', orientation: up + Math.PI });
  if (s === 0) out.landmarks.push({ kind: 'great-smial', poly: sm });
  // the bank the smial is dug into: hachures on its uphill side; the round door, the path down to the gate
  const sc = inscribed(sm, [], 0.3).c;
  for (let i = -3; i <= 3; i++) {
    const p = at(at(sc, up, W0 * 0.5 + 0.6), along, (i * L0) / 8);
    out.lines.push({ kind: 'hachure', path: [p, at(p, up, 2.4)], width: 0.35 });
  }
  const door = at(sc, up + Math.PI, W0 * 0.5);
  out.lines.push({ kind: 'round-door', path: Array.from({ length: 9 }, (_, i) => at(door, (i / 8) * 2 * Math.PI, 0.8)), width: 0.35 });
  if (gate) out.lines.push({ kind: 'footpath', path: [door, gate], width: 1.2 });
  // the vegetable garden in front, a shed, fruit trees
  const bed = fitIn(lot, (q, k) => rect(q, along, Math.min(14, ins.r * 1.1) * k, Math.min(6, ins.r * 0.45) * k), placed, { margin: 1.4, gap: 1.6, minScale: 0.55, cands: [at(ins.c, up + Math.PI, ins.r * 0.35)] });
  if (bed) { out.landmarks.push({ kind: 'garden-bed', poly: bed }); placed.push(bed); }
  if (r.chance(0.5)) { const sh = fitIn(lot, (q, k) => rect(q, along, 4 * k, 3 * k), placed, { margin: 1.2, gap: 2, minScale: 0.85, step: 2.5 }); if (sh) { placed.push(sh); out.buildings.push({ poly: sh, kind: 'outbuilding', parcel: pi, arch: 'garden-shed', roof: 'gable', storeys: 1, material: 'timber' }); } }
  for (let k = 0; k < r.int(1, 4); k++) {
    const tq = { x: ins.c.x + r.range(-1, 1) * ins.r * 0.85, y: ins.c.y + r.range(-1, 1) * ins.r * 0.85 };
    const tr = r.range(2.2, 3.8);
    if (pointInRing(lot, tq) && !placed.some((p) => pointInRing(p, tq) || p.some((q) => dist(q, tq) < tr + 0.5))) out.trees!.push({ x: tq.x, y: tq.y, r: tr });
  }
  hedges.push({ ring: lot, gates: gate ? [{ p: gate, width: 2.4 }] : [] });
  void face; void obb; void hut;
}

/** Shire farm hamlet: a few farms on their hedged fields, cottages above ground (the outlying form). */
export function shireFarms(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  const sk = Math.sqrt(cc.sprawl);
  const n = Math.max(1, Math.round(pop / 7));
  const st = statusLadder(n, rng.fork('status'));
  return dispersedFarms(cc, c, st, {
    radius: (s: Status, r: Rng) => [r.range(30, 36), r.range(25, 30), r.range(20, 25), r.range(16, 20)][s] * sk,
    gap: 28 * sk,
    spread: (50 + Math.sqrt(n) * 60) * sk,
    wobble: 0.08,
    aspect: [1.1, 1.5],
    fill: (o, pi, yard, home, s, gate, r) => {
      const ins = inscribed(yard, [], 0.5);
      const toward = gate ? Math.atan2(gate.y - ins.c.y, gate.x - ins.c.x) : 0;
      const placed: Polygon[] = [];
      // a smial dug into a bank if the ground slopes, else a round-ended cottage; a barn, the garden, trees
      const h = fitIn(yard, (q, k) => roundedRect(q, toward + Math.PI / 2, (s === 0 ? 18 : 12) * k, 8 * k, 3.4, 3), placed, { margin: 2, gap: 0, minScale: 0.6 });
      if (!h) return;
      placed.push(h);
      o.buildings.push({ poly: h, kind: 'house', parcel: pi, arch: 'hobbit-cottage', roof: 'thatch-round', storeys: 1, material: 'thatch' });
      const b2 = fitIn(yard, (q, k) => rect(q, toward, 10 * k, 6 * k), placed, { margin: 1.5, gap: 3, minScale: 0.7 });
      if (b2) { placed.push(b2); o.buildings.push({ poly: b2, kind: 'outbuilding', parcel: pi, arch: 'barn', roof: 'gable', storeys: 1, material: 'timber' }); }
      const bed = fitIn(yard, (q, k) => rect(q, toward, 10 * k, 6 * k), placed, { margin: 1.5, gap: 2, minScale: 0.6 });
      if (bed) o.landmarks.push({ kind: 'garden-bed', poly: bed });
      o.trees = o.trees ?? [];
      for (let k = 0; k < r.int(2, 5); k++) {
        const tq = { x: ins.c.x + r.range(-1, 1) * ins.r * 0.85, y: ins.c.y + r.range(-1, 1) * ins.r * 0.85 };
        const tr = r.range(2.4, 4);
        if (pointInRing(yard, tq) && !placed.some((p) => pointInRing(p, tq) || p.some((q) => dist(q, tq) < tr + 0.5)) && !(bed && pointInRing(bed, tq))) o.trees.push({ x: tq.x, y: tq.y, r: tr });
      }
      const g = gate ? nearestOn(home, gate) : null;
      for (const pl of openRing(home, g ? [{ p: g, width: 3 }] : [])) o.lines.push({ kind: 'hedge', path: pl, width: 1.6 });
    },
  }, rng);
}
