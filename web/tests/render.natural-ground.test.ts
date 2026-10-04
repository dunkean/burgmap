import { describe, expect, it } from 'vitest';
import { Resvg } from '@resvg/resvg-js';
import type { Polygon } from '../src/gen/types';
import { urbanNaturalGround } from '../src/gen/landuse/urbanGround';
import { intersectionS, mpArea } from '../src/gen/geo/bool';
import { polygonContains, polygonArea } from '../src/gen/core/geom';
import { buildScene } from '../src/render/scene';
import { renderSvg } from '../src/render/svg';
import { naturalLanduseLayer } from '../src/render/landuse';
import { biomePalette } from '../src/render/biomes';
import { createCanvasRenderer, type CanvasLike } from '../src/render/canvas';
import { fakeWorld, mockCanvas, MockPath2D } from '../scripts/fakeworld';

const rect = (x: number, y: number, w: number, h = w): Polygon => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];
const world = () => {
  const w = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, landAreas: 0 });
  w.options.labels = false; w.options.contours = false;
  w.terrain.rivers = []; w.terrain.lakes = []; w.terrain.coastline = []; w.terrain.islands = []; w.roads = [];
  const u = w.urban!, outer = rect(200, 200, 600);
  u.walls = []; u.footprint = [outer]; u.footprintH = [{ outer, holes: [] }];
  u.quarters = [{ poly: u.footprintH[0], phase: 0, zone: 'core', streetSpace: [] }];
  u.blocks = [rect(200, 200, 96, 600), rect(304, 200, 496, 600)];
  u.blockInfo = u.blocks.map(() => ({ kind: 'block', quarter: 0, phase: 0, zone: 'core' }));
  u.parcels = u.blocks.map((poly, block) => ({ poly, block, use: 'plot' }));
  u.parcels.push({ poly: rect(640, 320, 50), block: 1, use: 'market' });
  u.buildings = [{ poly: rect(400, 400, 30), kind: 'house', parcel: 1 }];
  u.masses = u.buildings.map((b) => ({ outer: b.poly, holes: [] }));
  u.streets = [{ path: [{ x: 300, y: 200 }, { x: 300, y: 800 }], width: 8, rank: 2, kind: 'street', role: 'street', phase: 0 }];
  w.landuse!.areas = [{ kind: 'forest', poly: rect(100, 100, 900) }];
  w.landuse!.naturalGround = urbanNaturalGround(w);
  return w;
};
const options = { width: 1600, style: 'parchment' as const, contours: false, labels: false, legend: false, cartouche: false };
const pixel = (img: ReturnType<Resvg['render']>, x: number, y: number): number[] =>
  Array.from(img.pixels.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
const distance = (a: number[], b: number[]): number => a.reduce((sum, x, i) => sum + Math.abs(x - b[i]), 0);

class RecordingPath extends MockPath2D {
  rings: Polygon[] = [];
  override moveTo(x = 0, y = 0): void { super.moveTo(); this.rings.push([{ x, y }]); }
  override lineTo(x = 0, y = 0): void { super.lineTo(); this.rings.at(-1)?.push({ x, y }); }
  contains(x: number, y: number): boolean { return this.rings.reduce((winding, ring) => polygonContains(ring, { x, y }) ? winding + Math.sign(polygonArea(ring)) : winding, 0) !== 0; }
}

describe('natural cover in unoccupied urban plots', () => {
  it('shares the occupation mask with the Canvas scene and preserves buildings, roads and dedicated places', () => {
    const w = world(), ground = w.landuse!.naturalGround!, scene = buildScene(w);
    expect(mpArea(intersectionS(ground, rect(590, 590, 20)))).toBeCloseTo(400, 6);
    for (const protectedArea of [rect(400, 400, 30), rect(296, 200, 8, 600), rect(640, 320, 50)]) {
      expect(mpArea(intersectionS(ground, protectedArea))).toBeLessThan(1e-6);
    }
    expect(scene.poly.get('u-natural-ground')?.polys).toEqual(ground.map((p) => p.outer));
    const svg = renderSvg(w, { ...options, raster: false });
    expect(svg).toContain('class="u-natural-ground"');
    expect(svg).toContain('id="urban-natural-ground"><path');
    expect(svg.match(/id="urban-natural-ground"[^]*?<\/clipPath>/)?.[0]).toContain('clip-rule="nonzero"');
    expect(svg).toContain('class="u-natural-cover"');
    expect(svg.indexOf('class="u-country-fringe"')).toBeLessThan(svg.indexOf('class="u-natural-ground"'));
    expect(svg.indexOf('class="u-natural-ground"')).toBeLessThan(svg.indexOf('class="u-plots"'));
    expect(svg).toContain('<use href="#regional-road-ground"');
  });

  it('rasterizes real forest over an empty interior more than 80 m from the settlement edge', () => {
    const w = world(), before = JSON.stringify(w);
    const open = new Resvg(renderSvg(w, { ...options, raster: false })).render();
    const closed = { ...w, landuse: { ...w.landuse!, naturalGround: [] }, urban: { ...w.urban!, phases: [{ id: 0, kind: 'core' as const, zone: 'core' as const,
      region: w.urban!.footprintH, walled: true, fossil: false }] } };
    const opaque = new Resvg(renderSvg(closed, { ...options, raster: false })).render();
    const pal = biomePalette('parchment', w.options.biome);
    expect(pal.landBlend).toBe('multiply');
    const channels = (hex: string): number[] => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
    // Observed in Resvg: the unmasked global group uses simple alpha, while this clip uses real multiply.
    // Verify the actual palette over restored paper, rather than the urban yard or a different blending context.
    const paper = channels(pal.paper), forest = channels(pal.land.forest);
    const expected = paper.map((channel, i) => Math.round(channel * (0.3 + 0.7 * forest[i] / 255)));
    expect(distance(pixel(open, 600, 600), expected)).toBeLessThan(4);
    expect(distance(pixel(open, 600, 600), pixel(opaque, 600, 600))).toBeGreaterThan(8);
    for (const [x, y] of [[415, 415], [300, 500], [665, 345]]) {
      expect(pixel(open, x, y)).toEqual(pixel(opaque, x, y));
    }
    expect(JSON.stringify(w)).toBe(before);
  });

  it('keeps duplicated stored natural permission a union under nonzero clipping', () => {
    const w = world();
    const single = new Resvg(renderSvg(w, { ...options, raster: false })).render();
    const snapshot = w.landuse!.naturalGround!;
    w.landuse!.naturalGround = [...snapshot, ...snapshot];
    const duplicate = new Resvg(renderSvg(w, { ...options, raster: false })).render();
    expect(pixel(duplicate, 600, 600)).toEqual(pixel(single, 600, 600));
  });

  it('keeps the generation snapshot unchanged when a lazy village arrives afterwards', () => {
    const w = world(), snapshot = w.landuse!.naturalGround!, before = JSON.stringify(snapshot);
    const plot = rect(900, 200, 500);
    const village = { ...w.urban!, footprint: [plot], footprintH: [{ outer: plot, holes: [] }],
      quarters: [{ poly: { outer: plot, holes: [] }, phase: 0, zone: 'core' as const, streetSpace: [] }],
      blocks: [plot], blockInfo: [{ kind: 'block' as const, quarter: 0, phase: 0, zone: 'core' as const }],
      parcels: [{ poly: plot, block: 0, use: 'plot' }], buildings: [], masses: [], streets: [], landmarks: [], squares: [], backLand: [] };
    w.settlements = [{ main: false, urban: village } as unknown as NonNullable<typeof w.settlements>[number]];
    const scene = buildScene(w);
    expect(scene.poly.get('u-natural-ground')?.polys).toEqual(snapshot.map((p) => p.outer));
    const image = new Resvg(renderSvg(w, { ...options, raster: false })).render();
    const yard = biomePalette('parchment', w.options.biome).urban.yard;
    expect(pixel(image, 1100, 500)).toEqual([1, 3, 5].map((at) => Number.parseInt(yard.slice(at, at + 2), 16)));
    expect(w.landuse!.naturalGround).toBe(snapshot);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('does not create a natural-ground permission while rendering a legacy World without a stored mask', () => {
    const w = world();
    delete w.landuse!.naturalGround;
    expect(buildScene(w).poly.has('u-natural-ground')).toBe(false);
    expect(renderSvg(w, { ...options, raster: false })).not.toContain('class="u-natural-ground"');
  });

  it('restores the actual terrain image through resvg use when land-use textures are disabled', () => {
    const w = world();
    const image = new Resvg(renderSvg(w, { ...options, landuse: false })).render();
    const surrounding = new Resvg(renderSvg({ ...w, urban: undefined }, { ...options, landuse: false })).render();
    expect(distance(pixel(image, 600, 600), pixel(surrounding, 600, 600))).toBeLessThan(2);
    const noRaster = new Resvg(renderSvg(w, { ...options, landuse: false, raster: false })).render();
    expect(distance(pixel(image, 600, 600), pixel(noRaster, 600, 600))).toBeGreaterThan(4);
  });

  it('replays forest in Canvas only under the common occupation clip', () => {
    const w = world(), m = mockCanvas(900, 700), ctx = m.canvas.getContext('2d') as Record<string, unknown>;
    let clip: RecordingPath | undefined;
    const stack: (RecordingPath | undefined)[] = [], replays: RecordingPath[] = [];
    const fill = ctx.fill as (...args: unknown[]) => void;
    ctx.save = () => { stack.push(clip); };
    ctx.restore = () => { clip = stack.pop(); };
    ctx.clip = (p: RecordingPath) => { clip = p; };
    const pal = biomePalette('parchment', w.options.biome);
    ctx.fill = (...args: unknown[]) => {
      if (clip && ctx.fillStyle === pal.land.forest && ctx.globalAlpha === 0.7) replays.push(clip);
      fill(...args);
    };
    const r = createCanvasRenderer(m.canvas as unknown as CanvasLike, w, 'parchment', { Path2D: RecordingPath as never, dpr: 1, terrain: () => null });
    r.draw({ cx: 500, cy: 500, scale: 0.6 });
    expect(replays.some((p) => p.contains(600, 600))).toBe(true);
    for (const p of replays) for (const [x, y] of [[415, 415], [300, 500], [665, 345]]) expect(p.contains(x, y)).toBe(false);
  });

  it('reuses only natural cover types and respects land-use toggles without inventing vegetation', () => {
    const w = world(), pal = biomePalette('parchment', w.options.biome);
    w.landuse!.areas.push({ kind: 'field', poly: rect(200, 200, 600) }, { kind: 'orchard', poly: rect(200, 200, 600) });
    const cover = naturalLanduseLayer(w, pal, 1);
    expect(cover).toContain('class="lu-forest"');
    expect(cover).not.toContain('class="lu-field"'); expect(cover).not.toContain('class="lu-orchard"');
    expect(renderSvg(w, { ...options, raster: false, landuse: false })).not.toContain('class="u-natural-cover"');
    w.landuse!.areas = [];
    expect(naturalLanduseLayer(w, pal, 1)).not.toContain('class="lu-forest"');
  });
});
