import { describe, expect, it } from 'vitest';
import type { UrbanCtx } from '../src/gen/urban/context';
import type { Primary } from '../src/gen/urban/primary';
import { addOpenFringe, openEdgeFade, streetStrips } from '../src/gen/urban/openfringe';
import { Streets } from '../src/gen/urban/streets';
import { resolveMorph } from '../src/gen/urban/morphology';
import { Rng } from '../src/gen/core/rng';
import { intersectionS, mpArea, differenceS, type MultiPoly } from '../src/gen/geo/bool';
import { area, pointInRing } from '../src/gen/geo/poly';
import { polygonCentroid } from '../src/gen/core/geom';
import { ribbon } from '../src/gen/geo/offset';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { urbanNaturalGround } from '../src/gen/landuse/urbanGround';
import { checkWorld } from './urbanCheck';
import '../src/gen/urban/cultures';

const box = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
function fixture(curved = false) {
  const morph = { ...resolveMorph(undefined), streetOp: curved ? 'organic' as const : 'grid' as const }, streets = new Streets();
  const id = streets.add([{ x: 250, y: 200 }, { x: 300, y: 200 }], 5, 2, 'radial', 1);
  streets.connected.add(id);
  const planned = [{ outer: box(100, 100, 300, 300), holes: [] }];
  const primary: Primary = { quarters: [], market: null, radials: [id], walls: [], moat: [], footprint: planned, marketStreet: -1 };
  const ctx = { mapSize: 1600, win: { x0: 0, y0: 0, x1: 1600, y1: 1600 }, water: [], slopeAt: () => 0.03, isWater: () => false } as unknown as UrbanCtx;
  const run = (protect: MultiPoly = []) => addOpenFringe(ctx, primary, streets, 2, morph, 'european-organic', new Rng('fringe'), protect);
  return { ctx, primary, streets, planned, run };
}

