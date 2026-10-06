import { describe, expect, it } from 'vitest';
import { benchLayout, benchParcels, benchBuildings, type BenchOptions } from '../src/gen/urban/testbench';
import { benchMorph, benchRecipes, BENCH_PRESETS, validateBenchParams } from '../src/gen/urban/testbenchConfig';
import { getCulture } from '../src/gen/urban/culture';
import { area, isSimple, interiorAngle } from '../src/gen/geo/poly';
import { intersectionS, mpArea, differenceS } from '../src/gen/geo/bool';
import { LAB_WATER } from '../src/gen/urban/streets';

const options: BenchOptions = { culture: 'european-organic', recipe: 'core', zone: 'core', density: 1, count: 4, radius: 160, placement: 'rectangle', monument: 'none' };

describe('isolated native generation bench', () => {
  it('scales micro dimensions up to fivefold without changing shape families or overlapping fixtures', () => {
    const micro: BenchOptions = { ...options, mode: 'micro' };
    const base = benchLayout(micro, '42');
    expect(benchLayout({ ...micro, microScale: 1 }, '42').blocks).toEqual(base.blocks);
    for (const scale of [2.5, 5]) {
      const enlarged = benchLayout({ ...micro, microScale: scale }, '42');
      expect(enlarged.shapeNames).toEqual(base.shapeNames);
      enlarged.blocks.forEach((block, i) => {
        expect(isSimple(block.poly)).toBe(true);
        expect(area(block.poly) / area(base.blocks[i].poly)).toBeCloseTo(scale * scale, 8);
        block.poly.forEach((p, j) => {
          const original = base.blocks[i].poly[j];
          expect(p.x).toBeCloseTo(320 + (original.x - 320) * scale, 8);
          expect(p.y).toBeCloseTo(420 + (original.y - 420) * scale, 8);
        });
        for (let j = 0; j < i; j++) expect(mpArea(intersectionS(block.poly, enlarged.blocks[j].poly))).toBeLessThan(0.001);
      });
      const parcels = benchParcels(enlarged, '42');
      expect(parcels.plots.length).toBeGreaterThan(0);
      expect(benchBuildings(enlarged, parcels, '42').buildings.length).toBeGreaterThan(0);
    }
  });

  it('keeps ten diverse micro shapes intact and isolates shape, parcel and house seeds', () => {
    const micro: BenchOptions = { ...options, mode: 'micro' };
    const layout = benchLayout(micro, '42');
    expect(layout.blocks).toHaveLength(10);
    expect(new Set(layout.shapeNames).size).toBe(10);
    expect(benchLayout(micro, '42').blocks).toEqual(layout.blocks);
    expect(benchLayout(micro, '43').blocks).not.toEqual(layout.blocks);
    // Regional settings cannot deform or remove the diversity preset.
    expect(benchLayout({ ...micro, count: 8, rings: 2, relief: 'hill', river: 'vertical', monument: 'church' }, '42').blocks).toEqual(layout.blocks);
    for (const block of layout.blocks) {
      expect(isSimple(block.poly)).toBe(true);
      expect(area(block.poly)).toBeGreaterThan(100);
    }
    expect(layout.blocks.some(b => b.poly.length > 10)).toBe(true);
    expect(layout.blocks.some(b => b.poly.some((_, i) => interiorAngle(b.poly, i) > Math.PI))).toBe(true);
    expect(layout.blocks.some(b => b.poly.some((_, i) => interiorAngle(b.poly, i) < Math.PI / 4))).toBe(true);
    const before = JSON.stringify(layout.blocks);
    const partition = benchParcels(layout, '42');
    expect(new Set(partition.plots.map(p => p.plot.block)).size).toBe(10);
    const frozen = JSON.stringify(partition);
    for (const preset of ['morph/european-organic', 'morph/medina', 'morph/chinese']) {
      const houses = benchBuildings(layout, partition, '42', { ...micro, stages: { buildings: { preset } } });
      expect(houses.buildings.length).toBeGreaterThan(0);
      expect(JSON.stringify(partition)).toBe(frozen);
    }
    expect(benchParcels(layout, '43').parcels).not.toEqual(partition.parcels);
    expect(JSON.stringify(layout.blocks)).toBe(before);
  });

  it('cuts parcels without buildings and retains the exact partition across house variants and seeds', () => {
    const layout = benchLayout(options, '42');
    const partition = benchParcels(layout, '42');
    const before = JSON.stringify(partition), streets = JSON.stringify(layout.streets.list), blocks = JSON.stringify(layout.blocks);
    expect(partition.plots.length).toBeGreaterThan(10);
    const rows = benchBuildings(layout, partition, '42');
    const courts = benchBuildings(layout, partition, 'other', { ...options, stages: { buildings: { preset: 'morph/medina' } } });
    expect(rows.buildings.length).toBeGreaterThan(0);
    expect(courts.buildings.length).toBeGreaterThan(0);
    expect(courts.buildings).not.toEqual(rows.buildings);
    expect(rows.parcels).toBe(partition.parcels);
    expect(courts.parcels).toBe(partition.parcels);
    expect(JSON.stringify(partition)).toBe(before);
    expect(JSON.stringify(layout.streets.list)).toBe(streets);
    expect(JSON.stringify(layout.blocks)).toBe(blocks);
    expect(benchBuildings(layout, partition, '42')).toEqual(rows);
    for (const b of rows.buildings) expect(mpArea(differenceS(b.poly, partition.parcels[b.parcel!].poly))).toBeLessThan(0.05);
  });

  it('varies native plot methods without changing roads or blocks and includes back land', () => {
    const layout = benchLayout(options, '42'), before = JSON.stringify(layout.streets.list);
    const strips = benchParcels(layout, '42');
    const courts = benchParcels(layout, '42', { ...options, stages: { plots: { preset: 'morph/medina' } } });
    expect(courts.parcels).not.toEqual(strips.parcels);
    expect(JSON.stringify(layout.streets.list)).toBe(before);
    const gardens = benchParcels(layout, '42', { ...options, stages: { plots: { params: { plotOp: 'garden' } } } });
    expect(gardens.plots).toHaveLength(0);
    expect(gardens.parcels.some(p => p.use === 'garden')).toBe(true);
    for (const block of layout.blocks) {
      const bi = layout.blocks.indexOf(block);
      const sum = strips.parcels.filter(p => p.block === bi).reduce((s, p) => s + area(p.poly), 0);
      expect(Math.abs(sum - area(block.poly)) / area(block.poly)).toBeLessThan(0.005);
    }
  });

  it('offers every cultural phase/sector recipe and applies preset parameters before explicit overrides', () => {
    expect(benchRecipes(getCulture('japanese-jokamachi')).some(r => r.id === 'ring')).toBe(true);
    expect(BENCH_PRESETS['morph/medina-souk']).toBeDefined();
    for (const [preset, entry] of Object.entries(BENCH_PRESETS)) {
      expect(benchMorph({ ...options, stages: { plots: { preset } } }, 'plots').plotOp, entry.label).toBeTruthy();
    }
    const P = benchMorph({ ...options, culture: 'chinese', stages: { buildings: { preset: 'morph/medina', params: { buildingOp: 'hall', coverage: { core: [0.3, 0.4] } } } } }, 'buildings');
    expect(P.buildingOp).toBe('hall'); expect(P.arch.material).toBe('mud'); expect(P.coverage.core).toEqual([0.3, 0.4]);
    expect(() => validateBenchParams('plots', { growth: {} })).toThrow('n’est pas utilisé');
    expect(() => validateBenchParams('streets', { gridSpacing: [0, 20] })).toThrow();
    expect(() => validateBenchParams('buildings', { buildingOp: 'fake' })).toThrow();
    expect(() => validateBenchParams('buildings', { houseVariation: 0 })).not.toThrow();
    expect(() => validateBenchParams('buildings', { houseVariation: 1 })).not.toThrow();
    expect(() => validateBenchParams('buildings', { houseVariation: -0.1 })).toThrow();
    expect(() => validateBenchParams('buildings', { houseVariation: 1.1 })).toThrow();
  });

  it.each(['center', 'rectangle', 'skew', 'notched'] as const)('keeps shared partitions simple and disjoint in the %s fixture', placement => {
    const layout = benchLayout({ ...options, placement, count: 5, rings: 2 }, '42');
    expect(layout.quarters).toHaveLength(10);
    for (const q of layout.quarters) { expect(isSimple(q.lp.pts)).toBe(true); expect(q.lp.lab).toHaveLength(q.lp.pts.length); }
    for (let i = 0; i < layout.quarters.length; i++) for (let j = i + 1; j < layout.quarters.length; j++) {
      expect(mpArea(intersectionS(layout.quarters[i].lp.pts, layout.quarters[j].lp.pts))).toBeLessThan(0.05);
    }
    expect(benchLayout({ ...options, placement, count: 5, rings: 2 }, '42').quarters).toEqual(layout.quarters);
    if (placement === 'notched') expect(layout.quarters.some(q => q.lp.pts.some((_, i) => interiorAngle(q.lp.pts, i) > Math.PI))).toBe(true);
  });

  it.each(['valley', 'hill'] as const)('constrains the %s footprint without regional generation', relief => {
    const flat = benchLayout(options, '42'), constrained = benchLayout({ ...options, relief }, '42');
    expect(constrained.contours.length).toBeGreaterThan(0);
    expect(constrained.quarters.reduce((s, q) => s + area(q.lp.pts), 0)).toBeLessThan(flat.quarters.reduce((s, q) => s + area(q.lp.pts), 0));
    expect(constrained.blocks.length).toBeGreaterThan(0);
  });

  it.each(['vertical', 'horizontal', 'diagonal'] as const)('cuts a %s river out of quarters, parcels and buildings', river => {
    const layout = benchLayout({ ...options, placement: 'notched', relief: 'hill', river, riverWidth: 18 }, '42');
    expect(layout.water.length).toBeGreaterThan(0);
    expect(layout.quarters.some(q => q.lp.lab.includes(LAB_WATER))).toBe(true);
    const partition = benchParcels(layout, '42'), houses = benchBuildings(layout, partition, '42');
    expect(partition.plots.length).toBeGreaterThan(0);
    for (const poly of [...layout.quarters.map(q => q.lp.pts), ...partition.parcels.map(p => p.poly), ...houses.buildings.map(b => b.poly)]) {
      expect(mpArea(intersectionS(poly, layout.water))).toBeLessThan(0.01);
    }
  });

  it('reserves a monument without constructing it at parcel stage', () => {
    const layout = benchLayout({ ...options, monument: 'church' }, '42'), partition = benchParcels(layout, '42');
    expect(partition.compounds).toHaveLength(1);
    const before = JSON.stringify(partition);
    const houses = benchBuildings(layout, partition, '42');
    expect(houses.buildings.some(b => b.parcel === partition.compounds[0].parcel)).toBe(true);
    expect(JSON.stringify(partition)).toBe(before);
  });
});
