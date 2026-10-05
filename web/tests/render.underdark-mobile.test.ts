import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeWorld, mockCanvas, MockPath2D } from '../scripts/fakeworld';
import { createCanvasRenderer, type CanvasLike } from '../src/render/canvas';
import { biomePalette } from '../src/render/biomes';
import { PALETTES, type MapStyle } from '../src/render/styles';
import { brushMotif, brushTextureOn, supportsPaintedBiome, type BrushImages } from '../src/render/brushes';
import { cartoucheModel, compactMapPanels, compactScaleModel, legendModel } from '../src/render/legend';
import { appendUnderdarkMark, underdarkMark } from '../src/render/underdark';
import { buildScene } from '../src/render/scene';
import { renderSvg } from '../src/render/svg';
import { urbanLayer } from '../src/render/urban';
import { CanvasBrushes } from '../src/render/brushCanvas';
import { roadsLayer } from '../src/render/landuse';
import type { Farmstead } from '../src/gen/types';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function world() {
  const w = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, clusters: 1, landAreas: 0 });
  w.urban = undefined; w.roads = []; w.terrain.rivers = [];
  w.options.labels = false; w.options.contours = false; w.options.legend = true;
  return w;
}

describe('compact interactive map information', () => {
  it('uses CSS dimensions, retains desktop panels, and never changes SVG export panels', () => {
    const w = world(), pal = PALETTES.parchment;
    expect(compactMapPanels(390, 700)).toBe(true); expect(compactMapPanels(900, 360)).toBe(true);
    expect(compactMapPanels(900, 700)).toBe(false); expect(compactMapPanels(641, 361)).toBe(false);
    for (const [width, height, dpr, compact] of [[390, 700, 1, true], [780, 1400, 2, true], [900, 320, 1, true], [900, 700, 1, false]] as const) {
      const m = mockCanvas(width, height), texts: string[] = [], ctx = m.canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
      ctx.fillText = (text: string): void => { texts.push(text); };
      const r = createCanvasRenderer(m.canvas as unknown as CanvasLike, w, 'parchment', { Path2D: MockPath2D as never, terrain: () => null, raster: false, dpr });
      r.draw({ cx: 800, cy: 800, scale: .2 });
      expect(texts.includes('seed fake')).toBe(!compact);
      expect(texts.some(t => / m$| km$/.test(t))).toBe(true);
      expect(r.getMapInfo().cartouche.h).toBe(76);
      expect(r.getMapInfo().cartouche.prims.filter(p => p.t === 'text').map(p => p.s)).toContain('seed fake');
      expect(r.getMapInfo().cartouche.prims.some(p => p.t === 'text' && / m$| km$/.test(p.s))).toBe(false);
      r.dispose();
    }
    expect(cartoucheModel(w, pal, 1).h).toBe(104);
    expect(renderSvg(w, { width: 390, raster: false })).toContain('class="cartouche"');
    expect(renderSvg(w, { width: 390, raster: false })).toContain('class="legend"');
  });
  it('uses the actual physical scale at every zoom, including subpixel bars', () => {
    for (const scale of [.00001, .02, .2, 1, 8]) {
      const panel = compactScaleModel(PALETTES.parchment, scale);
      const label = panel.prims.find(p => p.t === 'text' && / m$| km$/.test(p.s))!;
      if (label.t !== 'text') throw new Error('scale label');
      const length = parseFloat(label.s) * (label.s.endsWith('km') ? 1000 : 1);
      const bars = panel.prims.filter(p => p.t === 'rect' && p.h === 4);
      expect(bars.reduce((sum, p) => sum + (p.t === 'rect' ? p.w : 0), 0)).toBeCloseTo(length * scale, 12);
      expect(panel.w).toBeLessThanOrEqual(120);
    }
  });
  it('invalidates external title panels when a new rendered snapshot arrives', () => {
    const first = world(), m = mockCanvas(900, 700);
    const r = createCanvasRenderer(m.canvas as unknown as CanvasLike, first, 'parchment', { Path2D: MockPath2D as never, terrain: () => null, raster: false });
    const before = r.getMapInfo();
    const next = { ...first, seed: 'next', names: { town: 'New town', family: 'english' as const, entries: [] } };
    expect(r.update(next, buildScene(next))).toBe(true);
    expect(r.getMapInfo().cartouche).not.toBe(before.cartouche);
    expect(r.getMapInfo().cartouche.prims).toContainEqual(expect.objectContaining({ s: 'seed next' }));
    r.dispose();
  });
});

