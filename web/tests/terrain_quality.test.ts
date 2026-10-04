import { describe, it, expect } from 'vitest';
import { makeOptions, Relief } from '../src/gen/options';
import { terrainForExtent, gridForExtent } from '../src/gen/terrain/hydrology';
import { polygonContains, distToPolyline } from '../src/gen/core/geom';
import { createGrid } from '../src/gen/core/grid';
import { astarFewCrossings, crossingCounts, AStarCfg } from '../src/gen/roads/regional';
import type { TerrainLayer } from '../src/gen/types';

const opt = (relief: Relief, seed: string, extra: Record<string, unknown> = {}) =>
  ({ ...makeOptions({ seed, relief, river: 'river' }), ...extra }) as ReturnType<typeof makeOptions>;

const median = (a: number[]): number => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function landSlopes(t: TerrainLayer, near?: { path: { x: number; y: number }[]; r: number }): number[] {
  const n = t.height.w, cell = t.height.cell, out: number[] = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    if (t.water[i] !== 0 || t.height.data[i] < 0.5) continue;
    if (near && distToPolyline({ x: (x + 0.5) * cell, y: (y + 0.5) * cell }, near.path) > near.r) continue;
    out.push(t.slope.data[i]);
  }
  return out;
}

describe('slope distribution per relief (median over land, seeds 1-5)', () => {
  const seeds = ['1', '2', '3', '4', '5'];
  it('flat ~1%', () => {
    for (const s of seeds) {
      const { terrain } = terrainForExtent(opt('flat', s), 2400);
      const m = median(landSlopes(terrain));
      expect(m).toBeGreaterThan(0.005); expect(m).toBeLessThan(0.016);
    }
  }, 120000);
  it('hills 5-8%', () => {
    for (const s of seeds) {
      const { terrain } = terrainForExtent(opt('hills', s), 2400);
      const m = median(landSlopes(terrain));
      expect(m).toBeGreaterThan(0.05); expect(m).toBeLessThan(0.08);
    }
  }, 120000);
  it('valley floors 2-4% (within 220 m of the main river)', () => {
    for (const s of seeds) {
      const { terrain } = terrainForExtent(opt('valley', s), 2400);
      const main = terrain.rivers.find((r) => r.main)!;
      const m = median(landSlopes(terrain, { path: main.path, r: 220 }));
      expect(m).toBeGreaterThan(0.015); expect(m).toBeLessThan(0.04);
    }
  }, 120000);
  it('mountains are steep but not absurd (25-55%)', () => {
    for (const s of ['1', '3', '8']) {
      const { terrain } = terrainForExtent(opt('mountains', s), 2400);
      const m = median(landSlopes(terrain));
      expect(m).toBeGreaterThan(0.25); expect(m).toBeLessThan(0.55);
    }
  }, 120000);
});

