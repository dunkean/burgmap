import { describe, expect, it } from 'vitest';
import { Resvg } from '@resvg/resvg-js';
import type { World, Polygon, PolyH, UrbanLayer } from '../src/gen/types';
import { urbanLandscapeGround, currentLandscapeGround, landscapeCoverGround } from '../src/gen/landuse/landscapeGround';
import { groundAppearance } from '../src/gen/landuse/groundAppearance';
import { intersectionS, differenceSafeS, mpArea } from '../src/gen/geo/bool';
import { offsetRibbon, polygonContains, polygonArea } from '../src/gen/core/geom';
import { orientPos } from '../src/gen/geo/poly';
import { CULTURE_LIST } from '../src/gen/urban/cultures';
import { PALETTES, type MapStyle } from '../src/render/styles';
import { buildScene } from '../src/render/scene';
import { renderSvg } from '../src/render/svg';
import { createCanvasRenderer, type CanvasLike } from '../src/render/canvas';
import { biomePalette } from '../src/render/biomes';
import { pathEarth } from '../src/render/urban';
import { pathD } from '../src/render/util';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { megaQuarterDetail } from '../src/gen/urban/mega/detail';
import { MEGA_KEY } from '../src/gen/urban/mega/types';
import { fakeWorld, mockCanvas, MockPath2D } from '../scripts/fakeworld';

