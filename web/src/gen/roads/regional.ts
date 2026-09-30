import type { Rng } from '../core/rng';
import { MinHeap } from '../core/pq';
import { D8, D8_DIST, blurGrid } from '../core/grid';
import { Vec2, Polyline, chaikin, simplify, polylineLength, dist, resample } from '../core/geom';
import { smoothstep } from '../core/field';
import { roadCount, Options, SizeName } from '../options';
import { passability } from '../site/site';
import type { TerrainLayer, SiteLayer, World } from '../types';

type Road = NonNullable<World['roads']>[number];
type Bridge = NonNullable<World['bridges']>[number];

/** Laplacian relaxation (ends fixed, each point stays within `maxDisp` of where it started). */
function relax(pl: Polyline, iters: number, maxDisp: number, isWater: (p: Vec2) => boolean, pin?: (p: Vec2) => boolean): Polyline {
  const pts = resample(pl, 8);
  if (pts.length < 4) return pl;
  // ends stay exactly where they are; interior points keep the relaxed positions
  const orig = pts.map((p) => ({ ...p }));
  for (let it = 0; it < iters; it++) {
    const nx = pts.map((p) => ({ ...p }));
    for (let i = 1; i < pts.length - 1; i++) {
      let x = 0.5 * pts[i].x + 0.25 * (pts[i - 1].x + pts[i + 1].x);
      let y = 0.5 * pts[i].y + 0.25 * (pts[i - 1].y + pts[i + 1].y);
      const dx = x - orig[i].x, dy = y - orig[i].y, d = Math.hypot(dx, dy);
      if (d > maxDisp) { x = orig[i].x + (dx / d) * maxDisp; y = orig[i].y + (dy / d) * maxDisp; }
      if (isWater({ x, y }) && !isWater(pts[i])) continue; // never pull the road into water
      if (pin && pin(pts[i])) continue;
      nx[i].x = x; nx[i].y = y;
    }
    for (let i = 0; i < pts.length; i++) pts[i] = nx[i];
  }
  return pts;
}

export const ROAD_WIDTH = { major: 8, minor: 5, track: 3 } as const;

const gradeMult = (g: number): number => 1 + 6 * g + 120 * g * g + (g > 0.08 ? 25 * (g - 0.08) : 0);

export interface AStarCfg {
  w: number; h: number; cell: number;
  H: Float32Array; pass: Uint8Array; cm: Float32Array;
  used?: Uint8Array; discount: number;
  hf: (idx: number) => number;
  allowBridge: boolean;
}

/** A* on the cost grid; returns the cell path start -> goal or null. */
function astar(cfg: AStarCfg, start: number, isGoal: (idx: number) => boolean): number[] | null {
  const { w, h, cell, H, pass, cm, used, discount } = cfg;
  const N = w * h;
  const g = new Float32Array(N).fill(Infinity);
  const parent = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const heap = new MinHeap<number>();
  g[start] = 0; heap.push(start, cfg.hf(start));
  while (heap.size) {
    const c = heap.pop()!;
    if (closed[c]) continue;
    closed[c] = 1;
    if (isGoal(c)) {
      const out: number[] = [];
      for (let i = c; i >= 0; i = parent[i]) out.push(i);
      return out.reverse();
    }
    const cx = c % w, cy = (c / w) | 0;
    for (let k = 0; k < 8; k++) {
      const dx = D8[k][0], dy = D8[k][1];
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (closed[n]) continue;
      let pt = pass[n];
      if (!pt || (pt === 3 && !cfg.allowBridge)) continue;
      if (dx !== 0 && dy !== 0 && (!pass[c + dx] || !pass[c + dy * w] || (!cfg.allowBridge && (pass[c + dx] === 3 || pass[c + dy * w] === 3)))) continue;
      const d = D8_DIST[k] * cell;
      const gr = pt >= 2 || pass[c] >= 2 ? 0 : Math.abs(H[n] - H[c]) / d;
      let step = d * gradeMult(gr) * cm[n];
      if (used && used[n]) step *= discount;
      const ng = g[c] + step;
      if (ng < g[n]) {
        g[n] = ng; parent[n] = c;
        const hv = cfg.hf(n);
        if (hv !== Infinity) heap.push(n, ng + hv);
      }
    }
  }
  return null;
}


