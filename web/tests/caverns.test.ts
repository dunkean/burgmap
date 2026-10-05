import { describe, it, expect } from 'vitest';
import { generate, generateSettlementDetail } from '../src/gen/pipeline';
import { DEFAULTS } from '../src/gen/options';
import { createGrid } from '../src/gen/core/grid';
import { refreshCavernMask, generateCavernMask, cavernContains, cavernPathContains } from '../src/gen/terrain/caverns';
import { worldForRender } from '../src/ui/renderWorld';
import { renderView } from '../src/gen/settlements/merge';
import { ribbon } from '../src/gen/geo/offset';
import { megaQuarterDetail } from '../src/gen/urban/mega/detail';
import { intersectionS, tryDifference, mpArea } from '../src/gen/geo/bool';
import type { World, Options, Settlement } from '../src/gen/types';

const opts = { ...DEFAULTS, seed: 'under-17', size: 'hamlet' as const, population: 120, settlements: 'none' as const, coast: 'none' as const, river: 'stream' as const };
const normalModel = (w: World) => {
  const { stats: _, uid: _uid, terrain, options, ...rest } = w;
  const { caverns: _mask, ...baseTerrain } = terrain;
  return { ...rest, terrain: baseTerrain, options: { ...options, biome: 'underdark' } };
};
const compare = (options: Options, lazy?: boolean) => {
  const base = generate({ ...options, biome: 'underdark' }, undefined, { lazy });
  const cave = generate({ ...options, biome: 'underdark-caverns' }, undefined, { lazy });
  expect(normalModel(cave)).toEqual(normalModel(base));
  expect(cave.terrain.caverns!.solid.length).toBeGreaterThan(0);
  expect(cave.terrain.caverns!.chambers).toEqual([]);
  for (const b of cave.urban?.buildings ?? []) expect(cavernContains(cave.terrain, b.poly)).toBe(true);
  for (const r of cave.roads ?? []) expect(cavernPathContains(cave.terrain, r.path, r.width)).toBe(true);
  for (const r of cave.terrain.rivers) {
    const size = cave.mapSize;
    const visible = intersectionS(ribbon(r.path, r.width), [{ x: 0, y: 0 }, { x: size, y: 0 }, { x: size, y: size }, { x: 0, y: size }]);
    const out = tryDifference(visible, cave.terrain.caverns!.floor);
    expect(out.failed).toBe(false); expect(mpArea(out.pieces)).toBeLessThanOrEqual(0.001);
  }
  return { base, cave };
};

