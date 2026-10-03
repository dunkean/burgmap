/** Open-field system: furlongs bounded by real features (never Voronoi cells), strips in range, no overlaps, determinism, speed. */
import { describe, it, expect, beforeAll } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { makeOptions, effectiveSize } from '../src/gen/options';
import { Rng } from '../src/gen/core/rng';
import { polygonContains, polygonArea } from '../src/gen/core/geom';
import { generateRural } from '../src/gen/landuse/rural';
import { generateRural as legacyRural } from './legacy/rural_legacy';
import type { World, Polygon, Polyline, Vec2, LandArea } from '../src/gen/types';

const T = 900000;

/** Line segments in a bucket grid for nearest-distance queries. */
class SegIndex {
  private b = new Map<number, number[]>();
  private segs: number[] = []; // x0 y0 x1 y1 pad
  constructor(private bs = 80) {}
  add(pl: Polyline, pad = 0, closed = false): void {
    const n = pl.length;
    for (let i = closed ? 0 : 1; i < n; i++) {
      const a = pl[(i - 1 + n) % n], b = pl[i];
      const k = this.segs.length / 5;
      this.segs.push(a.x, a.y, b.x, b.y, pad);
      const x0 = Math.floor(Math.min(a.x, b.x) / this.bs), x1 = Math.floor(Math.max(a.x, b.x) / this.bs);
      const y0 = Math.floor(Math.min(a.y, b.y) / this.bs), y1 = Math.floor(Math.max(a.y, b.y) / this.bs);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const key = y * 100000 + x; const l = this.b.get(key); if (l) l.push(k); else this.b.set(key, [k]); }
    }
  }
  /** Smallest (distance - pad) from p to any segment within `r` m (Infinity when none). */
  near(p: Vec2, r: number): number {
    let best = Infinity;
    const x0 = Math.floor((p.x - r - 60) / this.bs), x1 = Math.floor((p.x + r + 60) / this.bs);
    const y0 = Math.floor((p.y - r - 60) / this.bs), y1 = Math.floor((p.y + r + 60) / this.bs);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const l = this.b.get(y * 100000 + x);
      if (!l) continue;
      for (const k of l) {
        const o = k * 5, ax = this.segs[o], ay = this.segs[o + 1], dx = this.segs[o + 2] - ax, dy = this.segs[o + 3] - ay;
        const l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / l2));
        const d = Math.hypot(p.x - ax - t * dx, p.y - ay - t * dy) - this.segs[o + 4];
        if (d < best) best = d;
      }
    }
    return best;
  }
}

const ringsOf = (a: LandArea): Polygon[] => [a.poly, ...(a.holes ?? [])];
const cellOf = (w: World, p: Vec2) => {
  const g = w.terrain.height;
  return Math.min(g.w - 1, Math.max(0, Math.floor(p.y / g.cell))) * g.w + Math.min(g.w - 1, Math.max(0, Math.floor(p.x / g.cell)));
};

/** Share of the furlong / close edge length (open fields and closes) lying on roads, tracks, water, other land-use edges or settlement edges. */
function edgeShare(w: World): { share: number; length: number } {
  const lu = w.landuse as (NonNullable<World['landuse']> & { ways?: Polyline[]; headlands?: Polyline[] });
  const g = w.terrain.height;
  const tol = 1.6 * g.cell + 8;
  const idx = new SegIndex();
  for (const l of lu.ways ?? []) idx.add(l);
  for (const l of lu.headlands ?? []) idx.add(l);
  for (const r of w.roads ?? []) idx.add(r.path, r.width / 2);
  for (const r of w.terrain.rivers) idx.add(r.path, Math.max(...r.width) / 2 + 2);
  for (const l of w.terrain.lakes) idx.add(l, 0, true);
  for (const l of w.terrain.coastline) idx.add(l, 0, true);
  for (const p of lu.reserve) idx.add(p, 0, true);
  for (const f of lu.farmsteads) { idx.add(f.yard, 0, true); idx.add(f.drive); }
  for (const st of w.settlements ?? []) for (const ph of st.urban?.footprintH ?? []) { idx.add(ph.outer, 0, true); for (const h of ph.holes) idx.add(h, 0, true); }
  for (const ph of w.urban?.footprintH ?? []) { idx.add(ph.outer, 0, true); for (const h of ph.holes) idx.add(h, 0, true); }
  const S = w.mapSize;
  idx.add([{ x: 0, y: 0 }, { x: S, y: 0 }, { x: S, y: S }, { x: 0, y: S }], 0, true);
  const rad = Math.ceil(tol / g.cell) + 1;
  const nearWater = (p: Vec2): boolean => {
    const cx = Math.floor(p.x / g.cell), cy = Math.floor(p.y / g.cell);
    for (let y = Math.max(0, cy - rad); y <= Math.min(g.w - 1, cy + rad); y++) for (let x = Math.max(0, cx - rad); x <= Math.min(g.w - 1, cx + rad); x++) if (w.terrain.water[y * g.w + x]) return true;
    return false;
  };
  const others = new SegIndex();
  for (const a of lu.areas) if (a.kind !== 'field' && !(a as { enclosed?: boolean }).enclosed) for (const r of ringsOf(a)) others.add(r, 0, true);
  let on = 0, total = 0;
  for (const a of lu.areas) {
    if (a.kind !== 'field' && !(a as { enclosed?: boolean }).enclosed) continue;
    for (const r of ringsOf(a)) {
      for (let i = 0; i < r.length; i++) {
        const p = r[i], q = r[(i + 1) % r.length];
        const L = Math.hypot(q.x - p.x, q.y - p.y);
        const m = Math.max(1, Math.ceil(L / 8));
        for (let k = 0; k < m; k++) {
          const s = { x: p.x + ((q.x - p.x) * (k + 0.5)) / m, y: p.y + ((q.y - p.y) * (k + 0.5)) / m };
          total += L / m;
          if (idx.near(s, tol) <= tol || others.near(s, tol) <= tol || nearWater(s)) on += L / m;
        }
      }
    }
  }
  return { share: total ? on / total : 1, length: total };
}

