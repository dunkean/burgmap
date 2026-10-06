import { expect, it } from 'vitest';
import type { Polygon } from '../src/gen/core/geom';
import type { UrbanCtx } from '../src/gen/urban/context';
import type { EdgeRoofPartition } from '../src/gen/urban/edgeRoofs';
import { finishEdgeRoofs } from '../src/gen/urban/edgeRoofs';
import { Streets, LAB_OPEN } from '../src/gen/urban/streets';
import { streetStrips } from '../src/gen/urban/openfringe';
import { mpArea, tryDifference } from '../src/gen/geo/bool';

it('confines lazy edge growth to its allowed collar', () => {
  const quarter: Polygon = [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 190 }, { x: 100, y: 170 }];
  const plot: Polygon = [{ x: 120, y: 103 }, { x: 140, y: 103 }, { x: 140, y: 178 }, { x: 120, y: 174 }];
  const roof: Polygon = [{ x: 120, y: 160 }, { x: 140, y: 160 }, { x: 140, y: 178 }, { x: 120, y: 174 }];
  const streets = new Streets();
  streets.connected.add(streets.add([{ x: 100, y: 100 }, { x: 200, y: 100 }], 6, 1, 'radial', 1));
  const input: EdgeRoofPartition = {
    ctx: { mapSize: 1000, win: { x0: 0, y0: 0, x1: 1000, y1: 1000 }, water: [],
      isWater: () => false, slopeAt: () => 0.03 } as unknown as UrbanCtx,
    quarters: [{ lp: { pts: quarter, lab: [0, LAB_OPEN, LAB_OPEN, LAB_OPEN] }, phase: 1,
      zone: 'edge', age: 0.1, kind: 'quarter' }], blocks: [{ poly: plot, quarter: 0 }],
    parcels: [{ poly: plot, block: 0, use: 'plot', front: [{ x: 120, y: 103 }, { x: 140, y: 103 }], zone: 'edge' }],
    buildings: [{ poly: roof, parcel: 0, kind: 'house', roof: 'gable', arch: 'gabled-row-house' }],
    streetSpace: [tryDifference(quarter, plot).pieces], footprint: [{ outer: quarter, holes: [] }],
    gardens: [], streets, protectedLand: streetStrips(streets.list[0].path, 6),
    phases: [{ id: 1, region: [{ outer: quarter, holes: [] }], band: [{ outer: quarter, holes: [] }] }],
    allowGrowth: true, growthLimit: [{ outer: quarter, holes: [] }], eligible: () => true,
  };
  const result = finishEdgeRoofs(input);
  expect(result.grown).toBe(0);
  const outside = tryDifference(input.buildings[0].poly, input.growthLimit!);
  expect(outside.failed).toBe(false);
  expect(mpArea(outside.pieces)).toBeLessThanOrEqual(1e-6);
});
