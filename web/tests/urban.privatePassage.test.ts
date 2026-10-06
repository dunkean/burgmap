import { describe, expect, it } from 'vitest';
import type { Polygon } from '../src/gen/core/geom';
import { privatePassageAccess } from '../src/gen/urban/privatePassage';
import { protectedGround } from '../src/gen/landuse/landscapeGround';
import { mpArea, tryIntersection } from '../src/gen/geo/bool';

const rect = (x0: number, y0: number, x1: number, y1: number): Polygon => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];
const main = rect(8, 8, 14, 14);
const path = [{ x: 0, y: 9 }, { x: 8, y: 9 }];
function fixture(streetX = -1) {
  const buildings = [{ kind: 'house', parcel: 0, poly: [
    { x: 0, y: 8.6 }, { x: 8, y: 8.6 }, { x: 8, y: 8 }, { x: 14, y: 8 },
    { x: 14, y: 14 }, { x: 8, y: 14 }, { x: 8, y: 9.4 }, { x: 0, y: 9.4 },
  ] }];
  return { buildings, parcels: [{ use: 'plot', block: 0, poly: rect(0, 0, 20, 20) }],
    blocks: [rect(0, 0, 20, 20)], streets: [{ path: [{ x: streetX, y: 0 }, { x: streetX, y: 20 }], width: 2 }],
    places: [], publicGround: [], passages: [], placementClear: () => true };
}

