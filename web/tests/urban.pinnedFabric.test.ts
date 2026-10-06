import { describe, expect, it } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { fromQuery } from '../src/gen/options';
import { area, minNeck } from '../src/gen/geo/poly';
import { auditUrban } from '../src/gen/urban/geometryAudit';
import { unreachableBuildings } from './accessCheck';
import { checkWorld } from './urbanCheck';

// Both user pin lists reproduce this same native map. Keep its compact options
// rather than replacing the curved quarter boundaries with a synthetic rectangle.
const query = 'id=1zvAFj4K0oKrM0T2dSYrHg5M4uSkzM4eI0AiYabicJBmnB4sS84uyizBJFTkNTAwOVILWpTNHRIGlg0sdIeOD0YmpuoWNibKATDUrdeVBBigklRWDSUVQCZo-QxLzEMmDiVoqNBQA';

describe('the two pinned curved town regressions', () => {
  it('keeps served, disjoint roofs and a real private entrance on the native town', () => {
    const world = generate(fromQuery(query)), urban = world.urban!;
    const audit = auditUrban(world);
    expect(audit.malformed).toEqual([]);
    expect(audit.failed).toBe(0);
    expect(audit.overlaps.filter(p => p.kind === 'building' && p.thickness > 0.05)).toEqual([]);
    expect(unreachableBuildings(world).n).toBe(0);
    const partitions = checkWorld(world);
    expect(partitions.overlapsPlots).toBe(0);
    expect(partitions.bldgOutside).toBe(0);
    expect(partitions.noFrontage).toBe(0);
    expect(partitions.orphanMain).toBe(0);
    const housingArea = urban.buildings.filter(b => ['house', 'rear', 'back'].includes(b.kind))
      .reduce((sum, b) => sum + area(b.poly), 0);
    // Measured with the old producer on this exact query, before the footprint pass.
    expect(housingArea).toBeGreaterThanOrEqual(0.98 * 80502.38129396425);
    const privateWays = urban.streets.filter(s => s.private);
    expect(privateWays.length).toBeGreaterThan(0);
    expect(privateWays.every(s => s.width >= 0.8 && s.kind === 'alley')).toBe(true);
    for (const parcel of [59, 106, 293, 445, 456]) {
      const roofs = urban.buildings.filter(b => b.parcel === parcel && ['house', 'rear', 'back'].includes(b.kind));
      expect(roofs.length, 'a repaired plot still contains its dwelling').toBeGreaterThan(0);
      expect(roofs.every(b => (minNeck(b.poly)?.w ?? Infinity) >= 2), `parcel ${parcel}`).toBe(true);
    }
  });
});
