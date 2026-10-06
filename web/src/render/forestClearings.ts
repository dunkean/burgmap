/** Forest is excluded by urban quarters except explicit parks and gardens. Soil is unaffected. */
import type { PolyH, Polygon, Settlement, UrbanLayer, World } from '../gen/types';
import { differenceSafeS, unionMany } from '../gen/geo/bool';
import { orientPos } from '../gen/geo/poly';
import { groundAppearance } from '../gen/landuse/groundAppearance';
import { megaView, placeholderUrban } from '../gen/settlements/merge';
import { fabricBudget } from '../gen/urban/mega/standin';
import { MEGA_KEY } from '../gen/urban/mega/types';

const piece = (outer: Polygon): PolyH => ({ outer: orientPos(outer), holes: [] });
const boundary = (u: UrbanLayer): PolyH[] => u.footprintH.length ? u.footprintH
  : u.footprint.length ? u.footprint.map(piece) : u.quarters.length ? u.quarters.map((q) => q.poly) : u.blocks.map(piece);

/** Macro streets and other host land outside the retained quarter partitions. */
export function forestBase(u: UrbanLayer): PolyH[] {
  return differenceSafeS(boundary(u), (u.macro?.quarters ?? []).map((q) => piece(q.pts)));
}

export function forestClearings(u: UrbanLayer, world?: World, extent: PolyH[] = boundary(u)): PolyH[] {
  if (!extent.length) return [];
  const material = groundAppearance(u, world);
  const parks = [
    ...u.parcels.filter((p) => p.use === 'green' || (p.use === 'garden' && !material.naturalParcels.has(p.poly))).map((p) => piece(p.poly)),
    ...(u.sites ?? []).filter((s) => s.kind === 'park').map((s) => piece(s.lot)),
  ];
  return differenceSafeS(unionMany(extent, 24, true), unionMany(parks, 24, true));
}

/** Use the same eager, stand-in and detailed quarter partitions as the retained scene. */
export function worldForestClearings(world: World): PolyH[] {
  const hosts = [{ index: 0, urban: world.urban }, ...(world.settlements ?? []).filter((s) => !s.main)];
  const budget = fabricBudget(hosts.reduce((n, h) => n + (h.urban?.macro?.quarters.length ?? 0), 0));
  const water = { data: world.terrain.water, n: world.terrain.height.w, cell: world.terrain.height.cell };
  return hosts.flatMap((h) => {
    let u = h.urban;
    if (!u && 'detail' in h && h.detail === 'lazy') u = placeholderUrban(h as Settlement, water);
    if (!u) return [];
    if (!u.macro) return forestClearings(u, world);
    const owner = u;
    return owner.macro!.quarters.flatMap((q) => {
      if (q.district === 'gardens') return [];
      const detail = world.megaDetail?.[h.index * MEGA_KEY + q.id];
      const part = detail ?? megaView({ ...owner, blocks: [], blockInfo: [], parcels: [], buildings: [], masses: [],
        macro: { ...owner.macro!, quarters: [q] } }, undefined, budget);
      return forestClearings(part, world, [piece(q.pts)]);
    }).concat(forestClearings(owner, world, forestBase(owner)));
  });
}
