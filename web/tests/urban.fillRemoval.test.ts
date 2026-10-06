import { describe, expect, it } from 'vitest';
import type { Polygon } from '../src/gen/core/geom';
import { area } from '../src/gen/geo/poly';
import { finalizeFootprints } from '../src/gen/urban/footprintFinal';

const rect = (x0: number, y0: number, x1: number, y1: number): Polygon => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

// Native coordinates from the final wizard-city 4 and European fringe p4uefz
// audits. Both ordinary infills are simple polygons with a zero-width contact;
// neither can be made into a served room under the supplied physical proof.
const cases = [
  { name: 'wizard-city 4', block: 8, roof: [
    { x: 653.8005039641969, y: 585.1177825261739 }, { x: 644.016, y: 584.3 },
    { x: 642.721, y: 581.412 }, { x: 643.159, y: 578.596 },
    { x: 643.113, y: 577.467 }, { x: 644.48, y: 578.055 },
    { x: 653.091, y: 585.05 }, { x: 655.1035982074112, y: 578.397764914976 },
    { x: 655.5106479942446, y: 578.5030010079547 },
  ], owner: [
    { x: 655.5474106825136, y: 578.512505402272 }, { x: 653.839, y: 585.121 },
    { x: 644.016, y: 584.3 }, { x: 642.721, y: 581.412 },
    { x: 643.159, y: 578.596 }, { x: 643.113, y: 577.467 },
    { x: 644.48, y: 578.055 }, { x: 653.091, y: 585.05 },
    { x: 655.1035982074112, y: 578.397764914976 },
  ] },
  { name: 'fringe p4uefz', block: 44, roof: [
    { x: 1758.4156155209027, y: 1594.6916471381703 },
    { x: 1760.508246558563, y: 1587.5588956624276 },
    { x: 1760.059662084847, y: 1587.1269393836521 },
    { x: 1754.5005102744042, y: 1584.7562329794637 },
    { x: 1755.9873835750732, y: 1583.2056126898228 },
    { x: 1762.9762843792296, y: 1589.9354478958592 },
  ], owner: [
    { x: 1763.843685879212, y: 1589.6600965187492 },
    { x: 1758.15, y: 1595.597 }, { x: 1760.571, y: 1587.345 },
    { x: 1734.16, y: 1576.082 }, { x: 1719.259, y: 1570.836 },
    { x: 1738.711, y: 1569.06 }, { x: 1742.6857215942614, y: 1569.286418751247 },
  ] },
];

