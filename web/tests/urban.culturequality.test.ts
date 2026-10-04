import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/gen/core/rng';
import type { Polygon } from '../src/gen/core/geom';
import { area, bboxOf, isSimple, pointInRing, obb, distToRing, distToSeg } from '../src/gen/geo/poly';
import { intersectionS, mpArea, differenceS } from '../src/gen/geo/bool';
import { polyInside } from '../src/gen/geo/split';
import { generate } from '../src/gen/pipeline';
import { makeOptions, fromQuery, toQuery, CULTURE_LABELS } from '../src/gen/options';
import { getCulture, resolvePlan, type NucleusKind } from '../src/gen/urban/culture';
import { MORPHOLOGIES } from '../src/gen/urban/morphology';
import { buildOn } from '../src/gen/urban/bops';
import { registerSwahili, swahiliDoorLines } from '../src/gen/urban/swahili';
import { buildCompound } from '../src/gen/urban/compounds';
import { registerPrimitiveFeatures, primitiveBoundaryLines, primitiveGardenLines, halflingGardenTrees } from '../src/gen/urban/primitive_features';
import { resolveMorph } from '../src/gen/urban/morphology';
import { primitiveHouse } from '../src/gen/urban/primitive';
import { makeCtx } from '../src/gen/urban/context';
import { wetArea } from '../src/gen/urban/waterland';
import { khmerCity, prasatMoatPaths } from '../src/gen/urban/camps/khmer';
import type { CampCtx } from '../src/gen/urban/camps';
import { openRing } from '../src/gen/urban/camps/kit';
import { ribbon } from '../src/gen/geo/offset';
import { blockReach, makeStreetAt, carvePassage, shapeOkObb } from '../src/gen/urban/access';
import { megaQuarterDetail } from '../src/gen/urban/mega/detail';
import type { Plot } from '../src/gen/urban/plots';
import type { UrbanLayer, UrbanStreet } from '../src/gen/types';
import { WALL_LINE_W } from '../src/render/scene';
import { expectInvariants } from './cultureCases';
import { IROQUOIAN_SHORT_LOTS, IROQUOIAN_VALID_HOUSE_HASHES } from './fixtures/iroquoian-short-lots';

const rect = (w: number, h: number): Polygon => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
const plot = (poly: Polygon): Plot => ({ poly, front: [poly[0], poly[1]], nrm: { x: 0, y: 1 }, block: 0, zone: 'middle', rank: 1, wealth: 0.8,
  sideA: { p: poly[0], d: { x: 0, y: 1 } }, sideB: { p: poly[1], d: { x: 0, y: 1 } }, depth: 40, wide: true, sideFronts: [], run: 0, order: 0 });

/** Whole-block access: the oracle includes compounds as obstacles and includes the actual macro arterials. */
function expectFabric(u: UrbanLayer, boundary: UrbanStreet[] = []): void {
  expect(u.buildings.length).toBeGreaterThan(0);
  const streetAt = makeStreetAt([...boundary, ...u.streets], u.parcels.filter((p) => ['place', 'market', 'quay', 'green'].includes(p.use)).map((p) => p.poly));
  for (const b of u.buildings) {
    expect(isSimple(b.poly)).toBe(true);
    expect(b.parcel).toBeDefined();
    expect(polyInside(u.parcels[b.parcel!].poly, b.poly)).toBe(true);
  }
  for (let bk = 0; bk < u.blocks.length; bk++) {
    const list = u.buildings.filter((b) => b.parcel !== undefined && u.parcels[b.parcel].block === bk);
    const access = blockReach(u.blocks[bk], list.map((b) => b.poly), streetAt);
    list.forEach((b, i) => {
      if (u.parcels[b.parcel!].use === 'plot') expect(access[i], 'dwelling access in block ' + bk).toBe(true);
      for (const other of list.slice(i + 1)) expect(mpArea(intersectionS(b.poly, other.poly)), 'disjoint footprints').toBeLessThanOrEqual(0.05);
    });
  }
}

