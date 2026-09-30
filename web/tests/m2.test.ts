import { describe, it, expect } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { renderSvg } from '../src/render/svg';
import { makeOptions, DEFAULT_ROADS, Options } from '../src/gen/options';
import { Rng } from '../src/gen/core/rng';
import { dist, distToPolyline, bbox, polygonContains, Vec2 } from '../src/gen/core/geom';
import type { World } from '../src/gen/types';

const cases: Partial<Options>[] = [
  { seed: '1', size: 'village', relief: 'hills', coast: 'S', river: 'river' },
  { seed: '2', size: 'village', relief: 'valley', coast: 'none', river: 'major' },
  { seed: '5', size: 'village', relief: 'flat', coast: 'none', river: 'river' },
  { seed: '8', size: 'hamlet', relief: 'mountains', coast: 'none', river: 'stream' },
  { seed: '11', size: 'town', relief: 'hills', coast: 'W', river: 'none' },
];
const worlds: World[] = cases.map((c) => generate(makeOptions(c)));

const waterAt = (w: World, p: Vec2): number => {
  const g = w.terrain.height;
  const x = Math.min(g.w - 1, Math.max(0, Math.floor(p.x / g.cell))), y = Math.min(g.h - 1, Math.max(0, Math.floor(p.y / g.cell)));
  return w.terrain.water[y * g.w + x];
};

describe('M2 determinism', () => {
  it('site, roads and land use are reproducible', () => {
    const o = makeOptions(cases[0]);
    const a = generate(o), b = generate(o);
    expect(a.site!.center).toEqual(b.site!.center);
    expect(JSON.stringify(a.roads)).toBe(JSON.stringify(b.roads));
    expect(JSON.stringify(a.landuse!.areas.map((x) => x.poly))).toBe(JSON.stringify(b.landuse!.areas.map((x) => x.poly)));
    expect(renderSvg(a)).toBe(renderSvg(b));
  });
});

describe('site', () => {
  it('is on land, away from the border, with a finite cost field at the center', () => {
    for (const w of worlds) {
      const s = w.site!;
      expect(waterAt(w, s.center)).toBe(0);
      expect(s.center.x).toBeGreaterThan(0.29 * w.mapSize);
      expect(s.center.x).toBeLessThan(0.71 * w.mapSize);
      expect(s.center.y).toBeGreaterThan(0.29 * w.mapSize);
      expect(s.center.y).toBeLessThan(0.71 * w.mapSize);
      const g = s.cost;
      expect(g.data[Math.floor(s.center.y / g.cell) * g.w + Math.floor(s.center.x / g.cell)]).toBe(0);
      if (w.terrain.rivers.some((r) => r.main)) expect(s.crossing).toBeDefined();
    }
  });
});

describe('regional roads', () => {
  it('start on the border and end at the center or on another road', () => {
    for (const w of worlds) {
      const S = w.mapSize;
      const roads = w.roads!;
      expect(roads.length).toBeGreaterThanOrEqual(Math.min(2, DEFAULT_ROADS[w.options.size]));
      let toCenter = 0;
      roads.forEach((r, i) => {
        const a = r.path[0], b = r.path[r.path.length - 1];
        if (r.kind !== 'track') {
          expect(Math.min(a.x, a.y, S - a.x, S - a.y)).toBeLessThan(1);
          if (dist(b, w.site!.center) < 2) toCenter++;
          else {
            const other = roads.filter((_, j) => j !== i && (roads[j].kind !== 'track'));
            expect(Math.min(...other.map((o) => distToPolyline(b, o.path)))).toBeLessThan(2);
          }
        } else {
          const others = roads.filter((_, j) => j !== i);
          expect(Math.min(...others.map((o) => distToPolyline(a, o.path)))).toBeLessThan(2);
          expect(Math.min(...others.map((o) => distToPolyline(b, o.path)))).toBeLessThan(2);
        }
      });
      expect(toCenter).toBeGreaterThanOrEqual(1);
    }
  });

  it('respects the roads option', () => {
    const w = generate(makeOptions({ ...cases[2], roads: 5 }));
    expect(w.roads!.filter((r) => r.kind !== 'track').length).toBeGreaterThanOrEqual(3);
    expect(w.roads!.filter((r) => r.kind !== 'track').length).toBeLessThanOrEqual(5);
  });

  it('never runs through water except on bridges', () => {
    for (const w of worlds) {
      for (const r of w.roads!) {
        for (let i = 1; i < r.path.length; i++) {
          const a = r.path[i - 1], b = r.path[i];
          const m = Math.max(1, Math.ceil(dist(a, b) / 3));
          for (let k = 0; k <= m; k++) {
            const p = { x: a.x + ((b.x - a.x) * k) / m, y: a.y + ((b.y - a.y) * k) / m };
            if (waterAt(w, p)) {
              const onBridge = w.bridges!.some((br) => distToPolyline(p, [br.a, br.b]) < br.width + 2);
              expect(onBridge).toBe(true);
            }
          }
        }
      }
      for (const br of w.bridges!) {
        expect(waterAt(w, br.a)).toBe(0);
        expect(waterAt(w, br.b)).toBe(0);
      }
      // a real main river (not a brook) is bridged only a few times, all near the crossing
      const mr = w.terrain.rivers.find((rv) => rv.main);
      if (!mr || Math.max(...mr.width) < 9) continue;
      const mainBridges = w.bridges!.filter((br) => w.terrain.rivers.some((rv) => rv.main && distToPolyline({ x: (br.a.x + br.b.x) / 2, y: (br.a.y + br.b.y) / 2 }, rv.path) < 40));
      expect(mainBridges.length).toBeLessThanOrEqual(4);
    }
  });
});

describe('rural land use', () => {
  it('has strips inside furlongs and never overlaps water or roads', () => {
    let strips = 0;
    for (const w of worlds) {
      const rng = new Rng('lu-test');
      const roads = w.roads!;
      const clear = (p: Vec2) => {
        if (waterAt(w, p)) return false;
        for (const r of roads) if (distToPolyline(p, r.path) < r.width / 2) return false;
        return true;
      };
      for (const a of w.landuse!.areas) {
        const bb = bbox(a.poly);
        const pts: Vec2[] = [];
        for (let t = 0; t < 40 && pts.length < 6; t++) {
          const p = { x: rng.range(bb.minX, bb.maxX), y: rng.range(bb.minY, bb.maxY) };
          if (polygonContains(a.poly, p) && !(a.holes ?? []).some((h) => polygonContains(h, p))) pts.push(p);
        }
        for (const p of pts) expect(clear(p)).toBe(true);
        for (const s of a.strips ?? []) {
          strips++;
          const c = { x: s.reduce((q, v) => q + v.x, 0) / s.length, y: s.reduce((q, v) => q + v.y, 0) / s.length };
          if (polygonContains(s, c)) expect(clear(c)).toBe(true);
        }
        if (a.kind === 'field') expect(a.stripAngle).toBeDefined();
      }
      // urban reserve is free of rural land use
      const ctr = w.site!.center;
      for (const a of w.landuse!.areas) expect(polygonContains(a.poly, ctr)).toBe(false);
    }
    expect(strips).toBeGreaterThan(20);
  });
});
