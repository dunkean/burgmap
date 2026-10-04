import { describe, expect, it, vi } from 'vitest';
import polygonClipping from 'polygon-clipping';
import type { Polygon, PolyH, UrbanLayer } from '../src/gen/types';
import { mpArea, intersectionS, differenceSafeS } from '../src/gen/geo/bool';
import { countrysideFringe, FRINGE_ALPHA, FRINGE_PAINT, FRINGE_ORDER } from '../src/render/countryside';
import { buildScene } from '../src/render/scene';
import { renderSvg } from '../src/render/svg';
import { biomePalette } from '../src/render/biomes';
import { createCanvasRenderer, type CanvasLike } from '../src/render/canvas';
import { fakeWorld, mockCanvas, MockPath2D } from '../scripts/fakeworld';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';

const rect = (x: number, y: number, w: number, h = w): Polygon => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];
const world = () => {
  const w = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, landAreas: 0 });
  w.terrain.rivers = []; w.terrain.lakes = []; w.terrain.coastline = []; w.terrain.islands = []; w.roads = []; w.options.labels = false;
  const u = w.urban!;
  u.walls = []; u.blocks = []; u.quarters = []; u.parcels = [];
  u.footprint = [rect(200, 200, 600)]; u.footprintH = [{ outer: u.footprint[0], holes: [rect(210, 400, 80)] }];
  u.streets = [{ path: [{ x: 200, y: 300 }, { x: 400, y: 300 }], width: 4, rank: 2, kind: 'street', role: 'street', phase: 0 }];
  return w;
};
const all = (u: ReturnType<typeof countrysideFringe>): PolyH[] => u.ground;

