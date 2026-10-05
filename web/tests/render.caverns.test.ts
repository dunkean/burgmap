import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fakeWorld, mockCanvas, MockPath2D } from '../scripts/fakeworld';
import { renderSvg } from '../src/render/svg';
import { createCanvasRenderer, type CanvasLike } from '../src/render/canvas';
import { biomePalette } from '../src/render/biomes';
import { underdarkMark, underdarkPatterns, underdarkTextureSpec } from '../src/render/underdark';
import { cavernWallFill, cavernRockPixels, cavernFungalRoomsSvg } from '../src/render/caverns';
import { supportsPaintedBiome } from '../src/render/brushes';
import { fmtPop, legendModel, townTitle } from '../src/render/legend';
import { cavernDisplayWorld } from '../src/render/cavernDisplay';
import { SceneBuilder } from '../src/render/sceneCache';
import { buildScene } from '../src/render/scene';
import type { Polygon } from '../src/gen/types';

const rect = (x: number, y: number, w: number, h = w): Polygon => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
function cavernWorld() {
  const w = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, clusters: 1, landAreas: 0 });
  w.options.biome = 'underdark-caverns'; w.options.contours = false; w.options.labels = false; w.options.legend = true;
  w.urban = undefined; w.roads = []; w.terrain.rivers = [];
  const floor = rect(200, 200, 1100), pillar = rect(600, 600, .25);
  w.terrain.caverns = { floor: [{ outer: floor, holes: [pillar] }],
    solid: [{ outer: rect(0, 0, 1600), holes: [floor] }, { outer: pillar, holes: [] }],
    mask: new Uint8Array(), clearance: new Float32Array(), chambers: [] };
  return w;
}

class ExactPath extends MockPath2D {
  points: [number, number][] = [];
  moveTo(x = 0, y = 0): void { this.points.push([x, y]); super.moveTo(); }
  lineTo(x = 0, y = 0): void { this.points.push([x, y]); super.lineTo(); }
}

