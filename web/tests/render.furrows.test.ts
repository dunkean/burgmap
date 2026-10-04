import { describe, expect, it } from 'vitest';
import type { Polygon, World } from '../src/gen/types';
import { furrowDegrees, furrowLines, furrowOffset, furrowSpacing } from '../src/render/furrows';
import { landuseLayer } from '../src/render/landuse';
import { biomePalette } from '../src/render/biomes';
import { FURROW_HOLDER_BUDGET, FURROW_MIN_PX } from '../src/render/lod';
import { buildScene } from '../src/render/scene';
import { createCanvasRenderer, type CanvasLike } from '../src/render/canvas';
import { polygonArea, polygonContains } from '../src/gen/core/geom';
import { fakeWorld, mockCanvas, MockPath2D } from '../scripts/fakeworld';

const rect = (x: number, y: number, width: number, height = width): Polygon => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
class RecordedPath extends MockPath2D {
  rings: { points: Polygon; closed: boolean }[] = [];
  override moveTo(x = 0, y = 0): void { super.moveTo(); this.rings.push({ points: [{ x, y }], closed: false }); }
  override lineTo(x = 0, y = 0): void { super.lineTo(); this.rings.at(-1)?.points.push({ x, y }); }
  override closePath(): void { const ring = this.rings.at(-1); if (ring) ring.closed = true; }
  contains(p: { x: number; y: number }): boolean {
    return this.rings.reduce((n, r) => r.closed && polygonContains(r.points, p) ? n + Math.sign(polygonArea(r.points)) : n, 0) !== 0;
  }
}

function fieldRenderer(w: World, width = 900, height = 700) {
  w.urban = undefined; w.roads = []; w.terrain.rivers = []; w.options.contours = false; w.options.labels = false;
  const scene = buildScene(w), m = mockCanvas(width, height), strokes: RecordedPath[] = [];
  const ctx = m.canvas.getContext('2d') as Record<string, unknown>;
  ctx.stroke = (p?: RecordedPath) => {
    if (p instanceof RecordedPath && p.rings.length > 2 && p.rings.every((r) => !r.closed && r.points.length === 2)) strokes.push(p);
  };
  const renderer = createCanvasRenderer(m.canvas as unknown as CanvasLike, w, 'parchment', { scene, Path2D: RecordedPath as never, terrain: () => null, createCanvas: () => null, dpr: 1 });
  return { renderer, scene, strokes };
}

