/**
 * Norse ring fortress (Trelleborg, Fyrkat, Aggersborg): a perfect circle of earth rampart with a ditch, four gates
 * on the cardinal points joined by two timber-paved axial streets, a ring street inside the rampart, and the
 * interior laid out as squares: in each square four bow-sided longhouses close a courtyard.
 *
 * Partition: quarter = the disc inside the rampart; cuts = the ring street (annulus) and the lattice streets (the
 * two axes and, in larger forts, the lines between the squares); each square cell of the lattice is a block holding
 * one courtyard plot; the leftover pieces along the ring are greens.
 */
import type { Vec2, Polygon } from '../../core/geom';
import { dist } from '../../core/geom';
import type { Rng } from '../../core/rng';
import { orientPos, pointInRing, inscribed, area } from '../../geo/poly';
import { MultiPoly, unionMany } from '../../geo/bool';
import type { CampCtx } from './index';
import { snapRing } from './kit';
import { CampOut, emptyCamp, street, circlePts, annulus, carveBlocks, pathRibbons, FrontIndex, bowSided, rect, fits, openRing, hachures } from './kit';

export function ringFort(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  const out = emptyCamp();
  const ctx = cc.ctx;
  const sf = Math.log2(cc.sprawl);
  const houses = Math.max(4, Math.min(48, Math.round(pop / 22)));
  const nSq = Math.ceil(houses / 4);
  const L = rng.range(26, 30) * (1 + 0.1 * sf), W = rng.range(6.5, 7.5);
  const S = L + 2 * W + 3; // the square: four houses round a courtyard, gables almost meeting at the corners
  const sw = 4.2; // street width
  const P = S + sw; // lattice pitch
  // cells of the cardinal lattice (axes through the centre) that lie inside a circle of radius R
  const cellsIn = (R: number): Vec2[] => {
    const out2: Vec2[] = [];
    const k = Math.ceil(R / P) + 1;
    for (let i = -k; i < k; i++) for (let j = -k; j < k; j++) {
      const cx = c.x + (i + 0.5) * P, cy = c.y + (j + 0.5) * P;
      const far = Math.hypot(Math.abs(cx - c.x) + S / 2, Math.abs(cy - c.y) + S / 2);
      if (far <= R) out2.push({ x: cx, y: cy });
    }
    return out2;
  };
  let Rin = P * Math.SQRT2 + 4;
  while (cellsIn(Rin - sw - 2).length < nSq && Rin < 400) Rin += 3;
  const cells = cellsIn(Rin - sw - 2).sort((a, b) => dist(a, c) - dist(b, c)).slice(0, Math.max(4, nSq + (nSq % 4 ? 4 - (nSq % 4) : 0)));
  const nr = Math.max(64, Math.round((2 * Math.PI * Rin) / 3));
  const quarter = snapRing(circlePts(c, Rin, nr));
  out.quarters.push(quarter);
  // ---- streets: ring street inside the rampart, the two axes gate to gate, the lattice lines between squares
  const ringR = Rin - sw / 2;
  const ringPl = circlePts(c, ringR, nr);
  out.streets.push(street(ringPl.concat([ringPl[0]]), sw, 3, 'ring'));
  const axes = [street([{ x: c.x - Rin - 6, y: c.y }, { x: c.x + Rin + 6, y: c.y }], sw + 1, 1, 'radial'), street([{ x: c.x, y: c.y - Rin - 6 }, { x: c.x, y: c.y + Rin + 6 }], sw + 1, 1, 'radial')];
  out.streets.push(...axes);
  const k = Math.ceil(Rin / P);
  const lattice: ReturnType<typeof street>[] = [];
  for (let i = -k; i <= k; i++) {
    if (i === 0) continue;
    const off = i * P;
    if (Math.abs(off) >= ringR - 2) continue;
    // only the lines that bound a kept square
    if (!cells.some((q) => Math.abs(Math.abs(q.x - c.x - off) - P / 2) < 1)) continue;
    const h = Math.sqrt(ringR * ringR - off * off);
    lattice.push(street([{ x: c.x + off, y: c.y - h }, { x: c.x + off, y: c.y + h }], sw, 3, 'lane'));
  }
  for (let j = -k; j <= k; j++) {
    if (j === 0) continue;
    const off = j * P;
    if (Math.abs(off) >= ringR - 2) continue;
    if (!cells.some((q) => Math.abs(Math.abs(q.y - c.y - off) - P / 2) < 1)) continue;
    const h = Math.sqrt(ringR * ringR - off * off);
    lattice.push(street([{ x: c.x - h, y: c.y + off }, { x: c.x + h, y: c.y + off }], sw, 3, 'lane'));
  }
  out.streets.push(...lattice);
  const cuts: MultiPoly = unionMany([[annulus(c, Rin - sw, Rin, nr)], ...pathRibbons([...axes, ...lattice]).map((ph) => [ph] as MultiPoly)], 16, true);
  const blocks = carveBlocks(quarter, cuts, ctx.water);
  const front = new FrontIndex(out.streets);
  const hr = rng.fork('houses');
  let placedHouses = 0;
  for (const b of blocks) {
    const bi = out.blocks.length;
    const ic = inscribed(b, [], 0.5).c;
    const cell = cells.find((q) => Math.abs(q.x - ic.x) < S / 2 + 1 && Math.abs(q.y - ic.y) < S / 2 + 1 && pointInRing(b, q));
    out.blocks.push({ poly: b, kind: cell ? 'block' : 'green', quarter: 0 });
    if (!cell || front.frontage(b).len < 3.2) { out.parcels.push({ poly: b, use: cell ? 'garden' : 'green', block: bi }); continue; }
    const pi = out.parcels.length;
    out.parcels.push({ poly: b, use: 'plot', block: bi });
    // the four longhouses closing the courtyard (corners open), gables to the corners
    const off = S / 2 - W / 2 - 0.6;
    const Lh = S - 2 * W - 2;
    const sides: [number, number, number][] = [[0, -off, 0], [0, off, 0], [-off, 0, Math.PI / 2], [off, 0, Math.PI / 2]];
    const placed: Polygon[] = [];
    // (houses are spread over all the squares first: a small garrison leaves sides of the squares empty)
    const perSq = Math.max(1, Math.min(4, Math.round(houses / cells.length + 0.49)));
    let inSq = 0;
    for (const [dx, dy, ang] of sides) {
      if (placedHouses >= houses || inSq >= perSq) break;
      const h = bowSided({ x: cell.x + dx, y: cell.y + dy }, ang, Lh, W, 0.22);
      if (fits(b, h, placed, 0.4, 0.5)) { placed.push(h); placedHouses++; inSq++; out.buildings.push({ poly: h, kind: 'house', parcel: pi, arch: 'longhouse', roof: 'gable', storeys: 1, material: 'timber', orientation: ang }); }
    }
    // a small house in the courtyard of some squares
    if (hr.chance(0.35)) {
      const sm = rect(cell, hr.chance(0.5) ? 0 : Math.PI / 2, 8, 5);
      if (fits(b, sm, placed, 0.5, 2)) out.buildings.push({ poly: sm, kind: 'outbuilding', parcel: pi, arch: 'court-house', roof: 'gable', storeys: 1, material: 'timber' });
    }
  }
  // ---- the rampart (a broad earth bank, timber-faced), the ditch outside, the four gates
  const gates = [0, Math.PI / 2, Math.PI, -Math.PI / 2].map((a) => ({ a, w: sw + 2 }));
  const bankR = Rin + 7;
  const bank = orientPos(circlePts(c, bankR, nr));
  const gp = (r: number) => gates.map((g) => ({ p: { x: c.x + Math.cos(g.a) * r, y: c.y + Math.sin(g.a) * r }, width: g.w + 2 }));
  for (const pl of openRing(bank, gp(bankR))) out.lines.push({ kind: 'rampart', path: pl, width: 13 });
  for (const pl of openRing(orientPos(circlePts(c, Rin + 0.8, nr)), gp(Rin + 0.8))) out.lines.push({ kind: 'palisade', path: pl, width: 1.2 });
  const ditchR = Rin + 20;
  for (const pl of openRing(orientPos(circlePts(c, ditchR, nr)), gp(ditchR))) out.lines.push({ kind: 'ditch', path: pl, width: 6 });
  out.lines.push(...hachures(orientPos(circlePts(c, Rin + 13.5, nr)), 2.6, 2.4, -1, (p) => gates.some((g) => dist(p, { x: c.x + Math.cos(g.a) * (Rin + 13.5), y: c.y + Math.sin(g.a) * (Rin + 13.5) }) < sw + 6)));
  out.outline.push(orientPos(circlePts(c, ditchR + 5, nr)));
  out.sites.push({ id: 'ringfort', kind: 'ring-fortress', role: 'power', lot: quarter, anchor: c, tags: { longhouses: String(placedHouses) } });
  void area;
  return out;
}
