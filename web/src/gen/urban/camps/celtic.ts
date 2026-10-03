/**
 * Celtic settlements of the Iron Age:
 * - raths (ringforts, enclosed farmsteads): a circular bank and ditch round one household's roundhouses, granary
 *   and pits; a hamlet is a few raths among their fields, linked by tracks;
 * - the hillfort (Danebury, Maiden Castle): the rampart follows the brow of the hill, its ditch and counterscarp
 *   outside, the gates with inturned ramparts; inside, roundhouses line the lee of the rampart along the
 *   perimeter lane, rows of four-post granaries stand along the roads in the centre, shrines at the top, a few
 *   fenced compounds and open ground for the stock.
 * Roundhouses (6–15 m across by status) open to the east-south-east, through a porch.
 */
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import { dist } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { UrbanStreet } from '../../types';
import { area, orientPos, pointInRing, inscribed, bboxOf, obb } from '../../geo/poly';
import { unionMany, MultiPoly } from '../../geo/bool';
import { Delaunay } from 'd3-delaunay';
import type { CampCtx } from './index';
import {
  snapRing, CampOut, emptyCamp, street, carveBlocks, pathRibbons, cutExact, FrontIndex, at, hut, rect, fitIn, openRing, hachures,
  roadPolylines, wanderLine, Curv,
} from './kit';
import { statusLadder, Status, yardEarth, fences } from './farms';
import { dispersedFarms } from './homesteads';
import { nearestOn } from './norse';
import { Noise2D } from '../../core/noise';

/** Celtic doors face the rising sun (east-south-east; y points south on the map). */
export const CELTIC_DOOR = 0.35;

/** Roundhouse: a circle of `r` with a porch of `porch` m on the door side. */
export function roundhouse(c: Vec2, r: number, door: number, porch = 1.6): Polygon {
  const n = 18;
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = door + ((i + 0.5) / n) * 2 * Math.PI;
    pts.push(at(c, t, r));
  }
  // the porch: two short walls straight out on the door side
  const w = Math.min(r * 0.32, 1.6);
  const a = { x: Math.cos(door), y: Math.sin(door) }, nrm = { x: -a.y, y: a.x };
  const base = Math.sqrt(Math.max(0, r * r - w * w));
  const p1 = { x: c.x + a.x * base + nrm.x * w, y: c.y + a.y * base + nrm.y * w };
  const p2 = { x: c.x + a.x * (base + porch) + nrm.x * w, y: c.y + a.y * (base + porch) + nrm.y * w };
  const p3 = { x: c.x + a.x * (base + porch) - nrm.x * w, y: c.y + a.y * (base + porch) - nrm.y * w };
  const p4 = { x: c.x + a.x * base - nrm.x * w, y: c.y + a.y * base - nrm.y * w };
  // circle points except those between p4 and p1 (the door arc), then the porch
  const half = Math.asin(Math.min(1, w / r));
  const ring = pts.filter((q) => { const t = Math.atan2(q.y - c.y, q.x - c.x) - door; const d = Math.abs(Math.atan2(Math.sin(t), Math.cos(t))); return d > half + 0.02; });
  ring.sort((u, v) => ((Math.atan2(u.y - c.y, u.x - c.x) - door + 4 * Math.PI) % (2 * Math.PI)) - ((Math.atan2(v.y - c.y, v.x - c.x) - door + 4 * Math.PI) % (2 * Math.PI)));
  return orientPos([p1, ...ring, p4, p3, p2]);
}

const houseR = (s: Status, r: Rng): number => [r.range(6.5, 7.6), r.range(5.2, 6.4), r.range(4.2, 5.2), r.range(3.3, 4.1)][s];

