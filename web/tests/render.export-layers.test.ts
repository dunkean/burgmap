import { describe, expect, it } from 'vitest';
import { Resvg } from '@resvg/resvg-js';
import { fakeWorld } from '../scripts/fakeworld';
import { renderSvg } from '../src/render/svg';
import { exportLayerPreset } from '../src/render/exportLayers';
import { exportSnapshot } from '../src/ui/exportSnapshot';
import type { Polygon } from '../src/gen/types';

const rect = (x: number, y: number, w: number, h = w): Polygon => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];
function fixture() {
  const world = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, landAreas: 0 });
  const urban = world.urban!, outer = rect(400, 400, 800);
  urban.quarters = [{ poly: { outer, holes: [] }, phase: 1, zone: 'core', streetSpace: [{ outer, holes: [rect(400, 400, 390, 800), rect(810, 400, 390, 800)] }] }];
  urban.footprint = [outer]; urban.footprintH = [{ outer, holes: [] }];
  urban.blocks = [rect(400, 400, 390, 800), rect(810, 400, 390, 800)];
  urban.blockInfo = urban.blocks.map(() => ({ kind: 'block', quarter: 0, phase: 1, zone: 'core' }));
  urban.parcels = []; urban.landmarks = []; urban.walls = [];
  urban.buildings = [{ poly: rect(500, 600, 80), kind: 'house' }];
  urban.masses = urban.buildings.map((b) => ({ outer: b.poly, holes: [] }));
  urban.streets = [{ path: [{ x: 800, y: 400 }, { x: 800, y: 1200 }], width: 20, rank: 2, kind: 'street', role: 'street', phase: 1 }];
  urban.water = [{ outer: rect(900, 700, 80), holes: [] }];
  world.roads = [{ path: [{ x: 100, y: 200 }, { x: 1500, y: 200 }], kind: 'major', width: 8 }];
  world.landuse!.areas = [{ kind: 'forest', poly: rect(100, 100, 100) }];
  world.terrain.rivers = []; world.terrain.lakes = [rect(200, 1000, 100)];
  world.options.contours = false; world.options.labels = false;
  return world;
}
const alpha = (svg: string, x: number, y: number) => {
  const image = new Resvg(svg, { fitTo: { mode: 'width', value: 1600 } }).render();
  return image.pixels[(y * image.width + x) * 4 + 3];
};

describe('SVG layers shared by SVG and PNG exports', () => {
  it('keeps the complete map identical when all layers are enabled', () => {
    const world = fixture();
    expect(renderSvg(world, { layers: exportLayerPreset('all') })).toBe(renderSvg(world));
  });

  it('exports town grounds and buildings on transparency without landscape, water or regional roads', () => {
    const svg = renderSvg(fixture(), { layers: exportLayerPreset('city') });
    expect(svg).toContain('class="u-buildings"');
    for (const part of ['class="layer-terrain"', 'class="layer-water"', 'class="layer-landuse"', 'class="layer-roads"', 'class="u-water"', 'class="layer-decor"', 'class="cartouche"']) expect(svg).not.toContain(part);
    expect(alpha(svg, 50, 50)).toBe(0);
    expect(alpha(svg, 540, 640)).toBe(255);
    expect(svg).not.toContain('href="#terrain-ground"');
  });

  it('exports both road networks without filling town blocks or including buildings', () => {
    const svg = renderSvg(fixture(), { layers: exportLayerPreset('roads') });
    expect(svg).toContain('class="layer-roads"'); expect(svg).toContain('class="u-streets"');
    expect(svg).not.toContain('class="u-buildings"'); expect(svg).not.toContain('class="u-blocks"');
    expect(alpha(svg, 800, 600)).toBeGreaterThan(0);
    expect(alpha(svg, 540, 640)).toBe(0);
    expect(alpha(svg, 600, 200)).toBeGreaterThan(0);
  });

  it('exports relief without towns, water, labels or decoration', () => {
    const svg = renderSvg(fixture(), { layers: exportLayerPreset('terrain') });
    expect(svg).toContain('class="layer-terrain"');
    for (const part of ['class="layer-urban"', 'class="layer-water"', 'class="layer-roads"', 'class="layer-decor"', 'class="cartouche"']) expect(svg).not.toContain(part);
  });

  it('keeps farms with buildings while exporting their drives with roads', () => {
    const world = fixture();
    world.landuse!.farmsteads = [{ pos: { x: 1300, y: 1300 }, angle: 0, yard: rect(1280, 1280, 100), buildings: [rect(1300, 1300, 40)], drive: [{ x: 1300, y: 1250 }, { x: 1300, y: 1280 }] }];
    const town = renderSvg(world, { layers: exportLayerPreset('city') });
    const roads = renderSvg(world, { layers: exportLayerPreset('roads') });
    expect(alpha(town, 1320, 1320)).toBeGreaterThan(0); expect(alpha(roads, 1320, 1320)).toBe(0);
    expect(alpha(town, 1300, 1260)).toBe(0); expect(alpha(roads, 1300, 1260)).toBeGreaterThan(0);
    expect(renderSvg(world, { layers: exportLayerPreset('all') })).toBe(renderSvg(world));
  });

  it('preserves stilt boardwalks and cultural footpaths in street-only exports', () => {
    const world = fixture();
    world.urban!.renderHints = { towerShape: 'round', stilts: true };
    world.urban!.lines = [{ kind: 'footpath', path: [{ x: 1250, y: 600 }, { x: 1250, y: 800 }] }];
    const roads = renderSvg(world, { layers: exportLayerPreset('roads') });
    expect(roads).toContain('class="u-boardwalks"');
    expect(alpha(roads, 1250, 700)).toBeGreaterThan(0);
    const town = renderSvg(world, { layers: { ...exportLayerPreset('city'), streets: false } });
    expect(alpha(town, 1250, 700)).toBe(0); expect(town).not.toContain('class="u-boardwalks"');
  });

  it('can export only natural and urban water, and hide streets independently', () => {
    const layers = exportLayerPreset('roads');
    for (const key of Object.keys(layers) as (keyof typeof layers)[]) layers[key] = key === 'water';
    const world = fixture(), svg = renderSvg(world, { layers });
    expect(svg).toContain('class="layer-water"'); expect(svg).toContain('class="u-water"');
    expect(svg).not.toContain('class="u-buildings"'); expect(svg).not.toContain('class="u-paths"');
    expect(alpha(svg, 940, 740)).toBeGreaterThan(0); expect(alpha(svg, 250, 1050)).toBeGreaterThan(0);
    const town = renderSvg(world, { layers: { ...exportLayerPreset('city'), streets: false } });
    expect(town).not.toContain('class="u-streets"'); expect(town).not.toContain('class="u-paths"');
    expect(town).toContain('class="u-buildings"');
  });

  it('captures layer choices before async exports and leaves the world unchanged', () => {
    const world = fixture(), layers = exportLayerPreset('city'), before = JSON.stringify(world);
    const snapshot = exportSnapshot(world.options, world, 1, 1, layers);
    layers.city = false;
    expect(snapshot.display.layers?.city).toBe(true);
    renderSvg(world, { layers: snapshot.display.layers });
    expect(JSON.stringify(world)).toBe(before);
  });
});
