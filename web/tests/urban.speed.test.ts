import { describe, expect, it, vi } from 'vitest';
import type { Polygon } from '../src/gen/core/geom';
import { bboxOf } from '../src/gen/geo/poly';
import { blockReach } from '../src/gen/urban/access';
import { PolygonIndex } from '../src/gen/urban/polygonIndex';
import { makeHullRectangleOverlap } from '../src/gen/urban/roofRetention';
import { Rng } from '../src/gen/core/rng';
import { tryIntersection, mpArea } from '../src/gen/geo/bool';
import * as booleanFunctions from '../src/gen/geo/bool';
import { makeGardenOpening } from '../src/gen/urban/gardenProof';
import { makeObstacleSelection } from '../src/gen/urban/obstacleIndex';
import { makeDensityProofMemo, repairResidentialDensity, type DensityRepairPartition } from '../src/gen/urban/densityRepair';
import type { UrbanCtx } from '../src/gen/urban/context';
import { Streets } from '../src/gen/urban/streets';
import { MORPHOLOGIES } from '../src/gen/urban/morphology';
import * as accessFunctions from '../src/gen/urban/access';

const box = (x0: number, y0: number, x1: number, y1: number): Polygon => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];
const brute = (polygons: Polygon[], subject: Polygon, touching: boolean): number[] => {
  const a = bboxOf(subject);
  return polygons.flatMap((p, i) => {
    const b = bboxOf(p);
    const meets = touching ? !(a.x0 > b.x1 || a.x1 < b.x0 || a.y0 > b.y1 || a.y1 < b.y0)
      : !(a.x0 >= b.x1 || a.x1 <= b.x0 || a.y0 >= b.y1 || a.y1 <= b.y0);
    return meets ? [i] : [];
  });
};

function densityFixture(): DensityRepairPartition {
  const poly = box(100, 103, 112, 123), roof = box(100, 103, 110, 110), streets = new Streets();
  streets.add([{ x: 90, y: 100 }, { x: 130, y: 100 }], 6, 1, 'radial', 2);
  return {
    ctx: { mapSize: 1000, isWater: () => false, slopeAt: () => 0.02 } as unknown as UrbanCtx,
    blocks: [{ poly, phase: 2, zone: 'middle', quarter: 0, kind: 'block', age: 0.5 }],
    parcels: [{ poly, block: 0, use: 'plot', zone: 'middle', front: [poly[0], poly[1]] }],
    buildings: [{ poly: roof, parcel: 0, kind: 'house', roof: 'gable' }],
    gardens: [box(100, 110, 112, 123), box(110, 103, 112, 110)], streets,
    protectedLand: [], eligible: () => true, morphology: () => MORPHOLOGIES['european-organic'],
  };
}