describe('Underdark vector cover', () => {
  it('has immutable stone/fungal palettes for all styles without changing surface styles', () => {
    const saved = JSON.stringify(PALETTES);
    for (const style of Object.keys(PALETTES) as MapStyle[]) {
      const pal = biomePalette(style, 'underdark');
      expect(pal).not.toBe(PALETTES[style]); expect(pal).toBe(biomePalette(style, 'underdark'));
      expect(pal.tex.commons && pal.tex.marsh && pal.tex.garden).toBe(true);
      expect(pal.hedgeOn).toBe(false); expect(biomePalette(style, 'temperate')).toBe(PALETTES[style]);
    }
    expect(JSON.stringify(PALETTES)).toBe(saved);
    expect(biomePalette('parchment', 'underdark').land.commons).not.toBe(PALETTES.parchment.land.commons);
  });
  it('keeps painted underground maps entirely vectorial and does not alter the World', () => {
    const w = world(); w.options.biome = 'underdark';
    w.landuse!.areas = (['commons', 'garden', 'marsh'] as const).map((kind, i) => ({ kind, poly: [{ x: 100 + 120 * i, y: 100 }, { x: 200 + 120 * i, y: 100 }, { x: 200 + 120 * i, y: 200 }, { x: 100 + 120 * i, y: 200 }] }));
    const saved = JSON.stringify(w), source = { version: 'surface-only', vegetation: 'data:vegetation', terrain: 'data:terrain' };
    const pattern = vi.spyOn(CanvasBrushes.prototype, 'pattern'), tree = vi.spyOn(CanvasBrushes.prototype, 'tree');
    for (const style of ['parchment', 'night', 'engraving'] as const) {
      const classic = renderSvg(w, { style, raster: false });
      expect(renderSvg(w, { style, raster: false, brushes: source })).toBe(classic);
      expect(classic).toContain('underdark-garden'); expect(classic).not.toContain('brush-');
      const pal = biomePalette(style, 'underdark'), legend = legendModel(w, pal);
      expect(legend.prims.filter(p => p.t === 'text').map(p => p.s)).toEqual(expect.arrayContaining(['Rock', 'Fungal cultivation', 'Wet fungi']));
      expect(supportsPaintedBiome('underdark')).toBe(false); expect(brushTextureOn('garden', pal, 'underdark')).toBe(false);
      expect(brushMotif(w, 'forest').stamps).toEqual([]);
      const m = mockCanvas(900, 700), allocations: number[] = [];
      const renderer = createCanvasRenderer(m.canvas as unknown as CanvasLike, w, style, { Path2D: MockPath2D as never, terrain: () => null, raster: false, brushes: { sources: source, vegetation: {}, terrain: {} } as BrushImages,
        createCanvas: (width) => { allocations.push(width); return null; } });
      expect(allocations).toEqual([]);
      expect(renderer.scene.textures.some(t => t.kind === 'garden')).toBe(true);
      renderer.draw({ cx: 280, cy: 150, scale: 2 });
      expect(renderer.lastStats().brushBytes).toBeUndefined(); expect(allocations).not.toContain(1254);
      expect(pattern).not.toHaveBeenCalled(); expect(tree).not.toHaveBeenCalled();
      renderer.dispose();
    }
    expect(JSON.stringify(w)).toBe(saved);
  });
  it('shares bounded top-down glyph geometry with the Canvas path', () => {
    const pal = biomePalette('parchment', 'underdark');
    for (const kind of ['commons', 'garden', 'marsh', 'meadow'] as const) {
      const p = new MockPath2D(); appendUnderdarkMark(p as never, kind, 10, 10, 3, pal);
      expect(p.ops).toBeGreaterThan(3);
      for (const mark of underdarkMark(kind, 10, 10, 3, pal)) {
        if (mark.t === 'line' || mark.t === 'poly') for (const [x, y] of mark.pts) { expect(Math.abs(x - 10)).toBeLessThanOrEqual(3); expect(Math.abs(y - 10)).toBeLessThanOrEqual(3); }
        if (mark.t === 'circle') { expect(Math.abs(mark.x - 10) + mark.r).toBeLessThanOrEqual(3); expect(Math.abs(mark.y - 10) + mark.r).toBeLessThanOrEqual(3); }
      }
    }
  });
  it('uses lichen and fungal beds in an open colony without outdoor grass marks', () => {
    const w = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, clusters: 1, landAreas: 0 });
    w.options.biome = 'underdark'; w.options.contours = false; w.options.labels = false;
    w.roads = []; w.terrain.rivers = [];
    const p = [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }];
    w.urban!.footprint = [p]; w.urban!.footprintH = [{ outer: p, holes: [] }];
    w.urban!.renderHints = { openGround: true, towerShape: 'round' };
    w.urban!.parcels = [{ poly: p, block: 0, use: 'meadow' }, { poly: p, block: 0, use: 'garden' }];
    const before = JSON.stringify(w), pal = biomePalette('parchment', 'underdark');
    const svg = urbanLayer(w, pal, 1, false);
    expect(svg).toContain('class="underdark-meadow"'); expect(svg).toContain('class="underdark-garden"');
    expect(svg).not.toContain('M2.5 4.5l-0.8-1.9');
    vi.stubGlobal('DOMMatrix', class { rotate(): this { return this; } scale(): this { return this; } });
    const surfaces: { width: number; height: number; log: ReturnType<typeof mockCanvas>['log'] }[] = [];
    const main = mockCanvas(900, 700), r = createCanvasRenderer(main.canvas as unknown as CanvasLike, w, 'parchment', {
      Path2D: MockPath2D as never, raster: false, terrain: () => null,
      createCanvas: (width, height) => { const c = mockCanvas(width, height); surfaces.push({ width, height, log: c.log }); return c.canvas as unknown as CanvasLike; },
    });
    r.draw({ cx: 200, cy: 200, scale: 2 });
    const lichen = surfaces.find(s => s.width === 154 && s.height === 126)!;
    expect(lichen).toBeDefined(); expect(lichen.log.calls.arc).toBe(6);
    expect(lichen.log.calls.lineTo ?? 0).toBe(0);
    expect(JSON.stringify(w)).toBe(before); r.dispose();
  });
  it('keeps a surface myconid farm fungal while neighboring farms keep their surface brushes', () => {
    const w = world(); w.options.biome = 'temperate'; w.options.culture = 'myconid-colony';
    const square = (x: number, y: number, n: number) => [{ x, y }, { x: x + n, y }, { x: x + n, y: y + n }, { x, y: y + n }];
    const farm = (x: number, fungal: boolean): Farmstead => ({ pos: { x, y: 100 }, angle: 0, buildings: [], yard: square(x + 20, 220, 10), drive: [], lot: square(x, 100, 140),
      plots: [{ kind: 'garden', poly: square(x, 100, 100) }], ...(fungal ? { cultivation: 'fungal' as const } : {}) });
    w.landuse!.farmsteads = [farm(100, true), farm(400, false)];
    w.roads = [{ path: [{ x: 0, y: 0 }, { x: 800, y: 100 }], kind: 'minor', width: 3 }];
    const scene = buildScene(w), pal = biomePalette('parchment');
    expect(scene.poly.get('farm-gardens')?.polys).toEqual([w.landuse!.farmsteads[1].plots![0].poly]);
    expect(scene.poly.get('farm-fungal-gardens')?.polys).toEqual([w.landuse!.farmsteads[0].plots![0].poly]);
    const svgBrushes = { pattern: (kind: string) => `brush-p-${kind}`, tree: () => '' } as never;
    const svg = roadsLayer(w, pal, 1, svgBrushes);
    expect(svg.match(/fill="url\(#p-fungal-farm\)"/g)).toHaveLength(1);
    expect(svg.match(/fill="url\(#brush-p-garden\)"/g)).toHaveLength(1);
    vi.stubGlobal('DOMMatrix', class { rotate(): this { return this; } scale(): this { return this; } });
    const surface = { name: 'surface' } as unknown as CanvasPattern, fungal = { name: 'fungal', setTransform: vi.fn() } as unknown as CanvasPattern;
    vi.spyOn(CanvasBrushes.prototype, 'pattern').mockReturnValue(surface);
    const main = mockCanvas(900, 700), ctx = main.canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
    ctx.createPattern = () => fungal;
    const r = createCanvasRenderer(main.canvas as unknown as CanvasLike, w, 'parchment', { scene, raster: false, terrain: () => null, Path2D: MockPath2D as never, brushes: {} as BrushImages,
      createCanvas: (width, height) => mockCanvas(width, height).canvas as unknown as CanvasLike });
    r.draw({ cx: 320, cy: 180, scale: 1.5 });
    expect(main.log.fills.filter(f => f.style === surface)).toHaveLength(1);
    expect(main.log.fills.filter(f => f.style === fungal)).toHaveLength(1);
    r.dispose();
  });
});
