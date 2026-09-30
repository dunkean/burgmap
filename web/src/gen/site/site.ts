import type { Rng } from '../core/rng';
import { Noise2D } from '../core/noise';
import { MinHeap } from '../core/pq';
import { Grid, createGrid, blurGrid, D8, D8_DIST } from '../core/grid';
import { Vec2, dist } from '../core/geom';
import { distanceField, forCellsNearPolyline, smoothstep } from '../core/field';
import type { Options, SizeName } from '../options';
import type { TerrainLayer, SiteLayer, SiteFields } from '../types';

export const RESERVE_RADIUS: Record<SizeName, number> = { hamlet: 90, village: 170, town: 380, city: 700, capital: 1150 };

/** Passability classes: 0 blocked, 1 land, 2 brook (ford/small bridge), 3 bridgeable main river. */
export function passability(terrain: TerrainLayer, f: SiteFields): Uint8Array {
  const N = terrain.water.length;
  const p = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const wv = terrain.water[i];
    if (wv === 0) p[i] = 1;
    else if (wv === 3) p[i] = f.riverMask[i] === 1 ? (f.bridgeZone[i] ? 3 : 0) : 2;
  }
  return p;
}

export function dijkstra(
  w: number, h: number, start: number, stepCost: (from: number, to: number, dist: number) => number,
): Float32Array {
  const N = w * h;
  const d = new Float64Array(N).fill(Infinity);
  const heap = new MinHeap<number>();
  d[start] = 0; heap.push(start, 0);
  while (heap.size) {
    const key = heap.peekKey();
    const c = heap.pop()!;
    if (key > d[c]) continue;
    const cx = c % w, cy = (c / w) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = cx + D8[k][0], ny = cy + D8[k][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      const sc = stepCost(c, n, D8_DIST[k]);
      if (sc === Infinity) continue;
      const nd = key + sc;
      if (nd < d[n]) { d[n] = nd; heap.push(n, nd); }
    }
  }
  return Float32Array.from(d);
}

interface Cand { p: Vec2; q: number }

