import { describe, expect, it } from 'vitest';
import { biomeLandKind, type BiomeGround } from '../src/gen/biomes';
import { Rng } from '../src/gen/core/rng';
import type { Polygon } from '../src/gen/core/geom';
import { area, pointInRing } from '../src/gen/geo/poly';
import { mpArea, tryDifference, tryIntersection } from '../src/gen/geo/bool';
import { insetConvex } from '../src/gen/geo/offset';
import { FARM_SIZES, farmType, frameOf, layoutFarm, placeFarm, type FarmContext, type FarmType } from '../src/gen/landuse/farms';
import { generate } from '../src/gen/pipeline';
import { fromQuery, makeOptions, toQuery } from '../src/gen/options';
import type { World } from '../src/gen/types';
import { buildOn } from '../src/gen/urban/bops';
import { COMPOUND_BUILDERS } from '../src/gen/urban/compounds';
import { CULTURES, getCulture } from '../src/gen/urban/culture';
import { MORPHOLOGIES, resolveMorph } from '../src/gen/urban/morphology';
import type { Plot } from '../src/gen/urban/plots';

const cultures = ['drow-enclave', 'duergar-hold', 'myconid-colony'] as const;
const legacyPresets = (): string => JSON.stringify([CULTURES, MORPHOLOGIES].map(registry =>
  Object.fromEntries(Object.entries(registry).filter(([id]) => !(cultures as readonly string[]).includes(id)))));
const originalLegacyPresets = legacyPresets();
const ground: BiomeGround = { water: 100, hab: 5, slope: 0.03, soil: 0, settlement: 80, arableRadius: 700 };
const rectangle = (x: number, y: number, w: number, h: number): Polygon => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];
const contains = (owner: Polygon, roof: Polygon): void => {
  const out = tryDifference(roof, owner);
  expect(out.failed, JSON.stringify({ owner, roof })).toBe(false);
  expect(mpArea(out.pieces)).toBeLessThan(1e-6);
};
const clear = (a: Polygon, b: Polygon): void => {
  const hit = tryIntersection(a, b);
  expect(hit.failed).toBe(false);
  expect(mpArea(hit.pieces)).toBeLessThan(1e-6);
};
const worldWithoutStats = (w: World): unknown => {
  const { stats: _, ...rest } = w;
  return rest;
};

