import { describe, expect, it } from 'vitest';
import { Resvg } from '@resvg/resvg-js';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { renderView } from '../src/gen/settlements/merge';
import { polygonArea } from '../src/gen/core/geom';
import { roadsLayer } from '../src/render/landuse';
import { urbanLayer } from '../src/render/urban';
import { buildScene } from '../src/render/scene';
import { createCanvasRenderer, type CanvasLike } from '../src/render/canvas';
import { PALETTES, ruralInk } from '../src/render/styles';
import { regionalBridgeSurface, regionalRoadSurface, urbanStrokeSpace } from '../src/render/roadSurfaces';
import { fakeWorld, mockCanvas, MockPath2D } from '../scripts/fakeworld';

function surfaceWorld(mapSize = 10000) {
  const w = fakeWorld({ mapSize, buildings: 0, streets: 0, landAreas: 0, clusters: 1, seed: 42 });
  w.options.labels = false;
  w.options.style = 'parchment';
  w.options.biome = 'temperate';
  w.terrain.coastline = [];
  w.terrain.lakes = [];
  w.terrain.islands = [];
  w.terrain.rivers = [];
  w.roads = [{ kind: 'major', width: 8, path: [{ x: 10, y: 50 }, { x: 90, y: 50 }] }];
  w.bridges = [];
  w.urban!.walls = [];
  w.urban!.quarters = [];
  w.urban!.blocks = [];
  w.urban!.blockInfo = [];
  w.urban!.parcels = [];
  w.urban!.buildings = [];
  w.urban!.masses = [];
  w.urban!.backLand = [];
  w.urban!.lines = [];
  w.urban!.landmarks = [];
  w.urban!.footprint = [];
  w.urban!.footprintH = [];
  w.urban!.water = [];
  w.urban!.squares = [];
  w.urban!.trees = [];
  w.urban!.sites = [];
  w.urban!.quays = [];
  w.landuse!.areas = [];
  w.landuse!.farmsteads = [];
  w.landuse!.reserve = [];
  return w;
}

