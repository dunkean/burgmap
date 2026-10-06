import { describe, expect, it, vi } from 'vitest';
import type { Polygon } from '../src/gen/core/geom';
import type { UrbanCtx } from '../src/gen/urban/context';
import type { EdgeRoofPartition } from '../src/gen/urban/edgeRoofs';
import { finishEdgeRoofs, insetEdgeRoof, roofEnvelope } from '../src/gen/urban/edgeRoofs';
import * as edgeRoofFunctions from '../src/gen/urban/edgeRoofs';
import { megaQuarterDetail } from '../src/gen/urban/mega/detail';
import { Streets, LAB_OPEN, LAB_WALL } from '../src/gen/urban/streets';
import { streetStrips } from '../src/gen/urban/openfringe';
import { area, bboxOf, distToRing } from '../src/gen/geo/poly';
import { tryDifference, tryIntersection, mpArea, intersectionS } from '../src/gen/geo/bool';
import * as booleanFunctions from '../src/gen/geo/bool';
import { blockReach, makeStreetAt } from '../src/gen/urban/access';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { checkWorld } from './urbanCheck';
import { unreachableBuildings } from './accessCheck';

const box = (x0: number, y0: number, x1: number, y1: number): Polygon => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
function fixture(wall = false): EdgeRoofPartition {
  const quarter = [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 190 }, { x: 100, y: 170 }];
  const offset = wall ? 2.8 : 0;
  const plot = [{ x: 120, y: 103 }, { x: 140, y: 103 }, { x: 140, y: 178 - offset }, { x: 120, y: 174 - offset }];
  const roof = [{ x: 120, y: 160 }, { x: 140, y: 160 }, { x: 140, y: 178 - offset }, { x: 120, y: 174 - offset }];
  const streets = new Streets();
  streets.connected.add(streets.add([{ x: 100, y: 100 }, { x: 200, y: 100 }], 6, 1, 'radial', 1));
  return {
    ctx: { mapSize: 1000, win: { x0: 0, y0: 0, x1: 1000, y1: 1000 }, water: [], isWater: () => false, slopeAt: () => 0.03 } as unknown as UrbanCtx,
    quarters: [{ lp: { pts: quarter, lab: [0, LAB_OPEN, wall ? LAB_WALL : LAB_OPEN, LAB_OPEN] }, phase: 1, zone: 'edge', age: 0.1, kind: 'quarter' }],
    blocks: [{ poly: plot, quarter: 0 }],
    parcels: [{ poly: plot, block: 0, use: 'plot', front: [{ x: 120, y: 103 }, { x: 140, y: 103 }], zone: 'edge' }],
    buildings: [{ poly: roof, parcel: 0, kind: 'house', roof: 'gable', arch: 'gabled-row-house' }],
    streetSpace: [tryDifference(quarter, plot).pieces], footprint: [{ outer: quarter, holes: [] }], gardens: [box(120, 120, 140, 160)], streets,
    protectedLand: streetStrips(streets.list[0].path, 6), phases: [{ id: 1, region: [{ outer: quarter, holes: [] }], band: [{ outer: quarter, holes: [] }] }], allowGrowth: true, eligible: () => true,
  };
}
const outside = (a: Polygon, b: Polygon) => { const d = tryDifference(a, b); expect(d.failed).toBe(false); return mpArea(d.pieces); };
const assertClearFenceAdditions = (before: Polygon[], after: Polygon[], fences: EdgeRoofPartition['protectedLand']) => {
  after.forEach((poly, i) => {
    const added = tryDifference(poly, before[i]);
    expect(added.failed).toBe(false);
    const A = bboxOf(poly);
    for (const fence of fences) {
      const B = bboxOf(fence.outer);
      if (A.x0 > B.x1 || B.x0 > A.x1 || A.y0 > B.y1 || B.y0 > A.y1) continue;
      const hit = tryIntersection(added.pieces, [fence]);
      expect(hit.failed, 'local physical-fence clearance must be provable').toBe(false);
      expect(mpArea(hit.pieces), 'finishing adds no roof land across an actual yard fence').toBeLessThanOrEqual(1e-6);
    }
  });
};
const assertRectangle = (p: Polygon) => {
  expect(p).toHaveLength(4);
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4];
    expect(Math.abs((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y))).toBeLessThan(1e-5);
  }
};
const assertUsefulRectangle = (p: Polygon) => {
  assertRectangle(p);
  const sides = p.map((a, i) => Math.hypot(a.x - p[(i + 1) % 4].x, a.y - p[(i + 1) % 4].y));
  expect(Math.min(...sides)).toBeGreaterThanOrEqual(4.5 - 1e-9);
  expect(Math.max(...sides) / Math.min(...sides)).toBeLessThanOrEqual(3);
};

/** A small clipped corner whose 65% area is below the minimum legal square. */
function smallCornerFixture(angle: number, coordinate: number): EdgeRoofPartition {
  const f = fixture();
  const at = ([x, y]: [number, number]) => ({ x: coordinate + x * Math.cos(angle) - y * Math.sin(angle),
    y: coordinate + x * Math.sin(angle) + y * Math.cos(angle) });
  const plot = ([[0, 0], [7.4, 0], [3.4, 7.4], [0, 7.4]] as [number, number][]).map(at);
  const roof = ([[0, 0], [7.4, 0], [3.4, 7.4], [0, 2.2]] as [number, number][]).map(at);
  const front: [Polygon[number], Polygon[number]] = [at([0, 0]), at([7.4, 0])];
  f.ctx.mapSize = 20000; f.ctx.win = { x0: 0, y0: 0, x1: 20000, y1: 20000 };
  f.quarters[0].lp = { pts: plot, lab: [0, LAB_OPEN, LAB_OPEN, LAB_OPEN] };
  f.blocks[0].poly = plot; f.parcels[0].poly = plot; f.parcels[0].front = front;
  f.buildings[0].poly = roof; f.footprint = [{ outer: plot, holes: [] }];
  f.streetSpace = [[]]; f.phases = []; f.gardens = []; f.allowGrowth = false;
  f.streets = new Streets();
  f.streets.connected.add(f.streets.add([at([-4, -3]), at([14, -3])], 6, 1, 'radial', 1));
  f.protectedLand = streetStrips(f.streets.list[0].path, 6);
  return f;
}
const fixedOwners = (f: EdgeRoofPartition) => JSON.stringify([f.quarters, f.blocks, f.parcels,
  f.streetSpace, f.footprint, f.phases, f.streets.list]);

