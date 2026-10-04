import { describe, expect, it } from 'vitest';
import { visitSegmentCells } from '../src/gen/core/grid';
import { Rng } from '../src/gen/core/rng';
import { distToPolyline, type Vec2 } from '../src/gen/core/geom';
import { lengths, pointAtPre } from '../src/gen/core/pline';
import { makeOptions } from '../src/gen/options';
import { clipRiverAtWater, generateTerrain, lakeComponentAt } from '../src/gen/terrain/hydrology';
import { assignHydraulics, scaleFor } from '../src/gen/terrain/rivernet';
import { chooseSite } from '../src/gen/site/site';
import { roadContext, routeRoads } from '../src/gen/roads/regional';
import type { River, SiteFields, TerrainLayer } from '../src/gen/types';
import { checkRivers, checkRoads } from './hydroCheck';

const box = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const grid = { w: 4, h: 4, cell: 10 };
function cells(a: Vec2, b: Vec2): number[] {
  const out: number[] = []; visitSegmentCells(grid, a, b, (i) => out.push(i)); return out;
}

describe('shore-preserving segment traversal', () => {
  it('sees a sub-metre wet corner crossing between the old two-metre samples', () => {
    const a = { x: 8, y: 8 }, b = { x: 13, y: 12.1 };
    expect(cells(a, b)).toEqual([0, 1, 5]);
    expect(cells(b, a)).toEqual([5, 1, 0]);
    const legacy = Array.from({ length: 5 }, (_, k) => {
      const t = k / 4; return Math.floor((a.y + (b.y - a.y) * t) / 10) * 4 + Math.floor((a.x + (b.x - a.x) * t) / 10);
    });
    expect(legacy).not.toContain(1);
  });
  it('handles horizontal, vertical and zero-length paths at the map boundaries', () => {
    expect(cells({ x: 0, y: 5 }, { x: 40, y: 5 })).toEqual([0, 1, 2, 3]);
    expect(cells({ x: 15, y: 40 }, { x: 15, y: 0 })).toEqual([13, 9, 5, 1]);
    expect(cells({ x: 40, y: 40 }, { x: 40, y: 40 })).toEqual([15]);
    expect(cells({ x: 5, y: 5 }, { x: 35, y: 35 })).toEqual([0, 5, 10, 15]);
  });
});