describe('Underdark land and cultivation', () => {
  it('round-trips the additive biome and three culture IDs without changing old links', () => {
    for (const culture of cultures) {
      const round = fromQuery(toQuery(makeOptions({ culture, biome: 'underdark' })));
      expect(round.culture).toBe(culture);
      expect(round.biome).toBe('underdark');
      expect(getCulture(culture).id).toBe(culture);
    }
    expect(fromQuery('seed=42').biome).toBeUndefined();
    expect(getCulture('dwarven').core.morphology).toBe('dwarven');
    expect(resolveMorph('duergar-hold').buildingOp).toBe('duergarHall');
    expect(resolveMorph('dwarven').buildingOp).toBe('hall');
  });

  it('permits fungal beds only near accessible, sufficiently dry settlement ground', () => {
    for (const k of ['field', 'garden', 'orchard'] as const) {
      expect(biomeLandKind(k, 'underdark', ground)).toBe('garden');
      for (const patch of [{ settlement: 800 }, { slope: 0.2 }, { water: 700 }]) {
        expect(biomeLandKind(k, 'underdark', { ...ground, ...patch })).toBe('commons');
      }
    }
    expect(biomeLandKind('marsh', 'underdark', ground)).toBe('marsh');
    for (const k of ['forest', 'meadow', 'pasture'] as const) expect(biomeLandKind(k, 'underdark', ground)).toBe('commons');
  });

  it('keeps environment-only cavern cover uncultivated, rocky and deterministic', () => {
    const o = makeOptions({ seed: '42', workflow: 'environment', biome: 'underdark', mapSize: 1600, river: 'river', relief: 'flat' });
    const w = generate(o);
    expect(w.urban).toBeUndefined();
    expect(w.site).toBeUndefined();
    expect(w.landuse!.farmsteads).toEqual([]);
    expect(w.landuse!.areas.length).toBeGreaterThan(0);
    for (const a of w.landuse!.areas) {
      expect(['commons', 'marsh']).toContain(a.kind);
      expect(a.cultivation).toBeUndefined();
    }
    expect(worldWithoutStats(generate(o))).toEqual(worldWithoutStats(w));
  });

  for (const type of ['fungal-farm', 'spore-farm'] as FarmType[]) for (const size of FARM_SIZES) {
    it(`${type}/${size} retains a partitioned accessible farm without trees or surface crops`, () => {
      const c: FarmContext = { biome: 'underdark', culture: type === 'spore-farm' ? 'myconid-colony' : 'duergar-hold',
        soil: 0.7, slope: 0.06, downhill: null, wet: 0.4, exposed: 0.8, market: 0.1, west: 0.2 };
      const f = frameOf({ x: 0, y: 1 }, null);
      const local = layoutFarm(type, size, c, f, new Rng('fungal-' + type + size));
      expect(local).toEqual(layoutFarm(type, size, c, f, new Rng('fungal-' + type + size)));
      expect(farmType(c, size, new Rng('farm-type'))).toBe(type);
      const placed = placeFarm(local, type, { x: 100, y: 50 }, { x: 0, y: 1 });
      expect(placed.parts.length).toBeGreaterThan(0);
      expect(placed.trees).toEqual([]);
      expect(local.tags).toContain('fungal-cultivation');
      const partition = placed.plots.filter(p => p.kind === 'farmyard' || p.kind === 'garden');
      expect(partition.reduce((s, p) => s + area(p.poly), 0)).toBeCloseTo(area(placed.lot), 8);
      partition.forEach((p, i) => { contains(placed.lot, p.poly); for (let j = 0; j < i; j++) clear(p.poly, partition[j].poly); });
      for (const p of placed.plots) expect(['farmyard', 'garden', 'pond', 'platform']).toContain(p.kind);
      const dx = placed.entry.x - placed.gate.x, dy = placed.entry.y - placed.gate.y, l = Math.hypot(dx, dy);
      const lane = [placed.gate, placed.entry, { x: placed.entry.x - 0.05 * dy / l, y: placed.entry.y + 0.05 * dx / l },
        { x: placed.gate.x - 0.05 * dy / l, y: placed.gate.y + 0.05 * dx / l }];
      placed.parts.forEach((p, i) => {
        contains(placed.lot, p.poly);
        expect(p.material).toBe(type === 'spore-farm' ? 'fungal' : 'dark-stone');
        expect(['granary', 'barn', 'byre', 'stable']).not.toContain(p.use);
        for (let j = 0; j < i; j++) clear(p.poly, placed.parts[j].poly);
        if (!p.passage) clear(p.poly, lane);
      });
      expect(pointInRing(placed.yard, placed.entry)).toBe(true);
    });
  }
});

