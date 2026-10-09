import { describe, expect, it } from 'vitest';
import { createGrid } from '../src/gen/core/grid';
import { dist, polygonCentroid } from '../src/gen/core/geom';
import { Rng } from '../src/gen/core/rng';
import { applyOverride, fromQuery, makeOptions, toQuery } from '../src/gen/options';
import { generate } from '../src/gen/pipeline';
import { megaRadius } from '../src/gen/urban/mega/plan';
import { planSettlements } from '../src/gen/settlements/planner';
import { chooseSite } from '../src/gen/site/site';
import { resolvePosition } from '../src/gen/site/position';
import type { TerrainLayer, World } from '../src/gen/types';

function flatTerrain(size = 2000): TerrainLayer {
  const n = 100, cell = size / n, N = n * n;
  return {
    height: createGrid(n, n, cell, 30), slope: createGrid(n, n, cell), flow: createGrid(n, n, cell),
    water: new Uint8Array(N), filled: new Float32Array(N).fill(30), receiver: new Int32Array(N).fill(-1),
    rivers: [], lakes: [], coastline: [], seaLevel: 0, seaFraction: 0, downSide: 'S', seaSide: null,
  };
}

const importedHeight = { w: 16, h: 16, rgba: new Uint8Array(16 * 16 * 4).fill(180) };

