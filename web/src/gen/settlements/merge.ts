/**
 * Renderer view of a settlement system: the urban layers of all settlements concatenated into one (indices of
 * parcels and blocks offset), so the SVG and canvas renderers draw every town and village with the same code.
 * The main settlement's scalar fields (archetype, population, culture, phases) are kept.
 */
import type { World, UrbanLayer, Settlement } from '../types';

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

/** Stand-in plan of a settlement whose detail is not generated yet: its projected extent as one built-up block. */
export function placeholderUrban(s: Settlement): UrbanLayer {
  const ext = s.extent;
  return {
    footprint: [ext], footprintH: [{ outer: ext, holes: [] }], streets: [], blocks: [ext], parcels: [], buildings: [], walls: [],
    landmarks: [], squares: [], archetype: 'town', population: s.population, morphology: 'placeholder', phases: [], quarters: [],
    blockInfo: [{ quarter: 0, phase: 1, zone: 'core', kind: 'block' }], masses: [], backLand: [],
  };
}

/** The World as the renderers should see it: `urban` = all settlements (main first; lazy ones as their extent). */
export function renderView(world: World): World {
  const extra = (world.settlements ?? []).filter((s) => !s.main && (s.urban || s.detail === 'lazy')).map((s) => s.urban ?? placeholderUrban(s));
  if (!extra.length || !world.urban) return world;
  return { ...world, urban: mergeUrban([world.urban, ...extra]) };
}
