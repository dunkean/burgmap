import { describe, it, expect, vi } from 'vitest';
import polygonClipping from 'polygon-clipping';
import type { World, Polygon } from '../src/gen/types';
import type { Culture } from '../src/gen/urban/culture';
import { createGrid } from '../src/gen/core/grid';
import { makeOptions } from '../src/gen/options';
import { makeCtx } from '../src/gen/urban/context';
import { MORPHOLOGIES } from '../src/gen/urban/morphology';
import { assemble } from '../src/gen/urban/camps/index';
import { emptyCamp } from '../src/gen/urban/camps/kit';
import { splitHoles } from '../src/gen/urban/camps/kit';
import { openHoles } from '../src/gen/urban/plots';
import { buildPrimary, clipMarketToLand } from '../src/gen/urban/primary';
import { Streets } from '../src/gen/urban/streets';
import { Rng } from '../src/gen/core/rng';
import { dryPieces, wetArea, waterContains, waterNear, WATER_CLIP_STATS, WATER_CLIP_EPS } from '../src/gen/urban/waterland';
import { wallFeatures } from '../src/gen/urban/walls';
import { polylineLength, polygonArea } from '../src/gen/core/geom';
import { generate } from '../src/gen/pipeline';
import { megaQuarterDetail } from '../src/gen/urban/mega/detail';
import { area, isSimple } from '../src/gen/geo/poly';
import { difference, differenceS, tryIntersection, mpArea, BOOL_AREA_EPS } from '../src/gen/geo/bool';
import { checkWorld } from './urbanCheck';
import * as portLots from '../src/gen/urban/m4/port';
import * as activityLots from '../src/gen/urban/m4/activities';
import type { ReservedLot } from '../src/gen/urban/primary';
import touchingGeometry from './fixtures/urban.water.touching.json';
import { terrainForExtent, clipRiverAtWater } from '../src/gen/terrain/hydrology';

const box = (x0: number, y0: number, x1: number, y1: number): Polygon => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
function world(): World {
  const height = createGrid(100, 100, 10);
  return { mapSize: 1000, terrain: { height, slope: height, water: new Uint8Array(10000),
    lakes: [], coastline: [], rivers: [{ path: [{ x: 0, y: 500 }, { x: 1000, y: 500 }], width: [20, 20] }] },
    site: { center: { x: 500, y: 500 }, cost: height } } as unknown as World;
}
const culture = { id: 'test-dry', render: {} } as Culture;
/** Measure in the original coordinate frame; only aggregate floating-point noise is treated as zero. */
function exactIntersection(a: Parameters<typeof tryIntersection>[0], b: Parameters<typeof tryIntersection>[0]) {
  const result = tryIntersection(a, b);
  expect(result.failed).toBe(false);
  return mpArea(result.pieces) <= BOOL_AREA_EPS ? [] : result.pieces;
}

