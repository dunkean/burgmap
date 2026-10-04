/**
 * Khmer settlements (Angkor):
 * - the walled city (Angkor Thom): a square on the cardinal axes, laterite wall and broad moat, gates with causeways
 *   over the moat lined by naga balustrades; avenues from the gates to the temple-mountain at the centre (the
 *   Bayon: stepped terraces in concentric galleries); the royal palace north of it (Phimeanakas, the Terrace of the
 *   Elephants facing the Royal Square), the Baphuon beside it; inside, a cardinal grid of earthen dykes: every
 *   block a ring of house lots along its dykes (houses on stilts, granaries, palms, a pond) round its rice
 *   paddies and its pond (srah), with a few monasteries (a small prasat in its moated court);
 * - outside, the barays (great rectangular reservoirs with their island temple, the mebon) and, for a city, Angkor
 *   Wat: the temple-mountain of five towers in its three galleries, on its island in a broad moat, its causeway
 *   from the west;
 * - a village is a street of stilt houses along an embankment road, its prasat in a moated court at the end.
 *
 * Partition: quarter = the square less the water; cuts = avenues, ring lane, dykes; the centre, the palace and the
 * Royal Square are compound blocks; every other block is cut into exact rectangles (the lot ring along its dykes,
 * the paddy inside).
 */
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { UrbanStreet } from '../../types';
import { orientPos, pointInRing, inscribed, area, bboxOf, segSegT } from '../../geo/poly';
import { intersectionS, differenceS, tryIntersection, mpArea } from '../../geo/bool';
import { wetArea } from '../waterland';
import { ribbon } from '../../geo/offset';
import type { CampCtx } from './index';
import { snapRing, CampOut, emptyCamp, street, carveBlocks, pathRibbons, cutExact, FrontIndex, rect, fits, fitIn, openRing, pieces } from './kit';
import { pyramid } from '../aztec';
import type { CompoundOut } from '../compounds';
import { wallFeatures } from '../walls';

const sq = (c: Vec2, h: number): Polygon => orientPos([{ x: c.x - h, y: c.y - h }, { x: c.x + h, y: c.y - h }, { x: c.x + h, y: c.y + h }, { x: c.x - h, y: c.y + h }]);
const box = (x0: number, y0: number, x1: number, y1: number): Polygon => orientPos([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]);
const ring = (p: Polygon): Vec2[] => p.concat([p[0]]);

/** Cut the 10 m moat around a village prasat by its actual 6 m causeway, including oblique/corner crossings.
 * The centreline exclusion reserves half the moat width as well, so neither the water band nor round caps
 * can intrude on the road. Only this village fallback uses it; the cardinal city moat keeps its old geometry. */
