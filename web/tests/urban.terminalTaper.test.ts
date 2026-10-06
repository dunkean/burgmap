import { describe, expect, it } from 'vitest';
import type { Polygon, UrbanBuilding, UrbanParcel } from '../src/gen/types';
import { area } from '../src/gen/geo/poly';
import { mpArea, tryDifference, tryIntersection } from '../src/gen/geo/bool';
import { polyInside } from '../src/gen/geo/split';
import { terminalTapers } from '../src/gen/urban/terminalTaper';
import { finalizeFootprints } from '../src/gen/urban/footprintFinal';
import { footprintPlacementGuard, physicalTipConstraint } from '../src/gen/urban/edgeFinish';
import { blockReach, makeStreetAt } from '../src/gen/urban/access';
import type { PolyH, UrbanStreet } from '../src/gen/types';
import native from './fixtures/medieval-terminal-tapers.json';

const rect = (x: number, y: number, w: number, h: number): Polygon => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];
const taper: Polygon = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 18, y: 3 },
  { x: 18, y: 4 }, { x: 12, y: 7 }, { x: 0, y: 7 }];
const cases = native.cases as unknown as { id: number; building: UrbanBuilding; owner: UrbanParcel; peers: UrbanBuilding[] }[];

describe('useful terminal room widths', () => {
  it('recognises long capped arms despite a wide main roof and preserves normal corner chamfers', () => {
    expect(terminalTapers(taper)).toHaveLength(1);
    expect(terminalTapers(taper)[0].thinLength).toBeGreaterThan(2);
    const chamfer = [{ x: 0, y: 0 }, { x: 11, y: 0 }, { x: 12, y: 1 }, { x: 12, y: 7 }, { x: 0, y: 7 }];
    expect(terminalTapers(chamfer)).toEqual([]);
    expect(terminalTapers(cases.find(c => c.id === 591)!.building.poly)).toEqual([]);
  });

  it('widens a complete terminal arm in its vacant owner before spending housing area', () => {
    const sourceArea = area(taper), building = { poly: taper, kind: 'house', parcel: 0 };
    const released: { outer: Polygon; holes: Polygon[] }[] = [];
    const owner = rect(-1, -2, 21, 11);
    const result = finalizeFootprints({ buildings: [building], parcels: [{ poly: owner, use: 'plot', block: 0 }],
      backLand: released, placementClear: () => true, validateParts: () => true, openQuarterEdge: () => false });
    expect(result.invalid).toEqual([]);
    expect(terminalTapers(building.poly)).toEqual([]);
    expect(area(building.poly)).toBeGreaterThan(sourceArea);
    expect(mpArea(tryDifference(taper, building.poly).pieces)).toBeLessThanOrEqual(1e-6);
    expect(polyInside(owner, building.poly)).toBe(true);
    expect(released).toEqual([]);
  });

  it('keeps an unblocked exterior arm whole and refuses a reduction outside the uniform reserve', () => {
    for (const exterior of [false, true]) {
      const sourcePoly = exterior ? taper : taper.map(p => p.x === 18 ? { ...p, x: 20.5 } : p);
      const building = { poly: sourcePoly, kind: 'house', parcel: 0 };
      const source = JSON.stringify(building.poly);
      const result = finalizeFootprints({ buildings: [building], parcels: [{ poly: sourcePoly, use: 'plot', block: 0 }],
        backLand: [], placementClear: () => true, validateParts: () => true,
        openQuarterEdge: () => exterior, tipConstrained: () => !exterior });
      expect(JSON.stringify(building.poly)).toBe(source);
      expect(result.removed).toEqual([]);
    }
  });

  for (const id of [43, 936, 934, 1067]) it(`repairs seeded medieval terminal room ${id} inside its native owner`, () => {
    const f = cases.find(c => c.id === id)!;
    const building: UrbanBuilding = { ...f.building, parcel: 0 };
    // Other mature rooms supply the same pass-wide reserve used by the production layer.
    const mature = { poly: rect(4000, 4000, 100, 100), kind: 'house' };
    const buildings = [building, ...f.peers.map(b => ({ ...b, parcel: 0 })), mature];
    const initial = buildings.filter(b => ['house', 'rear', 'back'].includes(b.kind)).reduce((s, b) => s + area(b.poly), 0);
    const released: { outer: Polygon; holes: Polygon[] }[] = [];
    const result = finalizeFootprints({ buildings, parcels: [f.owner], backLand: released, gardens: [],
      placementClear: () => true, validateParts: () => true, openQuarterEdge: () => false, tipConstrained: () => true });
    expect(result.invalid).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(terminalTapers(building.poly)).toEqual([]);
    expect(polyInside(f.owner.poly, building.poly)).toBe(true);
    expect(area(building.poly)).toBeGreaterThanOrEqual(0.7 * area(f.building.poly));
    const final = buildings.filter(b => ['house', 'rear', 'back'].includes(b.kind)).reduce((s, b) => s + area(b.poly), 0);
    expect(final).toBeGreaterThanOrEqual(0.97 * initial);
    for (const peer of f.peers) {
      expect(mpArea(tryIntersection(building.poly, peer.poly).pieces)).toBeLessThanOrEqual(
        mpArea(tryIntersection(f.building.poly, peer.poly).pieces) + 1e-6);
    }
  });

  it('preserves plausible triangles and the useful short back range byte for byte', () => {
    for (const id of [591, 545, 1071]) {
      const f = cases.find(c => c.id === id)!;
      const building: UrbanBuilding = { ...f.building, parcel: 0 }, source = JSON.stringify(building.poly);
      finalizeFootprints({ buildings: [building], parcels: [f.owner], backLand: [] });
      expect(JSON.stringify(building.poly)).toBe(source);
    }
  });

  it('keeps the seeded exterior barn whole when its thin cap runs along free surrounding land', () => {
    const f = cases.find(c => c.id === 1063)!;
    const building: UrbanBuilding = { ...f.building, parcel: 0 }, source = JSON.stringify(building.poly);
    const peers = f.peers.map(b => ({ ...b, parcel: 0 }));
    finalizeFootprints({ buildings: [building, ...peers], parcels: [f.owner], backLand: [], gardens: [],
      placementClear: () => true, validateParts: () => true,
      openQuarterEdge: () => false, tipConstrained: () => false });
    expect(JSON.stringify(building.poly)).toBe(source);
  });

  it('fills the seeded arrow corner inside its owner without entering the actual road ribbons', () => {
    const f = native.cases.find(c => c.id === 560)! as unknown as {
      building: UrbanBuilding; owner: UrbanParcel; peers: UrbanBuilding[];
      block: Polygon; streets: UrbanStreet[]; protectedLand: PolyH[];
    };
    const original = f.building.poly, building: UrbanBuilding = { ...f.building, parcel: 0 };
    const peers = f.peers.map(b => ({ ...b, parcel: undefined }));
    const streetAt = makeStreetAt(f.streets, []);
    const before = blockReach(f.block, [original, ...peers.map(b => b.poly)], streetAt);
    const constrained = physicalTipConstraint(f.protectedLand, () => false);
    expect(constrained(terminalTapers(original)[0].tip, terminalTapers(original)[0].outward)).toBe(true);
    const result = finalizeFootprints({ buildings: [building, ...peers], parcels: [f.owner], backLand: [], gardens: [],
      placementClear: footprintPlacementGuard(f.protectedLand, () => false),
      tipConstrained: constrained, openQuarterEdge: () => false,
      validateParts: (_i, parts) => {
        const after = blockReach(f.block, [...parts, ...peers.map(b => b.poly)], streetAt);
        return after.every((reached, j) => reached || !before[j]);
      } });
    expect(result.removed).toEqual([]);
    expect(terminalTapers(building.poly)).toEqual([]);
    expect(area(building.poly)).toBeGreaterThan(area(original));
    expect(mpArea(tryDifference(original, building.poly).pieces)).toBeLessThanOrEqual(1e-6);
    expect(mpArea(tryDifference(building.poly, f.owner.poly).pieces)).toBeLessThanOrEqual(1e-6);
    const added = tryDifference(building.poly, original);
    expect(mpArea(tryIntersection(added.pieces, f.protectedLand).pieces)).toBeLessThanOrEqual(1e-6);
  });
});
