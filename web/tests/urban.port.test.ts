import { describe, it, expect, vi } from 'vitest';
import type { Polygon, Vec2 } from '../src/gen/core/geom';
import type { World } from '../src/gen/types';
import { createGrid } from '../src/gen/core/grid';
import { Rng } from '../src/gen/core/rng';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { area, distToRing, distToSeg, segSegT, SNAP } from '../src/gen/geo/poly';
import { intersectionS, mpArea } from '../src/gen/geo/bool';
import * as booleans from '../src/gen/geo/bool';
import { ribbon } from '../src/gen/geo/offset';
import { makeCtx } from '../src/gen/urban/context';
import { resolveMorph } from '../src/gen/urban/morphology';
import { localShoreSamples, portWaterKind, reservePort } from '../src/gen/urban/m4/port';
import type { M4State } from '../src/gen/urban/m4/reserve';
import { buildPrimary, radialWallGates, type ReserveApi, type WallLine } from '../src/gen/urban/primary';
import { Streets, LAB_WATER, LAB_OPEN } from '../src/gen/urban/streets';
import { wallFeatures } from '../src/gen/urban/walls';
import { macroPortFrontage } from '../src/gen/urban/mega/ports';
import type { MacroQuarter, MacroStreet } from '../src/gen/urban/mega/types';
import { checkM4 } from './m4Check';
import { checkWorld } from './urbanCheck';

const box = (x0: number, y0: number, x1: number, y1: number): Polygon => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
function fixture(kind: 'coast' | 'river' | 'lake' = 'coast') {
  const height = createGrid(100, 100, 10);
  const water = new Uint8Array(10000);
  // Raster cells intentionally extend onto a physically dry bank, as real contour/raster banks can do.
  for (let y = 68; y < 100; y++) for (let x = 0; x < 100; x++) water[y * 100 + x] = kind === 'coast' ? 1 : kind === 'river' ? 3 : 2;
  const world = {
    seed: 'shore-fixture', options: makeOptions({ seed: 'shore-fixture' }), mapSize: 1000, stats: {},
    terrain: { height, slope: height, water, coastline: kind === 'coast' ? [box(0, 700, 1000, 1000)] : [],
      lakes: kind === 'lake' ? [box(0, 700, 1000, 1000)] : [],
      rivers: kind === 'river' ? [{ path: [{ x: 0, y: 711 }, { x: 1000, y: 711 }], width: [20, 20] }] : [] },
    site: { center: { x: 500, y: 600 }, cost: height },
  } as unknown as World;
  const P = resolveMorph('european-organic');
  const ctx = makeCtx(world, P, 1000);
  const region = [{ outer: box(350, 500, 650, 640), holes: [] }];
  const streets = new Streets();
  const id = streets.add([{ x: 350, y: 600 }, { x: 650, y: 600 }], 7, 0, 'radial', 1);
  streets.connected.add(id);
  const api: ReserveApi = { streets, market: null, marketStreet: -1, radialLines: [], enclosure: region, footprint: region, phases: [], gates: [], cuts: [] };
  const state: M4State = { ctx, rng: new Rng('coastal-frontage'), pop: 3500, P, lotData: new Map(), sites: [], culture: 'european-organic' };
  const pin = { avoid: [] as Polygon[], nucleus: world.site!.center, harbor: { x: 500, y: 700 }, roads: [] as Vec2[][], bridges: [] as { a: Vec2; b: Vec2 }[] };
  return { world, ctx, api, state, pin };
}

