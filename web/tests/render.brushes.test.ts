import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BIOME_NAMES } from '../src/gen/biomes';
import { makeOptions } from '../src/gen/options';
import { brushCell, brushMotif, brushColorMatrix, decodeBrushes, BRUSH_ATLAS, BRUSH_CELL } from '../src/render/brushes';
import { svgBrushes } from '../src/render/brushSvg';
import { renderSvg } from '../src/render/svg';
import { CanvasBrushes } from '../src/render/brushCanvas';
import { biomePalette } from '../src/render/biomes';
import { BRUSH_SOURCES } from '../src/render/assets/brushAssets';
import { appearanceQuery, paintedFromQuery } from '../src/ui/renderAppearance';
import { createCanvasRenderer } from '../src/render/canvas';
import { bugReport } from '../src/ui/share';
import { fakeWorld, mockCanvas, MockPath2D } from '../scripts/fakeworld';
import type { BrushImages } from '../src/render/brushes';
import type { CanvasLike } from '../src/render/canvas';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('optional painted natural textures', () => {
  it('keeps the preference outside World options and omits it from classic URLs', () => {
    const options = makeOptions({ seed: 'botanical' });
    expect(options).not.toHaveProperty('painted'); expect(options).not.toHaveProperty('brushes');
    const classic = 'seed=botanical&labels=0&pin=1%2C2';
    expect(appearanceQuery(classic, false)).toBe(classic);
    expect(paintedFromQuery(appearanceQuery(classic, true))).toBe(true);
    expect(paintedFromQuery('?brushes=unknown')).toBe(false);
    expect(appearanceQuery(appearanceQuery(classic, true), false)).toBe(classic);
    const report = bugReport(options, [], { cx: 10, cy: 20, scale: 4 }, 'https://example.test/', 900, appearanceQuery(classic, true));
    expect(report).toContain('Link: https://example.test/?' + classic + '&brushes=painted');
    expect(options).not.toHaveProperty('painted');
  });
  it('uses the selected untouched RGBA atlases with exact cell crops', () => {
    expect(BRUSH_ATLAS / BRUSH_CELL).toBe(6);
    for (const [file, key, hash] of [
      ['biome-vegetation-v2.png', 'vegetation', 'af7a51b3d7cd4549ca68c1fdf5360eeb1cfbc53261331953646fdf091b927706'],
      ['terrain-cultivation-v1.png', 'terrain', ''],
    ] as const) {
      const bytes = readFileSync(new URL('../src/render/assets/' + file, import.meta.url));
      if (hash) expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
      expect(bytes.readUInt32BE(16)).toBe(BRUSH_ATLAS); expect(bytes.readUInt32BE(20)).toBe(BRUSH_ATLAS);
      expect(bytes[25]).toBe(6); // PNG color type RGBA.
      expect(BRUSH_SOURCES[key]).toBe('data:image/png;base64,' + bytes.toString('base64'));
    }
  });
  it('varies species by map while preserving reproducible biome and fruit mixes', () => {
    const world = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, clusters: 1, landAreas: 0 });
    const fruits = [[1], [1], [12, 13], [20], [24, 26], [20]];
    BIOME_NAMES.filter(biome => biome !== 'underdark').forEach((biome, row) => {
      world.options.biome = biome;
      const a = brushMotif(world, 'forest'), b = brushMotif(world, 'forest');
      expect(a).toEqual(b); expect(new Set(a.stamps.map(s => s.cell)).size).toBeGreaterThan(1);
      expect(a.stamps.every(s => Math.floor(s.cell / 6) === row)).toBe(true);
      for (const stamp of brushMotif(world, 'orchard').stamps) expect(fruits[row]).toContain(stamp.cell);
      const other = brushMotif({ ...world, seed: 'another-map' }, 'forest'); expect(other).not.toEqual(a);
      for (const stamp of brushMotif(world, 'orchard').stamps) {
        expect(stamp.x % 11).toBe(5.5); expect(stamp.y % 11).toBe(5.5);
      }
    });
    expect(brushCell(world, 10.125, 30.25)).toBe(brushCell(world, 10.125, 30.25));
  });
  it('shares admissible low vegetation per biome without introducing trees into meadows', () => {
    const world = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, clusters: 1, landAreas: 0 });
    const allowed = [[4, 5], [10], [16, 17], [21, 22, 23], [27, 28], [30, 31, 33, 34, 35]];
    BIOME_NAMES.filter(biome => biome !== 'underdark').forEach((biome, row) => {
      world.options.biome = biome;
      for (const kind of ['meadow', 'pasture'] as const) {
        const a = brushMotif(world, kind); expect(a).toEqual(brushMotif(world, kind));
        expect(a).not.toEqual(brushMotif({ ...world, seed: 'low-plants-other-map' }, kind));
        for (const s of a.stamps) if (s.atlas === 'vegetation') expect(allowed[row]).toContain(s.cell); else expect(s.cell).toBeGreaterThanOrEqual(12);
      }
    });
  });
  it('uses the same natural garden texture switch in SVG and Canvas', () => {
    const world = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, clusters: 1, landAreas: 0 }); world.urban = undefined; world.roads = []; world.options.contours = false; world.options.labels = false;
    world.landuse!.areas = [{ kind: 'garden', poly: [{ x: 50, y: 50 }, { x: 150, y: 50 }, { x: 150, y: 150 }, { x: 50, y: 150 }] }];
    const gardenPattern = {} as CanvasPattern; vi.spyOn(CanvasBrushes.prototype, 'pattern').mockImplementation((_ctx, kind) => kind === 'garden' ? gardenPattern : {} as CanvasPattern);
    for (const style of ['watabou', 'parchment'] as const) {
      const target = mockCanvas(400, 400), canvas = target.canvas as CanvasLike;
      const renderer = createCanvasRenderer(canvas, world, style, { Path2D: MockPath2D as unknown as typeof Path2D, terrain: () => null, raster: false, brushes: {} as BrushImages });
      renderer.draw({ cx: 100, cy: 100, scale: 4 });
      const svg = renderSvg(world, { style, raster: false, brushes: BRUSH_SOURCES });
      expect(target.log.fills.some(fill => fill.style === gardenPattern)).toBe(biomePalette(style).tex.garden);
      expect(svg.includes('fill="url(#brush-p-garden)"')).toBe(biomePalette(style).tex.garden); renderer.dispose();
    }
  });
  it('embeds each atlas once and shares pattern definitions without changing the model or classic SVG', () => {
    const world = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, clusters: 1, landAreas: 0 });
    const p = [{ x: 50, y: 50 }, { x: 150, y: 50 }, { x: 150, y: 150 }, { x: 50, y: 150 }];
    world.landuse!.areas = ['forest', 'garden', 'field'].map(kind => ({ kind: kind as 'forest' | 'garden' | 'field', poly: p, holes: [[{ x: 80, y: 80 }, { x: 120, y: 80 }, { x: 120, y: 120 }, { x: 80, y: 120 }]] }));
    const before = JSON.stringify(world), classic = renderSvg(world, { raster: false });
    const painted = renderSvg(world, { raster: false, brushes: BRUSH_SOURCES });
    expect(painted.split(BRUSH_SOURCES.vegetation).length - 1).toBe(1);
    expect(painted.split(BRUSH_SOURCES.terrain).length - 1).toBe(1);
    expect(painted).toContain('fill="url(#brush-p-field)" fill-rule="evenodd"');
    expect(painted).toContain('fill="url(#brush-p-forest)" fill-rule="evenodd"');
    expect(classic).not.toContain('brush-'); expect(renderSvg(world, { raster: false })).toBe(classic);
    expect(JSON.stringify(world)).toBe(before);
    const defs = svgBrushes(world, biomePalette('parchment'), BRUSH_SOURCES).defs;
    expect(defs).toContain('viewBox="418 0 209 209"');
  });
  it('keeps bounded pattern memory across zooms and reuses identical zoom/DPR motifs', () => {
    vi.stubGlobal('DOMMatrix', class { scale(): object { return this; } });
    const context = { imageSmoothingEnabled: true, imageSmoothingQuality: 'high', globalAlpha: 1, drawImage: vi.fn(), createPattern: () => ({ setTransform: vi.fn() }) } as unknown as CanvasRenderingContext2D;
    const create = (width: number, height: number): CanvasLike => ({ width, height, getContext: () => context });
    const world = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, clusters: 1, landAreas: 0 }), sources = {} as BrushImages;
    const atlas = new CanvasBrushes(world, biomePalette('parchment'), sources, create);
    const first = atlas.pattern(context, 'forest', 4, 2); expect(atlas.pattern(context, 'forest', 4, 2)).toBe(first);
    for (let i = 0; i < 20; i++) for (const kind of ['forest', 'orchard', 'marsh', 'field'] as const) atlas.pattern(context, kind, 0.7 + i / 3, 2);
    expect(atlas.cachedBytes).toBeLessThanOrEqual(16 * 1024 * 1024); atlas.dispose(); expect(atlas.cachedBytes).toBe(0);
  });
  it('lifts painted night leaves while keeping alpha, subdued highlights and classic palettes unchanged', () => {
    const palette = biomePalette('night'), before = JSON.stringify(palette), matrix = brushColorMatrix(palette)!;
    const tone = (value: number): number[] => [0, 1, 2].map(channel => { const j = channel * 5; return (matrix[j] + matrix[j + 1] + matrix[j + 2]) * value + matrix[j + 4]; });
    const rgb = (hex: string): number[] => hex.slice(1).match(/../g)!.map(c => parseInt(c, 16) / 255);
    const luminosity = (c: number[]): number => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
    const oldMid = rgb(palette.treeFill).map((c, i) => (c + rgb(palette.treeInk)[i]) / 2);
    expect(luminosity(tone(0.5))).toBeGreaterThan(luminosity(oldMid) * 1.6);
    expect(Math.max(...tone(1))).toBeLessThanOrEqual(0.55); expect(tone(0).every(c => c >= 0)).toBe(true);
    expect(matrix.slice(15)).toEqual([0, 0, 0, 1, 0]); expect(JSON.stringify(palette)).toBe(before);
    const world = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, clusters: 1, landAreas: 0 });
    expect(svgBrushes(world, palette, BRUSH_SOURCES).defs).toContain('values="' + matrix.join(' ') + '"');
    const motif = brushMotif(world, 'forest');
    expect(motif.stamps.some(stamp => stamp.x % 9 < 2.7 || stamp.x % 9 > 6.3)).toBe(true);
    expect(motif.stamps.every(stamp => stamp.x % 9 >= 1.35 - 1e-8 && stamp.x % 9 <= 7.65 + 1e-8)).toBe(true);
  });
  it('matches monochrome tint definitions and falls back on failed or wrongly sized decoding', async () => {
    expect(brushColorMatrix(biomePalette('parchment'))).toBeNull();
    for (const style of ['night', 'engraving', 'blueprint'] as const) expect(brushColorMatrix(biomePalette(style))!).toHaveLength(20);
    const close = vi.fn(); vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => ({}) })));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close })));
    expect(await decodeBrushes(BRUSH_SOURCES)).toBeNull(); expect(close).toHaveBeenCalledTimes(2);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('refused'); }));
    expect(await decodeBrushes(BRUSH_SOURCES)).toBeNull();
  });
});
