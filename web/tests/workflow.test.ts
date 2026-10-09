import { describe, expect, it } from 'vitest';
import { generate, generateSettlementDetail } from '../src/gen/pipeline';
import { Rng } from '../src/gen/core/rng';
import { mpArea } from '../src/gen/geo/bool';
import { pointInRing, area } from '../src/gen/geo/poly';
import { polyInside } from '../src/gen/geo/split';
import { generateRural } from '../src/gen/landuse/rural';
import { generateUrban } from '../src/gen/urban';
import { unreachableBuildings } from './accessCheck';
import {
  fromQuery, generationUid, makeOptions, optionsForSettlement, settlementListFromString,
  settlementListToString, toQuery, type SettlementSpec,
} from '../src/gen/options';
import { RESERVE_RADIUS } from '../src/gen/site/site';

describe('generation workflow URL', () => {
  it('keeps old links exact and round-trips main-inclusive lists and the general theme', () => {
    expect(toQuery(makeOptions())).toBe('seed=1');
    expect(toQuery(makeOptions({ seed: 'x', settlements: { list: [{ population: 300 }] } }))).toBe('seed=x&settl=L300');
    const list: SettlementSpec[] = [
      { population: 20000, culture: 'elven', options: { walls: 'none', cultureMix: null, plan: null, sprawl: 1.3 } },
      { population: 300, culture: 'barbarian', siteType: 'hilltop', position: { x: 4200, y: 3100 },
        options: { moat: 'no', castle: 'yes', roads: 3, language: 'auto' } },
    ];
    const options = makeOptions({ seed: 'forest', mapSize: 8000, culture: 'european-organic', walls: 'single',
      sitePrefs: { weights: { hilltop: 2 }, waterSide: 'N' }, workflow: 'list', settlements: { list } });
    const query = toQuery(options);
    const loaded = fromQuery(query);
    expect(loaded.workflow).toBe('list');
    expect(loaded.culture).toBe('european-organic');
    expect(loaded.sitePrefs).toEqual(options.sitePrefs);
    expect(settlementListToString((loaded.settlements as { list: SettlementSpec[] }).list)).toBe(settlementListToString(list));
    expect(toQuery(loaded)).toBe(query);
    expect(new URLSearchParams(query).get('uid')).toBe(generationUid(options));
    expect(generationUid({ ...options, style: 'atlas', labels: false, legend: true, contours: false, landuse: false })).toBe(generationUid(options));
    expect(generationUid(fromQuery(query + '&pins=1%2C2%2Cnote&view=3%2C4%2C2&uid=forged'))).toBe(generationUid(options));
    const edited = { ...options, biome: 'temperate' as const, moat: 'auto' as const, sprawl: 1, cultureMix: null, plan: null };
    expect(generationUid(edited)).toBe(generationUid(fromQuery(toQuery(edited))));
    expect(new URLSearchParams(toQuery(edited)).get('uid')).toBe(generationUid(fromQuery(toQuery(edited))));
  });

  it('preserves a dormant settlement draft in an environment link and bounds decoded data', () => {
    const options = makeOptions({ workflow: 'environment', settlementMode: 'automatic', seed: '7', biome: 'forest', mapSize: 4000,
      settlements: { list: [{ population: 20000 }, { population: 250, culture: 'barbarian' }] } });
    const query = toQuery(options);
    const loaded = fromQuery(query);
    expect(loaded.settlements).toEqual(options.settlements);
    expect(loaded.settlementMode).toBe('automatic');
    expect(new URLSearchParams(query).get('compose')).toBe('a');
    expect(toQuery(loaded)).toBe(query);
    expect(generationUid({ ...options, culture: 'elven', settlements: 'auto' })).toBe(generationUid(options));
    expect(generationUid({ ...options, settlementMode: 'list' })).toBe(generationUid(options));
    const automatic = { ...options, workflow: 'automatic' as const };
    expect(generationUid(automatic)).toBe(generationUid({ ...automatic, settlements: 'auto' as const }));
    expect(settlementListFromString(JSON.stringify([[999999999, 'unknown', 'bad', -5, 999999, [null, null, 'bad', null, null, 'yes']]])))
      .toEqual([{ population: 5000000, position: { x: 0, y: 40000 }, options: { castle: 'yes' } }]);
  });
});

