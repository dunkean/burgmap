import { describe, expect, it } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { area, obb } from '../src/gen/geo/poly';
import { polyInside } from '../src/gen/geo/split';
import { unreachableBuildings } from './accessCheck';

describe('native longhouses on merged street frontages', () => {
  it('keeps both rounded ends when a renewed frontage runs across several boundary edges', () => {
    const w = generate(makeOptions({ seed: '2', size: 'town', culture: 'native-iroquoian' }));
    const u = w.urban!;
    // This seeded merged faubourg lot selected its frontage as both side lines.
    // Access then cut one apsidal end: 60.922 m2 / 12.230 m became 55.975 m2 / 10.824 m.
    const house = u.buildings.find((b) => b.parcel === 824 && b.arch === 'longhouse')!;
    expect(house).toBeDefined();
    expect(house.poly).toHaveLength(12);
    expect(area(house.poly)).toBeCloseTo(60.9220479692, 6);
    expect(2 * obb(house.poly).hu).toBeCloseTo(12.2298069990, 6);
    expect(polyInside(u.parcels[house.parcel!].poly, house.poly)).toBe(true);
    expect(unreachableBuildings(w).n).toBe(0);
  });
});
