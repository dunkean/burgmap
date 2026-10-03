import { describe, it, expect, vi } from 'vitest';
import polygonClipping from 'polygon-clipping';
import { Resvg } from '@resvg/resvg-js';
import { makeOptions, fromQuery, toQuery, applyOverride } from '../src/gen/options';
import { generate } from '../src/gen/pipeline';
import { planMoat, offsetCurtain, moatReserve, naturalBank } from '../src/gen/urban/moat';
import type { UrbanCtx } from '../src/gen/urban/context';
import { makeCtx } from '../src/gen/urban/context';
import { MORPHOLOGIES } from '../src/gen/urban/morphology';
import type { WallLine } from '../src/gen/urban/primary';
import type { Polygon } from '../src/gen/core/geom';
import { polygonArea } from '../src/gen/core/geom';
import { difference, differenceSafeS, intersection, mpArea } from '../src/gen/geo/bool';
import { area, pointInRing, bboxOf } from '../src/gen/geo/poly';
import { interiorPoint } from '../src/gen/urban';
import { buildScene } from '../src/render/scene';
import { renderSvg } from '../src/render/svg';
import { createCanvasRenderer, type CanvasLike } from '../src/render/canvas';
import { PALETTES } from '../src/render/styles';
import { fakeWorld, mockCanvas, MockPath2D } from '../scripts/fakeworld';