export function prasatMoatPaths(center: Vec2, causeway: [Vec2, Vec2]): Polyline[] {
  const [from, stop] = causeway, length = Math.hypot(stop.x - from.x, stop.y - from.y);
  if (length < 1e-6) return [];
  const dx = (stop.x - from.x) / length, dy = (stop.y - from.y) / length;
  const clearance = ribbon([{ x: from.x - 5.01 * dx, y: from.y - 5.01 * dy },
    { x: stop.x + 5.01 * dx, y: stop.y + 5.01 * dy }], 16.02);
  const moat = sq(center, 37), paths: Polyline[] = [];
  let current: Polyline = [];
  for (let i = 0; i < moat.length; i++) {
    const a = moat[i], b = moat[(i + 1) % moat.length], ts = [0, 1];
    for (let j = 0; j < clearance.length; j++) {
      const hit = segSegT(a, b, clearance[j], clearance[(j + 1) % clearance.length]);
      if (hit && hit.t > 1e-9 && hit.t < 1 - 1e-9) ts.push(hit.t);
    }
    ts.sort((a, b) => a - b);
    const at = (t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    for (let j = 1; j < ts.length; j++) {
      if (ts[j] - ts[j - 1] < 1e-9) continue;
      if (pointInRing(clearance, at((ts[j - 1] + ts[j]) / 2))) {
        if (current.length > 1) paths.push(current);
        current = [];
      } else {
        if (!current.length) current.push(at(ts[j - 1]));
        current.push(at(ts[j]));
      }
    }
  }
  if (current.length > 1) paths.push(current);
  if (paths.length > 1) {
    const first = paths[0], last = paths[paths.length - 1];
    if (Math.hypot(first[0].x - last.at(-1)!.x, first[0].y - last.at(-1)!.y) < 1e-8) {
      paths[0] = last.concat(first.slice(1)); paths.pop();
    }
  }
  return paths;
}

export function khmerCity(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  if (pop < 1200) return khmerVillage(cc, c, pop, rng);
  const out = emptyCamp();
  const ctx = cc.ctx;
  const city = pop >= 12000;
  const dens = 62 / cc.sprawl;
  const H = Math.min(ctx.mapSize * 0.3, Math.max(180, Math.sqrt((pop / dens) * 1e4) / 2)); // half side
  // (the streams crossing the city stay open water: the quarter is the square less the water)
  const quarters = (ctx.water.length ? pieces(differenceS([{ outer: sq(c, H), holes: [] }], ctx.water), 400) : [sq(c, H)]).map(snapRing);
  out.quarters.push(...quarters);
  const avW = city ? 10 : 7, dyW = 4;
  const T = Math.max(34, Math.min(H * 0.14, 130)); // half side of the temple block
  const Pp = Math.max(90, Math.min(150, H / 4)) * Math.sqrt(cc.sprawl); // dyke pitch
  // ---- streets: four avenues gate → temple, the street round the temple, the ring lane, the dyke lattice; the
  // Victory avenue from the east gate to the Royal Square (a city)
  const streets: UrbanStreet[] = [];
  const ext = 10;
  const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dy] of dirs) streets.push(street([{ x: c.x + dx * (H + ext), y: c.y + dy * (H + ext) }, { x: c.x + dx * (T + avW / 2 + 1), y: c.y + dy * (T + avW / 2 + 1) }], avW, 1, 'radial'));
  const tr = T + avW / 2 + 1;
  streets.push(street(ring(sq(c, tr)), avW, 1, 'ring'));
  const ringH = H - dyW / 2;
  streets.push(street(ring(sq(c, ringH)), dyW, 3, 'ring'));
  const lines: number[] = [];
  for (let k = 1; k * Pp < H - Pp * 0.45; k++) lines.push(k * Pp);
  for (const off of lines) for (const sgn of [-1, 1]) {
    const o = sgn * off;
    if (Math.abs(o) > tr + 6) {
      streets.push(street([{ x: c.x + o, y: c.y - ringH }, { x: c.x + o, y: c.y + ringH }], dyW, 3, 'lane'));
      streets.push(street([{ x: c.x - ringH, y: c.y + o }, { x: c.x + ringH, y: c.y + o }], dyW, 3, 'lane'));
    } else for (const [a, b] of [[-ringH, -tr], [tr, ringH]]) {
      streets.push(street([{ x: c.x + o, y: c.y + a }, { x: c.x + o, y: c.y + b }], dyW, 3, 'lane'));
      streets.push(street([{ x: c.x + a, y: c.y + o }, { x: c.x + b, y: c.y + o }], dyW, 3, 'lane'));
    }
  }
  // the Victory gate: a second east gate, its avenue to the palace's Royal Square
  const vy = c.y - Math.max(tr + Pp * 0.5, Math.min(H * 0.35, tr + Pp));
  if (city) streets.push(street([{ x: c.x + H + ext, y: vy }, { x: c.x + tr + 4, y: vy }], avW, 1, 'radial'));
  out.streets.push(...streets);
  const rib = pathRibbons(streets);
  const blocks: { b: Polygon; q: number }[] = quarters.flatMap((Q, qi) => carveBlocks(Q, rib, []).map((b) => ({ b, q: qi })));
  const front = new FrontIndex(out.streets);
  const hr = rng.fork('houses');
  // the palace: the block north of the temple on the west of the north avenue; the Royal Square east of it
  let palaceBi = -1, squareBi = -1, baphuonBi = -1;
  blocks.forEach(({ b }, i) => {
    const ic = inscribed(b, [], 1).c;
    if (palaceBi < 0 && ic.y < c.y - tr && ic.x < c.x && ic.x > c.x - Pp * 1.6 && ic.y > c.y - tr - Pp * 1.6) palaceBi = i;
  });
  if (palaceBi >= 0) {
    const pc = inscribed(blocks[palaceBi].b, [], 1).c;
    blocks.forEach(({ b }, i) => {
      if (i === palaceBi) return;
      const ic = inscribed(b, [], 1).c;
      if (squareBi < 0 && ic.x > c.x && Math.abs(ic.y - pc.y) < Pp * 0.8 && ic.x < c.x + Pp * 1.6) squareBi = i;
      if (baphuonBi < 0 && Math.abs(ic.x - pc.x) < Pp * 0.8 && ic.y > pc.y + 10 && ic.y < c.y + Pp && !pointInRing(b, c)) baphuonBi = i;
    });
  }
  const monk = rng.fork('monasteries');
  blocks.forEach(({ b, q: qi }, i) => {
    const bi = out.blocks.length;
    if (pointInRing(b, c)) {
      // ---- the temple-mountain (Bayon): stepped pyramid in concentric galleries open on the four axes
      out.blocks.push({ poly: b, kind: 'compound', compound: 'temple-mountain', quarter: qi });
      out.parcels.push({ poly: b, use: 'compound:temple-mountain', block: bi });
      const tmp: CompoundOut = { parcels: [{ poly: b, use: 'compound:temple-mountain' }], buildings: [], lines: [], water: [], landmarks: [] };
      const ins = inscribed(b, [], 1);
      const h = Math.max(12, Math.min(60, ins.r * 0.5));
      const Py = pyramid(tmp, b, c, 0, h, 'temple-mountain', 0, false);
      if (Py) out.landmarks.push({ kind: 'temple-mountain', poly: Py });
      for (const gk of [1.3, 1.6]) {
        const g = sq(c, Math.min(ins.r - 2.5, h * gk));
        if (g.every((q) => pointInRing(b, q))) for (const pl of openRing(g, dirs.map(([dx, dy]) => ({ p: { x: c.x + dx * h * gk, y: c.y + dy * h * gk }, width: 6 })))) tmp.lines.push({ kind: 'gallery', path: pl, width: 2.2 });
      }
      // the face towers on the summit (the quincunx)
      for (const [dx, dy] of [[0, 0], [-1, -1], [1, -1], [1, 1], [-1, 1]]) { const t = sq({ x: c.x + dx * h * 0.32, y: c.y + dy * h * 0.32 }, h * (dx ? 0.07 : 0.11)); tmp.lines.push({ kind: 'pyramid-step', path: ring(t), width: 0.6 }); }
      for (const bd of tmp.buildings) out.buildings.push({ ...bd, parcel: out.parcels.length - 1 });
      out.lines.push(...tmp.lines);
      out.sites.push({ id: 'temple-mountain', kind: 'temple-mountain', role: 'worship', lot: b, anchor: c });
      return;
    }
    if (i === palaceBi) {
      // ---- the royal palace: walled, the Phimeanakas, pools; its terrace on the east side
      out.blocks.push({ poly: b, kind: 'compound', compound: 'royal-palace', quarter: qi });
      out.parcels.push({ poly: b, use: 'compound:royal-palace', block: bi });
      const pi = out.parcels.length - 1;
      const tmp: CompoundOut = { parcels: [{ poly: b, use: 'compound:royal-palace' }], buildings: [], lines: [], water: [], landmarks: [] };
      const ins = inscribed(b, [], 1);
      pyramid(tmp, b, { x: ins.c.x - ins.r * 0.15, y: ins.c.y - ins.r * 0.1 }, 0, Math.min(16, ins.r * 0.3), 'phimeanakas', 0, false);
      const bb = bboxOf(b);
      const terr = box(bb.x1 - 9, ins.c.y - ins.r * 0.75, bb.x1 - 2.5, ins.c.y + ins.r * 0.75);
      if (fits(b, terr, tmp.buildings.map((x) => x.poly), 0.5, 1)) tmp.buildings.push({ poly: terr, kind: 'landmark', parcel: 0, arch: 'elephant-terrace', roof: 'none', material: 'stone', storeys: 1 });
      // halls of the palace
      for (const [dx, dy] of [[-0.55, 0.45], [0.05, 0.55], [-0.6, -0.5]]) {
        const g = rect({ x: ins.c.x + dx * ins.r, y: ins.c.y + dy * ins.r }, 0, ins.r * 0.45, 7);
        if (fits(b, g, tmp.buildings.map((x) => x.poly), 1, 2)) tmp.buildings.push({ poly: g, kind: 'landmark', parcel: 0, arch: 'palace-hall', roof: 'gable', material: 'wood', storeys: 1 });
      }
      for (const bd of tmp.buildings) out.buildings.push({ ...bd, parcel: pi });
      out.lines.push(...tmp.lines, { kind: 'stone-wall', path: ring(b), width: 1.4 });
      for (const [px, py, w2, h2] of [[-0.75, 0.05, 0.4, 0.22], [0.1, -0.7, 0.35, 0.18]]) {
        const pool = box(ins.c.x + px * ins.r, ins.c.y + py * ins.r, ins.c.x + (px + w2) * ins.r, ins.c.y + (py + h2) * ins.r);
        if (pool.every((q) => pointInRing(b, q)) && !tmp.buildings.some((x) => x.poly.some((q) => pointInRing(pool, q)) || pool.some((q) => pointInRing(x.poly, q)))) out.landmarks.push({ kind: 'pond', poly: pool });
      }
      out.sites.push({ id: 'royal-palace', kind: 'royal-palace', role: 'power', lot: b, anchor: ins.c });
      return;
    }
    if (i === squareBi) {
      // ---- the Royal Square (parade ground) before the terrace: open, paved by the avenue, the Khleangs on its east
      out.blocks.push({ poly: b, kind: 'compound', compound: 'royal-square', quarter: qi });
      out.parcels.push({ poly: b, use: 'place', block: bi });
      const pi = out.parcels.length - 1;
      const bb = bboxOf(b);
      const ins = inscribed(b, [], 1);
      for (const dy of [-0.45, 0.45]) {
        const g = rect({ x: bb.x1 - 9, y: ins.c.y + dy * ins.r }, Math.PI / 2, ins.r * 0.6, 8);
        if (fits(b, g, out.buildings.filter((x) => x.parcel === pi).map((x) => x.poly), 1, 2)) out.buildings.push({ poly: g, kind: 'landmark', parcel: pi, arch: 'khleang', roof: 'gable', material: 'stone', storeys: 1 });
      }
      out.squares.push(b);
      return;
    }
    if (i === baphuonBi) {
      // ---- the Baphuon: a large temple-mountain on its own block, its raised causeway from the east
      out.blocks.push({ poly: b, kind: 'compound', compound: 'baphuon', quarter: qi });
      out.parcels.push({ poly: b, use: 'compound:baphuon', block: bi });
      const tmp: CompoundOut = { parcels: [{ poly: b, use: 'compound:baphuon' }], buildings: [], lines: [], water: [], landmarks: [] };
      const ins = inscribed(b, [], 1);
      pyramid(tmp, b, { x: ins.c.x - ins.r * 0.15, y: ins.c.y }, 0, Math.min(30, ins.r * 0.45), 'baphuon', 0, false);
      for (const bd of tmp.buildings) out.buildings.push({ ...bd, parcel: out.parcels.length - 1 });
      out.lines.push(...tmp.lines, { kind: 'gallery', path: ring(sq(ins.c, ins.r * 0.8)), width: 1.6 });
      return;
    }
    out.blocks.push({ poly: b, kind: 'block', quarter: qi });
    const monastery = monk.chance(city ? 0.1 : 0.07) && area(b) > Pp * Pp * 0.6;
    fillDykeBlock(out, bi, b, front, hr.fork('b' + i), monastery, city);
  });
  // ---- wall, moat, gates; the causeways over the moat with their naga balustrades
  const gates = dirs.map(([dx, dy]) => ({ p: { x: c.x + dx * H, y: c.y + dy * H }, dir: { x: -dx, y: -dy }, width: avW + 1 }));
  if (city) gates.push({ p: { x: c.x + H, y: vy }, dir: { x: -1, y: 0 }, width: avW + 1 });
  const wall = sq(c, H);
  const wf = wallFeatures(wall, gates, rng.fork('wall'), ctx.isWater, () => false, 1e9);
  out.walls.push({ path: wall, closed: true, towers: [], gates: gates.map((g) => g.p), thickness: city ? 3.5 : 2.5, gateInfo: gates, pieces: wf.pieces, gateTowers: wf.gateTowers, towerScale: [], curtains: [], towerShape: 'square', role: 'town' });
  const mw = city ? 60 : 26;
  const mr = H + 14 + mw / 2;
  const gapAt = gates.map((g) => ({ p: { x: c.x + (g.p.x - c.x) * (mr / H), y: c.y + (g.p.y - c.y) * (mr / H) }, width: avW + 4 }));
  // (the Victory gate's crossing sits off the axis: its gap at its own height)
  if (city) gapAt[4] = { p: { x: c.x + mr, y: vy }, width: avW + 4 };
  for (const pl of openRing(sq(c, mr), gapAt)) out.lines.push({ kind: 'moat', path: pl, width: mw });
  for (const g of gates) {
    const out0 = { x: g.p.x - g.dir.x * (14 + mw + 6), y: g.p.y - g.dir.y * (14 + mw + 6) };
    const nx = -g.dir.y, ny = g.dir.x;
    for (const s of [-1, 1]) out.lines.push({ kind: 'balustrade', path: [{ x: g.p.x + nx * s * (avW / 2 + 0.6), y: g.p.y + ny * s * (avW / 2 + 0.6) }, { x: out0.x + nx * s * (avW / 2 + 0.6), y: out0.y + ny * s * (avW / 2 + 0.6) }], width: 1 });
  }
  out.outline.push(sq(c, mr + mw / 2 + 8));
  // ---- outside: the barays (main city), Angkor Wat south of the moat (a city)
  if (city && cc.main) angkorWat(out, cc, c, H, mr + mw / 2, rng.fork('wat'));
  if (cc.main) barays(out, cc, c, H, mr + mw / 2, pop, rng.fork('baray'));
  return out;
}

