import { describe, it, expect } from 'vitest';
import type { Polygon } from '../src/gen/core/geom';
import { Rng } from '../src/gen/core/rng';
import { area, bboxOf, isSimple } from '../src/gen/geo/poly';
import { intersection, intersectionS, mpArea } from '../src/gen/geo/bool';
import { polyInside } from '../src/gen/geo/split';
import { disk } from '../src/gen/geo/offset';
import { GridIndex } from '../src/gen/geo/spatial';
import { burgageHouse } from '../src/gen/urban/houses';
import { buildPlot, shapeOf, trimOverlaps } from '../src/gen/urban/buildings';
import { blockReach, carvePassage, makeStreetAt, shapeOkObb } from '../src/gen/urban/access';
import { MORPHOLOGIES } from '../src/gen/urban/morphology';
import type { Plot } from '../src/gen/urban/plots';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { megaQuarterDetail } from '../src/gen/urban/mega/detail';
import type { UrbanLayer, UrbanStreet } from '../src/gen/types';

const rectangle = (x: number, y: number, w: number, h: number): Polygon => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];

function plot(poly: Polygon): Plot {
  return {
    poly, block: 0, zone: 'core', front: [poly[0], poly[1]], nrm: { x: 0, y: 1 },
    sideA: { p: poly[0], d: { x: 0, y: 1 } }, sideB: { p: poly[1], d: { x: 0, y: 1 } },
    rank: 0, depth: 40, wide: true, sideFronts: [], run: 0, order: 0, wealth: 1,
  };
}

class TurretRng extends Rng {
  constructor(private readonly turret: boolean) { super('5'); }
  chance(p: number): boolean {
    const value = super.chance(p);
    return p === 0.55 ? this.turret : value;
  }
}

class PairedCourtRng extends Rng {
  pairDraws = 0;
  constructor(private readonly courtDepth: number, private readonly turret = false) { super('27'); }
  chance(p: number): boolean {
    const value = super.chance(p);
    // The first 0.6 draw is the carriage passage; the second requests the paired court wings.
    if (p === 0.6) return ++this.pairDraws > 1;
    return p === 0.55 ? this.turret : value;
  }
  range(a: number, b: number): number {
    const value = super.range(a, b);
    if (a === 3 && b === 5.5) return this.courtDepth;
    return a === 1.5 && b === 2 ? 2 : value;
  }
}

function disjoint(list: { poly: Polygon }[]): void {
  const index = new GridIndex<number>(30);
  list.forEach((b, i) => index.insertPts(b.poly, i));
  list.forEach((b, i) => {
    const bb = bboxOf(b.poly);
    for (const j of index.query(bb.x0, bb.y0, bb.x1, bb.y1)) {
      if (j > i) expect(mpArea(intersectionS(b.poly, list[j].poly)), `footprints ${i}/${j}`).toBeLessThanOrEqual(0.05);
    }
  });
}

function checkFabric(u: UrbanLayer, boundaryStreets: UrbanStreet[] = []): void {
  expect(u.buildings.length).toBeGreaterThan(0);
  for (const b of u.buildings) {
    expect(isSimple(b.poly)).toBe(true);
    if (b.parcel !== undefined) expect(polyInside(u.parcels[b.parcel].poly, b.poly)).toBe(true);
  }
  disjoint(u.buildings);
  const streetAt = makeStreetAt([...boundaryStreets, ...u.streets], u.parcels.filter((p) => ['place', 'market', 'quay', 'green'].includes(p.use)).map((p) => p.poly));
  const byBlock = new Map<number, typeof u.buildings>();
  for (const b of u.buildings) {
    if (b.parcel === undefined) continue;
    const bk = u.parcels[b.parcel].block;
    const list = byBlock.get(bk) ?? [];
    list.push(b);
    byBlock.set(bk, list);
  }
  for (const [bk, list] of byBlock) {
    // Every block is audited; landmark footprints remain obstacles for all homes and inns in that block.
    const ok = blockReach(u.blocks[bk], list.map((b) => b.poly), streetAt);
    list.forEach((b, i) => {
      const pc = u.parcels[b.parcel!];
      if (pc.use === 'plot' || pc.use === 'inn') expect(ok[i], `building ${i} access in block ${bk}`).toBe(true);
    });
  }
}

