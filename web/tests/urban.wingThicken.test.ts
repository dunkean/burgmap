import { describe, expect, it } from 'vitest';
import type { Polygon } from '../src/gen/types';
import fixture from './fixtures/urban-wing-v11.json';
import { area, inscribed, isSimple, minNeck, obb } from '../src/gen/geo/poly';
import { mpArea, tryDifference, tryIntersection } from '../src/gen/geo/bool';
import { thickenNarrowWing } from '../src/gen/urban/wingThicken';
import { bboxOf } from '../src/gen/geo/poly';
import native from './fixtures/compact-pins-v11.json';

describe('same-owner narrow wing thickening', () => {
  const poly = fixture.poly as Polygon, owner = fixture.owner as Polygon;

  it('retains every original roof byte while making the xrv97g wing habitable', () => {
    const before = JSON.stringify([poly, owner]);
    const roof = thickenNarrowWing(poly, owner, [], () => true);
    expect(roof).not.toBeNull();
    expect(thickenNarrowWing(poly, owner, [], () => true)).toEqual(roof);
    expect(JSON.stringify([poly, owner])).toBe(before);
    const added = tryDifference(roof!, poly), lost = tryDifference(poly, roof!);
    expect(added.failed || lost.failed).toBe(false);
    expect(mpArea(lost.pieces)).toBeLessThan(1e-6);
    expect(mpArea(added.pieces)).toBeGreaterThan(0);
    expect(mpArea(added.pieces)).toBeLessThanOrEqual(0.1 * area(poly));
    expect(mpArea(tryDifference(added.pieces, owner).pieces)).toBeLessThan(1e-6);
    expect(Math.abs(area(roof!) - area(poly) - mpArea(added.pieces))).toBeLessThan(1e-5);
    expect(isSimple(roof!)).toBe(true);
    expect(minNeck(roof!)?.w ?? Infinity).toBeGreaterThanOrEqual(3.59);
    expect(2 * inscribed(roof!, [], 0.05).r).toBeGreaterThanOrEqual(3.6);
    const box = obb(roof!);
    expect(2 * box.hv).toBeGreaterThanOrEqual(4.45);
    expect(box.hu / box.hv).toBeLessThanOrEqual(3);
  });

  it('rejects a neighbour occupying the proposed owner land and honours the access validator', () => {
    expect(thickenNarrowWing(poly, owner, [owner], () => true)).toBeNull();
    const far: Polygon = [{ x: -100, y: -100 }, { x: -90, y: -100 },
      { x: -90, y: -90 }, { x: -100, y: -90 }];
    expect(thickenNarrowWing(poly, owner, [far, owner], () => true)).toBeNull();
    expect(thickenNarrowWing(poly, owner, [], () => false)).toBeNull();
    const roof = thickenNarrowWing(poly, owner, [], candidate => {
      const added = tryDifference(candidate, poly);
      return !added.failed && mpArea(tryIntersection(added.pieces, owner).pieces) > 0;
    });
    expect(roof).not.toBeNull();
  });

  it('rejects inward roof claims yet finds a whole-wing candidate in a bounded exterior domain', () => {
    const f = native.cases.find(c => c.i === 736)!;
    expect(thickenNarrowWing(f.roof, f.owner, f.occupied, () => true)).toBeNull();
    const b = bboxOf(f.owner), margin = 16;
    const exterior: Polygon = [{ x: b.x0 - margin, y: b.y0 - margin },
      { x: b.x1 + margin, y: b.y0 - margin }, { x: b.x1 + margin, y: b.y1 + margin },
      { x: b.x0 - margin, y: b.y1 + margin }];
    const grown = thickenNarrowWing(f.roof, exterior, f.occupied, () => true);
    expect(grown).not.toBeNull();
    const added = tryDifference(grown!, f.roof);
    expect(mpArea(added.pieces)).toBeGreaterThan(0);
    expect(mpArea(tryDifference(added.pieces, f.owner).pieces)).toBeGreaterThan(20);
    for (const peer of f.occupied) {
      expect(mpArea(tryIntersection(added.pieces, peer).pieces)).toBeLessThanOrEqual(1e-6);
    }
  });
});
