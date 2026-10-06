import { describe, expect, it } from 'vitest';
import type { Polygon } from '../src/gen/core/geom';
import { area, minNeck } from '../src/gen/geo/poly';
import { finalizeFootprints } from '../src/gen/urban/footprintFinal';
import { splitLong } from '../src/gen/urban/access';

const rect = (x0: number, y0: number, x1: number, y1: number): Polygon => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

describe('last footprint pass', () => {
  it('keeps a plausible triangular dwelling byte for byte', () => {
    const triangle: Polygon = [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 4.5, y: 8 }];
    const source = JSON.stringify(triangle);
    const u = { buildings: [{ poly: triangle, kind: 'house', parcel: 0 }], parcels: [{ poly: rect(-1, -1, 10, 9), use: 'plot', block: 2 }], backLand: [] };
    const result = finalizeFootprints(u);
    expect(JSON.stringify(u.buildings[0].poly)).toBe(source);
    expect(result.invalid).toEqual([]);
    expect(result.changed.size).toBe(0);
    expect(minNeck(triangle)).toBeNull();
  });

  it('releases the narrow arm of an L as accounted open land', () => {
    const l: Polygon = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 2 },
      { x: 8, y: 2 }, { x: 8, y: 9 }, { x: 0, y: 9 }];
    const u = { buildings: [{ poly: l, kind: 'house', parcel: 0 }], parcels: [{ poly: rect(-1, -1, 13, 10), use: 'plot', block: 5 }], backLand: [] as { outer: Polygon; holes: Polygon[] }[] };
    const initial = area(l);
    const result = finalizeFootprints(u);
    expect(result.invalid).toEqual([]);
    expect(result.changed.has(5)).toBe(true);
    expect(u.buildings).toHaveLength(1);
    expect(u.backLand).toHaveLength(1);
    expect(area(u.buildings[0].poly) + area(u.backLand[0].outer)).toBeCloseTo(initial, 6);
    expect(minNeck(u.buildings[0].poly)?.w ?? Infinity).toBeGreaterThanOrEqual(3.6);
  });

  it('truncates only a disproportionate house tip inside its owner parcel', () => {
    const needle: Polygon = [{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 10 }, { x: 0, y: 10 }, { x: -40, y: 5 }];
    const u = { buildings: [{ poly: needle, kind: 'house', parcel: 0 }],
      parcels: [{ poly: rect(-41, -1, 25, 11), use: 'plot', block: 4 }], backLand: [] as { outer: Polygon; holes: Polygon[] }[] };
    const result = finalizeFootprints(u);
    expect(result.changed.has(4)).toBe(true);
    expect(u.buildings).toHaveLength(1);
    expect(u.backLand).toHaveLength(1);
    expect(area(u.buildings[0].poly) + area(u.backLand[0].outer)).toBeCloseTo(area(needle), 6);
    expect(area(u.backLand[0].outer)).toBeLessThan(0.03 * area(needle));
  });

  it('removes exact duplicate and retraced vertices without losing area at 20 km', () => {
    const p: Polygon = [{ x: 20000, y: 20000 }, { x: 20008, y: 20000 }, { x: 20008, y: 20000 },
      { x: 20008, y: 20006 }, { x: 20004, y: 20006 }, { x: 20004, y: 20008 },
      { x: 20004, y: 20006 }, { x: 20000, y: 20006 }];
    const u = { buildings: [{ poly: p, kind: 'house', parcel: 0 }], parcels: [{ poly: rect(19999, 19999, 20009, 20009), use: 'plot', block: 7 }], backLand: [] };
    const initial = area(p);
    const result = finalizeFootprints(u);
    expect(result.cleaned).toBe(1);
    expect(area(u.buildings[0].poly)).toBeCloseTo(initial, 6);
    expect(u.buildings[0].poly.length).toBeLessThan(p.length);
  });

  it('keeps useful splitLong pieces when a small fragment fails', () => {
    const tapered: Polygon = [{ x: 0, y: 0 }, { x: 21, y: 0 }, { x: 21, y: 1 }, { x: 18, y: 5 }, { x: 0, y: 5 }];
    const parts = splitLong([{ poly: tapered, kind: 'house' }]);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.reduce((sum, p) => sum + area(p.poly), 0)).toBeGreaterThanOrEqual(0.7 * area(tapered));
  });

  it('preserves a 2.4 m courtyard room chosen by its cultural builder', () => {
    const room = rect(0, 0, 12, 2.4);
    const u = { buildings: [{ poly: room, kind: 'house', arch: 'persian-courtyard-house', parcel: 0,
      courtyards: [rect(4, 0.2, 8, 1.8)] }],
    parcels: [{ poly: rect(-1, -1, 13, 4), use: 'plot', block: 9 }], backLand: [] };
    const before = JSON.stringify(u.buildings[0]);
    expect(finalizeFootprints(u).invalid).toEqual([]);
    expect(JSON.stringify(u.buildings[0])).toBe(before);
  });
});