describe('road surfaces', () => {
  it('keeps physical widths at close zoom and bounds far visibility to a pixel floor', () => {
    expect(regionalRoadSurface('major', 1).fill).toBe(8);
    expect(regionalRoadSurface('minor', 1).fill).toBe(3.6);
    expect(regionalRoadSurface('major', 0.16).fill).toBe(10);
    expect(regionalRoadSurface('minor', 0.16).fill).toBe(5);
    expect(regionalBridgeSurface(8, 1)).toEqual({ deck: 9, pad: 1.5, rail: 1.1 });
    expect(regionalBridgeSurface(8, 0.16)).toEqual({ deck: 12.5, pad: 1.5, rail: 6.25 });
  });

  it('reproduces the 10km p4uefz export without turning its 8m roads into 42.5m white bands', () => {
    const w = generate(makeOptions({ seed: 'p4uefz', size: 'town', mapSize: 10000 }));
    const svg = roadsLayer(w, PALETTES.parchment, 6.25);
    const fills = [...svg.matchAll(new RegExp(`stroke="${PALETTES.parchment.roadFill}" stroke-width="([\\d.]+)"`, 'g'))].map((m) => Number(m[1]));
    expect(fills).toContain(10);
    expect(fills.length).toBeGreaterThan(0);
    expect(Math.max(...fills)).toBe(10);
    expect(w.roads!.some((r) => r.kind === 'major')).toBe(true);
  }, 30000);

  it('keeps real macro graph faces in the clip before any quarter detail exists', () => {
    const w = generate(makeOptions({ seed: '42', size: 'city', mapSize: 10000, population: 100000, settlements: 'none' }));
    const macro = w.urban!.macro!;
    expect(macro).toBeDefined();
    expect(macro.quarters.length).toBeGreaterThan(0);
    const view = renderView(w), clips = urbanStrokeSpace(view.urban!);
    expect(clips.length).toBe(macro.quarters.length);
    for (let i = 0; i < clips.length; i++) expect(clips[i].outer).toEqual(macro.quarters[i].pts);
    expect(clips.some((clip, i) => polygonArea(clip.outer) > polygonArea(macro.quarters[i].inset) + 1)).toBe(true);
    expect(view.urban!.streets.some((st) => st.rank <= 1)).toBe(true);
  }, 30000);

  it('uses the same bounded regional surface in SVG and Canvas', () => {
    const w = surfaceWorld(), pal = PALETTES.parchment;
    const svg = roadsLayer(w, pal, 6.25);
    expect(svg).toContain(`stroke="${pal.roadFill}" stroke-width="10"`);
    const { canvas } = mockCanvas(1600, 1600);
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    const strokes: { color: unknown; width: number }[] = [];
    const stroke = ctx.stroke.bind(ctx);
    ctx.stroke = ((...args: unknown[]) => { strokes.push({ color: ctx.strokeStyle, width: ctx.lineWidth }); (stroke as (...xs: unknown[]) => void)(...args); }) as typeof ctx.stroke;
    const r = createCanvasRenderer(canvas as unknown as CanvasLike, w, pal, { Path2D: MockPath2D as unknown as new () => Path2D, terrain: () => null });
    r.draw({ cx: 5000, cy: 5000, scale: 0.16 });
    expect(strokes.filter((s) => s.color === pal.roadFill).map((s) => s.width)).toContain(10);
    expect(strokes.filter((s) => s.color === pal.roadEdge).map((s) => s.width)).toContain(21.25);
  });

  it('does not paint widened urban arterial ends outside the actual quarter', () => {
    const w = surfaceWorld(100);
    w.roads = [];
    const poly = [{ x: 40, y: 30 }, { x: 60, y: 30 }, { x: 60, y: 70 }, { x: 40, y: 70 }];
    w.urban!.quarters = [{ poly: { outer: poly, holes: [] }, phase: 1, zone: 'core', streetSpace: [] }];
    w.urban!.streets = [{ path: [{ x: 10, y: 50 }, { x: 90, y: 50 }], width: 1, rank: 0, role: 'radial', phase: 1, kind: 'main' }];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="#ff0000"/>${urbanLayer(w, PALETTES.parchment, 4, false)}</svg>`;
    const raster = new Resvg(svg).render();
    const pixel = (x: number, y: number) => [...raster.pixels.slice((y * 100 + x) * 4, (y * 100 + x) * 4 + 4)];
    expect(pixel(20, 50)).toEqual([255, 0, 0, 255]);
    expect(pixel(50, 50)).toEqual([244, 234, 208, 255]);
  });

  it('keeps quarter holes oppositely wound in the Canvas stroke clip without mutating geometry', () => {
    const w = surfaceWorld();
    const outer = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }];
    const hole = [{ x: 30, y: 30 }, { x: 30, y: 60 }, { x: 60, y: 60 }, { x: 60, y: 30 }];
    w.urban!.quarters = [{ poly: { outer, holes: [hole] }, phase: 1, zone: 'core', streetSpace: [] }];
    const before = JSON.stringify(w.urban!.quarters), clip = urbanStrokeSpace(w.urban!);
    expect(polygonArea(clip[0].outer)).toBeGreaterThan(0);
    expect(polygonArea(clip[0].holes[0])).toBeLessThan(0);
    const scene = buildScene(w);
    expect(scene.poly.get('u-stroke-space')!.holes![0]).toEqual(clip[0].holes);
    expect(JSON.stringify(w.urban!.quarters)).toBe(before);
  });

  it('falls back to legacy footprints and preserves positive winding of overlapping macro/detail pieces', () => {
    const w = surfaceWorld();
    const poly = { outer: [{ x: 40, y: 30 }, { x: 60, y: 30 }, { x: 60, y: 70 }, { x: 40, y: 70 }], holes: [] };
    w.urban!.footprintH = [poly];
    expect(urbanStrokeSpace(w.urban!)).toEqual([poly]);
    w.urban!.footprintH = [];
    w.urban!.footprint = [poly.outer];
    expect(urbanStrokeSpace(w.urban!)).toEqual([poly]);
    w.urban!.quarters = [
      { poly, phase: 1, zone: 'core', streetSpace: [] },
      { poly, phase: 1, zone: 'core', streetSpace: [] },
    ];
    const clips = urbanStrokeSpace(w.urban!);
    expect(clips).toHaveLength(2);
    expect(clips.every((p) => polygonArea(p.outer) > 0)).toBe(true);
  });

  it('renders rural landmark access tracks as earth dashes while preserving paved places and open paths', () => {
    const w = surfaceWorld();
    w.urban!.lines = [{ kind: 'track', path: [{ x: 10, y: 20 }, { x: 90, y: 20 }], width: 3 }];
    w.urban!.parcels = [{ use: 'place', block: -1, poly: [{ x: 30, y: 30 }, { x: 50, y: 30 }, { x: 50, y: 50 }, { x: 30, y: 50 }] }];
    const pal = PALETTES.parchment, svg = urbanLayer(w, pal, 1, false);
    expect(svg).toContain(`stroke="${ruralInk(pal)}" stroke-opacity="${pal.rural.track}"`);
    expect(svg).toContain('stroke-linecap="butt" stroke-dasharray="6 3.5"');
    expect(svg).toContain(`class="u-places"><path d="M30 30L50 30L50 50L30 50Z" fill="${pal.urban.place}"`);
    w.urban!.renderHints = { towerShape: 'round', openGround: true };
    expect(urbanLayer(w, pal, 1, false)).not.toContain('stroke-dasharray="6 3.5"');
    w.urban!.renderHints = { towerShape: 'round', stilts: true };
    const stilt = urbanLayer(w, pal, 1, false);
    expect(stilt).not.toContain('stroke-dasharray="6 3.5"');
    expect(stilt).toContain(`stroke="${pal.urban.street}" stroke-opacity="1" stroke-width="3" stroke-linecap="round"`);
  });
});
