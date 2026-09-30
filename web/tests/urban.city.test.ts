import { describe, it, expect } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { makeOptions, Culture } from '../src/gen/options';
import { checkWorld } from './urbanCheck';

// URBAN_GEOMETRY.md §6 invariants on seeds 1–6 × {european-organic, bastide} for size 'city'.
const cultures: Culture[] = ['european-organic', 'bastide'];
const SIZE: string = 'city';
// timing assertions only on a quiet machine: BURGMAP_PERF=1 npx vitest run tests/urban.city.test.ts
const PERF = process.env.BURGMAP_PERF === '1';
describe('urban invariants — city', () => {
  for (const culture of cultures) for (const seed of ['1', '2', '3', '4', '5', '6']) {
    it(`${culture} seed ${seed}`, () => {
      const w = generate(makeOptions({ seed, size: 'city', culture }));
      const r = checkWorld(w);
      const msg = r.details.slice(0, 8).join('\n');
      expect(r.blocks, 'has blocks').toBeGreaterThan(0);
      expect(r.blockAreaErr, 'blocks = plots + back land (±0.5 %)\n' + msg).toBeLessThanOrEqual(0.005);
      expect(r.blockOutside, 'blocks inside their quarter\n' + msg).toBeLessThan(1);
      expect(r.overlapsBlocks, 'no block overlaps').toBe(0);
      expect(r.overlapsPlots, 'no parcel overlaps\n' + msg).toBe(0);
      expect(r.overlapsBuildings, 'building overlaps\n' + msg).toBeLessThanOrEqual(Math.ceil(r.buildings * 0.0005));
      expect(r.noFrontage, 'every plot has ≥ 3 m of street frontage\n' + msg).toBe(0);
      expect(r.bldgOutside, 'buildings inside their plot\n' + msg).toBe(0);
      // known weak spot: rare acute tips / slivers (≤ 1 % of all shapes)
      expect(r.acute + r.thin, 'acute (<12°) or thin (<2 m) shapes\n' + msg).toBeLessThanOrEqual(Math.max(2, Math.ceil(0.01 * (r.plots + r.buildings))));
      expect(r.orphanMain, 'main streets connect to the radials').toBe(0);
      if (PERF && SIZE === 'town') expect(Number(w.stats['ms.urban']), 'town urban stages < 1.5 s').toBeLessThan(1500);
      if (PERF && SIZE === 'city') expect(Number(w.stats['ms.urban']), 'city urban stages < 5 s').toBeLessThan(5000);
    });
  }
});
