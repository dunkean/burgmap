import { describe, it, expect } from 'vitest';
import type { UrbanCtx } from '../src/gen/urban/context';
import { shoreTerrain, stiltGround, rootedWalk, finishShoreLots, shoreBlockLots } from '../src/gen/urban/camps/stiltterrain';
import { goodShape } from '../src/gen/urban/camps/kit';
import { area } from '../src/gen/geo/poly';
import { ribbon } from '../src/gen/geo/offset';
import { intersectionS, mpArea, unionMany } from '../src/gen/geo/bool';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { makeCtx } from '../src/gen/urban/context';
import { MORPHOLOGIES } from '../src/gen/urban/morphology';
import '../src/gen/urban/cultures';
import { checkWorld } from './urbanCheck';

const box = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
function context(river = false): UrbanCtx {
  return { mapSize: 2000, win: { x0: 0, y0: 0, x1: 2000, y1: 2000 }, water: [{ outer: box(1000, 0, river ? 1060 : 1700, 2000), holes: [] }],
    slopeAt: (p: { x: number; y: number }) => p.x < 950 ? 0.18 : 0.01,
    terrain: { rivers: river ? [{ path: [{ x: 1030, y: 0 }, { x: 1030, y: 2000 }], width: [60, 60] }] : [] } } as unknown as UrbanCtx;
}

