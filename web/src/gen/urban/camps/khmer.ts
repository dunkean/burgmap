/**
 * Khmer city (Angkor Thom, with Angkor Wat and the barays): a square enclosure on the cardinal axes, laterite wall
 * and wide moat, five gates; avenues from the gates to the temple-mountain at the centre (the Bayon: stepped
 * terraces, concentric galleries, the central tower), the royal palace enclosure north of it with the parade
 * ground before its terrace; inside, a cardinal grid of earthen dykes with houses on stilts and a pond (srah) in
 * every lot; outside, the baray (a huge rectangular reservoir with its island temple, the mebon) and rice fields.
 * A village is a small moated temple with its stilt houses along the dykes.
 *
 * Partition: quarter = the square inside the wall; cuts = the avenues, the ring lane inside the wall, the dyke
 * lanes and the street round the temple; the centre and palace blocks are compounds; every other block is cut into
 * two rows of lots back to back (exact rectangles), one stilt house and its pond per lot.
 */
import type { Vec2, Polygon } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { UrbanStreet } from '../../types';
import { orientPos, pointInRing, inscribed, area, bboxOf } from '../../geo/poly';
import { intersectionS, differenceS } from '../../geo/bool';
import type { CampCtx } from './index';
import { snapRing, CampOut, emptyCamp, street, carveBlocks, pathRibbons, cutByCells, FrontIndex, rect, fits, openRing, pieces } from './kit';
import { pyramid } from '../aztec';
import type { CompoundOut } from '../compounds';
import { wallFeatures } from '../walls';

const sq = (c: Vec2, h: number): Polygon => orientPos([{ x: c.x - h, y: c.y - h }, { x: c.x + h, y: c.y - h }, { x: c.x + h, y: c.y + h }, { x: c.x - h, y: c.y + h }]);
const box = (x0: number, y0: number, x1: number, y1: number): Polygon => orientPos([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]);

