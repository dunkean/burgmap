import { describe, it, expect } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { dist } from '../src/gen/core/geom';

// Fortifications are polygons of straight curtains: every wall vertex carries a tower (or is merged into the
// adjacent gate tower), every curtain between consecutive towers is one straight segment, towers are ≤ 60 m apart
// and no interior wall edge is a stub.
describe('walls — straight curtains between towers', () => {
  for (const size of ['town', 'city'] as SizeName[]) for (const seed of ['1', '2', '3', '4', '5', '6']) {
    it(`${size} seed ${seed}`, () => {
      const w = generate(makeOptions({ seed, size }));
      for (const wl of w.urban!.walls ?? []) {
        const towers = wl.towers.concat(wl.gateTowers ?? []);
        const curtains = wl.curtains ?? [];
        expect(curtains.length, 'curtains listed').toBeGreaterThan(0);
        for (const pc of wl.pieces ?? []) {
          for (let i = 1; i < pc.length - 1; i++) {
            const v = pc[i];
            expect(towers.some((t) => dist(t, v) < 8.5), 'a tower at every wall vertex').toBe(true);
            // the curtains break at every vertex: each curtain is a single straight segment
            expect(curtains.some(([a, b]) => dist(a, v) < 0.5 || dist(b, v) < 0.5), 'curtains break at vertices').toBe(true);
          }
          for (let i = 2; i < pc.length - 1; i++) expect(dist(pc[i - 1], pc[i]), 'no stub edges inside a wall piece').toBeGreaterThanOrEqual(8);
        }
        for (const [a, b] of curtains) expect(dist(a, b), 'tower spacing ≤ 60 m').toBeLessThanOrEqual(60);
      }
    });
  }
});