const rect = (x: number, y: number, w: number, h: number): Polygon =>
  [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const wall: WallLine = { ring: rect(200, 200, 240, 240), gates: [
  { p: { x: 320, y: 200 }, dir: { x: 0, y: 1 }, width: 10, street: 0 },
] };
function fixture(): UrbanCtx {
  const world = fakeWorld({ mapSize: 1000, buildings: 0, streets: 0, clusters: 1 });
  return { world, n: 100, cell: 10, mapSize: 1000, water: [], slopeAt: () => 0,
    site: { fields: { dWater: new Float32Array(10000).fill(100), hab: new Float32Array(10000).fill(2) } },
  } as unknown as UrbanCtx;
}

describe('wet moats', () => {
  it('round-trips controls and keeps old links unchanged', () => {
    for (const moat of ['yes', 'no'] as const) expect(fromQuery(toQuery(makeOptions({ moat }))).moat).toBe(moat);
    expect(fromQuery('moat=bad').moat).toBe('auto');
    expect(fromQuery('seed=42').moat).toBeUndefined();
    expect(toQuery(makeOptions())).not.toContain('moat');
    const o = makeOptions(); applyOverride(o, 'moat', 'bad'); expect(o.moat).toBe('auto');
  });
  it('follows concave curtains instead of their convex hull, with gate causeways', () => {
    const ctx = fixture();
    const concave: WallLine = { ...wall, ring: [{ x: 200, y: 200 }, { x: 440, y: 200 }, { x: 440, y: 290 },
      { x: 300, y: 290 }, { x: 300, y: 440 }, { x: 200, y: 440 }] };
    const water = planMoat(ctx, [concave], [], [], 'yes');
    expect(mpArea(water)).toBeGreaterThan(3000);
    expect(mpArea(intersection(water, concave.ring))).toBeLessThan(0.05);
    expect(mpArea(intersection(water, rect(315, 182, 10, 20)))).toBeLessThan(0.05);
    expect(mpArea(intersection(water, rect(380, 325, 40, 40)))).toBeLessThan(0.05);
    expect(planMoat(ctx, [concave], [], [], 'yes')).toEqual(water);
  });
  it('protects roads, reserved lots and small forbidden terrain pockets', () => {
    const ctx = fixture(), lot = rect(180, 270, 15, 30);
    // A 100 m² steep cell must survive the contour smoother's 1,500 m² hole threshold.
    ctx.slopeAt = (p) => p.x >= 440 && p.x < 450 && p.y >= 300 && p.y < 310 ? 0.4 : 0;
    const road = { path: [{ x: 380, y: 160 }, { x: 380, y: 250 }], widths: [10, 10] };
    const water = planMoat(ctx, [wall], [road], [lot], 'yes');
    expect(mpArea(water)).toBeGreaterThan(1000);
    for (const dry of [lot, rect(375, 170, 10, 40), rect(440, 300, 10, 10)]) {
      expect(mpArea(intersection(water, dry))).toBeLessThan(0.05);
    }
  });
  it('is optional and requires water supply and gentle low ground', () => {
    const ctx = fixture();
    expect(planMoat(ctx, [], [], [], 'yes')).toEqual([]);
    expect(planMoat(ctx, [wall], [], [], 'no', true)).toEqual([]);
    expect(planMoat(ctx, [wall], [], [], 'auto')).toEqual([]);
    ctx.world.options.biome = 'desert';
    expect(planMoat(ctx, [wall], [], [], 'auto', true)).toEqual([]);
    expect(planMoat(ctx, [wall], [], [], 'yes').length).toBeGreaterThan(0);
    ctx.site.fields.hab.fill(50);
    expect(planMoat(ctx, [wall], [], [], 'yes')).toEqual([]);
    ctx.site.fields.hab.fill(2); ctx.site.fields.dWater.fill(2000);
    expect(planMoat(ctx, [wall], [], [], 'yes')).toEqual([]);
  });
  it('puts the ditch outside a double curtain and keeps barbicans dry', () => {
    const outer = offsetCurtain(wall, 18)!;
    expect(outer.gates).toHaveLength(1);
    expect(outer.gates[0].p.y).toBeCloseTo(182, 1);
    const water = planMoat(fixture(), [outer], [], [], 'yes');
    expect(mpArea(intersection(water, outer.ring))).toBeLessThan(0.05);
    expect(mpArea(intersection(water, rect(310.5, 171, 19, 11)))).toBeLessThan(0.05);
  });
  it('contains the ditch on the map and ignores off-map curtains', () => {
    const ctx = fixture();
    const water = planMoat(ctx, [{ ring: rect(2, 2, 240, 240), gates: [] }], [], [], 'yes');
    for (const ph of water) for (const p of ph.outer) { expect(p.x).toBeGreaterThanOrEqual(0); expect(p.y).toBeGreaterThanOrEqual(0); }
    expect(planMoat(ctx, [{ ring: rect(1200, 1200, 240, 240), gates: [] }], [], [], 'yes')).toEqual([]);
  });
  it('preserves water holes in SVG and Canvas scenes', () => {
    const world = fixture().world;
    world.urban!.water = [{ outer: rect(100, 100, 400, 400), holes: [rect(130, 130, 340, 340)] }];
    const scene = buildScene(world), layer = scene.poly.get('u-water')!;
    expect(polygonArea(layer.holes![0]![0])).toBeLessThan(0);
    const svg = renderSvg(world);
    const path = svg.match(/<path class="u-water"[^>]*>/)![0];
    expect(path).toContain('fill-rule="evenodd"'); expect(path.match(/M/g)).toHaveLength(2);
  });
  it('paints overlapping water pieces as water while keeping uncovered islands dry', () => {
    const world = fixture().world;
    world.urban!.water = [{ outer: rect(100, 100, 400, 400), holes: [rect(130, 130, 340, 340)] },
      { outer: rect(110, 150, 140, 100), holes: [] }];
    const paths = renderSvg(world).match(/<path class="u-water"[^>]*>/g)!;
    const rgba = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="white"/>${paths.join('')}</svg>`).render().pixels;
    const pixel = (x: number, y: number) => Array.from(rgba.subarray((y * 600 + x) * 4, (y * 600 + x) * 4 + 3));
    expect(pixel(160, 160)).not.toEqual([255, 255, 255]);
    expect(pixel(120, 160)).not.toEqual([255, 255, 255]);
    expect(pixel(300, 300)).toEqual([255, 255, 255]);
    const mock = mockCanvas(600, 600), ctx = mock.canvas.getContext('2d') as CanvasRenderingContext2D;
    const rules: CanvasFillRule[] = [], fill = ctx.fill;
    ctx.fill = ((path: Path2D, rule: CanvasFillRule) => { if (ctx.fillStyle === PALETTES.parchment.riverFill) rules.push(rule); fill(path, rule); }) as typeof ctx.fill;
    const renderer = createCanvasRenderer(mock.canvas as unknown as CanvasLike, world, 'parchment', { Path2D: MockPath2D as unknown as typeof Path2D });
    renderer.draw({ cx: 300, cy: 300, scale: 1 }); renderer.dispose();
    expect(rules).toContain('nonzero'); expect(rules).not.toContain('evenodd');
  });
  it('reserves the dry berm as well as the ditch, without claiming built-up land', () => {
    const reserve = moatReserve([wall]);
    expect(mpArea(intersection(reserve, rect(195, 270, 5, 30)))).toBeGreaterThan(140);
    expect(mpArea(intersection(reserve, wall.ring))).toBeLessThan(0.05);
    const onNaturalBank = naturalBank([{ outer: rect(10, 10, 50, 50), holes: [] }]);
    expect(onNaturalBank({ x: 10, y: 30 })).toBe(true);
    expect(onNaturalBank({ x: 195, y: 300 })).toBe(false);
  });
  it('drops added water if the clipping engine cannot protect dry land', () => {
    const spy = vi.spyOn(polygonClipping, 'difference').mockImplementation(() => { throw new Error('clipping failure'); });
    try { expect(differenceSafeS(rect(0, 0, 100, 100), rect(10, 10, 40, 40))).toEqual([]); }
    finally { spy.mockRestore(); }
  });
  it('keeps p4uefz buildings and rural reserves separate from the wet ditch', () => {
    const world = generate(makeOptions({ seed: 'p4uefz', size: 'city', culture: 'chinese', walls: 'double', moat: 'yes', settlements: 'none' }));
    const u = world.urban!, wet = u.moats ?? [];
    expect(mpArea(wet)).toBeGreaterThan(1000);
    expect(mpArea(difference(wet, u.ruralReserve ?? []))).toBeLessThan(0.1);
    const dry = [...u.blocks, ...u.buildings.map((b) => b.poly)].map((outer) => ({ outer, holes: [] as Polygon[] }))
      .concat((world.landuse?.areas ?? []).map((a) => ({ outer: a.poly, holes: a.holes ?? [] })));
    const boxes = wet.map((ph) => bboxOf(ph.outer));
    for (const p of dry) {
      const b = bboxOf(p.outer);
      const nearby = wet.filter((_, i) => { const a = boxes[i]; return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0; });
      if (nearby.length) expect(mpArea(intersection(p, nearby))).toBeLessThan(0.05);
    }
    const points = u.blocks.map(interiorPoint);
    for (const ph of u.footprintH) if (area(ph.outer) > 3000) {
      expect(points.some((p) => pointInRing(ph.outer, p) && !ph.holes.some((h) => pointInRing(h, p)))).toBe(true);
    }
  }, 60000);
  it('keeps megacity quarters off the berm and bridges on natural water', () => {
    const world = generate(makeOptions({ seed: 'p4uefz', size: 'city', culture: 'chinese', eagerPop: 1000, moat: 'yes', settlements: 'none' }));
    const u = world.urban!, reserve = u.ruralReserve ?? [];
    expect(u.macro).toBeDefined(); expect(mpArea(u.moats ?? [])).toBeGreaterThan(100);
    for (const q of u.macro!.quarters) expect(mpArea(intersection(q.pts, reserve))).toBeLessThan(0.05);
    const ctx = makeCtx(world, MORPHOLOGIES.chinese, world.mapSize);
    const inside = (polys: typeof reserve, p: { x: number; y: number }) => polys.some((ph) => pointInRing(ph.outer, p) && !ph.holes.some((h) => pointInRing(h, p)));
    for (const b of world.bridges ?? []) {
      const mid = { x: (b.a.x + b.b.x) / 2, y: (b.a.y + b.b.y) / 2 };
      if (inside(reserve, mid)) expect(inside(ctx.water, mid), 'a defensive berm is not river water').toBe(true);
    }
  }, 60000);
});
