import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import upstream from 'polygon-clipping';
import vendored from '../src/vendor/polygonClipping';
import fixture from './fixtures/polygon-traversal-p4uefz.json';
import waterFixture from './fixtures/polygon-traversal-water-seed2.json';
import { differenceS, differenceSafeS, tryDifferenceS, fromGeom, mpArea } from '../src/gen/geo/bool';
import type { MultiPoly } from '../src/gen/geo/bool';
import { area, bboxOf } from '../src/gen/geo/poly';
import type { Polygon } from '../src/gen/types';

// The copied ESM uses arguments for variadic operands; retain the upstream public type in tests.
const clipping = vendored as unknown as typeof upstream;

const rect = (x: number, y: number, w: number, h: number): import('polygon-clipping').Polygon =>
  [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]];

describe('bounded consumed-neighbour traversal in polygon clipping', () => {
  it('keeps the pinned upstream artifact byte-exact apart from the two guards and attribution header', () => {
    let source = readFileSync(new URL('../src/vendor/polygonClipping.ts', import.meta.url), 'utf8');
    source = source.slice(source.indexOf("import SplayTree from 'splaytree';"));
    source = source.replace('    const consumedTraversalLimit = this.tree.size + 1;\n    let prevSteps = 0;\n', '')
      .replace('      if (++prevSteps > consumedTraversalLimit) throw new Error("SweepLine consumed predecessor traversal violated tree-size invariant.");\n', '')
      .replace('    let nextSteps = 0;\n', '')
      .replace('      if (++nextSteps > consumedTraversalLimit) throw new Error("SweepLine consumed successor traversal violated tree-size invariant.");\n', '');
    expect(createHash('sha256').update(source).digest('hex')).toBe('766d182d2908c03d19608f90837e870a99df42c313c537363d2a0adb0f44baaa');
    expect(createHash('sha256').update(JSON.stringify({ a: fixture.a, rest: fixture.rest })).digest('hex'))
      .toBe('be9fbd083eaf8a69d4ea3aa1e3e40ee08ab7a0f3497b1ad787ac73f7c3d186b9');
    expect(fixture.a).toHaveLength(20); expect(fixture.rest).toHaveLength(13);
  });

  it('returns exactly the same normal unions, intersections, differences and xor as upstream', () => {
    const pairs = [
      [rect(0, 0, 20, 20), rect(10, 5, 30, 10)],
      [rect(0, 0, 20, 20), rect(20, 0, 10, 20)],
      [rect(0, 0, 20, 20), rect(30, 30, 10, 10)],
      [[...rect(0, 0, 40, 40), ...rect(10, 10, 10, 10)], rect(15, 5, 20, 30)],
    ];
    for (let i = 0; i < 20; i++) pairs.push([rect(1000 + i * 0.731, -300 + i * 0.41, 20 + i, 17 + i * 0.25),
      rect(1010 + i * 0.519, -295 + i * 0.315, 25, 19)]);
    for (const [a, b] of pairs) for (const op of ['union', 'intersection', 'difference', 'xor'] as const) {
      expect(clipping[op](a, b)).toEqual(upstream[op](a as never, b as never));
    }
  });

  it('signals the frozen p4uefz failure to checked callers and resolves it through the existing coarse retry', () => {
    expect(fixture.op).toBe('difference'); expect(fixture.snapped).toBe(true);
    const before = JSON.stringify(fixture), a = fixture.a as Polygon, rest = fixture.rest;
    const checked = tryDifferenceS(a, ...rest);
    expect(checked.failed).toBe(true); expect(checked.pieces).toEqual([]);
    const attempts: Parameters<typeof upstream.difference>[] = [];
    const outcomes: { returned?: ReturnType<typeof upstream.difference>; error?: unknown }[] = [];
    const original = clipping.difference;
    const observation = vi.spyOn(clipping, 'difference').mockImplementation((...operands) => {
      attempts.push(operands);
      try { const returned = original(...operands); outcomes.push({ returned }); return returned; }
      catch (error) { outcomes.push({ error }); throw error; }
    });
    let result: ReturnType<typeof differenceS>;
    try { result = differenceS(a, ...rest); } finally { observation.mockRestore(); }
    expect(attempts).toHaveLength(2);
    expect(outcomes[0].error).toBeInstanceOf(Error);
    expect(String(outcomes[0].error)).toContain('consumed predecessor traversal violated tree-size invariant');
    expect(outcomes[1].error).toBeUndefined(); expect(outcomes[1].returned).toBeDefined();
    expect(result.length).toBeGreaterThan(0);
    expect(mpArea(result)).toBeGreaterThan(0); expect(mpArea(result)).toBeLessThan(area(a));
    const b = bboxOf(a);
    expect(result.every((p) => [p.outer, ...p.holes].every((r) => r.every((v) => Number.isFinite(v.x) && Number.isFinite(v.y)
      && v.x >= b.x0 - 0.05 && v.x <= b.x1 + 0.05 && v.y >= b.y0 - 0.05 && v.y <= b.y1 + 0.05)))).toBe(true);
    // Only the successfully resolved coarse operands reach unpatched upstream: never the hanging primary input.
    expect(result).toEqual(fromGeom(upstream.difference(...attempts[1]), 0.01, true));
    expect(differenceSafeS(a, ...rest)).toEqual(result);
    expect(differenceS(a, ...rest)).toEqual(result);
    expect(JSON.stringify(fixture)).toBe(before);
    expect(clipping.intersection(rect(0, 0, 20, 20), rect(5, 5, 5, 5)))
      .toEqual(upstream.intersection(rect(0, 0, 20, 20) as never, rect(5, 5, 5, 5) as never));
  });

  it('fails closed in checked and safe operations if both deterministic attempts fail', () => {
    const failure = vi.spyOn(clipping, 'difference').mockImplementation(() => { throw new Error('SweepLine consumed predecessor traversal violated tree-size invariant.'); });
    try {
      const a = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
      const b = a.map((p) => ({ x: p.x + 5, y: p.y }));
      expect(tryDifferenceS(a, b)).toEqual({ pieces: [], failed: true });
      expect(differenceSafeS(a, b)).toEqual([]);
      expect(failure).toHaveBeenCalledTimes(3);
    } finally { failure.mockRestore(); }
  });

  it('bounds the captured natural-road water difference without changing its exact kernel inputs', () => {
    const before = JSON.stringify(waterFixture);
    expect(waterFixture.kernel.type).toBe('difference');
    expect(createHash('sha256').update(JSON.stringify([waterFixture.kernel.geom, waterFixture.kernel.moreGeoms])).digest('hex'))
      .toBe(waterFixture.kernelGeometrySha256);
    const operands = [waterFixture.kernel.geom, ...waterFixture.kernel.moreGeoms] as unknown as Parameters<typeof upstream.difference>;
    expect(() => clipping.difference(...operands))
      .toThrow('SweepLine consumed predecessor traversal violated tree-size invariant.');
    expect(JSON.stringify(waterFixture)).toBe(before);
  });

  it('keeps the water-safe policy and deterministically resolves that natural-road difference through its existing retry', () => {
    const capture = waterFixture.wrapper, before = JSON.stringify(waterFixture);
    expect({ op: capture.op, snapped: capture.snapped, failClosed: capture.failClosed,
      retryCoarse: capture.retryCoarse, preserveEdges: capture.preserveEdges })
      .toEqual({ op: 'difference', snapped: true, failClosed: true, retryCoarse: true, preserveEdges: false });
    const a = capture.a as MultiPoly, rest = capture.rest as MultiPoly[];
    const attempts: Parameters<typeof upstream.difference>[] = [];
    const outcomes: { returned?: ReturnType<typeof upstream.difference>; error?: unknown }[] = [];
    const original = clipping.difference;
    const observation = vi.spyOn(clipping, 'difference').mockImplementation((...operands) => {
      attempts.push(operands);
      try { const returned = original(...operands); outcomes.push({ returned }); return returned; }
      catch (error) { outcomes.push({ error }); throw error; }
    });
    let result: ReturnType<typeof differenceSafeS>;
    try { result = differenceSafeS(a, ...rest); } finally { observation.mockRestore(); }
    expect(attempts).toHaveLength(2);
    expect(createHash('sha256').update(JSON.stringify([attempts[0][0], attempts[0].slice(1)])).digest('hex'))
      .toBe(waterFixture.kernelGeometrySha256);
    expect(String(outcomes[0].error)).toContain('consumed predecessor traversal violated tree-size invariant');
    expect(outcomes[1].error).toBeUndefined(); expect(outcomes[1].returned).toBeDefined();
    expect(result).toHaveLength(waterFixture.expected.pieces);
    expect(mpArea(result)).toBeCloseTo(waterFixture.expected.area, 8);
    expect(createHash('sha256').update(JSON.stringify(result)).digest('hex')).toBe(waterFixture.expected.resultSha256);
    // The unguarded module only receives the known successful coarse operands, never the captured hanging input.
    expect(result).toEqual(fromGeom(upstream.difference(...attempts[1]), 0.01, true));
    expect(differenceSafeS(a, ...rest)).toEqual(result);
    expect(JSON.stringify(waterFixture)).toBe(before);
  });
});
