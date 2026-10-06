import { describe, expect, it } from 'vitest';
import { Rng } from '../src/gen/core/rng';
import { area, distToRing, isSimple } from '../src/gen/geo/poly';
import { difference, tryDifference, tryIntersection, mpArea } from '../src/gen/geo/bool';
import { MORPHOLOGIES } from '../src/gen/urban/morphology';
import { buildPerimeterBlock, buildPerimeterPlot, retainBlockPlot } from '../src/gen/urban/perimeterBlock';
import { buildOn } from '../src/gen/urban/bops';
import { shapeOf } from '../src/gen/urban/buildings';
import { cutPlots } from '../src/gen/urban/plots';
import { blockReach, makeStreetAt } from '../src/gen/urban/access';
import { Streets } from '../src/gen/urban/streets';
import { benchLayout, benchParcels, benchBuildings, type BenchOptions } from '../src/gen/urban/testbench';
import type { Polygon } from '../src/gen/core/geom';

const P = { ...MORPHOLOGIES['perimeter-block'], blockSolidChance: 0, blockInfillChance: 0 };
const rectangle: Polygon = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }];
function fixture(poly = rectangle) {
  const streets = new Streets();
  poly.forEach((a, i) => streets.add([a, poly[(i + 1) % poly.length]], 0.2, 0, 'radial', 0));
  const partition = cutPlots(poly, 0, 'core', 0.95, P, streets, new Rng('perimeter-parcels'));
  const build = (parameters = P) => partition.plots.flatMap((pl, i) => buildPerimeterPlot(pl, parameters, new Rng('perimeter-houses:' + i)));
  return { streets, partition, build };
}
function geometry(poly: Polygon, roofs: { poly: Polygon }[]) {
  for (const roof of roofs) {
    expect(isSimple(roof.poly)).toBe(true);
    expect(mpArea(tryDifference(roof.poly, poly).pieces)).toBeLessThan(0.001);
    expect(shapeOf(roof.poly).w).toBeGreaterThanOrEqual(4.5 - 0.001);
    expect(shapeOf(roof.poly).asp).toBeLessThanOrEqual(3 + 0.001);
  }
  for (let i = 0; i < roofs.length; i++) for (let j = i + 1; j < roofs.length; j++) {
    // Native cadastral booleans retain the shared millimetre grid (area noise < 1 cm² per metre of seam).
    expect(mpArea(tryIntersection(roofs[i].poly, roofs[j].poly).pieces)).toBeLessThan(0.01);
  }
}

