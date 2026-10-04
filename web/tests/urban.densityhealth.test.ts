import { describe, expect, it } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { Rng } from '../src/gen/core/rng';
import { buildCompound } from '../src/gen/urban/compounds';
import { registerM4 } from '../src/gen/urban/m4';
import { FROZEN_SHANTY_CELLS } from './fixtures/shanty-cells';
import { area, isSimple, obb } from '../src/gen/geo/poly';
import { polyInside } from '../src/gen/geo/split';
import { burgageHouse } from '../src/gen/urban/houses';
import { MORPHOLOGIES } from '../src/gen/urban/morphology';
import type { Plot } from '../src/gen/urban/plots';
import { coverage } from './coverage';
import { unreachableBuildings } from './accessCheck';

// Approved d887575 quantities: regional roads alter cells in seeds 1 and 6, not the dwelling producer.
const HUT_CASES = [
  { seed: '1', count: 267 }, { seed: '2', count: 176 }, { seed: '3', count: 95 },
  { seed: '4', count: 286 }, { seed: '5', count: 651 }, { seed: '6', count: 638 },
];

const FADE = 0.9, FADE_CHANCE = 0.5 * Math.pow(FADE, 1.4);
class FadeGapRng extends Rng {
  fadeDraws = 0;
  constructor(private readonly skip: boolean) { super('density-health'); }
  chance(p: number): boolean {
    const value = super.chance(p);
    if (this.fadeDraws === 0 && Math.abs(p - FADE_CHANCE) < 1e-12) {
      this.fadeDraws++;
      return this.skip;
    }
    return value;
  }
}

function edgePlot(zone: Plot['zone']): Plot {
  const poly = [{ x: 0, y: 0 }, { x: 18, y: 0 }, { x: 18, y: 40 }, { x: 0, y: 40 }];
  return {
    poly, zone, block: 0, front: [poly[0], poly[1]], nrm: { x: 0, y: 1 },
    sideA: { p: poly[0], d: { x: 0, y: 1 } }, sideB: { p: poly[1], d: { x: 0, y: 1 } },
    rank: 2, depth: 40, wide: true, sideFronts: [], run: 0, order: 0, wealth: 0.5, fade: FADE,
  };
}