/** One household's roundhouse(s), granary and pits inside a yard. */
export function roundhouseYard(out: CampOut, pi: number, yard: Polygon, s: Status, r: Rng, o: { granaries?: number; second?: boolean; pits?: number; earth?: boolean } = {}): Polygon[] {
  const placed: Polygon[] = [];
  const R0 = houseR(s, r);
  const door = CELTIC_DOOR + r.range(-0.35, 0.35);
  const main = fitIn(yard, (q, k) => roundhouse(q, R0 * k, door), placed, { margin: 1.4, gap: 0, minScale: 0.6 });
  if (!main) return placed;
  placed.push(main);
  out.buildings.push({ poly: main, kind: s === 0 ? 'landmark' : 'house', parcel: pi, arch: s === 0 ? 'chief-roundhouse' : 'roundhouse', roof: 'thatch-round', storeys: 1, material: 'wattle', orientation: door });
  if (s === 0) out.landmarks.push({ kind: 'chief-roundhouse', poly: main });
  const second = o.second ?? (s <= 1 ? r.chance(0.7) : r.chance(0.25));
  if (second) {
    const h2 = fitIn(yard, (q, k) => roundhouse(q, R0 * r.range(0.55, 0.75) * k, door + r.range(-0.3, 0.3), 1.2), placed, { margin: 1.2, gap: 2.2, minScale: 0.75 });
    if (h2) { placed.push(h2); out.buildings.push({ poly: h2, kind: 'house', parcel: pi, arch: 'roundhouse', roof: 'thatch-round', storeys: 1, material: 'wattle', orientation: door }); }
  }
  const ng = o.granaries ?? [3, 2, 1, r.int(0, 1)][s];
  for (let k = 0; k < ng; k++) {
    const gs = r.range(2.4, 3.2);
    const g = fitIn(yard, (q, kk) => rect(q, r.range(-0.2, 0.2), gs * kk, gs * kk), placed, { margin: 1, gap: 1.6, minScale: 0.85, step: 2.5 });
    if (g) { placed.push(g); out.buildings.push({ poly: g, kind: 'outbuilding', parcel: pi, arch: 'four-post-granary', roof: 'gable', storeys: 1, material: 'timber' }); }
  }
  const np = o.pits ?? [5, 3, 2, 1][s];
  for (let k = 0; k < np; k++) {
    const g = fitIn(yard, (q, kk) => hut(q, r.range(1.12, 1.4) * kk, 8), placed, { margin: 1, gap: 1.1, minScale: 0.95, step: 2 });
    if (g) { placed.push(g); out.buildings.push({ poly: g, kind: 'pit', parcel: pi, arch: 'storage-pit', roof: 'none', storeys: 0, material: 'earth' }); }
  }
  if (o.earth !== false) yardEarth(out, yard, placed.filter((p) => area(p) > 6), 2.2);
  return placed;
}

/** The enclosure line at offset `off` outward: the brow of the hill (where the ground falls away), else an oval. */
export function enclosureAt(cc: CampCtx, c: Vec2, R: number, rng: Rng, hill: boolean): { at: (off: number) => Polygon; onHill: boolean } {
  const ctx = cc.ctx;
  const N = 72, hc = ctx.heightAt(c);
  let rad: number[] | null = null;
  if (hill) {
    const raw: number[] = [];
    let found = 0;
    for (let k = 0; k < N; k++) {
      const th = (k / N) * 2 * Math.PI;
      let r = 1.6 * R;
      for (let s2 = 0.55 * R; s2 <= 1.6 * R; s2 += 5) if (ctx.heightAt({ x: c.x + Math.cos(th) * s2, y: c.y + Math.sin(th) * s2 }) < hc - Math.max(4, R * 0.04)) { r = s2; found++; break; }
      raw.push(r);
    }
    if (found > N * 0.6) {
      rad = raw;
      for (let pass = 0; pass < 3; pass++) rad = rad.map((_, k) => (rad![(k + N - 1) % N] + 2 * rad![k] + rad![(k + 1) % N]) / 4);
      const A0 = (rad.reduce((a, r) => a + r * r, 0) * Math.PI) / N;
      const kk = Math.sqrt((Math.PI * R * R) / A0);
      rad = rad.map((r) => r * kk);
    }
  }
  if (!rad) {
    const nz = new Noise2D(rng.fork('encl'));
    const asp = rng.range(1, 1.25), ang = rng.range(0, Math.PI);
    rad = Array.from({ length: N }, (_, k) => {
      const th = (k / N) * 2 * Math.PI;
      const e = R / Math.sqrt(Math.pow(Math.cos(th - ang) / Math.sqrt(asp), 2) + Math.pow(Math.sin(th - ang) * Math.sqrt(asp), 2));
      return e * (1 + 0.05 * nz.noise(Math.cos(th) * 1.3 + 5, Math.sin(th) * 1.3 + 5));
    });
  }
  const rr = rad;
  return { at: (off: number) => orientPos(rr.map((r, k) => at(c, (k / N) * 2 * Math.PI, r + off))), onHill: !!hill && rr !== null };
}