describe('cavern walls and underground pebble correction', () => {
  it('keeps rock marks closed and sparse, with fixed shared metre specifications', () => {
    const pal = biomePalette('parchment', 'underdark');
    const marks = underdarkMark('commons', 10, 10, 2.5, pal);
    expect(marks).toHaveLength(1); expect(marks[0].t).toBe('poly');
    if (marks[0].t === 'poly') expect(marks[0].pts).toHaveLength(8);
    expect(underdarkTextureSpec('commons')).toEqual({ spacing: 28, radius: 2.5 });
    expect(underdarkPatterns(pal, 1)).toBe(underdarkPatterns(pal, 20));
    expect(underdarkPatterns(pal)).toContain('id="p-commons" patternUnits="userSpaceOnUse" width="28" height="28"');
  });
  it('clips SVG water and objects to authoritative compound floors and preserves the old biome', () => {
    const w = cavernWorld(), before = JSON.stringify(w), svg = renderSvg(w, { raster: false });
    expect(svg).toContain('id="cavern-floor"');
    expect(svg).toContain('<g clip-path="url(#cavern-solid)">');
    expect(svg).toContain('stroke-width="30"'); expect(svg).toContain('clip-rule="evenodd"');
    expect(svg.indexOf('<g clip-path="url(#cavern-floor)">')).toBeLessThan(svg.indexOf('class="layer-water"'));
    expect(svg.indexOf('class="layer-cavern-walls"')).toBeGreaterThan(svg.indexOf('class="layer-water"'));
    expect(svg).toContain('M600 600L600.3 600L600.3 600.3L600 600.3Z');
    expect(legendModel(w, biomePalette('parchment', w.options.biome)).prims).toContainEqual(expect.objectContaining({ s: 'Cavern walls' }));
    expect(buildScene(w).poly.get('cavern-floor')?.holes).toEqual([[w.terrain.caverns!.floor[0].holes[0]]]);
    expect(supportsPaintedBiome(w.options.biome)).toBe(false);
    expect(JSON.stringify(w)).toBe(before);
    const old = { ...w, options: { ...w.options, biome: 'underdark' as const }, terrain: { ...w.terrain, caverns: undefined } };
    expect(renderSvg(old, { raster: false })).not.toContain('cavern-floor');
    expect(renderSvg(old, { raster: false })).not.toContain('layer-cavern-walls');
  });
  it('retains exact tiny pillars and holes in Canvas at far and close zoom and in the minimap', () => {
    for (const scale of [.05, 2]) {
      const w = cavernWorld(), m = mockCanvas(900, 700), clips: ExactPath[] = [];
      const ctx = m.canvas.getContext('2d') as CanvasRenderingContext2D;
      (ctx as unknown as { clip: (path?: unknown) => void }).clip = (path?: unknown): void => { if (path instanceof ExactPath) clips.push(path); };
      const r = createCanvasRenderer(m.canvas as unknown as CanvasLike, w, 'parchment', { raster: false, terrain: () => null, Path2D: ExactPath as never });
      r.draw({ cx: 800, cy: 800, scale });
      expect(clips.some(p => p.points.some(([x, y]) => x === 600.25 && y === 600.25))).toBe(true);
      const solids = m.log.fills.filter(f => f.style === cavernWallFill(r.palette));
      expect(solids).toHaveLength(1);
      expect((solids[0].path as ExactPath).points).toContainEqual([600.25, 600.25]);
      const mini = mockCanvas(160, 160); r.drawMinimap(mini.canvas as unknown as CanvasLike, { cx: 800, cy: 800, scale }, 900, 700, false);
      const miniSolid = mini.log.fills.find(f => f.style === cavernWallFill(r.palette));
      expect((miniSolid?.path as ExactPath).points).toContainEqual([600.25, 600.25]);
      const next = { ...w, terrain: { ...w.terrain, caverns: { ...w.terrain.caverns!, solid: [{ outer: rect(620, 620, .25), holes: [] }] } } };
      expect(r.update(next, buildScene(next))).toBe(true); m.reset(); r.draw({ cx: 800, cy: 800, scale });
      const replacement = m.log.fills.find(f => f.style === cavernWallFill(r.palette));
      expect((replacement?.path as ExactPath).points).toContainEqual([620.25, 620.25]);
      expect((replacement?.path as ExactPath).points).not.toContainEqual([600.25, 600.25]);
      r.dispose();
    }
  });
  it('uses bounded, very dark deterministic multiscale bedrock independently of the floor mask', () => {
    const pal = biomePalette('parchment', 'underdark-caverns');
    const a = cavernRockPixels('rock-proof', 1600, pal), b = cavernRockPixels('rock-proof', 1600, pal);
    expect(a.width).toBe(512); expect(a.rgba.byteLength).toBe(1024 * 1024);
    const digest = (pixels: Uint8ClampedArray) => createHash('sha256').update(pixels).digest('hex');
    expect(digest(a.rgba)).toBe(digest(b.rgba));
    let min = 255, max = 0, sum = 0, opaque = true;
    for (let i = 0; i < a.rgba.length; i += 4) {
      min = Math.min(min, a.rgba[i]); max = Math.max(max, a.rgba[i]); sum += a.rgba[i];
      opaque &&= a.rgba[i + 3] === 255;
    }
    expect(opaque).toBe(true); expect(max - min).toBeGreaterThan(12); expect(max).toBeLessThanOrEqual(48);
    expect(sum / (512 * 512)).toBeLessThan(30);
    expect(cavernWallFill(pal)).toBe('#111116');
    const colourOffsets = new Set<number>();
    for (let i = 0; i < a.rgba.length; i += 4) colourOffsets.add(a.rgba[i + 2] - a.rgba[i]);
    expect(colourOffsets.size).toBeGreaterThan(4);
    const mono = cavernRockPixels('rock-proof', 1600, biomePalette('engraving', 'underdark-caverns'));
    let grey = true;
    for (let i = 0; i < mono.rgba.length; i += 4) grey &&= mono.rgba[i] === mono.rgba[i + 1] && mono.rgba[i] === mono.rgba[i + 2];
    expect(grey).toBe(true);
  });
  it('replaces broad cultivation with exact generated rooms before both scene paths and labels, without changing the World', () => {
    const w = cavernWorld(), broad = rect(300, 300, 700), room = { outer: rect(450, 450, 30), holes: [rect(460, 460, 3)] };
    w.terrain.caverns!.fungalRooms = [room];
    w.landuse!.areas = [{ kind: 'garden', poly: broad, cultivation: 'fungal' }, { kind: 'commons', poly: rect(250, 250, 100) }];
    w.landuse!.landscapeGround = [];
    w.landuse!.farmsteads = [{ buildings: [rect(500, 500, 10)], yard: rect(490, 490, 30), pos: { x: 500, y: 500 }, angle: 0, drive: [{ x: 500, y: 500 }, { x: 550, y: 500 }],
      lot: broad, plots: [{ kind: 'garden', poly: broad }], walls: [[{ x: 300, y: 300 }, { x: 1000, y: 300 }]], trees: [{ x: 600, y: 600 }] }];
    Object.assign(w.landuse!, { ways: [[{ x: 200, y: 200 }, { x: 900, y: 900 }]], headlands: [[{ x: 200, y: 200 }, { x: 900, y: 900 }]] });
    w.urban = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, clusters: 1, landAreas: 0 }).urban;
    w.urban!.parcels = [{ poly: broad, use: 'garden', block: 0 }]; w.urban!.backLand = [{ outer: broad, holes: [] }];
    w.names = { family: 'english', town: 'Colony', entries: [{ id: 'old-farm', kind: 'farm', text: 'Old Orchard', rank: 6, anchor: { x: 500, y: 500 } }] };
    const before = JSON.stringify(w), projected = cavernDisplayWorld(w);
    expect(projected.landuse!.areas.map(a => a.kind)).toEqual(['commons']);
    expect(projected.landuse!.farmsteads[0].buildings).toBe(w.landuse!.farmsteads[0].buildings);
    expect(projected.landuse!.farmsteads[0].yard).toBe(w.landuse!.farmsteads[0].yard);
    expect(projected.landuse!.farmsteads[0].lot).toBeUndefined(); expect(projected.landuse!.farmsteads[0].plots).toEqual([]);
    expect(projected.urban!.parcels[0].use).toBe('commons'); expect(projected.urban!.backLand).toEqual([]);
    expect(projected.names!.entries).toEqual([]); expect(cavernDisplayWorld(w)).toBe(projected);
    const scene = new SceneBuilder().update(w);
    for (const name of ['lu-garden', 'farm-lots', 'farm-fungal-gardens', 'u-open-garden', 'u-backland']) expect(scene.poly.get(name)).toBeUndefined();
    expect(scene.lines.some(l => ['field-ways', 'headlands', 'farm-walls'].includes(l.name))).toBe(false);
    expect(scene.poly.get('cavern-fungal-rooms')?.polys).toEqual([room.outer]);
    expect(scene.renderedWorld?.names?.entries).toEqual([]);
    const svg = renderSvg(w, { raster: false });
    expect(svg).toContain('class="layer-cavern-cultivation"'); expect(svg).toContain('p-cavern-fungi'); expect(svg).not.toContain('Old Orchard');
    expect(svg).not.toContain('class="u-gardens"'); expect(svg).not.toContain('class="u-fields"');
    expect(cavernFungalRoomsSvg(projected, biomePalette('parchment', w.options.biome))).toContain('fill-rule="evenodd"');
    for (const deps of [{}, { scene }]) {
      const m = mockCanvas(900, 700), r = createCanvasRenderer(m.canvas as unknown as CanvasLike, w, 'parchment', { ...deps, raster: false, terrain: () => null, Path2D: ExactPath as never });
      r.draw({ cx: 600, cy: 600, scale: 2 });
      const fills = m.log.fills.filter(f => f.style === r.palette.land.garden && f.path instanceof ExactPath);
      expect(fills).toHaveLength(1); expect((fills[0].path as ExactPath).points).toContainEqual([463, 463]);
      expect(r.getMapInfo().legend.prims).toContainEqual(expect.objectContaining({ s: 'Fungal cultivation' })); r.dispose();
    }
    expect(JSON.stringify(w)).toBe(before);
    const ordinary = { ...w, options: { ...w.options, biome: 'underdark' as const } };
    expect(cavernDisplayWorld(ordinary)).toBe(ordinary); expect(ordinary.landuse!.areas[0].poly).toBe(broad);
    expect(cavernFungalRoomsSvg(ordinary, biomePalette('parchment', 'underdark'))).toBe('');
  });
  it('preserves Unicode in existing population and environment titles', () => {
    expect(fmtPop(1234)).toBe('1\u202f234');
    const w = cavernWorld(); w.options.workflow = 'environment';
    expect(townTitle(w).sub).toContain(' m \u00b7 underdark-caverns');
  });
});
