/**
 * Stilt town (lake dwellings, marsh folk, lizardfolk; Ganvié, the Venetian casoni, the Sepik villages): houses on
 * piles over the shallow water and the marsh along the shore, boardwalks instead of streets — a main walk from
 * the shore out to the landing stage, cross walks off it — the council house on its broad platform, fish-drying
 * racks, the landing stages with their canoes.
 *
 * Water-allowed (Culture.waterBuild): the quarter is NOT cut by the water; blocks and lots lie over it. Otherwise
 * the same exact partition as every camp: quarter → boardwalk ribbons → blocks → lot cells → footprints.
 */
import type { Vec2, Polygon } from '../../core/geom';
import { dist } from '../../core/geom';
import type { Rng } from '../../core/rng';
import { orientPos, inscribed, area } from '../../geo/poly';
import type { CampCtx } from './index';
import { CampOut, emptyCamp, street, ellipse, carveBlocks, pathRibbons, cutByCells, FrontIndex, fitIn, rect, snapRing } from './kit';
import { Noise2D } from '../../core/noise';

/** Direction and distance from p to the nearest open water within `R` (null when there is none). */
export function nearestWater(isWater: (p: Vec2) => boolean, p: Vec2, R: number): { a: number; d: number } | null {
  for (let r = 0; r <= R; r += 20) {
    let sx = 0, sy = 0, n = 0;
    const k = r === 0 ? 1 : 48;
    for (let i = 0; i < k; i++) {
      const a = (i / k) * Math.PI * 2;
      if (isWater({ x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r })) { sx += Math.cos(a); sy += Math.sin(a); n++; }
    }
    if (n) return { a: r === 0 ? 0 : Math.atan2(sy, sx), d: r };
  }
  return null;
}

