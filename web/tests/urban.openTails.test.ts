import { describe, expect, it } from 'vitest';
import type { Polygon } from '../src/gen/core/geom';
import type { UrbanLayer } from '../src/gen/types';
import { classifyStreetTails, openTailGround, servedStreetPath } from '../src/gen/urban/openTails';
import { pointInRing } from '../src/gen/geo/poly';

const rect = (x0: number, y0: number, x1: number, y1: number): Polygon => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];
const base = (): UrbanLayer => ({
  footprintH: [{ outer: rect(0, 0, 100, 100), holes: [] }],
  streets: [{ path: [{ x: 40, y: 50 }, { x: 100, y: 50 }], width: 6, kind: 'street', rank: 3, role: 'street', phase: 0 }],
  parcels: [{ poly: rect(76, 52, 84, 65), use: 'plot', block: 0, front: [{ x: 76, y: 53 }, { x: 84, y: 53 }] }],
  buildings: [{ poly: rect(77, 55, 83, 62), kind: 'house', parcel: 0 }],
  quarters: [{ poly: { outer: rect(0, 0, 100, 100), holes: [] }, phase: 0, zone: 'edge', streetSpace: [{ outer: rect(0, 0, 100, 100), holes: [] }] }],
  squares: [],
} as unknown as UrbanLayer);

describe('open street tails', () => {
  it('trims the visible axis after the last occupied frontage without changing the plot path', () => {
    const urban = base();
    const tails = classifyStreetTails(urban);
    expect(tails).toHaveLength(1);
    expect(tails[0].kind).toBe('unservedOpenEdge');
    urban.openTails = tails;
    const visible = servedStreetPath(urban, 0);
    expect(visible[visible.length - 1].x).toBeGreaterThan(83);
    expect(visible[visible.length - 1].x).toBeLessThan(95);
    expect(urban.streets[0].path[1].x).toBe(100);
  });

  it('does not count an empty plot or a near miss as a road connection', () => {
    const urban = base();
    urban.buildings = [];
    const tails = classifyStreetTails(urban, { regionalRoads: [{ path: [{ x: 101, y: 60 }, { x: 120, y: 60 }], width: 6 }] });
    expect(tails[0].kind).toBe('unservedOpenEdge');
    expect(tails[0].excess).toBe(60);
  });

  it('preserves a regional crossing and a real junction at the terminal point', () => {
    const urban = base();
    const road = [{ path: [{ x: 80, y: 50 }, { x: 120, y: 50 }], width: 6 }];
    expect(classifyStreetTails(urban, { regionalRoads: road })[0].kind).toBe('regionalContinuation');
    urban.streets.push({ path: [{ x: 100, y: 30 }, { x: 100, y: 70 }], width: 5, kind: 'street', rank: 2, role: 'street', phase: 0 });
    expect(classifyStreetTails(urban)[0].kind).toBe('urbanJunction');
  });

  it('uses only the actual settlement exterior, and masks protected public ground', () => {
    const urban = base();
    urban.streets[0].path = [{ x: 40, y: 40 }, { x: 50, y: 40 }];
    expect(classifyStreetTails(urban)).toHaveLength(0);
    urban.streets[0].path = [{ x: 40, y: 50 }, { x: 100, y: 50 }];
    const tails = classifyStreetTails(urban);
    const ground = openTailGround(urban, tails, { protectedGround: [{ outer: rect(85, 45, 95, 55), holes: [] }] });
    expect(ground.length).toBeGreaterThan(0);
    expect(ground.some((ph) => pointInRing(ph.outer, { x: 90, y: 50 })
      && !ph.holes.some((hole) => pointInRing(hole, { x: 90, y: 50 })))).toBe(false);
  });
});
