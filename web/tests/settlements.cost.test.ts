/**
 * Regression: the bounded travel-cost field of secondary settlements (settlements/urban.ts `boundedCost`) compared
 * float64 offers with float32-rounded stored costs, so every path whose cost differed below the float32 ulp re-pushed
 * its cell: a combinatorial heap blow-up ("RangeError: Invalid array length", seed=2&map=20000&coast=S&size=city).
 */
import { describe, it, expect } from 'vitest';
import { boundedCost } from '../src/gen/settlements/urban';
import { createGrid, D8_DIST } from '../src/gen/core/grid';
import { dijkstra } from '../src/gen/site/site';
import type { World } from '../src/gen/types';

function fakeWorld(n: number, cell: number): World {
  const height = createGrid(n, n, cell);
  // gentle rolling plain (a few meters of relief), as on the coastal plain of the crashing map
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) height.data[y * n + x] = 8 + 1.5 * Math.sin(x * 0.07) * Math.cos(y * 0.05) + 0.3 * Math.sin((x + 2 * y) * 0.31);
  const water = new Uint8Array(n * n);
  // the sea on the south side
  for (let y = Math.floor(n * 0.85); y < n; y++) for (let x = 0; x < n; x++) water[y * n + x] = 1;
  const z = new Uint8Array(n * n);
  const terrain = { height, water } as unknown as World['terrain'];
  return { seed: 't', options: {} as World['options'], mapSize: n * cell, terrain, stats: {}, site: { fields: { riverMask: z, bridgeZone: z } } } as unknown as World;
}

describe('bounded settlement cost field', () => {
  it('stays bounded on rolling land and equals a float64 Dijkstra', () => {
    const n = 768, cell = 20000 / n;
    const w = fakeWorld(n, cell);
    const start = { x: 18303, y: 14000 }, limit = 3459;
    const t0 = performance.now();
    const g = boundedCost(w, start, limit);
    expect(performance.now() - t0).toBeLessThan(5000);
    const H = w.terrain.height.data, water = w.terrain.water;
    const s0 = Math.floor(start.y / cell) * n + Math.floor(start.x / cell);
    const ref = dijkstra(n, n, s0, (c, m, dd) => {
      if (water[m]) return Infinity;
      const gr = Math.abs(H[m] - H[c]) / (dd * cell);
      return dd * cell * (1 + 100 * gr * gr);
    });
    let finite = 0, bad = 0, err = 0;
    for (let i = 0; i < n * n; i++) {
      const v = g.data[i];
      if (ref[i] > limit) { if (v !== Infinity) bad++; continue; }
      finite++;
      err = Math.max(err, Math.abs(v - ref[i]));
    }
    expect(bad).toBe(0);
    expect(err).toBeLessThan(1e-2);
    expect(finite).toBeGreaterThan(1000);
    // a second search reuses the scratch buffer: same result
    const g2 = boundedCost(w, start, limit);
    expect(Array.from(g2.data)).toEqual(Array.from(g.data));
  });
});
