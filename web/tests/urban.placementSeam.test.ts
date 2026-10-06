import { describe, expect, it, vi } from 'vitest';
import type { Polygon } from '../src/gen/types';
import * as booleanOps from '../src/gen/geo/bool';
import { footprintAccessGuard, footprintPlacementGuard } from '../src/gen/urban/edgeFinish';

const rect = (x: number, y: number, w: number, h: number): Polygon => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];

describe('physical reserve seam preservation', () => {
  const road = { outer: rect(9.99, 0, 2, 10), holes: [] };
  const safe = footprintPlacementGuard([road], () => false);

  it('retains only a pre-existing sub-2 cm seam without enlarging or moving its contact', () => {
    const original = rect(0, 0, 10, 10);
    expect(safe(original), 'one-argument calls remain strict').toBe(false);
    expect(safe(original, original)).toBe(true);
    expect(safe(rect(0, 0, 9.995, 10), original)).toBe(true);
    expect(safe(rect(0.005, 0, 10, 10), original), 'increased street contact').toBe(false);
  });

  it('rejects a new seam even when its total occupied area is small', () => {
    const original = rect(0, 0, 9.98, 10);
    expect(safe(original, original)).toBe(true);
    expect(safe(rect(0, 0, 10, 10), original)).toBe(false);
  });

  it('rejects an inherited physical collision wider than 2 cm', () => {
    const original = rect(0, 0, 10.05, 10);
    expect(safe(original, original)).toBe(false);
  });

  it('fails closed if the checked difference cannot prove no new contact', () => {
    const original = rect(0, 0, 10, 10);
    const spy = vi.spyOn(booleanOps, 'tryDifference').mockReturnValue({ pieces: [], failed: true });
    try { expect(safe(original, original)).toBe(false); } finally { spy.mockRestore(); }
  });
});

it('updates block peers appended after the access guard was created', () => {
  const block = rect(0, 0, 12, 40);
  const front = rect(0, 0, 5, 7), rear = rect(2, 14, 8, 6), wall = rect(0, 0, 12, 7);
  const buildings = [{ poly: front, kind: 'house', parcel: 0 }];
  const parcels = [{ poly: block, use: 'plot', block: 0 }];
  const guard = footprintAccessGuard(buildings, parcels, [block], (p) => p.y < 0.1);
  expect(guard(0, [wall])).toBe(true);
  buildings.push({ poly: rear, kind: 'rear', parcel: 1 });
  parcels.push({ poly: block, use: 'plot', block: 0 });
  expect(guard(0, [wall]), 'newly appended peer was reachable before the wall').toBe(false);
  buildings[1].poly = rect(2, 22, 8, 6);
  expect(guard(0, [wall]), 'guard reads current peer geometry').toBe(false);
});
