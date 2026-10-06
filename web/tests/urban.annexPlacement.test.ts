import { expect, it } from 'vitest';
import type { Polygon } from '../src/gen/core/geom';
import { finalizeFootprints } from '../src/gen/urban/footprintFinal';
import { area } from '../src/gen/geo/poly';
import { mpArea, tryDifference, tryIntersection } from '../src/gen/geo/bool';

const p = (x: number, y: number) => ({ x, y });

it('places the pinned thin back house on vacant land of the same served owner', () => {
  // Native block-0 parcel and roofs at user pin x461,y435. The two backs cannot
  // simply merge: their union still has a 2.47m neck, and its convex hull takes
  // nearly 10m² from the next parcel.
  const owner: Polygon = [p(448.927, 435.296), p(448.124, 435.035), p(458.505, 408.048),
    p(465.2500046706218, 406.9142592905294), p(468.1901629703758, 432.78989702890544),
    p(460.7630344691916, 434.0382738953555), p(461.134, 436.986), p(450.154, 436.986)];
  const roofs: Polygon[] = [
    [p(452.83562018662406, 422.78642182679346), p(465.4729859942142, 420.66225783044507),
      p(467.12116977013864, 430.46785727111825), p(454.4838039625485, 432.59202126746663)],
    [p(448.927, 435.296), p(448.124, 435.035), p(448.68906138931527, 433.5660363439505),
      p(457.90531322658404, 432.01691363657045), p(458.74054696980636, 436.986), p(450.154, 436.986)],
    [p(457.90531322658404, 432.01691363657045), p(467.1211698853313, 430.4678573531588),
      p(467.4001042557215, 432.92269276851795), p(460.7630344691916, 434.0382738953555),
      p(461.134, 436.986), p(458.74054696980636, 436.986)],
  ];
  const buildings = roofs.map((poly, i) => ({ poly, parcel: 0, kind: i ? 'back' as const : 'rear' as const,
    arch: i ? 'gabled-row-house-back' : 'gabled-row-house-rear', roof: 'gable' as const }));
  const parcels = [{ poly: owner, block: 0, use: 'plot' as const,
    front: [p(458.505, 408.048), p(465.2500046706218, 406.9142592905294)] as [ReturnType<typeof p>, ReturnType<typeof p>],
    zone: 'core' as const }];
  const backLand: { outer: Polygon; holes: Polygon[] }[] = [];
  const beforeArea = buildings.reduce((s, b) => s + area(b.poly), 0);
  const result = finalizeFootprints({ buildings, parcels, backLand,
    placementClear: () => true,
    validateParts: (i, parts) => parts.every((part) => buildings.every((peer, j) => j === i
      || mpArea(tryIntersection(part, peer.poly).pieces) <= 1e-6)),
  });
  expect(result.invalid).not.toContain(2);
  expect(buildings).toHaveLength(3);
  expect(area(buildings[2].poly)).toBeGreaterThanOrEqual(area(roofs[2]));
  expect(area(buildings[2].poly)).toBeLessThanOrEqual(1.08 * area(roofs[2]));
  expect(mpArea(tryDifference(buildings[2].poly, owner).pieces)).toBeLessThanOrEqual(1e-6);
  for (let i = 0; i < buildings.length; i++) for (let j = i + 1; j < buildings.length; j++) {
    expect(mpArea(tryIntersection(buildings[i].poly, buildings[j].poly).pieces)).toBeLessThanOrEqual(1e-6);
  }
  expect(buildings.reduce((s, b) => s + area(b.poly), 0)).toBeGreaterThanOrEqual(beforeArea);
  expect(backLand.some((land) => Math.abs(area(land.outer) - area(roofs[2])) < 1e-6)).toBe(true);
  expect(result.changed).toContain(0);
});

it('reserves every new split room before a later annex relocation search', () => {
  const rect = (x0: number, y0: number, x1: number, y1: number): Polygon =>
    [p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)];
  const buildings = [
    { poly: rect(0, 0, 25, 5), parcel: 0, kind: 'house' as const },
    { poly: rect(20, 7, 23, 17), parcel: 0, kind: 'back' as const },
  ];
  let testedExtra = false;
  const result = finalizeFootprints({ buildings,
    parcels: [{ poly: rect(-1, -1, 26, 26), block: 0, use: 'plot', front: [p(0, -1), p(25, -1)] }],
    backLand: [], validateParts: () => true,
    placementClear: (candidate) => {
      const extra = buildings[2]?.poly;
      if (!extra) return false;
      const hit = tryIntersection(candidate, extra);
      if (!hit.failed && mpArea(hit.pieces) > 1) { testedExtra = true; return true; }
      return false;
    },
  });
  expect(buildings).toHaveLength(3);
  expect(testedExtra).toBe(true);
  expect(result.invalid).toContain(1);
  expect(buildings[1].poly).toEqual(rect(20, 7, 23, 17));
});