describe('countryside ground at open settlement edges', () => {
  it('keeps the true footprint, holes and dedicated places intact without changing the World', () => {
    const w = world(), u = w.urban!;
    u.parcels = [{ poly: rect(220, 210, 40), use: 'market', block: -1 }];
    w.terrain.lakes = [rect(600, 210, 80)];
    const before = JSON.stringify(w), f = countrysideFringe(w);
    expect(mpArea(all(f))).toBeGreaterThan(0);
    expect(mpArea(intersectionS(all(f), [{ outer: rect(210, 400, 80), holes: [] }]))).toBeLessThan(1e-6);
    expect(mpArea(intersectionS(all(f), u.parcels[0].poly))).toBeLessThan(1e-6);
    expect(mpArea(intersectionS(all(f), w.terrain.lakes[0]))).toBeLessThan(1e-6);
    expect(mpArea(intersectionS(all(f), rect(350, 350, 300)))).toBeLessThan(1e-6);
    for (let i = 0; i + 1 < f.bands.length; i++) {
      expect(mpArea(differenceSafeS(f.bands[i], f.bands[i + 1]))).toBeLessThan(1e-6);
    }
    expect(JSON.stringify(w)).toBe(before);
  });

  it('applies walls per settlement and leaves existing transparent cultures alone', () => {
    const w = world(), main = w.urban!;
    const other: UrbanLayer = { ...main, footprint: [rect(900, 200, 500)], footprintH: [{ outer: rect(900, 200, 500), holes: [] }] };
    main.walls = [{ path: main.footprint[0], closed: true, thickness: 3, gates: [], towers: [], role: 'town' }];
    w.settlements = [{ urban: other, main: false } as never];
    expect(mpArea(all(countrysideFringe(w)))).toBeGreaterThan(0);
    expect(mpArea(intersectionS(all(countrysideFringe(w)), main.footprintH))).toBeLessThan(1e-6);
    other.renderHints = { towerShape: 'round', openGround: true };
    expect(all(countrysideFringe(w))).toHaveLength(0);
    other.renderHints = { towerShape: 'round', stilts: true };
    expect(all(countrysideFringe(w))).toHaveLength(0);
  });

  it('keeps a primitive city with a town palisade opaque without UrbanWall records', () => {
    const w = world(), u = w.urban!;
    u.renderHints = { towerShape: 'round' };
    u.walls = [];
    u.phases = [{ id: 0, kind: 'core', zone: 'core', region: u.footprintH, walled: true, fossil: false }];
    u.lines = [{ path: u.footprint[0], kind: 'palisade', closed: true }];
    expect(all(countrysideFringe(w))).toHaveLength(0);
    expect(buildScene(w).poly.has('u-country-fringe-0')).toBe(false);
    expect(renderSvg(w, { raster: false, labels: false })).not.toContain('class="u-country-fringe"');
    u.phases[0].walled = false;
    u.lines = [];
    expect(mpArea(all(countrysideFringe(w)))).toBeGreaterThan(0);
  });

  it('protects landmark grounds and squares even when they have no parcels', () => {
    const w = world(), u = w.urban!;
    u.landmarks = [{ kind: 'sahn', poly: rect(250, 210, 40) }, { kind: 'camp-ground', poly: rect(650, 210, 40) }];
    u.squares = [rect(720, 210, 40)];
    const f = countrysideFringe(w);
    expect(mpArea(all(f))).toBeGreaterThan(0);
    for (const poly of [...u.landmarks.map((l) => l.poly), ...u.squares]) expect(mpArea(intersectionS(all(f), poly))).toBeLessThan(1e-6);
  });

  it('draws the same ordinary village fringe with an open or stilt main town', () => {
    for (const mainKind of ['openGround', 'stilts'] as const) {
      const w = world(), main = w.urban!;
      const other: UrbanLayer = { ...main, footprint: [rect(900, 200, 500)], footprintH: [{ outer: rect(900, 200, 500), holes: [] }] };
      main.renderHints = { towerShape: 'round', [mainKind]: true };
      w.settlements = [{ urban: other, main: false } as never];
      const pal = biomePalette('parchment', w.options.biome), m = mockCanvas(900, 700);
      const r = createCanvasRenderer(m.canvas as unknown as CanvasLike, w, 'parchment', { Path2D: MockPath2D as never, dpr: 1, terrain: () => null });
      r.draw({ cx: 1050, cy: 350, scale: 0.6 });
      expect(m.log.fills.some((f) => f.style === pal.land.pasture && Math.abs(f.alpha - FRINGE_PAINT[0] * pal.landOpacity) < 1e-8)).toBe(true);
      expect(renderSvg(w, { style: 'parchment', raster: false, labels: false })).toContain('class="u-country-fringe"');
    }
  });

  it('batches fringe streets with the same half-meter rounding in SVG and Canvas', () => {
    const w = world();
    w.urban!.streets[0].width = 4.12;
    w.urban!.streets.push({ ...w.urban!.streets[0], width: 4.22 });
    const ls = buildScene(w).lines.filter((l) => l.role === 'fringe-street');
    expect(ls).toHaveLength(1); expect(ls[0].width).toBe(4);
    const svg = renderSvg(w, { raster: false, labels: false });
    expect(svg.match(/id="country-fringe-streets"[^]*?<\/g>/)?.[0]).toContain('stroke-width="4"');
  });

  it('shares exact bands with the Canvas scene and restores streets only below roofs', () => {
    const w = world(), f = countrysideFringe(w), scene = buildScene(w);
    f.bands.forEach((b, i) => {
      expect(scene.poly.get('u-country-fringe-' + i)?.polys ?? []).toEqual(b.map((p) => p.outer));
      expect(scene.poly.get('u-country-fringe-' + i)?.holes ?? []).toEqual(b.map((p) => p.holes.length ? p.holes : undefined));
    });
    const svg = renderSvg(w, { raster: false, labels: false, legend: false, cartouche: false });
    expect(svg).toContain('class="u-country-fringe"');
    expect(svg).toContain('id="country-fringe-streets"');
    expect(svg).not.toContain('href="#terrain-ground"');
    expect(svg.indexOf('class="u-country-fringe"')).toBeLessThan(svg.indexOf('u-buildings'));
    expect(FRINGE_ALPHA[0]).toBeGreaterThan(FRINGE_ALPHA[7]);
  });

  it('protects macro landmark quarters and detailed gardens on open megacity plans', () => {
    const w = world(), u = w.urban!;
    const lot = rect(240, 210, 40), garden = rect(650, 210, 40);
    u.macro = { quarters: [{ kind: 'lot', district: 'palace', pts: lot }] } as unknown as UrbanLayer['macro'];
    w.megaDetail = { 1: { ...u, macro: undefined, backLand: [{ outer: garden, holes: [] }] } };
    const f = countrysideFringe(w);
    expect(mpArea(all(f))).toBeGreaterThan(0);
    expect(mpArea(intersectionS(all(f), lot))).toBeLessThan(1e-6);
    expect(mpArea(intersectionS(all(f), garden))).toBeLessThan(1e-6);
  });

  it('unions phase pieces before extracting countryside boundaries', () => {
    const w = world(), u = w.urban!;
    u.footprintH = [{ outer: rect(200, 200, 300, 600), holes: [] }, { outer: rect(500, 200, 300, 600), holes: [] }];
    const f = countrysideFringe(w);
    expect(mpArea(all(f))).toBeGreaterThan(0);
    expect(mpArea(intersectionS(all(f), rect(490, 400, 20, 200)))).toBeLessThan(1e-6);
  });

  it('leaves a lake shore and the edge of another settlement out of the rural transition', () => {
    const w = world(), u = w.urban!;
    w.terrain.lakes = [rect(400, 100, 400, 100)];
    const other: UrbanLayer = { ...u, footprintH: [{ outer: rect(800, 200, 400, 600), holes: [] }], footprint: [rect(800, 200, 400, 600)] };
    w.settlements = [{ urban: other, main: false } as never];
    const f = countrysideFringe(w);
    expect(mpArea(all(f))).toBeGreaterThan(0);
    expect(mpArea(intersectionS(all(f), rect(480, 200, 250, 75)))).toBeLessThan(1e-6);
    expect(mpArea(intersectionS(all(f), rect(725, 380, 150, 200)))).toBeLessThan(1e-6);
    expect(mpArea(intersectionS(all(f), rect(200, 400, 30, 200)))).toBeGreaterThan(0);
  });

  it('invalidates geometry caches for in-place footprint and water edits, including options clones', () => {
    const w = world(), initial = countrysideFringe(w), area = mpArea(all(initial));
    expect(countrysideFringe({ ...w, options: { ...w.options, labels: true } })).toEqual(initial);
    w.urban!.footprintH[0].outer[1].x = 1000;
    w.urban!.footprintH[0].outer[2].x = 1000;
    expect(mpArea(all(countrysideFringe(w)))).not.toBeCloseTo(area);
    const beforeWater = mpArea(all(countrysideFringe(w)));
    w.terrain.lakes.push(rect(200, 100, 800, 100));
    const afterWater = mpArea(all(countrysideFringe(w)));
    expect(afterWater).toBeLessThan(beforeWater);
    w.terrain.lakes[0][1].x = 300;
    w.terrain.lakes[0][2].x = 300;
    expect(mpArea(all(countrysideFringe(w)))).toBeGreaterThan(afterWater);
  });

  it('preserves concave footprints and narrow lobes with nested alpha regions', () => {
    const w = world(), u = w.urban!;
    u.footprintH = [{ outer: [
      { x: 200, y: 200 }, { x: 800, y: 200 }, { x: 800, y: 260 }, { x: 300, y: 260 },
      { x: 300, y: 700 }, { x: 800, y: 700 }, { x: 800, y: 800 }, { x: 200, y: 800 },
    ], holes: [] }];
    const f = countrysideFringe(w);
    expect(mpArea(all(f))).toBeGreaterThan(0);
    expect(mpArea(intersectionS(all(f), rect(400, 350, 200)))).toBeLessThan(1e-6);
    for (let i = 0; i + 1 < f.bands.length; i++) expect(mpArea(differenceSafeS(f.bands[i], f.bands[i + 1]))).toBeLessThan(1e-6);
  });

  it('rounds concave corner joins without square diagonal teeth and preserves footprint containment', () => {
    const w = world(), u = w.urban!;
    u.footprintH = [{ outer: [
      { x: 200, y: 200 }, { x: 800, y: 200 }, { x: 800, y: 400 },
      { x: 400, y: 400 }, { x: 400, y: 800 }, { x: 200, y: 800 },
    ], holes: [] }];
    const depth = Math.sqrt(mpArea(u.footprintH)) * 0.12 / 8;
    const diagonal = rect(400 - 0.95 * depth - 0.1, 400 - 0.95 * depth - 0.1, 0.2);
    const f = countrysideFringe(w);
    // This point is sqrt(2)*0.95*d from the reflex corner: outside a round d join, inside the old square.
    expect(mpArea(intersectionS(f.bands[0], diagonal))).toBeLessThan(1e-6);
    expect(mpArea(intersectionS(f.bands[1], diagonal))).toBeGreaterThan(0.035);
    expect(mpArea(differenceSafeS(f.ground, u.footprintH))).toBeLessThan(1e-6);
  });

  it('covers a 30 m arm at a 45 m band depth without a cancellation seam', () => {
    const w = world(), u = w.urban!;
    u.footprintH = [{ outer: [
      { x: 200, y: 200 }, { x: 800, y: 200 }, { x: 800, y: 800 }, { x: 500, y: 800 },
      { x: 500, y: 1100 }, { x: 470, y: 1100 }, { x: 470, y: 800 }, { x: 200, y: 800 },
    ], holes: [] }];
    const f = countrysideFringe(w), arm = rect(472, 820, 26, 200);
    expect(mpArea(intersectionS(f.ground, arm))).toBeCloseTo(26 * 200, 3);
    // The 600 m core sets the total depth above 72 m, so band five reaches at least 45 m.
    expect(mpArea(intersectionS(f.bands[4], arm))).toBeCloseTo(26 * 200, 3);
  });

  it('keeps a large subdivided ring and its narrow arm inside exact ground while simplifying only alpha classification', () => {
    const w = world(), u = w.urban!;
    const outline = [
      { x: 200, y: 200 }, { x: 800, y: 200 }, { x: 800, y: 800 }, { x: 500, y: 800 },
      { x: 500, y: 1100 }, { x: 470, y: 1100 }, { x: 470, y: 800 }, { x: 200, y: 800 },
    ];
    const dense = outline.flatMap((a, i) => {
      const b = outline[(i + 1) % outline.length], dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy), steps = Math.ceil(len / 2);
      return Array.from({ length: steps }, (_, j) => {
        const t = j / steps, noise = j ? 0.15 * Math.sin(j) : 0;
        return { x: a.x + dx * t - dy * noise / len, y: a.y + dy * t + dx * noise / len };
      });
    });
    u.footprintH = [{ outer: dense, holes: [rect(210, 400, 80)] }];
    u.parcels = [{ poly: rect(230, 210, 40), use: 'market', block: -1 }];
    const before = JSON.stringify(u), f = countrysideFringe(w);
    expect(dense.length).toBeGreaterThan(1000);
    expect(mpArea(differenceSafeS(f.ground, u.footprintH))).toBeLessThan(1e-6);
    expect(mpArea(intersectionS(f.ground, u.parcels[0].poly))).toBeLessThan(1e-6);
    expect(mpArea(intersectionS(f.ground, rect(340, 350, 300)))).toBeLessThan(1e-6);
    expect(mpArea(intersectionS(f.ground, rect(472, 820, 26, 200)))).toBeCloseTo(5200, 3);
    expect(mpArea(intersectionS(f.bands[4], rect(472, 820, 26, 200)))).toBeCloseTo(5200, 3);
    // The first nested region still covers the actual undulating border after the bounded classification simplification.
    expect(mpArea(intersectionS(f.bands[0], rect(320, 201, 100, 1)))).toBeCloseTo(100, 3);
    for (let i = 0; i + 1 < f.bands.length; i++) {
      expect(mpArea(differenceSafeS(f.bands[i], f.bands[i + 1]))).toBeLessThan(1e-6);
    }
    expect(JSON.stringify(u)).toBe(before);
    expect(countrysideFringe({ ...w, options: { ...w.options, labels: true } })).toEqual(f);
  });

  it('keeps a 10 m river and the first 60 m of its dry bank out of the fringe', () => {
    const w = world(), u = w.urban!;
    u.footprintH = [{ outer: rect(200, 200, 600), holes: [] }];
    w.terrain.rivers = [{ path: [{ x: 200, y: 100 }, { x: 200, y: 900 }], width: [10, 10], main: true }];
    const f = countrysideFringe(w);
    expect(mpArea(all(f))).toBeGreaterThan(0);
    expect(mpArea(intersectionS(f.ground, rect(207, 210, 60, 570)))).toBeLessThan(1e-6);
  });

  it('handles duplicated boundary vertices with finite, bounded geometry', () => {
    const w = world(), u = w.urban!;
    u.footprintH[0].outer.splice(1, 0, { ...u.footprintH[0].outer[0] });
    const f = countrysideFringe(w);
    expect(mpArea(f.ground)).toBeGreaterThan(0);
    for (const p of f.ground) for (const v of [p.outer, ...p.holes].flat()) {
      expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true);
      expect(v.x).toBeGreaterThanOrEqual(200); expect(v.x).toBeLessThanOrEqual(800);
      expect(v.y).toBeGreaterThanOrEqual(200); expect(v.y).toBeLessThanOrEqual(800);
    }
    u.footprintH[0].outer[0].x = Infinity;
    expect(countrysideFringe(w).ground).toHaveLength(0);
  });

  it('restores fringe streets once per Canvas frame and obeys block LOD', () => {
    const w = world(), m = mockCanvas(900, 700), ctx = m.canvas.getContext('2d') as Record<string, unknown>;
    const widths: number[] = [], stroke = ctx.stroke as (...args: unknown[]) => void;
    ctx.stroke = (...args: unknown[]) => { if (ctx.strokeStyle === biomePalette('parchment', w.options.biome).urban.street && Number(ctx.lineWidth) === 4) widths.push(4); stroke(...args); };
    const r = createCanvasRenderer(m.canvas as unknown as CanvasLike, w, 'parchment', { Path2D: MockPath2D as never, dpr: 1, terrain: () => null });
    r.draw({ cx: 300, cy: 300, scale: 0.6 });
    expect(widths).toHaveLength(1);
    m.reset(); widths.length = 0;
    r.draw({ cx: 300, cy: 300, scale: 0.02 });
    expect(widths).toHaveLength(0);
    expect(m.log.fills.some((f) => f.style === biomePalette('parchment', w.options.biome).land.pasture && Math.abs(f.alpha - FRINGE_PAINT[0] * biomePalette('parchment', w.options.biome).landOpacity) < 1e-8)).toBe(false);
  });

  it('clips a shared river window once for disconnected footprints and preserves every local bank guard', () => {
    const w = world(), u = w.urban!;
    u.footprintH = [rect(200, 200, 400), rect(900, 200, 400), rect(2500, 200, 400)]
      .map((outer) => ({ outer, holes: [] }));
    w.terrain.lakes = [rect(150, 100, 1200, 100)];
    const before = JSON.stringify(w), original = polygonClipping.intersection;
    let waterWindows = 0;
    const spy = vi.spyOn(polygonClipping, 'intersection').mockImplementation((...args) => {
      const first = args[0] as unknown as number[][][][];
      if (first[0]?.[0]?.some(([x, y]) => x === 150 && y === 100)) waterWindows++;
      return original(...args);
    });
    try {
      const f = countrysideFringe(w);
      expect(waterWindows).toBe(1);
      expect(mpArea(f.ground)).toBeGreaterThan(0);
      for (const x of [200, 900]) expect(mpArea(intersectionS(f.ground, rect(x, 200, 400, 75)))).toBeLessThan(1e-6);
      expect(mpArea(intersectionS(f.ground, rect(920, 590, 360, 9)))).toBeGreaterThan(3000);
      expect(mpArea(intersectionS(f.ground, rect(2520, 201, 360, 9)))).toBeGreaterThan(3000);
      expect(mpArea(differenceSafeS(f.ground, u.footprintH))).toBeLessThan(1e-6);
      expect(JSON.stringify(w)).toBe(before);
      expect(countrysideFringe({ ...w, options: { ...w.options, labels: true } })).toEqual(f);
      expect(waterWindows).toBe(1);
    } finally { spy.mockRestore(); }
  });

  it('clips detailed map-wide coastal water with islands before local padding', () => {
    const w = world(); w.mapSize = 40000;
    const shore = Array.from({ length: 8001 }, (_, i) => ({ x: 40000 - i * 5, y: 200 + 0.5 * (i % 2) }));
    w.terrain.coastline = [[{ x: 0, y: 0 }, { x: 40000, y: 0 }, ...shore]];
    w.terrain.islands = [rect(400, 120, 40), rect(20000, 140, 40)];
    const first = countrysideFringe(w);
    expect(mpArea(first.ground)).toBeGreaterThan(0);
    expect(mpArea(intersectionS(first.ground, rect(300, 201, 400, 75)))).toBeLessThan(1e-6);
    expect(countrysideFringe({ ...w, options: { ...w.options, labels: true } })).toEqual(first);
  });

  it('composes nested edge regions from widest to narrowest with the intended opacity profile', () => {
    const w = world(), f = countrysideFringe(w);
    expect(mpArea(f.bands[0])).toBeLessThan(mpArea(f.bands[7]));
    expect(mpArea(differenceSafeS(f.bands[7], f.ground))).toBeLessThan(1e-6);
    expect(mpArea(differenceSafeS(f.ground, f.bands[7]))).toBeLessThan(1e-6);
    let alpha = 0;
    for (const i of FRINGE_ORDER) {
      alpha = 1 - (1 - alpha) * (1 - FRINGE_PAINT[i]);
      expect(alpha).toBeCloseTo(FRINGE_ALPHA[i], 12);
    }
    const svg = renderSvg(w, { raster: false, labels: false });
    expect(svg.indexOf('id="country-fringe-7"')).toBeLessThan(svg.indexOf('id="country-fringe-0"'));
  });

  it('omits interior and distant streets from the rural restoration network', () => {
    const w = world(), edge = w.urban!.streets[0];
    const interior = { ...edge, path: [{ x: 400, y: 400 }, { x: 600, y: 400 }] };
    const distant = { ...edge, path: [{ x: 1300, y: 1300 }, { x: 1500, y: 1500 }] };
    w.urban!.streets.push(interior, distant);
    w.megaDetail = { 1: { ...w.urban!, streets: [distant], parcels: [], landmarks: [], squares: [] } };
    expect(countrysideFringe(w).streets).toEqual([edge]);
  });

  it('fails closed if only the water-window boolean engine fails after edge regions are cached', () => {
    const w = world();
    expect(countrysideFringe(w).ground.length).toBeGreaterThan(0);
    w.terrain.lakes = [rect(600, 100, 60)];
    const original = polygonClipping.intersection;
    let waterCalls = 0;
    const spy = vi.spyOn(polygonClipping, 'intersection').mockImplementation((...args) => {
      const inputs = args as unknown as number[][][][][];
      if (inputs[0]?.[0]?.[0]?.some(([x, y]) => x === 600 && y === 100) &&
          inputs[1]?.[0]?.[0]?.some(([x, y]) => x === 0 && y === 0)) {
        waterCalls++;
        throw new Error('water-window intersection failed');
      }
      return original(...args);
    });
    try {
      expect(countrysideFringe(w)).toEqual({ bands: FRINGE_ALPHA.map(() => []), ground: [], streets: [] });
      expect(waterCalls).toBe(2);
    } finally { spy.mockRestore(); }
    expect(countrysideFringe(w).ground.length).toBeGreaterThan(0);
  });

  it('drops painted bands if their final intersection engine fails, without exposing a protected market', () => {
    const w = world();
    expect(countrysideFringe(w).bands.every((band) => band.length > 0)).toBe(true);
    w.urban!.parcels = [{ poly: rect(220, 210, 40), use: 'market', block: -1 }];
    const original = polygonClipping.intersection;
    let bandCalls = 0;
    const spy = vi.spyOn(polygonClipping, 'intersection').mockImplementation((...args) => {
      const inputs = args as unknown as number[][][][][];
      if (inputs[1]?.some((piece) => piece.some((ring) => ring.some(([x, y]) => x === 220 && y === 210)))) {
        bandCalls++;
        throw new Error('band-ground intersection failed');
      }
      return original(...args);
    });
    try {
      const f = countrysideFringe(w);
      // The independent difference succeeded; only the final band intersections fail on both engine attempts.
      expect(mpArea(f.ground)).toBeGreaterThan(0);
      expect(mpArea(differenceSafeS(w.urban!.parcels[0].poly, f.ground))).toBeCloseTo(1600, 6);
      expect(bandCalls).toBe(2 * FRINGE_ALPHA.length);
      expect(f.bands.every((band) => band.length === 0)).toBe(true);
      expect(mpArea(intersectionS(f.bands.flat(), w.urban!.parcels[0].poly))).toBe(0);
      expect(renderSvg(w, { raster: false, labels: false })).not.toContain('class="u-country-fringe"');
    } finally { spy.mockRestore(); }
  });

  it('keeps closed cultural enclosures opaque even without a walled phase', () => {
    for (const kind of ['palisade', 'turf-wall', 'kraal-fence', 'albarrada']) {
      const w = world(); w.urban!.lines = [{ kind, path: w.urban!.footprint[0], closed: true }];
      expect(countrysideFringe(w).ground).toHaveLength(0);
    }
  });

  it('fails closed when an unexpected geometry accessor throws', () => {
    const w = world();
    Object.defineProperty(w.urban!, 'footprintH', { get: () => { throw new Error('geometry unavailable'); } });
    expect(countrysideFringe(w)).toEqual({ bands: FRINGE_ALPHA.map(() => []), ground: [], streets: [] });
  });

  it('keeps the reported open city geometry unchanged while softening its ground', () => {
    const w = generate(makeOptions({ seed: 'p4uefz', size: 'city', culture: 'european-organic', walls: 'none', settlements: 'none' }));
    const before = JSON.stringify(w.urban), f = countrysideFringe(w);
    expect(mpArea(all(f))).toBeGreaterThan(1000);
    expect(JSON.stringify(w.urban)).toBe(before);
    const render = () => renderSvg(w, { style: 'parchment', raster: false, labels: false });
    expect(render()).toContain('class="u-country-fringe"');
    expect(render()).toContain('id="p-country-ground"');
    w.urban!.walls = [{ path: w.urban!.footprint[0], closed: true, thickness: 3, gates: [], towers: [], role: 'town' }];
    expect(render()).not.toContain('class="u-country-fringe"');
    expect(render()).not.toContain('id="p-country-ground"');
  }, 60_000);
});
