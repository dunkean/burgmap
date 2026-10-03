import { describe, expect, it } from 'vitest';
import { populationCulture, getCulture, resolvePlan } from '../src/gen/urban/culture';
import { PRIMITIVE_GROWTH } from '../src/gen/urban/cultures_primitive';
import { primitiveHouse } from '../src/gen/urban/primitive';
import { shapeOkObb } from '../src/gen/urban/access';
import { resolveMorph } from '../src/gen/urban/morphology';
import { Rng } from '../src/gen/core/rng';
import type { Plot } from '../src/gen/urban/plots';
import { polyInside } from '../src/gen/geo/split';
import { mpArea, intersectionS } from '../src/gen/geo/bool';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { megaQuarterDetail } from '../src/gen/urban/mega/detail';
import { checkWorld } from './urbanCheck';

describe('population-aware primitive towns', () => {
  for (const [id, growth] of Object.entries(PRIMITIVE_GROWTH)) {
    it(`${id} keeps its village, then resolves a connected urban recipe`, () => {
      const base = getCulture(id);
      expect(base.camp).toBeDefined();
      expect(populationCulture(id, growth.minPop - 1)).toBe(base);
      const city = populationCulture(id, growth.minPop);
      expect(city.camp).toBeUndefined();
      expect(city.id).toBe(id);
      expect(city.nucleus.kind).toBe('market');
      expect(resolvePlan(id, growth.minPop).phases[0].morph.id).toBe(id + '-town');
      expect(resolvePlan(id, growth.minPop).phases[0].morph.arch).toEqual(resolveMorph(base.core.morphology).arch);
      expect(populationCulture(id, 10)).toBe(base);
      expect(base.camp).toBeDefined();
    });
  }

  it('fits varied round huts, bow-sided Norse and apsidal Iroquoian houses in their own lots', () => {
    const pl = { poly: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }], front: [{ x: 0, y: 0 }, { x: 40, y: 0 }], nrm: { x: 0, y: 1 }, zone: 'core' } as Plot;
    const forms: Record<string, number> = { 'barbarian-celtic': 16, 'barbarian-norse': 14, 'native-iroquoian': 12, barbarian: 4 };
    for (const [id, count] of Object.entries(forms)) {
      const P = resolvePlan(id, 10000).phases[0].morph;
      const buildings = primitiveHouse(pl, 0.6, P, new Rng('primitive-lot'));
      expect(buildings).toEqual(primitiveHouse(pl, 0.6, P, new Rng('primitive-lot')));
      expect(buildings[0].poly.length).toBe(count);
      expect(buildings[0].arch).toBe(P.arch.typology);
      for (const b of buildings) {
        expect(polyInside(pl.poly, b.poly)).toBe(true);
        expect(shapeOkObb(b.poly)).toBe(true);
      }
      for (let i = 0; i < buildings.length; i++) for (let j = i + 1; j < buildings.length; j++) expect(mpArea(intersectionS(buildings[i].poly, buildings[j].poly))).toBeLessThanOrEqual(0.02);
      expect(primitiveHouse(pl, 0.6, P, new Rng('other-lot'))[0].poly).not.toEqual(buildings[0].poly);
    }
  });

  it('keeps longhouses wide enough to survive the shared shape filter in narrow lots', () => {
    const pl = { poly: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 30 }, { x: 0, y: 30 }], front: [{ x: 0, y: 0 }, { x: 12, y: 0 }], nrm: { x: 0, y: 1 }, zone: 'core' } as Plot;
    for (const id of ['barbarian-norse', 'native-iroquoian', 'barbarian']) {
      const P = resolvePlan(id, 10000).phases[0].morph;
      for (const seed of ['1', '2', '3', '4']) {
        const buildings = primitiveHouse(pl, 0.44, P, new Rng(seed));
        expect(buildings.length).toBeGreaterThan(0);
        for (const b of buildings) {
          expect(polyInside(pl.poly, b.poly)).toBe(true);
          expect(shapeOkObb(b.poly)).toBe(true);
        }
      }
    }
  });

  it('does not give portable Plains and steppe dwellings agricultural granaries', () => {
    const pl = { poly: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }], front: [{ x: 0, y: 0 }, { x: 40, y: 0 }], nrm: { x: 0, y: 1 }, zone: 'core' } as Plot;
    for (const id of ['native-plains', 'nomad-camp']) {
      const P = resolvePlan(id, 10000).phases[0].morph;
      for (let i = 0; i < 12; i++) {
        const buildings = primitiveHouse(pl, 0.6, P, new Rng('portable:' + i));
        expect(buildings.length).toBeGreaterThan(0);
        expect(buildings.every((b) => b.kind === 'house' && b.arch === P.arch.typology)).toBe(true);
      }
    }
  });

  for (const culture of ['barbarian-norse', 'barbarian-celtic']) {
    it(`${culture} generates one served town with cultural houses`, () => {
      const w = generate(makeOptions({ seed: '1', mapSize: 3600, population: 6000, culture, relief: 'flat', river: 'none', settlements: 'none', walls: 'single' }));
      const u = w.urban!;
      expect(u.archetype).toBe('town');
      expect(u.population).toBe(6000);
      expect(u.buildings.filter((b) => b.arch === (culture === 'barbarian-norse' ? 'longhouse' : 'roundhouse')).length).toBeGreaterThan(100);
      expect(u.buildings.filter((b) => b.arch === 'granary').length).toBeGreaterThan(0);
      expect((u.lines ?? []).some((l) => l.kind === 'palisade')).toBe(true);
      expect((u.walls ?? []).filter((wall) => wall.role === 'town')).toHaveLength(0);
      const r = checkWorld(w);
      expect(r.blockAreaErr).toBeLessThanOrEqual(0.005);
      expect(r.overlapsBlocks + r.overlapsPlots + r.overlapsBuildings).toBe(0);
      expect(r.noFrontage).toBe(0);
      expect(r.bldgOutside).toBeLessThanOrEqual(0.05);
      expect(r.orphanMain).toBe(0);
    });
  }

  it('uses independently seeded lazy quarters for a large primitive city instead of capped tribes', () => {
    const w = generate(makeOptions({ seed: '1', mapSize: 8000, population: 80000, culture: 'barbarian-norse', relief: 'flat', river: 'none', settlements: 'none' }));
    const M = w.urban!.macro!;
    expect(M).toBeDefined();
    expect(M.population).toBe(80000);
    expect(String(w.stats['settlements.warning'] ?? '').includes('plan generated for')).toBe(false);
    expect(M.morphs.every((m) => (m as { id: string }).id === 'barbarian-norse-town')).toBe(true);
    expect(M.quarters.some((q) => /cathedral|church|monastery|palace|university|shanty/.test([q.district, q.compound, ...q.wants.map((w) => w.kind)].join(' ')))).toBe(false);
    const q = M.quarters.find((q) => q.kind === 'quarter' && q.zone === 'core')!;
    const a = megaQuarterDetail(w, q.id)!;
    megaQuarterDetail(w, M.quarters.find((other) => other.kind === 'quarter' && other.id !== q.id)!.id);
    const b = megaQuarterDetail(w, q.id)!;
    expect(a.buildings.filter((building) => building.arch === 'longhouse').length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });
});
