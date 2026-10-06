import { describe, expect, it } from 'vitest';
import type { Polygon, Vec2 } from '../src/gen/core/geom';
import { area, inscribed, minNeck } from '../src/gen/geo/poly';
import { mpArea, tryDifference, tryIntersection } from '../src/gen/geo/bool';
import { blockReach, makeStreetAt } from '../src/gen/urban/access';
import { streetStrips } from '../src/gen/urban/openfringe';
import { finalizeFootprints } from '../src/gen/urban/footprintFinal';
import native from './fixtures/urban-fringe-fills-v15.json';

type NativeCase = { i: number; kind: string; arch: string; roof: Polygon; owner: Polygon;
  front: [Vec2, Vec2]; block: Polygon; peers: { i: number; poly: Polygon }[];
  occupied: { i: number; poly: Polygon }[] };
const fixture = native as unknown as { streets: { path: Vec2[]; width: number; widths?: number[] }[];
  places: Polygon[]; water: { outer: Polygon; holes: Polygon[] }[];
  walls: { path: Vec2[]; thickness?: number }[];
  lines: { path: Vec2[]; width?: number; closed?: boolean }[]; cases: NativeCase[] };
const streetAt = makeStreetAt(fixture.streets, fixture.places);
const reserve = [...fixture.water,
  ...fixture.streets.flatMap((s) => streetStrips(s.path, s.widths ?? s.width)),
  ...fixture.walls.flatMap((w) => streetStrips([...w.path, w.path[0]], Math.max(w.thickness ?? 1, 5.6))),
  ...fixture.lines.flatMap((l) => streetStrips(l.closed ? [...l.path, l.path[0]] : l.path, l.width ?? 1)),
];
const room = (f: NativeCase) => f.peers.findIndex((p) => p.i === f.i);
const rect = (x: number): Polygon => [
  { x, y: 0 }, { x: x + 10, y: 0 }, { x: x + 10, y: 10 }, { x, y: 10 },
];

describe('native fringe infill decisions', () => {
  it('keeps a real small room from roof 647 and returns its unusable arms to the yard', () => {
    const f = fixture.cases.find((c) => c.i === 647)!;
    const before = blockReach(f.block, f.peers.map((p) => p.poly), streetAt);
    const buildings = [{ poly: f.roof, kind: f.kind, arch: f.arch, parcel: 0 },
      ...f.occupied.map((p) => ({ poly: p.poly, kind: 'landmark' })),
      ...Array.from({ length: 50 }, (_, j) => ({ poly: rect(3000 + 20 * j), kind: 'house' }))];
    const backLand: { outer: Polygon; holes: Polygon[] }[] = [];
    const result = finalizeFootprints({ buildings,
      parcels: [{ poly: f.owner, front: f.front, use: 'plot', block: 42 }], backLand,
      openQuarterEdge: () => false, tipConstrained: () => true,
      placementClear: (p) => {
        const hit = tryIntersection(p, reserve);
        return !hit.failed && mpArea(hit.pieces) <= 1e-6;
      },
      validateParts: (_, parts) => {
        const after = blockReach(f.block,
          f.peers.flatMap((p) => p.i === f.i ? parts : [p.poly]), streetAt);
        return after.every((served, j) => served || !before[j]);
      },
    });
    expect(result.invalid).not.toContain(0);
    expect(result.removed).toEqual([]);
    expect(area(buildings[0].poly)).toBeGreaterThanOrEqual(0.65 * area(f.roof));
    expect(area(buildings[0].poly)).toBeLessThan(0.70 * area(f.roof));
    expect(2 * inscribed(buildings[0].poly, [], 0.05).r).toBeGreaterThanOrEqual(3.2);
    expect(minNeck(buildings[0].poly)?.w ?? Infinity).toBeGreaterThanOrEqual(3.2);
    expect(mpArea(tryDifference(buildings[0].poly, f.owner).pieces)).toBeLessThanOrEqual(1e-6);
    expect(area(buildings[0].poly) + mpArea(backLand)).toBeCloseTo(area(f.roof), 5);
  }, 30_000);

  for (const reason of ['access', 'budget', 'free exterior'] as const) {
    it(`refuses a loss-making native 647 crop when ${reason} is unproved`, () => {
      const f = fixture.cases.find((c) => c.i === 647)!;
      const buildings = [{ poly: f.roof, kind: f.kind, arch: f.arch, parcel: 0 },
        ...f.occupied.map((p) => ({ poly: p.poly, kind: 'landmark' })),
        ...(reason === 'budget' ? [] : Array.from({ length: 50 }, (_, j) =>
          ({ poly: rect(3000 + 20 * j), kind: 'house' })))];
      const land: { outer: Polygon; holes: Polygon[] }[] = [];
      const result = finalizeFootprints({ buildings,
        parcels: [{ poly: f.owner, front: f.front, use: 'plot', block: 42 }], backLand: land,
        openQuarterEdge: () => reason === 'free exterior',
        tipConstrained: () => reason !== 'free exterior',
        placementClear: (p) => {
          const hit = tryIntersection(p, reserve);
          return !hit.failed && mpArea(hit.pieces) <= 1e-6;
        },
        validateParts: () => reason !== 'access',
      });
      expect(result.invalid).toContain(0);
      expect(buildings[0].poly).toBe(f.roof);
      expect(land).toEqual([]);
    }, 30_000);
  }

  for (const id of [723, 912]) it(`returns irreparable ordinary roof ${id} to its owner yard`, () => {
    const f = fixture.cases.find((c) => c.i === id)!;
    const before = blockReach(f.block, f.peers.map((p) => p.poly), streetAt);
    const buildings = [{ poly: f.roof, kind: f.kind, arch: f.arch, parcel: 0 },
      ...f.occupied.map((p) => ({ poly: p.poly, kind: 'landmark' })),
      ...Array.from({ length: 50 }, (_, j) => ({ poly: rect(3000 + 20 * j), kind: 'house' }))];
    const backLand: { outer: Polygon; holes: Polygon[] }[] = [];
    const result = finalizeFootprints({ buildings,
      parcels: [{ poly: f.owner, front: f.front, use: 'plot', block: id }], backLand,
      placementClear: () => false, validateParts: () => false,
      allowFillRemoval: true,
      validateRemoval: (i, pending) => {
        expect(i).toBe(0);
        expect(pending).toEqual([0]);
        const after = blockReach(f.block, f.peers.filter((p) => p.i !== f.i).map((p) => p.poly), streetAt);
        return after.every((served, j) => served || !before[j < room(f) ? j : j + 1]);
      },
    });
    expect(result.removed).toEqual([0]);
    expect(result.invalid).toEqual([]);
    expect(backLand).toEqual([{ outer: f.roof, holes: [] }]);
  }, 30_000);
});
