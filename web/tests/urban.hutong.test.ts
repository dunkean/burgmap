import { describe, it, expect } from 'vitest';
import { Rng } from '../src/gen/core/rng';
import { dist } from '../src/gen/core/geom';
import { area, pointInRing, distToRing, distToSeg } from '../src/gen/geo/poly';
import { differenceS, mpArea } from '../src/gen/geo/bool';
import { ribbon } from '../src/gen/geo/offset';
import { MORPHOLOGIES } from '../src/gen/urban/morphology';
import '../src/gen/urban/cultures';
import { Streets, LAB_WALL } from '../src/gen/urban/streets';
import type { Piece } from '../src/gen/urban/blocks';
import { culDeSacTree } from '../src/gen/urban/culdesac';
import { makeOptions } from '../src/gen/options';
import { generate } from '../src/gen/pipeline';
import { checkWorld } from './urbanCheck';

function ward() {
  const streets = new Streets();
  const id = streets.add([{ x: 0, y: 0 }, { x: 180, y: 0 }], 8, 2, 'street', 0);
  streets.connected.add(id);
  const pc: Piece = { lp: { pts: [{ x: 0, y: 0 }, { x: 180, y: 0 }, { x: 180, y: 160 }, { x: 0, y: 160 }],
    lab: [id, LAB_WALL, LAB_WALL, LAB_WALL] }, phase: 0, zone: 'core', age: 1, quarter: 0, kind: 'block', level: 2,
    morph: MORPHOLOGIES['chinese'] };
  return { streets, pc };
}

describe('Chinese hutong access', () => {
  it('serves deep ward interiors with connected cardinal lanes', () => {
    const { streets, pc } = ward();
    expect(culDeSacTree([pc], streets, new Rng('hutong'))).toBeGreaterThan(2);
    for (const s of streets.list.slice(1)) {
      expect(streets.connected.has(s.id)).toBe(true);
      const streetEntry = [{ x: -5, y: -5 }, { x: 185, y: -5 }, { x: 185, y: 0 }, { x: -5, y: 0 }];
      expect(mpArea(differenceS(ribbon(s.path, s.widths), pc.lp.pts, streetEntry))).toBeLessThan(0.05);
      for (let i = 1; i < s.path.length; i++) {
        const a = s.path[i - 1], b = s.path[i];
        expect(Math.min(Math.abs(a.x - b.x), Math.abs(a.y - b.y))).toBeLessThan(1e-6);
        for (let j = 0; j <= 20; j++) {
          const p = { x: a.x + (b.x - a.x) * j / 20, y: a.y + (b.y - a.y) * j / 20 };
          if (p.y >= 0) expect(pointInRing(pc.lp.pts, p) || distToRing(pc.lp.pts, p) < 0.01).toBe(true);
          else expect(p.y).toBeGreaterThanOrEqual(-4);
        }
      }
      expect(streets.list.slice(0, s.id).some((p) => p.path.some((a, i) => i > 0 &&
        // A parent crossing may lie along a segment rather than at its endpoints.
        distToSeg(s.path[0], p.path[i - 1], a) < 4))).toBe(true);
    }
  });

  it('is deterministic and does not consume the organic derb random stream', () => {
    const a = ward(), b = ward(), ra = new Rng('same'), rb = new Rng('same');
    culDeSacTree([a.pc], a.streets, ra); culDeSacTree([b.pc], b.streets, rb);
    expect(a.streets.list).toEqual(b.streets.list);
    expect(ra.next()).toBe(new Rng('same').next());
    expect(rb.next()).toBe(new Rng('same').next());
  });

  it('enters short frontage away from corners and serves back land beside a diagonal bank', () => {
    const { streets, pc } = ward();
    pc.lp = { pts: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 180, y: 90 }, { x: 180, y: 160 }, { x: 0, y: 160 }],
      lab: [0, LAB_WALL, LAB_WALL, LAB_WALL, LAB_WALL] };
    streets.list[0].path[1] = { x: 40, y: 0 };
    expect(culDeSacTree([pc], streets, new Rng('clipped'))).toBeGreaterThan(0);
    const entry = [{ x: -5, y: -5 }, { x: 45, y: -5 }, { x: 45, y: 0 }, { x: -5, y: 0 }];
    for (const s of streets.list.slice(1)) expect(mpArea(differenceS(ribbon(s.path, s.widths), pc.lp.pts, entry))).toBeLessThan(0.05);
    expect(streets.list.slice(1).some((s) => s.path.some((p) => p.y > 100))).toBe(true);
  });

  it('keeps reserved compounds intact', () => {
    const { streets, pc } = ward(); pc.compound = 'yamen';
    expect(culDeSacTree([pc], streets, new Rng('reserved'))).toBe(0);
    expect(streets.list).toHaveLength(1);
  });

  it('enters an oblique street normally before turning into the cardinal ward', () => {
    const { streets, pc } = ward(), k = Math.SQRT1_2;
    const rotate = (p: { x: number; y: number }) => ({ x: (p.x - p.y) * k, y: (p.x + p.y) * k });
    pc.lp.pts = pc.lp.pts.map(rotate);
    streets.list[0].path = streets.list[0].path.map(rotate);
    expect(culDeSacTree([pc], streets, new Rng('oblique'))).toBeGreaterThan(1);
    const entry = [{ x: -5, y: -5 }, { x: 185, y: -5 }, { x: 185, y: 0 }, { x: -5, y: 0 }].map(rotate);
    for (const s of streets.list.slice(1)) expect(mpArea(differenceS(ribbon(s.path, s.widths), pc.lp.pts, entry))).toBeLessThan(0.05);
    for (const s of streets.list.slice(1)) for (const p of s.path.slice(1)) {
      expect(pointInRing(pc.lp.pts, p) || distToRing(pc.lp.pts, p) < 0.01).toBe(true);
    }
  });

  it('shrinks giant under-served p4uefz lots while preserving urban geometry', () => {
    const w = generate(makeOptions({ seed: 'p4uefz', size: 'city', culture: 'chinese', moat: 'no', settlements: 'none' }));
    const u = w.urban!, plots = u.parcels.filter((p) => p.use === 'plot');
    // Before hutongs the largest residential plot was 40,274 m² with only 20 m of frontage.
    expect(Math.max(...plots.map((p) => area(p.poly)))).toBeLessThan(20000);
    expect(u.streets.filter((s) => s.role === 'close').length).toBeGreaterThan(10);
    const r = checkWorld(w), msg = r.details.slice(0, 8).join('\n');
    expect(r.blockAreaErr, msg).toBeLessThanOrEqual(0.005);
    expect(r.blockOutside, msg).toBeLessThan(1);
    expect(r.overlapsBlocks, msg).toBe(0);
    expect(r.overlapsPlots, msg).toBe(0);
    expect(r.overlapsBuildings, msg).toBeLessThanOrEqual(Math.ceil(r.buildings * 0.0005));
    expect(r.noFrontage, msg).toBe(0);
    expect(r.bldgOutside, msg).toBe(0);
    expect(r.orphanMain, msg).toBe(0);
    expect(plots.every((p) => !p.front || dist(p.front[0], p.front[1]) >= 3)).toBe(true);
  }, 120000);
});
