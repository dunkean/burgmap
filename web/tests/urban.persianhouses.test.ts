import { describe, expect, it, vi } from 'vitest';
import { chamferPersianHouse } from '../src/gen/urban/persianhouse';
import { MAX_ASPECT, MIN_BW, shapeOf } from '../src/gen/urban/buildings';
import { blockReach, carvePassage, makeStreetAt } from '../src/gen/urban/access';
import { area, interiorAngle, isSimple } from '../src/gen/geo/poly';
import { mpArea, tryDifference } from '../src/gen/geo/bool';
import * as booleanOps from '../src/gen/geo/bool';
import { expectInvariants, generateCase } from './cultureCases';
import { PERSIAN_ACUTE_HOUSES } from './fixtures/persian-acute-houses';
import { PERSIAN_PASSAGE } from './fixtures/persian-passage';

const minAngle = (p: Parameters<typeof area>[0]) => Math.min(...p.map((_, i) => interiorAngle(p, i))) * 180 / Math.PI;

describe('Persian courtyard roof corners', () => {
  it.each(PERSIAN_ACUTE_HOUSES)('bevels real acute house $index without losing its roof or growing into its patio', ({ building, parcel }) => {
    const before = JSON.stringify(building), poly = building.poly;
    expect(minAngle(poly)).toBeLessThan(12);
    const result = chamferPersianHouse(poly);
    expect(JSON.stringify(building)).toBe(before);
    expect(result).not.toBe(poly);
    expect(isSimple(result)).toBe(true);
    expect(minAngle(result)).toBeGreaterThanOrEqual(12);
    expect(area(result)).toBeGreaterThan(0.999 * area(poly));
    expect(area(poly) - area(result)).toBeLessThanOrEqual(0.125 * Math.sin(12 * Math.PI / 180) + 1e-6);
    for (const container of [poly, parcel.poly]) {
      const outside = tryDifference(result, container);
      expect(outside.failed).toBe(false);
      expect(mpArea(outside.pieces)).toBeLessThanOrEqual(1e-6);
    }
    const shape = shapeOf(result);
    expect(shape.w).toBeGreaterThanOrEqual(MIN_BW);
    expect(shape.asp).toBeLessThanOrEqual(MAX_ASPECT);
    expect(chamferPersianHouse(poly)).toEqual(result);
    expect(chamferPersianHouse(result)).toBe(result);
  });

  it('keeps healthy footprints verbatim', () => {
    const healthy = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 12 }, { x: 0, y: 12 }];
    expect(chamferPersianHouse(healthy)).toBe(healthy);
  });

  it('finishes a real corner created by a later access passage, preserving all three resulting roofs', () => {
    const f = structuredClone(PERSIAN_PASSAGE);
    for (const b of f.before) expect(minAngle(b.poly)).toBeGreaterThanOrEqual(12);
    const cut = carvePassage(f.plot, f.before, f.side, f.width, f.depth);
    expect(cut).toHaveLength(3);
    expect(cut[0].poly).toEqual(PERSIAN_ACUTE_HOUSES.find((h) => h.index === 105)!.building.poly);
    expect(minAngle(cut[0].poly)).toBeLessThan(12);
    const finished = cut.map((b) => ({ ...b, poly: chamferPersianHouse(b.poly) }));
    expect(finished).toHaveLength(cut.length);
    finished.forEach((b, i) => {
      expect({ ...b, poly: undefined }).toEqual({ ...cut[i], poly: undefined });
      expect(minAngle(b.poly)).toBeGreaterThanOrEqual(12);
      expect(isSimple(b.poly)).toBe(true);
      const outside = tryDifference(b.poly, cut[i].poly);
      expect(outside.failed).toBe(false);
      expect(mpArea(outside.pieces)).toBeLessThanOrEqual(1e-6);
      expect(area(b.poly)).toBeGreaterThan(0.999 * area(cut[i].poly));
    });
  });

  it('keeps the complete old house when the containment proof fails', () => {
    const proof = vi.spyOn(booleanOps, 'tryDifference').mockReturnValue({ failed: true, pieces: [] });
    try {
      const poly = PERSIAN_ACUTE_HOUSES[0].building.poly;
      expect(chamferPersianHouse(poly)).toBe(poly);
      expect(proof).toHaveBeenCalled();
    } finally { proof.mockRestore(); }
  });

  it('retains every house, lot, courtyard and street access in the actual seed2 village', () => {
    const w = generateCase({ label: 'persian', culture: 'persian' }, 'village', '2'), u = w.urban!;
    expect(u.buildings).toHaveLength(277);
    expect(u.parcels).toHaveLength(250);
    expectInvariants(w); // original angle, width, partition and containment budgets unchanged
    for (const f of PERSIAN_ACUTE_HOUSES) {
      const b = u.buildings[f.index];
      expect({ ...b, poly: undefined }).toEqual({ ...f.building, poly: undefined });
      expect(u.parcels[b.parcel!]).toEqual(f.parcel);
      expect(minAngle(b.poly)).toBeGreaterThanOrEqual(12);
      expect(area(b.poly)).toBeGreaterThan(0.999 * area(f.building.poly));
    }
    const streetAt = makeStreetAt(u.streets, u.parcels.filter((p) => ['place', 'market', 'quay', 'green'].includes(p.use)).map((p) => p.poly));
    for (const block of new Set(PERSIAN_ACUTE_HOUSES.map((f) => f.parcel.block))) {
      const houses = u.buildings.filter((b) => b.parcel !== undefined && u.parcels[b.parcel].block === block);
      expect(blockReach(u.blocks[block], houses.map((b) => b.poly), streetAt), `block ${block} access`).toEqual(houses.map(() => true));
    }
  }, 120000);
});
