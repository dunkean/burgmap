import { describe, expect, it } from 'vitest';
import type { Polygon } from '../src/gen/core/geom';
import { area, minNeck } from '../src/gen/geo/poly';
import { finalizeFootprints } from '../src/gen/urban/footprintFinal';
import { splitLong } from '../src/gen/urban/access';
import { blockReach, makeStreetAt } from '../src/gen/urban/access';
import { mpArea, tryIntersection } from '../src/gen/geo/bool';

const rect = (x0: number, y0: number, x1: number, y1: number): Polygon => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

describe('last footprint pass', () => {
  it('keeps a plausible triangular dwelling byte for byte', () => {
    const triangle: Polygon = [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 4.5, y: 8 }];
    const source = JSON.stringify(triangle);
    const u = { buildings: [{ poly: triangle, kind: 'house', parcel: 0 }], parcels: [{ poly: rect(-1, -1, 10, 9), use: 'plot', block: 2 }], backLand: [] };
    const result = finalizeFootprints(u);
    expect(JSON.stringify(u.buildings[0].poly)).toBe(source);
    expect(result.invalid).toEqual([]);
    expect(result.changed.size).toBe(0);
    expect(minNeck(triangle)).toBeNull();
  });

  it('releases the narrow arm of an L as accounted open land', () => {
    const l: Polygon = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 2 },
      { x: 8, y: 2 }, { x: 8, y: 9 }, { x: 0, y: 9 }];
    const u = { buildings: [{ poly: l, kind: 'house', parcel: 0 },
      { poly: rect(1000, 0, 1032, 32), kind: 'house', parcel: 0 }], parcels: [{ poly: rect(-1, -1, 13, 10), use: 'plot', block: 5 }],
      backLand: [] as { outer: Polygon; holes: Polygon[] }[], tipConstrained: () => true };
    const initial = area(l);
    const result = finalizeFootprints(u);
    expect(result.invalid).toEqual([]);
    expect(result.changed.has(5)).toBe(true);
    expect(u.buildings).toHaveLength(2);
    expect(u.backLand).toHaveLength(1);
    expect(area(u.buildings[0].poly) + area(u.backLand[0].outer)).toBeCloseTo(initial, 6);
    expect(minNeck(u.buildings[0].poly)?.w ?? Infinity).toBeGreaterThanOrEqual(3.6);
  });

  it('truncates only a disproportionate house tip inside its owner parcel', () => {
    const needle: Polygon = [{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 10 }, { x: 0, y: 10 }, { x: -40, y: 5 }];
    const u = { buildings: [{ poly: needle, kind: 'house', parcel: 0 },
      { poly: rect(1000, 0, 1032, 32), kind: 'house', parcel: 0 }],
      parcels: [{ poly: rect(-41, -1, 25, 11), use: 'plot', block: 4 },
        { poly: rect(-44, 3, -41, 7), use: 'plot', block: 6 }], backLand: [] as { outer: Polygon; holes: Polygon[] }[],
      tipConstrained: () => true };
    const result = finalizeFootprints(u);
    expect(result.changed.has(4)).toBe(true);
    expect(u.buildings).toHaveLength(2);
    expect(u.backLand).toHaveLength(1);
    expect(area(u.buildings[0].poly) + area(u.backLand[0].outer)).toBeCloseTo(area(needle), 6);
    expect(area(u.backLand[0].outer)).toBeLessThan(0.03 * area(needle));
  });

  it('keeps the whole pointed house at a dry open quarter edge', () => {
    const needle: Polygon = [{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 10 }, { x: 0, y: 10 }, { x: -40, y: 5 }];
    const u = { buildings: [{ poly: needle, kind: 'house', parcel: 0 }],
      parcels: [{ poly: rect(-41, -1, 25, 11), use: 'plot', block: 4 }], backLand: [] };
    finalizeFootprints(u);
    expect(u.buildings[0].poly).toEqual(needle);
    expect(u.backLand).toEqual([]);
  });

  it('keeps a sharp entrance when the access validator rejects the truncation', () => {
    const needle: Polygon = [{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 10 }, { x: 0, y: 10 }, { x: -40, y: 5 }];
    const u = { buildings: [{ poly: needle, kind: 'house', parcel: 0 }],
      parcels: [{ poly: rect(-41, -1, 25, 11), use: 'plot', block: 4 }], backLand: [] as { outer: Polygon; holes: Polygon[] }[],
      tipConstrained: () => true, validateParts: () => false };
    finalizeFootprints(u);
    expect(u.buildings[0].poly).toEqual(needle);
    expect(u.backLand).toEqual([]);
  });

  it('removes exact duplicate and retraced vertices without losing area at 20 km', () => {
    const p: Polygon = [{ x: 20000, y: 20000 }, { x: 20008, y: 20000 }, { x: 20008, y: 20000 },
      { x: 20008, y: 20006 }, { x: 20004, y: 20006 }, { x: 20004, y: 20008 },
      { x: 20004, y: 20006 }, { x: 20000, y: 20006 }];
    const u = { buildings: [{ poly: p, kind: 'house', parcel: 0 }], parcels: [{ poly: rect(19999, 19999, 20009, 20009), use: 'plot', block: 7 }], backLand: [] };
    const initial = area(p);
    const result = finalizeFootprints(u);
    expect(result.cleaned).toBe(1);
    expect(area(u.buildings[0].poly)).toBeCloseTo(initial, 6);
    expect(u.buildings[0].poly.length).toBeLessThan(p.length);
  });

  it('keeps useful splitLong pieces when a small fragment fails', () => {
    const tapered: Polygon = [{ x: 0, y: 0 }, { x: 21, y: 0 }, { x: 21, y: 1 }, { x: 18, y: 5 }, { x: 0, y: 5 }];
    const parts = splitLong([{ poly: tapered, kind: 'house' }]);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.reduce((sum, p) => sum + area(p.poly), 0)).toBeGreaterThanOrEqual(0.7 * area(tapered));
  });

  it('preserves a 2.4 m courtyard room chosen by its cultural builder', () => {
    const room = rect(0, 0, 12, 2.4);
    const u = { buildings: [{ poly: room, kind: 'house', arch: 'persian-courtyard-house', parcel: 0,
      courtyards: [rect(4, 0.2, 8, 1.8)] }],
    parcels: [{ poly: rect(-1, -1, 13, 4), use: 'plot', block: 9 }], backLand: [] };
    const before = JSON.stringify(u.buildings[0]);
    expect(finalizeFootprints(u).invalid).toEqual([]);
    expect(JSON.stringify(u.buildings[0])).toBe(before);
  });

  it('reports a convex matchstick and leaves a rejected access transaction intact', () => {
    const stick = rect(0, 0, 24, 2.8);
    const l: Polygon = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 2 },
      { x: 8, y: 2 }, { x: 8, y: 9 }, { x: 0, y: 9 }];
    const u = { buildings: [{ poly: stick, kind: 'house', parcel: 0 }, { poly: l, kind: 'house', parcel: 1 }],
      parcels: [{ poly: rect(-1, -1, 25, 4), use: 'plot', block: 0 },
        { poly: rect(-1, -1, 13, 10), use: 'plot', block: 1 }],
      backLand: [] as { outer: Polygon; holes: Polygon[] }[],
      tipConstrained: () => true,
      validateParts: () => false };
    const before = JSON.stringify(u.buildings);
    const result = finalizeFootprints(u);
    expect(result.invalid).toEqual([0, 1]);
    expect(JSON.stringify(u.buildings)).toBe(before);
    expect(u.backLand).toEqual([]);
  });

  it('divides a long, wide convex house into accessed rooms with exact area accounting', () => {
    const long = rect(0, 0, 25, 5);
    const calls: number[] = [];
    const u = { buildings: [{ poly: long, kind: 'house', parcel: 0 }],
      parcels: [{ poly: rect(-1, -1, 26, 6), use: 'plot', block: 3 }],
      backLand: [] as { outer: Polygon; holes: Polygon[] }[],
      validateParts: (_index: number, parts: Polygon[]) => { calls.push(parts.length); return true; } };
    const result = finalizeFootprints(u);
    expect(result.invalid).toEqual([]);
    expect(u.buildings.length).toBeGreaterThan(1);
    expect(calls.some((n) => n > 1)).toBe(true);
    expect(u.buildings.reduce((s, b) => s + area(b.poly), 0) + u.backLand.reduce((s, p) => s + area(p.outer), 0)).toBeCloseTo(area(long), 5);
  });

  it('does not mistake a reflex-to-adjacent-vertex notch for a corridor neck', () => {
    const p: Polygon = [
      { x: 466.04609604629417, y: 406.8345555735861 }, { x: 473.0504106462478, y: 405.65722850093124 },
      { x: 474.80260638499675, y: 415.76683706209525 }, { x: 471.8483017481581, y: 416.26341424751223 },
      { x: 472.3185907591118, y: 420.40231659191824 }, { x: 467.6764143525161, y: 421.18260135519273 },
    ];
    expect(minNeck(p)?.w ?? Infinity).toBeGreaterThanOrEqual(3.6);
  });

  it('removes a zero-width self-touch spur without claiming the neighbouring roof', () => {
    const roof: Polygon = [
      { x: 750.1853459203145, y: 470.69473553358483 }, { x: 735.0790724236791, y: 464.6176146560623 },
      { x: 737.8566088394319, y: 455.3010038142782 }, { x: 743.9482081792856, y: 457.11707612683387 },
      { x: 743.8766532149907, y: 468.1568039809795 }, { x: 746.0559644977345, y: 469.0335217299288 },
      { x: 750.8496467209039, y: 469.0434421365991 },
    ];
    const backLand: { outer: Polygon; holes: Polygon[] }[] = [];
    const u = { buildings: [{ poly: roof, kind: 'rear', parcel: 0 },
      { poly: rect(1000, 0, 1032, 32), kind: 'house', parcel: 0 }],
      parcels: [{ poly: rect(730, 450, 755, 480), use: 'plot', block: 2 }], backLand,
      validateParts: () => true };
    expect(minNeck(roof)?.w).toBe(0);
    const result = finalizeFootprints(u);
    expect(result.invalid).toEqual([]);
    expect(u.buildings).toHaveLength(2);
    expect(area(u.buildings[0].poly)).toBeGreaterThanOrEqual(0.95 * area(roof));
    expect(minNeck(u.buildings[0].poly)?.w ?? Infinity).toBeGreaterThanOrEqual(3.6);
    expect(area(u.buildings[0].poly) + backLand.reduce((s, p) => s + area(p.outer), 0)).toBeCloseTo(area(roof), 5);
  });

  it('blunts pinned courtyard-hall needles while preserving their U-shaped court', () => {
    const halls: Polygon[] = [
      [
        { x: 555.3520269788362, y: 611.9927584470759 }, { x: 557.795, y: 601.828 },
        { x: 560.136, y: 602.549 }, { x: 558.148, y: 600.806 },
        { x: 576.5732647064406, y: 586.6399804020078 }, { x: 578.4713703035104, y: 590.471299330912 },
        { x: 565.489, y: 601.042 }, { x: 565.8547563874106, y: 601.5872971109694 },
        { x: 580.4067878323797, y: 594.3779322522503 }, { x: 582.4761655139228, y: 598.55496323229 },
      ],
      [
        { x: 575.9663826814734, y: 576.3208745858894 }, { x: 590.1337055719733, y: 569.3021232438691 },
        { x: 600.6920075177587, y: 589.530501342162 }, { x: 582.4761655139228, y: 598.55496323229 },
        { x: 580.4067878323797, y: 594.3779322522503 }, { x: 595.073, y: 587.112 },
        { x: 591.35241057427, y: 579.9831051240459 }, { x: 578.4713703035104, y: 590.471299330912 },
        { x: 576.5732647064406, y: 586.6399804020078 }, { x: 591.527, y: 575.143 },
      ],
    ];
    const owner: Polygon = [
      { x: 557.795, y: 601.828 }, { x: 560.136, y: 602.549 }, { x: 558.148, y: 600.806 },
      { x: 591.527, y: 575.143 }, { x: 573.6, y: 576.5 },
      { x: 590.4388103726571, y: 568.1577448107457 }, { x: 609.6848106088646, y: 605.0306597602223 },
      { x: 604.5644188837042, y: 607.9327869993749 }, { x: 606.962351888121, y: 613.1895370675534 },
      { x: 547.75, y: 640.2 }, { x: 543.751, y: 638.846 }, { x: 543.916, y: 636.223 },
      { x: 549.45, y: 636.6 }, { x: 549.45, y: 636.55 },
    ];
    const streetAt = makeStreetAt([{ path: [{ x: 573.6, y: 573.5 }, { x: 590.4388, y: 565.16 }], width: 6 }], []);
    const reached = blockReach(owner, halls, streetAt);
    let accessChecks = 0;
    const u = { buildings: halls.map((poly) => ({ poly, kind: 'hall', arch: 'courtyard-hall', parcel: 0 })),
      parcels: [{ poly: owner, use: 'plot', block: 28 }],
      backLand: [] as { outer: Polygon; holes: Polygon[] }[], openQuarterEdge: () => false,
      tipConstrained: () => true,
      validateParts: (i: number, parts: Polygon[]) => {
        accessChecks++;
        const now = blockReach(owner, halls.map((poly, j) => j === i ? parts[0] : poly), streetAt);
        return now.every((v, j) => v || !reached[j]);
      } };
    const oldArea = halls.reduce((s, p) => s + area(p), 0);
    const result = finalizeFootprints(u);
    expect(result.invalid).toEqual([]);
    expect(u.buildings).toHaveLength(2);
    expect(u.backLand).toHaveLength(4);
    expect(accessChecks).toBe(4);
    u.buildings.forEach((b, i) => {
      expect(area(b.poly)).toBeGreaterThan(0.94 * area(halls[i]));
      expect(minNeck(b.poly)?.w ?? Infinity).toBeLessThan(3.6);
    });
    expect(u.buildings.reduce((s, b) => s + area(b.poly), 0)
      + u.backLand.reduce((s, p) => s + area(p.outer), 0)).toBeCloseTo(oldArea, 5);
    const exterior = { buildings: halls.map((poly) => ({ poly, kind: 'hall', arch: 'courtyard-hall', parcel: 0 })),
      parcels: [{ poly: owner, use: 'plot', block: 28 }], backLand: [] as { outer: Polygon; holes: Polygon[] }[],
      openQuarterEdge: () => true, tipConstrained: () => false };
    finalizeFootprints(exterior);
    expect(exterior.backLand).toHaveLength(0);
    expect(exterior.buildings.map((b) => area(b.poly))).toEqual(halls.map(area));
  });

  it('removes the zero-area return exposed by the pinned self-touch repair', () => {
    const roof: Polygon = [
      { x: 750.1853459203145, y: 470.69473553358483 }, { x: 735.0790724236791, y: 464.6176146560623 },
      { x: 737.8566088394319, y: 455.3010038142782 }, { x: 743.9482081792856, y: 457.11707612683387 },
      { x: 743.8766532149907, y: 468.1568039809795 }, { x: 746.0559644977345, y: 469.0335217299288 },
      { x: 750.8496467209039, y: 469.0434421365991 },
    ];
    const buildings = [{ poly: roof, kind: 'rear', parcel: 0 },
      { poly: rect(1000, 0, 1032, 32), kind: 'house', parcel: 0 }];
    const backLand: { outer: Polygon; holes: Polygon[] }[] = [];
    const result = finalizeFootprints({ buildings, parcels: [{ poly: rect(730, 450, 752, 473),
      use: 'plot', block: 1 }], backLand, validateParts: () => true });
    expect(result.invalid).toEqual([]);
    expect(buildings[0].poly).toHaveLength(4);
    expect(area(buildings[0].poly) + area(backLand[0].outer)).toBeCloseTo(area(roof), 5);
  });

  it('trims anonymous garden and earlier released land atomically when a room fills its notch', () => {
    const notch: Polygon = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
      { x: 6, y: 10 }, { x: 6, y: 8 }, { x: 4, y: 8 }, { x: 4, y: 10 }, { x: 0, y: 10 }];
    const gardens = [rect(4, 8, 5, 10)];
    const backLand = [{ outer: rect(5, 8, 6, 10), holes: [] as Polygon[] }];
    const initial = area(notch) + gardens.reduce((s, p) => s + area(p), 0)
      + backLand.reduce((s, p) => s + area(p.outer), 0);
    const buildings = [{ poly: notch, kind: 'house', parcel: 0 }];
    const result = finalizeFootprints({ buildings,
      parcels: [{ poly: rect(-2, -2, 12, 12), use: 'plot', block: 0 }],
      gardens, backLand, placementClear: () => true, validateParts: () => true });
    expect(result.invalid).toEqual([]);
    expect(buildings).toHaveLength(1);
    for (const open of [...gardens.map((outer) => ({ outer, holes: [] })), ...backLand]) {
      expect(mpArea(tryIntersection(buildings[0].poly, [open]).pieces)).toBeLessThanOrEqual(1e-6);
    }
    expect(area(buildings[0].poly) + gardens.reduce((s, p) => s + area(p), 0)
      + backLand.reduce((s, p) => s + area(p.outer), 0)).toBeCloseTo(initial, 5);
  });

  it('releases a sub-square-metre drafting spur on a dry open edge', () => {
    const roof: Polygon = [{ x: 0, y: 0 }, { x: 8.4, y: 0 }, { x: 8.4, y: 2 },
      { x: 8, y: 2 }, { x: 8, y: 22 }, { x: 0, y: 22 }];
    const backLand: { outer: Polygon; holes: Polygon[] }[] = [];
    const buildings = [{ poly: roof, kind: 'house', parcel: 0 }];
    const result = finalizeFootprints({ buildings,
      parcels: [{ poly: rect(-1, -1, 10, 23), use: 'plot', block: 1 }], backLand,
      openQuarterEdge: () => true, tipConstrained: () => false, validateParts: () => true });
    expect(result.invalid).toEqual([]);
    expect(buildings).toHaveLength(1);
    expect(area(buildings[0].poly)).toBe(176);
    expect(backLand).toHaveLength(1);
    expect(area(backLand[0].outer)).toBeCloseTo(0.8, 6);
    expect(area(buildings[0].poly) + area(backLand[0].outer)).toBeCloseTo(area(roof), 6);
  });
});
