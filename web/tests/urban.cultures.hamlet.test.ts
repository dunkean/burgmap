import { describe, it } from 'vitest';
import { CULTURE_CASES, SEEDS, generateCase, expectInvariants } from './cultureCases';

// URBAN_GEOMETRY.md §6 invariants on every culture preset and mix, size 'hamlet', seeds 1–4.
describe('culture invariants — hamlet', () => {
  for (const c of CULTURE_CASES) for (const seed of SEEDS) {
    it(`${c.label} seed ${seed}`, () => expectInvariants(generateCase(c, 'hamlet', seed)));
  }
});