class CikmaRng extends Rng {
  readonly requested: boolean;
  draws = 0;
  constructor(cikma: boolean) { super('konak'); this.requested = cikma; }
  range(a: number, b: number): number { return (a + b) / 2; }
  chance(p: number): boolean { if (p === 0.55) { this.draws++; return this.requested; } return true; }
}

describe('Ottoman usable house projection', () => {
  it('adds the previously impossible shallow cikma to the house, keeping the garden passage and other ranges', () => {
    const P = MORPHOLOGIES.ottoman, poly = rect(18, 36), withoutRng = new CikmaRng(false), withRng = new CikmaRng(true);
    const without = buildOn(plot(poly), 0.56, P, withoutRng), withProjection = buildOn(plot(poly), 0.56, P, withRng);
    const a = without.find((b) => b.arch === 'ottoman-wooden-house')!, b = withProjection.find((bld) => bld.arch === 'ottoman-wooden-house')!;
    expect(withoutRng.draws).toBe(1); expect(withRng.draws).toBe(1);
    // Exact approved e9a5df2 fixture: before both branches had this same rectangle and area.
    expect(area(a.poly)).toBeCloseTo(132.61, 5);
    expect(a.poly.length).toBe(4);
    expect(b.poly.length).toBeGreaterThanOrEqual(8);
    expect(area(b.poly) - area(a.poly)).toBeGreaterThan(3);
    expect(bboxOf(b.poly).y0).toBeCloseTo(0.05, 3);
    expect(polyInside(poly, b.poly)).toBe(true);
    expect(isSimple(b.poly)).toBe(true);
    expect(withProjection.filter((bld) => bld !== b)).toEqual(without.filter((bld) => bld !== a));
    const houses = withProjection.filter((bld) => bld.kind !== 'garden');
    const streetAt = makeStreetAt([{ path: [{ x: -5, y: -2 }, { x: 25, y: -2 }], width: 4 }], []);
    expect(blockReach(poly, houses.map((bld) => bld.poly), streetAt)).toEqual(houses.map(() => true));
    for (let i = 0; i < houses.length; i++) for (const other of houses.slice(i + 1)) expect(mpArea(intersectionS(houses[i].poly, other.poly))).toBeLessThanOrEqual(0.05);
  });
  it('keeps narrow konaks unchanged when their frontage does not qualify for a projection', () => {
    const withoutRng = new CikmaRng(false), withRng = new CikmaRng(true);
    const a = buildOn(plot(rect(8, 30)), 0.56, MORPHOLOGIES.ottoman, withoutRng);
    const b = buildOn(plot(rect(8, 30)), 0.56, MORPHOLOGIES.ottoman, withRng);
    expect(b).toEqual(a);
    expect(withoutRng.draws).toBe(0); expect(withRng.draws).toBe(0);
    expect(b.filter((bd) => bd.kind === 'house').length).toBeGreaterThan(0);
  });
});

