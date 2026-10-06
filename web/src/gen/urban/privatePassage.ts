/** A narrow discarded roof arm can become a real private pedestrian entrance. */
import type { Polygon, Vec2 } from '../core/geom';
import type { PolyH, UrbanBuilding, UrbanParcel } from '../types';
import { mpArea, tryDifference, tryIntersection } from '../geo/bool';
import { area, distToRing, isSimple } from '../geo/poly';
import { ribbon } from '../geo/offset';
import { blockReach, makeStreetAt } from './access';
import { footprintAccessGuard } from './edgeFinish';
import { streetStrips } from './openfringe';

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
  let publicPieces: PolyH[] = [];
  let publicEdges: { a: Vec2; b: Vec2 }[] = [];
  const length = (path: Vec2[]) => path.slice(1).reduce((sum, p, i) =>
    sum + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0);
  const publicContact = (path: Vec2[], main: Polygon, width: number, corridor: Polygon): boolean => {
    // Only a full terminal cap shared with the actual road/place edge connects
    // a passage. A nearby point or a two-centimetre gap is not an entrance.
    const firstHouse = distToRing(main, path[0]) <= 0.05;
    const lastHouse = distToRing(main, path[path.length - 1]) <= 0.05;
    if (firstHouse === lastHouse) return false;
    const end = firstHouse ? path[path.length - 1] : path[0];
    const near = firstHouse ? path[path.length - 2] : path[1];
    const dx = near.x - end.x, dy = near.y - end.y, mag = Math.hypot(dx, dy);
    if (mag < 1e-7) return false;
    const side = { x: -dy / mag * width / 2, y: dx / mag * width / 2 };
    const a = { x: end.x + side.x, y: end.y + side.y };
    const b = { x: end.x - side.x, y: end.y - side.y };
    const hasVertex = (p: Vec2) => corridor.some(q => Math.hypot(q.x - p.x, q.y - p.y) <= 1e-7);
    if (!hasVertex(a) || !hasVertex(b)) return false;
    const overlap = tryIntersection(corridor, publicPieces);
    if (overlap.failed || mpArea(overlap.pieces) > 1e-8) return false;
    return publicEdges.some(e => {
      const ex = e.b.x - e.a.x, ey = e.b.y - e.a.y, size = Math.hypot(ex, ey);
      if (size < width - 1e-7) return false;
      const ux = ex / size, uy = ey / size;
      const signed = (p: Vec2) => Math.abs((p.x - e.a.x) * uy - (p.y - e.a.y) * ux);
      if (signed(a) > 1e-7 || signed(b) > 1e-7) return false;
      const ta = (a.x - e.a.x) * ux + (a.y - e.a.y) * uy;
      const tb = (b.x - e.a.x) * ux + (b.y - e.a.y) * uy;
      return Math.min(size, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb)) >= width - 1e-7;
    });
  };
  let count = -1;
  let current = makeStreetAt(streets, places);
  let access = footprintAccessGuard(buildings, parcels, blocks, current);
  const refresh = () => {
    if (count === passages.length) return;
    count = passages.length;
    publicPieces = [...[...streets, ...passages].flatMap(s => streetStrips(s.path, 'widths' in s ? s.widths ?? s.width : s.width)),
      ...places.map(outer => ({ outer, holes: [] }))];
    publicEdges = publicPieces.flatMap(piece => piece.outer.map((a, i) =>
      ({ a, b: piece.outer[(i + 1) % piece.outer.length] })));
    current = makeStreetAt([...streets, ...passages], places);
    // blockReach caches boundary seeds by StreetAt identity. Refresh that identity
    // together with the guard when a newly accepted private entrance is appended.
    access = footprintAccessGuard(buildings, parcels, blocks, current);
  };
  const prove = (original: number, main: Polygon, path: Vec2[], width: number): boolean => {
      refresh();
      const building = buildings[original], ownerId = building?.parcel;
      const owner = ownerId === undefined ? undefined : parcels[ownerId];
      const blockId = owner?.block;
      if (!owner || blockId === undefined || !blocks[blockId] || width < 0.8 || width > 1.5
        || path.length < 2 || path.length > 8 || length(path) > 128
        || path.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
      const corridor = ribbon(path, width);
      if (!isSimple(corridor) || area(corridor) < 0.1) return false;
      if (!publicContact(path, main, width, corridor) || !input.placementClear(corridor, building.poly)) return false;
      // The rendered passage must actually meet an entrance, not just fall within
      // the generous street raster slack. Either path orientation is supported.
      if (!([path[0], path[path.length - 1]].some(p => distToRing(main, p) <= 0.05))) return false;
      // The discarded arm was already occupied by this same building. Reuse its
      // footprint without granting any newly claimed settlement land to the route.
      const outside = tryDifference(corridor, owner.poly, building.poly, ...input.publicGround);
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
  };
  const connectPrivatePassage = (original: number, main: Polygon, path: Vec2[], width: number): Vec2[] | false => {
    if (prove(original, main, path, width)) return path.slice();
    refresh();
    if (path.length < 2 || path.length > 5 || path.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
    const firstHouse = distToRing(main, path[0]) <= 0.05;
    const lastHouse = distToRing(main, path[path.length - 1]) <= 0.05;
    if (firstHouse === lastHouse) return false;
    const reverse = firstHouse, oriented = reverse ? path.slice().reverse() : path;
    const free = oriented[0], next = oriented[1];
    const dx = free.x - next.x, dy = free.y - next.y, mag = Math.hypot(dx, dy);
    if (mag < 0.1) return false;
    const ranked = publicEdges.map((edge, index) => {
      const vx = edge.b.x - edge.a.x, vy = edge.b.y - edge.a.y, squared = vx * vx + vy * vy;
      const t = squared ? Math.max(0, Math.min(1, ((free.x - edge.a.x) * vx + (free.y - edge.a.y) * vy) / squared)) : 0;
      const nearest = { x: edge.a.x + vx * t, y: edge.a.y + vy * t };
      return { edge, index, t, nearest, distance: Math.hypot(nearest.x - free.x, nearest.y - free.y),
        size: Math.sqrt(squared) };
    }).filter(t => t.distance <= 96).sort((a, b) => a.distance - b.distance || a.index - b.index);
    const bins = new Set<string>();
    const targets = ranked.filter(t => {
      const key = `${Math.floor(t.nearest.x / 8)}:${Math.floor(t.nearest.y / 8)}`;
      if (bins.has(key)) return false;
      bins.add(key); return true;
    }).slice(0, 32);
    let trials = 0;
    for (const target of targets) for (const offset of [0, -4, 4]) {
      if (target.size <= width + 2e-6) continue;
      const t = Math.max((width / 2 + 1e-6) / target.size,
        Math.min(1 - (width / 2 + 1e-6) / target.size, target.t + offset / target.size));
      const end = { x: target.edge.a.x + (target.edge.b.x - target.edge.a.x) * t,
        y: target.edge.a.y + (target.edge.b.y - target.edge.a.y) * t };
      for (const [extension, lateralShift] of [[0, 0], [5, 0], [10, 0], [15, 0],
        [25, -15], [25, 15], [35, -20], [35, 20]]) {
        if (++trials > 512) return false;
        const mid = { x: free.x + dx / mag * extension - dy / mag * lateralShift,
          y: free.y + dy / mag * extension + dx / mag * lateralShift };
        const ex = target.edge.b.x - target.edge.a.x, ey = target.edge.b.y - target.edge.a.y;
        const edgeLength = Math.hypot(ex, ey);
        if (edgeLength < 0.1) continue;
        const sign = Math.sign(ex * (free.y - end.y) - ey * (free.x - end.x));
        if (!sign) continue;
        const nx = -ey / edgeLength * sign, ny = ex / edgeLength * sign;
        const distance = Math.hypot(end.x - free.x, end.y - free.y);
        if (distance < 1e-5 || distance > 96) continue;
        const step = Math.min(2, distance / 2);
        const approach = { x: end.x + nx * step, y: end.y + ny * step };
        const candidate = [end, approach, ...(extension ? [mid] : []), ...oriented];
        if (length(candidate) > 128) continue;
        const route = reverse ? candidate.reverse() : candidate;
        if (prove(original, main, route, width)) return route;
      }
    }
    return false;
  };
  const validateRemoval = (original: number, pendingRemoved: readonly number[]): boolean => {
    refresh();
    const ownerId = buildings[original]?.parcel;
    const blockId = ownerId === undefined ? undefined : parcels[ownerId]?.block;
    if (blockId === undefined || !blocks[blockId]
      || pendingRemoved.some(i => !Number.isInteger(i) || i < 0 || i >= buildings.length)) return false;
    const peers = buildings.map((b, i) => ({ b, i }))
      .filter(({ b }) => b.parcel !== undefined && parcels[b.parcel]?.block === blockId);
    if (!peers.some(({ i }) => i === original)) return false;
    const removed = new Set([original, ...pendingRemoved]);
    const before = blockReach(blocks[blockId], peers.map(({ b }) => b.poly), current);
    const survivors = peers.filter(({ i }) => !removed.has(i));
    const after = blockReach(blocks[blockId], survivors.map(({ b }) => b.poly), current);
    return survivors.every(({ i }, j) => after[j] || !before[peers.findIndex(p => p.i === i)]);
  };
  return {
    validateParts: (original: number, parts: Polygon[]) => { refresh(); return access(original, parts); },
    validateRemoval,
    proposePrivatePassage: prove,
    connectPrivatePassage,
  };
}
