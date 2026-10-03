import { describe, expect, it } from 'vitest';
import { terraceMarks, terraceDetailAlpha } from '../src/render/terraces';
import { urbanLayer } from '../src/render/urban';
import { buildScene } from '../src/render/scene';
import { PALETTES } from '../src/render/styles';
import { createCanvasRenderer, type CanvasLike } from '../src/render/canvas';
import { fakeWorld, mockCanvas, MockPath2D } from '../scripts/fakeworld';

const world = () => {
  const w = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, landAreas: 0, clusters: 1 });
  w.options.labels = false;
  w.urban!.lines = [
    { kind: 'andene', path: [{ x: 100, y: 100 }, { x: 124, y: 100 }], width: 1 },
    { kind: 'andene-riser', path: [{ x: 100, y: 101 }, { x: 124, y: 101 }], width: 1.5 },
    { kind: 'terrace-stair', path: [{ x: 110, y: 80 }, { x: 110, y: 112 }], width: 1.4 },
  ];
  return w;
};

describe('terrace strokes', () => {
  it('uses evenly spaced real cross strokes, independent of redundant vertices', () => {
    const path = [{ x: 0, y: 0 }, { x: 24, y: 0 }];
    const marks = terraceMarks(path, 6, 1.2);
    expect(marks).toHaveLength(4);
    expect(marks.map(([a, b]) => (a.x + b.x) / 2)).toEqual([3, 9, 15, 21]);
    for (const [a, b] of marks) {
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(1.2);
      expect(a.x).toBe(b.x);
    }
    expect(terraceMarks([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 11, y: 0 }, { x: 24, y: 0 }], 6, 1.2)).toEqual(marks);
    expect(path).toEqual([{ x: 0, y: 0 }, { x: 24, y: 0 }]);
  });

  it('turns with the local path and skips empty, short and invalid inputs safely', () => {
    const marks = terraceMarks([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 14 }], 6, 2);
    expect(marks[2]).toEqual([{ x: 11, y: 5 }, { x: 9, y: 5 }]);
    for (const gap of [0, -1, Infinity, NaN]) expect(terraceMarks([{ x: 0, y: 0 }, { x: 30, y: 0 }], gap, 2)).toEqual([]);
    expect(terraceMarks([], 6, 2)).toEqual([]);
    expect(terraceMarks([{ x: 0, y: 0 }, { x: 2, y: 0 }], 6, 2)).toEqual([]);
    expect(terraceDetailAlpha(0.2)).toBe(0);
    expect(terraceDetailAlpha(0.5)).toBeCloseTo(0.5);
    expect(terraceDetailAlpha(2)).toBe(1);
  });

  it('shares explicit mark geometry between SVG and Canvas without mutating the world', () => {
    const w = world(), before = JSON.stringify(w.urban!.lines), scene = buildScene(w, 1000);
    const hatches = scene.lines.find((l) => l.kind === 'andene-hachure')!;
    expect(hatches.lines).toHaveLength(4);
    expect(hatches.lines[0]).toEqual([{ x: 103, y: 100.4 }, { x: 103, y: 101.6 }]);
    expect(scene.lines.find((l) => l.kind === 'terrace-tread')!.lines.length).toBeGreaterThan(10);
    const svg = urbanLayer(w, PALETTES.parchment, 1, false);
    expect(svg).toContain('class="u-terrace-hachures"');
    expect(svg).toContain('M103 100.4L103 101.6');
    expect(svg).toContain('class="u-terrace-treads"');
    expect(svg).not.toContain('0.22 0.85');
    expect(svg).not.toContain('0.35 0.55');
    expect(JSON.stringify(w.urban!.lines)).toBe(before);
  });

  it('shows walls at intermediate zoom and fades fine marks in without dense dash patterns', () => {
    const w = world(), m = mockCanvas(800, 600), ctx = m.canvas.getContext('2d') as Record<string, unknown>;
    const strokes: { width: number; alpha: number; color: unknown }[] = [];
    const stroke = ctx.stroke as (...args: unknown[]) => void;
    ctx.stroke = (...args: unknown[]) => {
      strokes.push({ width: Number(ctx.lineWidth), alpha: Number(ctx.globalAlpha), color: ctx.strokeStyle });
      stroke(...args);
    };
    const r = createCanvasRenderer(m.canvas as unknown as CanvasLike, w, 'parchment', { Path2D: MockPath2D as never, dpr: 1, terrain: () => null });
    for (const scale of [0.1, 0.5, 1.4]) {
      strokes.length = 0;
      r.draw({ cx: 110, cy: 100, scale });
      const walls = strokes.filter((s) => s.color === PALETTES.parchment.urban.wall && s.alpha === 0.65);
      expect(walls.length).toBeGreaterThan(0);
      const alpha = 0.55 * terraceDetailAlpha(scale);
      const fine = strokes.filter((s) => s.color === PALETTES.parchment.urban.wall && Math.abs(s.alpha - alpha) < 1e-8);
      expect(fine.length > 0).toBe(scale > 0.3);
      if (fine.length) expect(fine.every((s) => s.width * scale < 0.5)).toBe(true);
    }
  });
});
