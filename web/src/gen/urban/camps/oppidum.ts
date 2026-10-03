/**
 * Celtic oppidum of the late Iron Age (Bibracte, Manching, Titelberg): a vast enclosure on the brow of a hill (on a
 * plain a near circle), its murus gallicus rampart and ditch, the gates with long inturned passages (Zangentor).
 * The main street climbs from the main gate to the summit, where the sanctuary stands in its square ditched
 * enclosure (Viereckschanze); side streets branch off it. Along the streets, fenced yards with rectangular timber
 * houses, workshops and granaries; the artisans' quarter (smiths, bronze casters, enamellers) crowds the streets by
 * the main gate; the great families' enclosures (wings round a court) and the public place with its basin near the
 * top; roundhouses in the outer yards; much of the enclosure stays open: pasture, fields and woodland.
 *
 * Partition: quarter = the enclosure; cuts = the streets; blocks are cut by Voronoi cells of yard seeds strung
 * along the street frontages (and a few deep ones): the cells on a street are yards, the deep ones open ground.
 */
import { Delaunay } from 'd3-delaunay';
import type { Vec2, Polygon } from '../../core/geom';
import { dist } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { UrbanStreet } from '../../types';
import { area, orientPos, pointInRing, inscribed, bboxOf, obb, distToRing } from '../../geo/poly';
import { unionMany, MultiPoly } from '../../geo/bool';
import type { CampCtx } from './index';
import { snapRing, CampOut, emptyCamp, street, carveBlocks, pathRibbons, cutExact, FrontIndex, at, rect, fitIn, roadPolylines, wanderLine, Curv } from './kit';
import { enclosureAt, ramparts, roundhouseYard } from './celtic';
import { fences, yardEarth, statusLadder, Status } from './farms';