describe('plausible served port frontage', () => {
  it('recovers the real rounded radial endpoint as an actual wall opening, with no gate for a nearby interior stub', () => {
    // The terminal radial and curtain edge of seed1: insidePieces rounded the contact 1.750mm inward.
    const ring = [{ x: 1125.49, y: 1500 }, { x: 1211.1, y: 1500 }, { x: 1211.1, y: 1671.93 }, { x: 1125.49, y: 1642.5 }];
    const neighbour = { x: 1190.8504982315035, y: 1630.7874111658934 }, end = { x: 1175.5, y: 1659.69 };
    const streets = new Streets();
    const id = streets.add([neighbour, end], [5.91, 5.035], 1, 'radial', 1);
    expect(segSegT(neighbour, end, ring[2], ring[3])).toBeNull();
    expect(distToRing(ring, end)).toBeLessThan(Math.SQRT2 / (2 * SNAP));
    const gates = radialWallGates(streets.list[id], ring);
    expect(gates).toHaveLength(1);
    expect(distToRing(ring, gates[0].p)).toBeLessThan(1e-8);
    const approach = [{ x: 1227.0208638409151, y: 1743.8887414298488 }, end];
    const wall = wallFeatures(ring, gates, new Rng('rounded-gate'), () => false);
    for (const piece of wall.pieces) for (let i = 1; i < piece.length; i++) expect(segSegT(approach[0], approach[1], piece[i - 1], piece[i])).toBeNull();
    const length = Math.hypot(neighbour.x - end.x, neighbour.y - end.y);
    const stub = { x: end.x + (neighbour.x - end.x) * 0.02 / length, y: end.y + (neighbour.y - end.y) * 0.02 / length };
    expect(radialWallGates({ ...streets.list[id], path: [neighbour, stub] }, ring)).toEqual([]);
  });

  it('supplies the same radial gate contacts to reservation and the final primary curtain', () => {
    const f = fixture();
    const region = [{ outer: [{ x: 200.123, y: 330.456 }, { x: 830.789, y: 360.012 }, { x: 785.678, y: 650.345 }, { x: 210.901, y: 620.234 }], holes: [] }];
    const streets = new Streets();
    let reservedGates: Vec2[] = [];
    const primary = buildPrimary(f.ctx, {
      phases: [{ id: 1, kind: 'core', zone: 'core', region, band: region, age: 1, fossil: false, walled: true, pop: 3500 }],
      enclosure: region, walled: true, moat: 'no', faubourg: [],
      roads: [{ path: [{ x: 500, y: 100 }, { x: 500, y: 600 }], major: true }],
      marketArea: 1200, mainAngle: 0, extraRadials: true,
      reserve: (api) => { reservedGates = api.gates.slice(); return []; },
    }, streets, new Rng('rounded-radial'));
    const finalGates = primary.walls.flatMap((wall) => wall.gates.map((gate) => gate.p));
    expect(finalGates.length).toBeGreaterThan(1);
    expect(reservedGates).toEqual(finalGates);
    expect(primary.radials.some((id) => {
      const path = streets.list[id].path, end = path[path.length - 1];
      return distToRing(region[0].outer, end) <= Math.SQRT2 / (2 * SNAP)
        && finalGates.some((gate) => Math.hypot(gate.x - end.x, gate.y - end.y) < 0.01);
    })).toBe(true);
  });

  it('does not expose a radial contact discarded by the curtain twelve-metre gate spacing', () => {
    const f = fixture(), region = f.api.enclosure, streets = new Streets();
    const ctx = { ...f.ctx, center: { x: 485.5, y: 600 } };
    let reservedGates: Vec2[] = [];
    let reservedWalls: WallLine[] = [];
    const primary = buildPrimary(ctx, {
      phases: [{ id: 1, kind: 'core', zone: 'core', region, band: region, age: 1, fossil: false, walled: true, pop: 3500 }],
      enclosure: region, walled: true, moat: 'no', faubourg: [],
      roads: [480, 491].map((x) => ({ path: [{ x, y: 300 }, { x, y: 600 }], major: true })),
      marketArea: 0, mainAngle: 0, extraRadials: false,
      reserve: (api) => { reservedGates = api.gates.slice(); reservedWalls = api.gateWalls!; return []; },
    }, streets, new Rng('close-radial-gates'));
    const contacts = primary.radials.flatMap((id) => radialWallGates(streets.list[id], region[0].outer));
    expect(contacts).toHaveLength(2);
    expect(Math.hypot(contacts[0].p.x - contacts[1].p.x, contacts[0].p.y - contacts[1].p.y)).toBeCloseTo(11, 6);
    const wall = primary.walls[0];
    expect(reservedWalls).toBe(primary.walls);
    expect(wall.gates).toHaveLength(1);
    expect(reservedGates).toEqual(wall.gates.map((gate) => gate.p));
    expect(reservedGates.some((gate) => Math.hypot(gate.x - 491, gate.y - 500) < 10)).toBe(false);
    expect(wall.gates[0].width).toBe(contacts[0].width);
    expect(wall.gates[0].dir).toEqual(contacts[0].dir);
    const pieces = wallFeatures(wall.ring, wall.gates, new Rng('close-radial-gates'), () => false).pieces;
    expect(pieces.some((piece) => piece.slice(1).some((p, i) => segSegT({ x: 491, y: 480 }, { x: 491, y: 520 }, piece[i], p)))).toBe(true);
    expect(pieces.some((piece) => piece.slice(1).some((p, i) => segSegT({ x: 480, y: 480 }, { x: 480, y: 520 }, piece[i], p)))).toBe(false);
  });

  it('exposes an axis-end gate before reservation and retains its real final opening', () => {
    const f = fixture(), region = f.api.enclosure, streets = new Streets();
    // The existing axis-end rule admits this planned terminal point 0.1m inside the curtain.
    const extent = [{ outer: box(350, 500.1, 650, 640), holes: [] }];
    let reservedGates: Vec2[] = [];
    let reservedWalls: WallLine[] = [];
    const primary = buildPrimary(f.ctx, {
      phases: [{ id: 1, kind: 'core', zone: 'core', region, band: region, age: 1, fossil: false, walled: true, pop: 3500 }],
      enclosure: region, walled: true, moat: 'no', faubourg: [], roads: [],
      marketArea: 0, mainAngle: 0, extraRadials: false, axis: { angle: 0, extent, width: 6 },
      reserve: (api) => { reservedGates = api.gates.slice(); reservedWalls = api.gateWalls!; return []; },
    }, streets, new Rng('axis-end-gate'));
    const wall = primary.walls[0], axisGate = wall.gates.find((gate) => Math.hypot(gate.p.x - 500, gate.p.y - 500.1) < 1e-6)!;
    expect(reservedWalls).toBe(primary.walls);
    expect(reservedGates).toEqual(wall.gates.map((gate) => gate.p));
    expect(reservedGates.some((gate) => Math.hypot(gate.x - 500, gate.y - 500.1) < 1e-6)).toBe(true);
    expect(axisGate.street).toBe(-1);
    expect(axisGate.width).toBe(6);
    const pieces = wallFeatures(wall.ring, wall.gates, new Rng('axis-end-gate'), () => false).pieces;
    expect(pieces.some((piece) => piece.slice(1).some((p, i) => segSegT({ x: 500, y: 480 }, { x: 500, y: 520 }, piece[i], p)))).toBe(false);
  });

  it('samples a long straight shore only inside local search bounds and retains gaps between local shores', () => {
    const shore = box(0, 700, 1000000, 1000);
    const samples = localShoreSamples(shore, [{ x0: 400, y0: 650, x1: 600, y1: 750 }, { x0: 900, y0: 650, x1: 1000, y1: 750 }]);
    expect(samples.length).toBeLessThan(50);
    expect(samples.some((p) => p.y === 700 && p.x > 400 && p.x < 600)).toBe(true);
    expect(samples.some((p) => p.y === 700 && p.x > 600 && p.x < 900)).toBe(true);
    for (const p of samples) expect(distToRing(shore, p)).toBeLessThan(0.001);
  });

  it('makes a compact coastal port on a sparse bank while clipping the optional warehouse row around a lot', () => {
    const f = fixture();
    const castle = box(430, 630, 570, 660);
    f.pin.avoid.push(castle);
    const lots = reservePort(f.state, f.api, f.pin);
    expect(f.state.sites.some((s) => s.kind === 'harbour')).toBe(true);
    expect(f.state.quays).toHaveLength(1);
    expect(lots.some((lot) => lot.kind === 'harbour')).toBe(true);
    for (const lot of lots) {
      expect(mpArea(intersectionS(lot.poly, castle))).toBeLessThan(0.05);
      if (lot.kind === 'harbour') expect(mpArea(intersectionS(lot.poly, f.ctx.water))).toBeLessThan(0.05);
    }
    const quay = f.api.streets.list.find((st) => st.role === 'quay')!;
    expect(f.api.streets.connected.has(quay.id)).toBe(true);
    expect(mpArea(intersectionS(ribbon(quay.path, quay.widths), f.ctx.water))).toBeLessThanOrEqual(0.05);
    for (const edge of f.state.quays!) for (let i = 1; i < edge.length; i++) expect(Math.hypot(edge[i].x - edge[i - 1].x, edge[i].y - edge[i - 1].y)).toBeGreaterThanOrEqual(12);
  });

  it('tries the next real shore when the nearest harbour has no dry approach', () => {
    const f = fixture();
    f.world.terrain.coastline = [box(70, 700, 270, 1000), box(750, 700, 950, 1000)];
    f.state.ctx = makeCtx({ ...f.world, terrain: { ...f.world.terrain } }, f.state.P, 1000);
    const region = [box(80, 520, 250, 640), box(760, 520, 940, 640)].map((outer) => ({ outer, holes: [] }));
    f.api.footprint = region;
    f.api.enclosure = region;
    f.api.streets = new Streets();
    const id = f.api.streets.add([{ x: 800, y: 600 }, { x: 920, y: 600 }], 7, 0, 'radial', 1);
    f.api.streets.connected.add(id);
    f.pin.nucleus = { x: 170, y: 600 };
    f.pin.harbor = { x: 170, y: 700 };
    reservePort(f.state, f.api, f.pin);
    expect(f.state.sites.find((s) => s.id === 'port')?.anchor.x).toBeGreaterThan(700);
    const quays = f.api.streets.list.filter((st) => st.role === 'quay');
    expect(quays).toHaveLength(1);
    expect(quays.every((st) => f.api.streets.connected.has(st.id))).toBe(true);
  });

  it('leaves no streets, sites or builder data behind when every frontage is unserved', () => {
    const f = fixture();
    f.api.streets.connected.clear();
    const before = structuredClone(f.api.streets.list);
    expect(reservePort(f.state, f.api, f.pin)).toEqual([]);
    expect(f.api.streets.list).toEqual(before);
    expect(f.state.sites).toEqual([]);
    expect(f.state.lotData.size).toBe(0);
    expect(f.state.quays).toBeUndefined();
  });

  it.each([0, 18])('serves a sparse walled shore through its actual radial gate (outer curtain gap %s)', (gap) => {
    const f = fixture();
    const region = f.api.enclosure;
    f.api.phases = [{ id: 1, kind: 'core', zone: 'core', region, band: region, age: 1, fossil: false, walled: true, pop: 3500 }];
    const radial = [{ x: 500, y: 600 }, { x: 500, y: 690 }];
    const id = f.api.streets.add(radial, 7, 0, 'radial', 1);
    f.api.streets.connected.add(id);
    f.api.radialLines = [radial];
    f.api.gates = [{ x: 500, y: 640 }];
    f.api.gateWalls = [{ ring: region[0].outer, gates: [{ p: f.api.gates[0], dir: { x: 0, y: 1 }, width: 7, street: id }] }];
    f.state.wallThickness = 2.6;
    f.state.listsW = gap;
    const lots = reservePort(f.state, f.api, f.pin);
    expect(f.state.sites.some((s) => s.kind === 'harbour')).toBe(true);
    const quay = f.api.streets.list.find((st) => st.role === 'quay')!;
    expect(quay.path.slice(1).some((p, i) => segSegT(p, quay.path[i], radial[0], radial[1]))).toBe(true);
    const approaches = lots.find((lot) => lot.kind === 'm4-quay')!.cuts;
    for (const path of [quay.path, ...approaches]) for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      for (const wallY of gap ? [640, 640 + gap] : [640]) {
        const hit = segSegT(a, b, { x: 350 - gap, y: wallY }, { x: 650 + gap, y: wallY });
        if (hit) expect(Math.abs(a.x + (b.x - a.x) * hit.t - 500)).toBeLessThan(10);
      }
    }
  });

  it('does not cut a new port approach through an ungated standing wall', () => {
    const f = fixture();
    const region = f.api.enclosure;
    f.api.phases = [{ id: 1, kind: 'core', zone: 'core', region, band: region, age: 1, fossil: false, walled: true, pop: 3500 }];
    const before = structuredClone(f.api.streets.list);
    expect(reservePort(f.state, f.api, f.pin)).toEqual([]);
    expect(f.api.streets.list).toEqual(before);
    expect(f.state.sites).toEqual([]);
    expect(f.state.lotData.size).toBe(0);
  });

  it.each(['water', 'lot'] as const)('rejects an exhausted %s overlap proof without mutating streets or reserves', (subject) => {
    const f = fixture();
    const lot = box(430, 630, 570, 660);
    if (subject === 'lot') f.pin.avoid.push(lot);
    const failedOperand = subject === 'water' ? f.ctx.water : lot;
    const realIntersection = booleans.tryIntersection;
    const spy = vi.spyOn(booleans, 'tryIntersection').mockImplementation((poly, ...rest) =>
      rest.includes(failedOperand) ? { pieces: [], failed: true } : realIntersection(poly, ...rest));
    const before = structuredClone(f.api.streets.list);
    try {
      expect(reservePort(f.state, f.api, f.pin)).toEqual([]);
      expect(spy).toHaveBeenCalled();
      expect(f.api.streets.list).toEqual(before);
      expect(f.state.sites).toEqual([]);
      expect(f.state.lotData.size).toBe(0);
      expect(f.state.quays).toBeUndefined();
    } finally { spy.mockRestore(); }
  });

  it('rejects an exhausted physical curtain proof without mutating a viable gated shore', () => {
    const f = fixture(), region = f.api.enclosure;
    f.api.phases = [{ id: 1, kind: 'core', zone: 'core', region, band: region, age: 1, fossil: false, walled: true, pop: 3500 }];
    const gate = { x: 500, y: 640 };
    const radial = [{ x: 500, y: 600 }, gate];
    const id = f.api.streets.add(radial, 7, 0, 'radial', 1);
    f.api.streets.connected.add(id);
    f.api.radialLines = [radial];
    f.api.gates = [gate];
    f.api.gateWalls = [{ ring: region[0].outer, gates: [{ p: gate, dir: { x: 0, y: 1 }, width: 7, street: id }] }];
    f.state.wallThickness = 2.6;
    const realIntersection = booleans.tryIntersection;
    let curtainChecks = 0;
    const spy = vi.spyOn(booleans, 'tryIntersection').mockImplementation((poly, ...rest) => {
      if (rest[0] !== f.ctx.water) { curtainChecks++; return { pieces: [], failed: true }; }
      return realIntersection(poly, ...rest);
    });
    const before = structuredClone(f.api.streets.list);
    try {
      expect(reservePort(f.state, f.api, f.pin)).toEqual([]);
      expect(curtainChecks).toBeGreaterThan(0);
      expect(f.api.streets.list).toEqual(before);
      expect(f.state.sites).toEqual([]);
      expect(f.state.lotData.size).toBe(0);
      expect(f.state.quays).toBeUndefined();
    } finally { spy.mockRestore(); }
  });

  it('rejects a remote coast, lakes and small channels but retains a navigable river port', () => {
    const coast = fixture();
    coast.api.footprint = [{ outer: box(350, 100, 650, 300), holes: [] }];
    expect(reservePort(coast.state, coast.api, coast.pin)).toEqual([]);
    const lake = fixture('lake');
    expect(reservePort(lake.state, lake.api, lake.pin)).toEqual([]);
    const river = fixture('river');
    reservePort(river.state, river.api, river.pin);
    expect(river.state.sites.some((s) => s.kind === 'river-port')).toBe(true);
    expect(river.state.sites.some((s) => s.kind === 'harbour')).toBe(false);
    const narrow = { ...river.ctx, terrain: { ...river.ctx.terrain, rivers: [{ ...river.ctx.terrain.rivers[0], width: [4, 4] }] } };
    expect(portWaterKind(narrow, { x: 500, y: 711 })).toBeNull();
  });
});