describe('dense house partitions', () => {
  it('partitions a stair turret from a tapered lot, preserving the street house (seed 27)', () => {
    // A later parcel merge can retain the original side frame while its actual rear boundary converges.
    const pl = plot([{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 10, y: 40 }, { x: 2, y: 40 }]);
    const P = { ...MORPHOLOGIES['european-organic'], bigCourtChance: 0 };
    const raw = burgageHouse({ ...pl }, 0.88, P, new Rng('27'));
    const house = raw.find((b) => b.kind === 'house');
    expect(house).toBeDefined();
    expect(area(house!.poly)).toBeGreaterThan(100);
    // Analytic containment avoids boolean roundoff on the long coincident parcel edges.
    for (const b of raw) for (const q of b.poly) {
      expect(q.x).toBeGreaterThanOrEqual(0.05 * q.y - 0.01);
      expect(q.x).toBeLessThanOrEqual(12 - 0.05 * q.y + 0.01);
    }
    const built = buildPlot({ ...pl }, 0.88, P, new Rng('27')).filter((b) => b.kind !== 'garden');
    expect(built.some((b) => b.kind === 'house' && area(b.poly) > 100)).toBe(true);
    expect(built.reduce((s, b) => s + area(b.poly), 0) / area(pl.poly)).toBeGreaterThan(0.65);
    disjoint(built);
  });

  it('keeps a valid rectangular rich house turret instead of silently removing it', () => {
    const pl = plot(rectangle(0, 0, 16, 30));
    const P = { ...MORPHOLOGIES['european-organic'], bigCourtChance: 0 };
    const withTurret = burgageHouse({ ...pl }, 0.88, P, new TurretRng(true)).find((b) => b.kind === 'house')!;
    const without = burgageHouse({ ...pl }, 0.88, P, new TurretRng(false)).find((b) => b.kind === 'house')!;
    expect(area(withTurret.poly)).toBeGreaterThan(area(without.poly) + 0.1);
    expect(polyInside(pl.poly, withTurret.poly)).toBe(true);
  });

  it('clips a forced turret to true convergent party walls while retaining its added area (seed 5)', () => {
    const pl = plot([{ x: 0, y: 0 }, { x: 16, y: 0 }, { x: 12, y: 30 }, { x: 4, y: 30 }]);
    const l = Math.hypot(4, 30);
    pl.sideA.d = { x: 4 / l, y: 30 / l };
    pl.sideB.d = { x: -4 / l, y: 30 / l };
    const P = { ...MORPHOLOGIES['european-organic'], bigCourtChance: 0 };
    const withTurret = burgageHouse({ ...pl }, 0.88, P, new TurretRng(true)).find((b) => b.kind === 'house')!;
    const without = burgageHouse({ ...pl }, 0.88, P, new TurretRng(false)).find((b) => b.kind === 'house')!;
    expect(area(withTurret.poly)).toBeGreaterThan(area(without.poly) + 1);
    expect(area(withTurret.poly)).toBeGreaterThan(200);
    for (const q of withTurret.poly) {
      expect(q.x).toBeGreaterThanOrEqual(4 * q.y / 30 - 0.01);
      expect(q.x).toBeLessThanOrEqual(16 - 4 * q.y / 30 + 0.01);
    }
  });

  it('keeps the wing at the exact 3.6 m court-width clamp', () => {
    class CourtRng extends Rng {
      constructor() { super('27'); }
      chance(p: number): boolean { return p === 0.6 ? false : super.chance(p); }
      range(a: number, b: number): number { return a === 3 && b === 5.5 ? 3 : super.range(a, b); }
    }
    const pl = plot(rectangle(0, 0, 12, 40));
    const raw = burgageHouse(pl, 0.88, { ...MORPHOLOGIES['european-organic'], bigCourtChance: 0 }, new CourtRng());
    const house = raw.find((b) => b.kind === 'house')!.poly;
    expect(area(house)).toBeGreaterThan(115);
    expect(house.length).toBeGreaterThan(4);
    expect(Math.max(...house.map((p) => p.y))).toBeGreaterThan(13);
  });

  for (const courtDepth of [3, 4]) {
    for (const coverage of [0.88, 0.96]) {
      it(`keeps useful wing widths after a forced two-wing draw (court ${courtDepth} m, coverage ${coverage})`, () => {
        const pl = plot(rectangle(0, 0, 12, 40)), rng = new PairedCourtRng(courtDepth);
        const base = MORPHOLOGIES['european-organic'];
        // This orthogonal fixture excludes rectification draws from the two 0.6 program decisions.
        const P = { ...base, bigCourtChance: 0, footprintConformity: { ...base.footprintConformity, core: 1 } };
        const raw = burgageHouse(pl, coverage, P, rng);
        expect(rng.pairDraws).toBe(2);
        const house = raw.find((b) => b.kind === 'house')!.poly;
        const rearStart = Math.min(...raw.filter((b) => b.kind === 'rear' || b.kind === 'back').flatMap((b) => b.poly.map((p) => p.y)));
        const d0 = rearStart - courtDepth;
        expect(d0).toBeGreaterThan(8);
        // An independent boolean separates wings behind the facade without retaining a zero-area retrace.
        const parts = intersection(house, rectangle(-1, d0 + 0.001, 14, 41 - d0 - 0.001));
        expect(parts.every((p) => p.holes.length === 0)).toBe(true);
        const wings = parts.map((p) => p.outer);
        expect(wings).toHaveLength(coverage === 0.88 ? 1 : 2);
        for (const wing of wings) {
          const bb = bboxOf(wing);
          // A 3 m-deep court is shallower than the 3.6 m lateral room width; its OBB short side is its depth.
          expect(bb.x1 - bb.x0).toBeGreaterThanOrEqual(3.6 - 1e-6);
          if (courtDepth === 4) expect(shapeOf(wing).w).toBeGreaterThanOrEqual(3.6 - 1e-6);
          expect(area(wing)).toBeGreaterThanOrEqual(3.6 * (courtDepth - 0.001) - 1e-5);
          expect(polyInside(pl.poly, wing)).toBe(true);
        }
      });
    }
  }

  it('still clips a turret at a merged-lot notch when a paired draw falls back to one proper wing', () => {
    // The notch cuts only into the court, beyond the 3.6 m side wing; its frame survives a later parcel merge.
    // At W18 the overlap with the turret meets joinFoot's existing 5% union tolerance (W12 rejected it).
    const pl = plot([
      { x: 0, y: 0 }, { x: 18, y: 0 }, { x: 18, y: 11.5 }, { x: 4, y: 11.5 },
      { x: 4, y: 12.5 }, { x: 18, y: 12.5 }, { x: 18, y: 40 }, { x: 0, y: 40 },
    ]);
    const base = MORPHOLOGIES['european-organic'];
    const P = { ...base, bigCourtChance: 0, footprintConformity: { ...base.footprintConformity, core: 1 } };
    const rngA = new PairedCourtRng(3, true), rngB = new PairedCourtRng(3, false);
    const withTurret = burgageHouse({ ...pl }, 0.88, P, rngA).find((b) => b.kind === 'house')!.poly;
    const without = burgageHouse({ ...pl }, 0.88, P, rngB).find((b) => b.kind === 'house')!.poly;
    expect(rngA.pairDraws).toBe(2);
    expect(rngB.pairDraws).toBe(2);
    expect(area(withTurret)).toBeGreaterThan(area(without) + 0.5);
    expect(polyInside(pl.poly, withTurret)).toBe(true);
    expect(isSimple(withTurret)).toBe(true);
    // disk uses vertices at 22.5 + 45*i degrees; its real octagon crosses the notch before lot clipping.
    const d0 = Math.max(...without.map((p) => p.y)) - 3;
    // Prove that (3.6, d0) is the actual turret corner: one clamped side wing, on the left of this plot.
    const wing = intersection(without, rectangle(-1, d0 + 0.001, 20, 41 - d0 - 0.001));
    expect(wing).toHaveLength(1);
    const wb = bboxOf(wing[0].outer);
    expect(wb.x0).toBeCloseTo(0, 6);
    expect(wb.x1).toBeCloseTo(3.6, 6);
    expect(polyInside(pl.poly, disk({ x: 3.6, y: d0 }, 2, 8))).toBe(false);
  });

  for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
    it(`floods from a street at the ${edge} raster boundary`, () => {
      const block = rectangle(0, 0, 20, 20), house = rectangle(6, 6, 6, 6);
      const streetAt = (p: { x: number; y: number }) => edge === 'top' ? p.y < 0.1 : edge === 'bottom' ? p.y > 19.9 : edge === 'left' ? p.x < 0.1 : p.x > 19.9;
      expect(blockReach(block, [house], streetAt)).toEqual([true]);
    });
  }

  for (const depth of [6, 10]) {
    it(`subtracts a ${depth} m gateway without a cut across the whole house`, () => {
      const pl = plot(rectangle(0, 0, 12, 30));
      const b = { poly: pl.poly, kind: 'house', arch: 'gabled-row-house', storeys: 3 };
      const result = carvePassage(pl, [b], 'A', 1.6, depth);
      expect(result).toHaveLength(1);
      expect(area(result[0].poly)).toBeCloseTo(360 - 1.6 * depth, 5);
      expect(isSimple(result[0].poly)).toBe(true);
      expect(shapeOkObb(result[0].poly)).toBe(true);
      expect(polyInside(pl.poly, result[0].poly)).toBe(true);
      expect(result[0].arch).toBe(b.arch);
      expect(result[0].storeys).toBe(b.storeys);
      expect(blockReach(pl.poly, result.map((p) => p.poly), (p) => p.y < 0.1)).toEqual([true]);
    });
  }

  it('preserves a broad front range whose aspect is valid as part of the whole house', () => {
    const pl = plot(rectangle(0, 0, 30, 22));
    const result = carvePassage(pl, [{ poly: pl.poly, kind: 'house' }], 'A', 1.6, 6);
    expect(result).toHaveLength(1);
    expect(area(result[0].poly)).toBeCloseTo(660 - 1.6 * 6, 5);
    expect(shapeOkObb(result[0].poly)).toBe(true);
    expect(blockReach(pl.poly, result.map((b) => b.poly), (p) => p.y < 0.1)).toEqual([true]);
  });

  it('keeps oblique party walls exact on a 75 degree plot away from the origin', () => {
    const angle = 75 * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    const transformed = rectangle(0, 0, 12, 30).map((p) => ({ x: 1500 + p.x + p.y * c, y: -2300 + p.y * s }));
    const pl = plot(transformed);
    pl.sideA.d = { x: c, y: s };
    pl.sideB.d = { x: c, y: s };
    const result = carvePassage(pl, [{ poly: pl.poly, kind: 'house' }], 'A', 1.6, 10);
    expect(result).toHaveLength(1);
    expect(area(result[0].poly)).toBeCloseTo(12 * 30 * s - 1.6 * 10 / s, 5);
    expect(isSimple(result[0].poly)).toBe(true);
    expect(polyInside(pl.poly, result[0].poly)).toBe(true);
    expect(shapeOkObb(result[0].poly)).toBe(true);
    // The rear party-wall vertices remain exactly the input coordinates after stitching.
    for (const corner of transformed.slice(2)) expect(result[0].poly).toContainEqual(corner);
  });

  it('rejects a 3.9 m street-front arm hidden by the wide rear OBB', () => {
    const pl = plot(rectangle(0, 0, 5.5, 20));
    const result = carvePassage(pl, [{ poly: pl.poly, kind: 'house' }], 'A', 1.6, 8);
    expect(result).toHaveLength(1);
    expect(area(result[0].poly)).toBeCloseTo(5.5 * 12, 5);
    expect(result[0].poly.every((p) => p.y >= 8)).toBe(true);
    expect(shapeOkObb(result[0].poly)).toBe(true);
  });

  it('does not hide a 1 m rear arm behind the wide street house', () => {
    const pl = plot(rectangle(0, 0, 12, 11));
    const result = carvePassage(pl, [{ poly: pl.poly, kind: 'house' }], 'A', 1.6, 10);
    expect(result).toHaveLength(1);
    expect(area(result[0].poly)).toBeCloseTo(10.4 * 10, 5);
    expect(result[0].poly.every((p) => p.y <= 10)).toBe(true);
    expect(shapeOkObb(result[0].poly)).toBe(true);
  });

  it('keeps the valid front and rear ranges when their merged L exceeds the aspect limit', () => {
    const pl = plot(rectangle(0, 0, 12, 40));
    const result = carvePassage(pl, [{ poly: pl.poly, kind: 'house' }], 'A', 1.6, 6);
    expect(result).toHaveLength(2);
    expect(result.reduce((s, b) => s + area(b.poly), 0)).toBeCloseTo(480 - 1.6 * 6, 5);
    expect(result.every((b) => shapeOkObb(b.poly))).toBe(true);
    expect(blockReach(pl.poly, result.map((b) => b.poly), (p) => p.y < 0.1)).toEqual([true, true]);
    disjoint(result);
  });

  it('does not reach the rear through a 1 m gateway with insufficient clearance', () => {
    const pl = plot(rectangle(0, 0, 12, 40));
    const result = carvePassage(pl, [{ poly: pl.poly, kind: 'house' }], 'A', 1, 6);
    expect(result).toHaveLength(2);
    expect(blockReach(pl.poly, result.map((b) => b.poly), (p) => p.y < 0.1)).toEqual([false, true]);
  });

  it('reaches the terminal wall through the gateway without reaching buildings behind that wall', () => {
    const block = rectangle(0, 0, 12, 40);
    const front = rectangle(1.6, 0, 10.4, 6), wall = rectangle(0, 6, 12, 1), rear = rectangle(0, 8, 12, 6);
    expect(blockReach(block, [front, wall, rear], (p) => p.y < 0.1)).toEqual([true, true, false]);
  });

  it('does not reach a building diagonally through a corner sealed by two wall cells', () => {
    const block = rectangle(0, 0, 8, 8);
    const topWall = rectangle(5.5, 0, 2.5, 5), leftWall = rectangle(5, 5, 0.5, 3);
    const enclosed = rectangle(5.5, 5, 2.5, 3);
    // The reached centre (4.75,4.75) has a free apron (5.25,4.75), but wall cells at
    // (5.75,4.75) and (5.25,5.25) seal the diagonal target cell (5.75,5.25).
    expect(blockReach(block, [topWall, leftWall, enclosed], (p) => p.y < 0.1)).toEqual([true, true, false]);
  });

  it('opens a 1.6 m gateway into the yard and reaches a separate rear building', () => {
    const pl = plot(rectangle(0, 0, 12, 35));
    const house = { poly: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 20 }, { x: 6, y: 20 }, { x: 6, y: 10 }, { x: 0, y: 10 }], kind: 'house' };
    const rear = { poly: rectangle(2, 25, 8, 6), kind: 'back' };
    const streetAt = (p: { y: number }) => p.y < 0.1;
    expect(blockReach(pl.poly, [house.poly, rear.poly], streetAt)).toEqual([true, false]);
    const kept = carvePassage(pl, [house], 'A', 1.6, 10);
    expect(kept).toHaveLength(1);
    expect(blockReach(pl.poly, [...kept.map((b) => b.poly), rear.poly], streetAt)).toEqual([true, true]);
  });

  it('leaves a rear range beyond the gateway unchanged', () => {
    const pl = plot(rectangle(0, 0, 12, 30));
    const rear = { poly: rectangle(0, 15, 12, 10), kind: 'back' };
    expect(carvePassage(pl, [rear], 'A', 1.6, 10)).toEqual([rear]);
  });

  it('does not enclose an earlier home with an unserved hollow remainder', () => {
    const block = rectangle(0, 0, 20, 20);
    const first = { poly: rectangle(6, 6, 6, 6), kind: 'house' as const };
    const result = trimOverlaps([first, { poly: block, kind: 'back' as const }]);
    expect(result).toEqual([first]);
    expect(blockReach(block, result.map((b) => b.poly), (p) => p.y < 0.1)).toEqual([true]);
  });

});

describe('dense houses on the shared eager and lazy paths', () => {
  it('keeps eager street houses inside a disjoint fabric', () => {
    checkFabric(generate(makeOptions({ seed: '1', size: 'town', settlements: 'none' })).urban!);
  });

  it('keeps central megacity houses in their parcels and preserves deterministic detail', () => {
    const w = generate(makeOptions({ seed: '7', mapSize: 4000, population: 9000, eagerPop: 8999, settlements: 'none' }));
    const M = w.urban!.macro!;
    const ids = M.quarters.map((q) => ({ id: q.id, d: Math.hypot((q.bb[0] + q.bb[2]) / 2 - M.center.x, (q.bb[1] + q.bb[3]) / 2 - M.center.y) }))
      .sort((a, b) => a.d - b.d).slice(0, 3).map((q) => q.id);
    const again = structuredClone(w);
    const first = ids.map((id) => {
      const detail = megaQuarterDetail(w, id);
      expect(detail).not.toBeNull();
      return detail!;
    });
    first.forEach((detail) => checkFabric(detail, w.urban!.streets));
    for (const [i, id] of ids.entries()) expect(megaQuarterDetail(again, id)).toEqual(first[i]);
  }, 180000);
});
