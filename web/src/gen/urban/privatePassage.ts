/** A narrow discarded roof arm can become a real private pedestrian entrance. */
import type { Polygon, Vec2 } from '../core/geom';
import type { PolyH, UrbanBuilding, UrbanParcel } from '../types';
import { mpArea, tryDifference, tryIntersection } from '../geo/bool';
import { area, distToRing, isSimple } from '../geo/poly';
import { ribbon } from '../geo/offset';
import { blockReach, makeStreetAt } from './access';
import { footprintAccessGuard } from './edgeFinish';

export interface PrivatePassage { path: Vec2[]; width: number; parcel: number }
export interface PrivatePassageInput {
  buildings: UrbanBuilding[];
  parcels: UrbanParcel[];
  blocks: Polygon[];
  streets: { path: Vec2[]; width: number; widths?: number[] }[];
  places: Polygon[];
  publicGround: PolyH[];
  /** Full urban ownership; outside it a physically clear apron is unclaimed dry land. */
  footprint?: PolyH[];
  passages: PrivatePassage[];
  placementClear: (poly: Polygon, original?: Polygon) => boolean;
}

/** Proofs are read-only; the finalizer appends a passage only with its successful roof transaction. */
export function privatePassageAccess(input: PrivatePassageInput) {
  const { buildings, parcels, blocks, streets, places, passages } = input;
  let count = -1;
  let current = makeStreetAt(streets, places);
  let access = footprintAccessGuard(buildings, parcels, blocks, current);
  const refresh = () => {
    if (count === passages.length) return;
    count = passages.length;
    current = makeStreetAt([...streets, ...passages], places);
    // blockReach caches boundary seeds by StreetAt identity. Refresh that identity
    // together with the guard when a newly accepted private entrance is appended.
    access = footprintAccessGuard(buildings, parcels, blocks, current);
  };
  return {
    validateParts: (original: number, parts: Polygon[]) => { refresh(); return access(original, parts); },
    proposePrivatePassage: (original: number, main: Polygon, path: Vec2[], width: number): boolean => {
      refresh();
      const building = buildings[original], ownerId = building?.parcel;
      const owner = ownerId === undefined ? undefined : parcels[ownerId];
      const blockId = owner?.block;
      if (!owner || blockId === undefined || !blocks[blockId] || width < 0.8 || width > 1.5
        || path.length < 2 || path.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
      const corridor = ribbon(path, width);
      if (!isSimple(corridor) || area(corridor) < 0.1 || !input.placementClear(corridor, building.poly)) return false;
      // The rendered passage must actually meet an entrance, not just fall within
      // the generous street raster slack. Either path orientation is supported.
      if (!([path[0], path[path.length - 1]].some(p => distToRing(main, p) <= 0.05))) return false;
      const outside = tryDifference(corridor, owner.poly, ...input.publicGround);
      if (outside.failed) return false;
      if (mpArea(outside.pieces) > 1e-6) {
        if (!input.footprint?.length) return false;
        const claimed = tryIntersection(outside.pieces, input.footprint);
        if (claimed.failed || mpArea(claimed.pieces) > 1e-6) return false;
      }
      const otherOwners = parcels.filter((p, i) => i !== ownerId && ['plot', 'hut-lot', 'garden'].includes(p.use));
      const ownerHit = tryIntersection(corridor, otherOwners.map(p => ({ outer: p.poly, holes: [] })));
      const roofHit = tryIntersection(corridor, [main, ...buildings.filter((_, i) => i !== original).map(b => b.poly)]
        .map(outer => ({ outer, holes: [] })));
      if (ownerHit.failed || roofHit.failed || mpArea(ownerHit.pieces) > 1e-6 || mpArea(roofHit.pieces) > 1e-6) return false;
      const peers = buildings.map((b, i) => ({ b, i })).filter(({ b }) => b.parcel !== undefined && parcels[b.parcel]?.block === blockId);
      const before = blockReach(blocks[blockId], peers.map(({ b }) => b.poly), current);
      const replacement = peers.flatMap(({ b, i }) => i === original ? [main, corridor] : [b.poly]);
      const corridorIndex = peers.findIndex(({ i }) => i === original) + 1;
      // Probe the corridor as occupied geometry against the EXISTING public network.
      // It cannot invent its own street-side seed on a virtual block boundary.
      const reached = blockReach(blocks[blockId], replacement, current);
      if (!reached[corridorIndex]) return false;
      const candidateStreetAt = makeStreetAt([...streets, ...passages, { path, width }], places);
      const proposed = peers.map(({ b, i }) => i === original ? main : b.poly);
      const after = blockReach(blocks[blockId], proposed, candidateStreetAt);
      return after.every((yes, i) => yes || (peers[i].i !== original && !before[i]));
    },
  };
}
