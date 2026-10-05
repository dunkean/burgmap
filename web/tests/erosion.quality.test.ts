import { describe, expect, it } from 'vitest';
import { createGrid, D8, visitSegmentCells } from '../src/gen/core/grid';
import { polylineLength } from '../src/gen/core/geom';
import { priorityFloodFast } from '../src/gen/core/flood';
import { continuousFlow, resolveDepressions, steepestReceivers } from '../src/gen/terrain/erosion';
import { smoothMainRoute, terrainForExtent } from '../src/gen/terrain/hydrology';
import { makeOptions } from '../src/gen/options';
import { checkRivers } from './hydroCheck';

describe('erosion drainage', () => {
  it('splits oblique hillslope flow between adjacent downhill facets and conserves catchment area', () => {
    const w = 21, hh = 21, heights = new Float32Array(w * hh);
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) heights[y * w + x] = 100 - .37 * x - y;
    const fl = priorityFloodFast(heights, w, hh, null, .002);
    steepestReceivers(fl, w, hh);
    const flow = continuousFlow(fl, w, hh), c = 10 * w + 10;
    expect(flow.first[c]).toBe(11 * w + 11);
    expect(flow.second[c]).toBe(11 * w + 10);
    expect(flow.fraction[c]).toBeCloseTo((Math.atan2(1, .37) - Math.PI / 4) / (Math.PI / 4), 3);
    const rank = new Int32Array(w * hh);
    for (let k = 0; k < fl.order.length; k++) rank[fl.order[k]] = k;
    const acc = new Float64Array(w * hh).fill(1);
    for (let k = fl.order.length - 1; k >= 0; k--) {
      const i = fl.order[k], a = flow.first[i], b = flow.second[i], t = flow.fraction[i];
      expect(t).toBeGreaterThanOrEqual(0); expect(t).toBeLessThanOrEqual(1);
      if (a >= 0) { expect(rank[a]).toBeLessThan(rank[i]); acc[a] += acc[i] * (1 - t); }
      if (b >= 0) { expect(rank[b]).toBeLessThan(rank[i]); acc[b] += acc[i] * t; }
    }
    const discharged = Array.from(acc).reduce((sum, a, i) => sum + (flow.first[i] < 0 ? a : 0), 0);
    expect(discharged).toBeCloseTo(w * hh, 6);
  });

  it('uses greatest drop per metre instead of the first flood-discovery neighbour', () => {
    const g = createGrid(5, 5, 10, 1);
    for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) g.data[y * 5 + x] = 110;
    g.data[12] = 100;
    g.data[7] = 5;
    g.data[6] = 4;
    const fl = priorityFloodFast(g.data, 5, 5, null, .002);
    expect(fl.receiver[12]).toBe(6);
    steepestReceivers(fl, 5, 5);
    expect(fl.receiver[12]).toBe(7);
  });

  it('keeps border/sea outlets and a strictly ordered drainage tree, including Float32 flats', () => {
    const w = 32, h = 24;
    const heights = new Float32Array(w * h).fill(100000);
    const sea = new Uint8Array(w * h);
    sea[11 * w + 15] = 1;
    const fl = priorityFloodFast(heights, w, h, sea, .002);
    const outlets = Array.from(fl.receiver, (r, i) => r < 0 ? i : -1).filter(i => i >= 0);
    steepestReceivers(fl, w, h);
    const rank = new Int32Array(w * h);
    for (let k = 0; k < fl.order.length; k++) rank[fl.order[k]] = k;
    for (let i = 0; i < w * h; i++) {
      const r = fl.receiver[i];
      if (r >= 0) { expect(rank[r]).toBeLessThan(rank[i]); expect(fl.filled[r]).toBeLessThanOrEqual(fl.filled[i]); }
    }
    expect(Array.from(fl.receiver, (r, i) => r < 0 ? i : -1).filter(i => i >= 0)).toEqual(outlets);
  });

  it('retains basin relief during partial filling instead of making a horizontal shelf', () => {
    const g = createGrid(15, 15, 5, 1);
    for (let y = 2; y < 13; y++) for (let x = 2; x < 13; x++) {
      const d = Math.max(Math.abs(x - 7), Math.abs(y - 7));
      g.data[y * 15 + x] = d === 5 ? 20 : 2 + d * .6 + .07 * x;
    }
    const before = g.data[7 * 15 + 8] - g.data[7 * 15 + 7];
    resolveDepressions(g, 1, .5);
    expect(g.data[7 * 15 + 8] - g.data[7 * 15 + 7]).toBeCloseTo(before * .5, 4);
    expect(Array.from(g.data).every(Number.isFinite)).toBe(true);
  });

  it('does not cut a long dead-end trench when a basin has no short downstream outlet', () => {
    const g = createGrid(80, 80, 10, 20);
    for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) {
      if (x === 0 || y === 0 || x === 79 || y === 79) g.data[y * 80 + x] = 1;
      if (x >= 32 && x <= 47 && y >= 32 && y <= 47) g.data[y * 80 + x] = 2 + .1 * (x - 32);
    }
    const before = new Float32Array(g.data);
    resolveDepressions(g, 1, .5);
    for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) {
      if (x < 32 || x > 47 || y < 32 || y > 47) expect(g.data[y * 80 + x]).toBe(before[y * 80 + x]);
    }
    expect(g.data[40 * 80 + 40]).toBeGreaterThan(before[40 * 80 + 40]);
  });
});

