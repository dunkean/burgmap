import { describe, expect, it } from 'vitest';
import type { Polygon, Vec2 } from '../src/gen/types';
import fixture from './fixtures/urban-small-plot-v11.json';
import { area, inscribed, isSimple, minAngle, obb } from '../src/gen/geo/poly';
import { isConvex, polyInside } from '../src/gen/geo/split';
import { mpArea, tryDifference } from '../src/gen/geo/bool';
import { reconstructSmallPlotRoom } from '../src/gen/urban/smallPlotRoom';

describe('compact crop of real bent plots from xrv97g', () => {
  for (const record of fixture.houses) {
    it(`finds an ordinary habitable room in native plot ${record.id} without mutating geometry`, () => {
      const poly = record.poly as Polygon, owner = record.owner as Polygon, front = record.front as [Vec2, Vec2];
      const before = JSON.stringify(record);
      let physicalChecks = 0, accessChecks = 0;
      const solve = () => reconstructSmallPlotRoom(poly, owner, front, [],
        () => { physicalChecks++; return true; },
        () => { accessChecks++; return true; });
      const room = solve();
      expect(room).not.toBeNull();
      expect(solve()).toEqual(room);
      expect(JSON.stringify(record)).toBe(before);
      expect(room!.length).toBeGreaterThanOrEqual(4);
      expect(room!.length).toBeLessThanOrEqual(6);
      expect(isSimple(room!)).toBe(true);
      expect(isConvex(room!, 1e-3)).toBe(true);
      expect(minAngle(room!)).toBeGreaterThanOrEqual(Math.PI / 3);
      expect(area(room!)).toBeGreaterThanOrEqual(12);
      expect(area(room!)).toBeLessThanOrEqual(0.85 * area(poly));
      expect(2 * inscribed(room!, [], 0.05).r).toBeGreaterThanOrEqual(3.2);
      const box = obb(room!);
      expect(2 * Math.min(box.hu, box.hv)).toBeGreaterThanOrEqual(3.2);
      expect(Math.max(box.hu, box.hv) / Math.min(box.hu, box.hv)).toBeLessThanOrEqual(2.2);
      expect(polyInside(owner, room!)).toBe(true);
      expect(mpArea(tryDifference(room!, owner).pieces)).toBeLessThan(1e-6);
      expect(physicalChecks).toBeGreaterThan(0);
      expect(accessChecks).toBeGreaterThan(0);
    }, 30_000);
  }

  it('fails closed when physical clearance or peer access rejects every candidate', () => {
    const { poly, owner, front } = fixture.houses[0];
    expect(reconstructSmallPlotRoom(poly, owner, front as [Vec2, Vec2], [], () => false, () => true)).toBeNull();
    expect(reconstructSmallPlotRoom(poly, owner, front as [Vec2, Vec2], [], () => true, () => false)).toBeNull();
    expect(reconstructSmallPlotRoom(poly, owner, front as [Vec2, Vec2], [owner], () => true, () => true)).toBeNull();
  }, 30_000);
});
