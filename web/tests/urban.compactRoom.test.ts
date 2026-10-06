import { describe, expect, it } from 'vitest';
import type { Polygon, Vec2 } from '../src/gen/core/geom';
import { area, inscribed, isSimple, minNeck } from '../src/gen/geo/poly';
import { mpArea, tryIntersection } from '../src/gen/geo/bool';
import { tryDifference } from '../src/gen/geo/bool';
import { shapeOkObb, blockReach, makeStreetAt } from '../src/gen/urban/access';
import { streetStrips } from '../src/gen/urban/openfringe';
import { polyInside } from '../src/gen/geo/split';
import { reconstructCompactRoom } from '../src/gen/urban/compactRoom';
import { reconstructSmallPlotRoom } from '../src/gen/urban/smallPlotRoom';
import { finalizeFootprints } from '../src/gen/urban/footprintFinal';
import native from './fixtures/compact-pins-v11.json';
import roofPeer from './fixtures/urban-roof-peer-v13.json';
import compound from './fixtures/urban-compound-v13.json';
import spur from './fixtures/urban-spur-v13.json';
import workshop from './fixtures/urban-workshop-v13.json';

interface NativeCase {
  i: number; roof: Polygon; owner: Polygon; front: [Vec2, Vec2]; block: Polygon;
  peers: { i: number; poly: Polygon }[]; occupied: Polygon[];
}
const fixture = native as unknown as {
  streets: { path: Vec2[]; width: number; widths?: number[] }[];
  places: Polygon[]; water: { outer: Polygon; holes: Polygon[] }[];
  walls: { path: Vec2[] }[]; lines: { kind: string; path: Vec2[]; width?: number; closed?: boolean }[];
  cases: NativeCase[];
};
const streetAt = makeStreetAt(fixture.streets, fixture.places);
const reserve = [
  ...fixture.water,
  ...fixture.streets.flatMap((s) => streetStrips(s.path, s.widths ?? s.width)),
  ...fixture.walls.flatMap((w) => streetStrips([...w.path, w.path[0]], 5.6)),
  ...fixture.lines.flatMap((l) => streetStrips(l.closed ? [...l.path, l.path[0]] : l.path, l.width ?? 1)),
];
const proper = (p: Polygon): boolean => p.length >= 3 && isSimple(p) && area(p) >= 12
  && shapeOkObb(p) && 2 * inscribed(p, [], 0.05, 1.8).r >= 3.6
  && (minNeck(p)?.w ?? Infinity) >= 3.59;