describe('density producer contracts survive late styling and edge fading', () => {
  it('preserves all 53 formerly narrow huts on their exact original cells regardless of later regional-road changes', () => {
    registerM4();
    expect(FROZEN_SHANTY_CELLS.reduce((n, f) => n + f.cells.length, 0)).toBe(53);
    for (const fixture of FROZEN_SHANTY_CELLS) {
      const out = buildCompound('m4-shanty', fixture.poly, { rng: new Rng(fixture.rngKey), angle: 0, pop: 10000, center: fixture.center });
      for (const cell of fixture.cells) {
        expect(out.parcels[cell.index].poly, `seed ${fixture.seed} original block ${fixture.block} cell ${cell.index}`).toEqual(cell.poly);
        const huts = out.buildings.filter((b) => b.kind === 'hut' && b.parcel === cell.index);
        expect(huts, 'styling preserves the original dwelling').toHaveLength(1);
        const h = huts[0], o = obb(h.poly);
        expect({ poly: h.poly, arch: h.arch }, 'approved producer footprint and architecture on the historical centre').toEqual(cell.hut);
        expect(isSimple(h.poly)).toBe(true);
        expect(polyInside(cell.poly, h.poly)).toBe(true);
        expect(2 * o.hv).toBeGreaterThanOrEqual(4.5 - 1e-6);
        expect(o.hu / o.hv).toBeLessThanOrEqual(3 + 1e-6);
        expect(area(h.poly)).toBeGreaterThanOrEqual(15 - 1e-6);
        expect(area(h.poly)).toBeLessThanOrEqual(40.5);
      }
    }
  });

  for (const fixture of HUT_CASES) it(`city seed ${fixture.seed} retains its huts with usable final footprints`, () => {
    const u = generate(makeOptions({ size: 'city', seed: fixture.seed })).urban!;
    const huts = u.buildings.filter((b) => b.kind === 'hut');
    expect(huts, 'fix styling without deleting dwellings').toHaveLength(fixture.count);
    for (const h of huts) {
      expect(h.parcel).toBeDefined();
      const pc = u.parcels[h.parcel!], o = obb(h.poly);
      expect(pc.use).toBe('hut-lot');
      expect(isSimple(h.poly), `hut ${h.parcel} is simple`).toBe(true);
      expect(polyInside(pc.poly, h.poly), `hut ${h.parcel} stays in its own cell`).toBe(true);
      expect(2 * o.hv, `hut ${h.parcel} minimum width`).toBeGreaterThanOrEqual(4.5 - 1e-6);
      expect(o.hu / o.hv, `hut ${h.parcel} maximum aspect`).toBeLessThanOrEqual(3 + 1e-6);
      expect(area(h.poly)).toBeGreaterThanOrEqual(15 - 1e-6);
      expect(area(h.poly)).toBeLessThanOrEqual(40.5);
    }
    for (let i = 0; i < u.blocks.length; i++) if (u.blockInfo[i].kind === 'shanty') {
      const built = huts.filter((h) => u.parcels[h.parcel!].block === i).reduce((sum, h) => sum + area(h.poly), 0);
      expect(built / area(u.blocks[i]), `shanty block ${i} coverage`).toBeGreaterThanOrEqual(0.5);
      expect(built / area(u.blocks[i]), `shanty block ${i} coverage`).toBeLessThanOrEqual(0.7);
    }
  });

  for (const zone of ['core', 'middle'] as const) it(`${zone} edge keeps a dwelling and its existing random sequence`, () => {
    const rngA = new FadeGapRng(true), rngB = new FadeGapRng(false);
    const a = burgageHouse(edgePlot(zone), 0.6, MORPHOLOGIES['european-organic'], rngA);
    const b = burgageHouse(edgePlot(zone), 0.6, MORPHOLOGIES['european-organic'], rngB);
    expect(rngA.fadeDraws).toBe(1);
    expect(rngB.fadeDraws).toBe(1);
    expect(a).toEqual(b);
    expect(a.some((building) => building.kind === 'house')).toBe(true);
    expect(a.some((building) => building.kind === 'garden')).toBe(true);
    for (const building of a) expect(polyInside(edgePlot(zone).poly, building.poly)).toBe(true);
  });

  it('retains whole-plot garden gaps in the actual faubourg transition', () => {
    const rng = new FadeGapRng(true), pl = edgePlot('faubourg');
    const buildings = burgageHouse(pl, 0.6, MORPHOLOGIES['european-organic'], rng);
    expect(rng.fadeDraws).toBe(1);
    expect(buildings).toHaveLength(1);
    expect(buildings[0].kind).toBe('garden');
    expect(area(buildings[0].poly)).toBeCloseTo(area(pl.poly), 6);
  });

  it('town seed 3 reaches the original middle density target without reclaiming access or changing its plots', () => {
    const w = generate(makeOptions({ seed: '3', size: 'town' })), u = w.urban!;
    const middle = coverage(w).byPhase.get(2)!;
    expect(middle.zone).toBe('middle');
    expect(middle.area, 'same residential denominator as approved baseline').toBeCloseTo(66792.9288465149, 6);
    const middlePlots = u.parcels.filter((p) => u.blockInfo[p.block].phase === 2 && u.blockInfo[p.block].kind === 'block');
    expect(middlePlots).toHaveLength(248);
    expect(middlePlots.every((p) => p.use === 'plot')).toBe(true);
    expect(middle.built / middle.area).toBeGreaterThanOrEqual(0.7);
    expect(middle.built / middle.area).toBeLessThanOrEqual(0.85);
    expect(unreachableBuildings(w).n, 'density gain keeps real street and courtyard access').toBe(0);
    expect(Number(w.stats['urban.openFringe.quarters'])).toBeGreaterThan(0);
  });
});