export function khmerCity(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  const out = emptyCamp();
  const ctx = cc.ctx;
  const city = pop >= 1200;
  const dens = (city ? 62 : 40) / cc.sprawl;
  const H = Math.max(70, Math.sqrt((pop / dens) * 1e4) / 2); // half side
  // (the streams crossing the city stay open water: the quarter is the square less the water)
  const quarters = (ctx.water.length ? pieces(differenceS([{ outer: sq(c, H), holes: [] }], ctx.water), 400) : [sq(c, H)]).map(snapRing);
  out.quarters.push(...quarters);
  const avW = city ? 9 : 6, laneW = 4;
  const T = Math.max(26, Math.min(H * 0.2, 150)); // half side of the temple block
  const P = city ? 96 * Math.sqrt(cc.sprawl) : 72;
  // ---- streets: four avenues gate → temple, the street round the temple, the ring lane, the dyke lattice
  const streets: UrbanStreet[] = [];
  const ext = 8;
  const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dy] of dirs) streets.push(street([{ x: c.x + dx * (H + ext), y: c.y + dy * (H + ext) }, { x: c.x + dx * (T + avW / 2 + 1), y: c.y + dy * (T + avW / 2 + 1) }], avW, 1, 'radial'));
  const tr = T + avW / 2 + 1;
  const trPts = sq(c, tr);
  streets.push(street([...trPts, trPts[0]], avW, 1, 'ring'));
  const ringH = H - laneW / 2;
  const ringPts = sq(c, ringH);
  if (city) streets.push(street([...ringPts, ringPts[0]], laneW, 3, 'ring'));
  // the dyke lattice (from the centre outward on each side; it stops at the temple street)
  const lines: number[] = [];
  for (let k = 1; k * P < H - P * 0.45; k++) lines.push(k * P);
  for (const off of lines) for (const sgn of [-1, 1]) {
    const o = sgn * off;
    const tOk = Math.abs(o) > tr + 4;
    if (tOk) {
      streets.push(street([{ x: c.x + o, y: c.y - ringH }, { x: c.x + o, y: c.y + ringH }], laneW, 3, 'lane'));
      streets.push(street([{ x: c.x - ringH, y: c.y + o }, { x: c.x + ringH, y: c.y + o }], laneW, 3, 'lane'));
    } else {
      for (const [a, b] of [[-ringH, -tr], [tr, ringH]]) {
        streets.push(street([{ x: c.x + o, y: c.y + a }, { x: c.x + o, y: c.y + b }], laneW, 3, 'lane'));
        streets.push(street([{ x: c.x + a, y: c.y + o }, { x: c.x + b, y: c.y + o }], laneW, 3, 'lane'));
      }
    }
  }
  out.streets.push(...streets);
  const rib = pathRibbons(streets);
  const blocks: { b: Polygon; q: number }[] = quarters.flatMap((Q, qi) => carveBlocks(Q, rib, []).map((b) => ({ b, q: qi })));
  const front = new FrontIndex(out.streets);
  const hr = rng.fork('houses');
  // the palace: the block north-west of the temple (the lattice cell that touches the temple street on the north)
  let palaceBi = -1;
  blocks.forEach(({ b }, i) => {
    const ic = inscribed(b, [], 1).c;
    if (city && palaceBi < 0 && ic.y < c.y - tr && ic.x < c.x && ic.x > c.x - P * 1.6 && ic.y > c.y - tr - P * 1.6) palaceBi = i;
  });
  blocks.forEach(({ b, q: qi }, i) => {
    const bi = out.blocks.length;
    if (pointInRing(b, c)) {
      // ---- the temple-mountain: moat, enclosure, stepped pyramid with galleries and the central tower
      out.blocks.push({ poly: b, kind: 'compound', compound: 'temple-mountain', quarter: qi });
      out.parcels.push({ poly: b, use: 'compound:temple-mountain', block: bi });
      const tmp: CompoundOut = { parcels: [{ poly: b, use: 'compound:temple-mountain' }], buildings: [], lines: [], water: [], landmarks: [] };
      const ins = inscribed(b, [], 1);
      const h = Math.max(10, Math.min(60, ins.r * 0.62));
      const Py = pyramid(tmp, b, c, 0, h, 'temple-mountain', 0, false);
      if (Py) out.landmarks.push({ kind: 'temple-mountain', poly: Py });
      // the galleries: concentric square enclosures round the pyramid, open on the four axes
      for (const gk of [1.2, 1.45]) {
        const g = sq(c, Math.min(ins.r - 2.5, h * gk));
        if (g.every((q) => pointInRing(b, q))) for (const pl of openRing(g, dirs.map(([dx, dy]) => ({ p: { x: c.x + dx * h * gk, y: c.y + dy * h * gk }, width: 6 })))) tmp.lines.push({ kind: 'gallery', path: pl, width: 2.2 });
      }
      for (const bd of tmp.buildings) out.buildings.push({ ...bd, parcel: out.parcels.length - 1 });
      out.lines.push(...tmp.lines);
      out.sites.push({ id: 'temple-mountain', kind: 'temple-mountain', role: 'worship', lot: b, anchor: c });
      return;
    }
    if (i === palaceBi) {
      // ---- the royal palace: walled, a small temple-pyramid (Phimeanakas), pools; its terrace facing east
      out.blocks.push({ poly: b, kind: 'compound', compound: 'royal-palace', quarter: qi });
      out.parcels.push({ poly: b, use: 'compound:royal-palace', block: bi });
      const pi = out.parcels.length - 1;
      const tmp: CompoundOut = { parcels: [{ poly: b, use: 'compound:royal-palace' }], buildings: [], lines: [], water: [], landmarks: [] };
      const ins = inscribed(b, [], 1);
      pyramid(tmp, b, { x: ins.c.x - ins.r * 0.2, y: ins.c.y }, 0, Math.min(14, ins.r * 0.35), 'phimeanakas', 0, false);
      const bb = bboxOf(b);
      const terr = box(bb.x1 - 9, ins.c.y - ins.r * 0.7, bb.x1 - 2, ins.c.y + ins.r * 0.7);
      if (fits(b, terr, tmp.buildings.map((x) => x.poly), 0.5, 1)) tmp.buildings.push({ poly: terr, kind: 'landmark', parcel: 0, arch: 'royal-terrace', roof: 'none', material: 'stone', storeys: 1 });
      for (const bd of tmp.buildings) out.buildings.push({ ...bd, parcel: pi });
      out.lines.push(...tmp.lines, { kind: 'stone-wall', path: b.concat([b[0]]), width: 1.4 });
      const pool = box(ins.c.x - ins.r * 0.75, ins.c.y + ins.r * 0.3, ins.c.x - ins.r * 0.2, ins.c.y + ins.r * 0.6);
      if (pool.every((q) => pointInRing(b, q))) out.landmarks.push({ kind: 'pond', poly: pool });
      out.sites.push({ id: 'royal-palace', kind: 'royal-palace', role: 'power', lot: b, anchor: ins.c });
      return;
    }
    out.blocks.push({ poly: b, kind: 'block', quarter: qi });
    // ---- two rows of lots back to back, along the block's long axis
    const bb = bboxOf(b);
    const wide = bb.x1 - bb.x0 >= bb.y1 - bb.y0;
    const cells: { poly: Polygon; tag: number }[] = [];
    const len = wide ? bb.x1 - bb.x0 : bb.y1 - bb.y0;
    const n = Math.max(1, Math.round(len / hr.range(24, 34)));
    for (let k = 0; k < n; k++) for (const half of [0, 1]) {
      const a0 = (wide ? bb.x0 : bb.y0) + (len * k) / n - (k === 0 ? 1 : 0), a1 = (wide ? bb.x0 : bb.y0) + (len * (k + 1)) / n + (k === n - 1 ? 1 : 0);
      const m = wide ? (bb.y0 + bb.y1) / 2 : (bb.x0 + bb.x1) / 2;
      const lo = half ? m : (wide ? bb.y0 : bb.x0) - 1, hi = half ? (wide ? bb.y1 : bb.x1) + 1 : m;
      cells.push({ poly: wide ? box(a0, lo, a1, hi) : box(lo, a0, hi, a1), tag: k * 2 + half });
    }
    for (const pc of cutByCells(b, cells)) {
      const pi = out.parcels.length;
      const fr = front.frontage(pc.poly);
      if (fr.len < 3.2 || area(pc.poly) < 120) { out.parcels.push({ poly: pc.poly, use: 'garden', block: bi }); continue; }
      out.parcels.push({ poly: pc.poly, use: 'plot', block: bi });
      // the stilt house near the dyke, its granary, the pond behind
      const lot = pc.poly;
      const li = inscribed(lot, [], 0.5);
      const toward = fr.mid ? { x: fr.mid.x - li.c.x, y: fr.mid.y - li.c.y } : { x: 0, y: 1 };
      const tl = Math.hypot(toward.x, toward.y) || 1;
      const u = { x: toward.x / tl, y: toward.y / tl };
      const ang = Math.abs(u.x) > Math.abs(u.y) ? Math.PI / 2 : 0;
      const placed: Polygon[] = [];
      const hc = { x: li.c.x + u.x * li.r * 0.45, y: li.c.y + u.y * li.r * 0.45 };
      const house = rect(hc, ang, hr.range(9, 13), hr.range(5.5, 7));
      if (fits(lot, house, placed, 1, 0)) { placed.push(house); out.buildings.push({ poly: house, kind: 'house', parcel: pi, arch: 'stilt-house', roof: 'gable', storeys: 1, material: 'wood', orientation: ang }); }
      const gr = rect({ x: hc.x + (ang ? 0 : 9), y: hc.y + (ang ? 9 : 0) }, 0, 3, 3);
      if (hr.chance(0.5) && fits(lot, gr, placed, 1, 1.5)) { placed.push(gr); out.buildings.push({ poly: gr, kind: 'outbuilding', parcel: pi, arch: 'granary-on-posts', roof: 'gable', storeys: 1, material: 'wood' }); }
      const pd = rect({ x: li.c.x - u.x * li.r * 0.45, y: li.c.y - u.y * li.r * 0.45 }, ang, hr.range(7, 11), hr.range(5, 8));
      if (pd.every((q) => pointInRing(lot, q)) && !placed.some((p) => p.some((q) => pointInRing(pd, q)) || pd.some((q) => pointInRing(p, q)))) out.landmarks.push({ kind: 'pond', poly: pd });
    }
  });
  // ---- wall, moat, gates (the avenues cross the moat on causeways)
  const gates = dirs.map(([dx, dy]) => ({ p: { x: c.x + dx * H, y: c.y + dy * H }, dir: { x: -dx, y: -dy }, width: avW + 1 }));
  if (city) {
    const wall = sq(c, H);
    const wf = wallFeatures(wall, gates, rng.fork('wall'), ctx.isWater, () => false, 1e9);
    out.walls.push({ path: wall, closed: true, towers: [], gates: gates.map((g) => g.p), thickness: 3, gateInfo: gates, pieces: wf.pieces, gateTowers: wf.gateTowers, towerScale: [], curtains: [], towerShape: 'square', role: 'town' });
  }
  const mr = H + (city ? 30 : 14);
  for (const pl of openRing(sq(c, mr), dirs.map(([dx, dy]) => ({ p: { x: c.x + dx * mr, y: c.y + dy * mr }, width: avW + 2 })))) out.lines.push({ kind: 'moat', path: pl, width: city ? 40 : 14 });
  out.outline.push(sq(c, mr + (city ? 22 : 8)));
  // ---- the baray: a great reservoir beside the city (east first, then west, north, south), clear of the roads and
  // the water, inside the map; its island temple (mebon) in the middle
  if (city && cc.main) {
    const L0 = Math.min(H * 2.6, 2600);
    const roadHit = (P: Polygon): boolean => cc.roads.some((pl) => pl.some((q, i) => {
      if (pointInRing(P, q)) return true;
      if (i === 0) return false;
      const a2 = pl[i - 1];
      for (let t = 0.25; t < 1; t += 0.25) if (pointInRing(P, { x: a2.x + (q.x - a2.x) * t, y: a2.y + (q.y - a2.y) * t })) return true;
      return false;
    }));
    const wet = (P: Polygon): boolean => { const bb = bboxOf(P); for (let x = bb.x0; x <= bb.x1; x += 40) for (let y = bb.y0; y <= bb.y1; y += 40) if (ctx.isWater({ x, y })) return true; return false; };
    const cands: Polygon[] = [];
    for (const k2 of [1, 0.75, 0.55]) for (const off of [0, -0.45, 0.45]) {
      const L = L0 * k2, W = Math.min(L * 0.28, 700);
      cands.push(box(c.x + mr + 60, c.y - W / 2 + off * H, c.x + mr + 60 + L, c.y + W / 2 + off * H));
      cands.push(box(c.x - mr - 60 - L, c.y - W / 2 + off * H, c.x - mr - 60, c.y + W / 2 + off * H));
      cands.push(box(c.x - L / 2 + off * H, c.y - mr - 60 - W, c.x + L / 2 + off * H, c.y - mr - 60));
      cands.push(box(c.x - L / 2 + off * H, c.y + mr + 60, c.x + L / 2 + off * H, c.y + mr + 60 + W));
    }
    let made = 0;
    for (const B of cands) {
      if (made >= (pop > 9000 ? 2 : 1)) break;
      const bb = bboxOf(B);
      if (bb.x0 < 15 || bb.y0 < 15 || bb.x1 > ctx.mapSize - 15 || bb.y1 > ctx.mapSize - 15) continue;
      if (roadHit(B) || wet(B) || out.landmarks.some((l) => l.kind === 'baray' && intersectionS(l.poly, B).length)) continue;
      out.landmarks.push({ kind: 'baray', poly: B });
      out.outline.push(B);
      const bc = { x: (bb.x0 + bb.x1) / 2, y: (bb.y0 + bb.y1) / 2 };
      out.landmarks.push({ kind: "mebon", poly: sq(bc, Math.min(40, Math.min(bb.x1 - bb.x0, bb.y1 - bb.y0) * 0.12)) });
      out.sites.push({ id: 'baray:' + made, kind: 'baray', role: 'civic', lot: B, anchor: bc });
      made++;
    }
  }
  return out;
}