describe('native programmes survive urban growth', () => {
  for (const kind of ['cattle-kraal', 'chieftain-hall', 'kiva-plaza']) it(kind + ' reserves a useful civic core with contained architecture and open circulation', () => {
    registerPrimitiveFeatures();
    const lot = rect(60, 50), out = buildCompound(kind, lot, { angle: 0, pop: 10000, rng: new Rng('native-core'), center: { x: 30, y: 25 } });
    expect(out.parcels).toHaveLength(1);
    expect(area(out.parcels[0].poly)).toBe(area(lot));
    expect(out.buildings.length).toBeGreaterThan(0);
    expect(out.landmarks.length).toBeGreaterThan(0);
    expect(out.buildings.reduce((s, b) => s + area(b.poly), 0)).toBeLessThan(0.6 * area(lot));
    for (let i = 0; i < out.buildings.length; i++) {
      const b = out.buildings[i];
      expect(polyInside(lot, b.poly)).toBe(true);
      for (const other of out.buildings.slice(i + 1)) expect(mpArea(intersectionS(b.poly, other.poly))).toBeLessThanOrEqual(0.05);
    }
    const street = makeStreetAt([{ path: [{ x: -5, y: -2 }, { x: 65, y: -2 }], width: 4 }], []);
    expect(blockReach(lot, out.buildings.map((b) => b.poly), street)).toEqual(out.buildings.map(() => true));
    if (kind === 'cattle-kraal') {
      expect(out.lines.some((l) => l.kind === 'kraal-fence')).toBe(true);
      expect(out.buildings.every((b) => b.kind === 'pit')).toBe(true);
    } else if (kind === 'chieftain-hall') {
      const hall = out.buildings.find((b) => b.arch === 'chieftain-hall')!;
      expect(area(hall.poly)).toBeGreaterThan(150);
    } else expect(out.buildings.some((b) => b.arch === 'great-kiva')).toBe(true);
  });

  it('keeps functional gates in native banks and garden boundaries and fits fruit trees off roofs', () => {
    const path = [{ x: 2, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }];
    for (const culture of ['norse-ringfort', 'barbarian-celtic']) {
      const lines = primitiveBoundaryLines(culture, path);
      expect(lines.map((l) => l.kind)).toEqual(['rampart', 'palisade']);
      expect(lines.every((l) => l.path === path)).toBe(true); // only the real gate-cut enclosure, never a new closed ring
    }
    expect(primitiveBoundaryLines('kraal', path)[0].kind).toBe('thorn-fence');
    const poly = rect(30, 30), pl = plot(poly), parcel = { poly, use: 'plot', front: pl.front, block: 0 };
    const houses = primitiveHouse(pl, 0.45, resolveMorph('halfling-town'), new Rng('garden'));
    const bs = houses.map((b) => ({ ...b, parcel: 0 }));
    const lines = primitiveGardenLines('halfling', [parcel]);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) for (let i = 1; i < line.path.length; i++) expect(distToSeg({ x: 15, y: 0 }, line.path[i - 1], line.path[i])).toBeGreaterThanOrEqual(1.59);
    const trees = halflingGardenTrees([parcel], bs);
    expect(trees.length).toBeGreaterThan(0);
    for (const t of trees) {
      expect(distToRing(poly, t)).toBeGreaterThan(t.r);
      for (const b of bs) { expect(pointInRing(b.poly, t)).toBe(false); expect(distToRing(b.poly, t)).toBeGreaterThan(t.r); }
    }
    expect(primitiveGardenLines('barbarian', [parcel]).every((l) => l.kind === 'yard-fence')).toBe(true);
  });

  for (const [seed, oldCount] of [['1', 599], ['2', 725]] as const) it('Iroquoian town ' + seed + ' retains longhouses and served housing, instead of accepting short cottages', () => {
    const w = generate(makeOptions({ seed, culture: 'native-iroquoian', size: 'town' })), u = w.urban!;
    expectInvariants(w); expectFabric(u);
    const homes = u.buildings.filter((b) => b.arch === 'longhouse');
    // The approved baseline had 599/725 served house parcels; a dimension fix must not remove most households.
    expect(new Set(homes.map((b) => b.parcel)).size).toBeGreaterThanOrEqual(Math.ceil(oldCount * 0.9));
    const currentHashes = new Set(homes.map((b) => createHash('sha256').update(JSON.stringify([
      u.parcels[b.parcel!].poly, b.poly, b.arch, b.roof, b.material, b.storeys, b.orientation,
    ])).digest('hex')));
    expect(IROQUOIAN_VALID_HOUSE_HASHES[seed].filter((hash) => !currentHashes.has(hash)), 'every previously valid clan dwelling stays byte-identical').toEqual([]);
    for (const b of homes) { expect(2 * obb(b.poly).hu).toBeGreaterThan(11.5); expect(2 * obb(b.poly).hv).toBeGreaterThanOrEqual(4.45); }
  }, 600000);

  for (const fixture of IROQUOIAN_SHORT_LOTS) it('Iroquoian real short lot ' + fixture.seed + ' keeps a clan dwelling and a full side passage without blocking its neighbours', () => {
    const pl = structuredClone(fixture.plot), P = resolvePlan('native-iroquoian', 10000).phases[0].morph;
    const r = new Rng('regression');
    r.range = (a, b) => (a + b) / 2; r.chance = () => false;
    // Approved v3 returned no house on both exact plots with these same forced draws.
    const buildings = primitiveHouse(pl, 0.6, P, r);
    const homes = buildings.filter((b) => b.kind === 'house');
    expect(homes).toHaveLength(1);
    expect(homes[0].arch).toBe('longhouse');
    expect(pl.gated).toBe(true);
    for (const b of buildings) {
      expect(polyInside(pl.poly, b.poly)).toBe(true);
      expect(shapeOkObb(b.poly)).toBe(true);
      expect(isSimple(b.poly)).toBe(true);
      if (b.kind === 'house') expect(2 * obb(b.poly).hu).toBeGreaterThan(11.5);
    }
    // A full, unbounded 1.6 m cut on the reserved side must leave every footprint byte-identical.
    expect((['A', 'B'] as const).some((side) => JSON.stringify(carvePassage(pl, buildings, side, 1.6)) === JSON.stringify(buildings))).toBe(true);
    const streetAt = makeStreetAt(fixture.streets, []);
    const access = blockReach(fixture.block, [...fixture.existing.map((b) => b.poly), ...buildings.map((b) => b.poly)], streetAt);
    expect(access.every(Boolean), 'new clan dwelling and all existing block buildings remain served').toBe(true);
    for (let i = 0; i < buildings.length; i++) for (const other of [...buildings.slice(i + 1), ...fixture.existing]) {
      expect(mpArea(intersectionS(buildings[i].poly, other.poly))).toBeLessThanOrEqual(0.05);
    }
    const plAgain = structuredClone(fixture.plot), rAgain = new Rng('regression');
    rAgain.range = r.range; rAgain.chance = r.chance;
    expect(primitiveHouse(plAgain, 0.6, P, rAgain)).toEqual(buildings);
  });

  it('Khmer village seed 2 finds a dry temple court on a served road end', () => {
    const w = generate(makeOptions({ seed: '2', size: 'village', culture: 'khmer' })), u = w.urban!;
    expectInvariants(w); expectFabric(u);
    const shrine = u.sites!.find((s) => s.kind === 'prasat')!;
    expect(shrine).toBeDefined();
    const ctx = makeCtx(w, MORPHOLOGIES.khmer, w.mapSize);
    expect(wetArea(shrine.lot, ctx.water)).toBeLessThanOrEqual(0.01);
    // The oblique flat cap is carved out of the lot; its centre endpoint may be up to half a road width away.
    const causeway = u.streets.find((s) => s.width === 6 && distToRing(shrine.lot, s.path.at(-1)!) <= s.width / 2 + 0.002)!;
    expect(causeway).toBeDefined();
    expect(causeway.role).toBe('radial');
    expect(mpArea(intersectionS(shrine.lot, ribbon(causeway.path, causeway.width)))).toBeLessThanOrEqual(0.01);
    const others = u.streets.filter((s) => s !== causeway);
    expect(others.some((s) => s.path.some((p) => Math.hypot(p.x - causeway.path[0].x, p.y - causeway.path[0].y) < 0.02))).toBe(true);
    const reserve = rect(88, 88).map((p) => ({ x: p.x + shrine.anchor.x - 44, y: p.y + shrine.anchor.y - 44 }));
    expect(wetArea(reserve, ctx.water)).toBeLessThanOrEqual(0.01);
    for (const q of u.quarters) if (!pointInRing(q.poly.outer, shrine.anchor)) expect(mpArea(intersectionS([q.poly], reserve))).toBeLessThanOrEqual(0.01);
    const moats = (u.lines ?? []).filter((l) => l.kind === 'moat' && l.path.every((p) => Math.abs(p.x - shrine.anchor.x) <= 37.01 && Math.abs(p.y - shrine.anchor.y) <= 37.01));
    expect(moats.length).toBeGreaterThan(0);
    for (const l of moats) expect(mpArea(intersectionS(ribbon(l.path, l.width!), ribbon(causeway.path, causeway.width)))).toBeLessThanOrEqual(0.01);
  }, 600000);

  it('cuts a real passage through the whole moat band at oblique and corner approaches', () => {
    const center = { x: 100, y: 100 }, moat = rect(74, 74).map((p) => ({ x: p.x + 63, y: p.y + 63 }));
    for (const from of [{ x: 148, y: 170 }, { x: 148, y: 148 }, { x: 52, y: 170 }]) {
      const extent = Math.max(Math.abs(from.x - center.x), Math.abs(from.y - center.y));
      const at = (r: number) => ({ x: center.x + (from.x - center.x) * r / extent, y: center.y + (from.y - center.y) * r / extent });
      const causeway: [{ x: number; y: number }, { x: number; y: number }] = [from, at(30)], road = ribbon(causeway, 6);
      const old = openRing(moat, [{ p: at(37), width: 6 }]);
      expect(old.reduce((sum, path) => sum + mpArea(intersectionS(ribbon(path, 10), road)), 0)).toBeGreaterThan(1);
      const paths = prasatMoatPaths(center, causeway);
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.reduce((sum, path) => sum + mpArea(intersectionS(ribbon(path, 10), road)), 0)).toBeLessThanOrEqual(0.01);
      expect(paths.reduce((sum, path) => sum + area(ribbon(path, 10)), 0)).toBeGreaterThan(2400);
    }
  });

  it('keeps the entire Khmer moat reserve off existing ground even when its inner court is clear', () => {
    class MidRng extends Rng {
      range(a: number, b: number): number { return (a + b) / 2; }
      fork(label: string): Rng { return new MidRng(this.seedKey + ':' + label); }
    }
    const center = { x: 600, y: 600 }, original = { x: 847, y: 600 };
    const occupied = rect(2, 14).map((p) => ({ x: p.x + 888, y: p.y + 593 }));
    const squareAt = (c: { x: number; y: number }, h: number) => rect(h * 2, h * 2).map((p) => ({ x: p.x + c.x - h, y: p.y + c.y - h }));
    // With midpoint rows, the old prasat is at x=600+195+52=847. Its court misses this strip; its moat hits it.
    expect(mpArea(intersectionS(squareAt(original, 30), occupied))).toBe(0);
    expect(mpArea(intersectionS(squareAt(original, 44), occupied))).toBeGreaterThan(20);
    const cc = { main: true, roadAngle: 0, sprawl: 1, roads: [], avoid: [occupied],
      ctx: { center, mapSize: 1200, water: [], isWater: () => false } } as unknown as CampCtx;
    const out = khmerCity(cc, center, 180, new MidRng('reserve'));
    const shrine = out.sites.find((s) => s.kind === 'prasat')!;
    expect(shrine).toBeDefined();
    expect(shrine.anchor).not.toEqual(original);
    const reserve = squareAt(shrine.anchor, 44);
    expect(mpArea(intersectionS(reserve, occupied))).toBeLessThanOrEqual(0.01);
    for (const q of out.quarters) if (!pointInRing(q, shrine.anchor)) expect(mpArea(intersectionS(reserve, q))).toBeLessThanOrEqual(0.01);
  });

  for (const [culture, kind, arch, role] of [['native-pueblo', 'kiva-plaza', 'great-kiva', 'worship'],
    ['kraal', 'cattle-kraal', 'grain-pit', 'civic'], ['barbarian', 'chieftain-hall', 'chieftain-hall', 'power']] as const) it('retains the native core and its site independently in a lazy ' + culture + ' city', () => {
    const w = generate(makeOptions({ seed: '2', population: 60000, mapSize: 7000, eagerPop: 1000, culture, river: 'none', relief: 'flat', settlements: 'none' }));
    const untouched = structuredClone(w), M = w.urban!.macro!;
    expect(M.nucleusCompound).toBe(kind);
    const nucleus = M.quarters.find((q) => q.kind === 'market')!;
    const first = megaQuarterDetail(w, nucleus.id)!;
    expect(first.buildings.some((b) => b.arch === arch)).toBe(true);
    expect(first.sites!.some((s) => s.kind === kind && s.role === role)).toBe(true);
    expectFabric(first, w.urban!.streets);
    megaQuarterDetail(w, M.quarters.find((q) => q.kind === 'quarter')!.id);
    expect(megaQuarterDetail(untouched, nucleus.id)).toEqual(first);
  }, 600000);
});

