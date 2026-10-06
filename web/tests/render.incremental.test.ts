import { describe, expect, it } from 'vitest';
import type { Polygon, UrbanLayer, World, Settlement } from '../src/gen/types';
import { MEGA_KEY, type MacroQuarter } from '../src/gen/urban/mega/types';
import { LandscapeGroundCache, currentLandscapeGround } from '../src/gen/landuse/landscapeGround';
import { differenceSafeS, mpArea } from '../src/gen/geo/bool';
import { buildScene } from '../src/render/scene';
import { renderView } from '../src/gen/settlements/merge';
import { SceneBuilder } from '../src/render/sceneCache';
import { RasterTileCache } from '../src/render/rasterTiles';
import { TileIndex, boxesOf } from '../src/render/tileindex';
import { createCanvasRenderer, type CanvasLike } from '../src/render/canvas';
import { fakeWorld, mockCanvas, MockPath2D } from '../scripts/fakeworld';

const rect = (x: number, y: number, width: number): Polygon => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + width }, { x, y: y + width }];
const piece = (outer: Polygon) => ({ outer, holes: [] });

function fixture(): World {
  const w = fakeWorld({ mapSize: 2400, buildings: 0, streets: 0, landAreas: 0 });
  w.options.contours = false; w.options.labels = false; w.options.landuse = true;
  w.terrain.rivers = []; w.terrain.lakes = [rect(500, 350, 40)]; w.roads = []; w.settlements = [];
  w.landuse!.areas = [{ kind: 'meadow', poly: rect(100, 100, 2000) }]; w.landuse!.landscapeGround = [];
  const u = w.urban!;
  u.footprint = []; u.footprintH = []; u.walls = []; u.quarters = []; u.blocks = []; u.blockInfo = []; u.parcels = []; u.masses = [];
  const quarters = [200, 1400].map((x, id): MacroQuarter => ({ id, pts: rect(x, 200, 400), inset: rect(x + 10, 210, 380),
    lab: [0, 0, 0, 0], phase: 1, zone: 'middle', age: 100, kind: 'quarter', morph: 0, culture: 'european-organic',
    density: 140, pop: 1000, district: 'town', nucleus: 0, wants: [], area: 160000, bb: [x, 200, x + 400, 600] }));
  u.quarters = quarters.map((q) => ({ poly: piece(q.pts), phase: 1, zone: 'middle', streetSpace: [] }));
  u.macro = { version: 1, seedKey: 'incremental', eagerPop: 1, population: 2000, center: { x: 1200, y: 400 }, mainAngle: 0,
    terrainAngle: 0, waterAngle: 0, cityR: 1000, ctxRadius: 1200, streets: [], quarters,
    nuclei: [{ p: { x: 1200, y: 400 }, kind: 'main', r: 1000 }], morphs: [], wallRings: [], rings: [] };
  return w;
}

function detail(w: World): UrbanLayer {
  const poly = rect(220, 220, 350), roof = rect(250, 250, 30);
  return { ...w.urban!, macro: undefined, footprint: [], footprintH: [], quarters: [{ poly: piece(poly), phase: 1, zone: 'middle', streetSpace: [] }],
    blocks: [poly], blockInfo: [{ quarter: 0, phase: 1, zone: 'middle', kind: 'block' }],
    parcels: [{ poly, use: 'plot', block: 0 }, { poly: rect(300, 400, 40), use: 'market', block: 0 }],
    buildings: [{ poly: roof, kind: 'house', parcel: 0 }], masses: [piece(roof)] };
}

