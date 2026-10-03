import { describe, it, expect } from 'vitest';
import type { Polygon } from '../src/gen/core/geom';
import type { UrbanStreet } from '../src/gen/types';
import { differenceS, intersectionS, mpArea, unionMany } from '../src/gen/geo/bool';
import { disk, ribbon } from '../src/gen/geo/offset';
import { servedFootprint } from '../src/gen/urban/footprint';
import { makeOptions } from '../src/gen/options';
import { generate } from '../src/gen/pipeline';
import { checkWorld } from './urbanCheck';

const rect = (x: number, y: number, w: number, h: number): Polygon =>
  [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

describe('served urban footprint', () => {
  it('releases abandoned land while keeping complete quarters, roads and curtain strips', () => {
    const planned = [{ outer: rect(0, 0, 200, 200), holes: [] }];
    const quarters = [{ outer: rect(0, 0, 100, 200), holes: [rect(30, 30, 20, 20)] }];
    const street: UrbanStreet = { path: [{ x: -100, y: 100 }, { x: 300, y: 100 }], widths: [8, 12], width: 10, kind: 'main', rank: 0, role: 'radial', phase: 1 };
    const wall = rect(0, 0, 200, 200);
    const result = servedFootprint(planned, quarters, [street], [wall]);
    expect(mpArea(result)).toBeLessThan(25000);
    expect(mpArea(differenceS(quarters, result))).toBeLessThan(0.05);
    const road = intersectionS(planned, ribbon(street.path, street.widths!));
    expect(mpArea(differenceS(road, result))).toBeLessThan(0.05);
    const curtain = intersectionS(planned, unionMany(wall.flatMap((p, i) =>
      [ribbon([p, wall[(i + 1) % wall.length]], 5.6), disk(p, 2.8)])));
    expect(mpArea(differenceS(curtain, result))).toBeLessThan(0.05);
    expect(mpArea(differenceS(result, planned))).toBeLessThan(0.05);
    expect(servedFootprint(planned, quarters, [street], [wall])).toEqual(result);
  });

  it('leaves small junction remnants and fully served legacy outlines unchanged', () => {
    const planned = [{ outer: rect(0, 0, 100, 100), holes: [] }];
    expect(servedFootprint(planned, [{ outer: rect(0, 0, 95, 100), holes: [] }], [], [])).toBe(planned);
    expect(servedFootprint(planned, planned, [], [])).toBe(planned);
  });

  it('keeps bent variable-width streets and closed circuits without reserving their entire interior', () => {
    const planned = [{ outer: rect(0, 0, 400, 400), holes: [] }];
    const quarters = [{ outer: rect(0, 0, 80, 400), holes: [] }];
    const bent: UrbanStreet = { path: [{ x: 50, y: 50 }, { x: 180, y: 100 }, { x: 210, y: 50 }, { x: 380, y: 110 }],
      widths: [8, 12, 9, 14], width: 11, kind: 'main', rank: 0, role: 'radial', phase: 1 };
    const ring = rect(110, 160, 250, 190);
    const loop: UrbanStreet = { ...bent, path: [...ring, ring[0]], widths: undefined, width: 10, role: 'ring' };
    const result = servedFootprint(planned, quarters, [bent, loop], []);
    expect(mpArea(differenceS(ribbon(bent.path, bent.widths!), result))).toBeLessThan(0.05);
    for (let i = 0; i < ring.length; i++) {
      expect(mpArea(differenceS(ribbon([ring[i], ring[(i + 1) % ring.length]], 10), result))).toBeLessThan(0.05);
    }
    expect(mpArea(intersectionS(result, rect(160, 210, 150, 90)))).toBeLessThan(0.05);
  });

  it('restores land use on the unbuilt p4uefz Japanese district without losing urban geometry', () => {
    const w = generate(makeOptions({ seed: 'p4uefz', size: 'city', culture: 'japanese-jokamachi', settlements: 'none' }));
    const u = w.urban!;
    // The old coarse outline reserved 139,847 m² here although no quarter was built.
    const released = rect(2320, 2340, 260, 200);
    expect(mpArea(intersectionS(u.footprintH, released))).toBeLessThan(500);
    const rural = unionMany(w.landuse!.areas.map((a) => ({ outer: a.poly, holes: a.holes ?? [] })));
    expect(mpArea(intersectionS(rural, released))).toBeGreaterThan(30000);
    for (const q of u.quarters) expect(mpArea(differenceS(q.poly, u.footprintH))).toBeLessThan(0.1);
    const r = checkWorld(w), msg = r.details.slice(0, 8).join('\n');
    expect(r.blockAreaErr, msg).toBeLessThanOrEqual(0.005);
    expect(r.overlapsPlots, msg).toBe(0);
    expect(r.noFrontage, msg).toBe(0);
    expect(r.bldgOutside, msg).toBe(0);
  }, 120000);
});