describe('Swahili stone town', () => {
  it('is a real catalogue and URL preset, with own courtyard, bazaar and worship programmes', () => {
    const c = getCulture('swahili-stone-town'), p = resolvePlan(c.id, 6000);
    expect(c.id).toBe('swahili-stone-town');
    expect(CULTURE_LABELS.some(([id]) => id === c.id)).toBe(true);
    expect(fromQuery(toQuery(makeOptions({ culture: c.id }))).culture).toBe(c.id);
    expect(p.nucleus.builder).toBe('swahili-juma-mosque');
    expect(resolvePlan(c.id, 6000, undefined, { nucleus: { kind: 'market' } }).nucleus.builder).toBeUndefined();
    expect(resolvePlan(c.id, 6000, undefined, { nucleus: { kind: 'precinct', builder: 'kiva-plaza' } }).nucleus.builder).toBe('kiva-plaza');
    expect(p.phases[0].sectors[0].morph.arch.typology).toBe('swahili-bazaar-shop');
    expect(p.phases[0].morph.closeOp).toBe('culDeSacTree');
    expect(p.phases[0].morph.arch.material).toBe('coral-stone');
    expect(c.m4?.cathedral).toBeNull(); expect(c.m4?.palace).toBeNull();
    expect(c.m4?.port).toBe(true);
    for (const pop of [2400, 6000, 20000]) expect(resolvePlan(c.id, pop).phases.reduce((sum, phase) => sum + phase.share, 0)).toBeCloseTo(1, 12);
    expect(resolvePlan(c.id, 2400).phases[0].share).toBe(1);
  });

  it('leaves unknown override builders as exact open lots instead of calling inherited object properties', () => {
    const lot = rect(30, 30), cx = { angle: 0, pop: 6000, rng: new Rng('unknown-builder'), center: { x: 15, y: 15 } };
    for (const kind of ['unknown-nucleus', '__proto__', 'constructor', 'toString']) {
      const out = buildCompound(kind, lot, cx);
      expect(out.parcels).toEqual([{ poly: lot, use: 'compound:' + kind }]);
      expect(out.buildings).toEqual([]);
    }
  });

  for (const lazy of [false, true]) it('keeps unknown nucleus builder worlds clonable with ' + (lazy ? 'lazy' : 'eager') + ' site hooks', () => {
    for (const key of ['unknown-nucleus', '__proto__', 'constructor', 'toString']) for (const field of ['builder', 'kind'] as const) {
      const nucleus = field === 'builder' ? { builder: key } : { kind: key as NucleusKind };
      const w = generate(makeOptions({ seed: '3', size: 'town', population: 2400, mapSize: 3600,
        eagerPop: lazy ? 1000 : 30000, culture: 'swahili-stone-town', river: 'none', relief: 'flat', settlements: 'none',
        plan: { nucleus } }));
      const u = lazy ? megaQuarterDetail(w, w.urban!.macro!.quarters.find((q) => q.kind === 'market')!.id)! : w.urban!;
      expect(u.sites!.some((s) => s.kind === key)).toBe(false);
      expect(u.sites!.every((s) => typeof s.role === 'string')).toBe(true);
      expect(u.blockInfo.every((b) => b.compound === undefined || typeof b.compound === 'string')).toBe(true);
      expect(() => structuredClone(u)).not.toThrow();
      expect(() => structuredClone(w)).not.toThrow();
    }
  }, 600000);

  it('fits larger open courts and actual double-door glyphs, preserving the entrance and containment', () => {
    const poly = rect(24, 24), pl = plot(poly);
    const swahili = buildOn(structuredClone(pl), 0.9, MORPHOLOGIES['swahili-stone'], new Rng('2'));
    const medina = buildOn(structuredClone(pl), 0.9, MORPHOLOGIES.medina, new Rng('2'));
    const sc = swahili.flatMap((b) => b.courtyards ?? []), mc = medina.flatMap((b) => b.courtyards ?? []);
    expect(sc.length).toBe(1); expect(mc.length).toBe(1);
    expect(area(sc[0])).toBeGreaterThanOrEqual(0.22 * area(poly));
    expect(area(sc[0])).toBeGreaterThan(area(mc[0]));
    for (const b of swahili) {
      expect(polyInside(poly, b.poly)).toBe(true);
      expect(b.material).toBe('coral-stone'); expect(b.roof).toBe('flat');
      expect(mpArea(intersectionS(sc[0], b.poly))).toBeLessThanOrEqual(0.05);
    }
    const streetAt = makeStreetAt([{ path: [{ x: -5, y: -2 }, { x: 30, y: -2 }], width: 4 }], []);
    expect(blockReach(poly, swahili.map((b) => b.poly), streetAt)).toEqual(swahili.map(() => true));
    const doors = swahiliDoorLines(swahili.map((b) => ({ ...b, parcel: 0 })), [{ poly, front: pl.front, use: 'plot', block: 0 }]);
    expect(doors.length).toBe(2);
    expect(doors.every((l) => l.path.every((p) => pointInRing(poly, p)))).toBe(true);
    expect(WALL_LINE_W['carved-door']).toBe(0.25);
    expect(swahiliDoorLines([{ poly, kind: 'house', arch: 'swahili-stone-house', parcel: 0 }], [{ poly, front: pl.front, use: 'plot', block: 0 }])).toEqual([]);
  });

  for (const kind of ['swahili-mosque', 'swahili-juma-mosque', 'swahili-fort', 'swahili-merchant-house']) it(kind + ' is a distinct contained compound with open ground', () => {
    registerSwahili();
    const lot = rect(70, 60), out = buildCompound(kind, lot, { angle: 0, pop: 9000, rng: new Rng('1'), center: { x: 35, y: 30 } });
    expect(out.parcels).toEqual([{ poly: lot, use: 'compound:' + kind }]);
    expect(out.landmarks.some((l) => l.kind === kind)).toBe(true);
    expect(out.buildings.length).toBeGreaterThan(0);
    expect(out.buildings.reduce((sum, b) => sum + area(b.poly), 0)).toBeLessThan(0.9 * area(lot));
    for (let i = 0; i < out.buildings.length; i++) {
      const b = out.buildings[i];
      expect(polyInside(lot, b.poly)).toBe(true); expect(isSimple(b.poly)).toBe(true);
      expect(b.material).toBe('coral-stone'); expect(b.roof).toBe('flat');
      for (const other of out.buildings.slice(i + 1)) expect(mpArea(intersectionS(b.poly, other.poly))).toBeLessThanOrEqual(0.05);
    }
    for (const line of out.lines) expect(line.path.every((p) => pointInRing(lot, p))).toBe(true);
    if (kind.includes('mosque')) {
      const court = out.landmarks.find((l) => l.kind === 'swahili-mosque-court')!;
      expect(area(court.poly)).toBeGreaterThan(20);
      for (const b of out.buildings) expect(mpArea(intersectionS(court.poly, b.poly))).toBeLessThanOrEqual(0.05);
      expect(out.buildings.some((b) => b.roof === 'dome')).toBe(false);
    }
  });

  it('forms a coastal stone town and many suburbs with real quays, court houses and its own worship landmarks', () => {
    const w = generate(makeOptions({ seed: '1', size: 'town', population: 6000, culture: 'swahili-stone-town', coast: 'S', river: 'none', siteType: 'harbor', relief: 'flat', settlements: 'none', suburbs: 'many' }));
    expectInvariants(w); expectFabric(w.urban!);
    const u = w.urban!;
    expect(u.quays?.length ?? 0).toBeGreaterThan(0);
    expect(u.buildings.filter((b) => b.arch === 'swahili-stone-house' && !!b.courtyards?.length).length).toBeGreaterThan(10);
    expect(u.buildings.some((b) => b.arch === 'swahili-bazaar-shop')).toBe(true);
    expect(u.buildings.some((b) => b.arch === 'swahili-juma-mosque')).toBe(true);
    expect(u.buildings.some((b) => b.arch === 'swahili-mosque')).toBe(true);
    expect((u.lines ?? []).some((l) => l.kind === 'carved-door')).toBe(true);
    expect(u.blockInfo.some((b) => ['great-mosque', 'm4-cathedral-close', 'parish-church', 'church'].includes(b.compound ?? '')) || u.buildings.some((b) => b.arch === 'parish-church')).toBe(false);
  }, 600000);

  it('keeps inland water-free towns dry without inventing a quay', () => {
    const w = generate(makeOptions({ seed: '2', size: 'town', population: 2400, culture: 'swahili-stone-town', coast: 'none', river: 'none', relief: 'flat', settlements: 'none' }));
    expectInvariants(w); expectFabric(w.urban!);
    expect(w.urban!.quays ?? []).toHaveLength(0);
    expect(w.urban!.buildings.filter((b) => b.arch === 'swahili-stone-house').length).toBeGreaterThan(10);
  }, 600000);

  it('keeps lazy-quarter independence, partition and access with Swahili programmes on the waterfront', () => {
    const w = generate(makeOptions({ seed: '1', size: 'city', population: 60000, mapSize: 7000, eagerPop: 1000, culture: 'swahili-stone-town', coast: 'S', river: 'none', siteType: 'harbor', relief: 'flat', settlements: 'none' }));
    const M = w.urban!.macro!, original = structuredClone(w);
    expect(M.nucleusCompound).toBe('swahili-juma-mosque');
    expect(M.quarters.some((q) => q.district === 'port')).toBe(true);
    expect(M.quarters.some((q) => q.wants.some((want) => want.kind === 'swahili-merchant-house'))).toBe(true);
    expect(M.quarters.flatMap((q) => q.wants).some((want) => ['parish-church', 'm4-cathedral-close', 'm4-monastery'].includes(want.kind))).toBe(false);
    const ids = [...new Set([M.quarters.find((q) => q.kind === 'market')!.id, M.quarters.find((q) => q.district === 'port')!.id, M.quarters.find((q) => q.kind === 'quarter' && q.district === 'town')!.id])];
    const first = new Map(ids.map((id) => [id, megaQuarterDetail(w, id)!]));
    for (const id of ids.slice().reverse()) {
      const detail = megaQuarterDetail(original, id)!;
      expect(detail).toEqual(first.get(id));
      expectFabric(detail, w.urban!.streets);
      for (const block of detail.blocks) expect(mpArea(differenceS(block, M.quarters[id].pts))).toBeLessThan(0.5);
      const parcelArea = detail.parcels.reduce((sum, p) => sum + area(p.poly), 0), blockArea = detail.blocks.reduce((sum, p) => sum + area(p), 0);
      expect(Math.abs(parcelArea - blockArea) / blockArea).toBeLessThan(0.005);
    }
  }, 600000);
});