describe('incremental urban scene', () => {
  it('prepares only the replaced quarter and retains static and unaffected tile identities', () => {
    const w = fixture(), builder = new SceneBuilder(), before = builder.update(w), initialBuilds = builder.stats.partBuilds;
    const nearOther = before.poly.get('u-masses')!.index.tileAt(1600, 400);
    const otherKey = before.poly.get('u-masses')!.tileKeys![nearOther];
    const next = { ...w, megaDetail: { 0: detail(w) } }, after = builder.update(next), legacy = buildScene(next);
    expect(after.renderedWorld?.urban).toEqual(renderView(next).urban);
    expect(builder.stats.staticBuilds).toBe(1); expect(builder.stats.partBuilds - initialBuilds).toBe(1);
    expect(after.poly.get('lu-meadow')).toBe(before.poly.get('lu-meadow')); expect(after.textures).toBe(before.textures);
    expect(after.poly.get('u-masses')!.tileKeys![nearOther]).toBe(otherKey);
    for (const [name, layer] of legacy.poly) if (name !== 'u-landscape-ground' && name !== 'u-stroke-space') {
      if (name === 'u-forest-clearings') {
        // Exclusions are a union; retained parts group quarters by owner.
        const shapes = (l: typeof layer) => l.polys.map((outer, i) => JSON.stringify({ outer, holes: l.holes?.[i] ?? [] })).sort();
        expect(shapes(after.poly.get(name)!)).toEqual(shapes(layer));
        continue;
      }
      expect(after.poly.get(name)?.polys, name).toEqual(layer.polys);
      expect(after.poly.get(name)?.polys.map((_, i) => after.poly.get(name)?.holes?.[i]), name).toEqual(layer.polys.map((_, i) => layer.holes?.[i]));
    }
    const ground = after.poly.get('u-landscape-ground')!;
    const parts = ground.polys.map((outer, i) => ({ outer, holes: ground.holes?.[i] ?? [] }));
    expect(mpArea(differenceSafeS(parts, currentLandscapeGround(next)))).toBeLessThan(0.01);
    expect(mpArea(differenceSafeS(currentLandscapeGround(next), parts))).toBeLessThan(0.01);
    expect(after.dirty?.length).toBe(2);
    const dropped = builder.update(w);
    expect(dropped.poly.get('u-bldg')).toBeUndefined(); expect(builder.stats.staticBuilds).toBe(1);
  });

  it('requires explicit versions for in-place geometry changes and invalidates on terrain replacement', () => {
    const w = fixture(), layer = detail(w), cache = new LandscapeGroundCache(); cache.prepare(w);
    const a = cache.layer(layer); layer.parcels.push({ poly: rect(400, 250, 80), use: 'market', block: 0 });
    expect(cache.layer(layer)).toBe(a); const b = cache.layer(layer, 1); expect(mpArea(b)).toBeLessThan(mpArea(a));
    cache.prepare({ ...w, terrain: { ...w.terrain, lakes: [rect(220, 220, 350)] } });
    expect(mpArea(cache.layer(layer, 1))).toBe(0);
    cache.prepare({ ...w, terrain: { ...w.terrain, rivers: [{ path: [{ x: 0, y: 400 }, { x: 2400, y: 400 }], width: [NaN, 20], main: true }] } });
    expect(cache.layer(layer, 1)).toEqual([]);
  });

  it('invalidates shared macro quarter objects when their immutable owner and nucleus change', () => {
    const w = fixture(), builder = new SceneBuilder(), before = builder.update(w), n = builder.stats.partBuilds;
    const owner = { ...w.urban!, parcels: [{ poly: rect(300, 300, 100), use: 'market', block: 0 }],
      macro: { ...w.urban!.macro!, nuclei: [{ p: { x: 2100, y: 1800 }, kind: 'main' as const, r: 1000 }] } };
    const after = builder.update({ ...w, urban: owner });
    expect(builder.stats.partBuilds - n).toBe(3);
    const area = (scene: ReturnType<typeof buildScene>) => { const l = scene.poly.get('u-landscape-ground')!; return mpArea(l.polys.map((outer, i) => ({ outer, holes: l.holes?.[i] ?? [] }))); };
    expect(area(after)).toBeLessThan(area(before));
    expect(after.poly.get('u-masses')!.polys).not.toEqual(before.poly.get('u-masses')!.polys);
  });

  it('retains exact merged metadata and street painter order across secondary macros, lazy plans and drops', () => {
    const w = fixture();
    const street = (rank: number, width: number): UrbanLayer['streets'][number] => ({ path: [{ x: 100, y: 1000 }, { x: 2100, y: 1000 }], rank, width, role: 'street', kind: 'street', phase: 1 });
    w.urban!.streets = [street(1, 8)];
    const quarters = w.urban!.macro!.quarters.map((q, id) => ({ ...q, kind: id === 0 ? 'market' as const : q.kind }));
    const secondary = { ...w.urban!, macro: { ...w.urban!.macro!, quarters }, streets: [street(0, 6)] };
    const settlement = (index: number, urban?: UrbanLayer): Settlement => ({ index, key: `s${index}`, cls: 'town', population: 1000,
      culture: 'european-organic', center: { x: 1200, y: 1400 }, archetype: 'plain', radius: 400,
      extent: rect(1000, 1200, 400), region: rect(900, 1100, 600), detail: 'lazy', urban });
    w.settlements = [settlement(1, secondary), settlement(2)];
    const first = detail(w), second = { ...detail(w), streets: [street(3, 3)] };
    const builder = new SceneBuilder();
    for (const snapshot of [w, { ...w, megaDetail: { 0: first, [MEGA_KEY + 1]: second } }, w]) {
      const scene = builder.update(snapshot), legacy = buildScene(snapshot);
      expect(scene.renderedWorld?.urban).toEqual(renderView(snapshot).urban);
      expect(scene.lines.map(({ name, lines }) => ({ name, lines }))).toEqual(legacy.lines.map(({ name, lines }) => ({ name, lines })));
    }
    const noMain = { ...w, urban: undefined };
    expect(builder.update(noMain).counts).toEqual(buildScene(noMain).counts);
  });
});

