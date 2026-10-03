/**
 * Iroquoian village (Draper, Mantle, Kanata, Ganondagan): on a defensible rise near water, two or three rows of
 * palisade posts follow the lie of the ground, overlapping at the entrance (a baffled gate). Inside, bark
 * longhouses of 18–65 m (each the house of a matrilineal clan segment: its length follows its families) stand in
 * groups of parallel houses, each group with its own orientation (the village grew by additions); a plaza in the
 * middle, sweat lodges, corn cribs and middens against the palisade. Round the village, the cornfields; a hamlet
 * or a fishing camp is a few short longhouses without a palisade.
 *
 * Partition: quarter = the area inside the palisade; the lanes run along the boundaries between the house groups
 * (Voronoi edges of the group centres) and from the gate to the plaza; each group's block is cut into parallel
 * strips at its orientation, one longhouse per strip, its ends on the lanes.
 */
import { Delaunay } from 'd3-delaunay';
import type { Vec2, Polygon } from '../../core/geom';
import { dist } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { UrbanStreet } from '../../types';
import { area, orientPos, pointInRing, inscribed, bboxOf, obb } from '../../geo/poly';
import { MultiPoly, differenceS, intersectionS, unionMany } from '../../geo/bool';
import type { CampCtx } from './index';
import { snapRing, CampOut, emptyCamp, street, ellipse, carveBlocks, pathRibbons, cutExact, FrontIndex, apsidal, hut, fitIn, rect, pieces, openRing, at } from './kit';
import { Noise2D } from '../../core/noise';
import { waterDist } from './homesteads';