describe('perimeter buildings on native cutPlots parcels', () => {
  it('retains cutPlots in the morphology and leaves the cadastral partition untouched', () => {
    expect(P.plotOp).toBe('burgage');
    const { partition, build } = fixture(), before = JSON.stringify(partition);
    expect(partition.plots.length).toBeGreaterThan(8);
    expect(partition.plots.every(pl => !pl.wholeBlock)).toBe(true);
    build();
    expect(JSON.stringify(partition)).toBe(before);
  });

  it('creates an irregular collective court from the remaining space, with varied rectangular buildings', () => {
    const { build } = fixture(), roofs = build(), free = difference(rectangle, ...roofs.map(b => b.poly));
    geometry(rectangle, roofs);
    expect(free.filter(ph => area(ph.outer) > 25)).toHaveLength(1);
    expect(free.reduce((best, ph) => area(ph.outer) > area(best.outer) ? ph : best).outer.length).toBeGreaterThan(12);
    const sizes = roofs.map(b => area(b.poly)).sort((a, b) => a - b);
    expect(sizes[Math.floor(sizes.length * 0.9)] / sizes[Math.floor(sizes.length * 0.1)]).toBeGreaterThan(3);
    expect(roofs.filter(b => b.poly.length === 4).length / roofs.length).toBeGreaterThan(0.6);
    expect(blockReach(rectangle, roofs.map(b => b.poly), () => true).every(Boolean)).toBe(true);
    let served = 0;
    rectangle.forEach((a, i) => {
      const b = rectangle[(i + 1) % rectangle.length];
      for (let k = 0; k < 30; k++) {
        const v = (k + 0.5) / 30, p = { x: a.x + (b.x - a.x) * v, y: a.y + (b.y - a.y) * v };
        if (Math.min(...roofs.map(roof => distToRing(roof.poly, p))) < 0.01) served++;
      }
    });
    expect(served / 120).toBeGreaterThan(0.97);
  });

  it('orients buildings perpendicular to their actual street and contains them in their original parcel', () => {
    const { partition } = fixture();
    for (const [i, pl] of partition.plots.entries()) {
      const roofs = buildPerimeterPlot(pl, P, new Rng('perimeter-houses:' + i));
      geometry(pl.poly, roofs);
      for (const b of roofs) expect(Math.min(...[pl.front, ...pl.sideFronts, ...(pl.streetSides ?? [])].map(([a, c]) =>
        Math.abs(Math.cos(b.orientation) * (c.x - a.x) + Math.sin(b.orientation) * (c.y - a.y))))).toBeCloseTo(0, 6);
    }
  });

  it('changes the depth preference without drawing or resizing a prescribed court polygon', () => {
    const { build } = fixture();
    const small = build({ ...P, blockCourtShare: [0.1, 0.1] });
    const large = build({ ...P, blockCourtShare: [0.6, 0.6] });
    expect(mpArea(difference(rectangle, ...large.map(b => b.poly)))).toBeGreaterThan(mpArea(difference(rectangle, ...small.map(b => b.poly))) * 1.5);
  });

  it('uses the dedicated construction through the native dispatcher and ignores house perturbations', () => {
    const pl = fixture().partition.plots[0], rng = new Rng('dispatcher');
    const roofs = buildPerimeterPlot(pl, P, rng);
    expect(buildOn(pl, 0.95, P, new Rng('dispatcher')).map(b => b.poly)).toEqual(roofs.map(b => b.poly));
    expect(buildPerimeterPlot(pl, { ...P, houseVariation: 1 }, new Rng('dispatcher'))).toEqual(roofs);
  });

  it('still loads old whole-block cases through cutPlots without per-house passages', () => {
    const { streets } = fixture(), pl = retainBlockPlot(rectangle, 0, 'core', streets).plots[0];
    const result = buildPerimeterBlock(pl, P, new Rng('legacy'));
    expect(result.passages).toHaveLength(0);
    geometry(rectangle, result.buildings);
    expect(buildPerimeterBlock(pl, P, new Rng('legacy'))).toEqual(result);
  });

  for (const scale of [1, 2.5]) it(`keeps every generated roof accessible on the reported micro shapes at scale ${scale}`, () => {
    const options: BenchOptions = { culture: 'european-organic', recipe: 'core', zone: 'core', placement: 'skew', rings: 2,
      density: 1, count: 8, radius: 160, monument: 'none', mode: 'micro', microScale: scale, microFrontage: 'perimeter',
      stages: { plots: { params: { plotOp: 'burgage' } }, buildings: { params: { buildingOp: 'perimeterBlock' } } } };
    const layout = benchLayout(options, 'gja3b8'), partition = benchParcels(layout, '1tup5tm'), before = JSON.stringify(partition);
    expect(partition.plots.length).toBeGreaterThan(10);
    const result = benchBuildings(layout, partition, '186rtb7');
    expect(JSON.stringify(partition)).toBe(before);
    expect(benchBuildings(layout, partition, '186rtb7')).toEqual(result);
    const streetAt = makeStreetAt(layout.streets.list.map(s => ({ path: s.path, width: s.widths[0], widths: s.widths })), []);
    const rng = new Rng('186rtb7').fork('testbench-houses');
    for (let bi = 0; bi < layout.blocks.length; bi++) {
      const entries = partition.plots.filter(e => e.plot.block === bi);
      const raw = entries.flatMap(e => buildPerimeterPlot(e.plot, { ...MORPHOLOGIES['european-organic'], buildingOp: 'perimeterBlock' }, rng.fork('block:' + bi).fork('house:' + e.index)));
      const roofs = result.buildings.filter(b => partition.parcels[b.parcel!].block === bi);
      geometry(layout.blocks[bi].poly, roofs);
      expect(roofs.map(b => b.poly)).toEqual(raw.map(b => b.poly));
      expect(blockReach(layout.blocks[bi].poly, roofs.map(b => b.poly), streetAt).every(Boolean)).toBe(true);
    }
  });
});
