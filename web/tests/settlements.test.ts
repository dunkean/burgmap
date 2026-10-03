/** M3c: settlement system (REGION_SETTLEMENTS.md). */
import { describe, it, expect, beforeAll } from 'vitest';
import { generate, generateSettlementDetail } from '../src/gen/pipeline';
import { makeOptions, toQuery, fromQuery, settlementsToString, Options } from '../src/gen/options';
import type { World } from '../src/gen/types';
import { unreachable, overlaps, spacingViolations } from './settlementCheck';

const T = 600000;
const summary = (w: World) => (w.settlements ?? []).map((s) => ({ key: s.key, pop: s.population, cls: s.cls, culture: s.culture, x: Math.round(s.center.x * 10) / 10, y: Math.round(s.center.y * 10) / 10, name: s.name }));

describe('settlement options', () => {
  it('round-trip in the URL', () => {
    const cases: Partial<Options>[] = [
      { mapSize: 12500, population: 4800000, settlements: 'none' },
      { mapSize: 600, population: 10, settlements: { counts: { city: 0, town: 1, village: 7, hamlet: 3, farmstead: 12 } } },
      { mapSize: 40000, settlements: { list: [{ population: 300 }, { population: 2500, culture: 'dwarven', siteType: 'hilltop', position: { x: 1200, y: 3400 } }, { population: 40, culture: 'elven' }] } },
      { seed: 'x', size: 'city' },
    ];
    for (const c of cases) {
      const o = makeOptions(c);
      const back = fromQuery(toQuery(o));
      expect(back.mapSize).toBe(o.mapSize);
      expect(back.population).toBe(o.population);
      expect(settlementsToString(back.settlements)).toBe(settlementsToString(o.settlements));
      expect(toQuery(back)).toBe(toQuery(o));
    }
    // the default map writes nothing new in its link
    expect(toQuery(makeOptions({}))).toBe('seed=1');
  });
});

describe('settlement system (6 km, counts)', () => {
  const opts = makeOptions({ seed: '4', mapSize: 6000, population: 1500, relief: 'hills', settlements: { counts: { city: 0, town: 0, village: 2, hamlet: 3, farmstead: 4 } } });
  let w: World;
  beforeAll(() => { w = generate(opts); }, T);

  it('honours the counts', () => {
    const S = w.settlements!;
    expect(S[0].main).toBe(true);
    expect(S.filter((s) => s.cls === 'village').length).toBe(2);
    expect(S.filter((s) => s.cls === 'hamlet').length).toBe(3);
    expect(S.filter((s) => s.cls === 'farmstead').length).toBe(4);
    expect(w.stats['settlements.warning'] ?? '').not.toMatch(/could not be placed/);
  });
  it('every settlement is reachable by road', () => {
    expect(w.stats['network.unreachable']).toBe(0);
    expect(unreachable(w)).toEqual([]);
  });
  it('extents do not overlap', () => {
    expect(overlaps(w)).toEqual([]);
  });
  it('central-place spacing is respected', () => {
    const relaxed = /spacing relaxed/.test(String(w.stats['settlements.warning'] ?? ''));
    expect(spacingViolations(w, relaxed ? 0.48 : 1)).toEqual([]);
  });
  it('villages and hamlets have plans; farmsteads sit in their fields', () => {
    for (const s of w.settlements!) {
      if (s.cls === 'village' || s.cls === 'hamlet') expect(s.urban?.buildings.length ?? 0).toBeGreaterThan(0);
    }
    const farms = w.landuse!.farmsteads;
    for (const s of w.settlements!.filter((x) => x.detail === 'farmstead')) {
      expect(farms.some((f) => Math.hypot(f.pos.x - s.center.x, f.pos.y - s.center.y) < 80)).toBe(true);
    }
    // each village has fields around it
    for (const s of w.settlements!.filter((x) => x.cls === 'village')) {
      const near = w.landuse!.areas.filter((a) => a.kind === 'field' && a.poly.some((p) => Math.hypot(p.x - s.center.x, p.y - s.center.y) < 1200));
      expect(near.length).toBeGreaterThan(0);
    }
  });
  it('is deterministic, and lazy detail equals eager generation', () => {
    const w2 = generate(opts, undefined, { lazy: true });
    expect(JSON.stringify(summary(w2))).toBe(JSON.stringify(summary(w)));
    expect(JSON.stringify(w2.roads)).toBe(JSON.stringify(w.roads));
    const k = w.settlements!.findIndex((s) => s.cls === 'village');
    expect(w2.settlements![k].urban).toBeUndefined();
    const d = generateSettlementDetail(w2, k)!;
    expect(JSON.stringify(d.urban)).toBe(JSON.stringify(w.settlements![k].urban));
  }, T);
});

describe('settlement list', () => {
  it('honours cultures and positions; adding a settlement leaves the others unchanged', () => {
    const list = [{ population: 400, culture: 'dwarven' }, { population: 90, position: { x: 1000, y: 1100 } }, { population: 250, culture: 'medina' }];
    const base = { seed: '6', mapSize: 6000, population: 1200, relief: 'mountains' as const };
    const a = generate(makeOptions({ ...base, settlements: { list } }));
    const b = generate(makeOptions({ ...base, settlements: { list: [...list, { population: 150, culture: 'elven' }] } }));
    const sa = a.settlements!, sb = b.settlements!;
    expect(sa.length).toBe(4);
    expect(sa[1].culture).toBe('dwarven');
    expect(sa[3].culture).toBe('medina');
    expect(Math.hypot(sa[2].center.x - 1000, sa[2].center.y - 1100)).toBeLessThan(30);
    expect(sb.length).toBe(5);
    expect(JSON.stringify(summary(b).slice(0, 4))).toBe(JSON.stringify(summary(a)));
    expect(JSON.stringify(b.urban)).toBe(JSON.stringify(a.urban));
    expect(unreachable(b)).toEqual([]);
  }, T);

  it('warns when the land cannot hold the requested settlements', () => {
    const w = generate(makeOptions({ seed: '2', mapSize: 2000, population: 300, settlements: { counts: { city: 0, town: 2, village: 12, hamlet: 0, farmstead: 0 } } }));
    expect(String(w.stats['settlements.warning'] ?? '')).toMatch(/could not be placed|relaxed/);
    expect(overlaps(w)).toEqual([]);
  }, T);
});

describe('legacy maps', () => {
  it('the main settlement of a preset map does not depend on the secondary settlements', () => {
    const a = generate(makeOptions({ seed: '3', size: 'village' }));
    const b = generate(makeOptions({ seed: '3', size: 'village', settlements: 'none' }));
    expect(JSON.stringify(a.urban)).toBe(JSON.stringify(b.urban));
    expect(a.mapSize).toBe(1600);
    expect(b.settlements!.length).toBe(1);
  }, T);
});
