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
    expect(input.passages).toEqual([]);
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