describe('automatic coastal town regression', () => {
  for (const options of [
    { seed: '1', size: 'town' as const, coast: 'S' as const },
    { seed: '1', size: 'town' as const, coast: 'S' as const, walls: 'single' as const },
    { seed: '1', size: 'town' as const, coast: 'S' as const, walls: 'double' as const },
    { seed: '42', size: 'town' as const, coast: 'S' as const, siteType: 'harbor' as const },
  ]) {
    it(`keeps ${options.seed}/${'walls' in options ? options.walls : 'default'} coastal frontage connected, dry and exactly partitioned`, () => {
      const w = generate(makeOptions({ ...options, settlements: 'none' }));
      expect(w.urban!.sites!.some((s) => s.kind === 'harbour')).toBe(true);
      const m = checkM4(w), r = checkWorld(w);
      expect(m.noAccess).toEqual([]);
      expect(m.wetBuildings).toEqual([]);
      expect(m.wetBlocks).toEqual([]);
      expect(m.lotOverlap).toBeLessThan(0.5);
      expect(m.quayOff).toBeLessThanOrEqual(10);
      expect(r.blockAreaErr).toBeLessThanOrEqual(0.005);
      expect(r.blockOutside).toBeLessThan(1);
      expect(r.overlapsBlocks).toBe(0);
      expect(r.overlapsPlots).toBe(0);
      expect(r.overlapsBuildings).toBeLessThanOrEqual(Math.ceil(r.buildings * 0.0005));
      expect(r.noFrontage).toBe(0);
      expect(r.bldgOutside).toBe(0);
      expect(r.orphanMain).toBe(0);
      const ctx = makeCtx(w, resolveMorph('european-organic'), w.mapSize);
      for (const quay of w.urban!.quays!) for (let i = 1; i < quay.length; i++) expect(Math.hypot(quay[i].x - quay[i - 1].x, quay[i].y - quay[i - 1].y)).toBeGreaterThanOrEqual(12);
      for (const street of w.urban!.streets.filter((st) => st.role === 'quay')) expect(mpArea(intersectionS(ribbon(street.path, street.width), ctx.water))).toBeLessThanOrEqual(0.05);
      for (const parcel of w.urban!.parcels.filter((p) => p.use === 'pier')) expect(mpArea(intersectionS(parcel.poly, ctx.water))).toBeGreaterThanOrEqual(area(parcel.poly) - 0.5);
      const port = w.urban!.sites!.find((s) => s.id === 'port')!;
      expect(port.entrance).toBeDefined();
      expect(w.urban!.streets.some((st) => st.path.slice(1).some((p, i) => distToSeg(port.entrance!, st.path[i], p) <= st.width / 2 + 0.1))).toBe(true);
      if (options.seed === '1') {
        const wall = w.urban!.walls!.find((wall) => wall.role === 'town')!;
        const radialEnd = { x: 1175.5, y: 1659.69 };
        if ('walls' in options && options.walls === 'double') {
          // Double-curtain radial planning has its own real terminal contact; retain the same rounding bound.
          const radial = w.urban!.streets.filter((street) => street.role === 'radial').map((street) => ({ street, end: street.path[street.path.length - 1] }))
            .filter(({ end }) => distToRing(wall.path, end) <= Math.SQRT2 / (2 * SNAP)).sort((a, b) => b.end.y - a.end.y)[0];
          expect(radial).toBeDefined();
          const gate = wall.gateInfo!.find((gate) => Math.hypot(gate.p.x - radial.end.x, gate.p.y - radial.end.y) <= Math.SQRT2 / (2 * SNAP));
          expect(gate).toBeDefined();
          expect(distToRing(wall.path, gate!.p)).toBeLessThan(1e-8);
          expect(gate!.width).toBe(radial.street.widths![radial.street.widths!.length - 1]);
        } else expect(wall.gates.some((gate) => Math.hypot(gate.x - radialEnd.x, gate.y - radialEnd.y) < 0.01)).toBe(true);
        const quays = w.urban!.streets.filter((street) => street.role === 'quay');
        const approaches = w.urban!.streets.filter((street) => street.role === 'street' && street.path.some((p) =>
          quays.some((quay) => quay.path.slice(1).some((b, i) => distToSeg(p, quay.path[i], b) < 0.01))));
        expect(approaches.length).toBeGreaterThan(0);
        const curtains = w.urban!.walls!.filter((w) => w.role === 'town' || w.role === 'outer');
        if ('walls' in options && options.walls === 'double') expect(curtains.some((w) => w.role === 'outer')).toBe(true);
        // The former seed1 centreline used this real gate, but its shallow 4.6m pavement struck masonry.
        const shallow = ribbon([{ x: 1287.4878351750979, y: 1732.306116679254 }, radialEnd], 4.6);
        expect(wall.pieces!.reduce((sum, piece) => sum + mpArea(intersectionS(shallow, ribbon(piece, wall.thickness))), 0)).toBeGreaterThan(14);
        for (const street of [...quays, ...approaches]) {
          expect(street.width).toBeGreaterThanOrEqual(street.role === 'quay' ? 6.2 : 4.6);
          const pavement = ribbon(street.path, street.widths ?? street.width);
          const dry = booleans.tryIntersection(pavement, ctx.water);
          expect(dry.failed).toBe(false);
          expect(mpArea(dry.pieces)).toBeLessThanOrEqual(0.05);
          for (const curtain of curtains) for (const piece of curtain.pieces!) {
            for (let i = 1; i < street.path.length; i++) for (let j = 1; j < piece.length; j++) {
              expect(segSegT(street.path[i - 1], street.path[i], piece[j - 1], piece[j])).toBeNull();
            }
            const clear = booleans.tryIntersection(pavement, ribbon(piece, curtain.thickness));
            expect(clear.failed).toBe(false);
            expect(mpArea(clear.pieces)).toBeLessThanOrEqual(0.05);
          }
        }
        // A safe access road must not leave its ordinary harbour row standing across the outer curtain.
        expect(w.urban!.buildings.filter((building) => building.arch === 'warehouse').length).toBeGreaterThan(0);
        for (const building of w.urban!.buildings.filter((building) => ['house', 'rear', 'back', 'barn', 'shed'].includes(building.kind))) for (const curtain of curtains) for (const piece of curtain.pieces!) {
          const clear = booleans.tryIntersection(building.poly, ribbon(piece, curtain.thickness));
          expect(clear.failed).toBe(false);
          expect(mpArea(clear.pieces)).toBeLessThanOrEqual(0.05);
        }
      }
    }, 120000);
  }

  it('retains determinism, the port=no override and absence of an inland coast port', () => {
    const options = makeOptions({ seed: '1', size: 'town', coast: 'S', settlements: 'none' });
    const a = generate(options), b = generate(options);
    expect(b.urban).toEqual(a.urban);
    const off = generate(makeOptions({ ...options, port: 'no' }));
    expect(off.urban!.quays ?? []).toEqual([]);
    expect(off.urban!.sites!.some((s) => s.role === 'port')).toBe(false);
    const inland = generate(makeOptions({ seed: '42', size: 'town', coast: 'none', river: 'none', settlements: 'none' }));
    expect(inland.urban!.quays ?? []).toEqual([]);
    expect(inland.urban!.sites!.some((s) => s.role === 'port')).toBe(false);
  }, 120000);
});