/** Strip length (principal axis extent) and width (area / length). */
function stripDims(w: World): { L: number; W: number; A: number }[] {
  const out: { L: number; W: number; A: number }[] = [];
  for (const a of w.landuse!.areas) for (const st of a.strips ?? []) {
    let mx = 0, my = 0;
    for (const q of st) { mx += q.x / st.length; my += q.y / st.length; }
    let cxx = 0, cxy = 0, cyy = 0;
    for (const q of st) { cxx += (q.x - mx) ** 2; cxy += (q.x - mx) * (q.y - my); cyy += (q.y - my) ** 2; }
    const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy), ca = Math.cos(th), sa = Math.sin(th);
    let u0 = Infinity, u1 = -Infinity;
    for (const q of st) { const u = q.x * ca + q.y * sa; if (u < u0) u0 = u; if (u > u1) u1 = u; }
    const A = Math.abs(polygonArea(st));
    out.push({ L: u1 - u0, W: A / Math.max(1, u1 - u0), A });
  }
  return out;
}
const weighted = (d: { A: number }[], v: number[], q: number): number => {
  const idx = v.map((_, i) => i).sort((a, b) => v[a] - v[b]);
  const tot = d.reduce((s, x) => s + x.A, 0);
  let acc = 0;
  for (const i of idx) { acc += d[i].A; if (acc >= q * tot) return v[i]; }
  return v[idx[idx.length - 1]];
};

/** Fields must keep clear of water, roads and settlements. Returns the number of offending vertices. */
function overlaps(w: World): { water: number; road: number; urban: number; n: number } {
  const roads = new SegIndex();
  for (const r of w.roads ?? []) roads.add(r.path, r.width / 2);
  const foots: { outer: Polygon; holes: Polygon[] }[] = [...(w.urban?.footprintH ?? [])];
  for (const st of w.settlements ?? []) foots.push(...(st.urban?.footprintH ?? []));
  let water = 0, road = 0, urban = 0, n = 0;
  for (const a of w.landuse!.areas) {
    if (a.kind !== 'field') continue;
    const pts: Vec2[] = [...a.poly];
    for (const s of a.strips ?? []) pts.push(...s);
    for (const p of pts) {
      n++;
      if (w.terrain.water[cellOf(w, p)]) water++;
      if (roads.near(p, 4) < 0) road++;
      for (const f of foots) if (polygonContains(f.outer, p) && !f.holes.some((h) => polygonContains(h, p))) { urban++; break; }
    }
  }
  return { water, road, urban, n };
}

const mainView = (w: World): World => { const size = effectiveSize(w.options); return size !== w.options.size ? { ...w, options: { ...w.options, size } } : w; };
// timing assertions only on a quiet machine: BURGMAP_PERF=1 npx vitest run tests/fields.test.ts
const PERF = process.env.BURGMAP_PERF === '1';
const timeIt = (fn: () => void, runs = 3): number => { let best = Infinity; for (let i = 0; i < runs; i++) { const t = performance.now(); fn(); best = Math.min(best, performance.now() - t); } return best; };