/**
 * Ramparts round an enclosure: `banks` banks with their ditches outside (the outer ones lower), hachured on the
 * outer face, broken at the gates, the innermost bank turned in along each gate passage (inturned entrance).
 */
export function ramparts(out: CampOut, ringAt: (off: number) => Polygon, c: Vec2, gates: { p: Vec2; dir: Vec2 }[], banks: number, gateW: number, inturn: boolean): void {
  for (let k = 0; k < banks; k++) {
    const off = 3.5 + k * 15;
    const bank = ringAt(off);
    const gaps = gates.map((g) => ({ p: nearestOn(bank, g.p), width: gateW + 2 + k * 2 }));
    for (const pl of openRing(bank, gaps)) out.lines.push({ kind: 'rampart', path: pl, width: k === 0 ? 7 : 5 });
    const ditch = ringAt(off + 7.5);
    for (const pl of openRing(ditch, gates.map((g) => ({ p: nearestOn(ditch, g.p), width: gateW + 3 + k * 2 })))) out.lines.push({ kind: 'ditch', path: pl, width: 4 });
    out.lines.push(...hachures(ringAt(off + 3.4), 2.4, 2.4, -1, (p) => gates.some((g) => dist(nearestOn(bank, g.p), p) < gateW / 2 + 3 + k * 2)));
    if (k === banks - 1) out.outline.push(ringAt(off + 11));
  }
  if (inturn) {
    // the bank ends turn inward along the passage
    const bank = ringAt(3.5);
    for (const g of gates) {
      const q = nearestOn(bank, g.p);
      const L = dist(q, c) || 1;
      const ux = (c.x - q.x) / L, uy = (c.y - q.y) / L;
      for (const s of [-1, 1]) {
        const o2 = { x: q.x - uy * s * (gateW / 2 + 2.5), y: q.y + ux * s * (gateW / 2 + 2.5) };
        out.lines.push({ kind: 'rampart', path: [{ x: o2.x - ux * 3, y: o2.y - uy * 3 }, { x: o2.x + ux * 14, y: o2.y + uy * 14 }], width: 4.5 });
      }
    }
  }
}

/** Celtic village: a hillfort (or a ringfort on flat ground) for a village and more, raths for a hamlet. */
export function celticVillage(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  if (pop < 150) return raths(cc, c, pop, rng);
  return hillfort(cc, c, pop, rng);
}

/** A few raths (or one) among their fields. */
export function raths(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  const sk = Math.sqrt(cc.sprawl);
  const n = Math.max(1, Math.round(pop / 16));
  const st = statusLadder(n, rng.fork('status'));
  return dispersedFarms(cc, c, st, {
    radius: (s: Status, r: Rng) => [r.range(27, 33), r.range(22, 27), r.range(18, 22), r.range(15, 18)][s] * sk,
    gap: 45 * sk,
    spread: (70 + Math.sqrt(n) * 90) * sk,
    wobble: 0.035,
    maxSlope: 0.3,
    prefer: (p) => { const h = cc.ctx.heightAt(p) - cc.ctx.heightAt(c); return Math.max(-0.4, Math.min(0.4, h / 25)); },
    fill: (o, pi, yard, home, s, gate, r) => {
      roundhouseYard(o, pi, yard, s, r, { granaries: s <= 1 ? 2 : 1 });
      // the bank on the edge of the rath, its ditch outside, the causeway at the gate
      const g = gate ? nearestOn(home, gate) : null;
      const gw = [{ p: g ?? home[0], width: 4 }];
      for (const pl of openRing(home, g ? gw : [])) o.lines.push({ kind: 'rampart', path: pl, width: 3.2 });
      const ic = inscribed(home, [], 1).c;
      const ditch = orientPos(home.map((q) => { const L = dist(q, ic) || 1; return { x: q.x + ((q.x - ic.x) / L) * 4.2, y: q.y + ((q.y - ic.y) / L) * 4.2 }; }));
      for (const pl of openRing(ditch, g ? [{ p: nearestOn(ditch, g), width: 5 }] : [])) o.lines.push({ kind: 'ditch', path: pl, width: 2.6 });
      if (s === 0) o.sites.push({ id: 'rath', kind: 'ringfort', role: 'power', lot: home, anchor: ic });
    },
  }, rng);
}