describe('generation workflow output', () => {
  it('keeps automatic companions subordinate to the main settlement on custom maps', () => {
    const options = makeOptions({ seed: 'regional-budget', mapSize: 8000, size: 'village', population: 300, settlements: 'auto' });
    const legacy = generate(options);
    const automatic = generate({ ...options, workflow: 'automatic' });
    for (const world of [legacy, automatic]) {
      const main = world.settlements![0];
      const companions = world.settlements!.slice(1);
      expect(companions.length).toBeGreaterThan(0);
      expect(companions.every((s) => s.population < main.population)).toBe(true);
      expect(companions.reduce((sum, s) => sum + s.population, 0)).toBeLessThanOrEqual(main.population);
    }
    expect(automatic.settlements!.slice(1).map((s) => [s.key, s.population, s.center]))
      .toEqual(legacy.settlements!.slice(1).map((s) => [s.key, s.population, s.center]));
    expect(legacy.landuse!.areas.some((a) => a.kind === 'field')).toBe(true);
    for (const road of legacy.roads ?? []) for (let i = 1; i < road.path.length; i++) {
      const a = road.path[i - 1], b = road.path[i];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      expect(legacy.landuse!.areas.some((land) => ['field', 'orchard', 'garden'].includes(land.kind)
        && pointInRing(land.poly, mid) && !(land.holes ?? []).some((hole) => pointInRing(hole, mid)))).toBe(false);
    }
  });

  it('builds a small elven mountain settlement on coarse terrain without a broad forest reserve', () => {
    const options = makeOptions({ seed: '1', mapSize: 40000, size: 'hamlet', population: 40,
      relief: 'mountains', biome: 'forest', culture: 'elven', center: { x: 3359.375, y: 33776.04166666667 }, settlements: 'none' });
    const world = generate(options);
    for (const population of [40, 50, 60]) {
      const urban = population === 40 ? world.urban! : generateUrban({ ...world, options: { ...options, population },
        bridges: [...(world.bridges ?? [])] }, new Rng('magna-urbis:1')).layer;
      expect(urban.population).toBe(population);
      expect(urban.buildings.length, `${population} inhabitants have houses`).toBeGreaterThan(0);
      expect(urban.footprintH.length).toBeGreaterThan(0);
      expect(mpArea(urban.footprintH)).toBeGreaterThan(1000);
      expect(mpArea(urban.footprintH)).toBeLessThan(30000);
      for (const building of urban.buildings) if (building.parcel !== undefined) {
        expect(polyInside(urban.parcels[building.parcel].poly, building.poly)).toBe(true);
      }
      expect(unreachableBuildings({ ...world, urban }).n).toBe(0);
    }
    expect(world.landuse?.areas.some((a) => a.kind === 'forest')).toBe(true);
    expect(world.landuse!.reserve.reduce((sum, poly) => sum + area(poly), 0)).toBeLessThan(50000);

    const coverAt = (x: number, y: number) => world.landuse!.areas.find((a) =>
      pointInRing(a.poly, { x, y }) && !(a.holes ?? []).some((hole) => pointInRing(hole, { x, y })))?.kind;
    let woodedVerge = 0;
    let woodedApproach = 0;
    for (const road of world.roads ?? []) for (let i = 1; i < road.path.length; i++) {
      const a = road.path[i - 1], b = road.path[i];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length < 20) continue;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const nx = -(b.y - a.y) / length, ny = (b.x - a.x) / length;
      for (const side of [-1, 1]) {
        const far = { x: mx + side * nx * 110, y: my + side * ny * 110 };
        const near = { x: mx + side * nx * 30, y: my + side * ny * 30 };
        if (coverAt(far.x, far.y) !== 'forest') continue;
        woodedApproach++;
        if (coverAt(near.x, near.y) === 'forest') woodedVerge++;
        // One generated land polygon is used by SVG and Canvas, so this cut keeps both
        // a tree crown and the physical road casing clear without the 52 m cell mask.
        const insideClearance = road.width / 2 + 4;
        const roadEdge = { x: mx + side * nx * insideClearance, y: my + side * ny * insideClearance };
        expect(coverAt(roadEdge.x, roadEdge.y)).toBeUndefined();
        expect(['field', 'orchard', 'garden'].includes(coverAt(near.x, near.y) ?? '')).toBe(false);
      }
    }
    expect(woodedApproach).toBeGreaterThan(0);
    expect(woodedVerge).toBeGreaterThan(0);

    const empty = { ...world, urban: { ...world.urban!, buildings: [] } };
    const uncultivated = generateRural(empty, new Rng('magna-urbis:1'));
    expect(uncultivated.layer.reserve).toEqual([]);
    expect(uncultivated.layer.farmsteads).toEqual([]);
  });

  it('keeps the planned reserve of a real macro settlement before its quarters are detailed', () => {
    const world = generate(makeOptions({ seed: 'macro-reserve', mapSize: 10000, size: 'capital', population: 41000,
      relief: 'flat', river: 'none', settlements: 'none' }));
    expect(world.urban?.buildings).toHaveLength(0);
    expect(world.urban?.macro?.quarters.length).toBeGreaterThan(0);
    expect(world.urban?.footprintH.length).toBeGreaterThan(0);
    expect(world.landuse?.reserve.length).toBeGreaterThan(0);
    expect(world.landuse!.reserve.reduce((sum, poly) => sum + area(poly), 0)).toBeGreaterThan(10000);
  });

  it('generates an undeveloped landscape with natural cover only', () => {
    const world = generate(makeOptions({ seed: 'forest-env', workflow: 'environment', size: 'hamlet', biome: 'forest', river: 'none' }));
    expect(world.uid).toBeTruthy();
    expect(world.site).toBeUndefined();
    expect(world.roads).toBeUndefined();
    expect(world.urban).toBeUndefined();
    expect(world.settlements).toBeUndefined();
    expect(world.landuse?.farmsteads).toEqual([]);
    expect(world.landuse?.areas.length).toBeGreaterThan(0);
    expect(world.landuse?.areas.every((area) => ['forest', 'meadow', 'pasture', 'commons', 'marsh'].includes(area.kind))).toBe(true);
  });

  it('inherits the general theme independently of the first instance and matches eager/lazy secondary detail', () => {
    const list: SettlementSpec[] = [
      { population: 1000, culture: 'european-organic', options: { size: 'city', walls: 'none', moat: 'no' }, position: { x: 1800, y: 1800 } },
      { population: 250, culture: 'barbarian', options: { activities: 'no', language: 'german' }, position: { x: 5100, y: 5100 } },
    ];
    const theme = makeOptions({ seed: 'theme-inheritance', workflow: 'list', mapSize: 7000, relief: 'flat', river: 'none',
      culture: 'elven', walls: 'single', moat: 'yes', language: 'auto', settlements: { list } });
    expect(optionsForSettlement(theme, list[0]).walls).toBe('none');
    expect(optionsForSettlement(theme, list[1]).walls).toBe('single');
    expect(optionsForSettlement(theme, list[1]).culture).toBe('barbarian');
    expect(optionsForSettlement({ ...theme, cultureMix: { id: 'dwarven', t: 0.4, mode: 'blend' } }, list[0]).cultureMix).toBeUndefined();
    const eager = generate(theme, undefined, { lazy: false });
    const lazy = generate(theme, undefined, { lazy: true });
    expect(eager.options.culture).toBe('elven');
    expect(eager.options.walls).toBe('single');
    expect(eager.site?.reserveRadius).toBe(RESERVE_RADIUS.city);
    expect(eager.settlements?.[0].culture).toBe('european-organic');
    expect(eager.settlements?.[1].culture).toBe('barbarian');
    expect(eager.settlements?.[1].options).toEqual(list[1].options);
    expect(eager.settlements?.[1].urban).toBeDefined();
    expect(lazy.settlements?.[1].urban).toBeUndefined();
    expect(generateSettlementDetail(lazy, 1)?.urban).toEqual(eager.settlements?.[1].urban);
    const secondary = eager.settlements![1];
    const empty = { ...eager, settlements: eager.settlements!.map((s) => s.index === secondary.index
      ? { ...s, urban: { ...s.urban!, buildings: [] } } : s) };
    const uncultivated = generateRural(empty, new Rng('magna-urbis:' + eager.seed));
    expect(uncultivated.layer.reserve.some((ring) => pointInRing(ring, secondary.center))).toBe(false);
  });
});
