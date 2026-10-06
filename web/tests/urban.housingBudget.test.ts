import { describe, expect, it } from 'vitest';
import type { Polygon, Vec2 } from '../src/gen/core/geom';
import { area } from '../src/gen/geo/poly';
import { finalizeFootprints } from '../src/gen/urban/footprintFinal';
import fringe from './fixtures/urban-fringe-fills-v15.json';
import pins from './fixtures/compact-pins-v11.json';

type Native = { i: number; roof: Polygon; owner: Polygon; front: [Vec2, Vec2]; kind?: string; arch?: string };
const fringeCases = fringe.cases as unknown as Native[];
const pinCases = pins.cases as unknown as Native[];
const rect = (x: number, width: number): Polygon => [
  { x, y: 0 }, { x: x + width, y: 0 }, { x: x + width, y: 10 }, { x, y: 10 },
];

describe('cumulative housing-area budget', () => {
  it('accepts a full-area later room after crossing 98% and refuses loss beyond the uniform 97% floor', () => {
    const wing = fringeCases.find((c) => c.i === 647)!;
    const compact = pinCases.find((c) => c.i === 104)!;
    const whole = pinCases.find((c) => c.i === 845)!;
    const fill = fringeCases.find((c) => c.i === 723)!;
    const buildings = [
      { poly: wing.roof, kind: 'house', arch: wing.arch, parcel: 0 },
      { poly: compact.roof, kind: 'house', parcel: 1 },
      { poly: whole.roof, kind: 'back', parcel: 2 },
      { poly: fill.roof, kind: 'house', parcel: 3 },
      { poly: rect(3000, 10), kind: 'house' },
      { poly: rect(3020, 10), kind: 'house' },
      { poly: rect(3040, 5), kind: 'house' },
    ];
    const initial = buildings.reduce((s, b) => s + area(b.poly), 0);
    const result = finalizeFootprints({ buildings,
      parcels: [wing, compact, whole, fill].map((f, i) =>
        ({ poly: f.owner, front: f.front, use: 'plot', block: i })), backLand: [],
      openQuarterEdge: () => false, tipConstrained: () => true,
      placementClear: (p) => p.every((v) => v.x < 1700),
      validateParts: () => true, allowFillRemoval: true, validateRemoval: () => true,
    });
    const final = buildings.reduce((s, b) => s + area(b.poly), 0);
    expect(area(buildings[0].poly)).toBeGreaterThanOrEqual(0.65 * area(wing.roof));
    expect(final).toBeLessThan(0.98 * initial);
    expect(final).toBeGreaterThan(0.97 * initial);
    expect(buildings[1].poly).toBe(compact.roof);
    expect(result.invalid).toContain(1);
    expect(area(buildings[2].poly)).toBeGreaterThanOrEqual(area(whole.roof) - 1e-6);
    expect(result.removed).toEqual([]);
    expect(result.invalid).toContain(3);
    expect(buildings[3].poly).toBe(fill.roof);
  }, 30_000);
});