/** Per-cell id of the river/brook (index into terrain.rivers) whose ribbon covers the cell, -1 elsewhere. */
export function streamIds(terrain: TerrainLayer): Int16Array {
  const { w: n, cell } = terrain.height;
  const ids = new Int16Array(n * n).fill(-1);
  terrain.rivers.forEach((r, ri) => {
    for (let i = 1; i < r.path.length; i++) {
      const a = r.path[i - 1], b = r.path[i];
      const rad = Math.max(Math.max(r.width[i - 1], r.width[i]) / 2, cell * 0.6);
      const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - rad) / cell)), x1 = Math.min(n - 1, Math.floor((Math.max(a.x, b.x) + rad) / cell));
      const y0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - rad) / cell)), y1 = Math.min(n - 1, Math.floor((Math.max(a.y, b.y) + rad) / cell));
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = (x + 0.5) * cell, py = (y + 0.5) * cell;
        const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2));
        if (Math.hypot(px - a.x - t * dx, py - a.y - t * dy) <= rad && terrain.water[y * n + x] === 3) ids[y * n + x] = ri;
      }
    }
  });
  return ids;
}

/** Number of separate crossings of each stream along a cell path (a run of consecutive wet cells = one crossing). */
export function crossingCounts(cells: number[], ids: Int16Array, pass: Uint8Array): Map<number, number> {
  const out = new Map<number, number>();
  let prev = -1;
  for (const c of cells) {
    const id = pass[c] >= 2 ? ids[c] : -1;
    if (id >= 0 && id !== prev) out.set(id, (out.get(id) ?? 0) + 1);
    if (id >= 0 || pass[c] < 2) prev = id; // stay "in" a stream across gaps of unlabelled wet cells
  }
  return out;
}

/**
 * A* that discourages crossing the same brook repeatedly (roads in gorges zig-zag over one stream 6+ times):
 * after each attempt every stream crossed more than once (`maxCross` for the main river) gets its cells' cost
 * multiplied, and the road is re-routed. The attempt with the fewest excess crossings wins.
 */
export function astarFewCrossings(
  cfg: AStarCfg, start: number, isGoal: (idx: number) => boolean, ids: Int16Array, mainIds: Set<number>, attempts = 4,
): number[] | null {
  let best: number[] | null = null, bestExcess = Infinity;
  let cm = cfg.cm;
  for (let t = 0; t < attempts; t++) {
    const path = astar({ ...cfg, cm }, start, isGoal);
    if (!path) return best;
    const counts = crossingCounts(path, ids, cfg.pass);
    let excess = 0;
    const bad: number[] = [];
    counts.forEach((c, id) => { const allowed = mainIds.has(id) ? 2 : 1; if (c > allowed) { excess += c - allowed; bad.push(id); } });
    if (excess < bestExcess) { best = path; bestExcess = excess; }
    if (excess === 0) break;
    if (cm === cfg.cm) cm = Float32Array.from(cfg.cm);
    const set = new Set(bad);
    for (let i = 0; i < cm.length; i++) if (set.has(ids[i]) && cfg.pass[i] >= 2) cm[i] *= 6;
  }
  return best;
}

interface Exit { idx: number; p: Vec2; ang: number; q: number }

function nearestOnPolyline(pl: Polyline, p: Vec2): { pt: Vec2; d: number } {
  let best = Infinity, bp = pl[0];
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1], b = pl[i];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best) { best = d; bp = q; }
  }
  return { pt: bp, d: best };
}

function pointAtLength(pl: Polyline, s: number): Vec2 {
  let acc = 0;
  for (let i = 1; i < pl.length; i++) {
    const l = dist(pl[i - 1], pl[i]);
    if (acc + l >= s) { const t = (s - acc) / (l || 1); return { x: pl[i - 1].x + (pl[i].x - pl[i - 1].x) * t, y: pl[i - 1].y + (pl[i].y - pl[i - 1].y) * t }; }
    acc += l;
  }
  return pl[pl.length - 1];
}

const TRACKS: Record<SizeName, number> = { hamlet: 1, village: 1, town: 2, city: 3, capital: 3 };