describe('urban proposal acceleration', () => {
  it('retries unknown physical results, reuses proved refusals and rechecks changed candidate coordinates', () => {
    const obstacle = box(6, 6, 12, 12), candidate = box(0, 0, 10, 10);
    const proof = makeDensityProofMemo((poly) => {
      const result = booleanFunctions.tryIntersection(poly, obstacle);
      return result.failed ? 'unknown' : mpArea(result.pieces) > 1e-6 ? 'refused' : 'proved';
    });
    const spy = vi.spyOn(booleanFunctions, 'tryIntersection').mockReturnValueOnce({ pieces: [], failed: true });
    try {
      expect(proof(candidate)).toBe('unknown');
      expect(proof(candidate)).toBe('refused');
      expect(proof(candidate.map((p) => ({ ...p })))).toBe('refused');
      expect(spy).toHaveBeenCalledTimes(2);
      candidate[1].x = 5; candidate[2].x = 5;
      expect(proof(candidate)).toBe('proved'); expect(spy).toHaveBeenCalledTimes(3);
    } finally { spy.mockRestore(); }
  });

  it('propagates repeated proof exceptions without remembering an unproved outcome', () => {
    const prove = vi.fn((): 'proved' => { throw new Error('unproved physical operation'); });
    const proof = makeDensityProofMemo(prove), candidate = box(0, 0, 10, 10);
    expect(() => proof(candidate)).toThrow('unproved physical operation');
    expect(() => proof(candidate)).toThrow('unproved physical operation');
    expect(prove).toHaveBeenCalledTimes(2);
  });

  it('skips empty revisits after the immutable roof growth cap is fully spent', () => {
    const input = densityFixture(), oldArea = 70, waterCalls = [0, 0, 0];
    let sweep = -1;
    input.eligible = () => { sweep++; return true; };
    input.ctx.isWater = () => { waterCalls[sweep]++; return false; };
    const result = repairResidentialDensity(input);
    expect(result.enlarged).toBe(1); expect(sweep).toBe(2);
    expect(result.groups[0].after).toBeCloseTo(1.3 * oldArea, 6);
    expect(result.groups[0].shortfall).toBeCloseTo(0.7 * 240 - 1.3 * oldArea, 6);
    expect(waterCalls[0]).toBeGreaterThan(0); expect(waterCalls.slice(1)).toEqual([0, 0]);
    expect(input.buildings).toHaveLength(1);
  });

  it('rejects an over-cap base before performing block or physical proofs', () => {
    const input = densityFixture();
    input.buildings[0].poly = [{ x: 100, y: 103 }, { x: 110, y: 103 }, { x: 100, y: 110 }];
    const before = JSON.stringify([input.buildings, input.parcels, input.blocks, input.gardens]);
    const spy = vi.spyOn(accessFunctions, 'blockReach');
    try {
      expect(repairResidentialDensity(input).enlarged).toBe(0);
      expect(spy).not.toHaveBeenCalled();
      expect(JSON.stringify([input.buildings, input.parcels, input.blocks, input.gardens])).toBe(before);
    } finally { spy.mockRestore(); }
  });

  it('preserves checked differences and intersections after ordered obstacle selection, including no nearby clips', () => {
    const near = { outer: box(6, 6, 14, 14), holes: [box(7, 7, 8, 8)] };
    const far = { outer: box(1000, 1000, 1010, 1010), holes: [] };
    const obstacles = [{ outer: box(-300, -300, -200, -200), holes: [] }, near, far,
      { outer: [{ x: 0, y: 0 }], holes: [] }, { outer: box(10 + 1e-6, 0, 12, 5), holes: [] }];
    const select = makeObstacleSelection(obstacles);
    for (const subject of [box(0, 0, 10, 10), box(200, 200, 210, 210),
      [{ x: 200, y: 200 }, { x: 205, y: 200 }, { x: 210, y: 200 }, { x: 210, y: 210 }, { x: 200, y: 210 }]]) {
      expect(booleanFunctions.tryDifference(subject, [], select(subject))).toEqual(booleanFunctions.tryDifference(subject, [], obstacles));
      expect(tryIntersection(subject, select(subject))).toEqual(tryIntersection(subject, obstacles));
    }
    expect(select(box(0, 0, 10, 10))).toEqual([near, obstacles[4]]);
    const singleton = makeObstacleSelection([far]);
    expect(singleton(box(0, 0, 10, 10))).toEqual([far]);
    expect(select([])).toBe(obstacles);
    expect(select([{ x: NaN, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }])).toBe(obstacles);
  });

  it('retains the original checked failure path for nonfinite outer and converted hole coordinates', () => {
    const subject = box(0, 0, 10, 10), nearby = { outer: box(3, 3, 4, 4), holes: [] };
    for (const invalid of [NaN, Infinity, -Infinity]) for (const hole of [false, true]) {
      const damaged = box(100, 100, 110, 110); damaged[0].x = invalid;
      const broken = hole ? { outer: box(2, 2, 8, 8), holes: [damaged] } : { outer: damaged, holes: [] };
      const obstacles = [broken, nearby], select = makeObstacleSelection(obstacles);
      expect(select(subject)).toBe(obstacles);
      expect(booleanFunctions.tryDifference(subject, [], select(subject))).toEqual(booleanFunctions.tryDifference(subject, [], obstacles));
      expect(tryIntersection(subject, select(subject))).toEqual(tryIntersection(subject, obstacles));
    }
  });

  it('reuses a successful garden proof but rechecks changed coordinates, holes and invalid rings', () => {
    const open = makeGardenOpening(), outer = box(0, 0, 12, 12), piece = { outer, holes: [] as Polygon[] };
    const spy = vi.spyOn(booleanFunctions, 'tryDifference');
    try {
      expect(open([piece])).toEqual([outer]); expect(spy).toHaveBeenCalledTimes(2);
      expect(open([{ outer, holes: [] }])?.[0]).toBe(outer); expect(spy).toHaveBeenCalledTimes(2);
      outer[1].x = 13;
      expect(open([piece])).toEqual([outer]); expect(spy).toHaveBeenCalledTimes(4);
      piece.holes.push(box(3, 3, 6, 6));
      const opened = open([piece]);
      expect(opened).not.toBeNull(); expect(spy.mock.calls.length).toBeGreaterThan(4);
      const exact = tryIntersection(opened!.map((ring) => ({ outer: ring, holes: [] })), piece.holes[0]);
      expect(exact.failed).toBe(false); expect(mpArea(exact.pieces)).toBeLessThanOrEqual(1e-6);
      piece.holes = [];
      [outer[1], outer[2]] = [outer[2], outer[1]];
      expect(open([piece])).toBeNull();
    } finally { spy.mockRestore(); }
  });

  it('does not reuse a failed garden conservation proof', () => {
    const open = makeGardenOpening(), outer = box(0, 0, 12, 12);
    const spy = vi.spyOn(booleanFunctions, 'tryDifference').mockReturnValueOnce({ failed: true, pieces: [] });
    try {
      expect(open([{ outer, holes: [] }])).toBeNull();
      expect(open([{ outer, holes: [] }])).toEqual([outer]);
      expect(spy).toHaveBeenCalledTimes(4);
    } finally { spy.mockRestore(); }
  });

  it('keeps exact centimetre-adjacent donors in original order behind the padded broad phase', () => {
    for (const coordinate of [-40000, -64, 0, 64, 40000]) {
      const subject = box(coordinate, coordinate, coordinate + 10, coordinate + 10);
      const polygons = [box(coordinate + 10.01, coordinate, coordinate + 20, coordinate + 10),
        box(coordinate - 10, coordinate, coordinate - 0.01, coordinate + 10),
        box(coordinate + 10.01001, coordinate, coordinate + 20, coordinate + 10), subject];
      const a = bboxOf(subject), index = new PolygonIndex(polygons);
      const exact = (i: number) => {
        const b = bboxOf(polygons[i]);
        return !(a.x0 > b.x1 + 0.01 || a.x1 < b.x0 - 0.01 || a.y0 > b.y1 + 0.01 || a.y1 < b.y0 - 0.01);
      };
      const margin = 0.010001 + 128 * Number.EPSILON * Math.max(1, Math.abs(coordinate), Math.abs(coordinate + 10));
      expect(index.queryBounds(a, true, margin).filter(exact)).toEqual(polygons.map((_, i) => i).filter(exact));
    }
  });

  it('uses a hull superset for concave roofs and distinguishes empty diagonal corners from their boxes', () => {
    const triangle = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
    expect(makeHullRectangleOverlap(triangle)(8, 8, 10, 10)).toBeLessThan(1e-6);
    const concave = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 2 },
      { x: 2, y: 2 }, { x: 2, y: 10 }, { x: 0, y: 10 }];
    const upper = makeHullRectangleOverlap(concave)(3, 3, 5, 5);
    expect(upper).toBeGreaterThanOrEqual(4);
    const exact = tryIntersection(concave, box(3, 3, 5, 5));
    expect(exact.failed).toBe(false); expect(mpArea(exact.pieces)).toBe(0);
  });

  it('never underestimates checked retained area on seeded slanted and concave roofs at distant coordinates', () => {
    const rng = new Rng('retained-roof-upper');
    for (let i = 0; i < 256; i++) {
      const cx = i % 2 ? 40000 : -8000, cy = i % 3 ? 32000 : 0, vertices = 3 + i % 10;
      const polygon = Array.from({ length: vertices }, (_, j) => {
        const angle = 2 * Math.PI * j / vertices, radius = rng.range(2, 20);
        return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
      });
      const x0 = cx + rng.range(-22, 10), y0 = cy + rng.range(-22, 10);
      const x1 = x0 + rng.range(0.01, 25), y1 = y0 + rng.range(0.01, 25);
      const exact = tryIntersection(polygon, box(x0, y0, x1, y1));
      expect(exact.failed, `case ${i}`).toBe(false);
      expect(makeHullRectangleOverlap(polygon)(x0, y0, x1, y1), `case ${i}`).toBeGreaterThanOrEqual(mpArea(exact.pieces));
    }
  });

  it('keeps uncertain non-finite clipping inputs for the existing checked proof', () => {
    expect(makeHullRectangleOverlap([{ x: NaN, y: 0 }])(0, 0, 1, 1)).toBe(Infinity);
    expect(makeHullRectangleOverlap(box(0, 0, 10, 10))(NaN, 0, 1, 1)).toBe(Infinity);
  });

  it('keeps original ordered bounds predicates at cell boundaries and for large reservations', () => {
    const polygons = [box(64, 64, 128, 128), box(-64, -64, 0, 0), box(0, 0, 40000, 40000),
      box(63.9999999, 128, 64.0000001, 129), box(0, 0, 0, 0)];
    const index = new PolygonIndex(polygons);
    for (const touching of [false, true]) for (const subject of [box(0, 0, 64, 64), box(64, 128, 65, 129),
      box(-100, -100, -64, -64), box(40000, 0, 40001, 1), box(128, 128, 128, 128)]) {
      expect(index.query(subject, touching)).toEqual(brute(polygons, subject, touching));
    }
  });

  it('matches the boolean kernel outer-box margin before converting protected rings', () => {
    const polygons = [box(64 + 1e-6, 0, 65, 1), box(64 + 1.01e-6, 0, 65, 1),
      box(0, 0, 40000, 40000), box(-64 - 1e-6, 0, -64 - 1e-6, 1)];
    const bounds = bboxOf(box(-64, 0, 64, 1)), index = new PolygonIndex(polygons), margin = 1e-6;
    const expected = polygons.flatMap((p, i) => {
      const a = bboxOf(p), b = bounds;
      return !(a.x0 > b.x1 + margin || a.x1 < b.x0 - margin || a.y0 > b.y1 + margin || a.y1 < b.y0 - margin) ? [i] : [];
    });
    expect(index.queryBounds(bounds, true, margin)).toEqual(expected);
  });

  it('finds accepted growth outside old buckets and filters stale buckets after shrinking', () => {
    const polygons = [box(0, 0, 10, 10), box(200, 0, 210, 10)];
    const index = new PolygonIndex(polygons);
    polygons[0] = box(0, 0, 250, 10); index.set(0, polygons[0]);
    expect(index.query(box(240, 0, 245, 10))).toEqual([0]);
    polygons[0] = box(300, 0, 310, 10); index.set(0, polygons[0]);
    expect(index.query(box(0, 0, 20, 20))).toEqual([]);
    expect(index.query(box(200, 0, 305, 10))).toEqual([0, 1]);
  });

  it('keeps full access verdicts for repeated sub-cell states without aliasing caller results', () => {
    const block = box(0, 0, 20, 20), street = (p: { x: number; y: number }) => p.y < 0.1;
    for (let i = 0; i < 160; i++) {
      const width = 9.6 + (i % 40) * 0.02, front = box(0, 0, width, 5), rear = box(5, 10, 10, 15);
      const footprints = i % 3 ? [front, rear] : [front, front, rear];
      const fresh = blockReach(box(0, 0, 20, 20), footprints, street);
      const first = blockReach(block, footprints, street);
      expect(first).toEqual(fresh);
      first.fill(false);
      const duplicate = footprints.map((p) => p.map((q) => ({ ...q })));
      duplicate[0][1].x += 1e-6; duplicate[0][2].x += 1e-6;
      expect(blockReach(block, duplicate, street)).toEqual(fresh);
      expect(blockReach(block, footprints, street)).toEqual(fresh);
    }
  });

  it('reuses exact scanlines without stale verdicts after in-place footprint edits', () => {
    const block = box(0, 0, 20, 20), street = (p: { x: number; y: number }) => p.y < 0.1;
    const front = box(0, 0, 20, 5), rear = box(5, 10, 10, 15);
    expect(blockReach(block, [front, rear], street)).toEqual([true, false]);
    expect(blockReach(block, [front, rear], street)).toEqual([true, false]);
    front[1].x = 10; front[2].x = 10;
    expect(blockReach(block, [front, rear], street)).toEqual([true, true]);
    const fresh = box(0, 0, 20, 20);
    expect(blockReach(block, [front, rear], street)).toEqual(blockReach(fresh, [front, rear], street));
  });

  it('keeps later-footprint ownership and pool clearing when cached polygons recur', () => {
    const block = box(0, 0, 20, 20), street = (p: { x: number; y: number }) => p.y < 0.1;
    const front = box(0, 0, 20, 5), rear = box(5, 10, 10, 15);
    for (const footprints of [[front, rear], [front, front, rear], [rear], [rear, front], [front, rear]]) {
      const warm = blockReach(block, footprints, street);
      expect(warm).toEqual(blockReach(box(0, 0, 20, 20), footprints, street));
    }
  });
});
