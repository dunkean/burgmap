import { describe, expect, it } from 'vitest';
import type { LandArea, Polygon } from '../src/gen/types';
import { fieldHedges, fieldHedgeStyle } from '../src/render/hedges';
import { PALETTES } from '../src/render/styles';
import { biomePalette } from '../src/render/biomes';
import { landuseLayer } from '../src/render/landuse';
import { buildScene } from '../src/render/scene';
import { createCanvasRenderer, type CanvasLike } from '../src/render/canvas';
import { fakeWorld, mockCanvas, MockPath2D } from '../scripts/fakeworld';

const rect = (x: number, y: number, w: number, h = w): Polygon => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];
const areas: (LandArea & { enclosed?: boolean })[] = [
  { kind: 'field', poly: rect(100, 100, 200), holes: [rect(150, 150, 30)], enclosed: true },
  { kind: 'pasture', poly: rect(300, 100, 200), enclosed: true },
  { kind: 'field', poly: rect(600, 100, 100) },
];
const world = () => {
  const w = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, landAreas: 0, clusters: 1 });
  w.landuse!.areas = areas;
  w.options.labels = false;
  return w;
};

describe('subdued rural hedges', () => {
  it('draws a shared edge once, preserves hole boundaries and includes enclosed pasture', () => {
    const before = JSON.stringify(areas);
    const hedges = fieldHedges(areas, 1);
    expect(hedges.lines).toHaveLength(11);
    expect(hedges.lines.reduce((s, [a, b]) => s + Math.hypot(b.x - a.x, b.y - a.y), 0)).toBeCloseTo(1520);
    expect(hedges.lines.filter(([a, b]) => a.x === 300 && b.x === 300)).toHaveLength(1);
    expect(JSON.stringify(areas)).toBe(before);
    const reversed = areas.slice().reverse().map((a) => ({ ...a, poly: a.poly.slice().reverse(), holes: a.holes?.map((h) => h.slice().reverse()) }));
    expect(fieldHedges(reversed, 1)).toEqual(hedges);
  });

  it('uses the same boundaries and tree positions in SVG and the indexed Canvas scene', () => {
    const w = world(), hedges = fieldHedges(areas, 1), scene = buildScene(w, 1000);
    expect(scene.lines.find((l) => l.name === 'hedges')!.lines).toEqual(hedges.lines);
    const trees = scene.poly.get('hedge-trees')!.polys;
    expect(trees).toHaveLength(hedges.trees.length);
    trees.forEach((ring, i) => {
      expect(ring.reduce((s, p) => s + p.x, 0) / ring.length).toBeCloseTo(hedges.trees[i].center.x);
      expect(ring.reduce((s, p) => s + p.y, 0) / ring.length).toBeCloseTo(hedges.trees[i].center.y);
    });
    expect(landuseLayer(w, PALETTES.parchment, 1)).toContain('stroke-opacity="0.35"');
  });

  it('honours styles and biomes that disable field hedges', () => {
    for (const pal of [PALETTES.watabou, PALETTES.cadastre, biomePalette('parchment', 'desert'), biomePalette('parchment', 'tundra')]) {
      expect(pal.hedgeOn).toBe(false);
      expect(landuseLayer(world(), pal, 1)).not.toContain('class="lu-hedges"');
    }
  });

  it('keeps Canvas boundaries below road widths and fades them at intermediate zoom', () => {
    const w = world(), m = mockCanvas(900, 700), ctx = m.canvas.getContext('2d') as Record<string, unknown>;
    const strokes: { color: unknown; alpha: number; width: number }[] = [];
    const stroke = ctx.stroke as (...args: unknown[]) => void;
    ctx.stroke = (...args: unknown[]) => {
      strokes.push({ color: ctx.strokeStyle, alpha: Number(ctx.globalAlpha), width: Number(ctx.lineWidth) });
      stroke(...args);
    };
    const r = createCanvasRenderer(m.canvas as unknown as CanvasLike, w, 'parchment', { Path2D: MockPath2D as never, dpr: 1, terrain: () => null });
    const style = fieldHedgeStyle(PALETTES.parchment, 1);
    for (const scale of [0.1, 0.6, 2]) {
      strokes.length = 0;
      r.draw({ cx: 300, cy: 300, scale });
      const hedge = strokes.find((s) => s.color === style.color)!;
      expect(hedge).toBeDefined();
      expect(hedge.alpha).toBeCloseTo(style.alpha * Math.min(1, scale / 0.3));
      expect(hedge.width * scale).toBeCloseTo(Math.max(style.width * scale, 0.35));
    }
    const cadastre = createCanvasRenderer(m.canvas as unknown as CanvasLike, w, 'cadastre', { Path2D: MockPath2D as never, dpr: 1, terrain: () => null });
    strokes.length = 0;
    cadastre.draw({ cx: 300, cy: 300, scale: 0.6 });
    expect(strokes.some((s) => s.color === fieldHedgeStyle(PALETTES.cadastre, 1).color)).toBe(false);
  });
});
