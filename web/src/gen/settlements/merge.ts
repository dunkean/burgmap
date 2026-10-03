/**
 * Renderer view of a settlement system: the urban layers of all settlements concatenated into one (indices of
 * parcels and blocks offset), so the SVG and canvas renderers draw every town and village with the same code.
 * The main settlement's scalar fields (archetype, population, culture, phases) are kept.
 */
import type { World, UrbanLayer, Settlement, UrbanBlockInfo, UrbanParcel, Polygon } from '../types';
import { standIn } from '../urban/mega/standin';

export function mergeUrban(layers: UrbanLayer[]): UrbanLayer | undefined {
  if (!layers.length) return undefined;
  if (layers.length === 1) return layers[0];
  const m: UrbanLayer = {
    ...layers[0],
    footprint: [], streets: [], blocks: [], parcels: [], buildings: [], walls: [], landmarks: [], squares: [],
    quarters: [], blockInfo: [], masses: [], backLand: [], footprintH: [], lines: [], trees: [], water: [], sites: [], quays: [],
  };
  for (const u of layers) {
    const b0 = m.blocks.length, p0 = m.parcels.length, q0 = m.quarters.length;
    m.footprint.push(...u.footprint);
    m.footprintH.push(...u.footprintH);
    m.streets.push(...u.streets);
    m.blocks.push(...u.blocks);
    m.blockInfo.push(...u.blockInfo.map((bi) => (q0 ? { ...bi, quarter: bi.quarter + q0 } : bi)));
    m.parcels.push(...u.parcels.map((p) => (b0 && p.block >= 0 ? { ...p, block: p.block + b0 } : p)));
    m.buildings.push(...u.buildings.map((b) => (p0 && b.parcel !== undefined && b.parcel >= 0 ? { ...b, parcel: b.parcel + p0 } : b)));
    m.walls!.push(...(u.walls ?? []));
    m.landmarks.push(...u.landmarks);
    m.squares.push(...u.squares);
    m.quarters.push(...u.quarters);
    m.masses.push(...u.masses);
    m.backLand.push(...u.backLand);
    m.lines!.push(...(u.lines ?? []));
    m.trees!.push(...(u.trees ?? []));
    m.water!.push(...(u.water ?? []));
    m.sites!.push(...(u.sites ?? []));
    m.quays!.push(...(u.quays ?? []));
  }
  return m;
}

/**
 * Stand-in plan of a settlement whose detail is not generated yet: a small cluster of houses along one to three
 * lanes from its center, in the building colour (a cartographic "village" sign, never a blank disk). Deterministic
 * from the settlement key; houses falling on water (`water`: the terrain's water grid) are dropped.
 */
