import { describe, expect, it } from 'vitest';
import type { Polygon } from '../src/gen/types';
import { rasterizePolys } from '../src/gen/geo/raster';
import { intersectionS, mpArea } from '../src/gen/geo/bool';
import { farmGrowthReserve } from '../src/gen/landuse/rural';
import { quarterRoofCollar } from '../src/gen/urban/edgeFinish';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';

const rect = (x: number, y: number, w: number, h: number): Polygon => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];

describe('macro roof growth and farm reserve', () => {
  for (const cell of [5, 20]) it(`reserves every cell within the 16 m roof collar at ${cell} m cell size`, () => {
    const n = 400 / cell, urban = { outer: rect(100, 100, 100, 100), holes: [] };
    const base = rasterizePolys([urban.outer], n, n, cell);
    const before = base.slice(), farm = farmGrowthReserve(base, n, cell, [[urban]]);
    expect(base).toEqual(before); // the cover/field reserve remains unchanged
    const at = (x: number, y: number) => farm[Math.floor(y / cell) * n + Math.floor(x / cell)];
    for (let y = 0; y < 400; y += cell) for (let x = 0; x < 400; x += cell) {
      const cx = x + cell / 2, cy = y + cell / 2;
      const dx = Math.max(100 - cx, 0, cx - 200), dy = Math.max(100 - cy, 0, cy - 200);
      if (Math.hypot(dx, dy) <= 16.14) expect(at(cx, cy)).toBe(1);
    }
    expect(at(300, 150)).toBe(0); // an ordinary farm candidate beyond the collar remains possible
    const secondary = { outer: rect(250, 100, 50, 100), holes: [] };
    const both = farmGrowthReserve(base, n, cell, [[urban], [secondary]]);
    expect(both[Math.floor(150 / cell) * n + Math.floor(235 / cell)]).toBe(1);
    expect(both[Math.floor(150 / cell) * n + Math.floor(350 / cell)]).toBe(0);
    expect(farmGrowthReserve(base, n, cell, [])).toBe(base); // eager and fortressed plans are unchanged
  });

  it('keeps farm lots clear of a seeded open macro city growth collar', () => {
    const world = generate(makeOptions({ seed: '42', mapSize: 4000, population: 60000, coast: 'S', siteType: 'harbor', walls: 'none' }));
    expect(world.urban?.macro).toBeDefined();
    const farms = world.landuse?.farmsteads ?? [];
    expect(farms.length).toBeGreaterThan(0);
    const growth = world.urban!.footprintH.flatMap((p) => quarterRoofCollar(p.outer, 16));
    for (const farm of farms) if (farm.lot) expect(mpArea(intersectionS(farm.lot, growth))).toBeLessThan(0.01);
  }, 120_000);
});
