import { expect, it } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { megaQuarterDetail } from '../src/gen/urban/mega/detail';
import { quarterRoofCollar } from '../src/gen/urban/edgeFinish';
import { bboxOf } from '../src/gen/geo/poly';
import { tryDifference, tryIntersection, mpArea } from '../src/gen/geo/bool';

it('keeps whole exterior houses without order dependence or cross-quarter claims', () => {
  const world = generate(makeOptions({ seed: '42', size: 'town', population: 9000, eagerPop: 1,
    mapSize: 4000, walls: 'none', settlements: 'none', river: 'none', coast: 'none' }));
  const host = JSON.stringify(world.urban), M = world.urban!.macro!;
  const a = megaQuarterDetail(world, 2)!, b = megaQuarterDetail(world, 3)!;
  expect(a.buildings.length).toBeGreaterThan(0);
  expect(b.buildings.length).toBeGreaterThan(0);
  let extension = 0;
  for (const [id, detail] of [[2, a], [3, b]] as const) {
    const owner = M.quarters.find(q => q.id === id)!;
    const limit = quarterRoofCollar(owner.pts, 16);
    for (const roof of detail.buildings) {
      const outside = tryDifference(roof.poly, owner.pts), escaped = tryDifference(roof.poly, limit);
      expect(outside.failed || escaped.failed).toBe(false);
      extension += mpArea(outside.pieces);
      expect(mpArea(escaped.pieces)).toBeLessThan(0.01);
    }
  }
  expect(extension, 'exercises a real whole-roof extension on free dry land').toBeGreaterThan(10);
  const boxes = b.buildings.map(roof => bboxOf(roof.poly));
  for (const left of a.buildings) {
    const box = bboxOf(left.poly);
    b.buildings.forEach((right, i) => {
      const other = boxes[i];
      if (box.x0 >= other.x1 || box.x1 <= other.x0 || box.y0 >= other.y1 || box.y1 <= other.y0) return;
      const overlap = tryIntersection(left.poly, right.poly);
      expect(overlap.failed).toBe(false);
      expect(mpArea(overlap.pieces)).toBeLessThan(0.01);
    });
  }
  const reversed = structuredClone(world);
  expect(megaQuarterDetail(reversed, 3)).toEqual(b);
  expect(megaQuarterDetail(reversed, 2)).toEqual(a);
  expect(JSON.stringify(world.urban)).toBe(host);
  expect(JSON.stringify(reversed.urban)).toBe(host);
}, 180000);