export function chooseSite(terrain: TerrainLayer, opts: Options, mapSize: number, rng: Rng): SiteLayer {
  const { w: n, cell } = terrain.height;
  const N = n * n;
  const H = terrain.height.data;
  const water = terrain.water;
  const r = rng.fork('site');

  // ---- river masks (1 main, 2 brook), restricted to water cells
  const riverMask = new Uint8Array(N);
  const main = terrain.rivers.find((rv) => rv.main);
  const markRiver = (rv: typeof terrain.rivers[number], val: number) => {
    for (let i = 1; i < rv.path.length; i++) {
      const rad = Math.max(rv.width[i] / 2, cell * 0.6) + cell * 0.8;
      forCellsNearPolyline([rv.path[i - 1], rv.path[i]], n, n, cell, rad, (idx) => {
        if (water[idx] === 3 && (val === 1 || riverMask[idx] === 0)) riverMask[idx] = val;
      });
    }
  };
  for (const rv of terrain.rivers) if (!rv.main) markRiver(rv, 2);
  if (main) markRiver(main, 1);
  // any river-water cell not claimed by a stroke counts as a brook
  for (let i = 0; i < N; i++) if (water[i] === 3 && !riverMask[i]) riverMask[i] = 2;

  // ---- distance fields
  const anyW = new Uint8Array(N), seaM = new Uint8Array(N), mainM = new Uint8Array(N);
  const carry = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (water[i]) { anyW[i] = 1; carry[i] = water[i] === 1 ? 0 : H[i]; }
    if (water[i] === 1) seaM[i] = 1;
    if (riverMask[i] === 1) mainM[i] = 1;
  }
  if (main && Math.max(...main.width) < 9) for (const rv of [main]) forCellsNearPolyline(rv.path, n, n, cell, 2 * cell, (idx) => { if (water[idx] === 3) mainM[idx] = 1; });
  // a small "main" river is just a brook: it can be forded/bridged anywhere
  if (main && Math.max(...main.width) < 9) for (let i = 0; i < N; i++) if (riverMask[i] === 1) riverMask[i] = 2;
  const dw = distanceField(anyW, n, n, cell, carry);
  const dSea = distanceField(seaM, n, n, cell).dist;
  const dMain = distanceField(mainM, n, n, cell).dist;
  const hab = new Float32Array(N);
  for (let i = 0; i < N; i++) hab[i] = dw.val ? H[i] - dw.val[i] : 99;
  const slopeS = blurGrid(terrain.slope, Math.max(1, Math.round(100 / cell)), 2).data;
  const hc = new Float32Array(N);
  for (let i = 0; i < N; i++) hc[i] = Math.max(0, H[i]);
  const hb = blurGrid({ ...terrain.height, data: hc }, Math.max(2, Math.round(280 / cell)), 2).data;

  const at = (x: number, y: number) => Math.min(n - 1, Math.max(0, Math.floor(y / cell))) * n + Math.min(n - 1, Math.max(0, Math.floor(x / cell)));

  // ---- crossing candidates along the main river
  const cross: Cand[] = [];
  if (main) {
    let wmin = Infinity, wmax = 0;
    for (const v of main.width) { wmin = Math.min(wmin, v); wmax = Math.max(wmax, v); }
    const P = main.path;
    let acc = 0;
    for (let i = 1; i < P.length - 1; i++) {
      acc += dist(P[i - 1], P[i]);
      if (acc < 30) continue;
      acc = 0;
      const p = P[i];
      if (p.x < 0.1 * mapSize || p.y < 0.1 * mapSize || p.x > 0.9 * mapSize || p.y > 0.9 * mapSize) continue;
      const tx = P[i + 1].x - P[i - 1].x, ty = P[i + 1].y - P[i - 1].y, tl = Math.hypot(tx, ty) || 1;
      const nx = -ty / tl, ny = tx / tl;
      const wd = main.width[i];
      const off = wd / 2 + cell * 3;
      const a = at(p.x + nx * off, p.y + ny * off), b = at(p.x - nx * off, p.y - ny * off);
      if (water[a] || water[b]) continue;
      if (dSea[at(p.x, p.y)] < 100) continue;
      const bank = (terrain.slope.data[a] + terrain.slope.data[b]) / 2;
      const rel = (wmax - wd) / (wmax - wmin + 1e-6);
      const q = 0.45 * (1 - smoothstep(wd, 8, 50)) + 0.35 * (1 - smoothstep(bank, 0.03, 0.12)) + 0.2 * rel;
      cross.push({ p, q });
    }
  }
  // ---- harbor candidates: sheltered flat shore
  const harbors: Cand[] = [];
  if (terrain.seaFraction > 0.02) {
    const raw: Cand[] = [];
    for (let y = Math.floor(n * 0.12); y < n * 0.88; y++) for (let x = Math.floor(n * 0.12); x < n * 0.88; x++) {
      const i = y * n + x;
      if (water[i] || dSea[i] > cell * 1.6) continue;
      const wx = (x + 0.5) * cell, wy = (y + 0.5) * cell;
      let land = 0, tot = 0;
      for (let a = 0; a < 12; a++) for (const rad of [70, 140, 210]) {
        const px = wx + Math.cos((a / 12) * 6.2832) * rad, py = wy + Math.sin((a / 12) * 6.2832) * rad;
        if (px < 0 || py < 0 || px > mapSize || py > mapSize) continue;
        tot++;
        if (water[at(px, py)] !== 1) land++;
      }
      const shelter = smoothstep(land / Math.max(1, tot), 0.5, 0.85);
      const flat = 1 - smoothstep(slopeS[i], 0.03, 0.16);
      raw.push({ p: { x: wx, y: wy }, q: (0.25 + 0.75 * shelter) * flat });
    }
    raw.sort((a, b) => b.q - a.q);
    for (const c of raw) {
      if (harbors.length >= 30) break;
      if (harbors.every((o) => dist(o.p, c.p) > 90)) harbors.push(c);
    }
  }

  // ---- scoring
  const jit = new Noise2D(r.fork('jitter'));
  const dirs = 8;
  const lo = Math.floor(n * 0.3), hi = Math.ceil(n * 0.7);
  const promVals: number[] = [];
  for (let y = lo; y < hi; y += 2) for (let x = lo; x < hi; x += 2) { const p = H[y * n + x] - hb[y * n + x]; if (p > 0) promVals.push(p); }
  promVals.sort((a, b) => a - b);
  const promN = Math.max(3, promVals.length ? promVals[Math.floor(promVals.length * 0.9)] : 5);
  const wrapAt = (wx: number, wy: number): number => {
    let c = 0;
    for (let a = 0; a < dirs; a++) {
      const ca = Math.cos((a / dirs) * 6.2832), sa = Math.sin((a / dirs) * 6.2832);
      for (const rad of [60, 120, 180]) {
        const px = wx + ca * rad, py = wy + sa * rad;
        if (px < 0 || py < 0 || px > mapSize || py > mapSize) break;
        if (water[at(px, py)]) { c++; break; }
      }
    }
    return c;
  };

  let best = -1, bestScore = -Infinity;
  const scoreOf = (i: number): number => {
    const x = i % n, y = (i / n) | 0;
    const wx = (x + 0.5) * cell, wy = (y + 0.5) * cell;
    if (water[i]) return -Infinity;
    const flatA = 1 - smoothstep(slopeS[i], 0.015, 0.08);
    const flatP = 1 - smoothstep(terrain.slope.data[i], 0.03, 0.12);
    let dry = dw.dist[i] < 150 ? smoothstep(hab[i], 1, 5) : 1;
    if (main && dMain[i] < 220 && hab[i] < 3) dry *= 0.3;
    if (dSea[i] < 150 && hab[i] < 2.5) dry *= 0.3;
    let cb = 0;
    for (const c of cross) { const d = Math.hypot(c.p.x - wx, c.p.y - wy); if (d < 700) cb = Math.max(cb, c.q * Math.exp(-d / 220)); }
    let hbn = 0;
    for (const c of harbors) { const d = Math.hypot(c.p.x - wx, c.p.y - wy); if (d < 900) hbn = Math.max(hbn, c.q * Math.exp(-d / 260)); }
    const rprox = main ? Math.exp(-Math.max(0, dMain[i] - 30) / 150) : 0;
    const river = main ? 0.5 * rprox + 0.6 * cb : 0;
    const stream = 0.3 * Math.exp(-Math.max(0, dw.dist[i] - 20) / 120);
    const access = Math.max(river, 1.1 * hbn, stream);
    const wrap = wrapAt(wx, wy);
    const prom = Math.max(0, Math.min(1.3, (H[i] - hb[i]) / promN));
    const defense = 0.55 * prom + 0.5 * Math.max(0, Math.min(1, (wrap - 2) / 3)) * (wrap <= 6 ? 1 : 0.3);
    const dc = Math.hypot(wx - mapSize / 2, wy - mapSize / 2) / (0.28 * mapSize);
    const central = 1 - Math.min(1, dc) * 0.6;
    const jitter = jit.fbm(wx / 450, wy / 450, 2);
    return 3 * flatA + flatP + 2 * dry + 2.6 * access + 1.3 * defense + central + 0.85 * jitter;
  };
  // coarse search on every 2nd cell, then refine around the winner
  for (let y = lo; y < hi; y += 2) for (let x = lo; x < hi; x += 2) {
    const i = y * n + x;
    const s = scoreOf(i);
    if (s > bestScore) { bestScore = s; best = i; }
  }
  if (best >= 0) {
    const bx = best % n, by = (best / n) | 0;
    for (let y = by - 1; y <= by + 1; y++) for (let x = bx - 1; x <= bx + 1; x++) {
      if (x < lo || y < lo || x >= hi || y >= hi) continue;
      const i = y * n + x;
      const s = scoreOf(i);
      if (s > bestScore) { bestScore = s; best = i; }
    }
  }
  if (best < 0) best = Math.floor(n / 2) * n + Math.floor(n / 2);
  const center: Vec2 = { x: ((best % n) + 0.5) * cell, y: (((best / n) | 0) + 0.5) * cell };

  // ---- derived site features
  let crossing: Vec2 | undefined;
  if (main) {
    let bs = Infinity;
    for (const c of cross) {
      const s = dist(c.p, center) + 700 * (1 - c.q);
      if (s < bs) { bs = s; crossing = c.p; }
    }
    if (!crossing) {
      let bd = Infinity;
      for (const p of main.path) {
        const d = dist(p, center);
        if (d < bd && p.x > 0.05 * mapSize && p.y > 0.05 * mapSize && p.x < 0.95 * mapSize && p.y < 0.95 * mapSize) { bd = d; crossing = p; }
      }
    }
  }
  let harbor: Vec2 | undefined;
  {
    let bs = -Infinity;
    for (const c of harbors) {
      const d = dist(c.p, center);
      if (d > 1300) continue;
      const s = c.q * Math.exp(-d / 400);
      if (s > bs && c.q > 0.08) { bs = s; harbor = c.p; }
    }
  }
  // citadel: most defensible high ground 300..600 m away
  let citadelSpot: Vec2 | undefined;
  {
    let bs = -Infinity;
    const rMin = 300, rMax = 600;
    const x0 = Math.max(0, Math.floor((center.x - rMax) / cell)), x1 = Math.min(n - 1, Math.floor((center.x + rMax) / cell));
    const y0 = Math.max(0, Math.floor((center.y - rMax) / cell)), y1 = Math.min(n - 1, Math.floor((center.y + rMax) / cell));
    const hC = H[best];
    for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) {
      const wx = (x + 0.5) * cell, wy = (y + 0.5) * cell;
      const d = Math.hypot(wx - center.x, wy - center.y);
      if (d < rMin || d > rMax) continue;
      const i = y * n + x;
      if (water[i] || hab[i] < 4 || wx < 0.12 * mapSize || wy < 0.12 * mapSize || wx > 0.88 * mapSize || wy > 0.88 * mapSize) continue;
      const prom = Math.max(0, (H[i] - hb[i]) / promN);
      const wrap = wrapAt(wx, wy);
      const s = Math.min(1.4, prom) + 0.35 * Math.min(1, wrap / 4) + 0.5 * smoothstep(H[i] - hC, 0, 25)
        - 1.5 * smoothstep(terrain.slope.data[i], 0.18, 0.4) - 0.8 * smoothstep(slopeS[i], 0.06, 0.2) - 0.3 * (d - rMin) / (rMax - rMin);
      if (s > bs) { bs = s; citadelSpot = { x: wx, y: wy }; }
    }
    if (bs < 0.5) citadelSpot = undefined;
  }

  // ---- bridge zone + travel cost
  const bridgeZone = new Uint8Array(N);
  if (crossing) {
    const R = 260;
    const x0 = Math.max(0, Math.floor((crossing.x - R) / cell)), x1 = Math.min(n - 1, Math.floor((crossing.x + R) / cell));
    const y0 = Math.max(0, Math.floor((crossing.y - R) / cell)), y1 = Math.min(n - 1, Math.floor((crossing.y + R) / cell));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (Math.hypot((x + 0.5) * cell - crossing.x, (y + 0.5) * cell - crossing.y) <= R && riverMask[y * n + x] === 1) bridgeZone[y * n + x] = 1;
    }
  }
  const fields: SiteFields = { dWater: dw.dist, dSea, dMain, hab, slopeS, riverMask, bridgeZone };
  const pass = passability(terrain, fields);
  const costArr = dijkstra(n, n, best, (from, to, d) => {
    const pt = pass[to];
    if (!pt) return Infinity;
    const g = pt >= 2 || pass[from] >= 2 ? 0 : Math.abs(H[to] - H[from]) / (d * cell);
    return d * cell * (1 + 100 * g * g) * (pt === 1 ? 1 : pt === 2 ? 4 : 3);
  });
  const cost: Grid = createGrid(n, n, cell);
  cost.data.set(costArr);

  return { center, crossing, harbor, citadelSpot, cost, reserveRadius: RESERVE_RADIUS[opts.size], fields };
}