export function longhouseVillage(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  if (pop < 150) return longhouseHamlet(cc, c, pop, rng);
  const out = emptyCamp();
  const ctx = cc.ctx;
  const sf = Math.sqrt(cc.sprawl);
  const NL = Math.max(3, Math.round(pop / 30));
  const sr = rng.fork('shape');
  // ---- the outline: an oval bent to the ground (wider along the contour), wobbly
  const A = (NL * 560 + 900) * cc.sprawl;
  const aspect = sr.range(1.15, 1.55);
  const a = Math.sqrt((A * aspect) / Math.PI), b = Math.sqrt(A / (Math.PI * aspect));
  let ang = sr.range(0, Math.PI);
  {
    // along the contour of the rise
    const h = (q: Vec2) => ctx.heightAt(q);
    const gx = h({ x: c.x + 20, y: c.y }) - h({ x: c.x - 20, y: c.y }), gy = h({ x: c.x, y: c.y + 20 }) - h({ x: c.x, y: c.y - 20 });
    if (Math.hypot(gx, gy) > 0.4) ang = Math.atan2(gx, -gy);
  }
  const nz = new Noise2D(sr.fork('noise'));
  const wob = (t: number) => 0.09 * nz.noise(Math.cos(t) * 1.4 + 3, Math.sin(t) * 1.4 + 3);
  let oval = ellipse(c, a, b, ang, 72, wob);
  if (ctx.water.length) { const ps = pieces(differenceS([{ outer: oval, holes: [] }], ctx.water), 400); if (ps.length) oval = ps.reduce((p, q) => (area(q) > area(p) ? q : p)); }
  oval = snapRing(oval);
  out.quarters.push(oval);
  // ---- house groups: Voronoi of group centres; the plaza is the centre's cell
  const gr = rng.fork('groups');
  const nG = Math.max(2, Math.min(9, Math.round(NL / 4.5)));
  const seeds: Vec2[] = [c];
  for (let t = 0; t < nG * 30 && seeds.length < nG + 1; t++) {
    const q = at(c, gr.range(0, 2 * Math.PI), Math.sqrt(gr.float()) * Math.max(a, b) * 0.85);
    if (!pointInRing(oval, q) || seeds.some((s) => dist(s, q) < Math.sqrt(A / (nG + 1)) * 0.8)) continue;
    seeds.push(q);
  }
  const bb = bboxOf(oval);
  const vor = Delaunay.from(seeds.map((p) => [p.x, p.y] as [number, number])).voronoi([bb.x0 - 50, bb.y0 - 50, bb.x1 + 50, bb.y1 + 50]);
  const cells = seeds.map((_, i) => orientPos((vor.cellPolygon(i) ?? []).slice(0, -1).map(([x, y]) => ({ x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 }))));
  // the lanes: every Voronoi edge between two groups inside the oval (shared edges, each once)
  const streets: UrbanStreet[] = [];
  const seen = new Set<string>();
  const key = (p: Vec2) => Math.round(p.x * 10) + ',' + Math.round(p.y * 10);
  cells.forEach((poly) => {
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k], q = poly[(k + 1) % poly.length];
      const kk = [key(p), key(q)].sort().join('|');
      if (seen.has(kk)) continue;
      seen.add(kk);
      // (only edges between two cells: the box edges are not shared)
      const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      const owners = cells.filter((cp) => pointInRing(cp, { x: m.x + 0.01, y: m.y }) || pointInRing(cp, { x: m.x - 0.01, y: m.y }) || pointInRing(cp, { x: m.x, y: m.y + 0.01 }) || pointInRing(cp, { x: m.x, y: m.y - 0.01 }));
      if (owners.length < 2) continue;
      // clipped to the oval
      for (const piece of clipSeg(p, q, oval)) if (dist(piece[0], piece[1]) > 6) streets.push(street(piece, 3.6, 3, 'lane'));
    }
  });
  // ---- the gate: toward the nearest road (or the water), a path to the plaza
  let ga = cc.main ? cc.roadAngle : Math.atan2(ctx.center.y - c.y, ctx.center.x - c.x);
  let lo = 0, hi = Math.max(a, b) * 2;
  for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (pointInRing(oval, at(c, ga, m))) lo = m; else hi = m; }
  const gate = at(c, ga, lo);
  streets.push(street([at(c, ga, lo + 14), c], 4.2, 1, 'radial'));
  out.streets.push(...streets);
  const rib = unionMany(pathRibbons(streets).map((ph): MultiPoly => [ph]), 16, true);
  const blocks = carveBlocks(oval, rib, ctx.water);
  const front = new FrontIndex(out.streets);
  // ---- each group: its orientation, parallel strips (one longhouse each)
  const hr = rng.fork('houses');
  const gAng = seeds.map((_, i) => (i === 0 ? ang : ang + (hr.fork('g' + i).chance(0.4) ? Math.PI / 2 : 0) + hr.fork('g' + i).range(-0.35, 0.35)));
  let houses = 0;
  const groupOf = (p: Vec2): number => { let bi = 0, bd = Infinity; seeds.forEach((s, i) => { const d = dist(s, p); if (d < bd) { bd = d; bi = i; } }); return bi; };
  out.trees = out.trees ?? [];
  for (const blk of blocks) {
    const bi = out.blocks.length;
    out.blocks.push({ poly: blk, kind: 'block', quarter: 0 });
    const ic = inscribed(blk, [], 1).c;
    const g = groupOf(ic);
    if (g === 0) {
      // the plaza (dance ground); a sweat lodge at its edge
      out.parcels.push({ poly: blk, use: 'meadow', block: bi });
      out.squares.push(blk);
      continue;
    }
    const th = gAng[g];
    const ux = Math.cos(th), uy = Math.sin(th);
    const U = (p: Vec2) => (p.x - c.x) * ux + (p.y - c.y) * uy, V = (p: Vec2) => -(p.x - c.x) * uy + (p.y - c.y) * ux;
    const P = (u: number, v: number): Vec2 => ({ x: c.x + u * ux - v * uy, y: c.y + u * uy + v * ux });
    const vs = blk.map(V), us = blk.map(U);
    const v0 = Math.min(...vs), v1 = Math.max(...vs), u0 = Math.min(...us) - 2, u1 = Math.max(...us) + 2;
    const strips: { poly: Polygon; tag: number }[] = [];
    let v = v0 - 1, tag = 0;
    while (v < v1 + 1) {
      const w = hr.range(9.5, 12.5) * sf;
      strips.push({ poly: orientPos([P(u0, v), P(u1, v), P(u1, v + w), P(u0, v + w)]), tag: tag++ });
      v += w;
    }
    for (const pc of cutExact(blk, strips)) {
      const pi = out.parcels.length;
      const fr = front.frontage(pc.poly);
      if (fr.len < 3.2 || area(pc.poly) < 100) { out.parcels.push({ poly: pc.poly, use: 'garden', block: bi }); continue; }
      out.parcels.push({ poly: pc.poly, use: 'plot', block: bi });
      // the longhouse fills its strip less the lane margins: its length follows the strip (18–65 m)
      const pu = pc.poly.map(U), pv = pc.poly.map(V);
      const L = Math.min(65, Math.max(...pu) - Math.min(...pu) - 5);
      const W = hr.range(6.2, 7.6);
      const um = (Math.max(...pu) + Math.min(...pu)) / 2, vm = (Math.max(...pv) + Math.min(...pv)) / 2;
      const lh = L >= 18 ? fitIn(pc.poly, (q, s) => apsidal(q, th, Math.max(18, L * s), W, 4), [], { margin: 1, gap: 0, minScale: 0.4, cands: [P(um, vm), P(um - 3, vm), P(um + 3, vm), inscribed(pc.poly, [], 0.5).c] }) : null;
      if (lh) {
        out.buildings.push({ poly: lh, kind: 'house', parcel: pi, arch: 'longhouse', roof: 'barrel', storeys: 1, material: 'bark', orientation: th });
        // the roof: the ridge and the smoke holes of the hearths down the middle (one per two families)
        const lc = inscribed(lh, [], 0.3).c, o = obb(lh);
        const hl = Math.max(o.hu, o.hv);
        out.lines.push({ kind: 'roof-line', path: [{ x: lc.x - ux * (hl - 3), y: lc.y - uy * (hl - 3) }, { x: lc.x + ux * (hl - 3), y: lc.y + uy * (hl - 3) }], width: 0.2 });
        for (let x = -hl + 5; x < hl - 4; x += 6.5) out.lines.push({ kind: 'round-door', path: Array.from({ length: 7 }, (_, i) => ({ x: lc.x + ux * x + Math.cos((i / 6) * 2 * Math.PI) * 0.7, y: lc.y + uy * x + Math.sin((i / 6) * 2 * Math.PI) * 0.7 })), width: 0.3 });
        houses++;
      } else {
        // a short strip: a sweat lodge, a corn crib or a storage hut
        const kind = hr.float();
        const gg = fitIn(pc.poly, (q, s) => (kind < 0.4 ? hut(q, 2.3 * s, 10) : rect(q, th, 5 * s, 3.2 * s)), [], { margin: 0.8, gap: 0, minScale: 0.8 });
        if (gg) out.buildings.push({ poly: gg, kind: 'outbuilding', parcel: pi, arch: kind < 0.4 ? 'sweat-lodge' : 'corn-crib', roof: 'dome', storeys: 1, material: 'bark' });
      }
    }
  }
  // ---- the palisade: two or three rows of posts, the rows overlapping at the gate (a baffled entrance)
  const rows = pop > 700 ? 3 : 2;
  for (let k = 0; k < rows; k++) {
    const off = 1.8 + k * 3.2;
    const ring = ellipse(c, a + off, b + off, ang, 96, wob);
    // (each row opens a little further along: walking in means turning between them)
    const gp = at(c, ga + (k % 2 ? 0.08 : -0.08), dist(c, gate) + off);
    let best = ring[0], bd = Infinity;
    for (const q of ring) { const d = dist(q, gp); if (d < bd) { bd = d; best = q; } }
    for (const pl of openRing(ring, [{ p: best, width: 5 }])) out.lines.push({ kind: 'palisade', path: pl, width: 1 });
  }
  out.outline.push(ellipse(c, a + 12, b + 12, ang, 96, wob));
  // middens against the palisade, inside
  const mr = rng.fork('middens');
  for (let k = 0; k < Math.min(8, 2 + NL / 4); k++) {
    const t = mr.range(0, 2 * Math.PI);
    const p = { x: c.x + Math.cos(t) * (a - 6) * Math.cos(ang) - Math.sin(t) * (b - 6) * Math.sin(ang), y: c.y + Math.cos(t) * (a - 6) * Math.sin(ang) + Math.sin(t) * (b - 6) * Math.cos(ang) };
    const m = orientPos(Array.from({ length: 9 }, (_, i) => at(p, (i / 9) * 2 * Math.PI, mr.range(2.2, 3.6))));
    if (m.every((q) => pointInRing(oval, q))) out.landmarks.push({ kind: 'midden', poly: m });
  }
  if (cc.main) cornfields(out, cc, c, Math.max(a, b), pop, ang, rng.fork('fields'));
  out.sites.push({ id: 'palisade', kind: 'palisaded-village', role: 'power', lot: oval, anchor: c, tags: { longhouses: String(houses) } });
  return out;
}