// e9a5df2 approved baseline, exact matching options. Hashes omit timing/stats and include all urban geometry.
const UNCHANGED = {
  hanseatic: 'a31745e3591d1a27b24388decff09d6e774f3c3f60ea929a042cad9cdaa03e35',
  korean: '77d5671142d1249afe7fc50dbac3bdf21e88c7271b48bc6386eb936f060c1a7e',
  'stilt-town': 'd89df30e3ef33ea6016788f0f8174ff44eb8d35b5efdcb099cd285d30835cbee',
  'celtic-oppidum': '63cb3eed43ea2ea133a269d34f92e3d55ac42e135ba7c2cce87c9c43f07d5081',
  'barbarian-norse': '86baec92e1970e274fb3105e1175a744cc8343902e1b5d02c9543405249bb12f',
};
for (const [culture, hash] of Object.entries(UNCHANGED)) it(culture + ' retains the approved streets, plots and architecture', () => {
  const u = generate(makeOptions({ seed: '1', size: 'town', population: 2400, culture, settlements: 'none', coast: culture === 'hanseatic' ? 'S' : 'none', relief: culture === 'korean' || culture === 'celtic-oppidum' ? 'hills' : 'flat' })).urban!;
  const geometry = { culture: u.culture, streets: u.streets, blocks: u.blocks, parcels: u.parcels, buildings: u.buildings, walls: u.walls, lines: u.lines };
  expect(createHash('sha256').update(JSON.stringify(geometry)).digest('hex')).toBe(hash);
}, 600000);