/** A useful rear square needs a little of the adjacent garden; neither frontage nor the wall can move. */
function transferFixture(angle = 0): EdgeRoofPartition {
  const f = fixture(true), at = ([x, y]: [number, number]) => ({
    x: 100 + x * Math.cos(angle) - y * Math.sin(angle), y: 100 + x * Math.sin(angle) + y * Math.cos(angle),
  });
  const ring = (points: [number, number][]) => points.map(at);
  const owner = ring([[20, 0], [25, 0], [25, 30], [20, 34]]);
  const donor = ring([[0, 0], [20, 0], [20, 34], [0, 34]]);
  const block = ring([[0, 0], [25, 0], [25, 30], [20, 34], [0, 34]]);
  const old = ring([[20.5, 30], [24.5, 30], [20.5, 33.5]]);
  f.quarters[0].lp = { pts: block, lab: [0, LAB_WALL, LAB_WALL, LAB_WALL, LAB_WALL] };
  f.blocks[0].poly = block; f.footprint = [{ outer: block, holes: [] }];
  f.parcels = [
    { poly: owner, block: 0, use: 'plot', front: [at([20, 0]), at([25, 0])], zone: 'edge' },
    { poly: donor, block: 0, use: 'plot', front: [at([0, 0]), at([20, 0])], zone: 'edge' },
  ];
  f.buildings = [
    { poly: old, parcel: 0, kind: 'house', roof: 'gable', arch: 'gabled-row-house' },
    { poly: ring([[5, 1], [10, 1], [10, 8], [5, 8]]), parcel: 1, kind: 'house', roof: 'hip', arch: 'gabled-row-house' },
  ];
  f.streetSpace = [[]]; f.phases = [{ id: 1, region: f.footprint, band: f.footprint }];
  f.gardens = [ring([[0, 10], [20, 10], [20, 34], [0, 34]])]; f.allowGrowth = false;
  f.streets = new Streets();
  f.streets.connected.add(f.streets.add([at([0, -3]), at([25, -3])], 6, 1, 'radial', 1));
  // A real, one-sided masonry strip outside the sloping rear curtain.
  const nx = 4 / Math.sqrt(41), ny = 5 / Math.sqrt(41);
  f.protectedLand = [...streetStrips(f.streets.list[0].path, 6), {
    outer: ring([[25, 30], [20, 34], [20 + nx, 34 + ny], [25 + nx, 30 + ny]]), holes: [],
  }];
  return f;
}
const fixedFrames = (f: EdgeRoofPartition) => JSON.stringify([f.quarters, f.blocks, f.streetSpace, f.footprint, f.phases, f.streets.list]);
const parcelMetadata = (f: EdgeRoofPartition) => JSON.stringify(f.parcels.map(({ poly: _poly, ...metadata }) => metadata));
const buildingMetadata = (f: EdgeRoofPartition) => JSON.stringify(f.buildings.map(({ poly: _poly, ...metadata }) => metadata));

function assertTransfer(before: EdgeRoofPartition['parcels'], after: EdgeRoofPartition['parcels'], owner: number, donor: number): void {
  // Feed the original rings directly to checked differences. Pre-cleaning their union would hide a lost T vertex.
  const oldLand = [owner, donor].map((index) => ({ outer: before[index].poly, holes: [] }));
  const newLand = [owner, donor].map((index) => ({ outer: after[index].poly, holes: [] }));
  const lost = tryDifference(oldLand, newLand), extra = tryDifference(newLand, oldLand), overlap = tryIntersection(after[owner].poly, after[donor].poly);
  expect(lost.failed || extra.failed || overlap.failed).toBe(false);
  expect(mpArea(lost.pieces) + mpArea(extra.pieces) + mpArea(overlap.pieces)).toBeLessThanOrEqual(1e-6);
  expect(mpArea(newLand)).toBeCloseTo(mpArea(oldLand), 6);
  expect(outside(before[owner].poly, after[owner].poly)).toBeLessThanOrEqual(1e-6);
  expect(outside(after[donor].poly, before[donor].poly)).toBeLessThanOrEqual(1e-6);
  for (const index of [owner, donor]) for (const p of before[index].front!) expect(distToRing(after[index].poly, p)).toBeLessThanOrEqual(0.01);
}

