import { describe, it } from 'vitest';
import { CULTURE_CASES, SEEDS, generateCase, expectInvariants, expectSignature } from './cultureCases';

// URBAN_GEOMETRY.md §6 invariants and the plan signatures of every culture preset and mix, size 'city', seeds 1–4.
describe('culture invariants — city', () => {
  for (const c of CULTURE_CASES) for (const seed of SEEDS) {
    it(`${c.label} seed ${seed}`, () => {
      const w = generateCase(c, 'city', seed);
      expectInvariants(w);
      expectSignature(c, w);
    });
  }
});
