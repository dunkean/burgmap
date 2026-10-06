import { describe, expect, it } from 'vitest';
import { benchLayout, benchParcels, benchBuildings, type BenchOptions } from '../src/gen/urban/testbench';
import { blockReach, makeStreetAt } from '../src/gen/urban/access';
import { area, isSimple, interiorAngle } from '../src/gen/geo/poly';
import { intersectionS, differenceS, mpArea } from '../src/gen/geo/bool';
import { Rng } from '../src/gen/core/rng';
import { burgageHouseExperimental as burgageHouse } from '../src/gen/urban/housesExperimental';
import { MORPHOLOGIES } from '../src/gen/urban/morphology';
import type { Plot } from '../src/gen/urban/plots';

const options: BenchOptions = {
  culture: 'european-organic', zone: 'core', placement: 'skew', rings: 2, density: 1, count: 8, radius: 160,
  monument: 'none', recipe: 'core', relief: 'hill', reliefSlope: 18, river: 'none', riverWidth: 14,
  mode: 'micro', microScale: 2.5, microFrontage: 'perimeter',
  stages: { streets: { preset: 'morph/european-organic' }, plots: { preset: 'morph/european-organic' },
    buildings: { preset: 'culture', params: { buildingOp: 'streetFrontRowExperimental' } } },
};

describe('courts and access on scaled native house plots', () => {
  it.each(['courtyard', 'burgage'] as const)('serves every roof in the reported %s fixture, including rear ranges', plotOp => {
    const o: BenchOptions = { ...options, stages: { ...options.stages, plots: { preset: 'morph/european-organic', params: { plotOp } } } };
    const layout = benchLayout(o, 'gja3b8');
    const partition = benchParcels(layout, plotOp === 'courtyard' ? '1tup5tm' : 'uvz24c');
    const before = JSON.stringify({ layout, partition });
    const houses = benchBuildings(layout, partition, '186rtb7');
    const roofs = houses.buildings.filter(b => b.kind !== 'garden');
    const streetAt = makeStreetAt(layout.streets.list.filter(s => s.ribbon).map(s => ({ path: s.path, widths: s.widths, width: s.widths[0] })), []);
    let total = 0;
    for (const [bi, block] of layout.blocks.entries()) {
      const peers = roofs.filter(b => partition.parcels[b.parcel!].block === bi);
      expect(blockReach(block.poly, peers.map(b => b.poly), streetAt).every(Boolean), layout.shapeNames![bi]).toBe(true);
      const built = peers.reduce((s, b) => s + area(b.poly), 0);
      expect(built / area(block.poly)).toBeGreaterThan(0.5);
      expect(built / area(block.poly)).toBeLessThan(0.96);
      total += built;
      for (let i = 0; i < peers.length; i++) {
        expect(isSimple(peers[i].poly)).toBe(true);
        expect(mpArea(differenceS(peers[i].poly, partition.parcels[peers[i].parcel!].poly))).toBeLessThan(0.001);
        for (let j = i + 1; j < peers.length; j++) expect(mpArea(intersectionS(peers[i].poly, peers[j].poly))).toBeLessThan(0.001);
      }
    }
    // Baseline areas 40320.7 / 38199.7 m². Courts and entrances reserve real
    // land; prevent access from being satisfied by emptying the fixture.
    expect(total).toBeGreaterThan((plotOp === 'courtyard' ? 40320 : 38199) * 0.8);
    expect(roofs.length).toBeGreaterThan(partition.plots.length);
    expect(roofs.some(b => b.poly.some((_, i) => interiorAngle(b.poly, i) > Math.PI + 0.01))).toBe(true);
    expect(JSON.stringify({ layout, partition })).toBe(before);
    expect(benchBuildings(layout, partition, '186rtb7')).toEqual(houses);
  });

  it('keeps a deep rear court connected past each transverse range before the access repair', () => {
    const poly = [{ x: 0, y: 0 }, { x: 16, y: 0 }, { x: 16, y: 65 }, { x: 0, y: 65 }];
    const plot: Plot = { poly, block: 0, zone: 'core', front: [poly[0], poly[1]], nrm: { x: 0, y: 1 }, axis: { x: 0, y: 1 },
      sideA: { p: poly[0], d: { x: 0, y: 1 } }, sideB: { p: poly[1], d: { x: 0, y: 1 } }, boundarySides: [[poly[0], poly[1]]],
      rank: 0, depth: 65, wide: true, sideFronts: [], run: 0, order: 1, wealth: 0.5 };
    const P = { ...MORPHOLOGIES['european-organic'], bigCourtChance: 0 };
    const fronts = new Set<number>();
    for (const seed of ['deep-a', 'deep-b', 'deep-c']) {
      const roofs = burgageHouse(structuredClone(plot), 0.92, P, new Rng(seed)).filter(b => b.kind !== 'garden');
      expect(roofs.length).toBeGreaterThan(3);
      expect(blockReach(poly, roofs.map(b => b.poly), p => p.y <= 0.1).every(Boolean)).toBe(true);
      expect(roofs.reduce((s, b) => s + area(b.poly), 0) / area(poly)).toBeGreaterThan(0.7);
      fronts.add(roofs.filter(b => b.kind === 'house').length);
    }
    // The same parcel supports an L with a side entrance or two front houses
    // with an entrance between them; it does not repeat one straight slit.
    expect(fronts).toEqual(new Set([1, 2]));
  });
});
