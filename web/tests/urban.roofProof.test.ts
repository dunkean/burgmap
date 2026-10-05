import { describe, expect, it } from 'vitest';
import type { Polygon } from '../src/gen/core/geom';
import { prepareIntersection, tryIntersection, mpArea } from '../src/gen/geo/bool';
import { convexCenterDomain } from '../src/gen/urban/roofProof';
import { polyInside } from '../src/gen/geo/split';

const rectangle = (x: number, y: number, w: number, h: number): Polygon => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];

describe('prepared checked roof geometry', () => {
  it('keeps raw residues, holes, ordered operands and checked failures', () => {
    const obstacles = [
      { outer: rectangle(40000, 40000, 12, 12), holes: [rectangle(40003, 40003, 5, 5)] },
      { outer: rectangle(40012, 40000, 4, 4), holes: [] },
      { outer: rectangle(-20000, -20000, 100, 100), holes: [] },
    ];
    const prepared = prepareIntersection(obstacles);
    for (const subject of [rectangle(40001, 40001, 2, 2), rectangle(40004, 40004, 1, 1),
      rectangle(40012 - 1e-8, 40001, 2e-8, 1), rectangle(-40000, -40000, 80000, 80000)]) {
      expect(prepared(subject)).toEqual(tryIntersection(subject, obstacles));
    }
    const invalid = [{ outer: rectangle(0, 0, 8, 8), holes: [] },
      { outer: [{ x: 2, y: 2 }, { x: NaN, y: 3 }, { x: 4, y: 4 }], holes: [] }];
    expect(prepareIntersection(invalid)(rectangle(0, 0, 5, 5))).toEqual({ pieces: [], failed: true });
    expect(prepareIntersection(obstacles)([{ x: NaN, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]))
      .toEqual({ pieces: [], failed: true });
  });

  it('snapshots stable operands independently of later caller edits', () => {
    const obstacle = rectangle(0, 0, 10, 10), subject = rectangle(1, 1, 2, 2);
    const prepared = prepareIntersection(obstacle), expected = tryIntersection(subject, obstacle);
    obstacle[0].x = -100;
    expect(prepared(subject)).toEqual(expected);
  });
});

describe('necessary convex roof center domain', () => {
  it('rejects dimensions that fit the box but cannot fit a triangular owner', () => {
    const owner = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 0, y: 12 }];
    expect(convexCenterDomain([0, 12, 0], [0, 0, 12], owner, 7, 7, 6, 6)?.possible).toBe(false);
    expect(convexCenterDomain([0, 12, 0], [0, 0, 12], owner, 6, 6, 6, 6)?.possible).toBe(true);
  });

  it('keeps every legacy-contained placement, including centimeter contacts at distant coordinates', () => {
    for (const offset of [0, 40000]) for (const angle of [0, 0.23, 0.91]) {
      const local = [{ x: 0, y: 0 }, { x: 14, y: 0 }, { x: 11, y: 9 }, { x: 0, y: 12 }];
      const at = (x: number, y: number) => ({ x: offset + x * Math.cos(angle) - y * Math.sin(angle),
        y: offset + x * Math.sin(angle) + y * Math.cos(angle) });
      const owner = local.map((p) => at(p.x, p.y));
      for (const [width, depth] of [[4.5, 4.5], [5, 7], [7, 5]]) {
        const domain = convexCenterDomain(local.map((p) => p.x), local.map((p) => p.y), owner, width, depth, 7, 6)!;
        for (let x = width / 2 - 0.0099; x <= 14; x += 0.73) for (let y = depth / 2 - 0.0099; y <= 12; y += 0.79) {
          const roof = rectangle(x - width / 2, y - depth / 2, width, depth).map((p) => at(p.x, p.y));
          if (polyInside(owner, roof)) {
            expect(domain.possible).toBe(true);
            expect(domain.allows(x, y)).toBe(true);
          }
          if (mpArea(tryIntersection(roof, owner).pieces) > width * depth - 1e-7) expect(domain.allows(x, y)).toBe(true);
        }
      }
    }
  });

  it('falls back for concave owners and invalidates a previously certified in-place edit', () => {
    const owner = rectangle(0, 0, 12, 12);
    expect(convexCenterDomain([0, 12, 12, 0], [0, 0, 12, 12], owner, 5, 5, 6, 6)).not.toBeNull();
    owner[2] = { x: 3, y: 3 };
    expect(convexCenterDomain([0, 12, 3, 0], [0, 0, 3, 12], owner, 5, 5, 6, 6)).toBeNull();
  });

  it('keeps the checked fallback for reversed projections, overflowing supports and degenerate owners', () => {
    const owner = rectangle(0, 0, 12, 12);
    expect(convexCenterDomain([0, 12, 12, 0], [12, 12, 0, 0], [...owner].reverse(), 5, 5, 6, 6)).toBeNull();
    expect(convexCenterDomain([0, 12, 12, 0], [0, 0, 12, 12], owner, Infinity, Number.MAX_VALUE, 6, 6)).toBeNull();
    expect(convexCenterDomain([0, 1, 2], [0, 0, 0], [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], 5, 5, 1, 0)).toBeNull();
    const near = [{ x: 0, y: 0 }, { x: 12, y: 1e-12 }, { x: 12, y: 12 }, { x: 0, y: 12 }];
    expect(convexCenterDomain(near.map((p) => p.x), near.map((p) => p.y), near, 5, 5, 6, 6)?.allows(6, 6)).toBe(true);
  });
});