describe('settlement edge roofs', () => {
  it.each([0, 0.37])('transfers only unused adjacent garden while keeping both served owners and the physical wall: %s', (angle) => {
    const f = transferFixture(angle), before = structuredClone(f.parcels), old = structuredClone(f.buildings[0].poly);
    const neighbour = structuredClone(f.buildings[1].poly), frames = fixedFrames(f), parcels = parcelMetadata(f), buildings = buildingMetadata(f);
    const streetAt = makeStreetAt([{ path: f.streets.list[0].path, width: 6 }], []);
    const reached = blockReach(f.blocks[0].poly, f.buildings.map((b) => b.poly), streetAt);
    expect(reached).toEqual([true, true]);
    const result = finishEdgeRoofs(f), roof = f.buildings[0].poly;
    expect(result.grown).toBe(0); expect(result.fitted).toBe(1); expect(result.constrained).toBe(0);
    expect(f.parcels).toHaveLength(2); expect(f.buildings).toHaveLength(2);
    expect(fixedFrames(f)).toBe(frames); expect(parcelMetadata(f)).toBe(parcels); expect(buildingMetadata(f)).toBe(buildings);
    expect(f.buildings[1].poly).toEqual(neighbour); expect(result.changedBlocks).toEqual(new Set([0]));
    assertUsefulRectangle(roof); expect(area(roof)).toBeGreaterThanOrEqual(area(old));
    expect(outside(roof, before[0].poly)).toBeGreaterThan(1);
    expect(outside(roof, f.parcels[0].poly)).toBeLessThanOrEqual(1e-6);
    expect(outside(neighbour, f.parcels[1].poly)).toBeLessThanOrEqual(1e-6);
    const retained = tryIntersection(old, roof), physical = tryIntersection(roof, f.protectedLand);
    expect(retained.failed || physical.failed).toBe(false);
    expect(mpArea(retained.pieces)).toBeGreaterThanOrEqual(0.5 * area(old)); expect(mpArea(physical.pieces)).toBeLessThanOrEqual(1e-6);
    assertTransfer(before, f.parcels, 0, 1);
    expect(blockReach(f.blocks[0].poly, f.buildings.map((b) => b.poly), streetAt)).toEqual(reached);
    for (const garden of f.gardens) {
      const hit = tryIntersection(garden, f.buildings.map((b) => ({ outer: b.poly, holes: [] })));
      expect(hit.failed).toBe(false); expect(mpArea(hit.pieces)).toBeLessThanOrEqual(1e-6);
    }
    expect(mpArea(tryDifference(tryDifference(old, roof).pieces, f.gardens.map((outer) => ({ outer, holes: [] }))).pieces)).toBeLessThanOrEqual(1e-6);
  });

  it.each(['protected', 'ineligible', 'courtyard', 'failed-proof'] as const)('rejects an unsafe adjacent garden transaction without mutating any owner: %s', (reason) => {
    const f = transferFixture();
    if (reason === 'protected') f.protectedLand.push({ outer: f.parcels[1].poly, holes: [] });
    if (reason === 'ineligible') f.eligible = (index) => index === 0;
    if (reason === 'courtyard') f.buildings[1].courtyards = [box(106, 102, 109, 107)];
    const before = JSON.stringify([f.buildings, f.parcels, f.gardens]), frames = fixedFrames(f);
    const spy = reason === 'failed-proof' ? vi.spyOn(booleanFunctions, 'tryDifference').mockReturnValue({ failed: true, pieces: [] }) : undefined;
    try {
      const result = finishEdgeRoofs(f);
      expect(result.grown + result.fitted).toBe(0); expect(result.constrained).toBe(1);
      expect(JSON.stringify([f.buildings, f.parcels, f.gardens])).toBe(before); expect(fixedFrames(f)).toBe(frames);
      expect(result.changedBlocks.size).toBe(0);
    } finally { spy?.mockRestore(); }
  });

  it('keeps every seeded standing-wall roof transaction contained, physically clear, and accessible', () => {
    const originalFinish = edgeRoofFunctions.finishEdgeRoofs;
    let witnessed = 0;
    const spy = vi.spyOn(edgeRoofFunctions, 'finishEdgeRoofs').mockImplementation((input) => {
      const before = structuredClone(input.buildings.map((b) => b.poly));
      const frames = fixedFrames(input), parcelInfo = parcelMetadata(input), buildingInfo = buildingMetadata(input);
      const streetAt = makeStreetAt(input.streets.list.filter((s) => s.ribbon).map((s) => ({ path: s.path, widths: s.widths, width: s.widths[0] })), []);
      const reached = input.blocks.map((block, bi) => blockReach(block.poly, input.buildings
        .filter((b) => b.parcel !== undefined && input.parcels[b.parcel].block === bi).map((b) => b.poly), streetAt));
      const result = originalFinish(input);
      expect(input.buildings).toHaveLength(before.length);
      expect(parcelMetadata(input)).toBe(parcelInfo);
      expect(buildingMetadata(input)).toBe(buildingInfo);
      // The finisher may extend an open quarter; immutable frame comparison applies only to
      // blocks whose roofs stayed inside their original owner.
      for (let i = 0; i < before.length; i++) {
        const after = input.buildings[i].poly;
        if (JSON.stringify(before[i]) === JSON.stringify(after)) continue;
        witnessed++;
        const parcel = input.buildings[i].parcel;
        expect(parcel).toBeDefined();
        expect(outside(after, input.parcels[parcel!].poly)).toBeLessThanOrEqual(1e-6);
        const added = tryDifference(after, before[i]), hit = tryIntersection(added.pieces, input.protectedLand);
        expect(added.failed || hit.failed).toBe(false);
        expect(mpArea(hit.pieces)).toBeLessThanOrEqual(1e-6);
        const retained = tryIntersection(after, before[i]);
        expect(retained.failed).toBe(false);
        expect(mpArea(retained.pieces)).toBeGreaterThanOrEqual(0.5 * area(before[i]));
      }
      expect(fixedFrames(input) === frames || result.grown > 0).toBe(true);
      input.blocks.forEach((block, bi) => {
        const peers = input.buildings.filter((b) => b.parcel !== undefined && input.parcels[b.parcel].block === bi);
        const now = blockReach(block.poly, peers.map((b) => b.poly), streetAt);
        expect(now.every((v, j) => v || !reached[bi][j])).toBe(true);
      });
      return result;
    });
    try {
      const w = generate(makeOptions({ seed: '42', size: 'town', culture: 'european-organic', walls: 'single', settlements: 'none' }));
      expect(witnessed).toBeGreaterThan(0);
      const report = checkWorld(w);
      expect(report.overlapsBlocks + report.overlapsPlots + report.overlapsBuildings + report.bldgOutside + report.noFrontage + report.orphanMain).toBe(0);
      expect(report.blockAreaErr).toBeLessThanOrEqual(0.005); expect(unreachableBuildings(w).n).toBe(0);
    } finally { spy.mockRestore(); }
  });

  it.each([{ angle: 0, coordinate: 100 }, { angle: 0.37, coordinate: 1000 }, { angle: 1.1, coordinate: 12000 }])
    ('fits a useful intermediate-size corner after rotation/translation: %j', ({ angle, coordinate }) => {
      const f = smallCornerFixture(angle, coordinate), before = structuredClone(f.buildings[0].poly), owners = fixedOwners(f);
      const oldArea = area(before), streetAt = makeStreetAt([{ path: f.streets.list[0].path, width: 6 }], []);
      const beforeAccess = blockReach(f.blocks[0].poly, f.buildings.map((b) => b.poly), streetAt);
      expect(0.65 * oldArea).toBeLessThan(4.5 * 4.5);
      expect(beforeAccess).toEqual([true]);
      const result = finishEdgeRoofs(f), roof = f.buildings[0].poly;
      expect(result.grown).toBe(0); expect(result.fitted).toBe(1); expect(result.constrained).toBe(0);
      expect(f.buildings).toHaveLength(1); expect(fixedOwners(f)).toBe(owners);
      assertRectangle(roof);
      expect(area(roof)).toBeGreaterThanOrEqual(0.65 * oldArea);
      expect(area(roof)).toBeLessThanOrEqual(1.3 * oldArea);
      const sides = roof.map((p, i) => Math.hypot(p.x - roof[(i + 1) % 4].x, p.y - roof[(i + 1) % 4].y));
      expect(Math.min(...sides)).toBeGreaterThanOrEqual(4.5 - 1e-9);
      expect(Math.max(...sides) / Math.min(...sides)).toBeLessThanOrEqual(3);
      expect(outside(roof, f.parcels[0].poly)).toBeLessThanOrEqual(1e-6);
      const retained = tryIntersection(roof, before), added = tryDifference(roof, before);
      expect(retained.failed || added.failed).toBe(false);
      expect(mpArea(retained.pieces)).toBeGreaterThanOrEqual(0.5 * oldArea);
      const protectedHit = tryIntersection(added.pieces, f.protectedLand);
      expect(protectedHit.failed).toBe(false); expect(mpArea(protectedHit.pieces)).toBeLessThanOrEqual(1e-6);
      expect(blockReach(f.blocks[0].poly, f.buildings.map((b) => b.poly), streetAt)).toEqual(beforeAccess);
    });

  it('refuses to fit a whole roof through a genuinely narrower physical parcel', () => {
    const f = smallCornerFixture(0, 1000), plot = box(1000, 1000, 1003, 1010);
    const old = [{ x: 1000, y: 1000 }, { x: 1003, y: 1000 }, { x: 1003, y: 1010 }, { x: 1000, y: 1008 }];
    f.quarters[0].lp = { pts: plot, lab: plot.map(() => LAB_WALL) };
    f.blocks[0].poly = plot; f.parcels[0].poly = plot; f.parcels[0].front = [plot[0], plot[1]];
    f.buildings[0].poly = old; f.footprint = [{ outer: plot, holes: [] }];
    const before = JSON.stringify([f.buildings, f.gardens]), owners = fixedOwners(f);
    const result = finishEdgeRoofs(f);
    expect(result.grown + result.fitted).toBe(0); expect(result.constrained).toBe(1);
    expect(JSON.stringify([f.buildings, f.gardens])).toBe(before);
    expect(fixedOwners(f)).toBe(owners);
  });

  it.each([false, true])('keeps a whole useful roof in a triangular corner with a standing wall=%s', (wall) => {
    const f = smallCornerFixture(0, 1000), plot = [{ x: 1000, y: 1000 }, { x: 1016, y: 1000 }, { x: 1000, y: 1012 }];
    const old = [{ x: 1000, y: 1000 }, { x: 1016, y: 1000 }, { x: 1002, y: 1010.5 }, { x: 1000, y: 1010.5 }];
    f.quarters[0].lp = { pts: plot, lab: [0, wall ? LAB_WALL : LAB_OPEN, wall ? LAB_WALL : LAB_OPEN] };
    f.blocks[0].poly = plot; f.parcels[0].poly = plot; f.parcels[0].front = [plot[0], plot[1]];
    f.buildings[0].poly = old; f.footprint = [{ outer: plot, holes: [] }];
    f.streets = new Streets();
    f.streets.connected.add(f.streets.add([{ x: 996, y: 997 }, { x: 1020, y: 997 }], 6, 1, 'radial', 1));
    f.protectedLand = streetStrips(f.streets.list[0].path, 6);
    if (wall) f.protectedLand.push(...streetStrips([{ x: 1017.8, y: 1002.4 }, { x: 1001.8, y: 1014.4 }], 5.6));
    const owners = fixedOwners(f), oldArea = area(old);
    // Every rectangle in a triangle occupies at most half its area: 65% of this house cannot fit.
    expect(0.5 * area(plot)).toBeLessThan(0.65 * oldArea);
    const result = finishEdgeRoofs(f), roof = f.buildings[0].poly;
    expect(result.grown).toBe(0); expect(result.fitted).toBe(1); expect(result.constrained).toBe(0);
    expect(f.buildings).toHaveLength(1); expect(fixedOwners(f)).toBe(owners);
    assertUsefulRectangle(roof); expect(area(roof)).toBeGreaterThanOrEqual(0.5 * oldArea);
    expect(area(roof)).toBeLessThan(0.65 * oldArea);
    expect(outside(roof, plot)).toBeLessThanOrEqual(1e-6);
    const retained = tryIntersection(roof, old), added = tryDifference(roof, old);
    expect(retained.failed || added.failed).toBe(false);
    expect(mpArea(retained.pieces)).toBeGreaterThanOrEqual(0.5 * oldArea);
    const blocked = tryIntersection(added.pieces, f.protectedLand);
    expect(blocked.failed).toBe(false); expect(mpArea(blocked.pieces)).toBeLessThanOrEqual(1e-6);
    const streetAt = makeStreetAt([{ path: f.streets.list[0].path, width: 6 }], []);
    expect(blockReach(f.blocks[0].poly, f.buildings.map((b) => b.poly), streetAt)).toEqual([true]);
  });

  it('restores the minimum whole roof for a previously clipped undersized dwelling in its unchanged lot', () => {
    const f = smallCornerFixture(0, 1000), plot = box(1000, 1000, 1008, 1008);
    const old = [{ x: 1000, y: 1000 }, { x: 1005, y: 1000 }, { x: 1000, y: 1005 }];
    f.quarters[0].lp = { pts: plot, lab: [0, LAB_OPEN, LAB_OPEN, LAB_OPEN] };
    f.blocks[0].poly = plot; f.parcels[0].poly = plot; f.parcels[0].front = [plot[0], plot[1]];
    f.buildings[0].poly = old; f.footprint = [{ outer: plot, holes: [] }];
    const owners = fixedOwners(f), oldArea = area(old);
    expect(1.3 * oldArea).toBeLessThan(4.5 * 4.5);
    const result = finishEdgeRoofs(f), roof = f.buildings[0].poly;
    expect(result.grown).toBe(0); expect(result.fitted).toBe(1); expect(result.constrained).toBe(0);
    assertUsefulRectangle(roof); expect(area(roof)).toBe(4.5 * 4.5);
    const retained = tryIntersection(roof, old);
    expect(retained.failed).toBe(false); expect(mpArea(retained.pieces)).toBeGreaterThanOrEqual(0.5 * oldArea);
    const added = tryDifference(roof, old), blocked = tryIntersection(added.pieces, f.protectedLand);
    expect(added.failed || blocked.failed).toBe(false); expect(mpArea(blocked.pieces)).toBeLessThanOrEqual(1e-6);
    expect(outside(roof, plot)).toBeLessThanOrEqual(1e-6);
    expect(f.buildings).toHaveLength(1); expect(fixedOwners(f)).toBe(owners);
    const streetAt = makeStreetAt([{ path: f.streets.list[0].path, width: 6 }], []);
    expect(blockReach(f.blocks[0].poly, f.buildings.map((b) => b.poly), streetAt)).toEqual([true]);
  });

  it('cannot manufacture a minimum-width whole roof inside a genuinely smaller triangular parcel', () => {
    const f = smallCornerFixture(0, 1000), plot = [{ x: 1000, y: 1000 }, { x: 1008, y: 1000 }, { x: 1000, y: 1009 }];
    const old = [{ x: 1000, y: 1000 }, { x: 1008, y: 1000 }, { x: 1000.8, y: 1008.1 }, { x: 1000, y: 1008.1 }];
    f.quarters[0].lp = { pts: plot, lab: [0, LAB_WALL, LAB_WALL] };
    f.blocks[0].poly = plot; f.parcels[0].poly = plot; f.parcels[0].front = [plot[0], plot[1]];
    f.buildings[0].poly = old; f.footprint = [{ outer: plot, holes: [] }];
    expect(area(plot) / 2).toBeLessThan(4.5 * 4.5);
    const before = JSON.stringify([f.buildings, f.gardens]), owners = fixedOwners(f);
    const result = finishEdgeRoofs(f);
    expect(result.grown + result.fitted).toBe(0); expect(result.constrained).toBe(1);
    expect(JSON.stringify([f.buildings, f.gardens])).toBe(before); expect(fixedOwners(f)).toBe(owners);
  });

  it('grows the true roof-axis rectangle when the frontage envelope meets a real protected strip', () => {
    const f = fixture(), at = (u: number, d: number) => ({ x: 150 + u * Math.cos(0.4) - d * Math.sin(0.4),
      y: 170 + u * Math.sin(0.4) + d * Math.cos(0.4) });
    const old = [at(-7, -4), at(7, -4), at(7, 4), at(-3, 4), at(-7, 1)];
    const plot = [{ x: 140, y: 103 }, { x: 160, y: 103 }, { x: 160, y: 180 }, at(-3, 4), at(-7, 1), { x: 140, y: 155 }];
    f.quarters[0].lp = { pts: plot, lab: [0, LAB_OPEN, LAB_OPEN, LAB_OPEN, LAB_OPEN, LAB_OPEN] };
    f.blocks[0].poly = plot; f.parcels[0].poly = plot; f.parcels[0].front = [plot[0], plot[1]];
    f.buildings[0].poly = old; f.footprint = [{ outer: plot, holes: [] }]; f.streetSpace = [[]]; f.gardens = [];
    f.phases = [{ id: 1, region: [{ outer: plot, holes: [] }], band: [{ outer: plot, holes: [] }] }];
    const barrier = box(156, 174.5, 158.2, 176.6);
    f.protectedLand.push({ outer: barrier, holes: [] });
    const frontHit = tryIntersection(roofEnvelope(old, f.parcels[0].front!), barrier);
    expect(frontHit.failed).toBe(false); expect(mpArea(frontHit.pieces)).toBeGreaterThan(1);
    expect(mpArea(intersectionS(old, barrier))).toBe(0);
    const result = finishEdgeRoofs(f), roof = f.buildings[0].poly;
    expect(result.grown).toBe(1); expect(result.fitted).toBe(0); expect(result.constrained).toBe(0);
    expect(f.buildings).toHaveLength(1); assertUsefulRectangle(roof);
    expect(area(roof)).toBeGreaterThan(area(old)); expect(area(roof)).toBeLessThanOrEqual(2 * area(old));
    expect(outside(old, roof)).toBeLessThanOrEqual(1e-6);
    expect(outside(roof, f.parcels[0].poly)).toBeLessThanOrEqual(1e-6);
    expect(outside(f.parcels[0].poly, f.blocks[0].poly)).toBeLessThanOrEqual(1e-6);
    expect(outside(f.blocks[0].poly, f.quarters[0].lp.pts)).toBeLessThanOrEqual(1e-6);
    expect(mpArea(tryDifference(roof, f.footprint).pieces)).toBeLessThanOrEqual(1e-6);
    expect(mpArea(tryDifference(roof, f.phases![0].band).pieces)).toBeLessThanOrEqual(1e-6);
    const protectedHit = tryIntersection(roof, f.protectedLand);
    expect(protectedHit.failed).toBe(false); expect(mpArea(protectedHit.pieces)).toBeLessThanOrEqual(1e-6);
    const streetAt = makeStreetAt([{ path: f.streets.list[0].path, width: 6 }], []);
    expect(blockReach(f.blocks[0].poly, f.buildings.map((b) => b.poly), streetAt)).toEqual([true]);
  });

  it('preserves the current seeded hamlet programme and all owner geometry', () => {
    const originalFinish = edgeRoofFunctions.finishEdgeRoofs;
    let snapshot: { before: Polygon[]; owners: string; afterOwners: string; constrained: number } | undefined;
    const owners = (input: EdgeRoofPartition) => JSON.stringify([input.quarters, input.blocks, input.parcels,
      input.streetSpace, input.footprint, input.phases]);
    const spy = vi.spyOn(edgeRoofFunctions, 'finishEdgeRoofs').mockImplementation((input) => {
      const before = structuredClone(input.buildings.map((b) => b.poly)), initialOwners = owners(input);
      const result = originalFinish(input);
      snapshot = { before, owners: initialOwners, afterOwners: owners(input), constrained: result.constrained };
      return result;
    });
    try {
      const w = generate(makeOptions({ seed: '42', size: 'hamlet', walls: 'none', culture: 'european-organic', settlements: 'none' }));
      const u = w.urban!;
      expect(snapshot).toBeDefined();
      // The old 12-roof fixture was generated before the upstream quarter partition changed.
      // Both old and current finishers now receive 14 already-sound roofs for these options.
      expect(u.buildings).toHaveLength(14);
      expect(snapshot!.before).toHaveLength(u.buildings.length);
      expect(snapshot!.afterOwners).toBe(snapshot!.owners);
      expect(snapshot!.constrained).toBe(0);
      u.buildings.forEach((b, i) => {
        expect(b.poly).toEqual(snapshot!.before[i]);
        expect(outside(b.poly, u.parcels[b.parcel!].poly)).toBeLessThanOrEqual(1e-6);
      });
      const report = checkWorld(w);
      expect(report.overlapsBlocks + report.overlapsPlots + report.overlapsBuildings).toBe(0);
      expect(report.blockOutside + report.bldgOutside + report.noFrontage + report.orphanMain).toBe(0);
      expect(report.blockAreaErr).toBeLessThanOrEqual(0.005);
      expect(unreachableBuildings(w).n).toBe(0);
    } finally { spy.mockRestore(); }
  });

  it('claims the full roof and its owner at every level beyond an open planning edge', () => {
    const f = fixture(), oldQuarter = f.quarters[0].lp.pts, oldRoof = f.buildings[0].poly;
    const result = finishEdgeRoofs(f);
    expect(result.grown).toBe(1);
    expect(f.buildings).toHaveLength(1);
    assertRectangle(f.buildings[0].poly);
    expect(outside(oldRoof, f.buildings[0].poly)).toBeLessThan(1e-6);
    expect(outside(f.buildings[0].poly, oldQuarter)).toBeGreaterThan(1);
    expect(outside(f.buildings[0].poly, f.parcels[0].poly)).toBeLessThan(1e-6);
    expect(outside(f.parcels[0].poly, f.blocks[0].poly)).toBeLessThan(1e-6);
    expect(outside(f.blocks[0].poly, f.quarters[0].lp.pts)).toBeLessThan(1e-6);
    expect(mpArea(tryDifference(f.quarters[0].lp.pts, f.phases![0].region).pieces)).toBeLessThan(1e-6);
    expect(area(f.blocks[0].poly) + mpArea(f.streetSpace[0])).toBeCloseTo(area(f.quarters[0].lp.pts), 5);
    expect(area(f.parcels[0].poly)).toBeCloseTo(area(f.blocks[0].poly), 5);
  });

  it('keeps a whole useful rectangle inside a real wall without deleting the house', () => {
    const f = fixture(true), oldPlot = f.parcels[0].poly, oldArea = area(f.buildings[0].poly), original = JSON.stringify(f.quarters);
    const result = finishEdgeRoofs(f);
    expect(result.grown).toBe(0);
    expect(result.fitted).toBe(1);
    expect(f.buildings).toHaveLength(1);
    assertRectangle(f.buildings[0].poly);
    expect(area(f.buildings[0].poly)).toBeGreaterThanOrEqual(0.65 * oldArea);
    expect(outside(f.buildings[0].poly, oldPlot)).toBeLessThan(1e-6);
    expect(JSON.stringify(f.quarters)).toBe(original);
    const streetAt = makeStreetAt([{ path: f.streets.list[0].path, width: 6 }], []);
    expect(blockReach(f.blocks[0].poly, f.buildings.map((b) => b.poly), streetAt)).toEqual([true]);
  });

  it('rejects exterior water and occupied land, retaining a safe contained roof', () => {
    for (const obstacle of ['water', 'parcel']) {
      const f = fixture(), oldPlot = f.parcels[0].poly;
      const occupied = [{ x: 120, y: 174 }, { x: 140, y: 178 }, { x: 140, y: 183 }, { x: 120, y: 179 }];
      if (obstacle === 'water') { f.ctx.water = [{ outer: occupied, holes: [] }]; f.protectedLand.push(...f.ctx.water); }
      else f.parcels.push({ poly: occupied, block: 0, use: 'garden', zone: 'edge' });
      const result = finishEdgeRoofs(f);
      expect(result.grown).toBe(0);
      expect(result.fitted).toBe(1);
      assertRectangle(f.buildings[0].poly);
      expect(outside(f.buildings[0].poly, oldPlot)).toBeLessThan(1e-6);
      expect(mpArea(intersectionS(f.buildings[0].poly, occupied))).toBeLessThanOrEqual(0.001);
    }
  });

  it('keeps frozen macro frames and special architecture untouched', () => {
    const macro = fixture(); macro.allowGrowth = false;
    const frameBefore = JSON.stringify(macro.quarters);
    expect(finishEdgeRoofs(macro).grown).toBe(0);
    assertRectangle(macro.buildings[0].poly);
    expect(JSON.stringify(macro.quarters)).toBe(frameBefore);
    const special = fixture(); special.eligible = () => false;
    const before = JSON.stringify(special);
    expect(finishEdgeRoofs(special).fitted).toBe(0);
    expect(JSON.stringify(special)).toBe(before);
  });

  it('does not relocate a same-lot rectangle into a real reserved fence or path', () => {
    const f = fixture(); f.allowGrowth = false;
    const barrier = box(119.75, 155, 140.25, 159.8), oldRoof = f.buildings[0].poly;
    expect(mpArea(intersectionS(oldRoof, barrier))).toBe(0);
    f.protectedLand.push({ outer: barrier, holes: [] });
    const frameBefore = JSON.stringify(f.quarters), parcelBefore = JSON.stringify(f.parcels);
    const result = finishEdgeRoofs(f);
    expect(result.grown).toBe(0);
    expect(result.fitted).toBe(1);
    expect(f.buildings).toHaveLength(1);
    assertRectangle(f.buildings[0].poly);
    expect(mpArea(intersectionS(f.buildings[0].poly, barrier))).toBeLessThanOrEqual(1e-6);
    expect(area(f.buildings[0].poly)).toBeGreaterThanOrEqual(0.65 * area(oldRoof));
    expect(JSON.stringify(f.quarters)).toBe(frameBefore);
    expect(JSON.stringify(f.parcels)).toBe(parcelBefore);
  });

  it('provides actual lazy yard fences before finishing and adds no roof land across them', () => {
    const w = generate(makeOptions({ seed: '42', size: 'city', population: 60000, culture: 'russian-kremlin', walls: 'none', settlements: 'none' }));
    const originalFinish = edgeRoofFunctions.finishEdgeRoofs;
    const snapshots: { before: Polygon[]; after: Polygon[]; protectedLand: EdgeRoofPartition['protectedLand'] }[] = [];
    const spy = vi.spyOn(edgeRoofFunctions, 'finishEdgeRoofs').mockImplementation((input) => {
      const before = input.buildings.map((b) => b.poly.map((p) => ({ ...p })));
      const result = originalFinish(input);
      snapshots.push({ before, after: input.buildings.map((b) => b.poly), protectedLand: input.protectedLand });
      return result;
    });
    try {
      const candidates = w.urban!.macro!.quarters.filter((q) => q.kind === 'quarter' && q.lab.some((lab) => lab === LAB_OPEN || lab === LAB_WALL)).slice(0, 8);
      let checked = false;
      for (const q of candidates) {
        const detail = megaQuarterDetail(w, q.id)!;
        const fences = (detail.lines ?? []).filter((l) => l.kind === 'yard-fence').flatMap((l) => streetStrips(l.path, l.width ?? 0.45));
        if (!fences.length) continue;
        const snapshot = snapshots.at(-1)!;
        expect(snapshot).toBeDefined();
        for (const fence of fences) {
          const unprotected = tryDifference([fence], snapshot.protectedLand);
          expect(unprotected.failed).toBe(false);
          expect(mpArea(unprotected.pieces), 'the real emitted fence is protected before finishing').toBeLessThanOrEqual(1e-6);
        }
        assertClearFenceAdditions(snapshot.before, snapshot.after, fences);
        checked = true; break;
      }
      expect(checked, 'a real lazy Russian yard-house quarter was checked').toBe(true);
    } finally { spy.mockRestore(); }
  });

  it('protects actual eager yard fences when finishing a Russian town', () => {
    const originalFinish = edgeRoofFunctions.finishEdgeRoofs;
    let snapshot: { before: Polygon[]; after: Polygon[]; protectedLand: EdgeRoofPartition['protectedLand'] } | undefined;
    const spy = vi.spyOn(edgeRoofFunctions, 'finishEdgeRoofs').mockImplementation((input) => {
      const before = structuredClone(input.buildings.map((b) => b.poly));
      const result = originalFinish(input);
      snapshot = { before, after: input.buildings.map((b) => b.poly), protectedLand: input.protectedLand };
      return result;
    });
    try {
      const w = generate(makeOptions({ seed: '42', size: 'town', population: 6000, culture: 'russian-kremlin', walls: 'single', settlements: 'none' }));
      const fences = (w.urban!.lines ?? []).filter((l) => l.kind === 'yard-fence').flatMap((l) => streetStrips(l.path, l.width ?? 0.45));
      expect(fences.length).toBeGreaterThan(0);
      expect(snapshot).toBeDefined();
      for (const fence of fences) {
        // Eager reservations contain thousands of overlapping strips; identity proves inclusion directly,
        // without asking a global Boolean subtraction to reconstruct every unrelated road/wall junction.
        expect(snapshot!.protectedLand).toContainEqual(fence);
      }
      assertClearFenceAdditions(snapshot!.before, snapshot!.after, fences);
    } finally { spy.mockRestore(); }
  });


  it('fits an intact useful roof in the actual slanted wall-side rear-house lot from seed 42', () => {
    const f = fixture(true);
    const oldRoof = [{"x": 774.8191198327389, "y": 1289.0012272824806}, {"x": 783.8462391374868, "y": 1284.0368527411135}, {"x": 787.314, "y": 1289.325}, {"x": 780.5535185880537, "y": 1293.6618015586728}], plot = [{"x": 762.42, "y": 1295.82}, {"x": 783.8462391374868, "y": 1284.0368527411135}, {"x": 787.314, "y": 1289.325}, {"x": 768.935, "y": 1301.115}], front = [{"x": 768.935, "y": 1301.115}, {"x": 762.7268167567435, "y": 1296.0693621990724}] as [Polygon[number], Polygon[number]];
    f.ctx.mapSize = 2000;
    f.ctx.win = { x0: 0, y0: 0, x1: 2000, y1: 2000 };
    f.quarters[0].lp = { pts: plot, lab: plot.map(() => LAB_WALL) };
    f.blocks[0].poly = plot;
    f.parcels[0].poly = plot; f.parcels[0].front = front;
    f.buildings[0].poly = oldRoof; f.buildings[0].kind = 'rear';
    f.footprint = [{ outer: plot, holes: [] }]; f.gardens = []; f.protectedLand = [];
    f.streets = new Streets();
    f.streets.connected.add(f.streets.add(front, 6, 1, 'radial', 1));
    f.allowGrowth = false;
    const result = finishEdgeRoofs(f), roof = f.buildings[0].poly;
    expect(result.fitted).toBe(1); expect(result.constrained).toBe(0);
    assertRectangle(roof); expect(outside(roof, plot)).toBeLessThanOrEqual(1e-6);
    expect(area(roof)).toBeGreaterThanOrEqual(0.65 * area(oldRoof));
    expect(area(roof)).toBeLessThanOrEqual(1.3 * area(oldRoof));
    expect(f.buildings).toHaveLength(1);
  });

  it('preserves an already whole rectangular roof even when its axis differs from the street frontage', () => {
    const f = fixture(true);
    f.parcels[0].poly = [{ x: 110, y: 103 }, { x: 150, y: 103 }, { x: 150, y: 180 }, { x: 110, y: 172 }];
    f.blocks[0].poly = f.parcels[0].poly;
    const dx = 1 / Math.sqrt(1.04), dy = 0.2 / Math.sqrt(1.04);
    const a = { x: 120, y: 172 }, b = { x: a.x + 15 * dx, y: a.y + 15 * dy };
    f.buildings[0].poly = [a, b, { x: b.x + 6 * dy, y: b.y - 6 * dx }, { x: a.x + 6 * dy, y: a.y - 6 * dx }];
    const before = JSON.stringify(f.buildings);
    const result = finishEdgeRoofs(f);
    expect(result.grown + result.fitted + result.constrained).toBe(0);
    expect(JSON.stringify(f.buildings)).toBe(before);
  });

  it('does not claim a different phase band or collapse a physically narrow wall-side roof', () => {
    const f = fixture(), reserved = [{ x: 120, y: 174 }, { x: 140, y: 178 }, { x: 140, y: 183 }, { x: 120, y: 179 }];
    f.phases!.push({ id: 2, region: [{ outer: reserved, holes: [] }], band: [{ outer: reserved, holes: [] }] });
    const bandBefore = JSON.stringify(f.phases![1].band);
    expect(finishEdgeRoofs(f).grown).toBe(0);
    expect(JSON.stringify(f.phases![1].band)).toBe(bandBefore);
    expect(insetEdgeRoof([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 12 }, { x: 0, y: 9 }], [{ x: 0, y: 0 }, { x: 3, y: 0 }])).toBeNull();
  });

  it('fits the captured seed42 wall-side clipped range with a real rectangle', () => {
    const roof = [
      { x: 860.6487716972291, y: 1491.9387801913804 }, { x: 868.7671160897277, y: 1487.526343268794 },
      { x: 877.2554189397555, y: 1499.1709541551256 }, { x: 867.9278834289859, y: 1501.9245718404331 },
    ];
    const front: [typeof roof[0], typeof roof[0]] = [roof[0], roof[1]];
    const inset = insetEdgeRoof(roof, front);
    expect(inset).not.toBeNull();
    assertRectangle(inset!);
    expect(outside(inset!, roof)).toBeLessThan(1e-6);
    expect(area(inset!)).toBeGreaterThanOrEqual(0.65 * area(roof));
    expect(area(roofEnvelope(roof, front))).toBeGreaterThan(area(roof));
  });

  it.each(['none', 'single'] as const)('preserves real seeded partitions and access with walls=%s', (walls) => {
    const w = generate(makeOptions({ seed: '42', size: 'town', culture: 'european-organic', walls, settlements: 'none' }));
    expect(Number(w.stats['urban.edgeRoofs.grown'] ?? 0) + Number(w.stats['urban.edgeRoofs.fitted'] ?? 0)).toBeGreaterThan(0);
    const r = checkWorld(w);
    expect(r.blockOutside).toBeLessThanOrEqual(0.05);
    expect(r.blockAreaErr).toBeLessThanOrEqual(0.005);
    expect(r.overlapsBlocks).toBe(0);
    expect(r.overlapsPlots).toBe(0);
    expect(r.overlapsBuildings).toBe(0);
    expect(r.noFrontage).toBe(0);
    expect(r.bldgOutside).toBe(0);
    expect(r.orphanMain).toBe(0);
    expect(unreachableBuildings(w).n).toBe(0);
    for (const b of w.urban!.buildings) expect(mpArea(intersectionS(b.poly, w.urban!.water ?? []))).toBeLessThanOrEqual(0.05);
  });
});
