import { describe, expect, it } from 'vitest';
import type { Polygon, UrbanLayer, World } from '../src/gen/types';
import { groundAppearance, worldGroundAppearance, earthCourt } from '../src/gen/landuse/groundAppearance';
import { urbanLandscapeGround, currentLandscapeGround } from '../src/gen/landuse/landscapeGround';
import { mpArea, intersectionS, differenceSafeS } from '../src/gen/geo/bool';
import { plotLines } from '../src/render/plotLines';
import { campCover } from '../src/render/campCover';
import { buildScene } from '../src/render/scene';
import { SceneBuilder } from '../src/render/sceneCache';
import { worldForRender } from '../src/ui/renderWorld';
import type { MacroQuarter } from '../src/gen/urban/mega/types';
import { renderSvg } from '../src/render/svg';
import { createCanvasRenderer, type CanvasLike } from '../src/render/canvas';
import { biomePalette } from '../src/render/biomes';
import { selectLod } from '../src/render/lod';
import { pathD } from '../src/render/util';
import { fakeWorld, mockCanvas, MockPath2D } from '../scripts/fakeworld';

const rect = (x: number, y: number, w: number, h = w): Polygon => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const piece = (outer: Polygon) => ({ outer, holes: [] });
function fixture(): World {
  const w = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, landAreas: 0 });
  w.options.contours = false; w.options.labels = false; w.roads = []; w.settlements = [];
  w.terrain.rivers = []; w.terrain.lakes = []; w.terrain.coastline = [];
  w.landuse!.landscapeGround = [];
  const u = w.urban!, garden = [rect(260, 300, 60), rect(570, 300, 60), rect(850, 300, 60)];
  u.footprint = [rect(200, 200, 800, 500)]; u.footprintH = u.footprint.map(piece);
  u.blocks = [rect(200, 200, 250, 500), rect(500, 200, 250, 500), rect(800, 200, 200, 500)];
  u.blockInfo = [{ kind: 'block', zone: 'core', quarter: 0, phase: 0 }, { kind: 'block', zone: 'edge', quarter: 0, phase: 1 }, { kind: 'compound', compound: 'castle', zone: 'core', quarter: 0, phase: 0 }];
  u.parcels = u.blocks.slice(0, 2).map((poly, block) => ({ poly, block, use: 'plot' }));
  u.parcels.push(...garden.map((poly, block) => ({ poly, block, use: 'garden' })), { poly: u.blocks[2], block: 2, use: 'compound:castle' });
  u.backLand = garden.map(piece); u.quarters = [{ poly: piece(u.footprint[0]), phase: 0, zone: 'core', streetSpace: [] }];
  u.walls = [{ path: u.footprint[0], thickness: 3, closed: true, gates: [], towers: [], role: 'town' }];
  u.streets = []; u.lines = [{ kind: 'hedge', path: rect(825, 280, 100), closed: true }]; u.landmarks = [];
  u.masses = []; u.culture = 'european-organic'; u.renderHints = { towerShape: 'round' };
  return w;
}
const ground = (s: ReturnType<typeof buildScene>) => { const l = s.poly.get('u-landscape-ground'); return l?.polys.map((outer, i) => ({ outer, holes: l.holes?.[i] ?? [] })) ?? []; };

