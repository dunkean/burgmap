import { describe, expect, it } from 'vitest';
import type { Polygon, PolyH, UrbanLayer } from '../src/gen/types';
import { pointInRing } from '../src/gen/geo/poly';
import { openEdgeResidualGround } from '../src/gen/urban/openTails';

const rect = (x0: number, y0: number, x1: number, y1: number): Polygon => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];
const ph = (outer: Polygon): PolyH => ({ outer, holes: [] });
const contains = (ground: PolyH[], x: number, y: number): boolean => ground.some((p) => pointInRing(p.outer, { x, y })
  && !p.holes.some((hole) => pointInRing(hole, { x, y })));
function layer(space = rect(0, 0, 360, 160)): UrbanLayer {
  const owner = ph(rect(0, 0, 360, 160));
  return {
    footprint: [owner.outer], footprintH: [owner],
    quarters: [{ poly: owner, phase: 0, zone: 'edge', streetSpace: [ph(space)] }],
    streets: [], blocks: [], parcels: [], buildings: [], walls: [], landmarks: [], squares: [],
    phases: [], blockInfo: [], masses: [], backLand: [], archetype: 'town', population: 0, morphology: 'test',
  };
}

describe('continuous open-edge public ground', () => {
  it('varies along world coordinates within the bounded band, without using the display order', () => {
    const urban = layer(), context = { seed: 'open-ground-42' };
    const first = openEdgeResidualGround(urban, [], context);
    const second = openEdgeResidualGround(urban, [], context);
    expect(second).toEqual(first);
    const depths = [60, 90, 120, 150, 180, 210, 240, 270, 300].map((x) => {
      let deepest = 0;
      for (let y = 1; y < 50; y++) if (contains(first, x, y)) deepest = y;
      return deepest;
    });
    expect(Math.max(...depths) - Math.min(...depths)).toBeGreaterThan(3);
    expect(Math.min(...depths)).toBeGreaterThanOrEqual(17);
    expect(Math.max(...depths)).toBeLessThanOrEqual(43);
    expect(contains(first, 180, 80)).toBe(false);
  });

  it('keeps roads, water and neighbour land clear, and agrees with lazy detail on shared coordinates', () => {
    const eager = layer(), lazy = layer(rect(100, 0, 260, 160));
    const protectedGround = [ph(rect(220, 0, 245, 55))];
    const regionalRoads = [{ path: [{ x: 170, y: 0 }, { x: 170, y: 60 }], width: 8 }];
    const barriers = [ph(rect(110, 0, 135, 55))];
    eager.water = barriers; lazy.water = barriers;
    const context = { seed: 'open-ground-42', owner: eager.footprintH, protectedGround, regionalRoads, barriers };
    const full = openEdgeResidualGround(eager, [], context);
    const detail = openEdgeResidualGround(lazy, [], context);
    for (const x of [105, 125, 145, 165, 180, 195, 225, 250]) for (const y of [5, 12, 20, 28, 36, 44]) {
      expect(contains(detail, x, y), `lazy mismatch at ${x},${y}`).toBe(contains(full, x, y));
    }
    expect(contains(full, 170, 20)).toBe(false);
    expect(contains(full, 120, 20)).toBe(false);
    expect(contains(full, 230, 20)).toBe(false);
  });
});