export function oppidum(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  const out = emptyCamp();
  const ctx = cc.ctx;
  const sk = Math.sqrt(cc.sprawl);
  // (spacious: 40–55 inhabitants per hectare inside the walls)
  const dens = pop < 1000 ? 55 : 42;
  const R = Math.min(ctx.mapSize * 0.33, Math.max(110, Math.sqrt(((pop / dens) * 1e4 * cc.sprawl) / Math.PI)));
  const en = enclosureAt(cc, c, R, rng.fork('encl'), true);
  const ringAt = en.at;
  const outline = snapRing(ringAt(0));
  out.quarters.push(outline);
  // ---- the summit: the highest point inside (the sanctuary)
  let top = c, hTop = -Infinity;
  for (let k = 0; k < 60; k++) {
    const p = at(c, (k / 60) * 2 * Math.PI * 7.3, R * 0.55 * Math.sqrt(((k * 37) % 60) / 60));
    if (pointInRing(outline, p) && !ctx.isWater(p) && ctx.heightAt(p) > hTop) { hTop = ctx.heightAt(p); top = p; }
  }
  // ---- gates and the roads through them (the regional roads keep their line), the main street to the summit
  const exitOf = (pl: Vec2[]): { s: number; p: Vec2 } | null => {
    const cv = new Curv(pl);
    for (let s2 = 4; s2 < cv.L + R * 2; s2 += 2) { const q = cv.at(s2); if (!pointInRing(outline, q)) return { s: s2, p: q }; }
    return null;
  };
  const sr = rng.fork('streets');
  const gates: { p: Vec2; dir: Vec2 }[] = [];
  const streets: UrbanStreet[] = [];
  for (const pl of roadPolylines(cc, c, R * 2).slice(0, 3)) {
    const e = exitOf(pl);
    if (!e || gates.some((g) => dist(g.p, e.p) < R * 0.5)) continue;
    gates.push({ p: e.p, dir: { x: (c.x - e.p.x) / (dist(c, e.p) || 1), y: (c.y - e.p.y) / (dist(c, e.p) || 1) } });
    streets.push(street(new Curv(pl).slice(0, e.s + 10), gates.length === 1 ? 7 : 5.5, gates.length === 1 ? 1 : 2, 'radial'));
  }
  const edgeAt = (a: number): Vec2 => { let lo = 0, hi = R * 3; for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (pointInRing(outline, at(c, a, m))) lo = m; else hi = m; } return at(c, a, lo); };
  const want = pop > 1500 ? 3 : 2;
  for (let k = 0; gates.length < want && k < 8; k++) {
    const a = gates.length ? Math.atan2(gates[0].p.y - c.y, gates[0].p.x - c.x) + Math.PI + sr.range(-0.9, 0.9) : cc.main ? cc.roadAngle : Math.atan2(ctx.center.y - c.y, ctx.center.x - c.x);
    const p = edgeAt(a);
    if (gates.some((g) => dist(g.p, p) < R * 0.6)) continue;
    const pl = wanderLine(c, a, dist(c, p) + 12, sr, 22, 0.07);
    const e = exitOf(pl);
    if (!e) continue;
    gates.push({ p: e.p, dir: { x: (c.x - e.p.x) / (dist(c, e.p) || 1), y: (c.y - e.p.y) / (dist(c, e.p) || 1) } });
    streets.push(street(new Curv(pl).slice(0, e.s + 10), gates.length === 1 ? 7 : 5.5, gates.length === 1 ? 1 : 2, 'radial'));
  }
  // the main street on from the centre to the summit; side streets branching off the roads
  if (dist(c, top) > 30) streets.push(street(wanderLine(c, Math.atan2(top.y - c.y, top.x - c.x), dist(c, top), sr, 20, 0.05), 6, 1, 'radial'));
  const nSide = Math.min(16, 2 + Math.round(R / 85));
  const mains = streets.slice();
  for (let k = 0; k < nSide; k++) {
    const m = mains[k % mains.length];
    const cv = new Curv(m.path);
    const s0 = cv.L * sr.range(0.25, 0.8);
    const o = cv.at(s0), n = cv.normal(s0);
    const sd = sr.chance(0.5) ? 1 : -1;
    const a = Math.atan2(n.y * sd, n.x * sd) + sr.range(-0.5, 0.5);
    const pl = wanderLine(o, a, R * sr.range(0.3, 0.6), sr, 18, 0.1);
    // (kept inside the rampart, off the band behind it)
    const inside: Vec2[] = [];
    for (const q of pl) { if (!pointInRing(outline, q) || distToRing(outline, q) < 30) break; inside.push(q); }
    if (inside.length >= 3) streets.push(street(inside, 4, 3, 'lane'));
  }
  out.streets.push(...streets);
  const rib = unionMany(pathRibbons(streets).map((ph): MultiPoly => [ph]), 16, true);
  const blocks = carveBlocks(outline, rib, ctx.water);
  const front = new FrontIndex(out.streets);
  // ---- yard seeds along the street frontages (each side, every 20–30 m), a few deep seeds for the open ground
  const yr = rng.fork('yards');
  const seeds: Vec2[] = [];
  for (const st of streets) {
    const cv = new Curv(st.path);
    for (let s = 8; s < cv.L - 6; s += yr.range(20, 30) * sk) for (const sd of [-1, 1]) {
      const p = cv.at(s), n = cv.normal(s);
      const q = { x: p.x + n.x * sd * (st.width / 2 + 14 * sk), y: p.y + n.y * sd * (st.width / 2 + 14 * sk) };
      if (pointInRing(outline, q) && !seeds.some((o) => dist(o, q) < 15 * sk)) seeds.push(q);
    }
  }
  const bb = bboxOf(outline);
  const step = 60 * sk;
  for (let y = bb.y0; y < bb.y1; y += step) for (let x = bb.x0; x < bb.x1; x += step) {
    const q = { x: x + yr.range(0, step), y: y + yr.range(0, step) };
    if (pointInRing(outline, q) && !seeds.some((o) => dist(o, q) < step * 0.6)) seeds.push(q);
  }
  const vor = Delaunay.from(seeds.map((p) => [p.x, p.y] as [number, number])).voronoi([bb.x0 - 100, bb.y0 - 100, bb.x1 + 100, bb.y1 + 100]);
  const cells = seeds.map((_, i) => ({ poly: orientPos((vor.cellPolygon(i) ?? []).slice(0, -1).map(([x, y]) => ({ x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 }))), tag: i }));
  // zones: the artisans by the main gate, the great families near the summit, the rest ordinary yards
  const g0 = gates[0]?.p ?? c;
  const st = statusLadder(seeds.length, rng.fork('status'), false);
  const fr0 = rng.fork('fill');
  const yardRings: { ring: Polygon; gates: { p: Vec2; width: number }[] }[] = [];
  let sanctuaryDone = false, placeDone = false;
  for (const blk of blocks) {
    const bi = out.blocks.length;
    out.blocks.push({ poly: blk, kind: 'block', quarter: 0 });
    for (const pc of cutExact(blk, cells)) {
      const pi = out.parcels.length;
      const ic = inscribed(pc.poly, [], 1).c;
      const fr = front.frontage(pc.poly);
      const A = area(pc.poly);
      // the sanctuary on the summit
      if (!sanctuaryDone && pointInRing(pc.poly, top) && A > 900) { sanctuaryDone = true; sanctuary(out, pc.poly, bi); continue; }
      if (fr.len < 3.2 || A < 150) { out.parcels.push({ poly: pc.poly, use: A > 600 ? 'commons' : 'garden', block: bi }); continue; }
      // the public place with its basin, near the summit on the main street
      if (!placeDone && dist(ic, top) < R * 0.45 && dist(ic, top) > 40 && A > 900) {
        placeDone = true;
        out.parcels.push({ poly: pc.poly, use: 'place', block: bi });
        out.squares.push(pc.poly);
        const ins = inscribed(pc.poly, [], 0.5);
        const o2 = obb(pc.poly);
        const basin = rect(ins.c, Math.atan2(o2.u.y, o2.u.x), Math.min(9, ins.r), Math.min(3.5, ins.r * 0.4));
        if (basin.every((q) => pointInRing(pc.poly, q))) out.landmarks.push({ kind: 'pond', poly: basin });
        out.sites.push({ id: 'place', kind: 'market', role: 'market', lot: pc.poly, anchor: ins.c });
        continue;
      }
      out.parcels.push({ poly: pc.poly, use: 'plot', block: bi });
      const r = fr0.fork('p' + pi);
      const zone = dist(ic, g0) < R * 0.35 ? 'artisans' : dist(ic, top) < R * 0.4 ? 'elite' : 'yard';
      const s: Status = zone === 'elite' ? (r.chance(0.6) ? 0 : 1) : st[pc.tag] ?? 2;
      fillYard(out, pi, pc.poly, zone, s, fr.mid, r);
      yardRings.push({ ring: pc.poly, gates: fr.mid ? [{ p: fr.mid, width: zone === 'elite' ? 5 : 3.2 }] : [] });
    }
  }
  // (the summit fell on a street or a small cell: the sanctuary takes the largest open ground near it)
  if (!sanctuaryDone) {
    let bi2 = -1, bs = -Infinity;
    out.parcels.forEach((p, i) => { if (p.use !== 'commons' && p.use !== 'garden') return; const a2 = area(p.poly); if (a2 < 900) return; const sc = -dist(inscribed(p.poly, [], 2).c, top) + Math.sqrt(a2); if (sc > bs) { bs = sc; bi2 = i; } });
    if (bi2 >= 0) { const p = out.parcels[bi2]; out.parcels.splice(bi2, 1); for (const b of out.buildings) if (b.parcel > bi2) b.parcel--; sanctuary(out, p.poly, p.block); }
  }
  out.lines.push(...fences(yardRings, 'yard-fence', 0.4));
  // ---- the murus gallicus (one bank, two for a large oppidum: the outer line of an earlier phase), inturned gates
  ramparts(out, ringAt, c, gates, pop > 4000 ? 2 : 1, 8, true);
  out.sites.push({ id: 'oppidum', kind: 'oppidum', role: 'power', lot: outline, anchor: c });
  return out;
}