describe('complete water constraints', () => {
  it('proves the real p4uefz macro quarter 71 only touches its bank despite a distant-origin sweep failure', () => {
    const fromRaw = (geom: number[][][][]) => geom.map((poly) => ({
      outer: poly[0].slice(0, -1).map(([x, y]) => ({ x, y })),
      holes: poly.slice(1).map((ring) => ring.slice(0, -1).map(([x, y]) => ({ x, y }))),
    }));
    const land = fromRaw(touchingGeometry[0]), wet = fromRaw(touchingGeometry[1]);
    expect(isSimple(land[0].outer)).toBe(true);
    expect(wet.every((ph) => isSimple(ph.outer))).toBe(true);
    const result = tryIntersection(land, wet);
    expect(result.failed).toBe(false);
    expect(mpArea(result.pieces)).toBeLessThanOrEqual(BOOL_AREA_EPS);
  });

  it('preserves real positive wet overlap when an exact intersection retries in local coordinates', () => {
    const spy = vi.spyOn(polygonClipping, 'intersection').mockImplementationOnce(() => { throw new Error('synthetic distant-origin failure'); });
    try {
      const result = tryIntersection(box(2000, 3000, 2010, 3010), box(2004, 2999, 2006, 3011));
      expect(result.failed).toBe(false);
      expect(mpArea(result.pieces)).toBeCloseTo(20, 7);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
  });
  it('preserves a genuinely dry irregular quarter verbatim when its bbox overlaps distant water', () => {
    const q = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }];
    const wet = [{ outer: box(70, 70, 90, 90), holes: [] }];
    const dry = dryPieces(q, wet);
    expect(dry[0].outer).toBe(q);
    const part = emptyCamp();
    part.quarters = [q];
    part.blocks = [{ poly: box(10, 10, 25, 25), kind: 'block', quarter: 0 }];
    const u = assemble(world(), [part], culture, 'test', 100, 'hamlet', wet);
    expect(u.quarters[0].poly.outer).toBe(q);
    expect(u.blocks).toEqual(part.blocks.map((b) => b.poly));
  });

  it('keeps exact and grid-produced dry pieces idempotent under repeated water constraints', () => {
    const land = box(0.017, 0.031, 110.073, 100.039);
    const wet = [{ outer: [{ x: 30.001, y: -10.007 }, { x: 54.003, y: -10.007 },
      { x: 79.013, y: 110.017 }, { x: 40.009, y: 110.017 }], holes: [] }];
    const gridWater = [{ outer: box(30.001, -10.007, 54.003, 110.017), holes: [] }];
    const exact = dryPieces(land, wet), grid = differenceS(land, gridWater);
    expect(exact.length).toBeGreaterThan(0);
    for (const { pieces, water } of [{ pieces: exact, water: wet }, { pieces: grid, water: gridWater }]) {
      const again = dryPieces(pieces, water);
      expect(again).toBe(pieces);
      pieces.forEach((ph, i) => expect(again[i].outer).toBe(ph.outer));
    }
    const barelyTouching = [{ outer: box(9.999999999, -1, 20, 11), holes: [] }];
    const ring = box(0, 0, 10, 10);
    expect(dryPieces(ring, barelyTouching)[0].outer).toBe(ring);
  });

  it('recomputes water query geometry for mutable defensive arrays and changed coordinates', () => {
    const wet = [{ outer: box(20, 20, 30, 30), holes: [] }];
    const p = { x: 2, y: 5 };
    expect(waterNear(wet, p, 1)).toBe(false);
    expect(wetArea(box(0, 0, 10, 10), wet)).toBe(0);
    wet.push({ outer: box(0, 0, 5, 10), holes: [] });
    expect(waterContains(wet, p)).toBe(true);
    expect(wetArea(box(0, 0, 10, 10), wet)).toBeCloseTo(50, 7);
    for (const q of wet[1].outer) q.x += 100;
    expect(waterContains(wet, p)).toBe(false);
    expect(waterNear(wet, p, 1)).toBe(false);
    expect(wetArea(box(0, 0, 10, 10), wet)).toBe(0);
  });

  it('drops newly clipped 0.00001m² land slivers before they can become quarters or walls', () => {
    const land = box(400, 400, 410, 410), wet = [{ outer: box(400.000001, 399, 411, 411), holes: [] }];
    const dry = dryPieces(land, wet);
    expect(dry).toEqual([]);
    const ctx = makeCtx(world(), MORPHOLOGIES['european-organic'], 200);
    const phase = { id: 1, kind: 'core' as const, zone: 'core' as const, region: dry, band: dry, age: 1, fossil: false, walled: true, pop: 1000 };
    const prim = buildPrimary(ctx, { phases: [phase], enclosure: dry, walled: true, faubourg: [], roads: [], marketArea: 0,
      mainAngle: 0, extraRadials: false }, new Streets(), new Rng('no-sliver-wall'));
    expect(prim.quarters).toEqual([]);
    expect(prim.walls).toEqual([]);
    const alreadyDryTiny = box(0, 0, 0.001, 0.01);
    expect(dryPieces(alreadyDryTiny, wet)[0].outer).toBe(alreadyDryTiny);
  });

  it('keeps tiny interior water holes while discarding only land outer slivers', () => {
    const smallHole = box(2, 2, 2.0001, 2.002);
    const wet = [{ outer: box(9, -1, 11, 11), holes: [] }, { outer: smallHole, holes: [] }];
    const dry = dryPieces(box(0, 0, 10, 10), wet);
    expect(dry).toHaveLength(1);
    expect(dry[0].holes).toHaveLength(1);
    expect(area(dry[0].holes[0])).toBeGreaterThan(0);
    expect(area(dry[0].holes[0])).toBeCloseTo(area(smallHole), 10);
  });

  it('retries a failed whole-region subtraction locally and diagnoses any unprovable wet piece', () => {
    const land = [{ outer: box(0, 0, 10, 10), holes: [] }, { outer: box(20, 0, 30, 10), holes: [] }];
    const wet = [{ outer: box(4, -5, 6, 15), holes: [] }, { outer: box(24, -5, 26, 15), holes: [] }];
    const original = polygonClipping.difference;
    const spy = vi.spyOn(polygonClipping, 'difference').mockImplementation((a, ...rest) => {
      if (a.length > 1 || rest.some((b) => b.length > 1)) throw new Error('synthetic whole-region failure');
      return original(a, ...rest);
    });
    const retries = WATER_CLIP_STATS.retries;
    try {
      const safe = dryPieces(land, wet);
      expect(mpArea(safe)).toBeCloseTo(160, 3);
      expect(mpArea(exactIntersection(safe, wet))).toBe(0);
      expect(WATER_CLIP_STATS.retries).toBe(retries + 1);
      spy.mockImplementation(() => { throw new Error('synthetic local failure'); });
      const dropped = WATER_CLIP_STATS.droppedPieces;
      expect(dryPieces(land, wet)).toEqual([]);
      expect(WATER_CLIP_STATS.droppedPieces).toBeGreaterThan(dropped);
    } finally { spy.mockRestore(); }
  });

  it('bounds measured grid-retry bank residue across the complete result after a genuine exact failure', () => {
    const original = polygonClipping.difference;
    const spy = vi.spyOn(polygonClipping, 'difference').mockImplementation((a, ...rest) => {
      const offGrid = (value: unknown): boolean => typeof value === 'number'
        ? Math.abs(value * 1000 - Math.round(value * 1000)) > 1e-8
        : Array.isArray(value) && value.some(offGrid);
      if ([a, ...rest].some(offGrid)) {
        throw new Error('synthetic exact-only coincident-edge failure');
      }
      return original(a, ...rest);
    });
    const exactWetArea = (pieces: ReturnType<typeof dryPieces>, wet: Parameters<typeof dryPieces>[1]) => {
      const measured = tryIntersection(pieces, wet);
      expect(measured.failed).toBe(false);
      return mpArea(measured.pieces);
    };
    try {
      const small = [{ outer: box(4.99999, -1, 6, 11), holes: [] }];
      const retries = WATER_CLIP_STATS.snappedRetries, residue = WATER_CLIP_STATS.residualArea;
      const kept = dryPieces(box(0, 0, 10, 10), small);
      expect(kept.length).toBeGreaterThan(0);
      expect(exactWetArea(kept, small)).toBeGreaterThan(0);
      expect(exactWetArea(kept, small)).toBeLessThanOrEqual(WATER_CLIP_EPS);
      expect(WATER_CLIP_STATS.snappedRetries).toBeGreaterThan(retries);
      expect(WATER_CLIP_STATS.residualArea - residue).toBeCloseTo(0.0001, 7);
      const large = [{ outer: box(4.9996, -1, 6, 11), holes: [] }];
      expect(dryPieces(box(0, 0, 10, 10), large)).toEqual([]);
      const separate = [{ outer: box(0, 0, 10, 10), holes: [] }, { outer: box(20, 0, 30, 10), holes: [] }];
      const both = [{ outer: box(4.99992, -1, 6, 11), holes: [] }, { outer: box(24.99992, -1, 26, 11), holes: [] }];
      const safe = dryPieces(separate, both);
      expect(safe.length).toBeGreaterThan(0);
      expect(mpArea(safe)).toBeLessThan(180);
      expect(exactWetArea(safe, both)).toBeLessThanOrEqual(WATER_CLIP_EPS);
    } finally { spy.mockRestore(); }
  });

  it('keeps a channel crossing the window with no centreline vertex inside, and distant satellite water', () => {
    const w = world();
    w.terrain.lakes.push(box(850, 800, 880, 830));
    const ctx = makeCtx(w, MORPHOLOGIES['european-organic'], 80);
    expect(mpArea(exactIntersection(ctx.water, box(470, 490, 530, 510)))).toBeCloseTo(1200, 2);
    expect(mpArea(exactIntersection(ctx.water, box(850, 800, 880, 830)))).toBeCloseTo(900, 2);
    expect(makeCtx(w, MORPHOLOGIES['european-organic'], 200).water).toBe(ctx.water);
  });

  it('deeply freezes shared cached water without freezing or retaining terrain-owned rings', () => {
    const w = world();
    w.terrain.rivers = [];
    const lake = box(470, 470, 530, 530).reverse();
    w.terrain.lakes = [lake];
    const cached = makeCtx(w, MORPHOLOGIES['european-organic'], 80).water;
    expect(Object.isFrozen(cached)).toBe(true);
    for (const ph of cached) {
      expect(Object.isFrozen(ph)).toBe(true);
      expect(Object.isFrozen(ph.holes)).toBe(true);
      for (const ring of [ph.outer, ...ph.holes]) {
        expect(Object.isFrozen(ring)).toBe(true);
        expect(ring.every((p) => Object.isFrozen(p))).toBe(true);
      }
    }
    expect(cached[0].outer).not.toBe(lake);
    expect(polygonArea(cached[0].outer)).toBeGreaterThan(0);
    expect(polygonArea(lake)).toBeLessThan(0);
    expect(Object.isFrozen(lake)).toBe(false);
    expect(Object.isFrozen(lake[0])).toBe(false);
    expect(() => cached[0].outer.push({ x: 0, y: 0 })).toThrow();
    expect(makeCtx(w, MORPHOLOGIES['european-organic'], 200).water).toBe(cached);
  });

  it('opens a market around an internal lake before its nucleus quarter and ring enter the graph', () => {
    const w = world();
    w.terrain.rivers = [];
    const lake = box(490, 490, 510, 510);
    w.terrain.lakes = [lake];
    const ctx = makeCtx(w, MORPHOLOGIES['european-organic'], 200);
    const core = [{ outer: box(400, 400, 600, 600), holes: [lake] }];
    const candidate = box(450, 450, 550, 550);
    const market = clipMarketToLand(candidate, core, ctx.water, 10000)!;
    expect(market).not.toBeNull();
    expect(mpArea(exactIntersection(market, ctx.water))).toBe(0);
    expect(area(market)).toBeGreaterThan(4000);
    const phase = { id: 1, kind: 'core' as const, zone: 'core' as const, region: core, band: core, age: 1, fossil: false, walled: false, pop: 1000 };
    const prim = buildPrimary(ctx, { phases: [phase], enclosure: core, walled: false, faubourg: [], roads: [], marketArea: 10000, mainAngle: 0, extraRadials: false }, new Streets(), new Rng('lake-market'));
    expect(prim.market).not.toBeNull();
    for (const q of prim.quarters) expect(mpArea(exactIntersection(q.lp.pts, ctx.water))).toBe(0);
    expect(prim.quarters.some((q) => q.kind === 'market')).toBe(true);
  });

  it('rebuilds terrestrial reserved compound subjects after a water cut while retaining a real pier', () => {
    const w = world();
    w.terrain.rivers = [];
    const lake = box(500, 450, 520, 600);
    w.terrain.lakes = [lake];
    const ctx = makeCtx(w, MORPHOLOGIES['european-organic'], 200);
    const region = [{ outer: box(400, 400, 650, 650), holes: [] }];
    const phase = { id: 1, kind: 'core' as const, zone: 'core' as const, region, band: region, age: 1, fossil: false, walled: false, pop: 1000 };
    const landLot = { id: 'palace', kind: 'm4-palace', poly: box(480, 480, 540, 540), phase: 1, zone: 'core' as const, cuts: [] };
    const pierLot = { id: 'pier', kind: 'm4-pier', poly: box(498, 560, 530, 570), phase: 1, zone: 'core' as const, cuts: [], piece: 'place' as const };
    const prim = buildPrimary(ctx, { phases: [phase], enclosure: region, walled: false, faubourg: [], roads: [], marketArea: 0,
      mainAngle: 0, extraRadials: false, reserve: () => [landLot, pierLot] }, new Streets(), new Rng('lake-compound'));
    const palace = prim.quarters.filter((q) => q.lot === 'palace');
    expect(palace.length).toBeGreaterThan(0);
    expect(mpArea(exactIntersection(landLot.poly, ctx.water))).toBe(0);
    for (const q of palace) {
      expect(mpArea(exactIntersection(q.lp.pts, ctx.water))).toBe(0);
      expect(mpArea(differenceS(q.lp.pts, landLot.poly))).toBeLessThan(0.05);
    }
    const pier = prim.quarters.find((q) => q.lot === 'pier')!;
    expect(pier).toBeDefined();
    expect(mpArea(exactIntersection(pier.lp.pts, ctx.water))).toBeGreaterThan(1);
  });

  it('keeps the approached dry compound piece and updates all original ring references', () => {
    const w = world();
    w.terrain.rivers = [];
    w.terrain.lakes = [box(500, 450, 520, 650)];
    const ctx = makeCtx(w, MORPHOLOGIES['european-organic'], 200);
    const region = [{ outer: box(400, 400, 700, 700), holes: [] }];
    const phase = { id: 1, kind: 'core' as const, zone: 'core' as const, region, band: region, age: 1, fossil: false, walled: false, pop: 1000 };
    const approach = [{ x: 450, y: 520 }, { x: 480, y: 520 }];
    const lot: ReservedLot = { id: 'served-palace', kind: 'm4-palace', poly: box(480, 480, 600, 560), phase: 1, zone: 'core', cuts: [approach] };
    const registryRing = lot.poly;
    const streets = new Streets();
    const prim = buildPrimary(ctx, { phases: [phase], enclosure: region, walled: false, faubourg: [], roads: [], marketArea: 0,
      mainAngle: 0, extraRadials: false, reserve: () => {
        const id = streets.add(approach, 4, 2, 'street', 1); streets.connected.add(id);
        return [lot];
      } }, streets, new Rng('served-lake-compound'));
    expect(lot.poly).toBe(registryRing);
    expect(Math.max(...registryRing.map((p) => p.x))).toBeLessThanOrEqual(500);
    expect(mpArea(exactIntersection(lot.poly, ctx.water))).toBe(0);
    const kept = prim.quarters.filter((q) => q.lot === lot.id);
    expect(kept.length).toBeGreaterThan(0);
    for (const q of kept) expect(mpArea(difference(q.lp.pts, registryRing))).toBeLessThan(0.02);
  });

  it('preserves an unchanged dry lot whose connector runs alongside it at street half-width', () => {
    const w = world();
    w.terrain.rivers = [];
    const ctx = makeCtx(w, MORPHOLOGIES['european-organic'], 200);
    const region = [{ outer: box(400, 400, 700, 700), holes: [] }];
    const phase = { id: 1, kind: 'core' as const, zone: 'core' as const, region, band: region, age: 1, fossil: false, walled: false, pop: 1000 };
    const approach = [{ x: 478, y: 465 }, { x: 478, y: 575 }];
    const lot: ReservedLot = { id: 'dry-palace', kind: 'm4-palace', poly: box(480, 480, 540, 560), phase: 1, zone: 'core', cuts: [approach] };
    const ring = lot.poly, before = ring.map((p) => ({ ...p })), streets = new Streets();
    const prim = buildPrimary(ctx, { phases: [phase], enclosure: region, walled: false, faubourg: [], roads: [], marketArea: 0,
      mainAngle: 0, extraRadials: false, reserve: () => {
        const id = streets.add(approach, 4, 2, 'street', 1); streets.connected.add(id);
        return [lot];
      } }, streets, new Rng('dry-parallel-compound'));
    expect(lot.poly).toBe(ring);
    expect(lot.poly).toEqual(before);
    expect(prim.quarters.some((q) => q.lot === lot.id)).toBe(true);
  });

  it('preserves earlier reserved-lot exclusions when a wet band is clipped again off-grid', () => {
    const w = world();
    w.terrain.rivers = [];
    w.terrain.lakes = [box(450, 450, 500.00031, 650)];
    const ctx = makeCtx(w, MORPHOLOGIES['european-organic'], 200);
    const region = [{ outer: box(400, 400, 700, 700), holes: [] }];
    const phase = { id: 1, kind: 'core' as const, zone: 'core' as const, region, band: region, age: 1, fossil: false, walled: false, pop: 1000 };
    const early: ReservedLot = { id: 'first-palace', kind: 'm4-palace', poly: box(540, 500, 620, 540), phase: 1, zone: 'core',
      cuts: [[{ x: 650, y: 520 }, { x: 620, y: 520 }]] };
    const later: ReservedLot = { id: 'wet-palace', kind: 'm4-palace', poly: box(480, 480, 600, 560), phase: 1, zone: 'core',
      cuts: [[{ x: 530, y: 460 }, { x: 530, y: 480 }]] };
    const streets = new Streets();
    const prim = buildPrimary(ctx, { phases: [phase], enclosure: region, walled: false, faubourg: [], roads: [], marketArea: 0,
      mainAngle: 0, extraRadials: false, reserve: () => {
        for (const lot of [early, later]) for (const path of lot.cuts) {
          const id = streets.add(path, 4, 2, 'street', 1); streets.connected.add(id);
        }
        return [early, later];
      } }, streets, new Rng('overlapping-wet-reservations'));
    const a = prim.quarters.filter((q) => q.lot === early.id), b = prim.quarters.filter((q) => q.lot === later.id);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    for (const one of a) for (const two of b) expect(mpArea(exactIntersection(one.lp.pts, two.lp.pts))).toBe(0);
    for (const q of b) {
      expect(mpArea(exactIntersection(q.lp.pts, ctx.water))).toBe(0);
      expect(mpArea(difference(q.lp.pts, later.poly))).toBeLessThan(0.02);
      expect(mpArea(exactIntersection(q.lp.pts, early.poly))).toBe(0);
    }
  });

  it('never fills unresolved holes when a geometry split reaches its bounded retry limit', () => {
    const ph = { outer: box(0, 0, 100, 100), holes: [box(40, 40, 60, 60)] };
    expect(openHoles(ph, 5)).toEqual([]);
    expect(splitHoles(ph, 4)).toEqual([]);
    for (const piece of openHoles(ph)) expect(mpArea(exactIntersection(piece, ph.holes[0]))).toBe(0);
    for (const piece of splitHoles(ph)) expect(mpArea(exactIntersection(piece, ph.holes[0]))).toBe(0);
  });

  it('opens a restored water hole without rounding its shared off-grid outer bank', () => {
    const bank = 500.00031;
    const ph = { outer: box(bank, 450, 600, 650), holes: [box(530.00017, 500, 550.00029, 560)] };
    const wet = [{ outer: box(450, 440, bank, 660), holes: [] }, { outer: ph.holes[0], holes: [] }];
    const pieces = openHoles(ph, 0, true);
    expect(pieces.length).toBeGreaterThan(1);
    expect(Math.min(...pieces.flatMap((p) => p.outer.map((v) => v.x)))).toBe(bank);
    expect(mpArea(pieces)).toBeCloseTo(mpArea([ph]), 7);
    for (const piece of pieces) {
      expect(piece.holes).toEqual([]);
      expect(mpArea(exactIntersection(piece, wet))).toBe(0);
    }
  });

  it('retains dry sea islands without clearing channels running across them', () => {
    const w = world();
    w.terrain.coastline = [box(0, 0, 1000, 1000)];
    w.terrain.islands = [box(400, 400, 600, 600)];
    const ctx = makeCtx(w, MORPHOLOGIES['european-organic'], 80);
    expect(mpArea(exactIntersection(ctx.water, box(420, 420, 450, 450)))).toBe(0);
    expect(mpArea(exactIntersection(ctx.water, box(470, 490, 530, 510)))).toBeCloseTo(1200, 2);
  });

  it('classifies actual imported-heightmap islands by nesting, independently of marching-square winding', () => {
    const n = 384, rgba = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const px = (x + 0.5) * 40000 / n, py = (y + 0.5) * 40000 / n;
      const dry = px < 20500 + 700 * Math.sin(py / 2400) || Math.hypot((px - 30000) / 5000, (py - 20500) / 6500) < 1 || Math.hypot(px - 36000, py - 9000) < 1000;
      const i = (y * n + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = dry ? 140 : 15;
      rgba[i + 3] = 255;
    }
    const options = makeOptions({ seed: 'islands-water-v7', mapSize: 40000, coast: 'E', river: 'none', settlements: 'none',
      importedHeight: { w: n, h: n, rgba }, importSea: 35 });
    (options as typeof options & { lakes: string }).lakes = 'none';
    const { terrain } = terrainForExtent(options, 40000);
    const center = { x: 30000, y: 20500 };
    const w = { seed: options.seed, options, mapSize: 40000, terrain, site: { center, cost: terrain.height }, stats: {} } as World;
    const ctx = makeCtx(w, MORPHOLOGIES['european-organic'], 1000);
    expect(terrain.islands).toHaveLength(2);
    expect(terrain.water[Math.floor(center.y / terrain.height.cell) * terrain.height.w + Math.floor(center.x / terrain.height.cell)]).toBe(0);
    expect(waterContains(ctx.water, center)).toBe(false);
    expect(waterContains(ctx.water, { x: 36000, y: 9000 })).toBe(false);
    expect(waterContains(ctx.water, { x: 23000, y: 20500 })).toBe(true);
    expect(dryPieces(box(29000, 19500, 31000, 21500), ctx.water)).toHaveLength(1);
  }, 120000);

  it('retains an island river until its true inner shoreline and still clips an island lake', () => {
    const sea = [box(0, 0, 1000, 1000)], islands = [box(400, 400, 600, 600)];
    const river = { path: [{ x: 450, y: 500 }, { x: 550, y: 500 }, { x: 750, y: 500 }], width: [10, 10, 10] };
    const clipped = clipRiverAtWater(river, sea, islands)!;
    expect(clipped).not.toBeNull();
    expect(clipped.path[0]).toEqual(river.path[0]);
    expect(clipped.path.at(-1)!.x).toBeCloseTo(600, 3);
    const lakeClipped = clipRiverAtWater(clipped, [box(525, 480, 560, 520)])!;
    expect(lakeClipped.path.at(-1)!.x).toBeCloseTo(525, 3);
  });

  it('keeps an island town ring street and its complete dry curtains, while recognising its inner shore', () => {
    const w = world();
    w.terrain.rivers = [];
    w.terrain.coastline = [box(0, 0, 1000, 1000)];
    w.terrain.islands = [box(200, 200, 800, 800)];
    const ctx = makeCtx(w, MORPHOLOGIES['european-organic'], 400);
    expect(waterContains(ctx.water, { x: 500, y: 500 })).toBe(false);
    expect(waterNear(ctx.water, { x: 202, y: 500 }, 4)).toBe(true);
    expect(waterNear(ctx.water, { x: 190, y: 500 }, 4)).toBe(true);
    expect(waterNear(ctx.water, { x: 300, y: 300 }, 4)).toBe(false);
    const inner = [{ outer: box(400, 400, 600, 600), holes: [] }], outer = [{ outer: box(300, 300, 700, 700), holes: [] }];
    const phases = [
      { id: 1, kind: 'core' as const, zone: 'core' as const, region: inner, band: inner, age: 1, fossil: true, walled: false, pop: 300 },
      { id: 2, kind: 'ring' as const, zone: 'middle' as const, region: outer, band: differenceS(outer, inner), age: 0.5, fossil: false, walled: true, pop: 700 },
    ];
    const streets = new Streets();
    const prim = buildPrimary(ctx, { phases, enclosure: outer, walled: true, faubourg: [], roads: [], marketArea: 400,
      mainAngle: 0, extraRadials: false }, streets, new Rng('dry-island'));
    expect(streets.list.some((st) => st.role === 'ring' && st.phase === 1 && polylineLength(st.path) > 500)).toBe(true);
    expect(prim.walls).toHaveLength(1);
    const walls = wallFeatures(prim.walls[0].ring, [], new Rng('wall'), (p) => waterContains(ctx.water, p), (p) => waterNear(ctx.water, p, 4));
    expect(walls.curtains.length).toBeGreaterThan(4);
    expect(walls).toEqual(wallFeatures(prim.walls[0].ring, [], new Rng('wall'), () => false, () => false));
  });

  it('splits a river-straddling camp quarter while preserving its served blocks, parcels and houses', () => {
    const part = emptyCamp();
    part.quarters = [box(0, 0, 100, 100)];
    part.blocks = [{ poly: box(0, 0, 40, 100), kind: 'block', quarter: 0 }, { poly: box(60, 0, 100, 100), kind: 'block', quarter: 0 }];
    part.parcels = part.blocks.map((b, block) => ({ poly: b.poly, block, use: 'plot' }));
    part.buildings = [{ poly: box(5, 5, 35, 30), kind: 'house', parcel: 0 }, { poly: box(65, 5, 95, 30), kind: 'house', parcel: 1 }];
    const water = [{ outer: box(40, -10, 60, 110), holes: [] }];
    const u = assemble(world(), [part], culture, 'test', 100, 'hamlet', water);
    expect(u.quarters).toHaveLength(2);
    expect(u.blocks).toEqual(part.blocks.map((b) => b.poly));
    expect(u.buildings).toEqual(part.buildings);
    expect(u.parcels.map((p) => p.poly)).toEqual(part.parcels.map((p) => p.poly));
    expect(u.quarters.reduce((sum, q) => sum + mpArea([q.poly]), 0)).toBeCloseTo(8000, 2);
    for (const q of u.quarters) {
      expect(mpArea(exactIntersection(q.poly, water))).toBe(0);
      const blocks = u.blocks.filter((_, i) => u.blockInfo[i].quarter === u.quarters.indexOf(q));
      expect(blocks.reduce((sum, b) => sum + area(b), 0) + mpArea(q.streetSpace)).toBeCloseTo(mpArea([q.poly]), 2);
    }
  });

  it('preserves non-mm shared irregular edges and their boundary block beside a wet quarter cut', () => {
    const part = emptyCamp();
    const q = [{ x: 0.00031, y: 0.00027 }, { x: 210.27139, y: 3.82317 },
      { x: 203.62641, y: 197.78123 }, { x: -6.17129, y: 186.73163 }];
    const at = (a: Polygon[number], b: Polygon[number], t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const block = [q[0], at(q[0], q[1], 0.4), at(q[3], q[2], 0.4), q[3]];
    part.quarters = [q];
    part.blocks = [{ poly: block, kind: 'block', quarter: 0 }];
    part.parcels = [{ poly: block, block: 0, use: 'plot' }];
    part.buildings = [{ poly: box(10, 20, 45, 60), kind: 'house', parcel: 0 }];
    const wet = [{ outer: box(150.19237, -10, 165.78129, 220), holes: [] }];
    const u = assemble(world(), [part], culture, 'test', 100, 'hamlet', wet);
    expect(u.quarters).toHaveLength(2);
    expect(u.blocks).toEqual([block]);
    expect(u.parcels.map((p) => p.poly)).toEqual([block]);
    expect(u.buildings).toEqual(part.buildings);
    const parent = u.quarters[u.blockInfo[0].quarter];
    expect(mpArea(difference(block, parent.poly))).toBe(0);
    expect(mpArea(exactIntersection(parent.poly, wet))).toBe(0);
    expect(area(block) + mpArea(parent.streetSpace)).toBeCloseTo(mpArea([parent.poly]), 7);
  });

  it('does not fill an internal lake, even when a layout only tested dry polygon vertices', () => {
    const part = emptyCamp();
    part.quarters = [box(0, 0, 100, 100)];
    part.blocks = [{ poly: box(10, 10, 90, 90), kind: 'block', quarter: 0 }];
    part.parcels = [{ poly: part.blocks[0].poly, block: 0, use: 'plot' }];
    part.buildings = [{ poly: box(40, 40, 60, 60), kind: 'house', parcel: 0 }];
    const water = [{ outer: box(40, 40, 60, 60), holes: [] }];
    const u = assemble(world(), [part], culture, 'test', 100, 'hamlet', water);
    expect(u.quarters[0].poly.holes).toHaveLength(1);
    expect(mpArea(exactIntersection(u.quarters[0].poly, water))).toBe(0);
    expect(u.blocks).toHaveLength(0);
    expect(u.parcels).toHaveLength(0);
    expect(u.buildings).toHaveLength(0);
  });

  it.each(['european-organic', 'japanese-jokamachi', 'roman-core', 'maya', 'native-plains', 'norse-ringfort', 'orcish', 'khmer'])('keeps %s eager quarters and houses off natural water', (culture) => {
    const w = generate(makeOptions({ seed: 'p4uefz', size: 'town', culture, coast: 'E', river: 'major', settlements: 'none' }));
    const u = w.urban!, wet = makeCtx(w, MORPHOLOGIES['european-organic'], w.mapSize).water;
    const c = w.site!.center;
    expect(mpArea(exactIntersection(wet, box(c.x - 500, c.y - 500, c.x + 500, c.y + 500)))).toBeGreaterThan(1);
    expect(u.buildings.length).toBeGreaterThan(10);
    const aquatic = new Set(['quay', 'pier', 'slipway', 'bridge']);
    for (const q of u.quarters) {
      if (u.parcels.some((p) => aquatic.has(p.use) && mpArea(exactIntersection(p.poly, q.poly)) > 1)) continue;
      expect(mpArea(exactIntersection(q.poly, wet))).toBeLessThan(0.05);
    }
    for (const p of u.parcels) if (!aquatic.has(p.use)) expect(mpArea(exactIntersection(p.poly, wet))).toBeLessThan(0.05);
    for (const b of u.buildings) if (b.parcel === undefined || !aquatic.has(u.parcels[b.parcel].use)) expect(mpArea(exactIntersection(b.poly, wet))).toBeLessThan(0.05);
    const r = checkWorld(w), msg = r.details.slice(0, 12).join('\n');
    expect(r.blockAreaErr, msg).toBeLessThanOrEqual(0.005);
    expect(r.overlapsPlots, msg).toBe(0);
    expect(r.noFrontage, msg).toBe(0);
    expect(r.bldgOutside, msg).toBeLessThan(0.05);
  }, 600000);

  it.each([
    { seed: '7', coast: 'E' as const, siteType: 'harbor' as const, expected: ['m4-quay', 'm4-pier', 'm4-slipway'] },
    { seed: '2', coast: 'none' as const, siteType: 'auto' as const, expected: ['m4-watermill'] },
  ])('retains the actual port and river activity reservations for seed $seed', (options) => {
    const reserved: ReservedLot[] = [];
    const port = portLots.reservePort, mills = activityLots.reserveMills;
    const portSpy = vi.spyOn(portLots, 'reservePort').mockImplementation((...args) => {
      const lots = port(...args); reserved.push(...lots); return lots;
    });
    const millSpy = vi.spyOn(activityLots, 'reserveMills').mockImplementation((...args) => {
      const lots = mills(...args); reserved.push(...lots); return lots;
    });
    try {
      const w = generate(makeOptions({ seed: options.seed, size: 'city', coast: options.coast, siteType: options.siteType,
        port: 'yes', activities: 'yes', settlements: 'none' }));
      const use: Record<string, string> = { 'm4-quay': 'quay', 'm4-pier': 'pier', 'm4-slipway': 'slipway', 'm4-watermill': 'mill' };
      for (const kind of options.expected) {
        const planned = reserved.filter((lot) => lot.kind === kind && area(lot.poly) > 20);
        expect(planned.length, `${kind}: real producer must exercise the feature`).toBeGreaterThan(0);
        const parcels = w.urban!.parcels.filter((p) => p.use === use[kind]);
        expect(parcels.length, `${kind}: preserve structure count after water clipping`).toBeGreaterThanOrEqual(planned.length);
        for (const lot of planned) expect(parcels.some((p) => mpArea(exactIntersection(p.poly, lot.poly)) > 20), `${lot.id}: reserved structure survives`).toBe(true);
      }
      const wet = makeCtx(w, MORPHOLOGIES['european-organic'], w.mapSize).water;
      for (const p of w.urban!.parcels.filter((p) => p.use === 'mill' || p.use === 'mill-yard')) expect(mpArea(exactIntersection(p.poly, wet))).toBeLessThan(0.05);
    } finally { portSpy.mockRestore(); millSpy.mockRestore(); }
  }, 600000);

  it('keeps macro quarters and lazy buildings dry on the side of the map beyond the context window', () => {
    const w = generate(makeOptions({ seed: 'p4uefz', mapSize: 4000, population: 400000, siteType: 'harbor', culture: 'european-organic', coast: 'E', river: 'major', settlements: 'none' }));
    const wet = makeCtx(w, MORPHOLOGIES['european-organic'], w.mapSize).water;
    const macro = w.urban!.macro!;
    expect(macro.quarters.length).toBeGreaterThan(20);
    for (const q of macro.quarters) expect(mpArea(exactIntersection(q.pts, wet))).toBeLessThan(0.05);
    // Detail both central and distant quarters, rather than only the easy dry nucleus.
    const local = makeCtx(w, MORPHOLOGIES['european-organic'], 400), win = local.win;
    expect(local.water).toBe(makeCtx(w, MORPHOLOGIES['european-organic'], macro.ctxRadius).water);
    const selected = macro.quarters.filter((q) => q.kind === 'quarter');
    const outside = selected.filter((q) => q.bb[2] < win.x0 || q.bb[3] < win.y0 || q.bb[0] > win.x1 || q.bb[1] > win.y1);
    expect(outside.length).toBeGreaterThan(0);
    const distantBank = outside.find((q) => wetArea(box(q.bb[0] - 50, q.bb[1] - 50, q.bb[2] + 50, q.bb[3] + 50), wet) > 100);
    const central = selected.find((q) => q.bb[0] >= win.x0 && q.bb[1] >= win.y0 && q.bb[2] <= win.x1 && q.bb[3] <= win.y1);
    expect(distantBank).toBeDefined();
    expect(central).toBeDefined();
    for (const q of [distantBank!, central!]) {
      const detail = megaQuarterDetail(w, q.id)!;
      expect(detail.buildings.length).toBeGreaterThan(10);
      for (const b of detail.buildings) expect(mpArea(exactIntersection(b.poly, wet))).toBeLessThan(0.05);
      for (const p of detail.parcels) expect(mpArea(differenceS(p.poly, q.pts))).toBeLessThan(0.05);
    }
  }, 600000);
});
