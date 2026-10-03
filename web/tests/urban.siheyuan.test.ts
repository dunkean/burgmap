import { describe, it, expect } from 'vitest';
import { Rng } from '../src/gen/core/rng';
import { area } from '../src/gen/geo/poly';
import { differenceS, mpArea } from '../src/gen/geo/bool';
import { buildOn } from '../src/gen/urban/bops';
import type { Plot } from '../src/gen/urban/plots';
import { MORPHOLOGIES } from '../src/gen/urban/morphology';
import '../src/gen/urban/cultures';
import { makeOptions } from '../src/gen/options';
import { generate } from '../src/gen/pipeline';
import { checkWorld } from './urbanCheck';

describe('siheyuan on irregular hutong lots', () => {
  it('keeps the compound on the connected section of its frontage', () => {
    const front: Plot['front'] = [{ x: 0, y: 0 }, { x: 20, y: 0 }], nrm = { x: 0, y: 1 };
    // The far lobe has no frontage. A global cross-section envelope mistakenly spans the notch.
    const pl: Plot = { poly: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 80, y: 10 },
      { x: 80, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 70 }, { x: 0, y: 70 }], front, nrm,
      block: 0, zone: 'core', sideA: { p: front[0], d: nrm }, sideB: { p: front[1], d: nrm },
      sideFronts: [], rank: 4, depth: 70, wide: false, run: 0, order: 0 };
    const halls = buildOn(pl, 0.55, MORPHOLOGIES.chinese, new Rng('notched'));
    expect(halls.length).toBeGreaterThan(3);
    expect(halls.some((b) => b.arch === 'siheyuan-main-hall')).toBe(true);
    for (const b of halls) {
      expect(mpArea(differenceS(b.poly, pl.poly))).toBeLessThan(0.05);
      expect(Math.max(...b.poly.map((p) => p.x))).toBeLessThanOrEqual(20.01);
    }
    expect(buildOn(pl, 0.55, MORPHOLOGIES.chinese, new Rng('notched'))).toEqual(halls);
  });

  it('builds a wide shallow frontage as separate room ranges', () => {
    const front: Plot['front'] = [{ x: 0, y: 0 }, { x: 100, y: 0 }], nrm = { x: 0, y: 1 };
    const pl: Plot = { poly: [front[0], front[1], { x: 100, y: 12 }, { x: 0, y: 12 }], front, nrm,
      block: 0, zone: 'core', sideA: { p: front[0], d: nrm }, sideB: { p: front[1], d: nrm },
      sideFronts: [], rank: 2, depth: 12, wide: true, run: 0, order: 0 };
    const halls = buildOn(pl, 0.55, MORPHOLOGIES.chinese, new Rng('shallow'));
    expect(halls.length).toBeGreaterThan(2);
    expect(halls.reduce((sum, b) => sum + area(b.poly), 0)).toBeGreaterThan(700);
    for (const b of halls) expect(mpArea(differenceS(b.poly, pl.poly))).toBeLessThan(0.05);
  });


  it('subdivides oversized compounds without hiding sparse areas in gardens', () => {
    const w = generate(makeOptions({ seed: 'p4uefz', size: 'city', culture: 'chinese', moat: 'no', settlements: 'none' }));
    const u = w.urban!, built = new Set(u.buildings.map((b) => b.parcel));
    const empty = u.parcels.filter((p, i) => p.use === 'plot' && p.zone !== 'faubourg' && !built.has(i));
    expect(Math.max(0, ...empty.map((p) => area(p.poly)))).toBeLessThan(2000);
    expect(empty.reduce((sum, p) => sum + area(p.poly), 0)).toBeLessThan(10000);
    const gardens = u.parcels.filter((p) => p.use === 'garden' && p.zone !== 'faubourg');
    expect(Math.max(0, ...gardens.map((p) => area(p.poly)))).toBeLessThan(6000);
    const builtArea = new Float64Array(u.parcels.length);
    for (const b of u.buildings) if (b.parcel !== undefined) builtArea[b.parcel] += area(b.poly);
    const sparseArea = u.parcels.reduce((sum, p, i) => p.use === 'plot' && p.zone !== 'faubourg' &&
      area(p.poly) > 1000 && builtArea[i] / area(p.poly) < 0.1 ? sum + area(p.poly) : sum, 0);
    const residentialArea = u.parcels.filter((p) => p.use === 'plot' && p.zone !== 'faubourg')
      .reduce((sum, p) => sum + area(p.poly), 0);
    // Before this repair, 163,522 m² of large core plots had <10% roof coverage. Allow occasional
    // river-clipped estates, but keep this defect below 8% of residential ward land (now about 6%).
    expect(sparseArea / residentialArea, 'large residential lots with less than 10% roof coverage').toBeLessThan(0.08);
    const r = checkWorld(w), msg = r.details.slice(0, 8).join('\n');
    expect(r.blockAreaErr, msg).toBeLessThanOrEqual(0.005);
    expect(r.overlapsPlots, msg).toBe(0);
    expect(r.overlapsBuildings, msg).toBeLessThanOrEqual(Math.ceil(r.buildings * 0.0005));
    expect(r.noFrontage, msg).toBe(0);
    expect(r.bldgOutside, msg).toBe(0);
  }, 120000);
});