/** A dyke block: the ring of house lots along its dykes round its paddies and their pond (or a monastery). */
function fillDykeBlock(out: CampOut, bi: number, b: Polygon, front: FrontIndex, r: Rng, monastery: boolean, city: boolean): void {
  const bb = bboxOf(b);
  const W = bb.x1 - bb.x0, Hh = bb.y1 - bb.y0;
  const D = Math.min(28, Math.min(W, Hh) * 0.3);
  const cells: { poly: Polygon; tag: number }[] = [];
  const inner = W > 2 * D + 20 && Hh > 2 * D + 20 ? box(bb.x0 + D, bb.y0 + D, bb.x1 - D, bb.y1 - D) : null;
  let tag = 0;
  const lotsAlong = (x0: number, y0: number, x1: number, y1: number, alongX: boolean) => {
    const L = alongX ? x1 - x0 : y1 - y0;
    if (L < 6) return;
    const n = Math.max(1, Math.round(L / r.range(22, 32)));
    for (let k = 0; k < n; k++) {
      const a = (alongX ? x0 : y0) + (L * k) / n, e = (alongX ? x0 : y0) + (L * (k + 1)) / n;
      cells.push({ poly: alongX ? box(a, y0, e, y1) : box(x0, a, x1, e), tag: tag++ });
    }
  };
  if (inner) {
    lotsAlong(bb.x0 - 1, bb.y0 - 1, bb.x1 + 1, bb.y0 + D, true);
    lotsAlong(bb.x0 - 1, bb.y1 - D, bb.x1 + 1, bb.y1 + 1, true);
    lotsAlong(bb.x0 - 1, bb.y0 + D, bb.x0 + D, bb.y1 - D, false);
    lotsAlong(bb.x1 - D, bb.y0 + D, bb.x1 + 1, bb.y1 - D, false);
    cells.push({ poly: inner, tag: -2 });
  } else {
    const wide = W >= Hh;
    const m = wide ? (bb.y0 + bb.y1) / 2 : (bb.x0 + bb.x1) / 2;
    if (wide) { lotsAlong(bb.x0 - 1, bb.y0 - 1, bb.x1 + 1, m, true); lotsAlong(bb.x0 - 1, m, bb.x1 + 1, bb.y1 + 1, true); }
    else { lotsAlong(bb.x0 - 1, bb.y0 - 1, m, bb.y1 + 1, false); lotsAlong(m, bb.y0 - 1, bb.x1 + 1, bb.y1 + 1, false); }
  }
  for (const pc of cutExact(b, cells)) {
    const pi = out.parcels.length;
    if (pc.tag === -2) {
      if (monastery) {
        // a monastery: a small prasat on its platform inside a moated court
        out.parcels.push({ poly: pc.poly, use: 'compound:monastery', block: bi });
        const ins = inscribed(pc.poly, [], 1);
        const h = Math.min(ins.r * 0.8, 40);
        out.lines.push({ kind: 'moat', path: ring(sq(ins.c, h)), width: Math.min(6, h * 0.12) });
        const pr = sq(ins.c, Math.min(7, h * 0.3));
        if (fits(pc.poly, pr, [], 1, 0)) {
          out.buildings.push({ poly: pr, kind: 'landmark', parcel: pi, arch: 'prasat', roof: 'pyramidal', material: 'stone', storeys: 3 });
          out.lines.push({ kind: 'pyramid-step', path: ring(sq(ins.c, Math.min(7, h * 0.3) * 0.6)), width: 0.5 });
          out.lines.push({ kind: 'gallery', path: ring(sq(ins.c, h * 0.62)), width: 1.2 });
        }
        continue;
      }
      // the paddies and the block's pond (srah)
      out.parcels.push({ poly: pc.poly, use: 'field', block: bi });
      const ib = bboxOf(pc.poly);
      const step = r.range(14, 20);
      for (let x = ib.x0 + step; x < ib.x1 - 2; x += step) out.lines.push({ kind: 'bund', path: [{ x, y: ib.y0 + 1 }, { x, y: ib.y1 - 1 }], width: 0.5 });
      for (let y = ib.y0 + step; y < ib.y1 - 2; y += step) out.lines.push({ kind: 'bund', path: [{ x: ib.x0 + 1, y }, { x: ib.x1 - 1, y }], width: 0.5 });
      const ins = inscribed(pc.poly, [], 1);
      const pw = Math.min(ins.r * 0.9, r.range(12, 26)), ph = Math.min(ins.r * 0.7, r.range(9, 18));
      const pond = box(ins.c.x - pw, ins.c.y - ph, ins.c.x + pw, ins.c.y + ph);
      if (pond.every((q) => pointInRing(pc.poly, q))) out.landmarks.push({ kind: 'pond', poly: pond });
      continue;
    }
    const fr = front.frontage(pc.poly);
    if (fr.len < 3.2 || area(pc.poly) < 120) { out.parcels.push({ poly: pc.poly, use: 'garden', block: bi }); continue; }
    out.parcels.push({ poly: pc.poly, use: 'plot', block: bi });
    // the stilt house near the dyke, its granary, a small pond behind it, palms
    const li = inscribed(pc.poly, [], 0.5);
    const toward = fr.mid ? { x: fr.mid.x - li.c.x, y: fr.mid.y - li.c.y } : { x: 0, y: 1 };
    const tl = Math.hypot(toward.x, toward.y) || 1;
    const u = { x: toward.x / tl, y: toward.y / tl };
    const ang = Math.abs(u.x) > Math.abs(u.y) ? Math.PI / 2 : 0;
    const placed: Polygon[] = [];
    const hc = { x: li.c.x + u.x * li.r * 0.4, y: li.c.y + u.y * li.r * 0.4 };
    const L = r.range(9, 14), Wd = r.range(5, 6.8);
    const house = fitIn(pc.poly, (q, s) => rect(q, ang, L * s, Wd), placed, { margin: 1.2, gap: 0, minScale: 0.7, cands: [hc, li.c] });
    if (house) {
      placed.push(house);
      out.buildings.push({ poly: house, kind: 'house', parcel: pi, arch: 'stilt-house', roof: 'gable', storeys: 1, material: 'wood', orientation: ang });
      const ux = Math.cos(ang), uy = Math.sin(ang);
      const hcc = inscribed(house, [], 0.3).c;
      out.lines.push({ kind: 'roof-line', path: [{ x: hcc.x - ux * (L / 2 - 1.5), y: hcc.y - uy * (L / 2 - 1.5) }, { x: hcc.x + ux * (L / 2 - 1.5), y: hcc.y + uy * (L / 2 - 1.5) }], width: 0.2 });
    }
    if (r.chance(0.55)) { const g = fitIn(pc.poly, (q, s) => rect(q, 0, 3 * s, 3 * s), placed, { margin: 1, gap: 1.5, minScale: 0.85, step: 3 }); if (g) { placed.push(g); out.buildings.push({ poly: g, kind: 'outbuilding', parcel: pi, arch: 'granary-on-posts', roof: 'gable', storeys: 1, material: 'wood' }); } }
    if (r.chance(0.35)) {
      const pd = rect({ x: li.c.x - u.x * li.r * 0.45, y: li.c.y - u.y * li.r * 0.45 }, ang, r.range(6, 9), r.range(4, 6));
      if (pd.every((q) => pointInRing(pc.poly, q)) && !placed.some((p) => p.some((q) => pointInRing(pd, q)) || pd.some((q) => pointInRing(p, q)))) { out.landmarks.push({ kind: 'pond', poly: pd }); placed.push(pd); }
    }
    out.trees = out.trees ?? [];
    for (let k = 0; k < r.int(1, 3); k++) {
      const tq = { x: li.c.x + r.range(-1, 1) * li.r * 0.8, y: li.c.y + r.range(-1, 1) * li.r * 0.8 };
      if (pointInRing(pc.poly, tq) && !placed.some((p) => pointInRing(p, tq) || p.some((q) => Math.hypot(q.x - tq.x, q.y - tq.y) < 2.8))) out.trees.push({ x: tq.x, y: tq.y, r: r.range(1.8, 2.6) });
    }
    void city;
  }
}

