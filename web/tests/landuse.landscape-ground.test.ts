import { describe, expect, it } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { urbanLandscapeGround } from '../src/gen/landuse/landscapeGround';
import { intersectionS, differenceSafeS, unionMany, mpArea } from '../src/gen/geo/bool';
import { area, isSimple, obb, distToRing } from '../src/gen/geo/poly';
import { offsetRibbon } from '../src/gen/core/geom';
import { blockReach } from '../src/gen/urban/access';
import { polyInside } from '../src/gen/geo/split';
import { Rng } from '../src/gen/core/rng';
import { buildCompound } from '../src/gen/urban/compounds';
import { registerM4 } from '../src/gen/urban/m4';
import { FROZEN_SHANTY_CELLS } from './fixtures/shanty-cells';

describe('landscape permission and informal-settlement siting', () => {
  it('generates opaque ordinary ground for the reported walled Wizard City and retains the agricultural reserve', () => {
    const w = generate(makeOptions({ seed: '1', size: 'city', culture: 'wizard-city' }));
    const u = w.urban!, ground = w.landuse!.landscapeGround!;
    expect(u.walls!.some((wall) => wall.role === 'town')).toBe(true);
    expect(mpArea(ground)).toBeGreaterThan(10000);
    expect(ground).toEqual(urbanLandscapeGround(w));
    for (const p of u.parcels.filter((p) => ['place', 'market', 'quay', 'pier', 'plaza'].includes(p.use))) {
      expect(mpArea(intersectionS(ground, p.poly))).toBeLessThan(0.01);
    }
    for (const cover of w.landuse!.areas.filter((a) => ['field', 'orchard', 'garden'].includes(a.kind))) {
      expect(mpArea(intersectionS(ground, [{ outer: cover.poly, holes: cover.holes ?? [] }]))).toBeLessThan(0.01);
    }
    expect(w.landuse!.reserve.length).toBeGreaterThan(0);
  }, 120000);

  it('preserves frozen hut cells, density, usable physical footprints and real path frontage', () => {
    registerM4();
    expect(FROZEN_SHANTY_CELLS.reduce((sum, fixture) => sum + fixture.cells.length, 0)).toBe(53);
    for (const fixture of FROZEN_SHANTY_CELLS) {
      const out = buildCompound('m4-shanty', fixture.poly,
        { rng: new Rng(fixture.rngKey), angle: 0, pop: 10000, center: fixture.center });
      const huts = out.buildings.filter((b) => b.kind === 'hut');
      const covered = huts.reduce((sum, h) => sum + area(h.poly), 0) / area(fixture.poly);
      expect(covered).toBeGreaterThanOrEqual(0.5); expect(covered).toBeLessThanOrEqual(0.7);
      const paths = out.lines.filter((line) => line.kind === 'footpath');
      let reach: boolean[] | undefined;
      for (const saved of fixture.cells) {
        const cell = out.parcels[saved.index].poly;
        expect(cell).toEqual(saved.poly);
        const resident = huts.filter((h) => h.parcel === saved.index);
        expect(resident).toHaveLength(1);
        expect({ poly: resident[0].poly, arch: resident[0].arch }).toEqual(saved.hut);
        const o = obb(resident[0].poly);
        expect(2 * o.hv).toBeGreaterThanOrEqual(4.5 - 1e-6);
        expect(o.hu / o.hv).toBeLessThanOrEqual(3 + 1e-6);
        expect(isSimple(resident[0].poly)).toBe(true); expect(polyInside(cell, resident[0].poly)).toBe(true);
        const frontage = paths.some((p) => p.path.length >= 2 && cell.some((a, i) => {
          const b = cell[(i + 1) % cell.length], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
          if (!L || p.path.some((v) => Math.abs(dx * (v.y - a.y) - dy * (v.x - a.x)) / L > 0.08)) return false;
          const along = p.path.map((v) => ((v.x - a.x) * dx + (v.y - a.y) * dy) / L);
          return Math.min(L, Math.max(...along)) - Math.max(0, Math.min(...along)) > 0.1;
        }));
        const boundary = cell.some((p, i) => distToRing(fixture.poly, p) < 0.08 && distToRing(fixture.poly, cell[(i + 1) % cell.length]) < 0.08);
        // A rear hut can reach the public exterior through actual unoccupied yard ground; it need not have
        // an entire producer path's endpoints on its own shorter frontage edge. Require 0.5 m clear ground.
        if (!frontage && !boundary) reach ??= blockReach(fixture.poly, huts.map((h) => h.poly),
          (p) => distToRing(fixture.poly, p) < 0.25, 0.25);
        expect(frontage || boundary || reach?.[huts.indexOf(resident[0])],
          `saved seed ${fixture.seed} cell ${saved.index} retains real path or connected open-ground access`).toBe(true);
      }
    }
  });

  it('keeps newly sited shanty lots occupied, partitioned and unpaved rather than discarding huts to create gaps', () => {
    const w = generate(makeOptions({ seed: '1', size: 'city', suburbs: 'many', shantytowns: 'many' }));
    const u = w.urban!, ground = w.landuse!.landscapeGround!;
    // The opaque replay follows the water pass, so genuine lake shoreline ink is a physical reservation too.
    // A tapered river's casing is already included below; a closed lake edge also needs its actual round joins.
    const bankWidth = 1.5 * w.mapSize / 1600;
    const lakeBanks = w.terrain.lakes.flatMap((ring) => ring.flatMap((a, i) => {
      const b = ring[(i + 1) % ring.length], dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      if (!len) return [];
      const nx = -dy * bankWidth / len, ny = dx * bankWidth / len, radius = bankWidth / Math.cos(Math.PI / 24);
      return [{ outer: [{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny },
        { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }], holes: [] },
      { outer: Array.from({ length: 24 }, (_, j) => ({
        x: a.x + radius * Math.cos((j + 0.5) * Math.PI / 12),
        y: a.y + radius * Math.sin((j + 0.5) * Math.PI / 12),
      })), holes: [] }];
    }));
    const protectedLand = unionMany([
      ...u.parcels.filter((p) => p.use !== 'plot' && p.use !== 'hut-lot').map((p) => ({ outer: p.poly, holes: [] })),
      ...u.backLand, ...u.squares.map((outer) => ({ outer, holes: [] })), ...(u.water ?? []), ...(u.ruralReserve ?? []),
      ...u.landmarks.filter((l) => l.kind !== 'camp-ground').map((l) => ({ outer: l.poly, holes: [] })),
      ...w.terrain.lakes.map((outer) => ({ outer, holes: [] })),
      ...lakeBanks,
      // The full visible river casing is protected after opaque replay, including its tapered headwater.
      ...w.terrain.rivers.map((r) => ({ outer: offsetRibbon(r.path, r.width.map((width, i) =>
        Math.max(1.1 * w.mapSize / 1600, width * (r.main || r.edgeFed ? 1 : Math.min(1, 0.35 + 0.65 * i / 7)))
          + 3.4 * w.mapSize / 1600)), holes: [] })),
    ], 24, true);
    const blocks = u.blocks.map((poly, i) => ({ poly, i })).filter(({ i }) => u.blockInfo[i].kind === 'shanty');
    expect(blocks.length).toBeGreaterThan(0);
    for (const { poly, i } of blocks) {
      const huts = u.buildings.filter((b) => b.kind === 'hut' && b.parcel !== undefined && u.parcels[b.parcel].block === i);
      const coverage = huts.reduce((sum, h) => sum + area(h.poly), 0) / area(poly);
      expect(coverage).toBeGreaterThanOrEqual(0.5); expect(coverage).toBeLessThanOrEqual(0.7);
      const eligible = differenceSafeS([{ outer: poly, holes: [] }], protectedLand);
      expect(mpArea(eligible)).toBeGreaterThan(0);
      expect(mpArea(differenceSafeS(eligible, ground))).toBeLessThan(0.01);
      expect(mpArea(intersectionS(ground, protectedLand))).toBeLessThan(0.01);
      const occupied = new Set<number>();
      for (const hut of huts) {
        expect(hut.parcel).toBeDefined(); expect(occupied.has(hut.parcel!)).toBe(false); occupied.add(hut.parcel!);
        const cell = u.parcels[hut.parcel!], o = obb(hut.poly);
        expect(cell.use).toBe('hut-lot'); expect(polyInside(cell.poly, hut.poly)).toBe(true);
        expect(2 * o.hv).toBeGreaterThanOrEqual(4.5 - 1e-6); expect(o.hu / o.hv).toBeLessThanOrEqual(3 + 1e-6);
        expect(area(hut.poly)).toBeGreaterThanOrEqual(15 - 1e-6); expect(area(hut.poly)).toBeLessThanOrEqual(40.5);
      }
    }
    // Exact six-seed counts continue to live in urban.densityhealth.test.ts. New constants must be established
    // only after the grouped source review; the independent 53-cell producer controls above remain unchanged.
  }, 120000);

  for (const [seed, shantytowns] of [['1', 'auto'], ['2', 'auto'], ['2', 'some'], ['3', 'auto'], ['3', 'some'],
    ['4', 'auto'], ['5', 'auto'], ['6', 'auto']] as const)
    it(`city seed ${seed}/${shantytowns}: viable requested shanty programme retains occupied lots and strict density`, () => {
      const w = generate(makeOptions({ seed, size: 'city', shantytowns })), u = w.urban!;
      const blocks = u.blocks.map((poly, bi) => ({ poly, bi })).filter(({ bi }) => u.blockInfo[bi].kind === 'shanty');
      expect(blocks.length, 'cluster fragmentation must not discard the viable requested programme').toBeGreaterThan(0);
      expect(u.sites?.some((s) => s.kind === 'shanty')).toBe(true);
      for (const { poly, bi } of blocks) {
        const huts = u.buildings.filter((h) => h.kind === 'hut' && h.parcel !== undefined && u.parcels[h.parcel].block === bi);
        expect(huts.length).toBeGreaterThan(0);
        const coverage = huts.reduce((sum, h) => sum + area(h.poly), 0) / area(poly);
        expect(coverage, `seed ${seed} block ${bi} retains the configured resident coverage`).toBeGreaterThanOrEqual(0.5);
        expect(coverage).toBeLessThanOrEqual(0.7);
        for (const h of huts) {
          const o = obb(h.poly);
          expect(polyInside(u.parcels[h.parcel!].poly, h.poly)).toBe(true);
          expect(2 * o.hv).toBeGreaterThanOrEqual(4.5 - 1e-6);
          expect(o.hu / o.hv).toBeLessThanOrEqual(3 + 1e-6);
          expect(area(h.poly)).toBeGreaterThanOrEqual(15 - 1e-6);
          expect(area(h.poly)).toBeLessThanOrEqual(40.5);
        }
      }
    }, 120000);
});