describe('residential ground follows the landscape without erasing dedicated materials', () => {
  it('preserves irrigation materials across a worker snapshot and invalidates changed raster inputs', () => {
    const w = fixture(); w.options.biome = 'desert';
    w.site = { fields: { dWater: new Float32Array(128 * 128).fill(100), hab: new Float32Array(128 * 128).fill(10) } } as World['site'];
    const projected = worldForRender(w), builder = new SceneBuilder();
    expect(groundAppearance(projected.urban!, projected)).toEqual(groundAppearance(w.urban!, w));
    expect(builder.update(projected).poly.get('u-backland')!.polys).toEqual(buildScene(w).poly.get('u-backland')!.polys);
    const changed = { ...w, site: { ...w.site!, fields: { ...w.site!.fields, dWater: new Float32Array(128 * 128).fill(1000) } } };
    const dry = worldForRender(changed), retained = builder.update(dry), fresh = new SceneBuilder().update(dry);
    expect(retained.poly.get('u-backland')!.polys).toEqual(fresh.poly.get('u-backland')!.polys);
    expect(ground(retained)).toEqual(ground(fresh));
    expect(groundAppearance(dry.urban!, dry)).toEqual(groundAppearance(changed.urban!, changed));
    expect(retained.poly.get('u-backland')!.polys).toHaveLength(1);
    expect(w.site!.fields.dWater[0]).toBe(100);
  });

  it('accepts non-desert worker snapshots with a site but no analysis fields', () => {
    const w = fixture(); w.site = { fields: {} } as World['site'];
    const projected = worldForRender(w);
    expect(projected.site).not.toHaveProperty('fields');
    expect(() => new SceneBuilder().update(projected)).not.toThrow();
    expect(currentLandscapeGround(projected, true)).toEqual(currentLandscapeGround(w, true));
  });

  it('exposes peripheral yards while retaining core and compound gardens in temperate/forest settlements', () => {
    for (const biome of ['temperate', 'forest'] as const) {
      const w = fixture(); w.options.biome = biome;
      const before = JSON.stringify(w), material = groundAppearance(w.urban!, w);
      expect(material.natural).toEqual([w.urban!.backLand[1]]);
      expect(material.gardens).toEqual([w.urban!.backLand[0], w.urban!.backLand[2]]);
      const visible = currentLandscapeGround(w, true);
      expect(mpArea(intersectionS(visible, material.natural))).toBeCloseTo(3600, 6);
      expect(mpArea(intersectionS(visible, material.gardens))).toBeLessThan(1e-6);
      expect(JSON.stringify(w)).toBe(before);
      expect(mpArea(intersectionS(urbanLandscapeGround(w), w.urban!.backLand))).toBeLessThan(1e-6);
    }
  });

  it('puts dry Sahel residential ground and lanes on the desert but keeps citadel paving and water untouched', () => {
    const w = fixture(); w.options.biome = 'desert'; w.urban!.culture = 'sahel';
    w.terrain.lakes = [rect(620, 450, 40)];
    const material = groundAppearance(w.urban!, w), visible = currentLandscapeGround(w, true);
    expect(material.natural).toHaveLength(2); expect(material.gardens).toEqual([w.urban!.backLand[2]]);
    expect(material.earthStreets).toBe(true);
    expect(mpArea(intersectionS(visible, rect(465, 300, 20)))).toBeCloseTo(400, 6);
    expect(mpArea(intersectionS(visible, w.urban!.blocks[2]))).toBeLessThan(1e-6);
    expect(mpArea(intersectionS(visible, w.terrain.lakes[0]))).toBeLessThan(1e-6);
  });

  it('retains irrigated gardens, orchards and graves instead of flattening them into sand', () => {
    const w = fixture(); w.options.biome = 'desert';
    w.site = { fields: { dWater: new Float32Array(128 * 128).fill(100), hab: new Float32Array(128 * 128).fill(10) } } as World['site'];
    expect(groundAppearance(w.urban!, w).natural).toHaveLength(0);
    w.site!.fields.dWater.fill(1000);
    w.urban!.landmarks.push({ kind: 'orchard', poly: w.urban!.backLand[0].outer });
    expect(groundAppearance(w.urban!, w).gardens).toContain(w.urban!.backLand[0]);
    w.urban!.renderHints!.graves = true;
    expect(groundAppearance(w.urban!, w).gardens).toEqual(w.urban!.backLand);
  });

  it('allows an open steppe camp to share natural cover while keeping fields and physical mud/pens dedicated', () => {
    const w = fixture(), u = w.urban!; w.options.biome = 'steppe';
    u.renderHints!.openGround = true; u.walls = []; u.lines = []; u.backLand = [];
    const green = rect(220, 220, 50), field = rect(300, 220, 50), pen = rect(400, 220, 50), mud = rect(220, 400, 50);
    u.parcels = [{ poly: green, use: 'green', block: 0 }, { poly: field, use: 'field', block: 0 }, { poly: pen, use: 'pen', block: 0 }];
    u.landmarks = [{ kind: 'mud', poly: mud }, { kind: 'camp-ground', poly: rect(180, 180, 840, 540) }];
    const visible = currentLandscapeGround(w, true);
    expect(mpArea(intersectionS(visible, green))).toBeCloseTo(2500, 6);
    expect(mpArea(intersectionS(visible, rect(185, 185, 10)))).toBeCloseTo(100, 6);
    expect(mpArea(intersectionS(currentLandscapeGround(w), rect(185, 185, 10)))).toBeLessThan(1e-6);
    for (const p of [field, pen, mud]) expect(mpArea(intersectionS(visible, p))).toBeLessThan(1e-6);
  });

  it('keeps each secondary settlement policy and invalidates retained scenes when the biome changes', () => {
    const w = fixture(), other: UrbanLayer = { ...w.urban!, renderHints: { towerShape: 'round', graves: true } };
    w.settlements = [{ index: 1, main: false, urban: other } as never];
    const material = worldGroundAppearance(w);
    expect(material.natural).toHaveLength(1); expect(material.gardens).toHaveLength(5);
    w.settlements = [];
    const builder = new SceneBuilder(), first = builder.update(w), builds = builder.stats.staticBuilds;
    const changed = { ...w, options: { ...w.options, biome: 'desert' as const }, urban: { ...w.urban!, culture: 'sahel' } };
    const next = builder.update(changed), exact = currentLandscapeGround(changed, true);
    expect(builder.stats.staticBuilds).toBe(builds + 1);
    expect(mpArea(ground(next))).toBeGreaterThan(mpArea(ground(first)));
    expect(mpArea(differenceSafeS(ground(next), exact)) + mpArea(differenceSafeS(exact, ground(next)))).toBeLessThan(1e-6);
    expect(next.poly.get('u-backland')!.polys).toEqual([w.urban!.backLand[2].outer]);
  });

  it('removes only administrative plot border intervals and keeps inner cadastre and real defences', () => {
    const w = fixture(), u = w.urban!, lines = plotLines(u);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every(([a, b]) => !(a.y === b.y && [200, 700].includes(a.y)) && !(a.x === 200 && b.x === 200))).toBe(true);
    expect(lines.some(([a, b]) => a.x === 450 && b.x === 450)).toBe(true);
    const partial = { ...u, footprintH: [piece(rect(200, 200, 100, 100))], parcels: [{ poly: rect(150, 200, 200, 100), use: 'plot', block: 0 }] };
    expect(plotLines(partial).filter(([a, b]) => a.y === 200 && b.y === 200)).toEqual([[{ x: 150, y: 200 }, { x: 200, y: 200 }], [{ x: 300, y: 200 }, { x: 350, y: 200 }]]);
    const scene = buildScene(w), svg = renderSvg(w, { raster: false, labels: false, cartouche: false });
    expect(scene.lines.some((l) => l.role === 'wall')).toBe(true);
    expect(scene.lines.some((l) => l.kind === 'hedge')).toBe(true);
    expect(scene.lines.some((l) => l.role === 'plot')).toBe(true);
    expect(svg).toContain('class="u-walls"'); expect(svg).toContain('class="u-plots"');
    expect(svg.match(/<path class="u-streets"[^>]*>/)![0]).not.toContain('stroke=');
    const m = mockCanvas(900, 700), ctx = m.canvas.getContext('2d') as Record<string, unknown>, strokes: [unknown, unknown][] = [];
    ctx.stroke = () => { strokes.push([ctx.strokeStyle, ctx.lineWidth]); };
    const renderer = createCanvasRenderer(m.canvas as unknown as CanvasLike, w, 'parchment', { Path2D: MockPath2D as never, dpr: 1, terrain: () => null });
    renderer.draw({ cx: 600, cy: 450, scale: 0.6 });
    const pal = biomePalette('parchment', w.options.biome);
    expect(strokes).not.toContainEqual([pal.urban.street, 0.4]);
    expect(strokes.some(([color]) => color === pal.urban.wall)).toBe(true);
    m.reset(); renderer.draw({ cx: 600, cy: 450, scale: 0.04 });
    expect(m.log.fills.some((f) => f.style === pal.ink && f.alpha === 0.07 * selectLod(0.04).densityAlpha)).toBe(false);
  });

  it('keeps desert lanes natural through a footprint-free macro detail handover and an owner replacement', () => {
    const w = fixture(); w.options.biome = 'desert';
    const detail = { ...w.urban!, culture: undefined, renderHints: undefined, morphology: 'sahel-town',
      blockInfo: w.urban!.blockInfo.map((b) => ({ ...b, culture: 'sahel' })), footprint: [], footprintH: [], quarters: [], walls: [], lines: [] };
    const owner = { ...w.urban!, culture: 'sahel', blocks: [], blockInfo: [], parcels: [], backLand: [], walls: [], lines: [] };
    const poly = owner.footprint[0], q: MacroQuarter = { id: 0, pts: poly, inset: rect(210, 210, 780, 480), lab: [-1, -1, -1, -1], phase: 1, zone: 'edge', age: 40,
      kind: 'quarter', morph: 0, culture: 'sahel', density: 80, pop: 500, district: 'suburb', nucleus: 0, wants: [], area: 400000, bb: [200, 200, 1000, 700] };
    owner.macro = { version: 1, seedKey: 'ground-material', eagerPop: 1, population: 500, center: { x: 600, y: 450 }, mainAngle: 0, terrainAngle: 0,
      waterAngle: 0, cityR: 500, ctxRadius: 600, streets: [], quarters: [q], nuclei: [{ p: { x: 600, y: 450 }, kind: 'main', r: 500 }], morphs: [], wallRings: [], rings: [] };
    w.urban = owner;
    const builder = new SceneBuilder(); builder.update(w);
    const next = { ...w, megaDetail: { 0: detail } }, scene = builder.update(next), exact = currentLandscapeGround(next, true);
    expect(mpArea(intersectionS(ground(scene), rect(465, 300, 20)))).toBeCloseTo(400, 6);
    expect(mpArea(differenceSafeS(ground(scene), exact)) + mpArea(differenceSafeS(exact, ground(scene)))).toBeLessThan(1e-6);
    const oldBuilds = builder.stats.partBuilds, changedOwner = { ...owner, footprintH: [piece(rect(180, 180, 850, 540))] };
    builder.update({ ...next, urban: changedOwner });
    expect(builder.stats.partBuilds).toBeGreaterThan(oldBuilds);
  });

  it('exposes Sahel house courts and tags their own earth paths without changing a paved secondary town', () => {
    const w = fixture(), u = w.urban!; w.options.biome = 'desert'; u.culture = 'sahel';
    const earth = rect(280, 480, 20), paved = rect(850, 480, 20);
    u.buildings = [{ poly: rect(270, 470, 40), kind: 'house', arch: 'sudano-sahelian-house', courtyards: [earth] },
      { poly: rect(840, 470, 40), kind: 'house', arch: 'domus', courtyards: [paved] }];
    u.streets = [{ path: [{ x: 465, y: 220 }, { x: 465, y: 670 }], width: 8, rank: 0, role: 'street', kind: 'main', phase: 0 }];
    const other = { ...u, culture: 'european-organic', streets: [{ ...u.streets[0] }] };
    w.settlements = [{ index: 1, main: false, urban: other } as never];
    const before = JSON.stringify(w), scene = new SceneBuilder().update(w), material = worldGroundAppearance(w);
    expect(material.streetSources).toEqual(u.streets);
    expect(earthCourt(u.buildings[0], w)).toBe(true); expect(earthCourt(u.buildings[1], w)).toBe(false);
    expect(scene.poly.get('u-patios')!.polys).toEqual([paved, paved]);
    expect(scene.lines.filter((l) => l.role === 'street').map((l) => l.kind).sort()).toEqual(['r0', 'r0e']);
    const svg = renderSvg(w, { raster: false, labels: false, cartouche: false }), patios = svg.match(/<g class="u-patios">[^]*?<\/g>/)![0];
    expect(patios).toContain(pathD(paved, true)); expect(patios).not.toContain(pathD(earth, true));
    expect(JSON.stringify(w)).toBe(before);
  });

  it('repairs only an open camp exterior reserve with neighbouring real cover and protects fields, pens, water and clearings', () => {
    const w = fixture(), u = w.urban!; w.options.biome = 'steppe';
    u.renderHints!.openGround = true; u.footprint = [rect(600, 600, 200)]; u.footprintH = u.footprint.map(piece);
    u.blocks = []; u.blockInfo = []; u.backLand = []; u.squares = []; u.walls = []; u.lines = [];
    const field = rect(585, 620, 10, 30), pen = rect(585, 680, 10, 30), mud = rect(585, 740, 10, 20), lake = rect(805, 620, 10, 30);
    u.parcels = [{ poly: pen, use: 'pen', block: 0 }];
    u.landmarks = [{ kind: 'camp-ground', poly: rect(590, 590, 220) }, { kind: 'mud', poly: mud }];
    w.terrain.lakes = [lake];
    w.landuse!.areas = [{ kind: 'pasture', poly: rect(0, 0, 1600), holes: [rect(580, 580, 240)] }, { kind: 'field', poly: field }];
    const before = JSON.stringify(w), patches = campCover(w, u), pieces = patches.map((a) => ({ outer: a.poly, holes: a.holes ?? [] }));
    expect(patches.length).toBeGreaterThan(0); expect(patches.every((a) => a.kind === 'pasture')).toBe(true);
    expect(mpArea(intersectionS(pieces, rect(585, 650, 10, 20)))).toBeCloseTo(200, 6);
    for (const p of [field, pen, mud, lake, u.footprint[0]]) expect(mpArea(intersectionS(pieces, p))).toBeLessThan(1e-6);
    expect(mpArea(intersectionS(pieces, w.landuse!.areas.map((a) => ({ outer: a.poly, holes: a.holes ?? [] }))))).toBeLessThan(1e-6);
    expect(mpArea(intersectionS(currentLandscapeGround(w, true), field))).toBeLessThan(1e-6);
    const full = buildScene(w), cached = new SceneBuilder().update(w);
    expect(cached.poly.get('u-cover-pasture')!.polys).toEqual(full.poly.get('u-cover-pasture')!.polys);
    expect(cached.textures.find((t) => t.kind === 'pasture')!.areas).toEqual(full.textures.find((t) => t.kind === 'pasture')!.areas);
    expect(renderSvg(w, { raster: false, labels: false, cartouche: false })).toContain('class="u-cover-pasture"');
    expect(JSON.stringify(w)).toBe(before);
  });

  it('invalidates camp reserve patches when a neighbouring owner arrives and fails closed without nearby natural evidence', () => {
    const w = fixture(), u = w.urban!; u.renderHints!.openGround = true;
    u.footprint = [rect(600, 600, 200)]; u.footprintH = u.footprint.map(piece); u.blocks = []; u.blockInfo = [];
    u.backLand = []; u.squares = []; u.parcels = []; u.walls = []; u.lines = [];
    u.landmarks = [{ kind: 'camp-ground', poly: rect(590, 590, 220) }];
    w.landuse!.areas = [{ kind: 'pasture', poly: rect(0, 0, 1600), holes: [rect(580, 580, 240)] }];
    const builder = new SceneBuilder(), first = builder.update(w), oldBuilds = builder.stats.partBuilds;
    const occupied = rect(585, 640, 10, 30), neighbour = { ...u, footprint: [occupied], footprintH: [piece(occupied)],
      renderHints: { towerShape: 'round' as const }, landmarks: [] };
    const next = builder.update({ ...w, settlements: [{ index: 1, main: false, urban: neighbour } as never] });
    const covers = (s: typeof next) => s.poly.get('u-cover-pasture')!.polys.map((outer, i) => ({ outer, holes: s.poly.get('u-cover-pasture')!.holes?.[i] ?? [] }));
    expect(mpArea(intersectionS(covers(first), occupied))).toBeCloseTo(300, 6);
    expect(mpArea(intersectionS(covers(next), occupied))).toBeLessThan(1e-6);
    expect(builder.stats.partBuilds).toBeGreaterThan(oldBuilds + 1); expect(next.dirty!.length).toBeGreaterThan(0);
    expect(campCover({ ...w, landuse: { ...w.landuse!, areas: [] } }, u)).toEqual([]);
    expect(campCover({ ...w, terrain: { ...w.terrain, rivers: [{ path: [{ x: NaN, y: 0 }, { x: 1, y: 1 }], width: [1, 1] } as never] } }, u)).toEqual([]);
  });
});