describe('mouth identity after shoreline clipping', () => {
  const r: River = { id: 1, host: 0, mouth: 'river', source: 'spring', endLake: 99,
    path: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }], width: [2, 3, 4] };
  it('keeps a surviving tributary and gives its true sea mouth no stale river host', () => {
    const original = JSON.stringify(r);
    const clipped = clipRiverAtWater(r, [box(60, -10, 200, 10)], [], { mouth: 'sea' })!;
    expect(clipped.mouth).toBe('sea'); expect(clipped.host).toBeUndefined(); expect(clipped.endLake).toBeUndefined();
    expect(clipped.path.at(-1)!.x).toBeCloseTo(60, 4);
    expect(clipped.width.at(-1)).toBeCloseTo(3.2, 4);
    expect(JSON.stringify(r)).toBe(original);
  });
  it('records the actual receiving lake component', () => {
    const clipped = clipRiverAtWater(r, [box(60, -10, 200, 10)], [], { mouth: 'lake', lakeAt: () => 7 })!;
    expect(clipped.mouth).toBe('lake'); expect(clipped.host).toBeUndefined(); expect(clipped.endLake).toBe(7);
  });
  it('resolves a smoothed shore in a dry cell to a kept basin, never a discarded depression', () => {
    const comp = new Int32Array(16).fill(-1); comp[5] = 7; comp[2] = 9;
    expect(lakeComponentAt(grid, comp, new Set([7]), { x: 21, y: 15 })).toBe(7);
    expect(lakeComponentAt(grid, comp, new Set([7]), { x: 15, y: 15 })).toBe(7);
    expect(lakeComponentAt(grid, comp, new Set(), { x: 15, y: 15 })).toBeUndefined();
  });
  it('keeps valid lake inflow identity and its external catchment when a shore sample is negative', () => {
    const inflow = { ...r, mouth: 'lake' as const, endLake: 7, edgeFed: true, w0: 8 };
    const clipped = clipRiverAtWater(inflow, [box(60, -10, 200, 10)], [], { mouth: 'lake', lakeAt: () => -1 })!;
    const outlet: River = { id: 2, source: 'lake', lakeId: 7, mouth: 'edge', path: [{ x: 150, y: 0 }, { x: 250, y: 0 }], width: [1, 1] };
    expect(clipped.endLake).toBe(7);
    assignHydraulics({ rivers: [outlet, clipped], scale: scaleFor(1), aint: () => 0, mainAext: 0,
      lam: 1, lamBrook: 1, lamEdge: 1, mainMouthW: 0, mainHeadW: 0, estuary: 1, minBrookW: 1.4 });
    expect(clipped.ext!.at(-1)!).toBeGreaterThan(0);
    expect(outlet.ext![0]).toBeCloseTo(clipped.ext!.at(-1)!, 8);
    expect(outlet.width[0]).toBeCloseTo(8, 8);
    const rerouted = clipRiverAtWater(r, [box(60, -10, 200, 10)], [], { mouth: 'lake', lakeAt: () => -1 })!;
    expect(rerouted.endLake).toBeUndefined(); // Old river-host metadata is not a valid lake identity.
  });
  it('preserves the original downstream host when only a lake outlet source is trimmed', () => {
    const outlet = { ...r, source: 'lake' as const, lakeId: 7 };
    const clipped = clipRiverAtWater(outlet, [box(-20, -10, 20, 10)], [], { mouth: 'lake', lakeAt: () => 7 })!;
    expect(clipped.path[0].x).toBeCloseTo(20, 4);
    expect(clipped.path.at(-1)).toEqual(r.path.at(-1));
    expect(clipped.mouth).toBe('river'); expect(clipped.host).toBe(0); expect(clipped.lakeId).toBe(7);
  });
  it('retains a dry island channel and clips only at the inner sea shore', () => {
    const island = { ...r, path: [{ x: 40, y: 0 }, { x: 60, y: 0 }, { x: 90, y: 0 }] };
    const clipped = clipRiverAtWater(island, [box(0, -20, 100, 20)], [box(30, -10, 80, 10)], { mouth: 'sea' })!;
    expect(clipped.path[0]).toEqual(island.path[0]); expect(clipped.path.at(-1)!.x).toBeCloseTo(80, 4);
    expect(clipped.mouth).toBe('sea'); expect(clipped.host).toBeUndefined();
  });
});

