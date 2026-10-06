import { expect, it } from 'vitest';
import type { Polygon } from '../src/gen/core/geom';
import type { UrbanCtx } from '../src/gen/urban/context';
import type { EdgeRoofPartition } from '../src/gen/urban/edgeRoofs';
import { finishEdgeRoofs } from '../src/gen/urban/edgeRoofs';
import { Streets, LAB_OPEN } from '../src/gen/urban/streets';
import { streetStrips } from '../src/gen/urban/openfringe';
import { area, convexHull, minAngle } from '../src/gen/geo/poly';
import { mpArea, tryDifference } from '../src/gen/geo/bool';

const p = (x: number, y: number) => ({ x, y });

it('reconstructs the clipped cut03 rear house as a whole pentagon on a dry open edge', () => {
  // Native roof and owner from the user-pinned x985.2,y531.5 town. The long,
  // concave return makes every rectangular envelope more than double the roof.
  const roof: Polygon = [p(994.444, 533.994), p(986.325, 531.915), p(977.674, 529.877),
    p(977.113, 529.724), p(980.8824983750792, 519.1014881174053),
    p(987.4743072053566, 521.4406535567282), p(985.199, 527.854),
    p(1008.5465572687111, 538.2602251815221), p(1007.7204102346468, 540.1137806114434),
    p(1001.857, 536.962)];
  const owner: Polygon = [p(1059.1009645084077, 530.1826703855693), p(1048.1579543066055, 552.7321733157737),
    p(1047.265, 552.57), p(1039.066, 551.394), p(1031.039, 549.834), p(1023.342, 547.53),
    p(1015.969, 544.491), p(1008.904, 540.75), p(1001.857, 536.962), p(994.444, 533.994),
    p(986.325, 531.915), p(977.674, 529.877), p(977.113, 529.724), p(988.169, 498.568),
    p(993.758, 501.315), p(1005.4269242637927, 506.47064484068375)];
  const streets = new Streets();
  streets.connected.add(streets.add([p(988.169, 495.568), p(1059.101, 527.183)], 6, 1, 'radial', 1));
  const f: EdgeRoofPartition = {
    ctx: { mapSize: 1500, win: { x0: 0, y0: 0, x1: 1500, y1: 1500 }, water: [],
      isWater: () => false, slopeAt: () => 0.03 } as unknown as UrbanCtx,
    quarters: [{ lp: { pts: owner, lab: owner.map(() => LAB_OPEN) }, phase: 1,
      zone: 'edge', age: 0.1, kind: 'quarter' }],
    blocks: [{ poly: owner, quarter: 0 }],
    parcels: [{ poly: owner, block: 0, use: 'plot', front: [p(988.169, 498.568), p(1059.101, 530.183)], zone: 'edge' }],
    buildings: [{ poly: roof, parcel: 0, kind: 'rear', roof: 'gable', arch: 'gabled-row-house-rear' }],
    streetSpace: [[]], footprint: [{ outer: owner, holes: [] }], gardens: [], streets,
    protectedLand: streetStrips(streets.list[0].path, 6), phases: [], allowGrowth: true, eligible: () => true,
  };
  const candidate = convexHull(roof);
  expect(area(candidate) - area(roof)).toBeLessThan(area(roof));
  expect(minAngle(candidate) * 180 / Math.PI).toBeGreaterThan(20);
  const result = finishEdgeRoofs(f);
  expect(result.grown).toBe(1);
  expect(f.buildings).toHaveLength(1);
  expect(f.buildings[0].poly).toHaveLength(5);
  expect(mpArea(tryDifference(roof, f.buildings[0].poly).pieces)).toBeLessThanOrEqual(1e-6);
  expect(mpArea(tryDifference(f.buildings[0].poly, f.parcels[0].poly).pieces)).toBeLessThanOrEqual(1e-6);
  expect(mpArea(tryDifference(f.parcels[0].poly, f.blocks[0].poly).pieces)).toBeLessThanOrEqual(1e-6);
});
