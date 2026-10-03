import { describe, it, expect } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { makeOptions, toQuery, fromQuery, Options } from '../src/gen/options';
import { area } from '../src/gen/geo/poly';
import type { World } from '../src/gen/types';
import { expectInvariants } from './cultureCases';

// Sprawl (POLISH.md "Global settlement parameter"): for the same population, sprawl 0.5 → 1 → 2 grows the extent,
// lowers the built coverage, loosens the plots, adds gardens and spreads the faubourgs, relative to each culture's
// baseline (a medina stays denser than a European town at the same sprawl).
interface M { foot: number; cov: number; plot: number; garden: number; faub: number }
function measure(w: World): M {
  const u = w.urban!;
  const foot = u.footprintH.reduce((a, p) => a + area(p.outer), 0);
  let blockA = 0, built = 0;
  u.blockInfo.forEach((b, i) => { if (b.kind === 'block') blockA += area(u.blocks[i]); });
  for (const b of u.buildings) if (b.parcel !== undefined && u.blockInfo[u.parcels[b.parcel].block].kind === 'block') built += area(b.poly);
  const plots = u.parcels.filter((p) => p.use === 'plot');
  const garden = u.backLand.reduce((a, p) => a + area(p.outer), 0);
  return { foot, cov: built / blockA, plot: plots.reduce((a, p) => a + area(p.poly), 0) / plots.length, garden: garden / blockA, faub: Number(w.stats['urban.ha.faubourg'] ?? 0) };
}
const run = (o: Partial<Options>, s: number): World => generate(makeOptions({ ...o, sprawl: s }));

describe('sprawl', () => {
  for (const o of [{ seed: '1', size: 'town', population: 4000 }, { seed: '2', size: 'town', population: 4500, culture: 'medina' }, { seed: '3', size: 'city', population: 15000 }] as Partial<Options>[]) {
    it(`monotonic effects: ${o.culture ?? 'european-organic'} ${o.size} seed ${o.seed}`, () => {
      const ws = [0.5, 1, 2].map((s) => run(o, s));
      const m = ws.map(measure);
      for (const w of ws) expect(w.urban!.population).toBe(o.population);
      expect(m[0].foot, 'extent grows with sprawl').toBeLessThan(m[1].foot);
      expect(m[1].foot, 'extent grows with sprawl').toBeLessThan(m[2].foot);
      expect(m[0].cov, 'coverage falls with sprawl').toBeGreaterThan(m[1].cov);
      expect(m[1].cov, 'coverage falls with sprawl').toBeGreaterThan(m[2].cov);
      expect(m[0].plot, 'plots loosen').toBeLessThan(m[1].plot);
      expect(m[1].plot, 'plots loosen').toBeLessThan(m[2].plot);
      expect(m[0].garden, 'gardens').toBeLessThanOrEqual(m[1].garden + 1e-9);
      expect(m[1].garden, 'gardens').toBeLessThanOrEqual(m[2].garden + 1e-9);
      expect(m[0].faub, 'faubourgs spread').toBeLessThanOrEqual(m[2].faub);
      expectInvariants(ws[0]);
      expectInvariants(ws[2]);
    }, 300000);
  }
  it('a medina stays denser than a European town at the same sprawl', () => {
    const eo = measure(run({ seed: '1', size: 'town', population: 4000 }, 2));
    const md = measure(run({ seed: '1', size: 'town', population: 4000, culture: 'medina' }, 2));
    expect(md.foot, 'medina extent').toBeLessThan(eo.foot);
  }, 200000);
  it('camps loosen too (kraal village)', () => {
    const f = [0.5, 1, 2].map((s) => measure(run({ seed: '1', size: 'village', culture: 'kraal' }, s)).foot);
    expect(f[0]).toBeLessThan(f[1]);
    expect(f[1]).toBeLessThan(f[2]);
  }, 200000);
  it('URL round trip and default', () => {
    const o = makeOptions({ seed: '5', sprawl: 1.5 });
    expect(toQuery(o)).toContain('sprawl=1.5');
    expect(fromQuery(toQuery(o)).sprawl).toBe(1.5);
    expect(toQuery(makeOptions({ seed: '5' }))).not.toContain('sprawl');
    expect(fromQuery('seed=1&sprawl=9').sprawl).toBe(2);
  });
});
