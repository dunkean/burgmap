import { describe, it, expect } from 'vitest';
import { selectLod, BUILDING_SCALE, MID_SCALE, PARCEL_SCALE } from '../src/render/lod';

describe('individual buildings LOD', () => {
  it('merged masses at far/mid-low, individual outlines once >= ~0.5px apart, hairlines only near', () => {
    expect(selectLod(MID_SCALE).individual).toBe(false);
    expect(selectLod(BUILDING_SCALE * 0.99).individual).toBe(false);
    expect(selectLod(BUILDING_SCALE).individual).toBe(true);
    // narrowest house ~5 m must be >= 0.5 px wide when outlines appear
    expect(5 * BUILDING_SCALE).toBeGreaterThanOrEqual(0.5);
    expect(selectLod(0.3).parcels).toBe(false);
    expect(selectLod(PARCEL_SCALE).parcels).toBe(true);
  });
});