describe('river-width route smoothing', () => {
  it('removes cell-scale turns while preserving the large valley bend and exact edge endpoints', () => {
    const height = createGrid(60, 40, 10, 10), sea = new Uint8Array(height.data.length);
    const route = Array.from({ length: 26 }, (_, i) => ({ x: i * 20, y: 170 + 35 * Math.sin(i / 6) + (i % 2 ? 7 : -7) }));
    const result = smoothMainRoute(route, 20, 5, height, sea);
    const turn = (p: typeof route) => p.slice(1, -1).reduce((sum, q, i) => {
      const a = p[i], b = p[i + 2];
      const u = Math.atan2(q.y - a.y, q.x - a.x), v = Math.atan2(b.y - q.y, b.x - q.x);
      return sum + Math.abs(Math.atan2(Math.sin(v - u), Math.cos(v - u)));
    }, 0);
    expect(result[0]).toEqual(route[0]); expect(result.at(-1)).toEqual(route.at(-1));
    expect(turn(result)).toBeLessThan(turn(route) * .5);
    expect(Math.max(...result.map(q => q.y)) - Math.min(...result.map(q => q.y))).toBeGreaterThan(35);
    expect(polylineLength(result)).toBeLessThan(polylineLength(route));
  });

  it('keeps a genuine dry detour around sea rather than smoothing across its corners', () => {
    const height = createGrid(30, 20, 10, 10), sea = new Uint8Array(height.data.length);
    for (let y = 7; y <= 14; y++) for (let x = 8; x <= 16; x++) sea[y * 30 + x] = 1;
    const route = [{ x: 0, y: 100 }, { x: 50, y: 100 }, { x: 70, y: 55 }, { x: 180, y: 55 }, { x: 200, y: 100 }, { x: 300, y: 100 }];
    const result = smoothMainRoute(route, 22, 5, height, sea);
    let wet = 0;
    for (let i = 1; i < result.length; i++) visitSegmentCells(height, result[i - 1], result[i], c => { if (sea[c]) wet++; });
    expect(wet).toBe(0);
    expect(result[0]).toEqual(route[0]); expect(result.at(-1)).toEqual(route.at(-1));
  });
});

describe('exposed seeded relief', () => {
  it('keeps uncarved plains free of artificial cliff lines at local and regional scales', () => {
    for (const mapSize of [2400, 10000]) for (const seed of ['1', '2']) {
      const options = { ...makeOptions({ seed, relief: 'flat', river: 'none', coast: 'none' }), lakes: 'none' as const };
      const { terrain: t } = terrainForExtent(options, mapSize);
      const { w, h, cell, data } = t.height;
      let edgeGrade = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (x + 1 < w) edgeGrade = Math.max(edgeGrade, Math.abs(data[i + 1] - data[i]) / cell);
        if (y + 1 < h) edgeGrade = Math.max(edgeGrade, Math.abs(data[i + w] - data[i]) / cell);
      }
      // The bounded real basin shoulders are 0.2-grade; the old straight cuts exceeded 1.1-grade.
      expect(edgeGrade, `flat/${seed}/${mapSize}`).toBeLessThan(.25);
    }
  }, 120000);

  for (const [relief, seed, mapSize, coast] of [
    ['valley', '1', 3600, 'none'], ['valley', '2', 2400, 'E'],
    ['hills', '1', 2400, 'none'], ['mountains', '1', 2400, 'S'],
  ] as const) {
    it(`${relief}/${seed}/${mapSize}/${coast}: draining, finite land and physically connected rivers`, () => {
      const options = { ...makeOptions({ seed, size: 'city', population: 20000, relief, coast, river: 'river' }), lakes: 'none' as const };
      const { terrain: t } = terrainForExtent(options, mapSize);
      expect(checkRivers(t, { mapSize, river: options.river, widthK: 1 })).toEqual([]);
      const done = new Uint8Array(t.receiver.length);
      for (let s = 0; s < done.length; s++) {
        if (done[s]) continue;
        let c = s;
        const path: number[] = [];
        while (c >= 0 && done[c] === 0) { done[c] = 1; path.push(c); c = t.receiver[c]; }
        expect(c < 0 || done[c] === 2).toBe(true);
        for (const i of path) done[i] = 2;
      }
      let flatCells = 0, land = 0;
      const n = t.height.w;
      for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
        const i = y * n + x;
        expect(Number.isFinite(t.height.data[i])).toBe(true);
        const r = t.receiver[i];
        if (r >= 0) expect(t.filled[r]).toBeLessThanOrEqual(t.filled[i]);
        if (t.water[i]) continue;
        land++;
        if (D8.every(([dx, dy]) => t.height.data[i] === t.height.data[i + dy * n + dx])) flatCells++;
      }
      expect(flatCells / land).toBeLessThan(.002);
    }, 120000);
  }
});