describe('actual plough lines in Canvas fields', () => {
  it('matches the SVG world phase, direction and spacing, independently of viewport position', () => {
    const theta = .63, deg = furrowDegrees(theta), sp = furrowSpacing(3600), offset = furrowOffset(3600), angle = deg * Math.PI / 180;
    const a = furrowLines(rect(100, 100, 400), 3600, theta), b = furrowLines(rect(300, 200, 400), 3600, theta);
    expect(a.length).toBeGreaterThan(10);
    const across = (p: { x: number; y: number }) => -Math.sin(angle) * p.x + Math.cos(angle) * p.y;
    for (const line of a) {
      expect(across(line[0])).toBeCloseTo(across(line[1]), 8);
      expect((across(line[0]) - offset) / sp).toBeCloseTo(Math.round((across(line[0]) - offset) / sp), 8);
    }
    const levels = new Set(a.map((l) => Math.round((across(l[0]) - offset) / sp)));
    expect(b.some((l) => levels.has(Math.round((across(l[0]) - offset) / sp)))).toBe(true);
  });

  it.each([{ mapSize: 40000, spacing: 37.5, offset: 18.8 }, { mapSize: 3360, spacing: 3.2, offset: 1.6 }])('retains the historical serialized SVG phase at $mapSize meters rather than accumulating rounding drift', ({ mapSize, spacing, offset }) => {
    const w = fakeWorld({ mapSize, buildings: 0, streets: 0, landAreas: 0 });
    w.landuse!.areas = [{ kind: 'field', poly: rect(200, 200, 600), stripAngle: 0, strips: [rect(200, 200, 600)] }];
    const svg = landuseLayer(w, biomePalette('parchment', w.options.biome), mapSize / 1600);
    expect(svg).toContain(`height="${spacing}"`); expect(svg).toContain(`M0 ${offset}H40`);
    for (const line of furrowLines(w.landuse!.areas[0].poly, mapSize, 0)) {
      expect((line[0].y - offset) / spacing).toBeCloseTo(Math.round((line[0].y - offset) / spacing), 8);
    }
  });

  it('indexes holders and draws clipped furrows without filling holes or the gaps between strips', () => {
    const w = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, landAreas: 0 });
    w.urban = undefined; w.roads = []; w.options.contours = false; w.options.labels = false;
    const area = rect(200, 200, 600), hole = rect(300, 300, 120);
    w.landuse!.areas = [{ kind: 'field', poly: area, holes: [hole], stripAngle: Math.PI / 6, strips: [rect(220, 220, 240, 540), rect(480, 220, 280, 540)] }];
    const scene = buildScene(w); expect(scene.furrows!.areas).toHaveLength(1); expect(scene.furrows!.areas[0].holes).toEqual([hole]);
    const m = mockCanvas(900, 700), ctx = m.canvas.getContext('2d') as Record<string, unknown>;
    let clips: RecordedPath[] = []; const stack: RecordedPath[][] = [];
    const strokes: { path: RecordedPath; clips: RecordedPath[]; width: number; alpha: number }[] = [];
    ctx.save = () => { stack.push(clips.slice()); }; ctx.restore = () => { clips = stack.pop() ?? []; };
    ctx.clip = (p?: RecordedPath) => { if (p) clips.push(p); };
    const renderer = createCanvasRenderer(m.canvas as unknown as CanvasLike, w, 'parchment', { scene, Path2D: RecordedPath as never, terrain: () => null, createCanvas: () => null, dpr: 1 });
    ctx.stroke = (p: RecordedPath) => {
      if (p instanceof RecordedPath && p.rings.length > 10 && p.rings.every((r) => !r.closed && r.points.length === 2)) strokes.push({ path: p, clips: clips.slice(), width: Number(ctx.lineWidth), alpha: Number(ctx.globalAlpha) });
    };
    renderer.draw({ cx: 500, cy: 500, scale: 2 });
    expect(strokes).toHaveLength(1); expect(strokes[0].alpha).toBeGreaterThan(0); expect(strokes[0].width * 2).toBeLessThanOrEqual(.55);
    const allows = (x: number, y: number) => strokes[0].clips.every((p) => p.contains({ x, y }));
    expect(allows(250, 250)).toBe(true); expect(allows(350, 350)).toBe(false); expect(allows(470, 250)).toBe(false); expect(allows(100, 250)).toBe(false);
    strokes.length = 0; renderer.draw({ cx: 500, cy: 500, scale: .1 }); expect(strokes).toHaveLength(0);
    w.options.landuse = false; renderer.draw({ cx: 500, cy: 500, scale: 2 }); expect(strokes).toHaveLength(0);
    renderer.dispose();
  });

  it('does not invent furrows for fields lacking real strips or a direction', () => {
    const w = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, landAreas: 0 });
    w.urban = undefined; w.options.contours = false;
    w.landuse!.areas = [{ kind: 'field', poly: rect(200, 200, 200), stripAngle: 0 }, { kind: 'field', poly: rect(500, 200, 200), strips: [rect(500, 200, 200)] }];
    expect(buildScene(w).furrows).toBeUndefined();
  });

  it('skips plough texture above the visible-holder budget before allocating any furrow paths', () => {
    const w = fakeWorld({ mapSize: 40000, buildings: 0, streets: 0, landAreas: 0 });
    // 2701 disjoint, readable holders reproduce the former three-entry shared-cache churn case.
    w.landuse!.areas = Array.from({ length: 2701 }, (_, i) => {
      const poly = rect(7400 + (i % 60) * 420, 10600 + Math.floor(i / 60) * 420, 400);
      return { kind: 'field' as const, poly, strips: [poly], stripAngle: 0 };
    });
    const h = fieldRenderer(w, 1800, 1200), view = { cx: 20000, cy: 20000, scale: .06 };
    const first = h.renderer.draw(view);
    expect(first.furrowsDrawn).toBe(0); expect(first.furrowCache).toBe(0); expect(h.strokes).toHaveLength(0);
    const next = h.renderer.draw(view);
    // The shared tile/texture cache warms independently; only the dedicated plough records must stay empty.
    expect(next.furrowCache).toBe(0); expect(next.furrowsDrawn).toBe(0); expect(h.strokes).toHaveLength(0);
    h.renderer.dispose();
  });

  it('keeps a single large multi-tile holder readable on a 40km band1 map, with warm paths reused', () => {
    const w = fakeWorld({ mapSize: 40000, buildings: 0, streets: 0, landAreas: 0 }), poly = rect(19800, 19800, 600);
    w.landuse!.areas = [{ kind: 'field', poly, strips: [poly], stripAngle: 0 }];
    const h = fieldRenderer(w), view = { cx: 20000, cy: 20000, scale: .06 };
    expect(h.scene.furrows!.index.query({ minX: 12500, minY: 14000, maxX: 27500, maxY: 26000 })).toEqual([0]);
    const first = h.renderer.draw(view); expect(first.furrowsDrawn).toBe(1); expect(first.furrowCache).toBe(1); expect(h.strokes).toHaveLength(1);
    const next = h.renderer.draw(view); expect(next.pathsBuilt).toBe(0); expect(next.pathCache).toBe(first.pathCache); expect(next.furrowCache).toBe(1);
    h.renderer.dispose();
  });

  it('culls narrow projected holders before counting the budget, and restores them when zoom makes them readable', () => {
    const w = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, landAreas: 0 });
    const small = rect(300, 250, FURROW_MIN_PX - 1, 300), large = rect(750, 250, 40, 300);
    w.landuse!.areas = Array.from({ length: FURROW_HOLDER_BUDGET + 1 }, (_, i) => {
      const poly = rect(100 + (i % 25) * 24, 150 + Math.floor(i / 25) * 24, FURROW_MIN_PX - 1);
      return { kind: 'field' as const, poly, strips: [poly], stripAngle: 0 };
    });
    w.landuse!.areas.push({ kind: 'field', poly: large, strips: [large], stripAngle: 0 });
    const h = fieldRenderer(w);
    const overview = h.renderer.draw({ cx: 450, cy: 400, scale: 1 });
    expect(overview.furrowsDrawn).toBe(1); expect(overview.furrowCache).toBe(1); expect(h.strokes).toHaveLength(1);
    // A single previously culled holder becomes readable when enlarged; overviews still avoid arbitrary subsets.
    const one = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, landAreas: 0 });
    one.landuse!.areas = [{ kind: 'field', poly: small, strips: [small], stripAngle: 0 }];
    const zoomed = fieldRenderer(one);
    expect(zoomed.renderer.draw({ cx: 350, cy: 400, scale: 1 }).furrowsDrawn).toBe(0);
    expect(zoomed.renderer.draw({ cx: 350, cy: 400, scale: 2 }).furrowsDrawn).toBe(1);
    h.renderer.dispose(); zoomed.renderer.dispose();
  });

  it('bounds the dedicated record cache when panning across more unique holders than it can retain', () => {
    const w = fakeWorld({ mapSize: 40000, buildings: 0, streets: 0, landAreas: 0 });
    w.landuse!.areas = Array.from({ length: FURROW_HOLDER_BUDGET * 3 }, (_, i) => {
      const group = Math.floor(i / FURROW_HOLDER_BUDGET), local = i % FURROW_HOLDER_BUDGET;
      const poly = rect(1000 + group * 12000 + (local % 25) * 350, 5000 + Math.floor(local / 25) * 350, 320);
      return { kind: 'field' as const, poly, strips: [poly], stripAngle: 0 };
    });
    const h = fieldRenderer(w);
    for (let group = 0; group < 3; group++) {
      const st = h.renderer.draw({ cx: 5475 + group * 12000, cy: 7500, scale: .1 });
      expect(st.furrowsDrawn).toBe(FURROW_HOLDER_BUDGET);
      expect(st.furrowCache).toBe(Math.min(group + 1, 2) * FURROW_HOLDER_BUDGET);
    }
    const warm = h.renderer.draw({ cx: 29475, cy: 7500, scale: .1 });
    expect(warm.pathsBuilt).toBe(0); expect(warm.furrowCache).toBe(FURROW_HOLDER_BUDGET * 2);
    h.renderer.dispose();
  });
});