describe('macro coastal port programme', () => {
  it('requires natural navigable shore frontage and a real land street', () => {
    const f = fixture();
    const streets: MacroStreet[] = [{ path: [{ x: 350, y: 600 }, { x: 650, y: 600 }], widths: [7, 7], rank: 0, role: 'radial', phase: 1 }];
    const quarter = { pts: box(350, 600, 650, 700), lab: [0, LAB_OPEN, LAB_WATER, LAB_OPEN] } as MacroQuarter;
    expect(macroPortFrontage(f.ctx, quarter, streets)).toMatchObject({ served: true, coastal: true, length: 300 });
    expect(macroPortFrontage(f.ctx, { ...quarter, lab: quarter.lab.map((label) => label === 0 ? LAB_OPEN : label) }, streets).served).toBe(false);
    expect(macroPortFrontage(fixture('lake').ctx, quarter, streets).length).toBe(0);
    expect(macroPortFrontage(f.ctx, quarter, streets, () => false).length).toBe(0);
  });

  it('keeps the coastal programme in macro quarters and honors port=no', () => {
    const options = makeOptions({ seed: '42', size: 'city', population: 60000, mapSize: 4000, coast: 'S', siteType: 'harbor',
      river: 'none', relief: 'flat', settlements: 'none', walls: 'none' });
    const w = generate(options), u = w.urban!, M = u.macro!;
    expect(M).toBeDefined();
    expect(u.sites!.some((s) => s.kind === 'harbour')).toBe(true);
    const ports = M.quarters.filter((q) => q.district === 'port');
    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) expect(port.lab.some((label) => label >= 0 && M.streets[label].role === 'quay')).toBe(true);
    const off = generate(makeOptions({ ...options, port: 'no' })).urban!;
    expect(off.quays ?? []).toEqual([]);
    expect(off.sites!.some((s) => s.role === 'port')).toBe(false);
    expect(off.macro!.quarters.some((q) => q.district === 'port')).toBe(false);
  }, 120000);
});