export function placeholderUrban(s: Settlement, water?: { data: Uint8Array; n: number; cell: number }): UrbanLayer {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.key.length; i++) h = Math.imul(h ^ s.key.charCodeAt(i), 16777619) >>> 0;
  const rnd = (): number => { h = (Math.imul(h ^ (h >>> 15), 2246822519) + 0x6d2b79f5) >>> 0; return h / 4294967296; };
  const dry = (x: number, y: number): boolean => {
    if (!water) return true;
    const { data, n, cell } = water;
    const ix = Math.floor(x / cell), iy = Math.floor(y / cell);
    return ix >= 0 && iy >= 0 && ix < n && iy < n && data[iy * n + ix] === 0;
  };
  const houses = Math.max(3, Math.min(48, Math.round(s.population / 7)));
  const lanes = houses < 8 ? 1 : houses < 20 ? 2 : 3;
  const a0 = rnd() * Math.PI * 2;
  const reach = Math.max(25, Math.min(0.75 * s.radius, (9 * houses) / lanes + 20));
  const buildings: UrbanLayer['buildings'] = [];
  for (let l = 0; l < lanes; l++) {
    const a = a0 + (l * 2 * Math.PI) / lanes + (rnd() - 0.5) * 0.7;
    const ux = Math.cos(a), uy = Math.sin(a);
    // a lane through the center (both ways for the first one), houses on both sides, gable to the lane
    for (let t = l === 0 ? -reach * 0.6 : 12; t <= reach; t += 13 + rnd() * 6) {
      for (const side of [-1, 1]) {
        if (buildings.length >= houses || rnd() < 0.2) continue;
        const off = side * (8 + rnd() * 3);
        const cx = s.center.x + ux * t - uy * off, cy = s.center.y + uy * t + ux * off;
        if (!dry(cx, cy)) continue;
        const L = 8 + rnd() * 5, W = 5 + rnd() * 2, ang = a + (rnd() - 0.5) * 0.15;
        const cu = Math.cos(ang), su = Math.sin(ang);
        const poly = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => ({ x: cx + (cu * i * L) / 2 - (su * j * W) / 2, y: cy + (su * i * L) / 2 + (cu * j * W) / 2 }));
        buildings.push({ poly, kind: 'house', orientation: ang });
      }
    }
  }
  return {
    footprint: [], footprintH: [], streets: [], blocks: [], parcels: [], buildings, walls: [],
    landmarks: [], squares: [], archetype: 'town', population: s.population, morphology: 'placeholder', phases: [], quarters: [],
    blockInfo: [], masses: buildings.map((b) => ({ outer: b.poly, holes: [] })), backLand: [],
  };
}

/**
 * Megacity (URBAN_MORPHOLOGY §3d): the macro layer with a stand-in block for every quarter whose detail is not
 * generated yet, followed by the detailed quarters (by id). The result has no `macro` (merging it again is a no-op).
 */
export function megaView(u: UrbanLayer, details?: Record<number, UrbanLayer>): UrbanLayer {
  const M = u.macro;
  if (!M) return u;
  const blocks: Polygon[] = [], blockInfo: UrbanBlockInfo[] = [], parcels: UrbanParcel[] = [], masses: UrbanLayer['masses'] = [];
  for (const q of M.quarters) {
    if (details?.[q.id] || q.inset.length < 3) continue;
    const green = q.kind === 'place' || q.district === 'gardens';
    if (q.kind === 'quarter') {
      // stand-in fabric: block-sized pieces with their built mass
      const si = standIn(q);
      for (const b of si.blocks) { blocks.push(b); blockInfo.push({ quarter: q.id, phase: q.phase, zone: q.zone, kind: 'block', culture: q.culture }); }
      for (const m of si.masses) masses.push({ outer: m, holes: [] });
      continue;
    }
    const bi = blocks.length;
    blocks.push(q.inset);
    blockInfo.push({ quarter: q.id, phase: q.phase, zone: q.zone, kind: q.kind === 'market' ? 'market' : green ? 'green' : 'block', culture: q.culture });
    if (q.kind === 'market') parcels.push({ poly: q.inset, use: 'market', block: bi });
    else if (green) parcels.push({ poly: q.inset, use: 'green', block: bi });
  }
  const base: UrbanLayer = { ...u, macro: undefined, blocks, blockInfo, parcels, masses };
  const ds = details ? Object.keys(details).map(Number).sort((a, b) => a - b).map((k) => details[k]) : [];
  return ds.length ? { ...mergeUrban([base, ...ds])!, macro: undefined } : base;
}

/** The World as the renderers should see it: `urban` = all settlements (main first; lazy ones as their extent). */
export function renderView(world: World): World {
  const main = world.urban?.macro ? megaView(world.urban, world.megaDetail) : world.urban;
  const wg = { data: world.terrain.water, n: world.terrain.height.w, cell: world.terrain.height.cell };
  const extra = (world.settlements ?? []).filter((s) => !s.main && (s.urban || s.detail === 'lazy')).map((s) => s.urban ?? placeholderUrban(s, wg));
  if (!extra.length || !main) return main === world.urban ? world : { ...world, urban: main };
  return { ...world, urban: mergeUrban([main, ...extra]) };
}