describe('settlement centre overrides', () => {
  it('round-trips exact coordinates and rejects incomplete or nonfinite URL/preview coordinates', () => {
    const options = makeOptions({ center: { x: 850.25, y: 1234.5 }, settlements: { list: [{ population: 250, position: { x: 2200, y: 2400 } }] } });
    const back = fromQuery(toQuery(options));
    expect(back.center).toEqual(options.center);
    expect(back.settlements).toEqual(options.settlements);
    expect(toQuery(back)).toBe(toQuery(options));
    expect(toQuery(makeOptions())).toBe('seed=1');
    for (const value of ['', '1', '1,', ',2', '1,2,3', 'Infinity,2', 'NaN,2']) expect(fromQuery(`center=${value}`).center).toBeUndefined();
    const preview = makeOptions();
    applyOverride(preview, 'center', '850.25,1234.5');
    expect(preview.center).toEqual(options.center);
  });

  it('canonicalises fractional list positions to the same whole meters used by typed and clicked village centres', () => {
    const options = makeOptions({ center: { x: 850.25, y: 1234.5 }, settlements: { list: [{ population: 250, position: { x: 2200.25, y: 2400.75 } }] } });
    const back = fromQuery(toQuery(options));
    expect(back.settlements).toEqual({ list: [{ population: 250, position: { x: 2200, y: 2401 } }] });
    expect(back.center).toEqual(options.center);
    expect(toQuery(back)).toBe(toQuery(options));
    expect(fromQuery('settl=L250~~~2200.25~2400.75').settlements).toEqual(back.settlements);
  });

  it('uses the exact dry centre outside the automatic central band and roots its cost there', () => {
    const terrain = flatTerrain(), center = { x: 280, y: 1472 };
    const opts = makeOptions({ size: 'hamlet', relief: 'flat', river: 'none', center, sitePrefs: { weights: { hilltop: 100 } } });
    const site = chooseSite(terrain, opts, 2000, new Rng('magna-urbis:1'));
    expect(site.center).toEqual(center);
    expect(site.cost.data[Math.floor(center.y / 20) * 100 + Math.floor(center.x / 20)]).toBe(0);
    expect(site.warning).toBeUndefined();
    expect(site.archetype).toBe('plain');
  });

  it('corrects water, cliffs and off-map points deterministically; rejects a completely unusable map', () => {
    const terrain = flatTerrain();
    for (let y = 40; y <= 60; y++) for (let x = 40; x <= 60; x++) terrain.water[y * 100 + x] = 1;
    for (let y = 40; y <= 60; y++) for (let x = 61; x <= 68; x++) terrain.slope.data[y * 100 + x] = 1;
    const constraints = { inset: 80, slopeMax: 0.3 };
    const wet = { x: 1010, y: 1010 };
    const a = resolvePosition(terrain, 2000, wet, constraints)!;
    expect(a).toEqual(resolvePosition(terrain, 2000, wet, constraints));
    const i = Math.floor(a.y / 20) * 100 + Math.floor(a.x / 20);
    expect(terrain.water[i]).toBe(0);
    expect(terrain.slope.data[i]).toBeLessThanOrEqual(0.3);
    expect(resolvePosition(terrain, 2000, { x: -1000, y: 5000 }, constraints)).toEqual({ x: 80, y: 1920 });
    terrain.water.fill(1);
    expect(resolvePosition(terrain, 2000, wet, constraints)).toBeNull();
  });

  it('warns when the main requested centre moves, with a dry travel-cost origin', () => {
    const terrain = flatTerrain();
    for (let y = 40; y <= 60; y++) for (let x = 40; x <= 60; x++) terrain.water[y * 100 + x] = 1;
    const site = chooseSite(terrain, makeOptions({ center: { x: 1010, y: 1010 }, size: 'hamlet' }), 2000, new Rng('magna-urbis:2'));
    expect(site.warning).toMatch(/Main centre moved/);
    const i = Math.floor(site.center.y / 20) * 100 + Math.floor(site.center.x / 20);
    expect(terrain.water[i]).toBe(0);
    expect(site.cost.data[i]).toBe(0);
  });

  it('bounds village corrections from the requested point even when map clamping moves it farther', () => {
    const terrain = flatTerrain();
    const constraints = { inset: 80, slopeMax: 0.3, maxMove: 400 };
    expect(resolvePosition(terrain, 2000, { x: -1000, y: 1000 }, constraints)).toBeNull();
    expect(resolvePosition(terrain, 2000, { x: 80, y: 80 }, { ...constraints, inset: 600 })).toBeNull();
    // The exact radius is allowed by the fast path.
    expect(resolvePosition(terrain, 2000, { x: 100, y: 1000 }, { ...constraints, inset: 500 })).toEqual({ x: 500, y: 1000 });
    // A blocked clamped target must not restart the search's 400 m budget there.
    for (let y = 0; y < 100; y++) for (let x = 0; x <= 25; x++) terrain.water[y * 100 + x] = 1;
    expect(resolvePosition(terrain, 2000, { x: 100, y: 1000 }, { ...constraints, inset: 500 })).toBeNull();
  });

  it('keeps row-major tie breaking in a bounded village correction', () => {
    const terrain = flatTerrain();
    terrain.water[50 * 100 + 50] = 1;
    expect(resolvePosition(terrain, 2000, { x: 1010, y: 1010 }, { inset: 80, slopeMax: 0.3, maxMove: 400 })).toEqual({ x: 1010, y: 990 });
  });

  it('omits off-map or large-margin secondary centres rather than moving them more than 400 m', () => {
    const terrain = flatTerrain(), opts = makeOptions({ mapSize: 2000, population: 100, size: 'hamlet', center: { x: 1500, y: 1500 }, settlements: { list: [
      { population: 40, position: { x: -1000, y: 450 } },
      { population: 1000, position: { x: 0, y: 0 } },
    ] } });
    const root = new Rng('magna-urbis:1');
    const world: World = { options: opts, seed: opts.seed, mapSize: 2000, terrain, site: chooseSite(terrain, opts, 2000, root), stats: {} };
    const plan = planSettlements(world, opts, root);
    expect(plan.settlements).toHaveLength(1);
    expect(plan.warnings).toHaveLength(2);
    expect(plan.warnings.join(' ')).toMatch(/no usable land near the given position/);
  });

  it('keeps village coordinates exact and corrects conflicting centres without duplicate Voronoi sites', () => {
    const terrain = flatTerrain(), opts = makeOptions({ mapSize: 2000, population: 100, size: 'hamlet', center: { x: 1000, y: 1000 }, settlements: { list: [
      { population: 40, position: { x: 450, y: 450 } },
      { population: 40, position: { x: 1000, y: 1000 } },
    ] } });
    const root = new Rng('magna-urbis:1');
    const world: World = { options: opts, seed: opts.seed, mapSize: 2000, terrain, site: chooseSite(terrain, opts, 2000, root), stats: {} };
    const plan = planSettlements(world, opts, root);
    expect(plan.settlements).toHaveLength(3);
    expect(plan.settlements[1].center).toEqual({ x: 450, y: 450 });
    expect(plan.warnings.join(' ')).toMatch(/moved/);
    const main = plan.settlements[0], moved = plan.settlements[2];
    expect(dist(main.center, moved.center)).toBeGreaterThan(main.radius + moved.radius);
    expect(moved.region.length).toBeGreaterThanOrEqual(3);
  });

  it('moves eager urban geometry, regional roads and the main settlement to the chosen centre deterministically', () => {
    const options = makeOptions({ seed: 'placement-eager', mapSize: 4000, population: 300, importedHeight, relief: 'flat', river: 'none', center: { x: 850, y: 1325 }, settlements: 'none', castle: 'no', walls: 'none' });
    const a = generate(options), b = generate({ ...fromQuery(toQuery(options)), importedHeight });
    expect(a.site!.center).toEqual(options.center);
    expect(a.settlements![0].center).toEqual(options.center);
    expect(a.urban!.buildings.length).toBeGreaterThan(10);
    expect(Math.min(...a.roads!.map((road) => dist(road.path[road.path.length - 1], options.center!)))).toBeLessThan(1);
    const centres = a.urban!.buildings.map((building) => polygonCentroid(building.poly));
    const mean = { x: centres.reduce((s, c) => s + c.x, 0) / centres.length, y: centres.reduce((s, c) => s + c.y, 0) / centres.length };
    expect(dist(mean, options.center!)).toBeLessThan(400);
    expect(JSON.stringify(a.urban)).toBe(JSON.stringify(b.urban));
    expect(JSON.stringify(a.roads)).toBe(JSON.stringify(b.roads));
  }, 120000);

  it('uses the chosen centre in the macro plan as well as the site and settlement', () => {
    const center = { x: 3200, y: 3650 };
    const world = generate(makeOptions({ seed: 'placement-mega', mapSize: 7000, population: 50000, importedHeight, relief: 'flat', river: 'none', center, settlements: 'none' }));
    expect(world.site!.center).toEqual(center);
    expect(world.urban!.macro!.center).toEqual(center);
    expect(world.settlements![0].center).toEqual(center);
    expect(world.urban!.macro!.quarters.length).toBeGreaterThan(10);
  }, 120000);

  it('honours explicit footprint clearance even below the automatic twenty-percent band', () => {
    const terrain = flatTerrain(20000), center = { x: 800, y: 10000 };
    const opts = makeOptions({ size: 'city', center, sitePrefs: { margin: 0.1, centerInset: 2000 } });
    const site = chooseSite(terrain, opts, 20000, new Rng('magna-urbis:clearance'));
    expect(site.center).toEqual({ x: 2000, y: 10000 });
    expect(site.warning).toMatch(/Main centre moved/);
    expect(site.cost.data[50 * 100 + 10]).toBe(0);
  });

  it('reserves a small megacity radius on a large map when the centre is placed near the edge', () => {
    const opts = makeOptions({ seed: 'placement-large-mega', mapSize: 20000, population: 60000, importedHeight, relief: 'flat', river: 'none', center: { x: 200, y: 10000 }, settlements: 'none' });
    const clearance = megaRadius(60000, opts) + 400;
    expect(clearance / 20000).toBeLessThan(0.2);
    const w = generate(opts);
    expect(w.site!.center.x).toBeGreaterThanOrEqual(clearance);
    expect(w.urban!.macro!.center).toEqual(w.site!.center);
    expect(w.urban!.macro!.quarters.flatMap((q) => q.pts).every((p) => p.x >= 0 && p.x <= w.mapSize && p.y >= 0 && p.y <= w.mapSize)).toBe(true);
  }, 120000);

});