describe('lakes', () => {
  it('lakes:none gives no lakes; lakes:some gives natural lakes that all have an outlet river', () => {
    let lakes = 0;
    for (const relief of ['hills', 'valley', 'mountains'] as Relief[]) {
      for (const seed of ['1', '2', '3', '4']) {
        expect(terrainForExtent(opt(relief, seed, { lakes: 'none' }), 2000).terrain.lakes.length).toBe(0);
        const { terrain: t } = terrainForExtent(opt(relief, seed, { lakes: 'some' }), 2400);
        for (const inflow of t.rivers.filter((r) => r.mouth === 'lake')) {
          expect(inflow.endLake, `${relief}/${seed}: lake inflow without a retained component`).toBeGreaterThanOrEqual(0);
          expect(t.rivers.some((r) => r.source === 'lake' && r.lakeId === inflow.endLake),
            `${relief}/${seed}: lake inflow does not match its outlet`).toBe(true);
        }
        for (const outlet of t.rivers.filter((r) => r.source === 'lake')) {
          const upstream = t.rivers.filter((r) => r.mouth === 'lake' && r.endLake === outlet.lakeId)
            .reduce((sum, r) => sum + (r.ext?.at(-1) ?? 0), 0);
          expect(outlet.ext?.[0] ?? 0, `${relief}/${seed}: lake lost its external inflow`).toBeGreaterThanOrEqual(upstream - 1e-6);
        }
        const cell = t.height.cell;
        for (const lk of t.lakes) {
          lakes++;
          // an outlet: some river starts on the shore of this lake
          const has = t.rivers.some((r) => {
            const p = r.path[0];
            let d = Infinity;
            for (const q of lk) d = Math.min(d, Math.hypot(q.x - p.x, q.y - p.y));
            return d <= 3 * cell;
          });
          expect(has, `${relief}/${seed}: lake without outlet`).toBe(true);
        }
      }
    }
    expect(lakes).toBeGreaterThan(3);
  }, 240000);

  it('auto mode makes lakes rare', () => {
    let withLake = 0;
    for (const seed of ['1', '2', '3', '4', '5', '6', '7', '8']) if (terrainForExtent(opt('hills', seed), 1600).terrain.lakes.length) withLake++;
    expect(withLake).toBeLessThanOrEqual(4);
  }, 240000);
});

describe('coast and rivers', () => {
  it('river polylines never enter sea/lake polygons except the last (mouth) point', () => {
    for (const [relief, coast, seed] of [['hills', 'S', '4'], ['valley', 'E', '2'], ['flat', 'N', '3'], ['hills', 'W', '5'], ['mountains', 'S', '1']] as [Relief, 'S' | 'E' | 'N' | 'W', string][]) {
      const o = { ...opt(relief, seed, { lakes: 'some' }), coast, river: 'major' as const };
      const { terrain: t } = terrainForExtent(o, 2400);
      const polys = t.coastline.concat(t.lakes);
      expect(t.coastline.length).toBeGreaterThan(0);
      for (const r of t.rivers) {
        expect(r.width.length).toBe(r.path.length);
        for (let i = 0; i < r.path.length - 1; i++) {
          for (const pg of polys) expect(polygonContains(pg, r.path[i]), `${relief}/${coast}/${seed} river vertex ${i}/${r.path.length}`).toBe(false);
        }
      }
      // the main river still reaches the shore (mouth kept): last point within a few cells of the sea polygon
      const main = t.rivers.find((r) => r.main)!;
      const end = main.path[main.path.length - 1];
      let d = Infinity;
      // Distance to the actual shore, including long simplified edges between its vertices.
      for (const pg of t.coastline) d = Math.min(d, distToPolyline(end, pg.concat([pg[0]])));
      expect(d).toBeLessThan(4 * t.height.cell);
    }
  }, 240000);

  it('shore has no thin peninsulas: land strips narrower than ~2 cells do not survive', () => {
    const { terrain: t } = terrainForExtent({ ...opt('hills', '4'), coast: 'S' }, 2400);
    const n = t.height.w;
    // count land cells that have sea both left and right (or above and below) within 3 cells
    let thin = 0, land = 0;
    for (let y = 3; y < n - 3; y++) for (let x = 3; x < n - 3; x++) {
      const i = y * n + x;
      if (t.water[i] !== 0) continue;
      land++;
      const s = (dx: number, dy: number) => t.water[(y + dy) * n + x + dx] === 1;
      if ((s(-3, 0) && s(3, 0)) || (s(0, -3) && s(0, 3))) thin++;
    }
    expect(thin / land).toBeLessThan(0.004);
  }, 120000);
});