export function routeRoads(
  terrain: TerrainLayer, site: SiteLayer, opts: Options, mapSize: number, rng: Rng,
): { roads: Road[]; bridges: Bridge[]; stats: Record<string, number> } {
  const r = rng.fork('roads');
  const { w: n, cell } = terrain.height;
  const N = n * n;
  const H = blurGrid(terrain.height, 1, 2).data; // smoothed heights: grade from raw noise makes zigzag roads
  const f = site.fields;
  const pass = passability(terrain, f);
  const water = terrain.water;
  const sIds = streamIds(terrain);
  const mainIds = new Set<number>();
  terrain.rivers.forEach((rv, ri) => { if (rv.main) mainIds.add(ri); });
  const centerIdx = Math.min(n - 1, Math.floor(site.center.y / cell)) * n + Math.min(n - 1, Math.floor(site.center.x / cell));
  const costC = site.cost.data;

  // per-cell multiplier: wet ground is avoided, brooks need a ford/bridge, bridges cost extra
  const cm = new Float32Array(N).fill(1);
  for (let i = 0; i < N; i++) {
    if (pass[i] === 2) cm[i] = 40;
    else if (pass[i] === 3) cm[i] = 8;
    else if (pass[i] === 1) {
      let m = 1;
      if (f.dWater[i] < 60 && f.hab[i] < 2) m += 0.7 * (1 - smoothstep(f.hab[i], 0.3, 2));
      if (f.dWater[i] < 4 * cell) m += 0.5 * (1 - f.dWater[i] / (4 * cell)); // keep a margin from banks and shores
      else if (f.hab[i] >= 2 && f.hab[i] < 12 && f.dMain[i] < 400) m *= 0.92; // terrace above the floodplain
      cm[i] = m;
    }
  }

  // ---- exits on the border
  const cands: Exit[] = [];
  const step = Math.max(2, Math.round(30 / cell));
  const push = (x: number, y: number) => {
    const idx = y * n + x;
    if (pass[idx] !== 1 || !isFinite(costC[idx])) return;
    const p = { x: (x + 0.5) * cell, y: (y + 0.5) * cell };
    const eff = dist(p, site.center) / Math.max(1, costC[idx]);
    cands.push({ idx, p, ang: Math.atan2(p.y - site.center.y, p.x - site.center.x), q: eff });
  };
  for (let t = 1; t < n - 1; t += step) { push(t, 0); push(t, n - 1); push(0, t); push(n - 1, t); }
  let qmin = Infinity, qmax = -Infinity;
  for (const c of cands) { qmin = Math.min(qmin, c.q); qmax = Math.max(qmax, c.q); }
  const mainRiver = terrain.rivers.find((rv) => rv.main);
  const bonus = (c: Exit): number => {
    let b = 0;
    if (mainRiver) {
      const ends = [mainRiver.path[0], mainRiver.path[mainRiver.path.length - 1]];
      for (const e of ends) if (dist(e, c.p) < 220) b = Math.max(b, 0.25); // valley routes follow the river
    }
    if (terrain.seaFraction > 0.02 && f.dSea[c.idx] < 260) b = Math.max(b, 0.2); // coast road
    return b;
  };
  const want = roadCount(opts);
  const chosen: Exit[] = [];
  const angDiff = (a: number, b: number) => { let d = Math.abs(a - b) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d; return d; };
  const sector = (2 * Math.PI) / want;
  const jit = cands.map(() => r.float());
  while (chosen.length < want && cands.length) {
    let bi = -1, bs = -Infinity;
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      const qn = (c.q - qmin) / (qmax - qmin + 1e-9);
      let s: number;
      if (!chosen.length) s = qn + bonus(c) + 0.35 * jit[i];
      else {
        let sep = Infinity;
        for (const o of chosen) sep = Math.min(sep, angDiff(c.ang, o.ang));
        if (sep < 0.5 * sector) continue;
        s = 0.5 * qn + bonus(c) + Math.min(sep, sector) / sector + 0.12 * jit[i];
      }
      if (s > bs) { bs = s; bi = i; }
    }
    if (bi < 0) break;
    chosen.push(cands[bi]);
  }

  // ---- route exits -> center (tree-like: later roads are drawn towards earlier ones)
  const used = new Uint8Array(N);
  const owner = new Int16Array(N).fill(-1);
  const hCenter = (idx: number) => 0.8 * costC[idx];
  const roads: Road[] = [];
  const smoothed: Polyline[] = [];
  const rawCells: number[][] = [];
  const reached: boolean[] = [];

  const plannedWater = (cells: number[]): Uint8Array => {
    const pw = new Uint8Array(N);
    for (const c of cells) if (pass[c] >= 2) {
      const cx = c % n, cy = (c / n) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < n && y < n) pw[y * n + x] = 1;
      }
    }
    return pw;
  };
  const unplanned = (pl: Polyline, pw: Uint8Array): number => {
    let bad = 0;
    for (let i = 1; i < pl.length; i++) {
      const a = pl[i - 1], b = pl[i];
      const L = dist(a, b), m = Math.max(1, Math.ceil(L / 2));
      for (let k = 0; k <= m; k++) {
        const t = k / m;
        const x = Math.min(n - 1, Math.max(0, Math.floor((a.x + (b.x - a.x) * t) / cell)));
        const y = Math.min(n - 1, Math.max(0, Math.floor((a.y + (b.y - a.y) * t) / cell)));
        const idx = y * n + x;
        if (water[idx] && !pw[idx]) bad++;
      }
    }
    return bad;
  };
  const isWaterPt = (p: Vec2): boolean => water[Math.min(n - 1, Math.max(0, Math.floor(p.y / cell))) * n + Math.min(n - 1, Math.max(0, Math.floor(p.x / cell)))] !== 0;
  const smoothPath = (cells: number[], startPt: Vec2 | null, endPt: Vec2 | null): Polyline => {
    const raw: Vec2[] = cells.map((i) => ({ x: ((i % n) + 0.5) * cell, y: (((i / n) | 0) + 0.5) * cell }));
    if (startPt) raw[0] = startPt;
    if (endPt) raw[raw.length - 1] = endPt;
    const pw = plannedWater(cells);
    // land-preserving smoothing: relax the resampled path, never pulling a point into water
    const tries: [number, number][] = [[36, 3.4], [16, 1.8], [6, 1]];
    for (const [iters, disp] of tries) {
      let p = relax(raw, iters, disp * cell, isWaterPt);
      p = simplify(p, 0.35);
      if (unplanned(p, pw) === 0) return p;
    }
    // a brook crossing spoils the free smoothing: pin the points within 2 cells of any water, smooth the rest
    const nearWater = (q: Vec2): boolean => {
      const cx = Math.min(n - 1, Math.max(0, Math.floor(q.x / cell))), cy = Math.min(n - 1, Math.max(0, Math.floor(q.y / cell)));
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < n && y < n && water[y * n + x] !== 0) return true;
      }
      return false;
    };
    for (const [iters, disp] of [[36, 3.4], [16, 1.8]] as [number, number][]) {
      const p = simplify(relax(raw, iters, disp * cell, isWaterPt, nearWater), 0.35);
      if (unplanned(p, pw) === 0) return p;
    }
    // last resort: round the corners of the cell path
    for (const it of [2, 1]) {
      const p = resample(chaikin(raw, it), 4);
      if (unplanned(p, pw) === 0) return p;
    }
    return raw;
  };

  const baseCfg = { w: n, h: n, cell, H, pass, cm, discount: 0.45 };
  chosen.forEach((ex, k) => {
    const path = astarFewCrossings({ ...baseCfg, used, hf: hCenter, allowBridge: true }, ex.idx, (i) => i === centerIdx, sIds, mainIds);
    if (!path) return;
    // truncate where the road first touches the existing network
    let cut = path.length;
    let junction = -1;
    for (let i = 1; i < path.length; i++) if (used[path[i]]) { cut = i + 1; junction = path[i]; break; }
    let cells = path.slice(0, cut);
    const ownerRoad = junction >= 0 ? owner[junction] : -1;
    const idxRoad = roads.length;
    for (const c of cells) if (!used[c]) { used[c] = 1; owner[c] = idxRoad; }
    let startPt = { ...ex.p };
    if (ex.idx % n === 0) startPt.x = 0; else if (ex.idx % n === n - 1) startPt.x = mapSize;
    else if (ex.idx < n) startPt.y = 0; else startPt.y = mapSize;
    let endPt: Vec2 | null = null;
    if (junction >= 0 && ownerRoad >= 0 && smoothed[ownerRoad]) {
      const jp = { x: ((junction % n) + 0.5) * cell, y: (((junction / n) | 0) + 0.5) * cell };
      endPt = nearestOnPolyline(smoothed[ownerRoad], jp).pt;
      if (cells.length > 6) cells = cells.slice(0, cells.length - 2); // approach the junction without a kink
    } else if (junction < 0) endPt = { ...site.center };
    const pl = smoothPath(cells, startPt, endPt);
    smoothed.push(pl);
    rawCells.push(cells);
    const toCenter = junction < 0;
    reached.push(toCenter);
    roads.push({ path: pl, kind: 'major', width: ROAD_WIDTH.major });
    void k;
  });
  // roads that merge into another before the center are secondary, unless they are long
  for (let i = 0; i < roads.length; i++) {
    if (!reached[i]) {
      const len = polylineLength(roads[i].path);
      if (len < 900) { roads[i].kind = 'minor'; roads[i].width = ROAD_WIDTH.minor; }
    }
  }
  // make sure at least half the roads are major for readability
  const majors = roads.filter((rd) => rd.kind === 'major').length;
  if (majors < Math.ceil(roads.length / 2)) {
    roads.filter((rd) => rd.kind === 'minor').sort((a, b) => polylineLength(b.path) - polylineLength(a.path))
      .slice(0, Math.ceil(roads.length / 2) - majors).forEach((rd) => { rd.kind = 'major'; rd.width = ROAD_WIDTH.major; });
  }

  // ---- tracks linking neighbouring roads
  const order = roads.map((rd, i) => ({ i, a: Math.atan2(rd.path[0].y - site.center.y, rd.path[0].x - site.center.x) })).sort((a, b) => a.a - b.a);
  const nTracks = roads.length >= 2 ? Math.min(TRACKS[opts.size] + (r.chance(0.35) ? 1 : 0), roads.length) : 0;
  const trackRng = r.fork('tracks');
  let made = 0;
  for (let attempt = 0; attempt < nTracks * 4 && made < nTracks; attempt++) {
    const oi = trackRng.int(0, order.length - 1);
    const A = roads[order[oi].i], B = roads[order[(oi + 1) % order.length].i];
    if (A === B) continue;
    const LA = polylineLength(A.path), LB = polylineLength(B.path);
    const sA = LA * trackRng.range(0.35, 0.8), sB = LB * trackRng.range(0.35, 0.8);
    const pa = pointAtLength(A.path, LA - sA), pb = pointAtLength(B.path, LB - sB);
    const dd = dist(pa, pb);
    if (dd < 150 || dd > 1400) continue;
    const ia = Math.min(n - 1, Math.floor(pa.y / cell)) * n + Math.min(n - 1, Math.floor(pa.x / cell));
    const ib = Math.min(n - 1, Math.floor(pb.y / cell)) * n + Math.min(n - 1, Math.floor(pb.x / cell));
    if (pass[ia] !== 1 || pass[ib] !== 1) continue;
    const bx = ib % n, by = (ib / n) | 0;
    const octile = (idx: number) => {
      const dx = Math.abs((idx % n) - bx), dy = Math.abs(((idx / n) | 0) - by);
      return 0.95 * cell * (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy));
    };
    const cells = astarFewCrossings({ ...baseCfg, hf: octile, allowBridge: false, discount: 1 }, ia, (i) => i === ib, sIds, mainIds);
    if (!cells) continue;
    const pl = smoothPath(cells, pa, pb);
    if (polylineLength(pl) > 1.4 * dd) continue;
    roads.push({ path: pl, kind: 'track', width: ROAD_WIDTH.track });
    made++;
  }

  // ---- bridges: where a road runs over river water
  const bridges: Bridge[] = [];
  for (const rd of roads) {
    const pl = rd.path;
    const samples: { p: Vec2; wet: boolean }[] = [];
    for (let i = 1; i < pl.length; i++) {
      const a = pl[i - 1], b = pl[i];
      const L = dist(a, b), m = Math.max(1, Math.ceil(L / 1.5));
      for (let k = i === 1 ? 0 : 1; k <= m; k++) {
        const t = k / m;
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        const x = Math.min(n - 1, Math.max(0, Math.floor(p.x / cell))), y = Math.min(n - 1, Math.max(0, Math.floor(p.y / cell)));
        samples.push({ p, wet: water[y * n + x] !== 0 });
      }
    }
    const runs: [number, number][] = [];
    for (let i = 0; i < samples.length; i++) {
      if (!samples[i].wet) continue;
      let j = i;
      while (j + 1 < samples.length && samples[j + 1].wet) j++;
      if (runs.length && i - runs[runs.length - 1][1] < 7) runs[runs.length - 1][1] = j; else runs.push([i, j]);
      i = j;
    }
    for (const [i0, j0] of runs) {
      const ia = Math.max(0, i0 - 2), ib = Math.min(samples.length - 1, j0 + 2);
      bridges.push({ a: samples[ia].p, b: samples[ib].p, width: rd.width + 1 });
    }
  }
  return { roads, bridges, stats: { roads: roads.length, bridges: bridges.length } };
}