describe('open settlement fringe', () => {
  it('adds deterministic served quarters beyond the frame without claiming older land', () => {
    const f = fixture(), before = JSON.stringify(f.planned), quarters = f.run();
    expect(quarters.length).toBeGreaterThanOrEqual(2);
    expect(quarters).toEqual(fixture().run());
    expect(JSON.stringify(f.planned)).toBe(before);
    for (const q of quarters) {
      expect(mpArea(intersectionS(q.lp.pts, f.planned))).toBeLessThanOrEqual(0.02);
      const ids = q.lp.lab.filter((l) => l >= 0);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.every((id) => f.streets.connected.has(id))).toBe(true);
      expect(mpArea(differenceS(q.lp.pts, f.primary.footprint))).toBeLessThanOrEqual(0.02);
    }
    expect(mpArea(intersectionS(quarters[0].lp.pts, quarters[1].lp.pts))).toBeLessThanOrEqual(0.02);
    const street = f.streets.list.at(-1)!;
    expect(street.path[0]).toEqual({ x: 300, y: 200 });
    expect(street.path[0]).not.toBe(f.streets.list[0].path[1]);
  });

  it('rejects water, steep slopes, map edges and unconnected roots', () => {
    const wet = fixture(); wet.ctx.water = [{ outer: box(310, 150, 400, 250), holes: [] }];
    // Full-width exact water subtraction protects even a deliberately uninformative coarse sampler.
    expect(wet.run()).toEqual([]);
    const steep = fixture(); steep.ctx.slopeAt = (p) => p.x > 320 ? 0.5 : 0.03;
    expect(steep.run()).toEqual([]);
    const edge = fixture(); edge.ctx.win.x1 = 320;
    expect(edge.run()).toEqual([]);
    const isolated = fixture(); isolated.streets.connected.clear();
    expect(isolated.run()).toEqual([]);
  });

  it('continues organic streets with a gentle curve and real labelled frontage', () => {
    const f = fixture(true), q = f.run();
    expect(q.length).toBeGreaterThan(0);
    expect(q).toEqual(fixture(true).run());
    const lane = f.streets.list.at(-1)!;
    expect(lane.path.length).toBeGreaterThan(3);
    expect(lane.path.some((p) => Math.abs(p.y - 200) > 0.5)).toBe(true);
    expect(lane.path.filter((p) => p.x <= 308).every((p) => p.y === 200)).toBe(true);
    expect(Math.max(...lane.path.map((p) => Math.abs(p.y - 200)))).toBeLessThanOrEqual(8.000001);
    expect(q.every((quarter) => quarter.lp.lab.includes(lane.id))).toBe(true);
  });

  it('keeps small protected/wet pockets open and deduplicates nearby roots', () => {
    const f = fixture(); f.ctx.water = [{ outer: box(330, 205, 340, 215), holes: [] }];
    f.ctx.isWater = (p) => f.ctx.water.some((ph) => pointInRing(ph.outer, p));
    const id = f.streets.add([{ x: 250, y: 200 }, { x: 300, y: 200 }], 5, 2, 'radial', 1);
    f.streets.connected.add(id);
    const q = f.run();
    expect(q.length).toBeGreaterThan(0);
    expect(f.streets.list).toHaveLength(3);
    for (const quarter of q) expect(mpArea(intersectionS(quarter.lp.pts, f.ctx.water))).toBeLessThanOrEqual(0.02);
    const street = f.streets.list[2];
    expect(mpArea(intersectionS(ribbon(street.path, street.widths), f.ctx.water))).toBeLessThanOrEqual(0.02);
    expect(q.reduce((s, quarter) => s + area(quarter.lp.pts), 0)).toBeGreaterThan(180);
  });

  it('rejects a narrow pond across only the new lane even with an uninformative sampler', () => {
    const f = fixture();
    f.ctx.water = [{ outer: box(330, 198, 334, 202), holes: [] }];
    expect(f.run()).toEqual([]);
  });

  it('fades density over a finite interior band', () => {
    expect(openEdgeFade(0, 60)).toBe(0.9);
    expect(openEdgeFade(30, 60)).toBeCloseTo(0.45);
    expect(openEdgeFade(60, 60)).toBe(0);
    expect(openEdgeFade(120, 60)).toBe(0);
    expect(openEdgeFade(0, 0)).toBe(0);
  });

  it('prevents converging fringe lanes and quarters from crossing an earlier lane', () => {
    const f = fixture();
    f.planned.push({ outer: box(330, 60, 380, 160), holes: [] });
    const id = f.streets.add([{ x: 340, y: 100 }, { x: 340, y: 160 }], 5, 2, 'radial', 1);
    f.streets.connected.add(id);
    const quarters = f.run();
    expect(quarters.length).toBeGreaterThan(0);
    expect(f.streets.list).toHaveLength(3);
    expect(f.streets.list[2].path[0]).toEqual({ x: 300, y: 200 });
    expect(f.streets.list.slice(2).some((s) => s.path[0].x === 340 && s.path[0].y === 160)).toBe(false);
  });

  it('cuts quarters around a bending regional road and an external reserved lot', () => {
    const f = fixture();
    const road = ribbon([{ x: 310, y: 250 }, { x: 320, y: 210 }, { x: 350, y: 210 }, { x: 380, y: 240 }], 6);
    const lot = box(315, 203, 335, 230);
    const quarters = f.run([{ outer: road, holes: [] }, { outer: lot, holes: [] }]);
    expect(quarters.length).toBeGreaterThan(0);
    expect(quarters.some((q) => polygonCentroid(q.lp.pts).y > 200)).toBe(true);
    for (const q of quarters) {
      expect(mpArea(intersectionS(q.lp.pts, road))).toBeLessThanOrEqual(0.02);
      expect(mpArea(intersectionS(q.lp.pts, lot))).toBeLessThanOrEqual(0.02);
    }
    const lane = f.streets.list.at(-1)!;
    expect(mpArea(intersectionS(ribbon(lane.path, lane.widths), road))).toBeLessThanOrEqual(0.02);
  });

  it('finds long protected roads and containing lots even when all corners are far away', () => {
    const road = fixture();
    expect(road.run(streetStrips([{ x: 330, y: 100 }, { x: 330, y: 400 }], 6))).toEqual([]);
    const lot = fixture();
    expect(lot.run([{ outer: box(290, 100, 500, 400), holes: [] }])).toEqual([]);
  });

  it('checks the first metres too when a parent dead-ends inside older land', () => {
    const f = fixture();
    f.streets.list[0].path[1].x = 296;
    expect(f.run()).toEqual([]);
  });

  it('keeps closed street circuits hollow and never grows from their arbitrary seam', () => {
    const f = fixture();
    f.streets.list[0].path = [{ x: 300, y: 200 }, { x: 280, y: 200 }, { x: 280, y: 240 }, { x: 300, y: 240 }, { x: 300, y: 200 }];
    f.streets.list[0].widths = f.streets.list[0].path.map(() => 5);
    expect(f.run()).toEqual([]);
    const strips = streetStrips(f.streets.list[0].path, 5);
    expect(mpArea(intersectionS(box(288, 215, 292, 225), strips))).toBe(0);
    expect(mpArea(intersectionS(box(299, 210, 301, 220), strips))).toBeGreaterThan(10);
  });

  it('preserves partitions, access and containment on the reported open-town shape', () => {
    const w = generate(makeOptions({ seed: 'p4uefz', size: 'town', culture: 'european-organic', walls: 'none', settlements: 'none' }));
    expect(Number(w.stats['urban.openFringe.quarters'])).toBeGreaterThan(0);
    // Check the actual transition rather than a counter for randomly emptied mature plots.
    const u = w.urban!;
    const fringeBlocks = new Set(u.blockInfo.flatMap((info, i) => info.kind === 'block' && info.zone === 'faubourg' ? [i] : []));
    const matureBlocks = new Set(u.blockInfo.flatMap((info, i) => info.kind === 'block' && ['core', 'middle'].includes(info.zone) ? [i] : []));
    const builtIn = (blocks: Set<number>) => u.buildings.reduce((sum, b) => sum + (b.parcel !== undefined && blocks.has(u.parcels[b.parcel].block) ? area(b.poly) : 0), 0);
    const areaOf = (blocks: Set<number>) => [...blocks].reduce((sum, i) => sum + area(u.blocks[i]), 0);
    const middleBlocks = new Set(u.blockInfo.flatMap((info, i) => info.kind === 'block' && info.zone === 'middle' ? [i] : []));
    expect(builtIn(middleBlocks) / areaOf(middleBlocks), 'open mature middle keeps its historical coverage target').toBeGreaterThanOrEqual(0.7);
    expect(builtIn(middleBlocks) / areaOf(middleBlocks)).toBeLessThanOrEqual(0.85);
    const fringePlots = u.parcels.map((p, i) => ({ p, i })).filter(({ p }) => p.use === 'plot' && fringeBlocks.has(p.block));
    const gardenPlots = fringePlots.filter(({ i }) => !u.buildings.some((b) => b.parcel === i));
    expect(fringeBlocks.size).toBeGreaterThan(0);
    expect(builtIn(fringeBlocks), 'served outlying dwellings remain').toBeGreaterThan(0);
    expect(builtIn(fringeBlocks) / areaOf(fringeBlocks), 'real outlying fabric is less dense than the mature town').toBeLessThan(builtIn(matureBlocks) / areaOf(matureBlocks));
    expect(gardenPlots.length, 'whole-plot gardens remain outside the mature phases').toBeGreaterThan(0);
    const fullGardenPlots = gardenPlots.filter(({ p }) => {
      const garden = u.backLand.reduce((sum, g) => sum + mpArea(intersectionS(g, p.poly)), 0);
      return garden >= 0.99 * area(p.poly);
    });
    expect(fullGardenPlots.length, 'whole-plot gaps have real garden geometry').toBeGreaterThan(0);
    const report = checkWorld(w);
    expect(report.blockOutside).toBeLessThanOrEqual(0.05);
    expect(report.blockAreaErr).toBeLessThanOrEqual(0.005);
    expect(report.overlapsBlocks).toBe(0);
    expect(report.overlapsPlots).toBe(0);
    expect(report.overlapsBuildings).toBe(0);
    expect(report.noFrontage).toBe(0);
    expect(report.bldgOutside).toBeLessThanOrEqual(0.05);
    expect(report.orphanMain).toBe(0);
    const forbiddenNatural = differenceS(w.urban!.footprintH, urbanNaturalGround(w));
    // The occupation mask permits natural cover, while agriculture and occupied urban land stay reserved.
    const naturalKinds = new Set(['forest', 'meadow', 'pasture', 'commons', 'marsh']);
    const landOverlap = w.landuse!.areas.reduce((sum, a) => sum + mpArea(intersectionS([{ outer: a.poly, holes: a.holes ?? [] }],
      naturalKinds.has(a.kind) ? forbiddenNatural : w.urban!.footprintH)), 0);
    expect(landOverlap).toBeLessThanOrEqual(0.05);
    expect(w.stats['landuse.ms.lu.vector']).toEqual(expect.any(Number));
    expect(Number(w.stats['landuse.lu.clipDropped'] ?? 0)).toBe(0);
  });

  it('respects explicitly disabled suburbs', () => {
    const w = generate(makeOptions({ seed: 'p4uefz', size: 'town', culture: 'european-organic', walls: 'none', settlements: 'none', suburbs: 'none' }));
    expect(Number(w.stats['urban.quarters'])).toBeGreaterThan(0);
    expect(w.stats['urban.openFringe.quarters']).toBeUndefined();
  });
});