describe('layout-first natural cavern mask', () => {
  for (const culture of ['drow-enclave', 'duergar-hold', 'myconid-colony']) {
    it(`${culture}: changes only the display mask after exact normal Underdark generation`, () => {
      const { cave } = compare({ ...opts, culture });
      expect(cave.urban!.buildings.length).toBeGreaterThan(10);
      expect(mpArea(cave.terrain.caverns!.floor)).toBeLessThan(cave.mapSize ** 2 * 0.8);
    }, 60000);
  }
  it('keeps normal camps available without population caps or changed occupied geometry', () => {
    const { cave } = compare({ ...opts, seed: '42', population: 140, mapSize: 1800, relief: 'flat', culture: 'barbarian' });
    expect(cave.urban!.buildings.length).toBeGreaterThan(10);
  }, 60000);
  it('keeps macro plans and lazy quarter geometry exactly normal Underdark', () => {
    const { base, cave } = compare({ ...opts, seed: 'cave-macro', culture: 'duergar-hold', size: 'town', population: 2500, eagerPop: 200, mapSize: 3000, relief: 'flat', river: 'none' });
    expect(cave.urban!.macro).toBeDefined();
    const q = cave.urban!.macro!.quarters.find((q) => q.kind === 'quarter' && q.inset.length >= 3)!;
    expect(q).toBeDefined();
    const detail = megaQuarterDetail(cave, q.id)!;
    expect(detail).toEqual(megaQuarterDetail(base, q.id));
    cave.megaDetail = { [q.id]: detail };
    const oldTerrain = cave.terrain;
    refreshCavernMask(cave);
    expect(cave.terrain).not.toBe(oldTerrain);
    for (const b of detail.buildings) expect(cavernContains(cave.terrain, b.poly)).toBe(true);
  }, 90000);
  it('placed secondary villages retain exact eager/lazy normal detail and refresh their room', () => {
    const options = { ...opts, seed: 'cave-secondary', culture: 'myconid-colony', mapSize: 4000, relief: 'flat' as const, river: 'none' as const,
      settlements: { list: [{ population: 60, culture: 'duergar-hold', position: { x: 500, y: 500 } }] } };
    const { base, cave } = compare(options, true);
    const s = cave.settlements!.find((s) => !s.main)!;
    expect(s).toBeDefined();
    const detail = generateSettlementDetail(cave, s.index)!;
    expect(detail.urban).toEqual(generateSettlementDetail(base, s.index)!.urban);
    for (const b of renderView(cave).urban!.buildings) expect(cavernContains(cave.terrain, b.poly)).toBe(true);
    s.urban = detail.urban;
    refreshCavernMask(cave);
    for (const b of detail.urban.buildings) expect(cavernContains(cave.terrain, b.poly)).toBe(true);
    expect(generateCavernMask(structuredClone(worldForRender(cave)))).toEqual(cave.terrain.caverns);
  }, 90000);
  it('small disconnected placed village gains a connected visual passage without changing base roads', () => {
    const square = (x: number, y: number, r: number) => [{ x: x - r, y: y - r }, { x: x + r, y: y - r }, { x: x + r, y: y + r }, { x: x - r, y: y + r }];
    const u = { footprintH: [{ outer: square(200, 500, 45), holes: [] }], footprint: [], masses: [], backLand: [], buildings: [], parcels: [], landmarks: [], squares: [], streets: [], blocks: [], blockInfo: [], quarters: [], walls: [], phases: [], population: 100, archetype: 'hamlet', morphology: 'myconid-colony' };
    const village = { key: 'placed', index: 1, population: 40, radius: 30, center: { x: 800, y: 800 }, extent: square(800, 800, 20), detail: 'lazy' } as Settlement;
    const w = { seed: 'small-room', options: { ...opts, biome: 'underdark-caverns' }, mapSize: 1000, stats: {}, urban: u,
      terrain: { height: createGrid(100, 100, 10), water: new Uint8Array(10000), rivers: [], lakes: [], coastline: [] },
      roads: [{ path: [{ x: 0, y: 500 }, { x: 400, y: 500 }], width: 8, kind: 'major' }], settlements: [village] } as unknown as World;
    const roads = JSON.stringify(w.roads), old = w.terrain;
    refreshCavernMask(w);
    expect(w.terrain).not.toBe(old);
    expect(w.terrain.caverns!.floor).toHaveLength(1);
    expect(cavernContains(w.terrain, village.extent)).toBe(true);
    expect(mpArea(w.terrain.caverns!.floor)).toBeLessThan(1000 ** 2 * 0.25);
    expect(JSON.stringify(w.roads)).toBe(roads);
    const terrain = w.terrain;
    refreshCavernMask(w); expect(w.terrain).toBe(terrain);
    expect(generateCavernMask(w)).toEqual(w.terrain.caverns);
    const offsets = [2, 4, 6, 8, 10, 12, 28, 30, 32, 34, 36, 38].map((x) => {
      for (let y = 0; y < 50; y++) if (w.terrain.caverns!.mask[y * 100 + x]) return 500 - (y + 0.5) * 10;
      throw new Error('Road room not present');
    });
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeGreaterThan(10);
    // A large planned radius must not suppress a passage for a small real room near a road.
    village.radius = 700; village.center = { x: 350, y: 750 }; village.extent = square(350, 750, 20);
    refreshCavernMask(w);
    expect(w.terrain.caverns!.floor).toHaveLength(1);
    expect(cavernContains(w.terrain, village.extent)).toBe(true);
    expect(JSON.stringify(w.roads)).toBe(roads);
  });
  it('environment-only caves work without requesting or inventing any settlement', () => {
    const { cave } = compare({ ...opts, seed: 'cave-empty', culture: 'european-organic', workflow: 'environment', river: 'none' });
    expect(cave.urban).toBeUndefined();
    expect(cave.settlements).toBeUndefined();
    expect(mpArea(cave.terrain.caverns!.floor)).toBeGreaterThan(1000);
  }, 60000);
});
