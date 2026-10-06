import { describe, expect, it } from 'vitest';
import type { Polygon, UrbanLayer } from '../src/gen/types';
import type { Plot } from '../src/gen/urban/plots';
import { pointInRing } from '../src/gen/geo/poly';
import { clipUrban } from '../src/gen/settlements/urban';
import { mergeUrban } from '../src/gen/settlements/merge';
import { markPlannedTerminalPlots, openQuarterEdge, physicalTipConstraint } from '../src/gen/urban/edgeFinish';
import { LAB_OPEN } from '../src/gen/urban/streets';

const rect = (x0: number, y0: number, x1: number, y1: number): Polygon => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];
function layer(): UrbanLayer {
  const frame = { outer: rect(0, 0, 200, 100), holes: [] };
  const blocks = [rect(85, 30, 105, 50), rect(140, 30, 160, 50)];
  return {
    footprint: [frame.outer], footprintH: [frame], blocks,
    blockInfo: blocks.map(() => ({ quarter: 0, phase: 0, zone: 'edge', kind: 'block' })),
    parcels: blocks.map((poly, block) => ({ poly, block, use: 'plot', front: [poly[0], poly[1]] })),
    buildings: blocks.map((poly, parcel) => ({ poly, parcel, kind: 'house' })),
    streets: [{ path: [{ x: 0, y: 28 }, { x: 200, y: 28 }], width: 4, kind: 'street', role: 'street', rank: 3, phase: 0 }],
    quarters: [{ poly: frame, streetSpace: [frame], phase: 0, zone: 'edge' }],
    phases: [{ id: 0, kind: 'core', region: [frame], zone: 'edge', walled: false, fossil: false }],
    masses: blocks.map((outer) => ({ outer, holes: [] })), backLand: [],
    walls: [], landmarks: [], squares: [], archetype: 'town', population: 100, morphology: 'test',
  };
}

describe('open-edge integration', () => {
  it('removes discarded secondary ground while keeping a retained corner house whole', () => {
    const u = layer(), before = JSON.stringify(u);
    const clipped = clipUrban(u, rect(0, 0, 100, 100));
    expect(clipped.buildings).toHaveLength(1);
    expect(clipped.buildings[0].poly).toEqual(u.buildings[0].poly);
    expect(clipped.footprintH.some((p) => pointInRing(p.outer, { x: 104, y: 40 }))).toBe(true);
    expect(clipped.footprintH.some((p) => pointInRing(p.outer, { x: 150, y: 40 }))).toBe(false);
    expect(clipped.quarters.some((q) => pointInRing(q.poly.outer, { x: 150, y: 40 }))).toBe(false);
    expect(clipped.phases[0].region.some((p) => pointInRing(p.outer, { x: 150, y: 40 }))).toBe(false);
    expect(JSON.stringify(u)).toBe(before);
  });

  it('offsets tail street references across merged settlements without mutating either input', () => {
    const a = layer(), b = layer();
    a.openTails = [{ street: 0, end: 'end', point: { x: 200, y: 28 }, kind: 'unservedOpenEdge', servedFromEnd: 40, excess: 36 }];
    b.openTails = [{ ...a.openTails[0] }];
    a.openEdgeGround = [a.footprintH[0]]; b.openEdgeGround = [b.footprintH[0]];
    const before = JSON.stringify([a, b]), merged = mergeUrban([a, b])!;
    expect(merged.openTails?.map((t) => t.street)).toEqual([0, 1]);
    expect(merged.openEdgeGround).toHaveLength(2);
    expect(JSON.stringify([a, b])).toBe(before);
  });

  it('marks prospective terminal frontage without emptying or reordering the plot list', () => {
    const u = layer();
    u.streets[0].path = [{ x: 40, y: 28 }, { x: 100, y: 28 }];
    const plots = [{ poly: rect(85, 30, 98, 45), front: [{ x: 85, y: 30 }, { x: 98, y: 30 }], block: 0, zone: 'edge' }] as Plot[];
    markPlannedTerminalPlots(plots, u.streets, [{ outer: rect(0, 0, 100, 100), holes: [] }], {});
    expect(plots).toHaveLength(1);
    expect(plots[0].terminal).toBe(true);
  });

  it('distinguishes an empty exterior from a neighbouring quarter and physical water or paving', () => {
    const open = openQuarterEdge([
      { pts: rect(0, 0, 100, 100), lab: [LAB_OPEN, LAB_OPEN, LAB_OPEN, LAB_OPEN] },
      { pts: rect(100, 0, 200, 100), lab: [LAB_OPEN, LAB_OPEN, LAB_OPEN, LAB_OPEN] },
    ]);
    expect(open({ x: 100, y: 50 }, { x: 1, y: 0 })).toBe(false);
    expect(open({ x: 0, y: 50 }, { x: -1, y: 0 })).toBe(true);
    const physical = physicalTipConstraint([{ outer: rect(-10, 40, 0, 60), holes: [] }], (p) => p.y < 0);
    expect(physical({ x: 0, y: 50 }, { x: -1, y: 0 })).toBe(true);
    expect(physical({ x: 30, y: 0 }, { x: 0, y: -1 })).toBe(true);
    expect(physical({ x: 0, y: 80 }, { x: -1, y: 0 })).toBe(false);
  });
});
