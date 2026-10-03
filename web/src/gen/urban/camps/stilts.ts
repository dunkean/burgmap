/**
 * Stilt town (lake dwellings, marsh folk, lizardfolk; Ganvié, the Venetian casoni, the Sepik villages): houses on
 * piles over the shallow water and the marsh along the shore, boardwalks instead of streets — a main walk from
 * the shore out to the landing stage, cross walks off it — the council house on its broad platform, fish-drying
 * racks, the landing stages with their canoes.
 *
 * Water-allowed (Culture.waterBuild): shallow shores remain usable, while navigation channels and steep banks
 * constrain the quarter. The same exact partition applies: quarter → boardwalk ribbons → blocks → lots → houses.
 */
import type { Vec2, Polygon } from '../../core/geom';
import { dist } from '../../core/geom';
import type { Rng } from '../../core/rng';
import { orientPos, inscribed, area, distToSeg } from '../../geo/poly';
import type { CampCtx } from './index';
import { CampOut, emptyCamp, street, carveBlocks, pathRibbons, FrontIndex, fitIn, rect } from './kit';
import { Noise2D } from '../../core/noise';
import { shoreTerrain, stiltGround, rootedWalk, shoreBlockLots } from './stiltterrain';
import { ribbon } from '../../geo/offset';

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
  const habitat = shoreTerrain(ctx), w = habitat.anchor(c0);
  const ang = w ? w.angle : sr.range(0, Math.PI * 2);
  // Anchor at a gentle bank rather than pushing a population-sized oval into the river.
  const c = w ? w.center : { ...c0 };
  const ca = Math.cos(ang), sa = Math.sin(ang);
  // u: out over the water (along ang), v: along the shore
  const P = (u: number, v: number): Vec2 => ({ x: c.x + u * ca - v * sa, y: c.y + u * sa + v * ca });
  const nz = new Noise2D(sr.fork('noise'));
  const wob = (t: number) => 0.08 * nz.noise(Math.cos(t) * 1.4 + 5, Math.sin(t) * 1.4 + 5);
  const a = R * 0.95, b = R * 1.25;
  const quarters = stiltGround(habitat, c, a, b, ang, wob);
  if (!quarters.length) return out;
  // ---- boardwalks: the main walk from the shore out to the landing stage, cross walks along the shore every
  // 24–32 m, kinked at the main walk (the planks are laid in short straight runs)
  const mainPath = rootedWalk([P(-a * 1.12, 0), c, P(a * 1.25, 0)], c, 3.4, quarters, habitat.suitable);
  if (!mainPath) return out;
  out.quarters.push(...quarters);
  const main = street(mainPath, 3.4, 1, 'radial');
  const walks = [main];
  // A narrow bank may stop the water-facing trunk almost immediately. Serve
  // the usable shoreline from its root instead of leaving a long reed strip.
  for (const side of [-1, 1]) {
    const shoreWalk = rootedWalk([c, P(0, side * b * 1.3)], c, 2.2, quarters, habitat.suitable);
    if (shoreWalk) walks.push(street(shoreWalk, 2.2, 2, 'street'));
  }
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
        const root = pts[0];
        if (mainPath.slice(1).some((p, i) => distToSeg(root, mainPath[i], p) < 0.05)) {
          const path = rootedWalk(pts, root, 2.2, quarters, habitat.suitable);
          if (path) walks.push(street(path, 2.2, 2, 'street'));
        }
      }
    }
    u += sr.range(20, 34) * Math.sqrt(cc.sprawl);
  }
  // Reserve the landing before carving lots, so no house can occupy its planks.
  const tip = mainPath[mainPath.length - 1], before = mainPath[mainPath.length - 2];
  const tipLength = dist(before, tip);
  // A transverse dock needs room for its width beyond its root; the main tip
  // itself sits at the last suitable longitudinal sample.
  const e = tipLength > 2.5 ? { x: tip.x + (before.x - tip.x) * 2.5 / tipLength, y: tip.y + (before.y - tip.y) * 2.5 / tipLength } : c;
  const dock = rootedWalk([{ x: e.x + sa * 10, y: e.y - ca * 10 }, e, { x: e.x - sa * 10, y: e.y + ca * 10 }], e, 3, quarters, habitat.suitable);
  if (dock) walks.push(street(dock, 3, 2, 'quay'));
  out.streets.push(...walks);
  const rib = pathRibbons(walks);
  const front = new FrontIndex(walks);
  // ---- the terrain-adapted shore quarters are partitioned by their connected walks.
  const blocks = quarters.flatMap((q, quarter) => carveBlocks(q, rib, []).map((poly) => ({ poly, quarter })));
  const hr = rng.fork('houses');
  const councilCandidates: { parcel: number; d: number; centre: Vec2 }[] = [];
  blocks.forEach(({ poly: blk, quarter }) => {
    // Short plots along each boardwalk: clipped dead ends need not split a block
    // completely, so a full-width strip would otherwise contain dozens of homes.
    const cells: { poly: Polygon; tag: number }[] = [];
    let v0 = -b * 1.5, j = 0, row = 0;
    while (v0 < b * 1.5 && row++ < 200) {
      const v1 = v0 + hr.range(9, 13) * Math.sqrt(cc.sprawl);
      const length = hr.range(12, 18) * Math.sqrt(cc.sprawl);
      for (let u0 = -a * 1.5; u0 < a * 1.5; u0 += length) {
        const u1 = Math.min(a * 1.5, u0 + length);
        cells.push({ poly: orientPos([P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)]), tag: j++ });
      }
      v0 = v1;
    }
    for (const cleaned of shoreBlockLots(blk, cells, (p) => front.frontage(p).len)) {
      const bi = out.blocks.length;
      out.blocks.push({ poly: cleaned.poly, kind: 'block', quarter });
      for (const pc of cleaned.lots) {
        const pi = out.parcels.length;
        const fr = front.frontage(pc.poly);
        if (fr.len < 3.2 || area(pc.poly) < 45) { out.parcels.push({ poly: pc.poly, use: 'reed', block: bi }); continue; }
        out.parcels.push({ poly: pc.poly, use: 'plot', block: bi });
        const centre = inscribed(pc.poly, [], 0.5).c, d = dist(centre, c);
        if (area(pc.poly) >= 130 && area(pc.poly) <= 700) councilCandidates.push({ parcel: pi, d, centre });
        // the stilt house set against its walk, a drying rack or a granary on piles behind it now and then
        const wet = habitat.isWet(centre);
        const L = hr.range(6.5, 9), W = hr.range(4.8, 6.2);
        const cand = fr.mid ? [fr.mid] : undefined;
        const h = fitIn(pc.poly, (q, s) => rect(q, ang, L * s, W * s), [], { margin: 0.6, gap: 0, minScale: 0.6, cands: cand ? [...cand, centre] : undefined });
        if (h) out.buildings.push({ poly: h, kind: 'house', parcel: pi, arch: 'stilt-house', roof: 'thatch-round', storeys: 1, material: 'thatch', orientation: ang });
        if (hr.chance(wet ? 0.35 : 0.25)) {
          const r2 = fitIn(pc.poly, (q, s) => rect(q, ang + Math.PI / 2, 4 * s, 2.4 * s), h ? [h] : [], { margin: 0.6, gap: 1, minScale: 0.9 });
          if (r2) out.buildings.push({ poly: r2, kind: 'outbuilding', parcel: pi, arch: wet ? 'drying-rack' : 'granary-on-piles', roof: 'none', storeys: 1, material: 'wood' });
        }
      }
    }
  });
  // The council claims one served platform, never the entire connected shore block.
  if (pop >= 150) for (const candidate of councilCandidates.sort((a, b) => a.d - b.d || a.parcel - b.parcel)) {
    const councilParcel = candidate.parcel, platform = out.parcels[councilParcel];
    const ch = fitIn(platform.poly, (q, s) => rect(q, ang, 18 * s, 10 * s), [],
      { margin: 1, gap: 0, minScale: 0.5, cands: [candidate.centre] });
    if (ch) {
      platform.use = 'plaza';
      out.buildings = out.buildings.filter((bd) => bd.parcel !== councilParcel);
      out.buildings.push({ poly: ch, kind: 'landmark', parcel: councilParcel, arch: 'council-house', roof: 'gable', storeys: 1, material: 'wood' });
      out.landmarks.push({ kind: 'council-house', poly: ch });
      out.sites.push({ id: 'council', kind: 'council-platform', role: 'civic', lot: platform.poly, anchor: inscribed(ch, [], 0.5).c });
      break;
    }
  }
  // ---- the landing stage at the end of the main walk (a T of planks), the canoes along it
  if (dock) {
    out.lines.push({ kind: 'footbridge', path: dock, width: 3 });
    out.sites.push({ id: 'landing', kind: 'landing-stage', role: 'market', lot: ribbon(dock, 3), anchor: e });
  }
  out.outline.push(...quarters);
  return out;
}