describe('terrain-adapted stilt towns', () => {
  it('leaves a point-connected bank corner open without losing the served remainder', () => {
    const block = [[0, 0], [30, 0], [30, 20], [32, 21], [32, 23], [31, 23], [30, 20], [0, 20]]
      .map(([x, y]) => ({ x, y }));
    const cells = [{ tag: 0, poly: box(0, 0, 30, 30) }, { tag: 1, poly: box(30, 0, 40, 30) }];
    const result = shoreBlockLots(block, cells, (p) => p.every((q) => q.x <= 30.001) ? 10 : 0);
    expect(result).toHaveLength(1);
    expect(area(result[0].poly)).toBeCloseTo(600, 2);
    expect(result[0].lots.reduce((sum, p) => sum + area(p.poly), 0)).toBeCloseTo(600, 2);
    expect(mpArea(intersectionS(result[0].poly, box(0, 0, 30, 20)))).toBeCloseTo(600, 2);
  });

  it('ends a boardwalk at its true safe limit rather than the last coarse sample', () => {
    const root = { x: 5, y: 10 };
    const walk = rootedWalk([root, { x: 30, y: 10 }], root, 2.2, [box(0, 0, 20, 20)],
      (p) => p.x <= 17.25 && p.y >= 0 && p.y <= 20)!;
    expect(walk).not.toBeNull();
    expect(walk[walk.length - 1].x).toBeGreaterThan(17.24);
    expect(walk[walk.length - 1].x).toBeLessThanOrEqual(17.25);
  });

  it('repairs cell needles around a public hole without filling its boardwalk space', () => {
    const points = (p: number[][]) => p.map(([x, y]) => ({ x, y }));
    const lots = [
      { tag: 0, poly: points([[0, 0], [15, 0], [15, 3], [20, 5], [15, 4], [15, 10], [10, 10], [10, 20], [15, 20], [15, 30], [0, 30]]) },
      { tag: 1, poly: points([[15, 0], [30, 0], [30, 30], [15, 30], [15, 20], [20, 20], [20, 10], [15, 10], [15, 4], [20, 5], [15, 3]]) },
    ];
    expect(lots.some((p) => !goodShape(p.poly))).toBe(true);
    const result = finishShoreLots(lots);
    expect(result.every((p) => goodShape(p.poly))).toBe(true);
    expect(result.reduce((sum, p) => sum + area(p.poly), 0)).toBeCloseTo(800, 2);
    expect(mpArea(intersectionS(unionMany(result.map((p) => p.poly), 16, true), box(10, 10, 20, 20)))).toBeLessThan(0.02);
    expect(finishShoreLots(lots)).toEqual(result);
  });

  it('does not turn clipped water edges into shores or build beyond reliable coverage', () => {
    const ctx = context();
    ctx.win = { x0: 900, y0: 900, x1: 1100, y1: 1100 };
    ctx.water = [{ outer: box(880, 880, 1120, 1120), holes: [] }];
    const h = shoreTerrain(ctx);
    expect(h.anchor({ x: 1000, y: 1000 })).toBeNull();
    expect(h.suitable({ x: 1150, y: 1000 })).toBe(false);
    expect(h.suitable({ x: 1099, y: 1000 })).toBe(false);
  });

  it('tries another bank after rejecting the nearer steep shore', () => {
    const ctx = context();
    ctx.water = [{ outer: box(1000, 0, 1060, 2000), holes: [] }];
    ctx.slopeAt = (p) => p.x < 1000 ? 0.25 : 0.01;
    const h = shoreTerrain(ctx), anchor = h.anchor({ x: 1010, y: 1000 });
    expect(anchor).not.toBeNull();
    expect(anchor!.shore.x).toBeCloseTo(1060, 0);
    expect(anchor!.center.x).toBeGreaterThan(1060);
    expect(h.suitable(anchor!.center)).toBe(true);
  });

  it('finds the same shore from land and water instead of cancelling opposite-bank directions', () => {
    const h = shoreTerrain(context());
    for (const p of [{ x: 980, y: 1000 }, { x: 1020, y: 1000 }]) {
      const anchor = h.anchor(p)!;
      expect(anchor).not.toBeNull();
      expect(anchor.shore.x).toBeCloseTo(1000, 0);
      expect(Math.cos(anchor.angle)).toBeGreaterThan(0.9);
    }
  });

  it('grows a shore partition outside steep banks and deep open water', () => {
    const ctx = context(), h = shoreTerrain(ctx);
    const q = stiltGround(h, { x: 994, y: 1000 }, 90, 80, 0, () => 0);
    expect(q.length).toBeGreaterThan(0);
    expect(mpArea(intersectionS(unionMany(q, 16, true), box(1014, 0, 1700, 2000)))).toBeLessThan(0.05);
    expect(mpArea(intersectionS(unionMany(q, 16, true), box(0, 0, 948, 2000)))).toBeLessThan(0.05);
    expect(mpArea(intersectionS(unionMany(q, 16, true), ctx.water))).toBeGreaterThan(10);
    expect(stiltGround(h, { x: 994, y: 1000 }, 90, 80, 0, () => 0)).toEqual(q);
  });

  it('keeps navigation channels open and clips disconnected boardwalk continuations', () => {
    const h = shoreTerrain(context(true)), c = { x: 994, y: 1000 };
    const q = stiltGround(h, c, 90, 80, 0, () => 0);
    expect(mpArea(intersectionS(unionMany(q, 16, true), h.navigation))).toBeLessThan(0.05);
    const walk = rootedWalk([{ x: 990, y: 1000 }, { x: 1050, y: 1000 }, { x: 1050, y: 1050 }, { x: 990, y: 1050 }],
      { x: 990, y: 1000 }, 2.2, q, h.suitable)!;
    expect(walk).not.toBeNull();
    expect(walk[walk.length - 1].x).toBeLessThan(1014);
    expect(walk[walk.length - 1].y).toBe(1000);
    expect(mpArea(intersectionS(ribbon(walk, 2.2), h.navigation))).toBeLessThan(0.05);
  });

  it('protects p4uefz rivers, building lots and connected boardwalks', () => {
    const w = generate(makeOptions({ seed: 'p4uefz', size: 'town', culture: 'stilt-town', settlements: 'none' }));
    const ctx = makeCtx(w, MORPHOLOGIES['stilt-town'], 1500), h = shoreTerrain(ctx), u = w.urban!;
    expect(u.buildings.length).toBeGreaterThan(80);
    const council = u.sites!.find((s) => s.kind === 'council-platform');
    expect(council).toBeDefined();
    expect(area(council!.lot)).toBeLessThanOrEqual(700);
    const roofs = unionMany(u.buildings.map((b) => b.poly), 16, true);
    expect(mpArea(intersectionS(roofs, h.navigation))).toBeLessThan(0.05);
    const landing = u.sites!.find((s) => s.kind === 'landing-stage');
    expect(landing).toBeDefined();
    expect(mpArea(intersectionS(landing!.lot, roofs))).toBeLessThan(0.05);
    const walks = unionMany(u.streets.map((s) => ribbon(s.path, s.widths ?? s.width)), 16, true);
    expect(mpArea(intersectionS(walks, h.navigation))).toBeLessThan(0.05);
    for (const b of u.buildings) for (const p of b.poly) expect(ctx.slopeAt(p)).toBeLessThanOrEqual(0.125);
    const main = u.streets.find((s) => s.role === 'radial')!;
    const nearMain = (p: { x: number; y: number }) => main.path.slice(1).some((b, i) => {
      const a = main.path[i], dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) < 0.1;
    });
    for (const s of u.streets.filter((s) => s.role === 'street')) expect(nearMain(s.path[0])).toBe(true);
    const r = checkWorld(w), msg = r.details.slice(0, 8).join('\n');
    expect(r.blockAreaErr, msg).toBeLessThanOrEqual(0.005);
    expect(r.overlapsPlots, msg).toBe(0);
    expect(r.noFrontage, msg).toBe(0);
    expect(r.bldgOutside, msg).toBe(0);
  }, 120000);
});