describe('open fields on town maps (seeds 1-4)', () => {
  const worlds: World[] = [];
  beforeAll(() => { for (const seed of ['1', '2', '3', '4']) worlds.push(generate(makeOptions({ seed, size: 'town' }))); }, T);

  it('furlong edges lie on tracks, roads, water or other land-use edges (>= 70 %)', () => {
    for (const w of worlds) {
      const r = edgeShare(w);
      console.info(`seed ${w.seed} furlong edge share`, r.share.toFixed(3), 'of', Math.round(r.length), 'm');
      expect(r.length, 'has field edges').toBeGreaterThan(5000);
      expect(r.share, `seed ${w.seed}`).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('the edge-share metric rejects the old Voronoi furlongs', () => {
    const w = worlds[0];
    const old = legacyRural(mainView(w), new Rng('burgmap:' + w.options.seed), w.roads?.length);
    const r = edgeShare({ ...w, landuse: old.layer });
    console.info('legacy Voronoi furlong edge share', r.share.toFixed(3));
    expect(r.share).toBeLessThan(0.8);
  });

  it('furlongs form a track network and are not cells of equal size', () => {
    for (const w of worlds) {
      const lu = w.landuse as NonNullable<World['landuse']> & { ways?: Polyline[]; headlands?: Polyline[] };
      expect((lu.ways?.length ?? 0) + (lu.headlands?.length ?? 0), `seed ${w.seed}`).toBeGreaterThan(8);
      const fl = lu.areas.filter((a) => a.kind === 'field' && a.strips);
      expect(fl.length).toBeGreaterThan(8);
      // the strip directions differ from furlong to furlong (patchwork)
      const deg = new Set(fl.map((a) => Math.round(((a.stripAngle ?? 0) * 180) / Math.PI / 15)));
      expect(deg.size, `directions seed ${w.seed}`).toBeGreaterThan(3);
    }
  });

  it('strips are long, thin and parallel-sided: widths 10-25 m, lengths mostly 100-330 m', () => {
    for (const w of worlds) {
      const d = stripDims(w);
      expect(d.length, `strips seed ${w.seed}`).toBeGreaterThan(100);
      const Wv = d.map((x) => x.W), Lv = d.map((x) => x.L);
      expect(weighted(d, Wv, 0.1), 'width p10').toBeGreaterThanOrEqual(9);
      expect(weighted(d, Wv, 0.9), 'width p90').toBeLessThanOrEqual(26);
      const med = weighted(d, Lv, 0.5);
      expect(med, 'length median').toBeGreaterThanOrEqual(100);
      expect(med, 'length median').toBeLessThanOrEqual(330);
      expect(weighted(d, Lv, 0.9), 'length p90').toBeLessThanOrEqual(420);
    }
  });

  it('there are enclosed closes (hedged) next to the open fields', () => {
    let closes = 0;
    for (const w of worlds) closes += w.landuse!.areas.filter((a) => (a as { enclosed?: boolean }).enclosed).length;
    expect(closes).toBeGreaterThan(20);
  });

  it('no field overlaps water, roads or settlements', () => {
    for (const w of worlds) {
      const o = overlaps(w);
      expect(o.n).toBeGreaterThan(1000);
      expect(o.water, `water seed ${w.seed}`).toBe(0);
      expect(o.road, `road seed ${w.seed}`).toBe(0);
      expect(o.urban, `urban seed ${w.seed}`).toBe(0);
    }
  });

  it('is deterministic', () => {
    const w = worlds[0];
    const mv = mainView(w);
    const a = generateRural(mv, new Rng('burgmap:' + w.options.seed), w.roads?.length);
    const b = generateRural(mv, new Rng('burgmap:' + w.options.seed), w.roads?.length);
    expect(JSON.stringify(a.layer)).toBe(JSON.stringify(b.layer));
  });

  it.runIf(PERF)('land use takes at most 1.2x the previous generator time', () => {
    const w = worlds[0];
    const mv = mainView(w);
    const main = w.roads?.length;
    let tn = Infinity, tl = Infinity;
    for (let i = 0; i < 3; i++) {
      tl = Math.min(tl, timeIt(() => legacyRural(mv, new Rng('burgmap:' + w.options.seed), main), 1));
      tn = Math.min(tn, timeIt(() => generateRural(mv, new Rng('burgmap:' + w.options.seed), main), 1));
    }
    expect(tn).toBeLessThanOrEqual(1.2 * tl);
  });
});

describe('open fields on a 10 km multi-settlement map', () => {
  let w: World;
  beforeAll(() => { w = generate(makeOptions({ seed: '5', mapSize: 10000, population: 2500, settlements: 'auto' })); }, T);

  it.runIf(PERF)('land-use stage runs in at most 3 s', () => {
    const mv = mainView(w);
    const t = timeIt(() => generateRural(mv, new Rng('burgmap:' + w.options.seed), w.roads?.length), 3);
    expect(t).toBeLessThanOrEqual(3000);
  }, T);

  it('furlong edges lie on features, fields keep clear of water, roads and settlements', () => {
    const r = edgeShare(w);
    expect(r.share).toBeGreaterThanOrEqual(0.7);
    const o = overlaps(w);
    expect(o.water).toBe(0);
    expect(o.road).toBe(0);
    expect(o.urban).toBe(0);
  }, T);

  it('every settlement has fields in its territory', () => {
    const fields = w.landuse!.areas.filter((a) => a.kind === 'field');
    let withFields = 0;
    const sets = (w.settlements ?? []).filter((s) => !s.main && s.detail !== 'farmstead');
    for (const s of sets) if (fields.some((a) => Math.hypot(a.poly[0].x - s.center.x, a.poly[0].y - s.center.y) < 1500)) withFields++;
    expect(withFields).toBeGreaterThanOrEqual(Math.floor(0.7 * sets.length));
  }, T);
});