/** The barays east (then west, north, south) of the city: great reservoirs with their mebon. */
function barays(out: CampOut, cc: CampCtx, c: Vec2, H: number, R: number, pop: number, r: Rng): void {
  const ctx = cc.ctx;
  const L0 = Math.min(H * 2.6, 2600);
  const roadHit = (Pp: Polygon): boolean => cc.roads.some((pl) => pl.some((q, i) => {
    if (pointInRing(Pp, q)) return true;
    if (i === 0) return false;
    const a2 = pl[i - 1];
    for (let t = 0.25; t < 1; t += 0.25) if (pointInRing(Pp, { x: a2.x + (q.x - a2.x) * t, y: a2.y + (q.y - a2.y) * t })) return true;
    return false;
  }));
  const wet = (Pp: Polygon): boolean => { const bb = bboxOf(Pp); for (let x = bb.x0; x <= bb.x1; x += 30) for (let y = bb.y0; y <= bb.y1; y += 30) if (ctx.isWater({ x, y })) return true; return false; };
  const cands: Polygon[] = [];
  for (const k2 of [1, 0.75, 0.55, 0.4]) for (const off of [0, -0.45, 0.45]) {
    const L = L0 * k2, W = Math.min(L * 0.27, 700);
    cands.push(box(c.x + R + 60, c.y - W / 2 + off * H, c.x + R + 60 + L, c.y + W / 2 + off * H));
    cands.push(box(c.x - R - 60 - L, c.y - W / 2 + off * H, c.x - R - 60, c.y + W / 2 + off * H));
    cands.push(box(c.x - L / 2 + off * H, c.y - R - 60 - W, c.x + L / 2 + off * H, c.y - R - 60));
  }
  let made = 0;
  for (const B of cands) {
    if (made >= (pop > 9000 ? 2 : 1)) break;
    const bb = bboxOf(B);
    if (bb.x0 < 15 || bb.y0 < 15 || bb.x1 > ctx.mapSize - 15 || bb.y1 > ctx.mapSize - 15) continue;
    if (roadHit(B) || wet(B) || out.landmarks.some((l) => (l.kind === 'baray' || l.kind === 'wat-moat') && intersectionS(l.poly, B).length)) continue;
    out.landmarks.push({ kind: 'baray', poly: B });
    // the embankment round it
    out.lines.push({ kind: 'bank', path: ring(B), width: 0.8 });
    out.outline.push(B);
    const bc = { x: (bb.x0 + bb.x1) / 2, y: (bb.y0 + bb.y1) / 2 };
    const ms = Math.min(45, Math.min(bb.x1 - bb.x0, bb.y1 - bb.y0) * 0.12);
    out.landmarks.push({ kind: 'mebon', poly: sq(bc, ms) });
    out.lines.push({ kind: 'pyramid-step', path: ring(sq(bc, ms * 0.45)), width: 0.6 });
    out.sites.push({ id: 'baray:' + made, kind: 'baray', role: 'civic', lot: B, anchor: bc });
    made++;
  }
  void r;
}

