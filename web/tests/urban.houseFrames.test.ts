import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/gen/core/rng';
import type { Polygon } from '../src/gen/core/geom';
import { area, interiorAngle, isSimple, distToSeg } from '../src/gen/geo/poly';
import { difference, intersection, mpArea } from '../src/gen/geo/bool';
import { polyInside } from '../src/gen/geo/split';
import { blockReach, makeStreetAt } from '../src/gen/urban/access';
import { burgageHouseExperimental as burgageHouse } from '../src/gen/urban/housesExperimental';
import { buildPlotExperimental as buildPlot } from '../src/gen/urban/buildings';
import { fitParcelRectangle, houseBoundarySides, housePlotNormal, needsHouseFrameRepair } from '../src/gen/urban/houseFrames';
import { MORPHOLOGIES } from '../src/gen/urban/morphology';
import type { Plot } from '../src/gen/urban/plots';
import { benchLayout, benchParcels, benchBuildings, type BenchOptions } from '../src/gen/urban/testbench';

const digest = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const rightAngles = (poly: Polygon) => poly.forEach((_, i) => {
  const angle = interiorAngle(poly, i) * 180 / Math.PI;
  expect(Math.min(Math.abs(angle - 90), Math.abs(angle - 270))).toBeLessThan(0.01);
});
const options: BenchOptions = {
  culture: 'european-organic', zone: 'core', placement: 'skew', rings: 2, density: 1, count: 8, radius: 160,
  monument: 'none', recipe: 'core', relief: 'hill', reliefSlope: 18, river: 'none', riverWidth: 14,
  stages: { streets: { preset: 'morph/european-organic' }, plots: { preset: 'morph/european-organic' }, buildings: { preset: 'morph/european-organic', params: { buildingOp: 'streetFrontRowExperimental' } } },
};
const plotOptions: BenchOptions = { ...options, stages: { ...options.stages, plots: { preset: 'morph/european-organic', params: { plotOp: 'burgage', plotTilt: 0 } } } };