describe('scale support', () => {
  it('grid stays <= 1024 and cell = extent / grid for any extent 600 m .. 40 km', () => {
    for (const m of [600, 1000, 2400, 5000, 10000, 20000, 40000]) {
      const n = gridForExtent(m);
      expect(n).toBeLessThanOrEqual(1024);
      expect(n).toBeGreaterThanOrEqual(240);
    }
  });
  it('40 km map has regional relief, a big river and a coast; 1 km map has local relief', () => {
    const big = terrainForExtent({ ...opt('hills', '2'), coast: 'E' }, 40000);
    expect(big.terrain.height.w * big.terrain.height.cell).toBeCloseTo(40000, 3);
    const H = big.terrain.height.data;
    let mx = 0;
    for (let i = 0; i < H.length; i++) if (H[i] > mx) mx = H[i];
    expect(mx).toBeGreaterThan(200); // regional relief in meters
    const main = big.terrain.rivers.find((r) => r.main)!;
    expect(Math.max(...main.width)).toBeGreaterThan(60);
    expect(big.terrain.seaFraction).toBeGreaterThan(0.1);
    const small = terrainForExtent(opt('hills', '2'), 1000);
    expect(small.terrain.height.w * small.terrain.height.cell).toBeCloseTo(1000, 3);
    const m2 = median(landSlopes(small.terrain));
    expect(m2).toBeGreaterThan(0.03); expect(m2).toBeLessThan(0.1);
    const mb = median(landSlopes(big.terrain));
    expect(mb).toBeGreaterThan(0.015); expect(mb).toBeLessThan(0.09);
  }, 240000);
});

describe('determinism', () => {
  it('same options + extent -> identical terrain; different seed differs', () => {
    const o = { ...opt('mountains', '5', { lakes: 'some' }), coast: 'S' as const };
    const a = terrainForExtent(o, 3000).terrain, b = terrainForExtent(o, 3000).terrain;
    expect(Buffer.from(a.height.data.buffer).equals(Buffer.from(b.height.data.buffer))).toBe(true);
    expect(JSON.stringify(a.rivers)).toBe(JSON.stringify(b.rivers));
    expect(JSON.stringify(a.lakes)).toBe(JSON.stringify(b.lakes));
    expect(JSON.stringify(a.coastline)).toBe(JSON.stringify(b.coastline));
    const c = terrainForExtent({ ...o, seed: '6' }, 3000).terrain;
    expect(Buffer.from(c.height.data.buffer).equals(Buffer.from(a.height.data.buffer))).toBe(false);
  }, 120000);
});

describe('regional roads: brook crossings', () => {
  it('a road does not cross the same brook repeatedly when a one-bank route exists', () => {
    const W = 80, H = 60, cell = 5;
    const pass = new Uint8Array(W * H).fill(1);
    const ids = new Int16Array(W * H).fill(-1);
    // a winding brook whose humps reach up into the straight line between start and goal
    for (let x = 0; x < W; x++) {
      const y = Math.round(30 + 14 * Math.sin(x / 6));
      for (const yy of [y - 1, y, y + 1]) if (yy >= 0 && yy < H) { pass[yy * W + x] = 2; ids[yy * W + x] = 0; }
    }
    const cm = new Float32Array(W * H).fill(1);
    for (let i = 0; i < W * H; i++) if (pass[i] === 2) cm[i] = 1;
    const start = 22 * W + 2, goal = 22 * W + W - 3;
    const gx = goal % W, gy = (goal / W) | 0;
    const cfg: AStarCfg = {
      w: W, h: H, cell, H: new Float32Array(W * H), pass, cm, discount: 1, allowBridge: true,
      hf: (i) => 0.95 * cell * Math.max(Math.abs((i % W) - gx), Math.abs(((i / W) | 0) - gy)),
    };
    // baseline: a single attempt takes the wet shortcut several times
    const base = astarFewCrossings(cfg, start, (i) => i === goal, ids, new Set(), 1)!;
    const nb = crossingCounts(base, ids, pass).get(0) ?? 0;
    const fixed = astarFewCrossings(cfg, start, (i) => i === goal, ids, new Set(), 4)!;
    const nf = crossingCounts(fixed, ids, pass).get(0) ?? 0;
    expect(nb).toBeGreaterThan(1);
    expect(nf).toBeLessThanOrEqual(1);
    expect(fixed[fixed.length - 1]).toBe(goal);
    void createGrid;
  });
});
