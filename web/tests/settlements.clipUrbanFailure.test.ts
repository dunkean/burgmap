import { describe, expect, it, vi } from 'vitest';
import polygonClipping from '../src/vendor/polygonClipping';
import { clipUrban } from '../src/gen/settlements/urban';
import type { Polygon, UrbanLayer } from '../src/gen/types';
import { pointInRing } from '../src/gen/geo/poly';

const rect = (x: number, y: number, w: number, h: number): Polygon => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];

describe('secondary administrative clipping', () => {
  it('fails closed for painting while retaining an occupied lot if intersection throws', () => {
    const frame = { outer: rect(0, 0, 200, 100), holes: [] };
    const block = rect(85, 30, 20, 20);
    const source = {
      footprint: [frame.outer], footprintH: [frame], blocks: [block],
      blockInfo: [{ quarter: 0, phase: 0, zone: 'edge', kind: 'block' }],
      parcels: [{ poly: block, use: 'plot', block: 0 }],
      buildings: [{ poly: block, kind: 'house', parcel: 0 }],
      streets: [], quarters: [{ poly: frame, streetSpace: [frame], phase: 0, zone: 'edge' }],
      phases: [], masses: [], backLand: [], walls: [], landmarks: [], squares: [],
      archetype: 'town', population: 10, morphology: 'test',
    } as UrbanLayer;
    const before = JSON.stringify(source), stats: Record<string, number | string> = {};
    const spy = vi.spyOn(polygonClipping, 'intersection').mockImplementation(() => { throw new Error('engine failure'); });
    try {
      const clipped = clipUrban(source, rect(0, 0, 100, 100), stats);
      expect(Number(stats['clipUrban.failed'])).toBeGreaterThan(0);
      expect(clipped.buildings[0].poly).toEqual(block);
      expect(clipped.footprintH.some((p) => pointInRing(p.outer, { x: 95, y: 40 }))).toBe(true);
      expect(clipped.footprintH.some((p) => pointInRing(p.outer, { x: 150, y: 40 }))).toBe(false);
      expect(clipped.quarters.every((q) => q.streetSpace.length === 0)).toBe(true);
      expect(JSON.stringify(source)).toBe(before);
    } finally { spy.mockRestore(); }
  });
});