describe('parcel frames in oblique building plots', () => {
  it('repairs the three reported pins without recutting any street, block or parcel', () => {
    const layout = benchLayout(options, '1cl51ek');
    const partition = benchParcels(layout, '1f3hikq', plotOptions);
    const houses = benchBuildings(layout, partition, '43nbs4', plotOptions);
    expect(digest({ blocks: layout.blocks, quarters: layout.quarters, streets: layout.streets.list })).toBe('00360f2d5975a3c3d13a717b6350dc0de79e9db86106edbfdd05f6cc134d32d2');
    expect(digest(partition.parcels)).toBe('21bdee647f1aa4dbc819034454c2acc50a8011856571f95afdb5904404a3c83d');
    // Street-facing crops at pins 1/2 can remain oblique; the micro cases below
    // protect their private walls. Pin 3's isolated inner ranges must be orthogonal.
    const repaired = houses.buildings.filter(b => (b.parcel === 55 || b.parcel === 56) && b.kind === 'rear');
    expect(repaired.length).toBeGreaterThanOrEqual(3);
    repaired.forEach(b => rightAngles(b.poly));
    const roofs = houses.buildings.filter(b => b.kind !== 'garden');
    for (const b of roofs) {
      expect(isSimple(b.poly)).toBe(true);
      expect(mpArea(difference(b.poly, partition.parcels[b.parcel!].poly))).toBeLessThan(0.001);
    }
    for (let i = 0; i < roofs.length; i++) for (let j = i + 1; j < roofs.length; j++) {
      if (roofs[i].parcel === roofs[j].parcel) expect(mpArea(intersection(roofs[i].poly, roofs[j].poly))).toBeLessThan(0.001);
    }
    // Original occupied area: 56812.65381442045 m², before independent
    // gateways and room-depth courts. Bound their cost while checking access.
    expect(roofs.reduce((sum, b) => sum + area(b.poly), 0)).toBeGreaterThan(56812.65381442045 * 0.94);
    expect(roofs.reduce((sum, b) => sum + area(b.poly), 0)).toBeLessThan(56812.65381442045 * 1.12);
    const streetAt = makeStreetAt(layout.streets.list.filter(s => s.ribbon).map(s => ({ path: s.path, widths: s.widths, width: s.widths[0] })), []);
    for (const [bi, block] of layout.blocks.entries()) {
      const peers = roofs.filter(b => partition.parcels[b.parcel!].block === bi);
      expect(blockReach(block.poly, peers.map(b => b.poly), streetAt).every(Boolean)).toBe(true);
    }
    expect(benchBuildings(layout, partition, '43nbs4', plotOptions)).toEqual(houses);
  });

  it('keeps the complete footprints and random stream of 18 ordinary seeded houses', () => {
    const P = { ...MORPHOLOGIES['european-organic'], bigCourtChance: 0, houseVariation: 0 };
    const controls: unknown[] = [];
    for (const zone of ['core', 'middle', 'faubourg'] as const) for (const width of [8, 12, 16]) for (const shift of [0, 1]) {
      const poly = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width + shift, y: 30 }, { x: shift, y: 30 }];
      const plot: Plot = {
        poly, block: 0, zone, front: [poly[0], poly[1]], nrm: { x: 0, y: 1 },
        sideA: { p: poly[0], d: { x: 0, y: 1 } }, sideB: { p: poly[1], d: { x: 0, y: 1 } },
        rank: 0, depth: 40, wide: true, sideFronts: [], run: 0, order: 0, wealth: 1,
      };
      const rng = new Rng('house-frame-control');
      controls.push(burgageHouse(plot, zone === 'core' ? 0.9 : 0.7, P, rng), rng.float());
      if (!shift) {
        const reference = new Rng('house-frame-control'), framed = new Rng('house-frame-control');
        expect(burgageHouse({ ...plot, axis: { x: 0, y: 1 } }, zone === 'core' ? 0.9 : 0.7, P, framed))
          .toEqual(burgageHouse(plot, zone === 'core' ? 0.9 : 0.7, P, reference));
        expect(framed.float()).toBe(reference.float());
      }
    }
    expect(digest(controls)).toBe('ecf821cde8c226332ee7e87dcfc26619a873e59f6a8688c578f6b8b0f3a64bed');
  });

  it.each(['burgage', 'courtyard'] as const)('retains the micro parcels’ private wall frame with %s subdivision', plotOp => {
    const micro: BenchOptions = { ...plotOptions, mode: 'micro', stages: { ...plotOptions.stages,
      plots: { preset: 'morph/european-organic', params: { plotOp, plotTilt: 0 } }, buildings: { params: { buildingOp: 'streetFrontRowExperimental' } } } };
    const layout = benchLayout(micro, '1cl51ek');
    const partition = benchParcels(layout, '1f3hikq', micro);
    const houses = benchBuildings(layout, partition, '43nbs4', micro);
    const roofs = houses.buildings.filter(b => b.kind !== 'garden');
    const streetAt = makeStreetAt(layout.streets.list.filter(s => s.ribbon).map(s => ({ path: s.path, width: s.widths[0], kind: 'street' })), []);
    const frontageRoofs = roofs.filter(b => partition.parcels[b.parcel!].block === 4);
    const reached = blockReach(layout.blocks[4].poly, frontageRoofs.map(b => b.poly), streetAt);
    for (const { plot, parcel } of partition.plots.filter(p => [2, 3, 4, 6, 7].includes(p.plot.block))) {
      expect(plot.axis).toEqual(layout.blocks[plot.block].plotFrame.u);
      const n = housePlotNormal(plot), t = { x: n.y, y: -n.x };
      if (plot.block === 4) {
        const streetHouse = roofs.find(b => b.parcel === parcel && b.kind === 'house');
        expect(streetHouse).toBeDefined();
        expect(reached[frontageRoofs.indexOf(streetHouse!)]).toBe(true);
      }
      for (const b of roofs.filter(b => b.parcel === parcel)) {
        expect(polyInside(plot.poly, b.poly)).toBe(true);
        expect(isSimple(b.poly)).toBe(true);
        for (let i = 0; i < b.poly.length; i++) {
          const a = b.poly[i], q = b.poly[(i + 1) % b.poly.length], dx = q.x - a.x, dy = q.y - a.y, len = Math.hypot(dx, dy);
          if (len < 3) continue; // Small facade chamfers are permitted.
          const exterior = (plot.boundarySides ?? []).some(([p, r]) => distToSeg(a, p, r) < 0.02 && distToSeg(q, p, r) < 0.02);
          if (!exterior) expect(Math.max(Math.abs(dx * n.x + dy * n.y), Math.abs(dx * t.x + dy * t.y)) / len).toBeGreaterThan(0.9999);
        }
      }
    }
    for (let i = 0; i < roofs.length; i++) for (let j = i + 1; j < roofs.length; j++) {
      expect(mpArea(intersection(roofs[i].poly, roofs[j].poly))).toBeLessThan(0.001);
    }
    expect(benchBuildings(layout, partition, '43nbs4', micro)).toEqual(houses);
  });

  it('shortens or shifts a whole room in the retained frame, including a concave crop', () => {
    const angle = 0.73, t = { x: Math.cos(angle), y: Math.sin(angle) }, n = { x: -t.y, y: t.x }, o = { x: 20000, y: 20000 };
    const at = (x: number, y: number) => ({ x: o.x + t.x * x + n.x * y, y: o.y + t.y * x + n.y * y });
    const poly = [at(0, 0), at(9, 0), at(15, 12), at(6, 12)];
    const fitted = fitParcelRectangle(poly, { o, t, n })!;
    expect(fitted).not.toBeNull();
    rightAngles(fitted);
    expect(polyInside(poly, fitted)).toBe(true);
    expect(fitted).toHaveLength(4);
    expect(area(fitted)).toBeGreaterThan(area(poly) * 0.35);
    expect(area(fitted)).toBeLessThan(area(poly));
    const concave = [at(0, 0), at(9, 0), at(9, 5), at(4, 5), at(4, 12), at(0, 12)];
    const room = fitParcelRectangle(concave, { o, t, n })!;
    expect(room).not.toBeNull();
    expect(polyInside(concave, room)).toBe(true);
    rightAngles(room);
  });

  it('permits moderate exterior angles while repairing the same skew on a private wall', () => {
    const poly = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 18, y: 12 }, { x: 0, y: 12 }];
    const frame = { o: poly[0], t: { x: 1, y: 0 }, n: { x: 0, y: 1 } };
    expect(needsHouseFrameRepair(poly, frame, [[poly[1], poly[2]]])).toBe(false);
    expect(needsHouseFrameRepair(poly, frame, [])).toBe(true);
  });

  it.each([-2, 2])('retains a curved facade with a %s m bow beyond the frontage chord', bow => {
    const frontCurve = Array.from({ length: 7 }, (_, i) => ({ x: i * 3, y: 2 + bow * Math.sin(i * Math.PI / 6) }));
    const poly = [...frontCurve, { x: 18, y: 25 }, { x: 0, y: 25 }];
    const plot: Plot = {
      poly, block: 0, zone: 'core', front: [frontCurve[0], frontCurve[6]], nrm: { x: 0, y: 1 }, axis: { x: 0, y: 1 },
      sideA: { p: poly[0], d: { x: 0, y: 1 } }, sideB: { p: poly[6], d: { x: 0, y: 1 } },
      rank: 0, depth: 25, wide: true, sideFronts: [], boundarySides: houseBoundarySides(poly, poly, [poly[0], poly[6]]), run: 0, order: 1, wealth: 0.5,
    };
    class NoJogRng extends Rng {
      chance(p: number): boolean { const value = super.chance(p); return p === 0.14 ? false : value; }
    }
    const P = { ...MORPHOLOGIES['european-organic'], bigCourtChance: 0, setback: { ...MORPHOLOGIES['european-organic'].setback, core: [0, 0] as [number, number] } };
    const roofs = buildPlot(plot, 0.9, P, new NoJogRng('curved-facade'));
    const streetHouse = roofs.find(b => b.kind === 'house')!;
    expect(streetHouse).toBeDefined();
    expect(streetHouse.poly.filter(p => frontCurve.some(q => Math.hypot(p.x - q.x, p.y - q.y) < 0.02)).length).toBeGreaterThanOrEqual(4);
    roofs.forEach(b => expect(polyInside(poly, b.poly)).toBe(true));
  });
});
