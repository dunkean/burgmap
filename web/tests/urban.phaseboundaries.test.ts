import { describe, it, expect } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { difference, intersection, mpArea } from '../src/gen/geo/bool';
import { bboxOf } from '../src/gen/geo/poly';
import { GridIndex } from '../src/gen/geo/spatial';

describe('urban phase boundaries', () => {
  it('keeps earlier riverbank districts enclosed, outside the faubourgs (p4uefz)', () => {
    const w = generate(makeOptions({ seed: 'p4uefz', size: 'city', culture: 'european-organic' }));
    const u = w.urban!;
    for (let i = 1; i < u.phases.length; i++) {
      expect(mpArea(difference(u.phases[i - 1].region, u.phases[i].region)),
        `phase ${i + 1} must retain the older districts`).toBeLessThanOrEqual(0.05);
    }
    const index = new GridIndex<number>(40);
    u.quarters.forEach((q, i) => index.insertPts(q.poly.outer, i));
    u.quarters.forEach((q, i) => {
      const bb = bboxOf(q.poly.outer);
      for (const j of index.query(bb.x0, bb.y0, bb.x1, bb.y1)) {
        if (j <= i) continue;
        expect(mpArea(intersection(q.poly, u.quarters[j].poly)),
          `quarters ${i}/${j} (${q.zone}/${u.quarters[j].zone}) must be disjoint`).toBeLessThanOrEqual(0.05);
      }
    });
    const buildings = new GridIndex<number>(40);
    u.buildings.forEach((b, i) => buildings.insertPts(b.poly, i));
    u.buildings.forEach((b, i) => {
      if (b.parcel === undefined) return;
      const block = u.parcels[b.parcel].block;
      const bb = bboxOf(b.poly);
      for (const j of buildings.query(bb.x0, bb.y0, bb.x1, bb.y1)) {
        const c = u.buildings[j];
        if (j <= i || c.parcel === undefined || u.parcels[c.parcel].block === block) continue;
        expect(mpArea(intersection(b.poly, c.poly)),
          `buildings ${i}/${j} in separate blocks must be disjoint`).toBeLessThanOrEqual(0.05);
      }
    });
  });
});
