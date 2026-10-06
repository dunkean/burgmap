import { describe, expect, it } from 'vitest';
import { Resvg } from '@resvg/resvg-js';
import type { Polygon, PolyH, UrbanLayer, World } from '../src/gen/types';
import { polygonArea, polygonContains } from '../src/gen/core/geom';
import { forestClearings, worldForestClearings } from '../src/render/forestClearings';
import { buildScene } from '../src/render/scene';
import { SceneBuilder } from '../src/render/sceneCache';
import { renderSvg } from '../src/render/svg';
import { createCanvasRenderer, type CanvasLike } from '../src/render/canvas';
import { biomePalette } from '../src/render/biomes';
import { fakeWorld, mockCanvas, MockPath2D } from '../scripts/fakeworld';

const rect = (x: number, y: number, width: number): Polygon => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + width }, { x, y: y + width }];
const piece = (outer: Polygon): PolyH => ({ outer, holes: [] });
const covered = (ps: PolyH[], x: number, y: number) => ps.some((p) => polygonContains(p.outer, { x, y }) && !p.holes.some((h) => polygonContains(h, { x, y })));
function fixture(): World {
  const w = fakeWorld({ mapSize: 600, buildings: 0, streets: 0, landAreas: 0 });
  w.options.contours = false; w.options.labels = false; w.options.landuse = true;
  w.terrain.coastline = []; w.terrain.rivers = []; w.terrain.lakes = []; w.roads = []; w.settlements = [];
  w.landuse!.areas = [{ kind: 'forest', poly: rect(0, 0, 600) }]; w.landuse!.landscapeGround = [];
  const u = w.urban!, plot = rect(180, 180, 140), empty = rect(340, 180, 100);
  u.footprint = [rect(160, 160, 300)]; u.footprintH = u.footprint.map(piece); u.blocks = u.footprint;
  u.blockInfo = [{ kind: 'block', zone: 'middle', quarter: 0, phase: 0 }];
  u.parcels = [{ poly: plot, use: 'plot', block: 0 }, { poly: empty, use: 'plot', block: 0 }];
  u.buildings = [{ poly: rect(220, 220, 20), kind: 'house', parcel: 0 }]; u.masses = [piece(rect(222, 222, 16))];
  u.quarters = []; u.walls = []; u.landmarks = []; u.backLand = []; u.squares = []; u.streets = []; u.trees = []; u.lines = [];
  u.renderHints = { towerShape: 'round' }; return w;
}
class RecordingPath extends MockPath2D {
  rings: Polygon[] = [];
  override moveTo(x = 0, y = 0): void { super.moveTo(); this.rings.push([{ x, y }]); }
  override lineTo(x = 0, y = 0): void { super.lineTo(); this.rings.at(-1)?.push({ x, y }); }
  contains(x: number, y: number): boolean {
    return this.rings.reduce((n, r) => n + (polygonContains(r, { x, y }) ? Math.sign(polygonArea(r)) : 0), 0) !== 0;
  }
}
const pixel = (image: ReturnType<Resvg['render']>, x: number, y: number) => Array.from(image.pixels.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));
const shapes = (s: ReturnType<typeof buildScene>) => { const l = s.poly.get('u-forest-clearings'); return l?.polys.map((outer, i) => ({ outer, holes: l.holes?.[i] ?? [] })) ?? []; };

