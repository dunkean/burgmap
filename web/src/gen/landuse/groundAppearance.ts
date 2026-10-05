/** Display materials for residential land. Geometry and generated land use remain unchanged. */
import type { World, UrbanLayer, PolyH, Polygon, UrbanBlockInfo, Vec2, UrbanBuilding, UrbanStreet } from '../types';
import { biomeName } from '../biomes';
import { polygonCentroid, polygonContains } from '../core/geom';
import { bboxOf } from '../geo/poly';

export interface GroundAppearance {
  gardens: PolyH[];
  natural: PolyH[];
  naturalParcels: Set<Polygon>;
  earthStreets: boolean;
  streetSources: UrbanStreet[];
}

/** A garden/yard is not evidence of irrigation. Only dry ordinary residential land loses that green fill. */
export function groundAppearance(u: UrbanLayer, world?: World): GroundAppearance {
  if (!world || u.renderHints?.graves || u.renderHints?.stilts) {
    return { gardens: u.backLand, natural: [], naturalParcels: new Set(), earthStreets: false, streetSources: [] };
  }
  const biome = biomeName(world.options.biome), dry = biome === 'desert';
  const open = !!u.renderHints?.openGround;
  // Quarter detail exports culture on blockInfo/morphology, not on the layer's optional scalar field.
  const culture = u.culture ?? u.blockInfo.find((b) => b.culture)?.culture;
  const earthStreets = dry && (culture === 'sahel' || u.morphology?.startsWith('sahel') || u.archetype !== 'town' || open);
  const fields = world.site?.fields, grid = world.terrain.height;
  const irrigated = (p: Vec2): boolean => {
    if (!fields) return false;
    const x = Math.floor(p.x / grid.cell), y = Math.floor(p.y / grid.cell), i = y * grid.w + x;
    return x >= 0 && y >= 0 && x < grid.w && y < grid.h && fields.dWater[i] <= 180 && fields.hab[i] <= 28;
  };
  // Blocks index the owner of otherwise anonymous plot-garden pieces. Avoid a map-wide O(gardens*blocks) scan.
  const buckets = new Map<string, number[]>(), cell = 128;
  u.blocks.forEach((poly, i) => {
    const b = bboxOf(poly);
    if (![b.x0, b.y0, b.x1, b.y1].every(Number.isFinite)) return;
    for (let y = Math.floor(b.y0 / cell); y <= Math.floor(b.y1 / cell); y++) {
      for (let x = Math.floor(b.x0 / cell); x <= Math.floor(b.x1 / cell); x++) {
        const key = `${x},${y}`, ids = buckets.get(key) ?? []; ids.push(i); buckets.set(key, ids);
      }
    }
  });
  const parcelOwners = new Map(u.parcels.map((p) => [p.poly, p]));
  const owner = (poly: Polygon, p: Vec2): UrbanBlockInfo | undefined => {
    const parcel = parcelOwners.get(poly);
    if (parcel) return u.blockInfo[parcel.block];
    return (buckets.get(`${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`) ?? [])
      .filter((i) => polygonContains(u.blocks[i], p)).map((i) => u.blockInfo[i])[0];
  };
  const dedicated = (p: Vec2): boolean => (u.sites ?? []).some((s) => s.role !== 'suburb' && s.role !== 'shanty' && polygonContains(s.lot, p))
    || u.landmarks.some((l) => ['garth', 'orchard', 'garden-bed', 'cornfield', 'terrace-field', 'chinampa', 'cemetery'].includes(l.kind) && polygonContains(l.poly, p));
  const natural = (poly: Polygon): boolean => {
    const p = polygonCentroid(poly), info = owner(poly, p);
    if (dedicated(p) || (info && !['block', 'shanty'].includes(info.kind))) return false;
    // A detached named garden is a real dedicated plot, not a generic rear yard.
    if (!info && parcelOwners.has(poly) && !open) return false;
    if (dry) return !irrigated(p);
    return open || ['edge', 'faubourg', 'village'].includes(info?.zone ?? '');
  };
  const gardens: PolyH[] = [], exposed: PolyH[] = [], naturalParcels = new Set<Polygon>();
  for (const p of u.backLand) (natural(p.outer) ? exposed : gardens).push(p);
  for (const p of u.parcels) {
    if ((p.use === 'garden' && natural(p.poly)) || (open && ['meadow', 'green', 'commons'].includes(p.use))) naturalParcels.add(p.poly);
  }
  return { gardens, natural: exposed, naturalParcels, earthStreets, streetSources: earthStreets ? u.streets : [] };
}

/** Sahel mud houses enclose an earth court. A patio alone is not evidence of laid paving. */
export const earthCourt = (b: UrbanBuilding, world: World): boolean => biomeName(world.options.biome) === 'desert'
  && ['sudano-sahelian-house', 'compound-room'].includes(b.arch ?? '');

/** Preserve each settlement's material policy when its geometry is concatenated for display. */
export function worldGroundAppearance(world: World): GroundAppearance {
  const layers = [world.urban, ...(world.settlements ?? []).filter((s) => !s.main).map((s) => s.urban), ...Object.values(world.megaDetail ?? {})]
    .filter((u): u is UrbanLayer => !!u);
  const material = layers.map((u) => groundAppearance(u, world));
  return { gardens: material.flatMap((m) => m.gardens), natural: material.flatMap((m) => m.natural),
    naturalParcels: new Set(material.flatMap((m) => [...m.naturalParcels])), earthStreets: material.some((m) => m.earthStreets),
    streetSources: material.flatMap((m) => m.streetSources) };
}