/** Angkor Wat: the island of the temple in its moat, south of the city (else west or east), causeway from the west. */
function angkorWat(out: CampOut, cc: CampCtx, c: Vec2, H: number, R: number, r: Rng): void {
  const ctx = cc.ctx;
  const S = Math.max(90, H * 0.22); // half side of the island
  const mw = Math.max(30, H * 0.08);
  for (const [dx, dy] of [[0, 1], [-1, 0.2], [1, 0.2], [0.5, 1], [-0.5, 1], [0, -1], [-1, -0.4], [1, -0.4]]) {
    const ac = { x: c.x + dx * (R + 25 + S + mw), y: c.y + dy * (R + 25 + S + mw) };
    const outer = sq(ac, S + mw);
    const bb = bboxOf(outer);
    if (bb.x0 < 15 || bb.y0 < 15 || bb.x1 > ctx.mapSize - 15 || bb.y1 > ctx.mapSize - 15) continue;
    let wet = false;
    for (let x = bb.x0; x <= bb.x1 && !wet; x += 30) for (let y = bb.y0; y <= bb.y1; y += 30) if (ctx.isWater({ x, y })) { wet = true; break; }
    if (wet || wetArea(outer, ctx.water) > 0.01 || out.landmarks.some((l) => l.kind === 'baray' && intersectionS(l.poly, outer).length)) continue;
    // the island: a quarter of its own (one block, one compound parcel)
    const island = snapRing(sq(ac, S));
    const qi = out.quarters.length;
    out.quarters.push(island); out.outline.push(outer);
    // the causeway from the west across the moat to the west gopura
    const cw = street([{ x: ac.x - S - mw - 12, y: ac.y }, { x: ac.x - S * 0.55, y: ac.y }], 9, 1, 'radial');
    out.streets.push(cw);
    const blocks = carveBlocks(island, pathRibbons([cw]), []);
    for (const b of blocks) {
      const bi = out.blocks.length;
      out.blocks.push({ poly: b, kind: 'compound', compound: 'angkor-wat', quarter: qi });
      const pi = out.parcels.length;
      out.parcels.push({ poly: b, use: 'compound:angkor-wat', block: bi });
      if (!pointInRing(b, ac)) continue;
      // three galleries round the five-towered temple-mountain
      for (const k of [0.55, 0.4, 0.27]) out.lines.push({ kind: 'gallery', path: ring(sq(ac, S * k)), width: 2.4 });
      const tm = sq(ac, S * 0.18);
      if (fits(b, tm, [], 1, 0)) {
        out.buildings.push({ poly: tm, kind: 'landmark', parcel: pi, arch: 'angkor-wat', roof: 'pyramidal', material: 'stone', storeys: 5 });
        out.landmarks.push({ kind: 'angkor-wat', poly: tm });
        for (const [ddx, ddy, sz] of [[0, 0, 0.07], [-1, -1, 0.04], [1, -1, 0.04], [1, 1, 0.04], [-1, 1, 0.04]]) out.lines.push({ kind: 'pyramid-step', path: ring(sq({ x: ac.x + ddx * S * 0.11, y: ac.y + ddy * S * 0.11 }, S * sz)), width: 0.7 });
      }
      // the enclosure wall of the island
      out.lines.push({ kind: 'stone-wall', path: ring(sq(ac, S * 0.97)), width: 1.4 });
    }
    for (const pl of openRing(sq(ac, S + mw / 2), [{ p: { x: ac.x - S - mw / 2, y: ac.y }, width: 11 }])) out.lines.push({ kind: 'moat', path: pl, width: mw });
    out.landmarks.push({ kind: 'wat-moat', poly: outer });
    out.sites.push({ id: 'angkor-wat', kind: 'temple-mountain', role: 'worship', lot: island, anchor: ac });
    return;
  }
  void r;
}