describe('compact recovery on six pinned native blocks', () => {
  for (const id of [180, 845]) it(`refuses a retained room overlapping a live peer in pinned roof ${id}`, () => {
    const f = fixture.cases.find((c) => c.i === id)!;
    const baseline = [{ poly: f.roof, kind: id === 180 ? 'rear' : 'back', parcel: 0 }];
    finalizeFootprints({ buildings: baseline,
      parcels: [{ poly: f.owner, front: f.front, use: 'plot', block: 0 }], backLand: [],
      placementClear: () => true, validateParts: () => true,
      privatePassages: [], proposePrivatePassage: () => true });
    const main = baseline[0].poly;
    const center = inscribed(main, [], 0.05).c;
    const intruder: Polygon = [{ x: center.x - 0.8, y: center.y - 0.8 },
      { x: center.x + 0.8, y: center.y - 0.8 },
      { x: center.x + 0.8, y: center.y + 0.8 },
      { x: center.x - 0.8, y: center.y + 0.8 }];
    expect(mpArea(tryIntersection(main, intruder).pieces)).toBeGreaterThan(2);
    const buildings = [{ poly: f.roof, kind: id === 180 ? 'rear' : 'back', parcel: 0 },
      { poly: intruder, kind: 'landmark' }];
    const backLand: { outer: Polygon; holes: Polygon[] }[] = [];
    const privatePassages: { path: Vec2[]; width: number; parcel: number }[] = [];
    const original = JSON.stringify(buildings[0].poly);
    const result = finalizeFootprints({ buildings,
      parcels: [{ poly: f.owner, front: f.front, use: 'plot', block: 0 }],
      backLand, privatePassages,
      placementClear: (poly) => {
        const added = tryDifference(poly, f.roof);
        return !added.failed && mpArea(added.pieces) <= 1e-6;
      },
      validateParts: () => true,
      proposePrivatePassage: () => true });
    expect(result.invalid).toContain(0);
    expect(JSON.stringify(buildings[0].poly)).toBe(original);
    expect(buildings).toHaveLength(2);
    expect(backLand).toEqual([]);
    expect(privatePassages).toEqual([]);
  });
  it('replaces a narrow craft wing with a physical-clear served workshop in the same plot', () => {
    const f = workshop as unknown as { i: number; roof: Polygon; owner: Polygon; front: [Vec2, Vec2];
      block: Polygon; peers: { i: number; poly: Polygon }[];
      streets: { path: Vec2[]; widths?: number[]; width: number }[]; places: Polygon[];
      water: { outer: Polygon; holes: Polygon[] }[]; walls: { path: Vec2[]; thickness?: number }[];
      lines: { kind: string; path: Vec2[]; width?: number; closed?: boolean }[] };
    const streets = makeStreetAt(f.streets, f.places);
    const reserve = [...f.water, ...f.streets.flatMap((s) => streetStrips(s.path, s.widths ?? s.width)),
      ...f.walls.flatMap((w) => streetStrips([...w.path, w.path[0]], Math.max(w.thickness ?? 1, 5.6))),
      ...f.lines.filter((line) => /wall|fence|palisade|rampart|barbican|hedge/.test(line.kind))
        .flatMap((line) => streetStrips(line.closed ? [...line.path, line.path[0]] : line.path, line.width ?? 1))];
    const before = blockReach(f.block, f.peers.map((p) => p.poly), streets);
    const buildings = [{ poly: f.roof, kind: 'house', parcel: 0 },
      ...f.peers.filter((p) => p.i !== f.i).map((p) => ({ poly: p.poly, kind: 'landmark', parcel: undefined })),
      { poly: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }],
        kind: 'house', parcel: undefined }];
    const backLand: { outer: Polygon; holes: Polygon[] }[] = [];
    const result = finalizeFootprints({ buildings,
      parcels: [{ poly: f.owner, front: f.front, use: 'plot', block: 0 }], backLand,
      openQuarterEdge: () => false,
      placementClear: (p) => {
        const hit = tryIntersection(p, reserve);
        return !hit.failed && mpArea(hit.pieces) <= 1e-6;
      },
      validateParts: (_, parts) => {
        const proposed = f.peers.flatMap((peer) => peer.i === f.i ? parts : [peer.poly]);
        const after = blockReach(f.block, proposed, streets);
        const required = f.peers.flatMap((peer, j) => peer.i === f.i ? parts.map(() => true) : [before[j]]);
        return after.every((reached, j) => reached || !required[j]);
      } });
    expect(result.invalid).not.toContain(0);
    expect(area(buildings[0].poly)).toBeGreaterThanOrEqual(25);
    expect(area(buildings[0].poly)).toBeLessThan(0.7 * area(f.roof));
    expect(mpArea(tryDifference(buildings[0].poly, f.owner).pieces)).toBeLessThanOrEqual(1e-6);
    expect(mpArea(tryIntersection(buildings[0].poly, reserve).pieces)).toBeLessThanOrEqual(1e-6);
    expect(area(buildings[0].poly) + mpArea(backLand)
      - mpArea(tryDifference(buildings[0].poly, f.roof).pieces)).toBeCloseTo(area(f.roof), 5);
  });
  it('cuts a 2.23 m² inner spur into open land and keeps the plausible small quadrilateral', () => {
    const f = spur as unknown as { i: number; roof: Polygon; owner: Polygon; front: [Vec2, Vec2];
      block: Polygon; peers: { i: number; poly: Polygon }[];
      streets: { path: Vec2[]; widths?: number[]; width: number }[]; places: Polygon[] };
    const streetAt = makeStreetAt(f.streets, f.places);
    const before = blockReach(f.block, f.peers.map((p) => p.poly), streetAt);
    const buildings = [{ poly: f.roof, kind: 'back', parcel: 0 },
      ...f.peers.filter((p) => p.i !== f.i).map((p) => ({ poly: p.poly, kind: 'landmark', parcel: undefined }))];
    const backLand: { outer: Polygon; holes: Polygon[] }[] = [];
    const result = finalizeFootprints({ buildings,
      parcels: [{ poly: f.owner, front: f.front, use: 'plot', block: 0 }], backLand,
      openQuarterEdge: () => false,
      validateParts: (_, parts) => {
        const proposed = f.peers.flatMap((peer) => peer.i === f.i ? parts : [peer.poly]);
        const after = blockReach(f.block, proposed, streetAt);
        const required = f.peers.flatMap((peer, j) => peer.i === f.i ? parts.map(() => true) : [before[j]]);
        return after.every((reached, j) => reached || !required[j]);
      } });
    expect(result.invalid).not.toContain(0);
    expect(buildings[0].poly).toHaveLength(4);
    expect(area(buildings[0].poly)).toBeGreaterThan(0.9 * area(f.roof));
    expect(area(buildings[0].poly) + mpArea(backLand)).toBeCloseTo(area(f.roof), 5);
    expect(2 * inscribed(buildings[0].poly, [], 0.05).r).toBeGreaterThanOrEqual(3.2);
  });
  it('removes only a 4.49 m² interior spur while keeping two 20 m² rooms connected and served', () => {
    const f = compound as unknown as { i: number; roof: Polygon; owner: Polygon; front: [Vec2, Vec2];
      block: Polygon; peers: { i: number; poly: Polygon }[];
      streets: { path: Vec2[]; widths?: number[]; width: number }[]; places: Polygon[] };
    const streetAt = makeStreetAt(f.streets, f.places);
    const before = blockReach(f.block, f.peers.map((p) => p.poly), streetAt);
    const buildings = [{ poly: f.roof, kind: 'back', parcel: 0 },
      ...f.peers.filter((p) => p.i !== f.i).map((p) => ({ poly: p.poly, kind: 'landmark', parcel: undefined }))];
    const backLand: { outer: Polygon; holes: Polygon[] }[] = [];
    const result = finalizeFootprints({ buildings,
      parcels: [{ poly: f.owner, front: f.front, use: 'plot', block: 0 }], backLand,
      openQuarterEdge: () => false,
      validateParts: (_, parts) => {
        const proposed = f.peers.flatMap((peer) => peer.i === f.i ? parts : [peer.poly]);
        const after = blockReach(f.block, proposed, streetAt);
        const required = f.peers.flatMap((peer, j) => peer.i === f.i ? parts.map(() => true) : [before[j]]);
        return after.every((reached, j) => reached || !required[j]);
      } });
    expect(result.invalid).not.toContain(0);
    expect(area(buildings[0].poly)).toBeGreaterThan(0.90 * area(f.roof));
    expect(area(buildings[0].poly) + mpArea(backLand)).toBeCloseTo(area(f.roof), 5);
    expect((minNeck(buildings[0].poly)?.w ?? Infinity)).toBeGreaterThanOrEqual(3.2);
    expect((minNeck(buildings[0].poly)?.w ?? Infinity)).toBeLessThan(3.59);
    expect(buildings).toHaveLength(f.peers.length);
  });
  it('repairs a small convex rear roof that overlaps its same-plot main roof by 9 m²', () => {
    const f = roofPeer as unknown as { main: Polygon; peer: Polygon; owner: Polygon; front: [Vec2, Vec2] };
    expect(mpArea(tryIntersection(f.main, f.peer).pieces)).toBeGreaterThan(9);
    const buildings = [{ poly: f.peer, kind: 'house', parcel: 0 },
      { poly: f.main, kind: 'rear', parcel: 0 },
      { poly: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }],
        kind: 'house', parcel: undefined as number | undefined }];
    const result = finalizeFootprints({ buildings,
      parcels: [{ poly: f.owner, front: f.front, use: 'plot', block: 0 }], backLand: [],
      placementClear: () => true, validateParts: () => true });
    expect(result.invalid).not.toContain(1);
    expect(mpArea(tryIntersection(buildings[0].poly, buildings[1].poly).pieces)).toBeLessThanOrEqual(1e-6);
    expect(area(buildings[1].poly)).toBeGreaterThanOrEqual(12);
  });
  it('does not classify a 7 m by 2 m matchstick as a tiny dwelling', () => {
    const matchstick: Polygon = [{ x: 0, y: 0 }, { x: 7, y: 0 }, { x: 7, y: 2 }, { x: 0, y: 2 }];
    expect(reconstructSmallPlotRoom(matchstick, matchstick, undefined, [], () => true, () => true)).toBeNull();
  });
  for (const id of [104, 576]) it(`commits a small served dwelling in bent native plot ${id}`, () => {
    const f = fixture.cases.find((c) => c.i === id)!;
    const before = blockReach(f.block, f.peers.map((p) => p.poly), streetAt);
    const buildings = [{ poly: f.roof, kind: 'house', parcel: 0 },
      ...f.peers.filter((peer) => peer.i !== f.i)
        .map((peer) => ({ poly: peer.poly, kind: 'house', parcel: undefined as number | undefined }))];
    const land: { outer: Polygon; holes: Polygon[] }[] = [];
    const result = finalizeFootprints({ buildings, parcels: [{ poly: f.owner, front: f.front,
      use: 'plot', block: 0 }], backLand: land, placementClear: () => true,
    validateParts: (_, parts) => {
      const proposed = f.peers.flatMap((peer) => peer.i === f.i ? parts : [peer.poly]);
      const after = blockReach(f.block, proposed, streetAt);
      const required = f.peers.flatMap((peer, j) => peer.i === f.i ? parts.map(() => true) : [before[j]]);
      return after.every((reached, j) => reached || !required[j]);
    } });
    const room = buildings[0].poly;
    expect(result.invalid).not.toContain(0);
    expect(room.length).toBeGreaterThanOrEqual(4);
    expect(room.length).toBeLessThanOrEqual(6);
    expect(area(room)).toBeGreaterThanOrEqual(12);
    expect(2 * inscribed(room, [], 0.05).r).toBeGreaterThanOrEqual(3.2);
    expect(mpArea(tryDifference(room, f.owner).pieces)).toBeLessThanOrEqual(1e-6);
    expect(mpArea(tryIntersection(room, f.occupied.map((outer) => ({ outer, holes: [] }))).pieces))
      .toBeLessThanOrEqual(1e-6);
    const added = mpArea(tryDifference(room, f.roof).pieces);
    expect(area(room) + mpArea(land) - added).toBeCloseTo(area(f.roof), 5);
  }, 30_000);
  it('replaces the pinned uninhabitable arm with a real 0.8 m passage to served public apron', () => {
    const f = fixture.cases.find((c) => c.i === 845)!;
    const buildings = [{ poly: f.roof, kind: 'back', parcel: 0 },
      ...f.occupied.map((poly) => ({ poly, kind: 'landmark', parcel: 0 }))];
    const backLand: { outer: Polygon; holes: Polygon[] }[] = [];
    const privatePassages: { path: Vec2[]; width: number; parcel: number }[] = [];
    let approvedPath: Vec2[] | undefined;
    const before = blockReach(f.block, f.peers.map((p) => p.poly), streetAt);
    const validatePassage = (_: number, main: Polygon, path: Vec2[], width: number): boolean => {
      const corridor = streetStrips(path, width);
      const roofHit = tryIntersection(corridor, f.occupied.map((outer) => ({ outer, holes: [] })));
      const reserveHit = tryIntersection(corridor, reserve);
      const outsideOwner = tryDifference(corridor, f.owner), outsideBlock = tryDifference(corridor, f.block);
      if (roofHit.failed || reserveHit.failed || outsideOwner.failed || outsideBlock.failed
        || mpArea(roofHit.pieces) > 1e-6 || mpArea(reserveHit.pieces) > 1e-6
        || Math.abs(mpArea(outsideOwner.pieces) - mpArea(outsideBlock.pieces)) > 1e-6) return false;
      // The public apron is reachable before this private path becomes a street.
      const probe = blockReach(f.block, [...f.peers.map((p) => p.poly), ...corridor.map((p) => p.outer)], streetAt);
      if (!probe.slice(f.peers.length).some(Boolean)) return false;
      const extended = makeStreetAt([...fixture.streets, { path, width }], fixture.places);
      const after = blockReach(f.block, f.peers.map((peer) => peer.i === f.i ? main : peer.poly), extended);
      return after.every((served, j) => served || !before[j]);
    };
    const result = finalizeFootprints({ buildings,
      parcels: [{ poly: f.owner, front: f.front, use: 'plot', block: 0 }], backLand, privatePassages,
      placementClear: (p) => !tryIntersection(p, reserve).failed && mpArea(tryIntersection(p, reserve).pieces) <= 1e-6,
      proposePrivatePassage: (i, main, path, width) => {
        if (!validatePassage(i, main, path, width)) return false;
        approvedPath = path.map((p) => ({ ...p }));
        return approvedPath;
      },
      validateParts: (_, parts) => {
        const proposed = f.peers.flatMap((peer) => peer.i === f.i ? parts : [peer.poly]);
        const after = blockReach(f.block, proposed, streetAt);
        const required = f.peers.flatMap((peer, j) => peer.i === f.i ? parts.map(() => true) : [before[j]]);
        return after.every((reached, j) => reached || !required[j]);
      } });
    expect(result.invalid).not.toContain(0);
    expect(privatePassages).toHaveLength(1);
    expect(privatePassages[0].width).toBe(0.8);
    expect(privatePassages[0].path).toEqual(approvedPath);
    expect(privatePassages[0].path).not.toBe(approvedPath);
    expect(area(buildings[0].poly)).toBeGreaterThan(100);
    expect(area(buildings[0].poly) + mpArea(backLand)).toBeCloseTo(area(f.roof), 5);
    const denied = [{ poly: f.roof, kind: 'back', parcel: 0 }];
    const deniedPassages: typeof privatePassages = [];
    const deniedLand: typeof backLand = [];
    finalizeFootprints({ buildings: denied, parcels: [{ poly: f.owner, use: 'plot', block: 0 }],
      backLand: deniedLand, privatePassages: deniedPassages, placementClear: () => true,
      proposePrivatePassage: () => false, validateParts: () => false });
    expect(deniedPassages).toHaveLength(0);
    expect(denied[0].poly).toEqual(f.roof);
    expect(deniedLand).toHaveLength(0);
  });
  it('splits the pinned 1.55 m rear connector into three served rooms with 98% of its floor', () => {
    const f = fixture.cases.find((c) => c.i === 180)!;
    const before = blockReach(f.block, f.peers.map((p) => p.poly), streetAt);
    const buildings = [{ poly: f.roof, kind: 'rear', parcel: 0 },
      ...f.occupied.map((poly) => ({ poly, kind: 'landmark', parcel: 0 }))];
    const backLand: { outer: Polygon; holes: Polygon[] }[] = [];
    const result = finalizeFootprints({ buildings, parcels: [{ poly: f.owner, use: 'plot', block: 0 }], backLand,
      placementClear: (p) => !tryIntersection(p, reserve).failed && mpArea(tryIntersection(p, reserve).pieces) <= 1e-6,
      validateParts: (_, parts) => {
        const proposed = f.peers.flatMap((peer) => peer.i === f.i ? parts : [peer.poly]);
        const after = blockReach(f.block, proposed, streetAt);
        const required = f.peers.flatMap((peer, j) => peer.i === f.i ? parts.map(() => true) : [before[j]]);
        return after.every((reached, j) => reached || !required[j]);
      } });
    expect(result.invalid).not.toContain(0);
    const parts = [buildings[0].poly, ...buildings.slice(f.occupied.length + 1).map((b) => b.poly)];
    expect(parts).toHaveLength(3);
    expect(parts.every(proper)).toBe(true);
    expect(parts.reduce((s, p) => s + area(p), 0)).toBeGreaterThan(0.98 * area(f.roof));
    expect(parts.reduce((s, p) => s + area(p), 0)
      + backLand.reduce((s, p) => s + area(p.outer), 0)
      - mpArea(tryDifference(parts.map((outer) => ({ outer, holes: [] })), f.roof).pieces))
      .toBeCloseTo(area(f.roof), 5);
    const added = tryDifference(parts.map((outer) => ({ outer, holes: [] })), f.roof);
    expect(added.failed).toBe(false);
    expect(added.pieces.every((p) => p.holes.length === 0)).toBe(true);
    const gardens = added.pieces.map((p) => p.outer);
    const initialGardenArea = gardens.reduce((s, p) => s + area(p), 0);
    const secondBuildings = [{ poly: f.roof, kind: 'rear', parcel: 0 },
      ...f.occupied.map((poly) => ({ poly, kind: 'landmark', parcel: 0 }))];
    const secondBackLand: { outer: Polygon; holes: Polygon[] }[] = [];
    const second = finalizeFootprints({ buildings: secondBuildings,
      parcels: [{ poly: f.owner, use: 'plot', block: 0 }], gardens, backLand: secondBackLand,
      placementClear: (p) => !tryIntersection(p, reserve).failed && mpArea(tryIntersection(p, reserve).pieces) <= 1e-6,
      validateParts: (_, proposedParts) => {
        const proposed = f.peers.flatMap((peer) => peer.i === f.i ? proposedParts : [peer.poly]);
        const after = blockReach(f.block, proposed, streetAt);
        const required = f.peers.flatMap((peer, j) => peer.i === f.i ? proposedParts.map(() => true) : [before[j]]);
        return after.every((reached, j) => reached || !required[j]);
      } });
    expect(second.invalid).not.toContain(0);
    const secondParts = [secondBuildings[0].poly, ...secondBuildings.slice(f.occupied.length + 1).map((b) => b.poly)];
    for (const p of secondParts) {
      expect(mpArea(tryIntersection(p, gardens.map((outer) => ({ outer, holes: [] }))).pieces))
        .toBeLessThanOrEqual(1e-6);
      expect(mpArea(tryIntersection(p, secondBackLand).pieces)).toBeLessThanOrEqual(1e-6);
    }
    expect(secondParts.reduce((s, p) => s + area(p), 0) + gardens.reduce((s, p) => s + area(p), 0)
      + secondBackLand.reduce((s, p) => s + area(p.outer), 0))
      .toBeCloseTo(area(f.roof) + initialGardenArea, 5);
  });

  it('rebuilds the river U as a served, clear 85%-area room without taking another plot', () => {
    const f = fixture.cases.find((c) => c.i === 860)!;
    const before = blockReach(f.block, f.peers.map((p) => p.poly), streetAt);
    const candidate = reconstructCompactRoom(f.roof, f.owner, f.occupied, f.front,
      (p) => !tryIntersection(p, reserve).failed && mpArea(tryIntersection(p, reserve).pieces) <= 1e-6,
      (p) => {
        if (!proper(p)) return false;
        const after = blockReach(f.block, f.peers.map((peer) => peer.i === f.i ? p : peer.poly), streetAt);
        return after.every((reached, j) => f.peers[j].i === f.i ? reached : reached || !before[j]);
      });
    expect(candidate).not.toBeNull();
    expect(area(candidate!)).toBeGreaterThanOrEqual(0.85 * area(f.roof) - 1e-5);
    expect(area(candidate!)).toBeLessThan(area(f.roof));
    expect(mpArea(tryIntersection(candidate!, f.occupied.map((outer) => ({ outer, holes: [] }))).pieces))
      .toBeLessThanOrEqual(1e-6);
    expect(mpArea(tryIntersection(candidate!, reserve).pieces)).toBeLessThanOrEqual(1e-6);
  });

  it('commits the pinned river compact room with its freed land fully accounted', () => {
    const f = fixture.cases.find((c) => c.i === 860)!;
    const before = blockReach(f.block, f.peers.map((p) => p.poly), streetAt);
    const buildings = [{ poly: f.roof, kind: 'house', parcel: 0 },
      ...f.occupied.map((poly) => ({ poly, kind: 'landmark', parcel: 0 }))];
    const backLand: { outer: Polygon; holes: Polygon[] }[] = [];
    const result = finalizeFootprints({ buildings, parcels: [{ poly: f.owner, front: f.front,
      use: 'plot', block: 0 }], backLand,
      placementClear: (p) => !tryIntersection(p, reserve).failed && mpArea(tryIntersection(p, reserve).pieces) <= 1e-6,
      validateParts: (_, parts) => {
        const proposed = f.peers.flatMap((peer) => peer.i === f.i ? parts : [peer.poly]);
        const after = blockReach(f.block, proposed, streetAt);
        const required = f.peers.flatMap((peer, j) => peer.i === f.i ? parts.map(() => true) : [before[j]]);
        return after.every((reached, j) => reached || !required[j]);
      } });
    expect(result.invalid).not.toContain(0);
    expect(buildings[0].poly).toHaveLength(4);
    expect(area(buildings[0].poly)).toBeGreaterThanOrEqual(0.85 * area(f.roof) - 1e-5);
    const added = mpArea(tryDifference(buildings[0].poly, f.roof).pieces);
    expect(area(buildings[0].poly) + backLand.reduce((s, p) => s + area(p.outer), 0) - added)
      .toBeCloseTo(area(f.roof), 5);
  });

  it('does not claim occupied roofs, destroy block access, or squeeze a compact room into a too-small plot', () => {
    const bent = fixture.cases.find((c) => c.i === 576)!;
    const shortcut = bent.roof.filter((_, j) => (189 >> j) & 1);
    expect(polyInside(bent.owner, shortcut)).toBe(true);
    expect(mpArea(tryDifference(shortcut, bent.owner).pieces)).toBeGreaterThan(7.7);
    for (const f of fixture.cases.filter((c) => c.i !== 860)) {
      const before = blockReach(f.block, f.peers.map((p) => p.poly), streetAt);
      const candidate = reconstructCompactRoom(f.roof, f.owner, f.occupied, f.front, () => true,
        (p) => {
          if (!proper(p)) return false;
          const after = blockReach(f.block, f.peers.map((peer) => peer.i === f.i ? p : peer.poly), streetAt);
          return after.every((reached, j) => f.peers[j].i === f.i ? reached : reached || !before[j]);
        });
      expect(candidate, `roof ${f.i}`).toBeNull();
    }
  });
});