describe('safe junction fallback', () => {
  const n = 6, cell = 10, N = n * n, wet = 2 * n + 2;
  function context(anchorRiver = false) {
    const water = new Uint8Array(N); water[wet] = 1;
    if (anchorRiver) water[15] = 3;
    const height = { w: n, h: n, cell, data: new Float32Array(N) };
    const terrain = { height, water, rivers: [] } as unknown as TerrainLayer;
    const f = { hab: new Float32Array(N).fill(10), dWater: new Float32Array(N).fill(100), dMain: new Float32Array(N).fill(100) } as unknown as SiteFields;
    const pass = new Uint8Array(N).fill(1); pass[wet] = 0;
    return roadContext(terrain, f, new Rng('junction-shore'), n * cell, pass);
  }
  function expectDry(path: Vec2[]) {
    for (let i = 1; i < path.length; i++) {
      visitSegmentCells({ w: n, h: n, cell }, path[i - 1], path[i], (c) => expect(c).not.toBe(wet));
    }
  }
  it('retains the untrimmed detour rather than replacing its end with an unsafe diagonal', () => {
    const path = context().smoothPath([7, 8], { x: 15, y: 15 }, { x: 35, y: 25 }, [7, 8, 9, 15]);
    expect(path).not.toBeNull(); expectDry(path!);
    expect(path!.at(-1)).toEqual({ x: 35, y: 25 }); expect(path!.length).toBeGreaterThan(2);
  });
  it('reconnects a real off-grid anchor by a bounded dry local route', () => {
    const path = context().smoothPath([6, 7], { x: 5, y: 15 }, { x: 35, y: 25 });
    expect(path).not.toBeNull(); expectDry(path!);
    expect(path![0]).toEqual({ x: 5, y: 15 }); expect(path!.at(-1)).toEqual({ x: 35, y: 25 });
  });
  it('refuses an anchor inside the sea rather than returning a path known to be unsafe', () => {
    expect(context().smoothPath([6, 7], { x: 5, y: 15 }, { x: 25, y: 25 })).toBeNull();
  });
  it('preserves a host ford anchor while still refusing the adjacent sea corner', () => {
    const path = context(true).smoothPath([6, 7], { x: 5, y: 15 }, { x: 35, y: 25 });
    expect(path).not.toBeNull(); expectDry(path!);
    expect(path!.at(-1)).toEqual({ x: 35, y: 25 });
    const reverse = context(true).smoothPath([7, 6], { x: 35, y: 25 }, { x: 5, y: 15 });
    expect(reverse).not.toBeNull(); expectDry(reverse!);
    expect(reverse![0]).toEqual({ x: 35, y: 25 });
  });
});

describe('real estuary regressions from the full suite', () => {
  for (const [seed, id, minimum] of [['2', 1, 3], ['3', 1, 3], ['4', 2, 4]] as const) {
    it(`valley seed ${seed} preserves the drowned confluence as a real sea outlet`, () => {
      const o = makeOptions({ seed, size: 'town', relief: 'valley', coast: 'random', river: 'river' });
      const { terrain: t } = generateTerrain(o, new Rng('burgmap:' + seed));
      expect(t.rivers.length).toBeGreaterThanOrEqual(minimum);
      const r = t.rivers.find((r) => r.id === id)!;
      expect(r).toBeDefined(); expect(r.mouth).toBe('sea'); expect(r.host).toBeUndefined();
      const distance = Math.min(...t.coastline.map((p) => distToPolyline(r.path.at(-1)!, p.concat([p[0]]))));
      expect(distance).toBeLessThan(0.01);
      expect(checkRivers(t, { mapSize: 2400, river: o.river, widthK: 1 })).toEqual([]);
    }, 120000);
  }
  it('keeps the mountain seed 6 coastal road on land without inventing sea bridges', () => {
    const o = makeOptions({ seed: '6', size: 'town', relief: 'mountains', coast: 'random', river: 'river' });
    const root = new Rng('burgmap:' + o.seed), { terrain: t } = generateTerrain(o, root);
    const site = chooseSite(t, o, 2400, root), result = routeRoads(t, site, o, 2400, root);
    expect(result.roads.length).toBeGreaterThanOrEqual(4); // Keep the real routes, rather than dropping the bad road.
    expect(result.bridges.length).toBeGreaterThanOrEqual(2); // Preserve the genuine river crossings.
    expect(checkRoads(t, site, result.roads, result.bridges, 2400)).toEqual([]);
    // Independent fine-distance oracle, including bridge decks: no sea/lake crossing is authorized here.
    let blocked = 0;
    for (const rd of result.roads) {
      const pre = lengths(rd.path), L = pre.at(-1)!;
      for (let s = 0; s <= L; s += 0.05) {
        const p = pointAtPre(rd.path, pre, s).pt;
        const x = Math.min(t.height.w - 1, Math.max(0, Math.floor(p.x / t.height.cell)));
        const y = Math.min(t.height.h - 1, Math.max(0, Math.floor(p.y / t.height.cell)));
        if (t.water[y * t.height.w + x] === 1 || t.water[y * t.height.w + x] === 2) blocked++;
      }
    }
    expect(blocked).toBe(0);
  }, 120000);
});
