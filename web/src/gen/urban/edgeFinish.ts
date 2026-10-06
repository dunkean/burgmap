/** Shared open-edge finishing for eager settlements and independent lazy quarters. */
import type { PolyH, UrbanLayer, UrbanStreet } from '../types';
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