/** A Khmer village: stilt houses along an embankment road, its prasat in a moated court at the end. */
function khmerVillage(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  const out = emptyCamp();
  const ctx = cc.ctx;
  const nH = Math.max(3, Math.round(pop / 6));
  const lotW = 26 * Math.sqrt(cc.sprawl), D = 34;
  // the embankment roads (one per ~36 houses, parallel, paddies between them) along the main road's direction,
  // snapped to the nearer cardinal axis; a cross road joins them through the middle
  const a0 = cc.main ? cc.roadAngle : Math.atan2(ctx.center.y - c.y, ctx.center.x - c.x);
  const horiz = Math.abs(Math.cos(a0)) >= Math.abs(Math.sin(a0));
  const rows = Math.max(1, Math.ceil(nH / 36));
  const pitch = 2 * D + 6 + 60;
  const lr = rng.fork('rows');
  const P = (u: number, v: number): Vec2 => (horiz ? { x: c.x + u, y: c.y + v } : { x: c.x + v, y: c.y + u });
  const hr = rng.fork('houses');
  const roads: UrbanStreet[] = [];
  const strips: Polygon[] = [];
  let x1 = 0;
  for (let k = 0; k < rows; k++) {
    const v = (k - (rows - 1) / 2) * pitch;
    const n = Math.ceil(nH / rows / 2);
    const len = n * lotW * lr.range(0.85, 1.15);
    const sh = lr.range(-0.2, 0.2) * len;
    const u0 = -len / 2 + sh, u1 = len / 2 + sh;
    x1 = Math.max(x1, u1);
    const a = P(u0, v - D - 3), b = P(u1, v + D + 3);
    strips.push(box(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)));
    roads.push(street([P(u0 - 10, v), P(u1 + 10, v)], 5, rows > 1 ? 2 : 1, 'radial'));
  }
  if (rows > 1) roads.push(street([P(0, -((rows - 1) / 2) * pitch - D - 12), P(0, ((rows - 1) / 2) * pitch + D + 12)], 5.5, 1, 'radial'));
  out.streets.push(...roads);
  const front = new FrontIndex(out.streets);
  const rib = pathRibbons(roads);
  for (const strip of strips) for (const q of (ctx.water.length ? pieces(differenceS([{ outer: strip, holes: [] }], ctx.water), 200) : [strip]).map(snapRing)) {
    const qi = out.quarters.length;
    out.quarters.push(q); out.outline.push(q);
    for (const b of carveBlocks(q, rib, [])) {
      const bi = out.blocks.length;
      out.blocks.push({ poly: b, kind: 'block', quarter: qi });
      fillDykeBlock(out, bi, b, front, hr.fork('b' + bi), false, false);
    }
  }
  // The original end may lie across a river. Keep it when usable, otherwise search real road ends for a dry
  // moated court with a dry causeway. The shrine is a reserved quarter, never placed over house lots or water.
  const original = P(x1 + 52, 0);
  const ends = roads.flatMap((road) => [road.path[0], road.path[road.path.length - 1]]);
  const nearest = ends.reduce((best, p) => Math.hypot(p.x - original.x, p.y - original.y) < Math.hypot(best.x - original.x, best.y - original.y) ? p : best);
  const candidates = [{ center: original, from: nearest }];
  for (const road of roads) for (const end of [0, road.path.length - 1]) {
    const from = road.path[end], near = road.path[end === 0 ? 1 : end - 1];
    const len = Math.hypot(from.x - near.x, from.y - near.y) || 1, dx = (from.x - near.x) / len, dy = (from.y - near.y) / len;
    for (const offset of [0, -70, 70]) candidates.push({ from, center: { x: from.x + dx * 48 - dy * offset, y: from.y + dy * 48 + dx * offset } });
  }
  for (const { center: pe, from } of candidates) {
    const tcx = pe.x, tcy = pe.y;
    const courtQuarter = snapRing(sq({ x: tcx, y: tcy }, 30));
    const reserve = sq(pe, 44), bb = bboxOf(reserve);
    const extent = Math.max(Math.abs(from.x - tcx), Math.abs(from.y - tcy));
    if (extent <= 30) continue;
    const stop = { x: tcx + (from.x - tcx) * 30 / extent, y: tcy + (from.y - tcy) * 30 / extent };
    const causeway: [Vec2, Vec2] = [from, stop], crossing = ribbon(causeway, [6, 6]);
    if (bb.x0 < 10 || bb.y0 < 10 || bb.x1 > ctx.mapSize - 10 || bb.y1 > ctx.mapSize - 10 || wetArea(reserve, ctx.water) > 0.01 || wetArea(crossing, ctx.water) > 0.01) continue;
    const occupied = [...out.quarters, ...(cc.avoid ?? [])];
    const occupiedHit = (p: Polygon, tolerance: number): boolean => occupied.some((q) => {
      const hit = tryIntersection(q, p);
      return hit.failed || mpArea(hit.pieces) > tolerance;
    });
    // Reserve the whole moat and its bank, not just the inner 60 m court.
    if (occupiedHit(reserve, 0.01) || occupiedHit(crossing, 0.05)) continue;
    const moatPaths = prasatMoatPaths(pe, causeway);
    if (!moatPaths.length || moatPaths.some((path) => {
      const hit = tryIntersection(ribbon(path, 10), crossing);
      return hit.failed || mpArea(hit.pieces) > 0.01;
    })) continue;
    // An oblique flat road cap can enter the court by a small triangle. Reserve that street piece exactly.
    const courtBlocks = carveBlocks(courtQuarter, pathRibbons([street(causeway, 6, 1, 'radial')]), []);
    const court = courtBlocks.find((b) => pointInRing(b, pe));
    if (!court || courtBlocks.length !== 1) continue;
    {
      const qi = out.quarters.length;
      out.quarters.push(courtQuarter); out.outline.push(sq({ x: tcx, y: tcy }, 44));
      const bi = out.blocks.length;
      out.blocks.push({ poly: court, kind: 'compound', compound: 'prasat', quarter: qi });
      const pi = out.parcels.length;
      out.parcels.push({ poly: court, use: 'compound:prasat', block: bi });
      const pr = sq({ x: tcx, y: tcy }, 7);
      out.buildings.push({ poly: pr, kind: 'landmark', parcel: pi, arch: 'prasat', roof: 'pyramidal', material: 'stone', storeys: 3 });
      out.lines.push({ kind: 'pyramid-step', path: ring(sq({ x: tcx, y: tcy }, 4.2)), width: 0.5 }, { kind: 'gallery', path: ring(sq({ x: tcx, y: tcy }, 20)), width: 1.2 });
      for (const path of moatPaths) out.lines.push({ kind: 'moat', path, width: 10 });
      out.landmarks.push({ kind: 'prasat', poly: pr });
      out.sites.push({ id: 'prasat', kind: 'prasat', role: 'worship', lot: court, anchor: { x: tcx, y: tcy } });
      out.streets.push(street(causeway, 6, 1, 'radial'));
      break;
    }
  }
  return out;
}