describe('urban forest exclusion', () => {
  it('excludes the entire urban footprint, including empty plots, except explicit parks and gardens', () => {
    const w = fixture(), u = w.urban!;
    u.parcels.push({ poly: rect(180, 350, 50), use: 'garden', block: 0 }, { poly: rect(250, 350, 50), use: 'green', block: 0 });
    u.sites = [{ id: 'park', kind: 'park', role: 'civic', lot: rect(320, 350, 50), anchor: { x: 340, y: 370 } }];
    const ps = forestClearings(u, w);
    expect(covered(ps, 200, 200)).toBe(true);
    expect(covered(ps, 350, 200)).toBe(true); // Empty plot follows the same quarter rule.
    expect(covered(ps, 100, 200)).toBe(false); // Forest beyond the footprint remains natural.
    for (const [x, y] of [[200, 370], [270, 370], [340, 370]]) expect(covered(ps, x, y)).toBe(false);
    expect(covered(forestClearings({ ...u, renderHints: { towerShape: 'round', canopy: true } }, w), 350, 200)).toBe(true);
    const rearGarden = rect(390, 350, 30);
    u.backLand = [piece(rect(300, 250, 40))];
    u.blocks.push(rearGarden); u.blockInfo.push({ kind: 'block', zone: 'village', quarter: 0, phase: 0 });
    u.parcels.push({ poly: rearGarden, use: 'garden', block: 1 });
    expect(covered(forestClearings(u, w), 320, 270)).toBe(true);
    expect(covered(forestClearings(u, w), 400, 370)).toBe(true);
  });

  it('updates secondary quarter exclusion after late arrival while retaining unchanged scene parts', () => {
    const w = fixture(), extent = rect(20, 20, 80), local: UrbanLayer = { ...w.urban!, footprint: [extent], footprintH: [piece(extent)],
      blocks: [extent], parcels: [], buildings: [], masses: [] };
    w.settlements = [{ main: false, index: 1, urban: local } as never];
    expect(covered(worldForestClearings(w), 25, 25)).toBe(true);
    const builder = new SceneBuilder(), a = builder.update(w), expanded = rect(20, 20, 120);
    const next = { ...w, settlements: [{ ...w.settlements[0], urban: { ...local, footprint: [expanded], footprintH: [piece(expanded)] } }] };
    const b = builder.update(next), c = builder.update(next);
    expect(covered(shapes(a), 125, 125)).toBe(false);
    expect(covered(shapes(b), 125, 125)).toBe(true);
    expect(c.poly.get('u-forest-clearings')!.tileKeys).toEqual(b.poly.get('u-forest-clearings')!.tileKeys);
    expect(builder.stats.retainedParts).toBeGreaterThan(0);
  });

  it('keeps macro park quarters wooded and exposes explicit gardens in late detail without a canopy exemption', () => {
    const w = fixture(), ordinary = { ...w.urban!, footprint: [], footprintH: [] }, park = rect(20, 20, 80);
    ordinary.parcels = [...ordinary.parcels, { poly: rect(180, 350, 50), use: 'garden', block: 0 }];
    w.urban = { ...w.urban!, footprint: [], footprintH: [], blocks: [], quarters: [], parcels: [], buildings: [], masses: [],
      macro: { quarters: [{ id: 0, pts: rect(160, 160, 300), district: 'town' }, { id: 1, pts: park, district: 'gardens' }] } as UrbanLayer['macro'] };
    w.megaDetail = { 0: ordinary };
    const ps = worldForestClearings(w);
    expect(covered(ps, 350, 200)).toBe(true);
    expect(covered(ps, 200, 370)).toBe(false);
    expect(covered(ps, 25, 25)).toBe(false);
  });

  it('removes SVG forest from the whole quarter while preserving exterior forest, park patches and continuous soil', () => {
    const w = fixture(); w.urban!.parcels.push({ poly: rect(180, 350, 50), use: 'garden', block: 0 });
    const options = { width: 600, raster: false, contours: false, labels: false, legend: false, cartouche: false };
    const withForest = new Resvg(renderSvg(w, options)).render();
    const withoutForest = new Resvg(renderSvg({ ...w, landuse: { ...w.landuse!, areas: [] } }, options)).render();
    expect(pixel(withForest, 200, 200)).toEqual(pixel(withoutForest, 200, 200));
    expect(pixel(withForest, 370, 200)).toEqual(pixel(withoutForest, 370, 200));
    expect(pixel(withForest, 100, 100)).not.toEqual(pixel(withoutForest, 100, 100));
    expect(renderSvg(w, options)).toContain('class="lu-forest" mask="url(#forest-clearance)"');
    expect(buildScene(w).poly.get('u-landscape-ground')!.polys).toContainEqual(w.urban!.blocks[0]);
  });

  it('clips Canvas forest color and glyphs by quarters with exact park holes', () => {
    const w = fixture(); w.urban!.parcels.push({ poly: rect(180, 350, 50), use: 'green', block: 0 });
    const m = mockCanvas(600, 600), ctx = m.canvas.getContext('2d') as Record<string, unknown>;
    let clips: RecordingPath[] = []; const stack: RecordingPath[][] = [], forestClips: RecordingPath[][] = [];
    const fill = ctx.fill as (...a: unknown[]) => void;
    ctx.save = () => stack.push(clips.slice()); ctx.restore = () => { clips = stack.pop() ?? []; };
    ctx.clip = (p: RecordingPath) => { if (p) clips.push(p); };
    const pal = biomePalette('parchment', w.options.biome);
    ctx.fill = (...a: unknown[]) => { if (ctx.fillStyle === pal.land.forest || ctx.fillStyle === pal.treeFill) forestClips.push(clips.slice()); fill(...a); };
    const renderer = createCanvasRenderer(m.canvas as unknown as CanvasLike, w, 'parchment', { Path2D: RecordingPath as never, terrain: () => null });
    renderer.draw({ cx: 300, cy: 300, scale: 1 });
    expect(forestClips.length).toBeGreaterThan(0);
    expect(forestClips.some((ps) => ps.every((p) => p.contains(200, 370)))).toBe(true);
    for (const ps of forestClips) {
      expect(ps.some((p) => !p.contains(370, 200))).toBe(true);
    }
  });
});
