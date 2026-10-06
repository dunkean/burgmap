import { describe, expect, it } from 'vitest';
import type { Polygon } from '../src/gen/types';
import { area, minNeck } from '../src/gen/geo/poly';
import { isConvex } from '../src/gen/geo/split';
import { mpArea, tryIntersection } from '../src/gen/geo/bool';
import { reconstructRoom } from '../src/gen/urban/roomReconstruct';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { shapeOkObb } from '../src/gen/urban/access';
import { inscribed } from '../src/gen/geo/poly';

const rect = (x: number, y: number, w: number, h: number): Polygon => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];
const notch: Polygon = [
  { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 6, y: 10 },
  { x: 6, y: 8 }, { x: 4, y: 8 }, { x: 4, y: 10 }, { x: 0, y: 10 },
];

describe('ordinary room reconstruction', () => {
  it('fills a small defective notch without losing area or mutating source geometry', () => {
    const owner = rect(-2, -2, 14, 14), before = JSON.stringify([notch, owner]);
    const validate = (p: Polygon) => isConvex(p, 1e-3) && (minNeck(p)?.w ?? Infinity) >= 3.59;
    const a = reconstructRoom(notch, owner, [], validate);
    const b = reconstructRoom(notch, owner, [], validate);
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
    expect(area(a!)).toBeGreaterThanOrEqual(0.95 * area(notch));
    expect(area(a!)).toBeLessThanOrEqual(1.08 * area(notch));
    expect(JSON.stringify([notch, owner])).toBe(before);
  });

  it('rejects newly occupied neighbour land and a physical obstacle, returning null when no safe room exists', () => {
    const owner = rect(0, 0, 10, 10), obstacle = rect(4, 8, 2, 2);
    const validate = (p: Polygon) => isConvex(p, 1e-3);
    const room = reconstructRoom(notch, owner, [obstacle], [obstacle], validate);
    expect(room).toBeNull();
    expect(reconstructRoom(notch, owner, [], () => false, validate)).toBeNull();
  });

  it('uses an oriented local room only when the shape and access validator accepts it', () => {
    const owner = rect(-20, -20, 40, 40);
    const triangle: Polygon = [{ x: -8, y: -5 }, { x: 8, y: 3 }, { x: -2, y: 9 }];
    const room = reconstructRoom(triangle, owner, [], (p) => p.length === 4 && isConvex(p, 1e-3));
    expect(room).not.toBeNull();
    expect(room).toHaveLength(4);
    expect(area(room!)).toBeCloseTo(area(triangle), 5);
    const e0 = { x: room![1].x - room![0].x, y: room![1].y - room![0].y };
    const e1 = { x: room![2].x - room![1].x, y: room![2].y - room![1].y };
    expect(Math.abs(e0.x * e1.x + e0.y * e1.y)).toBeLessThan(1e-6);
    expect(mpArea(tryIntersection(room!, rect(16, 16, 3, 3)).pieces)).toBe(0);
  });

  it('audits actual invalid ordinary rooms from seeded wizard town without admitting unsafe repairs', () => {
    const urban = generate(makeOptions({ seed: '4', size: 'town', culture: 'wizard-city', walls: 'none', settlements: 'none' })).urban!;
    const proper = (p: Polygon) => p.length >= 3 && area(p) >= 12 && shapeOkObb(p)
      && 2 * inscribed(p, [], 0.05, 1.8).r >= 3.6 && (minNeck(p)?.w ?? Infinity) >= 3.59;
    let invalid = 0, repaired = 0;
    for (const building of urban.buildings) {
      if (building.kind !== 'house' || building.courtyards?.length || building.parcel == null) continue;
      const owner = urban.parcels[building.parcel]?.poly;
      if (!owner || proper(building.poly)) continue;
      invalid++;
      const room = reconstructRoom(building.poly, owner, [], proper);
      if (room) {
        repaired++;
        expect(proper(room)).toBe(true);
        expect(area(room)).toBeGreaterThanOrEqual(0.95 * area(building.poly) - 1e-6);
        expect(area(room)).toBeLessThanOrEqual(1.08 * area(building.poly) + 1e-6);
      }
    }
    expect(invalid).toBeGreaterThan(0);
    expect(repaired).toBeGreaterThan(0);
  }, 120_000);
});
