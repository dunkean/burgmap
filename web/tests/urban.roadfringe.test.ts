import { describe, expect, it, vi } from 'vitest';
import type { UrbanCtx } from '../src/gen/urban/context';
import { Rng } from '../src/gen/core/rng';
import { roadFringeGrowth, planFaubourgs, dilate, type RoadIn } from '../src/gen/urban/phases';
import * as phaseFunctions from '../src/gen/urban/phases';
import { joinVillages } from '../src/gen/urban/m4/suburbs';
import { addOpenFringe } from '../src/gen/urban/openfringe';
import { Streets } from '../src/gen/urban/streets';
import { resolveMorph } from '../src/gen/urban/morphology';
import { pointInRing } from '../src/gen/geo/poly';
import { intersectionS, tryDifference, mpArea, unionS, type MultiPoly } from '../src/gen/geo/bool';
import { ribbon } from '../src/gen/geo/offset';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { checkM4 } from './m4Check';
import '../src/gen/urban/cultures';

const box = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const inside = (m: MultiPoly, x: number, y: number) => m.some((p) => pointInRing(p.outer, { x, y }) && !p.holes.some((h) => pointInRing(h, { x, y })));
const ctx = { mapSize: 1600, water: [], isWater: () => false, slopeAt: () => 0.03, win: { x0: 0, y0: 0, x1: 1600, y1: 1600 } } as unknown as UrbanCtx;
const enclosure = [{ outer: box(100, 100, 300, 300), holes: [] }];
const roads: RoadIn[] = [{ path: [{ x: 700, y: 200 }, { x: 200, y: 200 }], major: true, width: 7 }];

