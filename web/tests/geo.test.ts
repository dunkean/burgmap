import { describe, it, expect } from 'vitest';
import { cleanRing, isSimple, inscribed, obb, interiorAngle, area } from '../src/gen/geo/poly';
import { union, difference, intersection, mpArea } from '../src/gen/geo/bool';
import { splitByChord, lpoly, rayHit, insidePieces } from '../src/gen/geo/split';
import { ribbon, insetConvex, sweepLeft } from '../src/gen/geo/offset';
import { StreetGraph } from '../src/gen/geo/graph';
import { polygonArea } from '../src/gen/core/geom';

const sq = (x: number, y: number, s: number) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];

describe('poly', () => {
  it('cleans duplicates, collinear points and short edges', () => {
    const r = cleanRing([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0.001 }, { x: 10, y: 10 }, { x: 10.1, y: 10 }, { x: 0, y: 10 }]);
    expect(r.length).toBe(4);
    expect(Math.abs(polygonArea(r))).toBeCloseTo(100, 0);
  });
  it('angles, simplicity, inscribed circle, obb', () => {
    const s = sq(0, 0, 10);
    for (let i = 0; i < 4; i++) expect(interiorAngle(s, i)).toBeCloseTo(Math.PI / 2, 6);
    expect(isSimple(s)).toBe(true);
    expect(isSimple([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }])).toBe(false);
    const ins = inscribed([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 10 }, { x: 0, y: 10 }], [], 0.05);
    expect(ins.r).toBeCloseTo(5, 1);
    const o = obb([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 10 }, { x: 0, y: 10 }]);
    expect(o.hu).toBeCloseTo(20, 6);
    expect(Math.abs(o.u.x)).toBeCloseTo(1, 6);
  });
});

describe('booleans', () => {
  it('union/intersection/difference conserve area', () => {
    const a = sq(0, 0, 10), b = sq(5, 5, 10);
    expect(mpArea(union(a, b))).toBeCloseTo(175, 3);
    expect(mpArea(intersection(a, b))).toBeCloseTo(25, 3);
    expect(mpArea(difference(a, b))).toBeCloseTo(75, 3);
    const ring = difference(sq(0, 0, 30), sq(10, 10, 10));
    expect(ring[0].holes.length).toBe(1);
    expect(mpArea(ring)).toBeCloseTo(800, 3);
  });
});

describe('split', () => {
  it('splits by a polyline chord exactly, preserving labels', () => {
    const P = lpoly(sq(0, 0, 100), -1);
    const res = splitByChord(P, [{ x: 30, y: 0 }, { x: 40, y: 50 }, { x: 35, y: 100 }], 7)!;
    expect(res).not.toBeNull();
    const [A, B] = res;
    expect(polygonArea(A.pts) + polygonArea(B.pts)).toBeCloseTo(10000, 6);
    expect(A.lab.length).toBe(A.pts.length);
    expect(A.lab.filter((l) => l === 7).length).toBe(2);
    expect(B.lab.filter((l) => l === 7).length).toBe(2);
    // shared chord vertices are identical objects/values
    expect(A.pts.some((p) => p.x === 40 && p.y === 50)).toBe(true);
    expect(B.pts.some((p) => p.x === 40 && p.y === 50)).toBe(true);
  });
  it('rejects chords leaving the polygon', () => {
    const P = lpoly(sq(0, 0, 100), -1);
    expect(splitByChord(P, [{ x: 30, y: 0 }, { x: 140, y: 50 }, { x: 35, y: 100 }], 1)).toBeNull();
  });
  it('ray casting and inside pieces', () => {
    const h = rayHit(sq(0, 0, 100), { x: 50, y: 0 }, { x: 0, y: 1 });
    expect(h!.p.y).toBeCloseTo(100, 6);
    const pcs = insidePieces(sq(0, 0, 100), [{ x: -10, y: 50 }, { x: 110, y: 50 }]);
    expect(pcs.length).toBe(1);
    expect(pcs[0].pts[0].x).toBeCloseTo(0, 6);
  });
});

describe('offset', () => {
  it('ribbon, sweep and convex inset', () => {
    const r = ribbon([{ x: 0, y: 0 }, { x: 100, y: 0 }], 8);
    expect(area(r)).toBeCloseTo(800, 3);
    const s = sweepLeft([{ x: 0, y: 0 }, { x: 50, y: 0 }], [20, 20]);
    expect(area(s)).toBeCloseTo(1000, 3);
    const ins = insetConvex(sq(0, 0, 10), 2);
    expect(area(ins)).toBeCloseTo(36, 6);
    expect(insetConvex(sq(0, 0, 10), 6)).toEqual([]);
  });
});

describe('graph', () => {
  it('nodes crossings and extracts faces of a grid', () => {
    const g = new StreetGraph();
    const at = { width: 5, rank: 1, phase: 0, kind: 'street' as const, street: 0 };
    for (let i = 0; i <= 3; i++) {
      g.insertPolyline([{ x: 0, y: i * 10 }, { x: 30, y: i * 10 }], { ...at, street: i });
      g.insertPolyline([{ x: i * 10, y: 0 }, { x: i * 10, y: 30 }], { ...at, street: 10 + i });
    }
    const f = g.faces();
    expect(f.length).toBe(9);
    for (const x of f) expect(x.area).toBeCloseTo(100, 6);
    expect(g.components().count).toBe(1);
  });
  it('connects an earlier street ending (within snapR) on a later closed ring', () => {
    const g = new StreetGraph();
    const at = (k: number) => ({ width: 1, rank: 1, phase: 1, kind: 'street' as const, street: k });
    g.insertPolyline([{ x: 1458.34, y: 1319.57 }, { x: 1483.49, y: 1282.49 }], at(0), { snapR: 0.3, mergeDist: 0 });
    g.insertPolyline([{ x: 1397.54, y: 1378.45 }, { x: 1418.95, y: 1341.89 }, { x: 1437.96, y: 1325.16 }, { x: 1481.9, y: 1313.11 }, { x: 1457.02, y: 1354.36 }, { x: 1436.07, y: 1368.59 }, { x: 1397.54, y: 1378.45 }], at(1), { snapR: 0.3, mergeDist: 0 });
    expect(g.components().count).toBe(1);
  });
  it('snaps endpoints and merges near-parallel duplicates', () => {
    const g = new StreetGraph();
    const at = { width: 5, rank: 1, phase: 0, kind: 'street' as const, street: 0 };
    g.insertPolyline([{ x: 0, y: 0 }, { x: 100, y: 0 }], at);
    g.insertPolyline([{ x: 50, y: 2 }, { x: 50, y: 60 }], { ...at, street: 1 });
    expect(g.nodes.filter((n) => n.edges.length).length).toBe(4);
    const before = g.aliveEdges().length;
    g.insertPolyline([{ x: 10, y: 1 }, { x: 40, y: 1.5 }], { ...at, street: 2 });
    expect(g.aliveEdges().length).toBe(before);
  });
});