/** One yard: a workshop crowd by the gate, a great family's wings round a court near the summit, else a house. */
function fillYard(out: CampOut, pi: number, yard: Polygon, zone: 'artisans' | 'elite' | 'yard', s: Status, frontMid: Vec2 | null, r: Rng): void {
  const placed: Polygon[] = [];
  const o = obb(yard);
  const long = Math.atan2(o.u.y, o.u.x);
  // the front of the yard: the house gable to the street
  const ins = inscribed(yard, [], 0.5);
  const toward = frontMid ? Math.atan2(frontMid.y - ins.c.y, frontMid.x - ins.c.x) : long;
  const nearFront = frontMid ? { x: ins.c.x + (frontMid.x - ins.c.x) * 0.45, y: ins.c.y + (frontMid.y - ins.c.y) * 0.45 } : ins.c;
  const push = (poly: Polygon, kind: string, arch: string, roof: 'gable' | 'thatch-round' | 'none', storeys = 1) => { placed.push(poly); out.buildings.push({ poly, kind, parcel: pi, arch, roof, storeys, material: 'timber' }); };
  if (zone === 'elite') {
    // wings round a court (the Roman-style houses of the last generation: PC1 at Bibracte)
    const L = s === 0 ? r.range(30, 40) : r.range(22, 28), Wd = r.range(5.5, 7);
    const c0 = ins.c;
    const ux = Math.cos(toward), uy = Math.sin(toward), nx = -uy, ny = ux;
    const wings: [number, number, number, number][] = [[-L / 2 + Wd / 2, 0, toward + Math.PI / 2, L], [0, L / 2 - Wd / 2, toward, L - 2 * Wd], [0, -L / 2 + Wd / 2, toward, L - 2 * Wd]];
    for (const [du, dv, a, len] of wings) {
      const q = { x: c0.x + ux * du + nx * dv, y: c0.y + uy * du + ny * dv };
      const g = fitIn(yard, (p, k) => rect(p, a, len * k, Wd), placed, { margin: 1.5, gap: 0.6, minScale: 0.6, cands: [q] });
      if (g) push(g, s === 0 ? 'landmark' : 'house', s === 0 ? 'domus' : 'courtyard-house', 'gable');
    }
    if (s === 0 && placed.length) out.landmarks.push({ kind: 'domus', poly: placed[0] });
  } else if (zone === 'artisans') {
    // workshops on the street front, a forge, a house behind
    const n = r.int(2, 3);
    for (let k = 0; k < n; k++) {
      const g = fitIn(yard, (p, kk) => rect(p, toward + Math.PI / 2, r.range(7, 11) * kk, r.range(5, 6.5) * kk), placed, { margin: 1, gap: 1.2, minScale: 0.7, cands: [nearFront] });
      if (g) push(g, 'house', r.pick(['workshop', 'forge', 'bronze-workshop', 'workshop']), 'gable');
    }
    for (let k = 0; k < 2; k++) { const g = fitIn(yard, (p, kk) => rect(p, long, 3 * kk, 3 * kk), placed, { margin: 1, gap: 1.5, minScale: 0.85, step: 2.5 }); if (g) push(g, 'outbuilding', 'granary-on-posts', 'gable'); }
  } else if (r.chance(0.3)) {
    roundhouseYard(out, pi, yard, s, r);
    return;
  } else {
    // a rectangular timber house, its gable to the street, granaries, a pit
    const L = [r.range(16, 20), r.range(13, 16), r.range(10, 13), r.range(8, 10)][s], Wd = r.range(6, 7.5);
    const g = fitIn(yard, (p, k) => rect(p, toward, L * k, Wd * Math.max(0.85, k)), placed, { margin: 1.4, gap: 0, minScale: 0.6, cands: [nearFront, ins.c] });
    if (g) push(g, 'house', 'timber-house', 'gable');
    for (let k = 0; k < r.int(1, 2); k++) { const gg = fitIn(yard, (p, kk) => rect(p, long, 3 * kk, 3 * kk), placed, { margin: 1, gap: 1.5, minScale: 0.85, step: 2.5 }); if (gg) push(gg, 'outbuilding', 'granary-on-posts', 'gable'); }
  }
  yardEarth(out, yard, placed, 2.2);
}

