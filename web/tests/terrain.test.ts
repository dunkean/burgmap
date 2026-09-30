import { describe, it, expect } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { renderSvg } from '../src/render/svg';
import { makeOptions, Relief, CoastOpt, RiverOpt } from '../src/gen/options';

const base = { size: 'village' as const };

describe('determinism', () => {
  it('same seed -> identical SVG; different seed differs', () => {
    const o = makeOptions({ ...base, seed: 'det', relief: 'hills', coast: 'S', river: 'river' });
    const a = renderSvg(generate(o)), b = renderSvg(generate(o));
    expect(a).toBe(b);
    const c = renderSvg(generate({ ...o, seed: 'det2' }));
    expect(c).not.toBe(a);
  });
});

describe('hydrology invariants', () => {
  const cases: [Relief, CoastOpt, RiverOpt][] = [['hills', 'S', 'river'], ['valley', 'none', 'major'], ['mountains', 'none', 'stream'], ['flat', 'E', 'river'], ['hills', 'N', 'none']];
  for (const [relief, coast, river] of cases) {
    it(`${relief}/${coast}/${river}: every cell drains to an outlet; rivers on land`, () => {
      const w = generate(makeOptions({ ...base, seed: '7', relief, coast, river }));
      const t = w.terrain;
      const n = t.height.w;
      // every cell reaches an outlet (receiver -1) without cycles; outlets are edge or sea cells
      let bad = 0, bad2 = 0;
      for (let i = 0; i < n * n; i++) {
        let c = i, steps = 0;
        while (t.receiver[c] >= 0 && steps++ <= n * n) c = t.receiver[c];
        const x = c % n, y = (c / n) | 0;
        const isEdge = x === 0 || y === 0 || x === n - 1 || y === n - 1;
        if (steps > n * n || !(isEdge || t.water[c] === 1)) bad++;
        // filled surface never below terrain, and non-increasing downstream
        if (t.filled[i] < t.height.data[i] - 1e-4) bad2++;
        const r = t.receiver[i];
        if (r >= 0 && t.filled[r] > t.filled[i] + 1e-4) bad2++;
      }
      expect(bad).toBe(0);
      expect(bad2).toBe(0);
      if (river !== 'none') expect(t.rivers.some((r) => r.main)).toBe(true);
      // river vertices are on non-sea cells except near the mouth (last 12%)
      for (const r of t.rivers) {
        const lim = Math.floor(r.path.length * 0.88);
        for (let i = 0; i < lim; i++) {
          const p = r.path[i];
          const cx = Math.floor(p.x / t.height.cell), cy = Math.floor(p.y / t.height.cell);
          if (cx < 0 || cy < 0 || cx >= n || cy >= n) continue;
          expect(t.water[cy * n + cx]).not.toBe(1);
        }
        // widths per vertex, positive
        expect(r.width.length).toBe(r.path.length);
        for (const wd of r.width) expect(wd).toBeGreaterThan(0);
      }
    });
  }

  it('main river widens downstream', () => {
    const w = generate(makeOptions({ ...base, seed: '3', relief: 'hills', coast: 'S', river: 'river' }));
    const m = w.terrain.rivers.find((r) => r.main)!;
    const k = Math.floor(m.width.length / 4);
    const up = m.width.slice(0, k).reduce((a, b) => a + b, 0) / k;
    const down = m.width.slice(-k).reduce((a, b) => a + b, 0) / k;
    expect(down).toBeGreaterThan(up);
  });

  it('sea fraction is in a sensible range when a coast is requested', () => {
    for (const seed of ['1', '2', '3', '4']) {
      const w = generate(makeOptions({ ...base, seed, coast: 'random', river: 'none' }));
      expect(w.terrain.seaFraction).toBeGreaterThan(0.1);
      expect(w.terrain.seaFraction).toBeLessThan(0.42);
    }
  });
});
