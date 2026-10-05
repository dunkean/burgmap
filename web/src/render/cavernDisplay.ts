/** Cave-only display projection. The generated World and its geometry stay untouched. */
import type { World, UrbanLayer } from '../gen/types';
import { CAVERN_CROP_MARKS } from '../gen/terrain/caverns';

const CACHE = new WeakMap<World, { signature: unknown[]; view: World }>();
const URBAN = new WeakMap<UrbanLayer, UrbanLayer>();
const PROJECTED = new WeakSet<World>();
const CULTIVATED = new Set(['garden', 'field', 'orchard', 'farm']);

function urbanView(u: UrbanLayer | undefined): UrbanLayer | undefined {
  if (!u) return undefined;
  const old = URBAN.get(u); if (old) return old;
  // Keep array positions: building.parcel and street/block ownership remain valid.
  const view = { ...u, backLand: [],
    parcels: u.parcels.map(p => CULTIVATED.has(p.use) ? { ...p, use: 'commons' } : p),
    landmarks: u.landmarks.filter(l => !CAVERN_CROP_MARKS.has(l.kind)) };
  URBAN.set(u, view); URBAN.set(view, view); return view;
}

export function cavernDisplayWorld(world: World): World {
  if (world.options.biome !== 'underdark-caverns' || !world.terrain.caverns || PROJECTED.has(world)) return world;
  const signature: unknown[] = [world.terrain.caverns, world.landuse, world.urban, world.names, world.settlements,
    ...Object.entries(world.megaDetail ?? {}).sort(([a], [b]) => Number(a) - Number(b)).flat()];
  const old = CACHE.get(world);
  if (old && signature.length === old.signature.length && signature.every((x, i) => x === old.signature[i])) return old.view;
  const landuse = world.landuse && { ...world.landuse,
    areas: world.landuse.areas.filter(a => !CULTIVATED.has(a.kind) && a.cultivation !== 'fungal'),
    farmsteads: world.landuse.farmsteads.map(f => ({ ...f,
      lot: undefined, plots: [], walls: [], trees: [] })),
    // Surface plot access and headland lines are not underground galleries.
    ways: [], headlands: [] };
  const view: World = { ...world, landuse, urban: urbanView(world.urban),
    settlements: world.settlements?.map(s => s.urban ? { ...s, urban: urbanView(s.urban) } : s),
    megaDetail: world.megaDetail && Object.fromEntries(Object.entries(world.megaDetail).map(([k, u]) => [k, urbanView(u)!])),
    names: world.names && { ...world.names, entries: world.names.entries.filter(e => e.kind !== 'farm') } };
  PROJECTED.add(view); CACHE.set(world, { signature, view }); return view;
}
