import { describe, it, expect } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { coverage } from './coverage';

// Burgage-cycle density (built area / block area, area-weighted per phase): oldest phase 85–95 %, second 70–85 %,
// younger 50–70 %; faubourgs 35–60 % near the gate (≤ 150 m) and fading further out (rows → gaps → scattered
// houses → fields). No matchsticks: every footprint ≥ 4.5 m wide and aspect ≤ 4.
describe('urban density per phase', () => {
  for (const size of ['town', 'city'] as SizeName[]) for (const seed of ['1', '2', '3', '4', '5', '6']) {
    it(`${size} seed ${seed}`, () => {
      const r = coverage(generate(makeOptions({ seed, size })));
      for (const [id, v] of r.byPhase) {
        if (v.zone === 'faubourg') continue;
        const c = v.built / v.area;
        const [lo, hi] = v.zone === 'faubourg' ? [0.35, 0.55] : id === 1 ? [0.85, 0.95] : id === 2 ? [0.7, 0.85] : [0.5, 0.7];
        expect(c, `phase ${id} (${v.zone}) coverage`).toBeGreaterThanOrEqual(lo);
        expect(c, `phase ${id} (${v.zone}) coverage`).toBeLessThanOrEqual(hi);
      }
      if (!Number.isNaN(r.faubNear)) {
        expect(r.faubNear, 'faubourg coverage near the gate').toBeGreaterThanOrEqual(0.35);
        expect(r.faubNear, 'faubourg coverage near the gate').toBeLessThanOrEqual(0.6);
        if (!Number.isNaN(r.faubFar)) expect(r.faubFar, 'the faubourg fades out').toBeLessThan(r.faubNear);
      }
      expect(r.narrow, 'footprints narrower than 4.5 m').toBe(0);
      expect(r.long, 'footprints with aspect > 4').toBe(0);
    });
  }
});