/** The pieces of segment pq inside a ring. */
function clipSeg(p: Vec2, q: Vec2, ring: Polygon): Vec2[][] {
  const n = Math.max(2, Math.ceil(dist(p, q) / 2));
  const out: Vec2[][] = [];
  let cur: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const r = { x: p.x + ((q.x - p.x) * i) / n, y: p.y + ((q.y - p.y) * i) / n };
    if (pointInRing(ring, r)) cur.push(r);
    else if (cur.length) { out.push(cur.length > 1 ? [cur[0], cur[cur.length - 1]] : []); cur = []; }
  }
  if (cur.length) out.push(cur.length > 1 ? [cur[0], cur[cur.length - 1]] : []);
  // (a lane reaching the palisade stops 6 m short of it: the lane does not open the palisade)
  return out.filter((s) => s.length === 2);
}

/** Cornfields round the village: irregular clearings of corn hills among the woods, none on the roads or the water. */
function cornfields(out: CampOut, cc: CampCtx, c: Vec2, R0: number, pop: number, ang: number, fr: Rng): void {
  const ctx = cc.ctx;
  const nF = Math.min(14, 4 + Math.round(pop / 150));
  const roadRb = cc.roads.map((pl) => pathRibbons([street(pl, 14, 1, 'radial')])).flat();
  const done: { p: Vec2; r: number }[] = [];
  for (let k = 0; k < nF * 6 && done.length < nF; k++) {
    const r = fr.range(35, 85);
    const p = at(c, fr.range(0, 2 * Math.PI), R0 + 30 + r + fr.range(0, 220));
    if (p.x < r + 10 || p.y < r + 10 || p.x > ctx.mapSize - r - 10 || p.y > ctx.mapSize - r - 10) continue;
    if (done.some((d) => dist(d.p, p) < d.r + r + 12) || ctx.isWater(p) || ctx.slopeAt(p) > 0.25) continue;
    const ph = fr.range(0, 6), ph2 = fr.range(0, 6);
    const blob = orientPos(Array.from({ length: 24 }, (_, i) => {
      const t = (i / 24) * 2 * Math.PI;
      return at(p, t, r * (1 + 0.22 * Math.sin(t * 2 + ph) + 0.12 * Math.sin(t * 5 + ph2)) * (Math.abs(Math.cos(t - ang)) * 0.25 + 0.85));
    }));
    let m: MultiPoly = [{ outer: blob, holes: [] }];
    if (ctx.water.length) m = differenceS(m, ctx.water);
    if (roadRb.length) m = differenceS(m, roadRb);
    for (const q of pieces(m, 1500)) out.landmarks.push({ kind: 'cornfield', poly: q });
    done.push({ p, r });
  }
}