describe('Underdark geometric recipes', () => {
  it('resolves the exact seed42 duergar shared-edge witness with a checked roof subset', () => {
    const owner: Polygon = [{ x: 828.7151290932054, y: 811.4233517024113 }, { x: 843.7, y: 799.798 },
      { x: 865.696, y: 828.15 }, { x: 850.2945087793058, y: 840.0983406985175 }];
    const roof: Polygon = [{ x: 840.0299297152667, y: 810.5482966625983 }, { x: 832.5323113821705, y: 816.3648826663558 },
      { x: 829.2466205604715, y: 812.1296051812911 }, { x: 829.1263469135051, y: 811.9697838354763 },
      { x: 836.6216464680541, y: 806.1549967196114 }];
    expect(tryDifference(roof, owner).failed).toBe(true);
    const candidate = insetConvex(roof, 0.02);
    expect(candidate.length).toBeGreaterThanOrEqual(4);
    expect(area(candidate) / area(roof)).toBeGreaterThan(0.98);
    contains(roof, candidate);
    contains(owner, candidate);
  });

  for (const culture of cultures) it(`${culture} builds owned footprints with its own architecture`, () => {
    const poly = rectangle(0, 0, 32, 45);
    const plot = (): Plot => ({ poly, block: 0, zone: 'core', front: [poly[0], poly[1]], nrm: { x: 0, y: 1 },
      sideA: { p: poly[0], d: { x: 0, y: 1 } }, sideB: { p: poly[1], d: { x: 0, y: 1 } },
      rank: 1, depth: 45, wide: true, sideFronts: [], run: 0, order: 0 });
    const P = resolveMorph(culture);
    const b = buildOn(plot(), 0.7, P, new Rng('build-' + culture));
    expect(b.length).toBeGreaterThan(0);
    expect(b).toEqual(buildOn(plot(), 0.7, P, new Rng('build-' + culture)));
    b.forEach((r, i) => {
      contains(poly, r.poly);
      expect(r.arch).toMatch(culture === 'drow-enclave' ? /^drow-/ : culture === 'duergar-hold' ? /^duergar-/ : /^fungal-/);
      for (let j = 0; j < i; j++) if (r.kind !== 'garden' && b[j].kind !== 'garden') clear(r.poly, b[j].poly);
    });
  });

  for (const builder of ['drow-sanctum', 'duergar-smeltery', 'myconid-circle']) it(`${builder} retains its whole compound and contains its footprints`, () => {
    for (const lot of [rectangle(0, 0, 70, 60), [{ x: 0, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 30 },
      { x: 30, y: 30 }, { x: 30, y: 60 }, { x: 0, y: 60 }]]) {
      const build = () => COMPOUND_BUILDERS[builder](lot, { angle: 0.4, pop: 500, center: { x: 20, y: 20 }, rng: new Rng(builder) });
      const result = build();
      expect(result).toEqual(build());
      expect(result.parcels).toHaveLength(1);
      expect(result.parcels[0].poly).toEqual(lot);
      expect(result.buildings.length).toBeGreaterThan(0);
      expect(result.water).toEqual([]);
      expect(result.trees ?? []).toEqual([]);
      result.buildings.forEach((b, i) => { contains(lot, b.poly); for (let j = 0; j < i; j++) clear(b.poly, result.buildings[j].poly); });
      result.landmarks.forEach(l => contains(lot, l.poly));
    }
  });

  for (const culture of cultures) it(`${culture} generates a deterministic dry hamlet without outdoor vegetation`, () => {
    const o = makeOptions({ seed: '42', size: 'hamlet', population: 140, culture, biome: 'underdark', relief: 'flat',
      coast: 'none', river: 'none', settlements: 'none', mapSize: 1800, roads: 2 });
    const w = generate(o);
    expect(worldWithoutStats(generate(o))).toEqual(worldWithoutStats(w));
    expect(legacyPresets()).toBe(originalLegacyPresets);
    expect(w.urban!.culture).toBe(culture);
    expect(w.urban!.buildings.length).toBeGreaterThan(0);
    expect(w.urban!.trees ?? []).toEqual([]);
    expect(getCulture(culture).waterBuild).toBeUndefined();
    w.urban!.buildings.forEach(b => {
      expect(b.parcel).toBeDefined();
      const owner = w.urban!.parcels[b.parcel!];
      contains(owner.poly, b.poly);
      for (const p of b.poly) {
        const grid = w.terrain.height;
        const i = Math.floor(p.y / grid.cell) * grid.w + Math.floor(p.x / grid.cell);
        expect(w.terrain.water[i]).toBe(0);
      }
    });
    for (const a of w.landuse!.areas) {
      expect(['commons', 'garden', 'marsh']).toContain(a.kind);
      if (a.kind === 'garden') expect(a.cultivation).toBe('fungal');
    }
    for (const f of w.landuse!.farmsteads) {
      expect(['fungal-farm', 'spore-farm']).toContain(f.type);
      expect(f.cultivation).toBe('fungal');
      expect(f.trees ?? []).toEqual([]);
    }
  });
});
