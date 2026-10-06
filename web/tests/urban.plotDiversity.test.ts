import { describe, expect, it } from 'vitest';
import { benchLayout, benchParcels, benchBuildings, type BenchOptions } from '../src/gen/urban/testbench';
import { area, isSimple } from '../src/gen/geo/poly';
import { differenceS, intersectionS, mpArea } from '../src/gen/geo/bool';
import { frontageEdges } from '../src/gen/urban/courtyards';

const options: BenchOptions = {
  culture: 'european-organic', zone: 'core', mode: 'micro', microScale: 3, recipe: 'core',
  placement: 'skew', rings: 2, density: 1, count: 8, radius: 160, monument: 'none',
  relief: 'hill', reliefSlope: 18, river: 'none', riverWidth: 14,
  stages: { streets: { preset: 'morph/european-organic' }, plots: { preset: 'morph/european-organic', params: { plotOp: 'courtyard' } }, buildings: { preset: 'culture', params: { buildingOp: 'streetFrontRow' } } },
};

describe('parcel diversity and scaled micro access', () => {
  it.each(['burgage', 'courtyard'] as const)('varies the %s frame by parcel seed while retaining it for houses', plotOp => {
    const o: BenchOptions = { ...options, stages: { ...options.stages, plots: { preset: 'morph/european-organic', params: { plotOp } } } };
    const layout = benchLayout(o, 'gja3b8'), a = benchParcels(layout, '1tup5tm', o), b = benchParcels(layout, 'other-parcels', o);
    const before = JSON.stringify(layout.blocks), streets = JSON.stringify(layout.streets.list);
    expect(benchParcels(layout, '1tup5tm', o)).toEqual(a);
    expect(b.parcels).not.toEqual(a.parcels);
    expect(b.plots.map(p => p.plot.axis)).not.toEqual(a.plots.map(p => p.plot.axis));
    for (const { plot } of a.plots) {
      const u = layout.blocks[plot.block].plotFrame.u, axis = plot.axis!;
      expect(Math.acos(Math.min(1, u.x * axis.x + u.y * axis.y)) * 180 / Math.PI).toBeLessThanOrEqual(6.00001);
    }
    const locked = benchParcels(layout, '1tup5tm', { ...o, stages: { ...o.stages, plots: { preset: 'morph/european-organic', params: { plotOp, plotTilt: 0 } } } });
    locked.plots.forEach(({ plot }) => expect(plot.axis).toEqual(layout.blocks[plot.block].plotFrame.u));
    const grid = benchParcels(layout, '1tup5tm', { ...o, stages: { ...o.stages, plots: { preset: 'morph/european-organic', params: { plotOp, streetOp: 'grid', plotTilt: 6 } } } });
    grid.plots.forEach(({ plot }) => expect(plot.axis).toEqual(layout.blocks[plot.block].plotFrame.u));
    const partition = JSON.stringify(a);
    expect(benchBuildings(layout, a, '186rtb7', o).buildings.length).toBeGreaterThan(0);
    expect(JSON.stringify(a)).toBe(partition);
    expect(JSON.stringify(layout.blocks)).toBe(before);
    expect(JSON.stringify(layout.streets.list)).toBe(streets);
  });

  it('subdivides the reported scale-three case into compact street-accessible lots with perimeter roads', () => {
    const front = benchLayout(options, 'gja3b8'), o: BenchOptions = { ...options, microFrontage: 'perimeter' };
    const surrounded = benchLayout(o, 'gja3b8');
    expect(surrounded.blocks).toEqual(front.blocks);
    expect(frontageEdges(front.blocks[0].poly, front.streets)).toHaveLength(1);
    expect(frontageEdges(surrounded.blocks[0].poly, surrounded.streets)).toHaveLength(4);
    const long = benchParcels(front, '1tup5tm', options), compact = benchParcels(surrounded, '1tup5tm', o);
    expect(compact.plots.length).toBeGreaterThan(long.plots.length * 3);
    expect(Math.max(...compact.plots.map(p => area(p.plot.poly)))).toBeLessThan(800);
    // Regression: the cut line's centre lies outside the concave curve. Ignoring
    // its other interior chords left an indivisible 2214 m² parcel.
    expect(compact.plots.filter(p => p.plot.block === 9).length).toBeGreaterThanOrEqual(20);
    for (const [bi, block] of surrounded.blocks.entries()) {
      const cells = compact.parcels.filter(p => p.block === bi);
      expect(Math.abs(cells.reduce((s, p) => s + area(p.poly), 0) - area(block.poly))).toBeLessThan(0.01);
      for (let i = 0; i < cells.length; i++) {
        expect(isSimple(cells[i].poly)).toBe(true);
        for (let j = i + 1; j < cells.length; j++) expect(mpArea(intersectionS(cells[i].poly, cells[j].poly))).toBeLessThan(0.05);
      }
    }
    const frozen = JSON.stringify(compact), houses = benchBuildings(surrounded, compact, '186rtb7', o);
    for (const b of houses.buildings) expect(mpArea(differenceS(b.poly, compact.parcels[b.parcel!].poly))).toBeLessThan(0.05);
    expect(benchBuildings(surrounded, compact, '186rtb7', o)).toEqual(houses);
    expect(JSON.stringify(compact)).toBe(frozen);
  });
});
