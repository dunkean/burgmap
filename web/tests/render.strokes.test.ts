import { describe, expect, it } from 'vitest';
import { Resvg } from '@resvg/resvg-js';
import { MAP_STROKES, CANVAS_MAP_STROKES, mapStrokeWidth, svgMapStroke } from '../src/render/strokes';
import { renderSvg } from '../src/render/svg';
import { landuseLayer } from '../src/render/landuse';
import { createCanvasRenderer, type CanvasLike } from '../src/render/canvas';
import { biomePalette } from '../src/render/biomes';
import { PALETTES } from '../src/render/styles';
import { fakeWorld, mockCanvas, MockPath2D } from '../scripts/fakeworld';

const rect = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const world = (mapSize: number) => {
  const w = fakeWorld({ mapSize, buildings: 0, streets: 0, landAreas: 0 });
  w.landuse!.areas = [{ kind: 'field', poly: rect(100, 100, 400, 200), strips: [rect(100, 100, 20, 200), rect(120, 100, 20, 200)], stripAngle: 0 }];
  w.urban = undefined; w.roads = []; w.terrain.rivers = []; w.options.labels = false;
  return w;
};

describe('bounded map hairlines', () => {
  it('bounds screen weight without using map extent', () => {
    for (const stroke of [...Object.values(MAP_STROKES), ...Object.values(CANVAS_MAP_STROKES)]) for (const scale of [0.02, 0.08, 0.6, 1, 4, 12]) {
      const px = mapStrokeWidth(stroke, scale) * scale;
      expect(px).toBeGreaterThanOrEqual(stroke.minPx - 1e-9);
      expect(px).toBeLessThanOrEqual(stroke.maxPx + 1e-9);
    }
  });

  it('preserves design SVG weights and historical Canvas readability floors', () => {
    const weight = PALETTES.parchment.contourIndexW / 1.6;
    for (const [kind, floor] of [['strip', 0.28], ['furlong', 0.45], ['furrow', 0.3], ['headland', 0.4]] as const) {
      expect(mapStrokeWidth(MAP_STROKES[kind], 0.04) * 0.04).toBeCloseTo(floor);
    }
    expect(mapStrokeWidth(MAP_STROKES.contour, 0.04) * 0.04).toBeCloseTo(0.55);
    expect(mapStrokeWidth(MAP_STROKES.contourIndex, 0.04, weight) * 0.04).toBeCloseTo(0.55 * PALETTES.parchment.contourIndexW);
    expect(mapStrokeWidth(CANVAS_MAP_STROKES.contour, 0.6) * 0.6).toBeCloseTo(0.7);
    expect(mapStrokeWidth(CANVAS_MAP_STROKES.contourIndex, 0.6, weight) * 0.6).toBeCloseTo(0.63 * PALETTES.parchment.contourIndexW);
    for (const [kind, floor] of [['strip', 0.5], ['furlong', 0.6], ['headland', 0.5]] as const) {
      expect(mapStrokeWidth(CANVAS_MAP_STROKES[kind], 0.6) * 0.6).toBeCloseTo(floor);
    }
  });

  it('uses actual export pixels for field strokes at 1.6, 10 and 40 km', () => {
    for (const size of [1600, 10000, 40000]) for (const width of [1600, 3000, 6000]) {
      const scale = width / size, svg = landuseLayer(world(size), PALETTES.parchment, size / 1600, scale);
      expect(svg).toContain(svgMapStroke(MAP_STROKES.strip, scale));
      expect(svg).toContain(svgMapStroke(MAP_STROKES.furlong, scale));
      expect(svg).toContain(svgMapStroke(MAP_STROKES.furrow, scale));
      expect(svg).not.toContain('vector-effect');
    }
  });

  it('defaults to the 1600 px design size and identical explicit export stroke weights', () => {
    for (const size of [10000, 40000]) {
      const w = world(size), height = w.terrain.height;
      w.options.contours = true; w.options.relief = 'hills'; w.terrain.slope.data.fill(0.1);
      for (let y = 0; y < height.h; y++) for (let x = 0; x < height.w; x++) height.data[y * height.w + x] = x;
      const options = { raster: false, labels: false, legend: false, cartouche: false };
      const svg = renderSvg(w, options);
      expect(svg).toContain('width="1600" height="1600" data-seed');
      expect(svg).toEqual(renderSvg(w, { ...options, width: 1600 }));
      expect(svg.match(/class="layer-contours"[^]*?<\/g>/)?.[0]).toContain(svgMapStroke(MAP_STROKES.contour, 1600 / size));
      expect(svg).toContain(svgMapStroke(MAP_STROKES.furrow, 1600 / size));
      const large = renderSvg(w, { ...options, width: 40000 });
      expect(large).toContain('width="40000" height="40000" data-seed');
      expect(large.match(/class="layer-contours"[^]*?<\/g>/)?.[0]).toContain(svgMapStroke(MAP_STROKES.contour, 40000 / size));
      expect(large).toContain(svgMapStroke(MAP_STROKES.furrow, 40000 / size));
    }
  });

  it('exports visible thin and index contours at the requested 40 km output size', () => {
    const w = world(40000), height = w.terrain.height;
    w.options.contours = true; w.options.relief = 'hills';
    w.terrain.slope.data.fill(0.1);
    for (let y = 0; y < height.h; y++) for (let x = 0; x < height.w; x++) height.data[y * height.w + x] = x;
    for (const width of [1600, 3000]) {
      const svg = renderSvg(w, { width, style: 'parchment', raster: false, labels: false, legend: false, cartouche: false });
      const contours = svg.match(/class="layer-contours"[^]*?<\/g>/)?.[0];
      expect(contours).toContain(svgMapStroke(MAP_STROKES.contour, width / w.mapSize));
      expect(contours).toContain(svgMapStroke(MAP_STROKES.contourIndex, width / w.mapSize, PALETTES.parchment.contourIndexW / 1.6));
      expect(svg).toContain(`width="${width}" height="${width}" data-seed`);
      expect(contours).not.toContain('vector-effect');
    }
  });

  it('rasterizes a visible contour through the installed resvg without vector-effect', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="40" viewBox="0 0 40000 1000"><rect width="40000" height="1000" fill="white"/><path d="M100 500H39900" fill="none" stroke="black" ${svgMapStroke(MAP_STROKES.contour, 0.04)}/></svg>`;
    const img = new Resvg(svg).render(), px = img.pixels;
    const center = Array.from({ length: img.height }, (_, y) => px[(y * img.width + 800) * 4]);
    expect(Math.min(...center)).toBeLessThan(235);
  });

  it('keeps a real parchment contour visible at its actual palette colour and opacity', () => {
    const pal = PALETTES.parchment, red = (hex: string) => Number.parseInt(hex.slice(1, 3), 16);
    for (const size of [10000, 40000]) {
      const scale = 1600 / size;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="40" viewBox="0 0 ${size} ${40 / scale}"><rect width="${size}" height="${40 / scale}" fill="${pal.paper}"/><path d="M${100 / scale} ${20 / scale}H${1500 / scale}" fill="none" stroke="${pal.contour}" opacity="${pal.contourOpacity * 0.7}" ${svgMapStroke(MAP_STROKES.contour, scale)}/></svg>`;
      const img = new Resvg(svg).render(), px = img.pixels;
      const contrast = Array.from({ length: img.height }, (_, y) => Math.max(0, red(pal.paper) - px[(y * img.width + 800) * 4]));
      // Integrated ink should retain the historic .55 px design footprint, even after antialiasing.
      const historicInk = 0.55 * pal.contourOpacity * 0.7 * (red(pal.paper) - red(pal.contour));
      expect(contrast.reduce((sum, v) => sum + v, 0)).toBeGreaterThan(historicInk * 0.8);
    }
  });

  it('keeps real parchment furrows visible after the actual palette tints and strip opacity', () => {
    const w = world(40000), poly = rect(0, 0, 40000, 1000), pal = PALETTES.parchment;
    w.landuse!.areas = [{ kind: 'field', poly, strips: [poly], stripAngle: 0 }];
    const render = (furrowAlpha: number) => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="40" viewBox="0 0 40000 1000"><rect width="40000" height="1000" fill="${pal.paper}"/>${landuseLayer(w, { ...pal, furrowAlpha }, 25, 0.04)}</svg>`).render();
    const ink = render(pal.furrowAlpha), blank = render(0);
    const contrast = Array.from({ length: 20 }, (_, i) => {
      const at = ((i + 10) * ink.width + 800) * 4;
      return blank.pixels[at] - ink.pixels[at];
    });
    expect(Math.max(...contrast)).toBeGreaterThan(3);
  });

  it('rasterizes black field furrows at the parchment opacity on a 40 km map at 1600 pixels', () => {
    const w = world(40000), poly = rect(0, 0, 40000, 1000);
    w.landuse!.areas = [{ kind: 'field', poly, strips: [poly], stripAngle: 0 }];
    const pal = { ...PALETTES.parchment, land: { ...PALETTES.parchment.land, field: '#ffffff' },
      // Installed resvg drops this subpixel pattern at opacity 1; the real parchment opacity remains visible.
      landOpacity: 1, furrow: '#000000', furrowAlpha: PALETTES.parchment.furrowAlpha, stripAlpha: [0, 0] as [number, number] };
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="40" viewBox="0 0 40000 1000"><rect width="40000" height="1000" fill="white"/>${landuseLayer(w, pal, 25, 0.04)}</svg>`;
    const img = new Resvg(svg).render(), px = img.pixels;
    const center = Array.from({ length: 20 }, (_, i) => px[((i + 10) * img.width + 800) * 4]);
    expect(Math.min(...center)).toBeLessThan(245);
  });

  it('keeps Canvas field lines thin on large maps at the same zoom', () => {
    for (const size of [1600, 40000]) {
      const w = world(size), m = mockCanvas(900, 700), ctx = m.canvas.getContext('2d') as Record<string, unknown>;
      const strokes: number[] = [], stroke = ctx.stroke as (...args: unknown[]) => void;
      ctx.stroke = (...args: unknown[]) => { if (ctx.strokeStyle === biomePalette('parchment', w.options.biome).furrow) strokes.push(Number(ctx.lineWidth)); stroke(...args); };
      const r = createCanvasRenderer(m.canvas as unknown as CanvasLike, w, 'parchment', { Path2D: MockPath2D as never, dpr: 1, terrain: () => null });
      for (const scale of [0.6, 4]) {
        strokes.length = 0; r.draw({ cx: 300, cy: 200, scale });
        expect(strokes.length).toBeGreaterThan(0);
        expect(Math.max(...strokes) * scale).toBeLessThanOrEqual(0.85 + 1e-9);
      }
    }
  });
});
