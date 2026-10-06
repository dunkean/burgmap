/** Shared open-edge finishing for eager settlements and independent lazy quarters. */
import type { PolyH, Polygon, UrbanBuilding, UrbanLayer, UrbanParcel, UrbanStreet, Vec2 } from '../types';
import { bboxOf, distToSeg, pointInRing } from '../geo/poly';
import { GridIndex } from '../geo/spatial';
import { LAB_OPEN } from './streets';
import { blockReach, type StreetAt } from './access';
import { unionMany, tryIntersection, mpArea } from '../geo/bool';
import { ribbon } from '../geo/offset';
import type { Plot } from './plots';
import { naturalGroundEligible } from '../landuse/urbanGround';
import { classifyStreetTails, markTerminalPlots, openTailGround, type StreetTailContext } from './openTails';

/** Prospective frontage, used before the independent seeded building programmes run. */
export function markPlannedTerminalPlots(plots: Plot[], streets: UrbanStreet[], owner: PolyH[], context: StreetTailContext): void {
  if (!plots.length || !owner.length) return;
  const draft: UrbanLayer = {
    footprint: owner.map((p) => p.outer), footprintH: owner, streets,
    blocks: [], blockInfo: [], quarters: [], phases: [], masses: [], backLand: [],
    walls: [], landmarks: [], squares: [], archetype: 'town', population: 0, morphology: '',
    parcels: plots.map((p) => ({ poly: p.poly, front: p.front, block: p.block, use: 'plot', zone: p.zone })),
    buildings: plots.map((p, parcel) => ({ poly: p.poly, kind: 'house', parcel })),
  };
  markTerminalPlots(plots, classifyStreetTails(draft, { ...context, owner }), streets);
}

/** Metadata never changes the planning axes used for frontage, containment and access. */
export function finishOpenEdges(layer: UrbanLayer, context: StreetTailContext, policy: UrbanLayer = layer): void {
  if (!naturalGroundEligible(policy)) return;
  layer.openTails = classifyStreetTails(layer, context);
  layer.openEdgeGround = openTailGround(layer, layer.openTails, context);
}

/** A planning outline is not an obstacle; only occupied neighbour land or a physical surface constrains a tip. */
export function physicalTipConstraint(protectedLand: PolyH[], isWater: (p: Vec2) => boolean): (tip: Vec2, outward: Vec2) => boolean {
  const index = new GridIndex<number>(24);
  const large: number[] = [];
  protectedLand.forEach((p, i) => {
    const b = bboxOf(p.outer);
    if ((1 + (b.x1 - b.x0) / 24) * (1 + (b.y1 - b.y0) / 24) > 1024) large.push(i);
    else index.insertPts(p.outer, i);
  });
  return (tip, outward) => [0.5, 1.5, 3].some((distance) => {
    const p = { x: tip.x + outward.x * distance, y: tip.y + outward.y * distance };
    return isWater(p) || [...index.queryPt(p, 0.1), ...large].some((i) => pointInRing(protectedLand[i].outer, p)
      && !protectedLand[i].holes.some((hole) => pointInRing(hole, p)));
  });
}

/** Only the actual outer planning edge permits a whole house to stand on free surrounding land. */
export function openQuarterEdge(quarters: { pts: Polygon; lab: number[] }[]): (tip: Vec2, outward: Vec2) => boolean {
  const edges = quarters.flatMap((q) => q.pts.flatMap((a, i) => q.lab[i] === LAB_OPEN ? [{ a, b: q.pts[(i + 1) % q.pts.length] }] : []));
  return (tip, outward) => {
    if (!edges.some((edge) => distToSeg(tip, edge.a, edge.b) < 2)) return false;
    const beyond = { x: tip.x + 1.5 * outward.x, y: tip.y + 1.5 * outward.y };
    return !quarters.some((q) => pointInRing(q.pts, beyond));
  };
}

/** Check a proposed footprint transaction against the current peers, including earlier accepted splits. */
export function footprintAccessGuard(buildings: UrbanBuilding[], parcels: UrbanParcel[], blocks: Polygon[], streetAt: StreetAt): (original: number, parts: Polygon[]) => boolean {
  return (original, parts) => {
    const owner = buildings[original]?.parcel;
    const block = owner === undefined ? undefined : parcels[owner]?.block;
    if (block === undefined || block < 0 || !blocks[block] || !parts.length) return false;
    const peers = buildings.map((b, i) => ({ b, i })).filter(({ b }) => b.parcel !== undefined && parcels[b.parcel]?.block === block);
    const before = blockReach(blocks[block], peers.map(({ b }) => b.poly), streetAt);
    const proposed: Polygon[] = [], required: boolean[] = [];
    peers.forEach(({ b, i }, j) => {
      if (i === original) for (const part of parts) { proposed.push(part); required.push(true); }
      else { proposed.push(b.poly); required.push(before[j]); }
    });
    const after = blockReach(blocks[block], proposed, streetAt);
    return after.every((reached, i) => reached || !required[i]);
  };
}

/** A relocated roof must avoid the full physical reserve, not just sample its corners. */
export function footprintPlacementGuard(protectedLand: PolyH[], unsafe: (point: Vec2) => boolean): (poly: Polygon) => boolean {
  const index = new GridIndex<number>(24), large: number[] = [];
  protectedLand.forEach((p, i) => {
    const b = bboxOf(p.outer);
    if ((1 + (b.x1 - b.x0) / 24) * (1 + (b.y1 - b.y0) / 24) > 1024) large.push(i);
    else index.insertPts(p.outer, i);
  });
  return (poly) => {
    if (poly.length < 3 || poly.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || unsafe(p))) return false;
    const box = bboxOf(poly);
    const hit = tryIntersection(poly, [...new Set([...index.query(box.x0, box.y0, box.x1, box.y1), ...large])].map(i => protectedLand[i]));
    if (hit.failed || mpArea(hit.pieces) > 1e-6) return false;
    for (let y = box.y0; y <= box.y1; y += 2) for (let x = box.x0; x <= box.x1; x += 2) {
      const p = { x, y };
      if (pointInRing(poly, p) && unsafe(p)) return false;
    }
    return true;
  };
}

/** Fixed collar for independent macro roof ownership; its outer radius is at most r / cos(pi/24). */
export function quarterRoofCollar(poly: Polygon, radius: number): PolyH[] {
  const pieces: PolyH[] = [{ outer: poly, holes: [] }];
  const circumradius = radius / Math.cos(Math.PI / 24);
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    pieces.push({ outer: ribbon([p, q], 2 * radius), holes: [] });
    pieces.push({ outer: Array.from({ length: 24 }, (_, j) => ({
      x: p.x + circumradius * Math.cos((j + 0.5) * Math.PI / 12),
      y: p.y + circumradius * Math.sin((j + 0.5) * Math.PI / 12),
    })), holes: [] });
  }
  return unionMany(pieces, 24, true);
}