/** A hamlet or fishing camp: a few short longhouses by the water, no palisade, drying racks. */
export function longhouseHamlet(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  const out = emptyCamp();
  const ctx = cc.ctx;
  const n = Math.max(1, Math.round(pop / 22));
  const hr = rng.fork('h');
  // the camp ground: a rounded patch, the houses along the shore direction (else along the contour)
  const R = 18 + Math.sqrt(n) * 16;
  let ang = hr.range(0, Math.PI);
  const wd = waterDist(cc, c, 300);
  if (wd < 300) for (let k = 0; k < 24; k++) { const a = (k / 24) * 2 * Math.PI; if (ctx.isWater(at(c, a, wd))) { ang = a + Math.PI / 2; break; } }
  let ground = ellipse(c, R * 1.25, R * 0.85, ang, 40, (t) => 0.07 * Math.sin(t * 3 + hr.range(0, 6)));
  if (ctx.water.length) { const ps = pieces(differenceS([{ outer: ground, holes: [] }], ctx.water), 200); if (ps.length) ground = ps.reduce((p, q) => (area(q) > area(p) ? q : p)); }
  ground = snapRing(ground);
  out.quarters.push(ground); out.outline.push(ground);
  const lane = street([at(c, ang, -R * 1.4), at(c, ang, R * 1.4)], 3.4, 1, 'radial');
  out.streets.push(lane);
  const front = new FrontIndex(out.streets);
  const blocks = carveBlocks(ground, pathRibbons([lane]), ctx.water);
  out.trees = out.trees ?? [];
  let built = 0;
  for (const blk of blocks) {
    const bi = out.blocks.length;
    out.blocks.push({ poly: blk, kind: 'block', quarter: 0 });
    // lots across the lane: one short longhouse each, perpendicular to the lane
    const cellsL: { poly: Polygon; tag: number }[] = [];
    const ux = Math.cos(ang), uy = Math.sin(ang);
    for (let k = -8; k <= 8; k++) {
      const u0 = k * 16 - 8, u1 = u0 + 16;
      cellsL.push({ poly: orientPos([{ x: c.x + ux * u0 - uy * 200, y: c.y + uy * u0 + ux * 200 }, { x: c.x + ux * u1 - uy * 200, y: c.y + uy * u1 + ux * 200 }, { x: c.x + ux * u1 + uy * 200, y: c.y + uy * u1 - ux * 200 }, { x: c.x + ux * u0 + uy * 200, y: c.y + uy * u0 - ux * 200 }]), tag: k });
    }
    for (const pc of cutExact(blk, cellsL)) {
      const pi = out.parcels.length;
      const fr = front.frontage(pc.poly);
      if (fr.len < 3.2 || area(pc.poly) < 120 || built >= n || dist(inscribed(pc.poly, [], 1).c, c) > R * 1.1) { out.parcels.push({ poly: pc.poly, use: 'garden', block: bi }); continue; }
      out.parcels.push({ poly: pc.poly, use: 'plot', block: bi });
      built++;
      const L = hr.range(14, 26), W = hr.range(5.8, 6.8);
      const lh = fitIn(pc.poly, (q, s) => apsidal(q, ang + Math.PI / 2, L * s, W, 4), [], { margin: 1, gap: 0, minScale: 0.6 });
      if (lh) out.buildings.push({ poly: lh, kind: 'house', parcel: pi, arch: 'longhouse', roof: 'barrel', storeys: 1, material: 'bark', orientation: ang + Math.PI / 2 });
      // a drying rack for the fish or the corn
      const ic = inscribed(pc.poly, [], 0.5).c;
      if (hr.chance(0.6)) out.lines.push({ kind: 'drying-rack', path: [at(ic, ang, -3), at(ic, ang, 3)], width: 0.8 });
    }
  }
  out.sites.push({ id: 'camp', kind: 'hamlet', role: 'civic', lot: ground, anchor: c });
  return out;
}
