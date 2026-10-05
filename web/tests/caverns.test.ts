import { describe, it, expect } from 'vitest';
import { generate, generateSettlementDetail } from '../src/gen/pipeline';
import { DEFAULTS } from '../src/gen/options';
import { createGrid } from '../src/gen/core/grid';
import { refreshCavernMask, generateCavernMask, cavernContains, cavernPathContains, cavernRiverRooms, cavernRiverBankMargin } from '../src/gen/terrain/caverns';
import { Rng } from '../src/gen/core/rng';
import { worldForRender } from '../src/ui/renderWorld';
import { renderView } from '../src/gen/settlements/merge';
import { ribbon } from '../src/gen/geo/offset';
import { megaQuarterDetail } from '../src/gen/urban/mega/detail';
import { intersectionS, tryIntersection, tryDifference, mpArea } from '../src/gen/geo/bool';
import { pointInRing } from '../src/gen/geo/poly';
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
  it('varies river cavern lengths and spacing while keeping three quarters of its course tight', () => {
    const length = 7000;
    const rooms = cavernRiverRooms(new Rng('river-diversity'), length);
    expect(rooms).toEqual(cavernRiverRooms(new Rng('river-diversity'), length));
    expect(rooms).not.toEqual(cavernRiverRooms(new Rng('another-river'), length));
    const durations = rooms.map((r) => r.end - r.start);
    const gaps = [rooms[0].start, ...rooms.slice(1).map((r, i) => r.start - rooms[i].end), length - rooms[rooms.length - 1].end];
    expect(durations.reduce((a, b) => a + b, 0) / length).toBeCloseTo(0.25, 10);
    expect(Math.min(...gaps)).toBeGreaterThan(0);
    expect(Math.max(...durations) / Math.min(...durations)).toBeGreaterThan(1.3);
    expect(Math.max(...gaps) / Math.min(...gaps)).toBeGreaterThan(1.3);
    expect(Math.max(...rooms.map((r) => r.amplitude)) - Math.min(...rooms.map((r) => r.amplitude))).toBeGreaterThan(2);
    for (const room of rooms) {
      expect(cavernRiverBankMargin(rooms, room.start, 12)).toBeCloseTo(5, 10);
      expect(cavernRiverBankMargin(rooms, room.end, 12)).toBeCloseTo(5, 10);
      const peak = room.start + (room.end - room.start) * room.peak;
      expect(cavernRiverBankMargin(rooms, peak, 40)).toBeGreaterThan(cavernRiverBankMargin(rooms, peak, 4));
    }
  });
  for (const culture of ['drow-enclave', 'duergar-hold', 'myconid-colony']) {
    it(`${culture}: changes only the display mask after exact normal Underdark generation`, () => {
      const { cave } = compare({ ...opts, culture });
      expect(cave.urban!.buildings.length).toBeGreaterThan(10);
      expect(mpArea(cave.terrain.caverns!.floor)).toBeLessThan(cave.mapSize ** 2 * 0.8);
      if (culture === 'drow-enclave') {
        expect(cave.terrain.caverns!.fungalRooms!.length).toBeGreaterThan(0);
        const occupied = [
          ...cave.urban!.buildings.map((b) => b.poly),
          ...cave.roads!.map((r) => ribbon(r.path, r.width)),
          ...cave.terrain.rivers.map((r) => ribbon(r.path, r.width)),
        ];
        for (const room of cave.terrain.caverns!.fungalRooms!) {
          const outside = tryDifference(room, cave.terrain.caverns!.floor);
          expect(outside.failed).toBe(false); expect(mpArea(outside.pieces)).toBeLessThanOrEqual(0.001);
          for (const p of occupied) {
            const overlap = tryIntersection(room, p);
            expect(overlap.failed).toBe(false); expect(mpArea(overlap.pieces)).toBeLessThanOrEqual(0.001);
          }
        }
      }
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
    for (const b of renderView(w).urban!.buildings) expect(cavernContains(w.terrain, b.poly)).toBe(true);
    expect(mpArea(w.terrain.caverns!.floor)).toBeLessThan(1000 ** 2 * 0.25);
    expect(JSON.stringify(w.roads)).toBe(roads);
    const terrain = w.terrain;
    refreshCavernMask(w); expect(w.terrain).toBe(terrain);
    expect(generateCavernMask(w)).toEqual(w.terrain.caverns);
    // A large planned radius must not suppress a passage for a small real room near a road.
    village.radius = 700; village.center = { x: 350, y: 750 }; village.extent = square(350, 750, 20);
    refreshCavernMask(w);
    expect(w.terrain.caverns!.floor).toHaveLength(1);
    for (const b of renderView(w).urban!.buildings) expect(cavernContains(w.terrain, b.poly)).toBe(true);
    expect(JSON.stringify(w.roads)).toBe(roads);
  });
  it('keeps river banks mostly tight, widens major roads and replaces broad cultivation with small connected rooms', () => {
    const square = (x: number, y: number, r: number) => [{ x: x - r, y: y - r }, { x: x + r, y: y - r }, { x: x + r, y: y + r }, { x: x - r, y: y + r }];
    const roof = square(600, 650, 15);
    const u = { footprintH: [{ outer: square(600, 650, 450), holes: [] }], footprint: [], masses: [], backLand: [{ outer: square(600, 650, 450), holes: [] }], ruralReserve: [], buildings: [{ poly: roof }], parcels: [], landmarks: [], squares: [], streets: [], blocks: [], blockInfo: [], quarters: [], walls: [], phases: [], population: 100, archetype: 'hamlet', morphology: 'myconid-colony' };
    const w = { seed: 'tight-galleries', options: { ...opts, biome: 'underdark-caverns' }, mapSize: 1200, stats: {}, urban: u,
      terrain: { height: createGrid(120, 120, 10), water: new Uint8Array(14400), rivers: [{ path: [{ x: 0, y: 900 }, { x: 1200, y: 900 }], width: [10, 10] }], lakes: [], coastline: [] },
      roads: [{ path: [{ x: 0, y: 200 }, { x: 1200, y: 200 }], width: 4, kind: 'minor' }, { path: [{ x: 0, y: 400 }, { x: 1200, y: 400 }], width: 24, kind: 'major' }],
      landuse: { areas: [{ kind: 'field', cultivation: 'fungal', poly: square(1000, 650, 150) }], farmsteads: [{ lot: square(500, 650, 250), yard: square(400, 600, 20), buildings: [square(400, 600, 10)], drive: [{ x: 400, y: 600 }, { x: 400, y: 400 }], plots: [], walls: [[...square(500, 650, 250), { x: 250, y: 400 }]], trees: [] }] } } as unknown as World;
    const before = JSON.stringify({ urban: w.urban, roads: w.roads, landuse: w.landuse, rivers: w.terrain.rivers });
    refreshCavernMask(w);
    const cave = w.terrain.caverns!;
    const inside = (x: number, y: number) => cave.floor.some((p) => pointInRing(p.outer, { x, y }) && !p.holes.some((hole) => pointInRing(hole, { x, y })));
    const span = (x: number, y: number) => {
      let a = 0, b = 0;
      while (a < 100 && inside(x, y - a)) a++;
      while (b < 100 && inside(x, y + b)) b++;
      return a + b;
    };
    expect(span(600, 400)).toBeGreaterThan(span(600, 200) + 20);
    const riverSpans = Array.from({ length: 116 }, (_, i) => span(20 + i * 10, 900));
    const tight = riverSpans.filter((v) => v <= 32).length / riverSpans.length;
    expect(tight).toBeGreaterThanOrEqual(0.7); expect(tight).toBeLessThan(0.95);
    expect(Math.max(...riverSpans) - Math.min(...riverSpans)).toBeGreaterThan(20);
    expect(cave.fungalRooms!.length).toBeGreaterThan(0);
    expect(mpArea(cave.fungalRooms!)).toBeLessThan(6000);
    expect(inside(1000, 650)).toBe(true); expect(inside(1000, 750)).toBe(false);
    expect(inside(700, 700)).toBe(false);
    expect(cavernContains(w.terrain, roof)).toBe(true);
    for (const room of cave.fungalRooms!) {
      const outside = tryDifference(room, cave.floor);
      expect(outside.failed).toBe(false); expect(mpArea(outside.pieces)).toBeLessThanOrEqual(0.001);
      expect(mpArea(intersectionS(room, roof))).toBeLessThanOrEqual(0.001);
      expect(mpArea(intersectionS(room, ribbon(w.roads![1].path, 24)))).toBeLessThanOrEqual(0.001);
    }
    expect(JSON.stringify({ urban: w.urban, roads: w.roads, landuse: w.landuse, rivers: w.terrain.rivers })).toBe(before);
    expect(generateCavernMask(w)).toEqual(cave);
  });
  it('environment-only caves work without requesting or inventing any settlement', () => {
    const { cave } = compare({ ...opts, seed: 'cave-empty', culture: 'european-organic', workflow: 'environment', river: 'none' });
    expect(cave.urban).toBeUndefined();
    expect(cave.settlements).toBeUndefined();
    expect(mpArea(cave.terrain.caverns!.floor)).toBeGreaterThan(1000);
  }, 60000);
});