describe('real private pedestrian passages', () => {
  it('protects the visible private entrance from replayed natural ground inside the block', () => {
    const urban = { parcels: [], squares: [], landmarks: [], streets: [{ path, width: 0.8, private: true }] };
    const material = { gardens: [], naturalParcels: new Set(), earthStreets: false };
    const protectedLand = protectedGround(urban as never, undefined, material as never);
    const hit = tryIntersection(rect(1, 8.7, 7, 9.3), protectedLand);
    expect(hit.failed).toBe(false);
    expect(mpArea(hit.pieces)).toBeCloseTo(3.6, 6);
  });
  it('proves an existing public connection without committing a rejected or proposed passage', () => {
    const input = fixture(), before = JSON.stringify(input);
    const access = privatePassageAccess(input);
    expect(access.proposePrivatePassage(0, main, path, 0.8)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('refuses to turn a virtual block boundary into a street-side seed', () => {
    const input = fixture(100);
    expect(privatePassageAccess(input).proposePrivatePassage(0, main, path, 0.8)).toBe(false);
    expect(privatePassageAccess(input).connectPrivatePassage(0, main, path, 0.8)).toBe(false);
    expect(input.passages).toEqual([]);
  });

  it('requires exact street contact, then extends through unclaimed land to a real road edge', () => {
    const input = { ...fixture(-2.5), footprint: [{ outer: rect(0, 0, 20, 20), holes: [] }] };
    const before = JSON.stringify(input), access = privatePassageAccess(input);
    // The access raster can see this nearby road; the original ink still ends 1.5 m short.
    expect(access.proposePrivatePassage(0, main, path, 0.8)).toBe(false);
    const route = access.connectPrivatePassage(0, main, path, 0.8);
    expect(route).not.toBe(false);
    expect(route).toEqual([{ x: -1.5, y: 9 }, { x: -0.75, y: 9 }, ...path]);
    expect(access.proposePrivatePassage(0, main, route as typeof path, 0.8)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('requires a full-width flush cap, rejecting millimetre gaps and oblique point contacts', () => {
    const input = { ...fixture(-2.5), footprint: [{ outer: rect(0, 0, 20, 20), holes: [] }] };
    const access = privatePassageAccess(input);
    expect(access.proposePrivatePassage(0, main, [{ x: -1.5, y: 9 }, ...path], 0.8)).toBe(true);
    expect(access.proposePrivatePassage(0, main, [{ x: -1.499, y: 9 }, ...path], 0.8)).toBe(false);
    expect(access.proposePrivatePassage(0, main, [{ x: -1.48, y: 9 }, ...path], 0.8)).toBe(false);
    expect(access.proposePrivatePassage(0, main, [{ x: -1.501, y: 9 }, ...path], 0.8)).toBe(false);
    expect(access.proposePrivatePassage(0, main, [{ x: -1.5, y: 9 }, { x: 0, y: 10 }, { x: 8, y: 9 }], 0.8)).toBe(false);
  });

  it('can meet a true place edge at full passage width', () => {
    const input = { ...fixture(100), streets: [], places: [rect(-2, 0, 0, 20)] };
    expect(privatePassageAccess(input).proposePrivatePassage(0, main, path, 0.8)).toBe(true);
  });

  it('does not count a short corner seam as a full-width connection', () => {
    const input = fixture();
    input.streets = [{ path: [{ x: -1, y: 8.8 }, { x: -1, y: 9.2 }], width: 2 }];
    expect(privatePassageAccess(input).proposePrivatePassage(0, main, path, 0.8)).toBe(false);
  });

  it('turns an oblique approach into a perpendicular, flush street junction', () => {
    const input = { ...fixture(-2.5), footprint: [{ outer: rect(0, 0, 20, 20), holes: [] }] };
    const route = privatePassageAccess(input).connectPrivatePassage(0, main,
      [{ x: 0, y: 9.2 }, { x: 4, y: 9 }, { x: 8, y: 9 }], 0.8);
    expect(route).not.toBe(false);
    const connected = route as typeof path;
    expect(connected[0].x).toBeCloseTo(-1.5, 8);
    expect(connected[1].x).toBeGreaterThan(-1.5);
    expect(connected[1].y).toBeCloseTo(connected[0].y, 8);
    expect(privatePassageAccess(input).proposePrivatePassage(0, main, connected, 0.8)).toBe(true);
  });

  it('rejects a nearby false seed when a physical reserve blocks the extension', () => {
    const input = { ...fixture(-2.5), footprint: [{ outer: rect(0, 0, 20, 20), holes: [] }],
      placementClear: (poly: Polygon) => poly.every(p => p.x >= 0) };
    const access = privatePassageAccess(input);
    expect(access.proposePrivatePassage(0, main, path, 0.8)).toBe(false);
    expect(access.connectPrivatePassage(0, main, path, 0.8)).toBe(false);
  });

  it('can reuse the discarded arm outside its plot without granting new claimed land', () => {
    const input = { ...fixture(), parcels: [{ use: 'plot', block: 0, poly: rect(2, 0, 20, 20) }],
      footprint: [{ outer: rect(0, 0, 20, 20), holes: [] }] };
    const before = JSON.stringify(input);
    expect(privatePassageAccess(input).proposePrivatePassage(0, main, path, 0.8)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
    // A detour on fresh quarter land, even beside the same old arm, is refused.
    const detour = [{ x: 0, y: 9 }, { x: 3, y: 7 }, { x: 8, y: 9 }];
    expect(privatePassageAccess(input).proposePrivatePassage(0, main, detour, 0.8)).toBe(false);
  });

  it('checks survivor access before a deferred roof removal without mutating the block', () => {
    const input = fixture();
    input.buildings.push({ kind: 'house', parcel: 0, poly: rect(15, 8, 18, 11) });
    const before = JSON.stringify(input), access = privatePassageAccess(input);
    expect(access.validateRemoval(0, [])).toBe(true);
    expect(access.validateRemoval(0, [1])).toBe(true);
    expect(access.validateRemoval(0, [999])).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('refuses obstacles, another owner, and a gap to the house entrance', () => {
    const obstacle = fixture();
    obstacle.buildings.push({ kind: 'house', parcel: 0, poly: rect(4, 8.5, 5, 9.5) });
    expect(privatePassageAccess(obstacle).proposePrivatePassage(0, main, path, 0.8)).toBe(false);
    const otherOwner = fixture();
    otherOwner.parcels.push({ use: 'plot', block: 0, poly: rect(4, 8.5, 5, 9.5) });
    expect(privatePassageAccess(otherOwner).proposePrivatePassage(0, main, path, 0.8)).toBe(false);
    expect(privatePassageAccess(fixture()).proposePrivatePassage(0, main, [path[0], { x: 7.5, y: 9 }], 0.8)).toBe(false);
    expect(privatePassageAccess({ ...fixture(), placementClear: () => false })
      .proposePrivatePassage(0, main, path, 0.8)).toBe(false);
  });
});