const rect = (x: number, y: number, w: number, h = w): Polygon => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];
const piece = (outer: Polygon): PolyH => ({ outer, holes: [] });
const fixture = () => {
  const w = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, landAreas: 0 });
  w.options.labels = false; w.options.contours = false;
  w.terrain.rivers = []; w.terrain.lakes = []; w.terrain.coastline = []; w.terrain.islands = [];
  w.roads = []; w.settlements = [];
  const u = w.urban!, outer = rect(200, 200, 600);
  u.footprint = [outer]; u.footprintH = [piece(outer)];
  u.quarters = [{ poly: piece(outer), phase: 0, zone: 'core', streetSpace: [] }];
  u.blocks = [rect(200, 200, 296, 600), rect(504, 200, 296, 600)];
  u.blockInfo = u.blocks.map(() => ({ kind: 'block', quarter: 0, phase: 0, zone: 'core' }));
  u.parcels = u.blocks.map((poly, block) => ({ poly, block, use: 'plot' }));
  u.parcels.push({ poly: rect(620, 300, 60), block: 1, use: 'market' });
  u.buildings = [{ poly: rect(310, 420, 30), kind: 'house', parcel: 0 }];
  u.masses = u.buildings.map((b) => piece(b.poly));
  u.streets = [{ path: [{ x: 500, y: 200 }, { x: 500, y: 800 }], width: 8, rank: 2, role: 'street', kind: 'street', phase: 0 }];
  u.walls = [{ path: outer, closed: true, thickness: 3, gates: [], towers: [], role: 'town' }];
  u.lines = []; u.landmarks = []; u.backLand = []; u.squares = [];
  w.landuse!.areas = [{ kind: 'forest', poly: rect(100, 100, 900) }];
  w.landuse!.landscapeGround = urbanLandscapeGround(w);
  return w;
};
const opts = { width: 1600, labels: false, legend: false, cartouche: false, contours: false };
const pixel = (img: ReturnType<Resvg['render']>, x: number, y: number): number[] => {
  const pixels = img.pixels;
  return Array.from(pixels.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
};
class RecordingPath extends MockPath2D {
  rings: Polygon[] = [];
  override moveTo(x = 0, y = 0): void { super.moveTo(); this.rings.push([{ x, y }]); }
  override lineTo(x = 0, y = 0): void { super.lineTo(); this.rings.at(-1)?.push({ x, y }); }
  contains(x: number, y: number): boolean {
    return this.rings.reduce((n, ring) => polygonContains(ring, { x, y }) ? n + Math.sign(polygonArea(ring)) : n, 0) !== 0;
  }
}

/** Capture the exact clip receiving the opaque base, rather than any earlier paper/background fill. */
function landscapeCanvas(w: World) {
  const m = mockCanvas(900, 700), ctx = m.canvas.getContext('2d') as Record<string, unknown>;
  const pal = biomePalette('parchment', w.options.biome);
  let clip: RecordingPath | undefined, landscape: RecordingPath | undefined;
  const stack: { clip?: RecordingPath; landscape?: RecordingPath }[] = [];
  const bases: RecordingPath[] = [], paths: { clip: RecordingPath; path: RecordingPath; color: unknown }[] = [];
  const fill = ctx.fill as (...args: unknown[]) => void, stroke = ctx.stroke as (...args: unknown[]) => void;
  ctx.save = () => { stack.push({ clip, landscape }); };
  ctx.restore = () => { const saved = stack.pop(); clip = saved?.clip; landscape = saved?.landscape; };
  ctx.clip = (p?: RecordingPath) => { clip = p; };
  ctx.fill = (...args: unknown[]) => {
    if (clip && args[0] === clip && ctx.fillStyle === pal.paper && ctx.globalAlpha === 1) {
      landscape = clip; bases.push(clip);
    }
    fill(...args);
  };
  ctx.stroke = (...args: unknown[]) => {
    if (landscape && args[0] instanceof RecordingPath) paths.push({ clip: landscape, path: args[0], color: ctx.strokeStyle });
    stroke(...args);
  };
  const renderer = createCanvasRenderer(m.canvas as unknown as CanvasLike, w, 'parchment',
    { Path2D: RecordingPath as never, dpr: 1, terrain: () => null });
  return { bases, paths, draw: (cx: number, cy: number) => renderer.draw({ cx, cy, scale: 0.6 }) };
}

function expectCanvasGround(w: World, ground: PolyH[], cx: number, cy: number): void {
  const canvas = landscapeCanvas(w); canvas.draw(cx, cy);
  const rings = ground.flatMap((p) => [orientPos(p.outer), ...p.holes.map((h) => orientPos(h).slice().reverse())]);
  // The clip now contains only viewport candidates. Every retained ring must still be exact,
  // and its nonzero membership must match the complete ground throughout the displayed view.
  const exactRings = new Set(rings.map((p) => JSON.stringify(p)));
  expect(canvas.bases.some((p) => p.rings.length > 0 && p.rings.every((r) => exactRings.has(JSON.stringify(r))))).toBe(true);
  for (let y = cy - 700 / 1.2; y < cy + 700 / 1.2; y += 20) for (let x = cx - 900 / 1.2; x < cx + 900 / 1.2; x += 20) {
    const inside = ground.some((p) => polygonContains(p.outer, { x, y }) && !p.holes.some((h) => polygonContains(h, { x, y })));
    expect(canvas.bases.some((p) => p.contains(x, y)), `ground at ${x},${y}`).toBe(inside);
  }
}

describe('opaque landscape ground across settlement models', () => {
  it('replaces every ordinary block up to its real edge while preserving street space, plazas and gardens', () => {
    const w = fixture(), u = w.urban!;
    u.backLand = [piece(rect(570, 550, 100))];
    const before = JSON.stringify(w), ground = urbanLandscapeGround(w);
    for (const poly of [rect(202, 250, 25), rect(750, 740, 30)]) {
      expect(mpArea(intersectionS(ground, poly))).toBeCloseTo(mpArea([piece(poly)]), 6);
    }
    for (const poly of [rect(496, 200, 8, 600), u.parcels[2].poly, u.backLand[0]]) {
      expect(mpArea(intersectionS(ground, poly))).toBeLessThan(1e-6);
    }
    expect(mpArea(differenceSafeS(ground, u.footprintH))).toBeLessThan(1e-6);
    expect(JSON.stringify(w)).toBe(before);
    u.lines = [{ kind: 'palisade', closed: true, path: u.footprint[0] }];
    expect(urbanLandscapeGround(w)).toEqual(ground);
  });

  for (const culture of CULTURE_LIST) it(`${culture.id}: all nine styles retain opaque land, real walls and physical paving`, () => {
    const w = fixture(), u = w.urban!;
    u.culture = culture.id; u.renderHints = { ...culture.render };
    u.lines = [{ kind: 'palisade', closed: true, path: rect(210, 210, 570) }];
    w.landuse!.landscapeGround = urbanLandscapeGround(w);
    const ground = currentLandscapeGround(w), scene = buildScene(w);
    expect(scene.poly.get('u-landscape-ground')?.polys ?? []).toEqual(ground.map((p) => p.outer));
    expect(scene.poly.has('block-edges')).toBe(false);
    expect(scene.lines.some((l) => l.role === 'wall')).toBe(true);
    for (const style of Object.keys(PALETTES) as MapStyle[]) {
      const svg = renderSvg(w, { ...opts, style, raster: false });
      expect(svg).not.toContain('class="u-block-edges"');
      expect(svg).not.toContain('class="u-country-fringe"');
      expect(svg).toContain('class="u-walls"');
      if (culture.render.stilts) expect(svg).not.toContain('class="u-landscape-ground"');
      else {
        expect(svg).toContain('class="u-landscape-ground"');
        const base = svg.match(/class="u-landscape-ground"[^]*?<path d="[^"]*" fill="[^"]*" fill-rule="nonzero"\/>/)?.[0];
        expect(base).toBeDefined(); expect(base).not.toContain('opacity=');
      }
      const m = mockCanvas(900, 700), pal = biomePalette(style, w.options.biome);
      const r = createCanvasRenderer(m.canvas as unknown as CanvasLike, w, style,
        { scene, Path2D: MockPath2D as never, dpr: 1, terrain: () => null });
      r.draw({ cx: 500, cy: 500, scale: 0.6 });
      if (!culture.render.stilts) expect(m.log.fills.some((f) => f.style === pal.paper && f.alpha === 1)).toBe(true);
    }
  });

  it('replays identical opaque hillshade across a walled edge when land-use drawing is disabled', () => {
    const w = fixture();
    const withTown = new Resvg(renderSvg(w, { ...opts, landuse: false })).render();
    const withoutTown = new Resvg(renderSvg({ ...w, urban: undefined }, { ...opts, landuse: false })).render();
    for (const [x, y] of [[205, 280], [480, 500], [780, 720]]) {
      expect(pixel(withTown, x, y)).toEqual(pixel(withoutTown, x, y));
      expect(pixel(withTown, x, y)[3]).toBe(255);
    }
    const townNoRaster = new Resvg(renderSvg(w, { ...opts, landuse: false, raster: false })).render();
    const outsideNoRaster = new Resvg(renderSvg({ ...w, urban: undefined }, { ...opts, landuse: false, raster: false })).render();
    expect(pixel(townNoRaster, 480, 500)).toEqual(pixel(outsideNoRaster, 480, 500));
  });

  it('uses the same nonzero ground clip for Canvas vegetation and excludes actual paving', () => {
    const w = fixture(), m = mockCanvas(900, 700), ctx = m.canvas.getContext('2d') as Record<string, unknown>;
    let clip: RecordingPath | undefined;
    const stack: (RecordingPath | undefined)[] = [], clips: RecordingPath[] = [];
    const fill = ctx.fill as (...args: unknown[]) => void, pal = biomePalette('parchment', w.options.biome);
    ctx.save = () => { stack.push(clip); }; ctx.restore = () => { clip = stack.pop(); };
    ctx.clip = (p: RecordingPath) => { clip = p; };
    ctx.fill = (...args: unknown[]) => { if (clip && ctx.fillStyle === pal.land.forest && ctx.globalAlpha === 0.7) clips.push(clip); fill(...args); };
    const r = createCanvasRenderer(m.canvas as unknown as CanvasLike, w, 'parchment',
      { Path2D: RecordingPath as never, dpr: 1, terrain: () => null });
    r.draw({ cx: 500, cy: 500, scale: 0.6 });
    expect(clips.some((p) => p.contains(480, 500))).toBe(true);
    for (const p of clips) { expect(p.contains(500, 500)).toBe(false); expect(p.contains(650, 330)).toBe(false); }
  });

  it('keeps the full visible river ribbon and sea/lake interiors protected while admitting a real dry bank and island', () => {
    const w = fixture(), u = w.urban!;
    u.blocks = [rect(200, 200, 600)]; u.parcels = [{ poly: u.blocks[0], use: 'plot', block: 0 }];
    w.terrain.coastline = [rect(200, 200, 240, 600), rect(250, 250, 100)]; // nested sea hole
    w.terrain.islands = [rect(260, 500, 100)];
    w.terrain.lakes = [rect(600, 300, 20, 250)];
    w.terrain.rivers = [{ path: [{ x: 700, y: 100 }, { x: 710, y: 440 }, { x: 680, y: 900 }], width: [9, 13, 18], main: true }];
    const ground = urbanLandscapeGround(w);
    const river = offsetRibbon(w.terrain.rivers[0].path, [12.4, 16.4, 21.4]);
    for (const water of [rect(200, 370, 240, 120), w.terrain.lakes[0], river]) expect(mpArea(intersectionS(ground, water))).toBeLessThan(1e-6);
    for (const dry of [rect(265, 265, 50), rect(280, 520, 50), rect(450, 400, 25)]) expect(mpArea(intersectionS(ground, dry))).toBeCloseTo(mpArea([piece(dry)]), 6);
  });

  it('hands a macro stand-in over to exact late gardens, shanty blocks and roofs without modifying stored ground', () => {
    const w = fixture(), u = w.urban!, plot = rect(200, 200, 600), garden = rect(560, 540, 100);
    u.macro = { quarters: [{ id: 0, kind: 'quarter', district: 'town', pts: plot, inset: [] }] } as unknown as UrbanLayer['macro'];
    w.landuse!.landscapeGround = urbanLandscapeGround(w);
    const snapshot = w.landuse!.landscapeGround, before = JSON.stringify(snapshot);
    const detailed: UrbanLayer = { ...u, macro: undefined, footprint: [], footprintH: [], quarters: [], blocks: [plot],
      blockInfo: [{ kind: 'shanty', phase: 0, quarter: 0, zone: 'faubourg' }],
      parcels: [{ poly: plot, use: 'hut-lot', block: 0 }], backLand: [piece(garden)],
      buildings: [{ poly: rect(300, 300, 6, 5), kind: 'hut', parcel: 0 }], masses: [piece(rect(300, 300, 6, 5))] };
    w.megaDetail = { 0: detailed };
    const ground = currentLandscapeGround(w);
    expect(mpArea(intersectionS(ground, garden))).toBeLessThan(1e-6);
    expect(mpArea(intersectionS(ground, rect(730, 720, 20)))).toBeCloseTo(400, 6);
    expect(mpArea(intersectionS(landscapeCoverGround(w, ground), detailed.buildings[0].poly))).toBeLessThan(1e-6);
    expect(w.landuse!.landscapeGround).toBe(snapshot); expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('uses secondary macro keys rather than a detail footprint to hand over only the owning host quarter', () => {
    const w = fixture(), main = w.urban!, local = rect(900, 200, 500), garden = rect(1050, 350, 100);
    main.macro = { quarters: [{ id: 0, kind: 'quarter', district: 'town', pts: main.footprint[0], inset: [] }] } as unknown as UrbanLayer['macro'];
    const secondary: UrbanLayer = { ...main, footprint: [local], footprintH: [piece(local)], parcels: [], backLand: [], streets: [],
      macro: { quarters: [{ id: 0, kind: 'quarter', district: 'town', pts: local, inset: [] }] } as unknown as UrbanLayer['macro'] };
    w.settlements = [{ main: false, index: 1, urban: secondary } as never];
    const detail: UrbanLayer = { ...secondary, macro: undefined, footprint: [], footprintH: [], quarters: [], blocks: [local],
      blockInfo: [{ kind: 'block', quarter: 0, phase: 0, zone: 'middle' }],
      parcels: [{ poly: local, block: 0, use: 'plot' }], backLand: [piece(garden)] };
    const before = urbanLandscapeGround(w);
    w.megaDetail = { [MEGA_KEY]: detail };
    const after = urbanLandscapeGround(w);
    expect(mpArea(intersectionS(before, garden))).toBeCloseTo(10000, 6);
    expect(mpArea(intersectionS(after, garden))).toBeLessThan(1e-6);
    expect(mpArea(intersectionS(after, main.footprintH))).toBeCloseTo(mpArea(intersectionS(before, main.footprintH)), 6);
    w.landuse!.landscapeGround = before;
    expect(buildScene(w).poly.get('u-landscape-ground')?.polys).toEqual(after.map((p) => p.outer));
    const clip = renderSvg(w, { ...opts, raster: false }).match(/id="urban-landscape-ground"[^]*?<\/clipPath>/)?.[0];
    for (const p of after) expect(clip).toContain(pathD(p.outer, true));
    expectCanvasGround(w, after, 1150, 450);
  });

  it('preserves dedicated gardens, paving and street gaps while exposing peripheral yards in actual footprint-free megaQuarterDetail output', () => {
    const w = generate(makeOptions({ seed: '42', mapSize: 4000, population: 60000, coast: 'S', siteType: 'harbor', walls: 'none' }));
    const plan = w.urban!.macro!, id = 98, detail = megaQuarterDetail(w, id)!;
    // Actual seeded shoreline detail: 30 ordinary blocks and 256 garden pieces on the reviewed producer.
    expect(detail.backLand.length).toBeGreaterThan(0);
    expect(detail.blockInfo.some((b) => b.kind === 'block')).toBe(true);
    expect(detail.footprintH).toEqual([]); expect(detail.quarters).toEqual([]);
    const before = JSON.stringify(w.landuse!.landscapeGround);
    w.megaDetail = { [id]: detail };
    const ground = currentLandscapeGround(w), quarter = plan.quarters[id];
    for (const poly of [...detail.backLand, ...detail.parcels.filter((p) => p.use !== 'plot' && p.use !== 'hut-lot').map((p) => piece(p.poly))]) {
      expect(mpArea(intersectionS(ground, poly))).toBeLessThan(0.01);
    }
    const gaps = differenceSafeS([piece(quarter.pts)], detail.blocks.map(piece));
    expect(mpArea(gaps)).toBeGreaterThan(0);
    expect(mpArea(intersectionS(ground, gaps))).toBeLessThan(0.01);
    expect(mpArea(intersectionS(ground, quarter.pts))).toBeGreaterThan(100);
    const displayed = currentLandscapeGround(w, true), material = groundAppearance(detail, w);
    for (const poly of [...material.gardens, ...detail.parcels.filter((p) => p.use !== 'plot' && p.use !== 'hut-lot' && !material.naturalParcels.has(p.poly)).map((p) => piece(p.poly))]) {
      expect(mpArea(intersectionS(displayed, poly))).toBeLessThan(0.01);
    }
    expect(mpArea(intersectionS(displayed, gaps))).toBeLessThan(0.01);
    expect(buildScene(w).poly.get('u-landscape-ground')?.polys).toEqual(displayed.map((p) => p.outer));
    const svg = renderSvg(w, { ...opts, width: 1000, raster: false });
    expect(svg).toContain('class="u-landscape-ground"');
    const clip = svg.match(/id="urban-landscape-ground"[^]*?<\/clipPath>/)?.[0];
    for (const p of displayed) expect(clip).toContain(pathD(p.outer, true));
    expectCanvasGround(w, displayed, w.site!.center.x, w.site!.center.y);
    expect(JSON.stringify(w.landuse!.landscapeGround)).toBe(before);
  }, 300000);

  for (const culture of ['barbarian-norse', 'native-iroquoian']) it(`${culture}: actual internal paths replay after the opaque terrain in SVG and Canvas`, () => {
    const w = generate(makeOptions({ seed: '1', mapSize: 3600, population: 1000, culture, relief: 'flat', river: 'none', settlements: 'none', walls: 'single' }));
    expect(w.urban!.renderHints?.openGround).toBe(true);
    expect(w.urban!.streets.length).toBeGreaterThan(0);
    const ground = currentLandscapeGround(w), path = w.urban!.streets.find((st) => mpArea(intersectionS(ground, [piece(offsetRibbon(st.path, st.path.map(() => st.width)))])) > 0.1);
    expect(path).toBeDefined(); // This exact producer geometry exercised the overwritten path pixels.
    const svg = renderSvg(w, { ...opts, raster: false });
    const replay = svg.match(/class="u-landscape-ground"[^]*?<g class="u-paths"[^]*?<\/g>/)?.[0];
    expect(replay).toContain(pathD(path!.path, false));
    expect(replay!.indexOf('class="u-natural-cover"')).toBeLessThan(replay!.indexOf('class="u-paths"'));
    const pal = biomePalette('parchment', w.options.biome), canvas = landscapeCanvas(w);
    canvas.draw(path!.path[0].x, path!.path[0].y);
    const color = path!.rank <= 1 && path!.width >= 6.5 ? pal.urban.street : pathEarth(pal);
    const replayPaths = canvas.paths.filter((p) => p.color === color);
    expect(replayPaths.some(({ path: p }) => p.rings.some((ring) => ring.some((v) =>
      v.x === path!.path[0].x && v.y === path!.path[0].y)))).toBe(true);
    expect(canvas.bases.length).toBeGreaterThan(0);
  }, 120000);
});
