/**
 * Invariant: streets, roads, tracks, field ways and farm drives never run in the sea, a lake or a river except over
 * bridges (tests/waterCheck.ts); settlements are never sited on water. Coastal maps of several seeds.
 */
import { describe, it, expect } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { fromQuery } from '../src/gen/options';
import { waterViolations } from './waterCheck';

const T = 600000;
const CASES = [
  'seed=1&map=10000&coast=S', 'seed=2&map=10000&coast=W', 'seed=3&map=10000&coast=S&size=city', 'seed=4&map=10000&coast=W',
  'seed=1&coast=S&size=town', 'seed=6&coast=W&size=village',
];

describe('nothing runs in the water', () => {
  for (const q of CASES) {
    it(q, () => {
      const w = generate(fromQuery(q));
      const v = waterViolations(w);
      expect(v.samples).toEqual([]);
      // every category was actually checked
      expect((v.summary['road-major'] ?? 0) + (v.summary['road-minor'] ?? 0)).toBeGreaterThan(0);
      for (const s of w.settlements ?? []) {
        const g = w.terrain.height;
        const i = Math.floor(s.center.y / g.cell) * g.w + Math.floor(s.center.x / g.cell);
        expect(w.terrain.water[i], `settlement ${s.key} on water`).toBe(0);
      }
    }, T);
  }
});