export function stiltTown(cc: CampCtx, c0: Vec2, pop: number, rng: Rng): CampOut {
  const out = emptyCamp();
  const ctx = cc.ctx;
  const sr = rng.fork('shape');
  const R = Math.max(42, Math.sqrt((pop * 36 * Math.sqrt(cc.sprawl)) / Math.PI));
  // the shore: the settlement straddles it, two thirds of it over the water
  const w = nearestWater(ctx.isWater, c0, 700);
  const ang = w ? w.a : sr.range(0, Math.PI * 2);
  const c = w ? { x: c0.x + Math.cos(ang) * (w.d + R * 0.3), y: c0.y + Math.sin(ang) * (w.d + R * 0.3) } : c0;
  const S = ctx.mapSize;
  c.x = Math.max(R * 1.4 + 20, Math.min(S - R * 1.4 - 20, c.x));
  c.y = Math.max(R * 1.4 + 20, Math.min(S - R * 1.4 - 20, c.y));
  const ca = Math.cos(ang), sa = Math.sin(ang);
  // u: out over the water (along ang), v: along the shore
  const P = (u: number, v: number): Vec2 => ({ x: c.x + u * ca - v * sa, y: c.y + u * sa + v * ca });
  const nz = new Noise2D(sr.fork('noise'));
  const wob = (t: number) => 0.08 * nz.noise(Math.cos(t) * 1.4 + 5, Math.sin(t) * 1.4 + 5);
  const a = R * 0.95, b = R * 1.25;
  const quarter = snapRing(ellipse(c, a, b, ang, 96, wob));
  out.quarters.push(quarter);
  // ---- boardwalks: the main walk from the shore out to the landing stage, cross walks along the shore every
  // 24–32 m, kinked at the main walk (the planks are laid in short straight runs)
  const main = street([P(-a * 1.12, 0), P(a * 1.25, 0)], 3.4, 1, 'radial');
  const walks = [main];
  // (the half width of the oval at u, a little beyond its wobbly edge so the walks cut it through)
  const vmax = (u: number) => b * Math.sqrt(Math.max(0, 1 - (u / a) * (u / a))) * 1.12 + 2;
  let u = -a + sr.range(14, 24);
  while (u < a - 12) {
    const vm = vmax(u);
    if (vm > 18) {
      // planks laid in short straight runs: a kink every 12–20 m, now and then a walk stops short (a dead end)
      for (const side of [-1, 1]) {
        const end = sr.chance(0.25) ? vm * sr.range(0.45, 0.8) : vm;
        const pts: Vec2[] = [P(u, 0)];
        let v = 0, uu = u;
        while (v < end - 1) {
          v = Math.min(end, v + sr.range(12, 20));
          uu += sr.range(-3.5, 3.5);
          pts.push(P(uu, side * v));
        }
        walks.push(street(pts, 2.2, 2, 'street'));
      }
    }
    u += sr.range(20, 34) * Math.sqrt(cc.sprawl);
  }
  out.streets.push(...walks);
  const rib = pathRibbons(walks);
  const front = new FrontIndex(walks);
  // ---- blocks over land and water alike (water allowed), lots as strips along the walks
  const blocks = carveBlocks(quarter, rib, []);
  const hr = rng.fork('houses');
  let bigBlock = -1, bigA = 0;
  blocks.forEach((blk) => {
    const bi = out.blocks.length;
    out.blocks.push({ poly: blk, kind: 'block', quarter: 0 });
    const A = area(blk);
    const ic = inscribed(blk, [], 0.5).c;
    const dc = dist(ic, c);
    if (A > 600 && dc < R * 0.6 && A > bigA) { bigA = A; bigBlock = bi; }
    // strips across the block (along u), 9–13 m wide in v, so every lot has its frontage on a cross walk
    const cells: { poly: Polygon; tag: number }[] = [];
    let v0 = -b * 1.5, j = 0;
    while (v0 < b * 1.5 && j < 200) {
      const v1 = v0 + hr.range(9, 13) * Math.sqrt(cc.sprawl);
      cells.push({ poly: orientPos([P(-a * 1.5, v0), P(a * 1.5, v0), P(a * 1.5, v1), P(-a * 1.5, v1)]), tag: j++ });
      v0 = v1;
    }
    for (const pc of cutByCells(blk, cells)) {
      const pi = out.parcels.length;
      const fr = front.frontage(pc.poly);
      if (fr.len < 3.2 || area(pc.poly) < 45) { out.parcels.push({ poly: pc.poly, use: 'reed', block: bi }); continue; }
      out.parcels.push({ poly: pc.poly, use: 'plot', block: bi });
      // the stilt house set against its walk, a drying rack or a granary on piles behind it now and then
      const wet = ctx.isWater(inscribed(pc.poly, [], 0.5).c);
      const L = hr.range(6.5, 9), W = hr.range(4.8, 6.2);
      const cand = fr.mid ? [fr.mid] : undefined;
      const h = fitIn(pc.poly, (q, s) => rect(q, ang, L * s, W * s), [], { margin: 0.6, gap: 0, minScale: 0.6, cands: cand ? [...cand, inscribed(pc.poly, [], 0.5).c] : undefined });
      if (h) out.buildings.push({ poly: h, kind: 'house', parcel: pi, arch: 'stilt-house', roof: 'thatch-round', storeys: 1, material: 'thatch', orientation: ang });
      if (hr.chance(wet ? 0.35 : 0.25)) {
        const r2 = fitIn(pc.poly, (q, s) => rect(q, ang + Math.PI / 2, 4 * s, 2.4 * s), h ? [h] : [], { margin: 0.6, gap: 1, minScale: 0.8 });
        if (r2) out.buildings.push({ poly: r2, kind: 'outbuilding', parcel: pi, arch: wet ? 'drying-rack' : 'granary-on-piles', roof: 'none', storeys: 1, material: 'wood' });
      }
    }
  });
  // ---- the council house on its broad platform near the middle (the whole block is its platform)
  if (bigBlock >= 0 && pop >= 150) {
    const blk = out.blocks[bigBlock];
    blk.kind = 'compound'; blk.compound = 'council-platform';
    const keep = out.parcels.filter((p) => p.block !== bigBlock);
    const dropped = out.parcels.length - keep.length;
    if (dropped) {
      // (re-index: the platform replaces the lots of that block)
      const map = new Map<number, number>();
      let k = 0;
      out.parcels.forEach((p, i) => { if (p.block !== bigBlock) map.set(i, k++); });
      out.buildings = out.buildings.filter((bd) => map.has(bd.parcel)).map((bd) => ({ ...bd, parcel: map.get(bd.parcel)! }));
      out.parcels = keep;
    }
    const pi = out.parcels.length;
    out.parcels.push({ poly: blk.poly, use: 'plaza', block: bigBlock });
    const ch = fitIn(blk.poly, (q, s) => rect(q, ang, 18 * s, 10 * s), [], { margin: 2, gap: 0, minScale: 0.5, cands: [inscribed(blk.poly, [], 0.5).c] });
    if (ch) { out.buildings.push({ poly: ch, kind: 'landmark', parcel: pi, arch: 'council-house', roof: 'gable', storeys: 1, material: 'wood' }); out.landmarks.push({ kind: 'council-house', poly: ch }); }
  }
  // ---- the landing stage at the end of the main walk (a T of planks), the canoes along it
  const e = P(a * 1.25, 0);
  out.lines.push({ kind: 'footbridge', path: [P(a * 1.25, -10), P(a * 1.25, 10)], width: 3 });
  out.outline.push(quarter);
  out.sites.push({ id: 'landing', kind: 'landing-stage', role: 'market', lot: rect(e, ang, 6, 20), anchor: e });
  return out;
}