/** The hillfort. */
function hillfort(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  const out = emptyCamp();
  const ctx = cc.ctx;
  const sk = Math.sqrt(cc.sprawl);
  const nH = Math.max(6, Math.round(pop / 6));
  const R = Math.max(70, Math.sqrt((pop * 105 * cc.sprawl) / Math.PI));
  const Db = Math.min(22, R * 0.2) * sk;
  const en = enclosureAt(cc, c, R, rng.fork('encl'), true);
  const ringAt = en.at;
  const outline = snapRing(ringAt(0));
  const quarter = outline;
  out.quarters.push(quarter);
  const lane = ringAt(-Db);
  const ringSt = street(lane.concat([lane[0]]), 3.6, 2, 'ring');
  const sr = rng.fork('roads');
  const gw = 5;
  // ---- the roads through the fort: the regional roads keep their line inside; the gates are where they cross the
  // rampart. Without a road: a way from the gate toward the main road, and (for a larger fort) a second gate.
  const gates: { p: Vec2; dir: Vec2 }[] = [];
  const roads: UrbanStreet[] = [];
  const exitOf = (pl: Vec2[]): { s: number; p: Vec2 } | null => {
    const cv = new Curv(pl);
    for (let s2 = 4; s2 < cv.L + R * 2; s2 += 2) { const q = cv.at(s2); if (!pointInRing(outline, q)) return { s: s2, p: q }; }
    return null;
  };
  for (const pl of roadPolylines(cc, c, R * 1.8).slice(0, 2)) {
    const e = exitOf(pl);
    if (!e || gates.some((g) => dist(g.p, e.p) < R * 0.6)) continue;
    const cv = new Curv(pl);
    gates.push({ p: e.p, dir: { x: (c.x - e.p.x) / (dist(c, e.p) || 1), y: (c.y - e.p.y) / (dist(c, e.p) || 1) } });
    roads.push(street(cv.slice(0, e.s + 8), roads.length ? 4.6 : 5.5, roads.length ? 2 : 1, 'radial'));
  }
  const edgeAt = (a: number): Vec2 => { let lo = 0, hi = R * 3; for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (pointInRing(outline, at(c, a, m))) lo = m; else hi = m; } return at(c, a, lo); };
  const want = pop > 250 ? 2 : 1;
  for (let k = 0; gates.length < want && k < 4; k++) {
    const a = gates.length ? Math.atan2(c.y - gates[0].p.y, c.x - gates[0].p.x) + sr.range(-0.6, 0.6) : cc.main ? cc.roadAngle : Math.atan2(cc.ctx.center.y - c.y, cc.ctx.center.x - c.x);
    const p = edgeAt(a);
    if (gates.some((g) => dist(g.p, p) < R * 0.6)) continue;
    const L = dist(p, c);
    const pl = wanderLine(c, a, L + 8, sr, 20, 0.07);
    const e = exitOf(pl);
    if (!e) continue;
    gates.push({ p: e.p, dir: { x: (c.x - e.p.x) / (dist(c, e.p) || 1), y: (c.y - e.p.y) / (dist(c, e.p) || 1) } });
    roads.push(street(new Curv(pl).slice(0, e.s + 8), roads.length ? 4.6 : 5.5, roads.length ? 2 : 1, 'radial'));
  }
  if (roads.length === 1) {
    // a lane on from the centre to the far side of the perimeter lane
    const a = Math.atan2(c.y - gates[0].p.y, c.x - gates[0].p.x) + sr.range(-0.6, 0.6);
    const far = Math.min(R - Db - 2, R * 0.9);
    roads.push(street(wanderLine(c, a, far + 4, sr, 18, 0.06), 3.6, 3, 'lane'));
  }
  out.streets.push(ringSt, ...roads);
  const rib = unionMany([pathRibbons([ringSt]).map((ph) => ph), ...pathRibbons(roads).map((ph): MultiPoly => [ph])], 16, true);
  const blocks = carveBlocks(quarter, rib, ctx.water);
  const front = new FrontIndex(out.streets);
  // ---- band lots: wedges of 15–26 m at the middle of the band; central cells: Voronoi of jittered seeds
  const wr = rng.fork('wedges');
  const Rmid = R - Db / 2;
  const wedges: { poly: Polygon; tag: number }[] = [];
  {
    let t = wr.range(0, 1);
    const t0 = t;
    let tag = 0;
    while (t < t0 + 2 * Math.PI - 0.05) {
      const w = wr.range(15, 27) * sk / Rmid;
      const t1 = Math.min(t + w, t0 + 2 * Math.PI);
      const steps = Math.max(1, Math.ceil((t1 - t) / 0.12));
      const pts: Vec2[] = [c];
      for (let i = 0; i <= steps; i++) pts.push(at(c, t + ((t1 - t) * i) / steps, R * 2.5));
      wedges.push({ poly: orientPos(pts), tag: tag++ });
      t = t1;
    }
  }
  const inner = ringAt(-Db - 4);
  const cr = rng.fork('centre');
  const seeds: Vec2[] = [];
  const bb = bboxOf(inner);
  const step = 34 * sk;
  for (let y = bb.y0 + step / 2; y < bb.y1; y += step) for (let x = bb.x0 + step / 2; x < bb.x1; x += step) {
    const p = { x: x + cr.range(-0.4, 0.4) * step, y: y + cr.range(-0.4, 0.4) * step };
    if (pointInRing(inner, p)) seeds.push(p);
  }
  if (seeds.length < 3) seeds.push(c, { x: c.x + 10, y: c.y }, { x: c.x, y: c.y + 10 });
  const vor = Delaunay.from(seeds.map((p) => [p.x, p.y] as [number, number])).voronoi([bb.x0 - R, bb.y0 - R, bb.x1 + R, bb.y1 + R]);
  const cells = seeds.map((_, i) => ({ poly: orientPos((vor.cellPolygon(i) ?? []).slice(0, -1).map(([x, y]) => ({ x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 }))), tag: i }));
  // the use of each central cell: the shrine nearest the top, granary rows along the roads, fenced compounds, pasture
  const top = seeds.reduce((bi, p, i) => (ctx.heightAt(p) > ctx.heightAt(seeds[bi]) ? i : bi), 0);
  const roadPts: Vec2[] = roads.flatMap((s) => s.path);
  const nearRoad = (p: Vec2) => roadPts.some((q) => dist(q, p) < step * 0.75);
  const use = seeds.map((p, i) => (i === top ? 'shrine' : nearRoad(p) ? (cr.chance(0.5) ? 'granaries' : 'compound') : cr.chance(0.68) ? 'compound' : cr.chance(0.5) ? 'granaries' : 'pasture'));
  const st = statusLadder(nH, rng.fork('status'));
  let hi = 0;
  const yardRings: { ring: Polygon; gates: { p: Vec2; width: number }[] }[] = [];
  const fr0 = rng.fork('houses');
  blocks.forEach((blk) => {
    const bi = out.blocks.length;
    out.blocks.push({ poly: blk, kind: 'block', quarter: 0 });
    const ic = inscribed(blk, [], 1).c;
    const inBand = !pointInRing(lane, ic);
    const parts = cutExact(blk, inBand ? wedges : cells);
    for (const pc of parts) {
      const pi = out.parcels.length;
      const fr = front.frontage(pc.poly);
      const a = area(pc.poly);
      const u = inBand ? 'band' : use[pc.tag] ?? 'pasture';
      if (fr.len < 3.2 || a < 90 || u === 'pasture') { out.parcels.push({ poly: pc.poly, use: a > 400 ? 'commons' : 'garden', block: bi }); continue; }
      out.parcels.push({ poly: pc.poly, use: 'plot', block: bi });
      const r = fr0.fork('p' + pi);
      if (u === 'band') {
        // one or two households in the lee of the rampart
        const s = st[Math.min(st.length - 1, 1 + (hi++ % Math.max(1, st.length - 1)))];
        roundhouseYard(out, pi, pc.poly, s, r, { granaries: r.chance(0.4) ? 1 : 0, pits: r.int(1, 3) });
      } else if (u === 'shrine') {
        // a square shrine (and a smaller one) in an open court
        const o2 = obb(pc.poly);
        const ang = Math.atan2(o2.u.y, o2.u.x);
        const g = fitIn(pc.poly, (q, k) => rect(q, ang, 6.5 * k, 6.5 * k), [], { margin: 3, gap: 0, minScale: 0.7 });
        if (g) {
          out.buildings.push({ poly: g, kind: 'landmark', parcel: pi, arch: 'shrine', roof: 'pyramidal', storeys: 1, material: 'timber' });
          out.landmarks.push({ kind: 'shrine', poly: g });
          const g2 = fitIn(pc.poly, (q, k) => rect(q, ang, 4 * k, 4 * k), [g], { margin: 3, gap: 4, minScale: 0.8 });
          if (g2) out.buildings.push({ poly: g2, kind: 'landmark', parcel: pi, arch: 'shrine', roof: 'pyramidal', storeys: 1, material: 'timber' });
          out.sites.push({ id: 'shrine', kind: 'shrine', role: 'worship', lot: pc.poly, anchor: inscribed(g, [], 0.5).c });
        }
      } else if (u === 'granaries') {
        // four-post granaries in rows along the road
        const near = roadPts.reduce((b2, q) => (dist(q, ic) < dist(b2, ic) ? q : b2), roadPts[0]);
        const k0 = roadPts.indexOf(near);
        const nb = roadPts[Math.min(roadPts.length - 1, k0 + 1)], pb = roadPts[Math.max(0, k0 - 1)];
        const ang = Math.atan2(nb.y - pb.y, nb.x - pb.x);
        const placed: Polygon[] = [];
        const ins = inscribed(pc.poly, [], 0.5).c;
        const ux = Math.cos(ang), uy = Math.sin(ang);
        for (const j of [-0.5, 0.5]) for (let i = -4; i <= 4; i++) {
          const q = { x: ins.x + ux * i * 6.2 - uy * j * 6.6, y: ins.y + uy * i * 6.2 + ux * j * 6.6 };
          const gs = r.range(2.6, 3.4);
          const g = rect(q, ang, gs, gs);
          if (pointInRing(pc.poly, q) && fitIn(pc.poly, () => g, placed, { margin: 1.2, gap: 1.5, minScale: 1, cands: [q] })) { placed.push(g); out.buildings.push({ poly: g, kind: 'outbuilding', parcel: pi, arch: 'four-post-granary', roof: 'gable', storeys: 1, material: 'timber' }); }
        }
        if (!placed.length) out.parcels[pi].use = 'commons';
      } else {
        // a fenced compound: a household of standing
        const s: Status = hi === 0 || r.chance(0.12) ? (hi === 0 ? 0 : 1) : 2;
        hi++;
        roundhouseYard(out, pi, pc.poly, s, r);
        yardRings.push({ ring: pc.poly, gates: fr.mid ? [{ p: fr.mid, width: 3 }] : [] });
      }
    }
  });
  out.lines.push(...fences(yardRings, 'yard-fence', 0.4));
  // ---- the rampart(s), ditch(es), inturned gates
  const banks = pop > 900 ? 3 : pop > 300 ? 2 : 1;
  ramparts(out, ringAt, c, gates, banks, gw, true);
  out.sites.push({ id: 'hillfort', kind: pop > 300 ? 'hillfort' : 'ringfort', role: 'power', lot: outline, anchor: c });
  void Curv;
  return out;
}

export type { Polyline };