describe('retained raster resources', () => {
  it('evicts by byte budget, protects hits and closes only affected tiles', () => {
    const closed: number[] = [], cache = new RasterTileCache<number>(20);
    const put = (n: number) => cache.put(String(n), { value: n, bounds: { minX: n * 100, minY: 0, maxX: n * 100 + 10, maxY: 10 }, bytes: 10, release: () => closed.push(n) });
    put(1); put(2); expect(cache.get('1')).toBe(1); put(3); expect(closed).toEqual([2]); expect(cache.bytes).toBe(20);
    cache.invalidate([{ minX: 99, minY: 0, maxX: 111, maxY: 10 }]); expect(closed).toEqual([2, 1]); expect(cache.get('3')).toBe(3);
    cache.clear(); expect(closed).toEqual([2, 1, 3]); expect(cache.bytes).toBe(0);
  });

  it('reuses rasterized geometry on camera frames, invalidates paint options and rejects style reuse', () => {
    const w = fixture(), builder = new SceneBuilder(), scene = builder.update(w), main = mockCanvas(900, 700);
    const renderer = createCanvasRenderer(main.canvas as unknown as CanvasLike, w, 'parchment', { scene, Path2D: MockPath2D as never,
      dpr: 1, terrain: () => null, createCanvas: (width, height) => mockCanvas(width, height).canvas as unknown as CanvasLike });
    const view = { cx: 450, cy: 400, scale: 1 };
    const first = renderer.draw(view); expect(first.rasterBuilt).toBeGreaterThan(0);
    main.reset(); const warm = renderer.draw({ ...view, cx: view.cx + 1 });
    expect(warm.rasterHits).toBeGreaterThan(0); expect(warm.rasterBuilt).toBe(0); expect(main.log.calls.drawImage).toBeGreaterThan(0);
    expect(renderer.update({ ...w, options: { ...w.options, landuse: false } }, builder.update(w))).toBe(true);
    expect(renderer.draw(view).rasterBuilt).toBeGreaterThan(0);
    expect(renderer.update(w, scene, 'night')).toBe(false);
    renderer.update(w, scene); renderer.draw(view);
    const wide = (x: number, width: number) => {
      const lines = [[{ x, y: 200 }, { x, y: 600 }]];
      return { name: 'wide-wall', role: 'wall', kind: 'wall', width, lines, index: new TileIndex(w.mapSize, 250, boxesOf(lines)) };
    };
    renderer.update(w, { ...scene, lines: [wide(5000, 1000)], dirty: [{ minX: 5000, minY: 200, maxX: 5000, maxY: 600 }] });
    renderer.draw(view); // Cached tiles can remain from before this increase outside the viewport.
    renderer.update(w, { ...scene, lines: [wide(1400, 1001)], dirty: [{ minX: 1400, minY: 200, maxX: 1400, maxY: 600 }] });
    expect(renderer.draw(view).rasterBuilt).toBeGreaterThan(0); // A much wider new stroke reaches old cached tiles.
    renderer.dispose();
  });
});
