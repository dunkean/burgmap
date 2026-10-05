import { describe, expect, it } from 'vitest';
import { roofCandidateBatches, type RoofCandidateSearch } from '../src/gen/urban/roofSearch';
import { roofEnvelope } from '../src/gen/urban/edgeRoofs';
import { area } from '../src/gen/geo/poly';

interface Candidate { id: string; nominal: number; measured: number; move: number }
const source = (items: Candidate[], margin: number, calls: number[]): RoofCandidateSearch<Candidate> => ({
  sizes: items.map((p) => ({ width: p.nominal, depth: 1 })), areaMargin: margin,
  build: (band) => {
    calls.push(band?.low ?? -1);
    return items.filter((p) => !band || (p.nominal >= band.low && p.nominal <= band.high))
      .sort((a, b) => b.measured - a.measured || a.move - b.move);
  },
});

describe('lazy roof area search', () => {
  it('covers real inclined rectangle construction and shoelace cancellation through 80 km coordinates', () => {
    for (const coordinate of [0, 40000, 80000]) for (const angle of [0.13, 0.73, 1.37, 2.4]) {
      for (const [width, depth] of [[4.5, 4.5], [4.5, 13.5], [7.125, 11.875]]) {
        const at = (x: number, y: number) => ({ x: coordinate + Math.cos(angle) * x - Math.sin(angle) * y,
          y: coordinate + Math.sin(angle) * x + Math.cos(angle) * y });
        const polygon = [at(-8, -8), at(-8 + width, -8), at(-8 + width, -8 + depth), at(-8, -8 + depth)];
        const roof = roofEnvelope(polygon, [at(0, 0), at(1, 0)]);
        const scale = coordinate + 20 + Math.sqrt(width * depth * (3 + 1 / 3));
        expect(Math.abs(area(roof) - width * depth)).toBeLessThanOrEqual(4096 * Number.EPSILON * scale * scale);
      }
    }
  });

  it('preserves the exhaustive stable order across donors, axes, area cancellation and equal-area moves', () => {
    const inputs: Candidate[][] = [
      [{ id: 'a', nominal: 100, measured: 100 + 1e-7, move: 3 },
        { id: 'b', nominal: 100 + 2e-7, measured: 100, move: 4 },
        { id: 'c', nominal: 100, measured: 100, move: 1 },
        { id: 'd', nominal: 90, measured: 90 - 1e-7, move: 0 }],
      [{ id: 'e', nominal: 100, measured: 100, move: 0 },
        { id: 'f', nominal: 90, measured: 90 + 1e-7, move: 0 },
        { id: 'g', nominal: 80, measured: 80, move: 0 }],
    ];
    const searches = inputs.map((items) => source(items, 1e-6, []));
    const expected = searches.flatMap((s) => s.build()).sort((a, b) => b.measured - a.measured);
    const actual = [...roofCandidateBatches(searches, (p) => p.measured)].flat();
    expect(actual).toEqual(expected);
  });

  it('does not enumerate smaller proposals after the first successful transaction', () => {
    const calls: number[] = [], items = [130, 100, 90, 80, 65].map((area) => ({ id: `${area}`, nominal: area, measured: area, move: 0 }));
    const search = source(items, 1e-6, calls);
    for (const batch of roofCandidateBatches([search], (p) => p.measured)) {
      expect(batch.map((p) => p.measured)).toEqual([130]); break;
    }
    expect(calls).toEqual([130]);
  });

  it('merges transitively overlapping uncertainty bands and falls back when the bound is nonfinite', () => {
    const calls: number[] = [], items = [100, 100 + 1.5e-6, 100 + 3e-6]
      .map((a) => ({ id: `${a}`, nominal: a, measured: a, move: 0 }));
    const batches = [...roofCandidateBatches([source(items, 1e-6, calls)], (p) => p.measured)];
    expect(batches).toHaveLength(1); expect(calls).toEqual([100]);
    const fallback: number[] = [];
    expect([...roofCandidateBatches([source(items, Infinity, fallback)], (p) => p.measured)].flat()).toHaveLength(3);
    expect(fallback).toEqual([-1]);
  });
});
