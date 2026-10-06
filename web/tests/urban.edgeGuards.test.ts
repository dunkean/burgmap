import { describe, expect, it } from 'vitest';
import type { Polygon, UrbanLayer } from '../src/gen/types';
import { blockReach, type StreetAt } from '../src/gen/urban/access';
import { footprintAccessGuard, quarterRoofCollar } from '../src/gen/urban/edgeFinish';
import { differenceSafeS, intersectionS, mpArea } from '../src/gen/geo/bool';
import { mergeUrban } from '../src/gen/settlements/merge';

const rect = (x: number, y: number, w: number, h: number): Polygon => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];
const street = ((p: { y: number }) => p.y < 0.1) as StreetAt;
const parcel = (poly: Polygon, block = 0) => ({ poly, use: 'plot' as const, block });

describe('open-edge footprint guards', () => {
  it('rejects a proposed part cut off behind a solid front wall', () => {
    const block = rect(0, 0, 12, 40);
    const front = rect(1.6, 0, 10.4, 6), wall = rect(0, 6, 12, 1), rear = rect(0, 8, 12, 6);
    const buildings = [front, wall, rear].map((poly, parcel) => ({ poly, parcel, kind: 'house' }));
    expect(blockReach(block, buildings.map((b) => b.poly), street)).toEqual([true, true, false]);
    const guard = footprintAccessGuard(buildings, buildings.map((b) => parcel(b.poly)), [block], street);
    expect(guard(2, [rear])).toBe(false);
  });

  it('accepts a new part while retaining access to an earlier reachable peer', () => {
    const block = rect(0, 0, 20, 30);
    const front = rect(1, 0, 6, 7), rear = rect(10, 14, 7, 7);
    const buildings = [front, rear].map((poly, parcel) => ({ poly, parcel, kind: 'house' }));
    expect(blockReach(block, buildings.map((b) => b.poly), street)).toEqual([true, true]);
    const grown = rect(1, 0, 7, 8);
    expect(blockReach(block, [grown, rear], street)).toEqual([true, true]);
    const before = JSON.stringify(buildings);
    expect(footprintAccessGuard(buildings, buildings.map((b) => parcel(b.poly)), [block], street)(0, [grown])).toBe(true);
    expect(JSON.stringify(buildings)).toBe(before);
  });

  it('rejects a replacement that seals the only passage to an accessible peer', () => {
    const block = rect(0, 0, 12, 40), front = rect(0, 0, 5, 7), rear = rect(2, 14, 8, 6);
    const buildings = [front, rear].map((poly, parcel) => ({ poly, parcel, kind: 'house' }));
    expect(blockReach(block, buildings.map((b) => b.poly), street)).toEqual([true, true]);
    const wall = rect(0, 0, 12, 7);
    expect(blockReach(block, [wall, rear], street)).toEqual([true, false]);
    expect(footprintAccessGuard(buildings, buildings.map((b) => parcel(b.poly)), [block], street)(0, [wall])).toBe(false);
  });

  it('keeps adjacent lazy roof claims apart with 16 m growth and 18 m neighbour exclusion', () => {
    const left = rect(0, 0, 100, 100), right = rect(100, 0, 100, 100);
    const before = JSON.stringify([left, right]);
    const leftClaim = differenceSafeS(differenceSafeS(quarterRoofCollar(left, 16), left), quarterRoofCollar(right, 18));
    const rightClaim = differenceSafeS(differenceSafeS(quarterRoofCollar(right, 16), right), quarterRoofCollar(left, 18));
    expect(mpArea(leftClaim)).toBeGreaterThan(0);
    expect(mpArea(rightClaim)).toBeGreaterThan(0);
    expect(mpArea(intersectionS(leftClaim, rightClaim))).toBeLessThan(0.01);
    expect(JSON.stringify([left, right])).toBe(before);
  });
});

function layer(quarter: number, streetX: number, withQuarter: boolean): UrbanLayer {
  const block = rect(streetX, 10, 10, 10), frame = { outer: rect(streetX, 0, 30, 30), holes: [] };
  return {
    footprint: [frame.outer], footprintH: [frame],
    streets: [{ path: [{ x: streetX, y: 5 }, { x: streetX + 30, y: 5 }], width: 4, kind: 'street', rank: 2, role: 'street', phase: 0 }],
    openTails: [{ street: 0, end: 'end', kind: 'unservedOpenEdge', point: { x: streetX + 30, y: 5 }, servedFromEnd: 8, excess: 4 }],
    openEdgeGround: [frame], blocks: [block], blockInfo: [{ quarter, phase: 0, zone: 'edge', kind: 'block' }],
    parcels: [parcel(block)], buildings: [{ poly: block, kind: 'house', parcel: 0 }],
    walls: [], landmarks: [], squares: [], phases: [], quarters: withQuarter ? [{ poly: frame, phase: 0, zone: 'edge', streetSpace: [] }] : [],
    masses: [], backLand: [], archetype: 'town', population: 1, morphology: 'test',
  };
}

describe('merged lazy and secondary quarter references', () => {
  it('preserves a lazy host quarter id then offsets secondary local ids and street tails', () => {
    const host = layer(0, 0, true);
    host.quarters.push({ poly: { outer: rect(30, 0, 30, 30), holes: [] }, phase: 0, zone: 'edge', streetSpace: [] });
    const detail = layer(17, 100, false);
    const secondary = layer(0, 200, true);
    const before = JSON.stringify([host, detail, secondary]);
    const merged = mergeUrban([host, detail, secondary])!;
    expect(merged.blockInfo.map((b) => b.quarter)).toEqual([0, 17, 2]);
    expect(merged.openTails?.map((t) => t.street)).toEqual([0, 1, 2]);
    expect(merged.parcels.map((p) => p.block)).toEqual([0, 1, 2]);
    expect(merged.buildings.map((b) => b.parcel)).toEqual([0, 1, 2]);
    expect(JSON.stringify([host, detail, secondary])).toBe(before);
  });
});