describe('road fringe growth and attachment', () => {
  it('has deterministic no-growth and partial-growth cases without consuming the parent stream', () => {
    const manyRoads = [true, true, true, false, false].map((major) => ({ major }));
    expect(roadFringeGrowth(manyRoads, new Rng('0'))).toEqual(manyRoads.map(() => false));
    let partial = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const rng = new Rng(String(seed)), selected = roadFringeGrowth(manyRoads, rng);
      expect(selected).toEqual(roadFringeGrowth(manyRoads, new Rng(String(seed))));
      expect(rng.float()).toBe(new Rng(String(seed)).float());
      if (selected.some(Boolean) && selected.some((value) => !value)) partial++;
    }
    expect(partial).toBeGreaterThan(0);
    expect(planFaubourgs(ctx, enclosure, roads, 40000, 22, new Rng('0'))).toEqual({ region: [], paths: [] });
  });

  it('joins open districts directly and walled districts by a narrow public gate throat', () => {
    const open = planFaubourgs(ctx, enclosure, roads, 40000, 0, new Rng('fringe'));
    const wall = planFaubourgs(ctx, enclosure, roads, 40000, 22, new Rng('fringe'));
    expect(open.region.length).toBeGreaterThan(0);
    expect(wall.region.length).toBeGreaterThan(0);
    expect(inside(open.region, 311, 215)).toBe(true);
    expect(inside(wall.region, 311, 200)).toBe(true);
    expect(inside(wall.region, 311, 215)).toBe(false);
    expect(mpArea(intersectionS(open.region, enclosure))).toBeLessThanOrEqual(0.05);
    expect(mpArea(intersectionS(wall.region, enclosure))).toBeLessThanOrEqual(0.05);
    expect(unionS(enclosure, wall.region)).toHaveLength(1);
  });

  it('preserves gate throats when absorbed villages join, and leaves open settlements without an arbitrary gap', () => {
    const village = { c: { x: 500, y: 200 }, core: box(450, 150, 550, 250), road: [{ x: 200, y: 200 }, { x: 600, y: 200 }], roadWidth: 7 };
    const wall = planFaubourgs(ctx, enclosure, roads, 40000, 22, new Rng('fringe')).region;
    const joinedWall = joinVillages(wall, [village], enclosure, ctx, 22);
    const joinedOpen = joinVillages([], [village], enclosure, ctx, 0);
    expect(inside(joinedWall, 311, 200)).toBe(true);
    expect(inside(joinedWall, 311, 215)).toBe(false);
    expect(inside(joinedOpen, 311, 215)).toBe(true);
    expect(mpArea(intersectionS(joinedWall, enclosure))).toBeLessThanOrEqual(0.05);
    expect(mpArea(intersectionS(joinedOpen, enclosure))).toBeLessThanOrEqual(0.05);
  });

  it('never fills water across a gate approach, even with an uninformative raster sampler', () => {
    const water = [{ outer: box(305, 180, 316, 220), holes: [] }];
    const wetCtx = { ...ctx, water };
    const f = planFaubourgs(wetCtx, enclosure, roads, 40000, 22, new Rng('fringe'));
    expect(mpArea(intersectionS(f.region, water))).toBeLessThanOrEqual(0.05);
    expect(inside(f.region, 310, 200)).toBe(false);
  });

  it('allows an open town with no extra street-end extensions', () => {
    const streets = new Streets(), id = streets.add([{ x: 250, y: 200 }, { x: 300, y: 200 }], 5, 2, 'radial', 1);
    streets.connected.add(id);
    const primary = { quarters: [], market: null, radials: [id], walls: [], moat: [], footprint: enclosure, marketStreet: -1 };
    expect(addOpenFringe(ctx, primary, streets, 2, resolveMorph(undefined), 'european-organic', new Rng('0'))).toEqual([]);
    expect(streets.list).toHaveLength(1);
    expect(primary.footprint).toBe(enclosure);
  });

  it.each(['some', 'many', 'none'] as const)('honours explicit %s through the eager producer on viable land', (suburbs) => {
    const calls: { varying: boolean; region: MultiPoly }[] = [];
    const original = planFaubourgs;
    const spy = vi.spyOn(phaseFunctions, 'planFaubourgs').mockImplementation((...args) => {
      const result = original(...args);
      calls.push({ varying: args[8] ?? true, region: result.region });
      return result;
    });
    try {
      const world = generate(makeOptions({ seed: 'p4uefz', size: 'town', population: 2500, culture: 'european-organic', relief: 'flat', river: 'none', coast: 'none', walls: 'none', suburbs, settlements: 'none' }));
      if (suburbs === 'none') {
        expect(calls).toEqual([]);
        // Later enclosed historical phases can also be named faubourg; the option controls exterior growth.
        expect(world.stats['urban.openFringe.quarters']).toBeUndefined();
        expect((world.urban!.sites ?? []).some((s) => s.kind === 'absorbed-village')).toBe(false);
      } else {
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every((c) => !c.varying)).toBe(true);
        expect(mpArea(calls.at(-1)!.region)).toBeGreaterThan(1500);
        expect(world.urban!.quarters.some((q) => q.zone === 'faubourg')).toBe(true);
      }
    } finally { spy.mockRestore(); }
  });

  it.each(['single', 'double'] as const)('replans off-axis Chinese road throats after gate redirection with %s curtains and a moat', (walls) => {
    const calls: { roads: RoadIn[]; enclosure: MultiPoly; glacis: number; region: MultiPoly }[] = [];
    const original = planFaubourgs;
    const spy = vi.spyOn(phaseFunctions, 'planFaubourgs').mockImplementation((...args) => {
      const result = original(...args);
      calls.push({ roads: structuredClone(args[2]), enclosure: structuredClone(args[1]), glacis: args[4], region: result.region });
      return result;
    });
    try {
      const world = generate(makeOptions({ seed: 'p4uefz', size: 'town', population: 6000, culture: 'chinese', walls, moat: 'yes', suburbs: 'some', settlements: 'none' }));
      expect(calls.length).toBeGreaterThanOrEqual(2);
      const first = calls[0], final = calls.at(-1)!;
      expect(final.roads.map((r) => r.path)).toEqual(world.roads!.filter((r) => r.kind !== 'track').map((r) => r.path));
      expect(final.roads.map((r) => r.path)).not.toEqual(first.roads.map((r) => r.path));
      const neck = intersectionS(final.region, dilate(final.enclosure, final.glacis));
      expect(mpArea(neck)).toBeGreaterThan(1);
      const roadSpace = final.roads.flatMap((r) => [{ outer: ribbon(r.path, r.width ?? (r.major ? 7 : 5)), holes: [] }]);
      const excess = tryDifference(neck, roadSpace);
      expect(excess.failed).toBe(false);
      expect(mpArea(excess.pieces)).toBeLessThanOrEqual(0.05);
      expect(mpArea(intersectionS(final.region, final.enclosure))).toBeLessThanOrEqual(0.05);
      expect(world.urban!.walls!.length).toBeGreaterThanOrEqual(walls === 'double' ? 2 : 1);
      expect(world.urban!.walls!.some((w) => w.gates.length > 0)).toBe(true);
      const physical = checkM4(world);
      expect(physical.wetBlocks).toEqual([]);
      expect(physical.wetBuildings).toEqual([]);
      expect(physical.noAccess).toEqual([]);
    } finally { spy.mockRestore(); }
  });
});
