import { describe, it, expect } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { makeOptions, Options } from '../src/gen/options';
import { unreachableBuildings } from './accessCheck';
import { coverage } from './coverage';

// Every building is reachable: it touches a street or place, or open ground of its block (yard, court, gateway,
// shared side passage ≥ ~1.5 m) connected to one. No matchsticks among dwellings (width ≥ 4.5 m, aspect ≤ 3).
const CASES: Partial<Options>[] = [
  { seed: '1', size: 'town' }, { seed: '2', size: 'town' }, { seed: '3', size: 'city' },
  { seed: '1', size: 'town', culture: 'medina' }, { seed: '1', size: 'town', culture: 'chinese' },
  { seed: '1', size: 'town', culture: 'japanese-jokamachi' }, { seed: '1', size: 'town', culture: 'roman-core' },
  { seed: '1', size: 'town', culture: 'indian-temple' }, { seed: '1', size: 'town', culture: 'bastide' },
];
describe('every building is reachable', () => {
  for (const o of CASES) {
    it(`${o.culture ?? 'european-organic'} ${o.size} seed ${o.seed}`, () => {
      const w = generate(makeOptions(o));
      const a = unreachableBuildings(w);
      expect(a.total, 'has buildings').toBeGreaterThan(100);
      expect(a.n, `unreachable buildings near ${JSON.stringify(a.where.slice(0, 3))}`).toBe(0);
      const c = coverage(w, new Set(['church', 'cathedral', 'landmark', 'hut']));
      expect(c.narrow, 'footprints narrower than 4.5 m').toBe(0);
      expect(c.long, 'footprints with aspect > 3').toBe(0);
    });
  }
});
