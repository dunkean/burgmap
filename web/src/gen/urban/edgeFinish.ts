/** Shared open-edge finishing for eager settlements and independent lazy quarters. */
import type { PolyH, Polygon, UrbanLayer, UrbanStreet, Vec2 } from '../types';
import { bboxOf, distToSeg, pointInRing } from '../geo/poly';
import { GridIndex } from '../geo/spatial';
import { LAB_OPEN } from './streets';
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
