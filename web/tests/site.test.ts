import { describe, it, expect } from 'vitest';
import { Rng } from '../src/gen/core/rng';
import { makeOptions, SIZE_PRESETS, Relief, CoastOpt } from '../src/gen/options';
import { generateTerrain } from '../src/gen/terrain/hydrology';
import { chooseSite, RESERVE_RADIUS } from '../src/gen/site/site';
import { nearestOn } from '../src/gen/core/pline';
import { dist } from '../src/gen/core/geom';

const CFG: [Relief, CoastOpt][] = [['hills', 'none'], ['valley', 'random'], ['flat', 'random'], ['mountains', 'none']];

describe('site archetypes (seeds 1-20 x terrain configs)', () => {
  it('center is dry, inside the 20% margin, and its archetype feature is at hand', () => {
    const bad: string[] = [];
    const seen = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) for (const [relief, coast] of CFG) {
      const o = makeOptions({ seed: String(seed), relief, coast, size: 'town' });
      const root = new Rng('magna-urbis:' + o.seed);
      const { terrain: t } = generateTerrain(o, root);
      const S = SIZE_PRESETS.town.mapSize;
      const s = chooseSite(t, o, S, root);
      const tag = `[${seed} ${relief} ${coast}] ${s.archetype}`;
      seen.add(s.archetype);
      const c = s.center, n = t.height.w, cell = t.height.cell;
      if (c.x < 0.2 * S - 1 || c.x > 0.8 * S + 1 || c.y < 0.2 * S - 1 || c.y > 0.8 * S + 1) bad.push(tag + ' margin');
      if (t.water[Math.floor(c.y / cell) * n + Math.floor(c.x / cell)] !== 0) bad.push(tag + ' wet center');
      const R = RESERVE_RADIUS.town, front = 0.3 * R + 45 + 12;
      const rivDist = Math.min(...t.rivers.filter((r) => Math.max(...r.width) >= 4.5).map((r) => nearestOn(r.path, c).d), Infinity);
      if (['bridge', 'estuary'].includes(s.archetype)) {
        if (!s.crossing) bad.push(tag + ' no crossing');
        else if (dist(c, s.crossing) > front + 20) bad.push(tag + ' crossing far ' + Math.round(dist(c, s.crossing)));
        if (rivDist > front) bad.push(tag + ' not fronting river ' + Math.round(rivDist));
      }
      if (s.archetype === 'estuary' && (!s.harbor || dist(c, s.harbor) > front)) bad.push(tag + ' no quay');
      if (s.archetype === 'harbor') {
        const hd = Math.min(160, 60 + 0.08 * R) + cell * 2;
        if (!s.harbor || dist(c, s.harbor) > hd) bad.push(tag + ' harbor far');
      }
      if (s.archetype === 'confluence' && rivDist > 0 && Math.min(...t.rivers.map((r) => nearestOn(r.path, c).d)) > 0.35 * R + 90) bad.push(tag + ' not at rivers');
      if (s.feature && ['bridge', 'confluence', 'valley', 'estuary'].includes(s.archetype) && dist(c, s.feature) > 0.3 * R + 260) bad.push(tag + ' feature far');
    }
    expect(seen.size).toBeGreaterThanOrEqual(3);
    expect(bad, bad.slice(0, 10).join('\n')).toEqual([]);
  }, 600000);

  it('siteType forces an available archetype; sitePrefs weights steer the choice', () => {
    const o = makeOptions({ seed: '3', relief: 'flat', coast: 'none', size: 'town', siteType: 'plain' });
    const root = new Rng('magna-urbis:' + o.seed);
    const { terrain: t } = generateTerrain(o, root);
    expect(chooseSite(t, o, 2400, root).archetype).toBe('plain');
    const o2 = { ...o, siteType: 'auto' as const, sitePrefs: { weights: { bridge: 0, plain: 50 } } };
    expect(chooseSite(t, o2, 2400, new Rng('magna-urbis:3')).archetype).toBe('plain');
  }, 120000);
});