describe('last-resort ordinary infill removal', () => {
  for (const f of cases) it(`returns the irreparable ${f.name} infill to open land after live access proof`, () => {
    const peers = Array.from({ length: 49 }, (_, j) => ({
      poly: rect(3000 + 20 * j, 0, 3010 + 20 * j, 10), kind: 'house' as const,
    }));
    const buildings = [{ poly: f.roof as Polygon, kind: 'house' as const, parcel: 0 }, ...peers];
    const backLand: { outer: Polygon; holes: Polygon[] }[] = [];
    const seen: number[][] = [];
    const result = finalizeFootprints({ buildings,
      parcels: [{ poly: f.owner as Polygon, use: 'plot', block: f.block }], backLand,
      placementClear: () => false, validateParts: () => false,
      allowFillRemoval: true,
      validateRemoval: (i, pending) => { expect(i).toBe(0); seen.push([...pending]); return true; },
    });
    expect(seen).toEqual([[0]]);
    expect(result.removed).toEqual([0]);
    expect(result.invalid).toEqual([]);
    expect(result.changed.has(f.block)).toBe(true);
    expect(buildings).toHaveLength(49);
    expect(buildings[0]).toBe(peers[0]);
    expect(backLand).toEqual([{ outer: f.roof, holes: [] }]);
    expect(result.releasedArea).toBeCloseTo(area(f.roof), 5);
  }, 30_000);

  it('leaves an irreparable roof untouched when the peer-access proof refuses removal', () => {
    const f = cases[1];
    const buildings = [{ poly: f.roof as Polygon, kind: 'house' as const, parcel: 0 }];
    const backLand: { outer: Polygon; holes: Polygon[] }[] = [];
    const result = finalizeFootprints({ buildings,
      parcels: [{ poly: f.owner as Polygon, use: 'plot', block: f.block }], backLand,
      placementClear: () => false, validateParts: () => false,
      allowFillRemoval: true, validateRemoval: () => false,
    });
    expect(result.removed).toEqual([]);
    expect(result.invalid).toEqual([0]);
    expect(buildings[0].poly).toBe(f.roof);
    expect(backLand).toEqual([]);
  }, 30_000);

  it('keeps original indices stable through two deferred removals', () => {
    const f = cases[1];
    const shift = (poly: Polygon): Polygon => poly.map((p) => ({ x: p.x + 100, y: p.y }));
    const peers = Array.from({ length: 100 }, (_, j) => ({
      poly: rect(3000 + 20 * j, 0, 3010 + 20 * j, 10), kind: 'house' as const,
    }));
    const buildings = [{ poly: f.roof as Polygon, kind: 'house' as const, parcel: 0 },
      { poly: shift(f.roof as Polygon), kind: 'house' as const, parcel: 1 }, ...peers];
    const backLand: { outer: Polygon; holes: Polygon[] }[] = [];
    const observed: { i: number; pending: number[]; length: number }[] = [];
    const result = finalizeFootprints({ buildings,
      parcels: [{ poly: f.owner as Polygon, use: 'plot', block: 44 },
        { poly: shift(f.owner as Polygon), use: 'plot', block: 45 }], backLand,
      placementClear: () => false, validateParts: () => false,
      allowFillRemoval: true,
      validateRemoval: (i, pending) => {
        observed.push({ i, pending: [...pending], length: buildings.length });
        return true;
      },
    });
    expect(observed).toEqual([{ i: 0, pending: [0], length: 102 },
      { i: 1, pending: [0, 1], length: 102 }]);
    expect(result.removed).toEqual([0, 1]);
    expect(buildings).toHaveLength(100);
    expect(buildings[0]).toBe(peers[0]);
    expect(backLand).toHaveLength(2);
    expect(result.changed).toEqual(new Set([44, 45]));
  }, 30_000);

  it('reports an unrepaired later roof at its final index after an earlier removal', () => {
    const f = cases[1];
    const shift = (poly: Polygon): Polygon => poly.map((p) => ({ x: p.x + 100, y: p.y }));
    const later = { poly: shift(f.roof as Polygon), kind: 'house' as const, parcel: 1 };
    const peers = Array.from({ length: 50 }, (_, j) => ({
      poly: rect(3000 + 20 * j, 0, 3010 + 20 * j, 10), kind: 'house' as const,
    }));
    const buildings = [{ poly: f.roof as Polygon, kind: 'house' as const, parcel: 0 }, later, ...peers];
    const result = finalizeFootprints({ buildings,
      parcels: [{ poly: f.owner as Polygon, use: 'plot', block: 44 },
        { poly: shift(f.owner as Polygon), use: 'plot', block: 45 }], backLand: [],
      placementClear: () => false, validateParts: () => false,
      allowFillRemoval: true, validateRemoval: (i) => i === 0,
    });
    expect(result.removed).toEqual([0]);
    expect(result.invalid).toEqual([0]);
    expect(buildings[0]).toBe(later);
  }, 30_000);

  it('refuses removal when it would breach the housing-area budget', () => {
    const f = cases[0];
    const peers = Array.from({ length: 49 }, (_, j) => ({
      poly: rect(3000 + 10 * j, 0, 3005 + 10 * j, 5), kind: 'house' as const,
    }));
    const buildings = [{ poly: f.roof as Polygon, kind: 'house' as const, parcel: 0 }, ...peers];
    const backLand: { outer: Polygon; holes: Polygon[] }[] = [];
    const result = finalizeFootprints({ buildings,
      parcels: [{ poly: f.owner as Polygon, use: 'plot', block: f.block }], backLand,
      placementClear: () => false, validateParts: () => false,
      allowFillRemoval: true, validateRemoval: () => true,
    });
    expect(result.removed).toEqual([]);
    expect(result.invalid).toEqual([0]);
    expect(buildings).toHaveLength(50);
    expect(backLand).toEqual([]);
  }, 30_000);

  it('keeps a plausible triangle even when optional removal is enabled', () => {
    const triangle: Polygon = [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 4.5, y: 8 }];
    const buildings = [{ poly: triangle, kind: 'house' as const, parcel: 0 }];
    const result = finalizeFootprints({ buildings,
      parcels: [{ poly: rect(-1, -1, 10, 9), use: 'plot', block: 1 }], backLand: [],
      allowFillRemoval: true, validateRemoval: () => true,
    });
    expect(result.removed).toEqual([]);
    expect(buildings[0].poly).toBe(triangle);
  });

  it('keeps intentional ring, longhouse and pueblo room footprints under all fallback callbacks', () => {
    const buildings = [
      { poly: rect(0, 0, 18, 2.4), kind: 'house', arch: 'longhouse', parcel: 0 },
      { poly: rect(25, 0, 43, 2.4), kind: 'back', arch: 'granary', ring: true, parcel: 1 },
      { poly: rect(50, 0, 53, 3), kind: 'house', arch: 'pueblo-room', parcel: 2 },
    ];
    const source = JSON.stringify(buildings);
    const backLand: { outer: Polygon; holes: Polygon[] }[] = [];
    let callbacks = 0;
    const result = finalizeFootprints({ buildings,
      parcels: [
        { poly: rect(-1, -1, 20, 4), use: 'plot', block: 0 },
        { poly: rect(24, -1, 45, 4), use: 'plot', block: 1 },
        { poly: rect(49, -1, 54, 4), use: 'plot', block: 2 },
      ], backLand, allowFillRemoval: true,
      placementClear: () => { callbacks++; return true; },
      validateParts: () => { callbacks++; return true; },
      validateRemoval: () => { callbacks++; return true; },
    });
    expect(JSON.stringify(buildings)).toBe(source);
    expect(callbacks).toBe(0);
    expect(backLand).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.invalid).toEqual([]);
  });
});