/** The sanctuary: a square ditched enclosure (Viereckschanze) with its square temple (fanum). */
function sanctuary(out: CampOut, poly: Polygon, bi: number): void {
  const pi = out.parcels.length;
  out.parcels.push({ poly, use: 'compound:sanctuary', block: bi });
  const ins = inscribed(poly, [], 0.5);
  const h = Math.min(45, ins.r * 0.8);
  if (h < 10) return;
  const sqr = (k: number): Polygon => rect(ins.c, 0, 2 * h * k, 2 * h * k);
  out.lines.push({ kind: 'ditch', path: sqr(1).concat([sqr(1)[0]]), width: 3 });
  out.lines.push({ kind: 'bank', path: sqr(0.93).concat([sqr(0.93)[0]]), width: 0.8 });
  const gal = sqr(0.26), cella = sqr(0.14);
  if (gal.every((q) => pointInRing(poly, q))) {
    out.buildings.push({ poly: gal, kind: 'landmark', parcel: pi, arch: 'fanum', roof: 'pyramidal', material: 'timber', storeys: 1 });
    out.lines.push({ kind: 'pyramid-step', path: cella.concat([cella[0]]), width: 0.6 });
    out.landmarks.push({ kind: 'sanctuary', poly: sqr(1) });
  }
  out.sites.push({ id: 'sanctuary', kind: 'sanctuary', role: 'worship', lot: poly, anchor: ins.c });
}

export { yardEarth };
