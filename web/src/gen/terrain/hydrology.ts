import { Rng } from '../core/rng';
import { Noise2D } from '../core/noise';
import { MinHeap } from '../core/pq';
import { Grid, createGrid, sampleGrid, slopeGrid, blurGrid, D8, D8_DIST } from '../core/grid';
import { Vec2, Polyline, Polygon, chaikin, simplify, resample, polylineLength, dist, polygonArea } from '../core/geom';
import { Options, SIZE_PRESETS, RiverOpt } from '../options';
import type { TerrainLayer, River } from '../types';
import { generateHeightfield, HeightPlan, OPPOSITE, SIDE_VEC, Side } from './heightfield';
import { marchingSquares } from './contour';

const EPS = 0.002;
const smooth = (t: number): number => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

/** Sea = cells at/below sea level connected to the map border through such cells. */
export function seaMaskOf(h: Grid, seaLevel: number): Uint8Array {
  const { w, h: hh } = h;
  const mask = new Uint8Array(w * hh);
  const stack: number[] = [];
  const tryPush = (i: number) => { if (!mask[i] && h.data[i] <= seaLevel) { mask[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { tryPush(x); tryPush((hh - 1) * w + x); }
  for (let y = 0; y < hh; y++) { tryPush(y * w); tryPush(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) tryPush(i - 1);
    if (x < w - 1) tryPush(i + 1);
    if (y > 0) tryPush(i - w);
    if (y < hh - 1) tryPush(i + w);
  }
  return mask;
}

export interface FloodResult { filled: Float32Array; receiver: Int32Array; order: Int32Array }

/**
 * Priority-flood depression filling with epsilon (Barnes, Lehman & Mulla 2014).
 * Outlets: every border cell and every sea cell. Each cell's receiver is the neighbor
 * it was discovered from, so the receiver graph is acyclic and drains to an outlet.
 * `order` lists cells in pop order (receivers always precede their donors).
 */
export function priorityFlood(h: Grid, sea: Uint8Array): FloodResult {
  const { w, h: hh } = h;
  const N = w * hh;
  const src = h.data;
  const filled = new Float32Array(N);
  const receiver = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const order = new Int32Array(N);
  let no = 0;
  const heap = new MinHeap<number>();
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (sea[i] || x === 0 || y === 0 || x === w - 1 || y === hh - 1) {
        closed[i] = 1; filled[i] = src[i]; heap.push(i, src[i]);
      }
    }
  }
  while (heap.size) {
    const c = heap.pop()!;
    order[no++] = c;
    const cx = c % w, cy = (c / w) | 0;
    const fc = filled[c];
    for (let k = 0; k < 8; k++) {
      const nx = cx + D8[k][0], ny = cy + D8[k][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= hh) continue;
      const n = ny * w + nx;
      if (closed[n]) continue;
      closed[n] = 1;
      const v = src[n];
      filled[n] = v > fc ? v : fc + EPS;
      receiver[n] = c;
      heap.push(n, filled[n]);
    }
  }
  return { filled, receiver, order };
}

export function accumulate(receiver: Int32Array, order: Int32Array, inject?: { idx: number; amount: number }[]): Float32Array {
  const acc = new Float32Array(receiver.length).fill(1);
  if (inject) for (const { idx, amount } of inject) acc[idx] += amount;
  for (let k = order.length - 1; k >= 0; k--) {
    const c = order[k];
    const r = receiver[c];
    if (r >= 0) acc[r] += acc[c];
  }
  return acc;
}

interface RiverClass { wSrc: number; wMouth: number; inject: number }
const RIVER_CLASS: Record<Exclude<RiverOpt, 'none'>, RiverClass> = {
  stream: { wSrc: 2.2, wMouth: 5, inject: 0.02 },
  river: { wSrc: 11, wMouth: 24, inject: 0.10 },
  major: { wSrc: 30, wMouth: 58, inject: 0.22 },
};

interface MainRoute { poly: Polyline; srcIdx: number }

/** Dijkstra from an edge inflow to the sea (or opposite edge) preferring downhill / low ground. */
function routeMainRiver(
  height: Grid, filled: Float32Array, sea: Uint8Array, plan: HeightPlan, rng: Rng, amp: number,
): MainRoute | null {
  const { w, h: hh, cell } = height;
  const M = 2;
  const up: Side = OPPOSITE[plan.downSide];
  const uv = SIDE_VEC[up];
  // choose inflow cell along the up edge
  const span0 = Math.floor(w * 0.22), span1 = Math.floor(w * 0.78);
  let best = -1, bestScore = Infinity;
  for (let t = span0; t <= span1; t++) {
    const x = uv.x !== 0 ? (uv.x < 0 ? M : w - 1 - M) : t;
    const y = uv.y !== 0 ? (uv.y < 0 ? M : hh - 1 - M) : t;
    const i = y * w + x;
    const centrality = Math.abs(t - w / 2) / (w / 2);
    const score = filled[i] / Math.max(1, amp) + centrality * 0.12 + rng.float() * 0.05;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  if (best < 0) return null;
  const rn = new Noise2D(rng.fork('routeNoise'));
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < filled.length; i++) { if (filled[i] < minH) minH = filled[i]; if (filled[i] > maxH) maxH = filled[i]; }
  const range = Math.max(1, maxH - minH);

  const N = w * hh;
  const dst = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);
  const heap = new MinHeap<number>();
  dst[best] = 0; heap.push(best, 0);
  const dv = SIDE_VEC[plan.downSide];
  let goal = -1;
  while (heap.size) {
    const c = heap.pop()!;
    if (done[c]) continue;
    done[c] = 1;
    const cx = c % w, cy = (c / w) | 0;
    if (sea[c]) { goal = c; break; }
    if (!plan.seaSide) {
      const onGoal = (dv.x > 0 && cx >= w - 1 - M) || (dv.x < 0 && cx <= M) || (dv.y > 0 && cy >= hh - 1 - M) || (dv.y < 0 && cy <= M);
      if (onGoal) { goal = c; break; }
    }
    for (let k = 0; k < 8; k++) {
      const nx = cx + D8[k][0], ny = cy + D8[k][1];
      if (nx < M || ny < M || nx >= w - M || ny >= hh - M) continue;
      const n = ny * w + nx;
      if (done[n]) continue;
      const d = D8_DIST[k] * cell;
      const dh = filled[n] - filled[c];
      const upSlope = dh > 0 ? dh / d : 0;
      const hn = (filled[n] - minH) / range;
      const nm = 1 + 0.55 * rn.fbm(nx * cell / 260, ny * cell / 260, 2);
      const cost = d * (1 + 40 * upSlope + 1.5 * hn) * nm;
      const nd = dst[c] + cost;
      if (nd < dst[n]) { dst[n] = nd; prev[n] = c; heap.push(n, nd); }
    }
  }
  if (goal < 0) return null;
  const idxs: number[] = [];
  for (let c = goal; c >= 0; c = prev[c]) idxs.push(c);
  idxs.reverse();
  let pts: Vec2[] = idxs.map((i) => ({ x: ((i % w) + 0.5) * cell, y: (((i / w) | 0) + 0.5) * cell }));
  // extend to the map border at the source
  const s = pts[0];
  const edge: Vec2 = { x: s.x + uv.x * (M + 0.5) * cell, y: s.y + uv.y * (M + 0.5) * cell };
  pts.unshift({ x: Math.max(0, Math.min(w * cell, edge.x)), y: Math.max(0, Math.min(hh * cell, edge.y)) });
  if (!plan.seaSide) {
    const e = pts[pts.length - 1];
    pts.push({ x: Math.max(0, Math.min(w * cell, e.x + dv.x * (M + 0.5) * cell)), y: Math.max(0, Math.min(hh * cell, e.y + dv.y * (M + 0.5) * cell)) });
  }
  pts = simplify(pts, cell * 1.3);
  return { poly: pts, srcIdx: best };
}

function movingAvg(a: number[], r: number): number[] {
  const out = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) {
    let s = 0, n = 0;
    for (let k = -r; k <= r; k++) { const j = i + k; if (j >= 0 && j < a.length) { s += a[j]; n++; } }
    out[i] = s / n;
  }
  return out;
}

/** Smooth, resample and add gentle meanders where the terrain is flat. */
function smoothAndMeander(
  pl: Polyline, spacing: number, width: number, slopeAt: (p: Vec2) => number, rng: Rng, meander: boolean, tailFree: boolean,
  lamMin = 90, ampMin = 16,
): Polyline {
  let p = chaikin(pl, 4);
  p = resample(p, spacing);
  if (!meander || p.length < 6) return p;
  const n = p.length;
  // arc length
  const s: number[] = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + dist(p[i - 1], p[i]));
  const L = s[n - 1];
  const lambda = Math.max(lamMin, 12 * width) * rng.range(0.85, 1.25);
  const phi1 = rng.range(0, 6.28), phi2 = rng.range(0, 6.28);
  const ampBase = Math.min(0.3 * lambda, Math.max(ampMin, 3.6 * width));
  const flatRaw = p.map((q) => Math.max(0.3, 1 - smooth((slopeAt(q) - 0.02) / 0.11)));
  const flat = movingAvg(movingAvg(flatRaw, 8), 8);
  const off: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = s[i] / L;
    const taper = smooth(t / 0.05) * (tailFree ? smooth((1 - t) / 0.03) : 1);
    const wave = Math.sin((2 * Math.PI * s[i]) / lambda + phi1) + 0.45 * Math.sin((2 * Math.PI * s[i]) / (lambda * 0.57) + phi2);
    off.push(ampBase * flat[i] * taper * wave / 1.3);
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = p[Math.max(0, i - 1)], b = p[Math.min(n - 1, i + 1)];
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
    out.push({ x: p[i].x - (dy / l) * off[i], y: p[i].y + (dx / l) * off[i] });
  }
  return resample(chaikin(out, 2), spacing);
}

interface Carved { bed: number[] }

/** Carve a channel + floodplain + valley along the polyline into the height grid (in place). */
function carveRiver(height: Grid, pl: Polyline, widths: number[], seaLevel: number, wallS: number, amp: number, filled: Float32Array): Carved {
  const { w, h, cell } = height;
  const H = height.data;
  const n = pl.length;
  // bed (water surface) profile: monotone non-increasing
  const fg: Grid = { w, h, cell, data: filled };
  const z = pl.map((q) => sampleGrid(height, q.x, q.y));
  const zf = pl.map((q) => sampleGrid(fg, q.x, q.y));
  const cap = Math.max(6, 0.15 * amp);
  const zs = movingAvg(z, 6);
  const ds = polylineLength(pl) / Math.max(1, n - 1);
  const bed: number[] = [];
  const floor = seaLevel + 0.45;
  for (let i = 0; i < n; i++) {
    const zi = Math.max(floor, zs[i] - 0.3);
    let b = i === 0 ? zi : Math.max(floor, Math.min(zi, bed[i - 1] - 0.0004 * ds));
    bed.push(b);
  }
  for (let i = 0; i < n; i++) bed[i] = Math.max(bed[i], zf[i] - cap);
  const bestD = new Float32Array(w * h).fill(Infinity);
  const bestT = new Float32Array(w * h);
  const fpHalf = (wd: number) => 1.7 * wd + 7;
  const wallSlope = wallS;
  const maxCut = Math.max(30, amp * 0.45);
  const reach = (wd: number) => fpHalf(wd) + (maxCut / wallSlope) * 1.3;
  const touched: number[] = [];
  const seen = new Uint8Array(w * h);
  for (let i = 0; i < n - 1; i++) {
    const a = pl[i], b = pl[i + 1];
    const vh = Math.max(reach(widths[i]), reach(widths[i + 1]));
    const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - vh) / cell)), x1 = Math.min(w - 1, Math.floor((Math.max(a.x, b.x) + vh) / cell));
    const y0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - vh) / cell)), y1 = Math.min(h - 1, Math.floor((Math.max(a.y, b.y) + vh) / cell));
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const px = (xx + 0.5) * cell, py = (yy + 0.5) * cell;
        const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2));
        const d = Math.hypot(px - a.x - t * dx, py - a.y - t * dy);
        if (d > vh) continue;
        const idx = yy * w + xx;
        if (d < bestD[idx]) {
          if (!seen[idx]) { seen[idx] = 1; touched.push(idx); }
          bestD[idx] = d; bestT[idx] = i + t;
        }
      }
    }
  }
  const lerpAt = (arr: number[], f: number) => { const i = Math.min(arr.length - 2, Math.floor(f)); const t = f - i; return arr[i] * (1 - t) + arr[i + 1] * t; };
  const origSave = new Float32Array(touched.length);
  touched.forEach((idx, k) => { origSave[k] = H[idx]; });
  for (const idx of touched) {
    const f = bestT[idx], d = bestD[idx];
    const wd = lerpAt(widths, f);
    const bedv = lerpAt(bed, f);
    const chan = wd / 2;
    const depth = Math.max(0.5, Math.min(4, 0.12 * wd + 0.3));
    const chFloor = Math.max(seaLevel + 0.1, bedv - depth);
    const bankW = 0.6 * wd + 1.5;
    const fp = fpHalf(wd);
    const orig = H[idx];
    const rise = (dd: number) => 0.35 + 0.012 * Math.max(0, dd - chan - bankW);
    let target: number;
    if (d <= chan) target = chFloor;
    else if (d <= chan + bankW) target = chFloor + (bedv + 0.35 - chFloor) * smooth((d - chan) / bankW);
    else if (d <= fp) target = bedv + rise(d);
    else {
      const x = d - fp;
      target = bedv + rise(fp) + (wallSlope * (x * x)) / (x + 30);
    }
    if (target < orig) {
      if (d <= chan + bankW) H[idx] = target;
      else {
        const dlt = orig - target;
        const rch = reach(wd);
        const fade = smooth((rch - d) / (0.35 * rch));
        H[idx] = orig - dlt * smooth(dlt / 2.5) * fade;
      }
    }
  }
  // smooth the valley walls (removes radial artefacts of nearest-segment distance)
  const delta = createGrid(w, h, cell);
  touched.forEach((idx, k) => { delta.data[idx] = origSave[k] - H[idx]; });
  const bl = blurGrid(delta, 2, 2);
  touched.forEach((idx, k) => {
    const f = bestT[idx];
    if (bestD[idx] > fpHalf(lerpAt(widths, f)) * 1.15) H[idx] = origSave[k] - bl.data[idx];
  });
  return { bed };
}

function labelLakes(depth: Float32Array, sea: Uint8Array, w: number, h: number, thr: number): { comp: Int32Array; sizes: number[] } {
  const comp = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (comp[s] >= 0 || sea[s] || depth[s] <= thr) continue;
    const id = sizes.length; let count = 0;
    comp[s] = id; stack.push(s);
    while (stack.length) {
      const i = stack.pop()!; count++;
      const x = i % w, y = (i / w) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && comp[j] < 0 && !sea[j] && depth[j] > thr) { comp[j] = id; stack.push(j); }
    }
    sizes.push(count);
  }
  return { comp, sizes };
}

/** Pad a w*h field with two rings: ring1 replicates the border, ring2 is `outer` (forces closed loops). */
function padField(f: ArrayLike<number>, w: number, h: number, outer: number): { data: Float32Array; pw: number; ph: number } {
  const pw = w + 4, ph = h + 4;
  const d = new Float32Array(pw * ph).fill(outer);
  for (let y = 0; y < h + 2; y++) {
    for (let x = 0; x < w + 2; x++) {
      const sx = Math.max(0, Math.min(w - 1, x - 1)), sy = Math.max(0, Math.min(h - 1, y - 1));
      d[(y + 1) * pw + (x + 1)] = f[sy * w + sx];
    }
  }
  return { data: d, pw, ph };
}

/** Closed polygons around regions where field > 0 (in world coordinates). */
function regionPolygons(field: ArrayLike<number>, w: number, h: number, cell: number, minArea: number): Polygon[] {
  const { data, pw, ph } = padField(field, w, h, -1);
  const paths = marchingSquares(data, pw, ph, 0, cell, (-1 + 0.5 - 1) * cell + 0 * cell, (-1 + 0.5 - 1) * cell);
  const out: Polygon[] = [];
  for (const p of paths) {
    if (!p.closed || p.pts.length < 4) continue;
    if (Math.abs(polygonArea(p.pts)) < minArea) continue;
    let pts = chaikin(p.pts, 2, true);
    pts = simplify(pts, cell * 0.12);
    out.push(pts);
  }
  return out;
}

/** Stream-power style incision: carve dendritic valleys along the drainage network. */
function incise(height: Grid, amp: number, strength: number): void {
  const N = height.w * height.h;
  const sea = seaMaskOf(height, 0);
  const fl = priorityFlood(height, sea);
  const acc = accumulate(fl.receiver, fl.order);
  const slope = slopeGrid(height);
  const raw = new Float32Array(N);
  const vals: number[] = [];
  for (let i = 0; i < N; i++) {
    if (sea[i] || acc[i] < 12) continue;
    const r = Math.sqrt(acc[i]) * Math.pow(Math.min(0.6, slope.data[i]) + 0.02, 0.6);
    raw[i] = r;
    if ((i & 3) === 0) vals.push(r);
  }
  vals.sort((a, b) => a - b);
  const norm = vals.length ? vals[Math.floor(vals.length * 0.985)] : 1;
  const depthMax = amp * strength;
  const fine = createGrid(height.w, height.h, height.cell);
  for (let i = 0; i < N; i++) fine.data[i] = depthMax * Math.min(1.4, raw[i] / (norm || 1));
  const broad = blurGrid(fine, 3, 2);
  const mid = blurGrid(fine, 1, 1);
  for (let i = 0; i < N; i++) {
    if (sea[i]) continue;
    const dh = 0.2 * fine.data[i] + 0.6 * mid.data[i] + 1.4 * broad.data[i];
    const cur = height.data[i];
    height.data[i] = Math.max(Math.min(cur, 0.4), cur - dh);
  }
}

export interface TerrainTimings { height: number; hydrology: number; rivers: number; polygons: number }

export function generateTerrain(opts: Options, root: Rng): { terrain: TerrainLayer; timings: TerrainTimings } {
  const preset = SIZE_PRESETS[opts.size];
  const mapSize = preset.mapSize, n = preset.grid;
  const rng = root.fork('terrain');
  const t0 = performance.now();
  const { height, plan } = generateHeightfield(opts, mapSize, n, rng);
  const t1 = performance.now();
  const seaLevel = 0;
  const cell = height.cell;
  const N = n * n;

  // ---- pass 1: hydrology on the raw terrain
  const sea = seaMaskOf(height, seaLevel);
  let flood = priorityFlood(height, sea);

  const rivers: River[] = [];
  let mainIdx: Int32Array | null = null;
  let mainPoly: Polyline | null = null;
  let mainWidths: number[] = [];
  let inject: { idx: number; amount: number }[] = [];
  const cls = opts.river === 'none' ? null : RIVER_CLASS[opts.river];
  const slopeRaw = slopeGrid(height);
  const slopeAt = (q: Vec2) => sampleGrid(slopeRaw, q.x, q.y);
  let seaFrac = 0;
  for (let i = 0; i < N; i++) if (sea[i]) seaFrac++;

  if (cls) {
    const rrng = rng.fork('river');
    const route = routeMainRiver(height, flood.filled, sea, plan, rrng, plan.amp);
    if (route) {
      const hasSea = plan.seaSide !== null;
      const approxW = (cls.wSrc + cls.wMouth) / 2;
      const poly = smoothAndMeander(route.poly, Math.max(cell * 0.9, 3), approxW, slopeAt, rrng.fork('meander'), true, hasSea);
      if (hasSea && poly.length > 3) {
        const a = poly[poly.length - 4], b = poly[poly.length - 1];
        const l = dist(a, b) || 1;
        const ext = cell * 1.5;
        poly.push({ x: b.x + ((b.x - a.x) / l) * ext, y: b.y + ((b.y - a.y) / l) * ext });
      }
      // provisional widths (final widths recomputed from accumulation below)
      const provisional = poly.map((_, i) => cls.wSrc + (cls.wMouth - cls.wSrc) * Math.pow(i / Math.max(1, poly.length - 1), 0.7));
      carveRiver(height, poly, provisional, seaLevel, plan.relief === 'mountains' ? 0.5 : 0.24, plan.amp, flood.filled);
      mainPoly = poly;
      const pi = Math.min(N - 1, Math.max(0, Math.floor(poly[Math.min(2, poly.length - 1)].y / cell) * n + Math.floor(poly[Math.min(2, poly.length - 1)].x / cell)));
      inject = [{ idx: pi, amount: cls.inject * N }];
      mainIdx = null;
      mainWidths = provisional;
    }
  }

  // erosion: dendritic valleys along drainage (main river trench already cut, so it stays dominant)
  const iters = plan.relief === 'mountains' ? [0.05] : plan.relief === 'flat' ? [0.09] : [0.07, 0.05];
  for (const st of iters) incise(height, plan.amp, st);
  if (plan.relief === 'mountains') { const sm = blurGrid(height, 1, 1); for (let i = 0; i < N; i++) if (height.data[i] > 1) height.data[i] = sm.data[i]; }

  // ---- pass 2: hydrology on the carved terrain
  const sea2 = seaMaskOf(height, seaLevel);
  flood = priorityFlood(height, sea2);
  const acc = accumulate(flood.receiver, flood.order, inject);
  const t2 = performance.now();

  // main river widths from accumulation along the polyline
  const idxAt = (q: Vec2) => Math.min(n - 1, Math.max(0, Math.floor(q.y / cell))) * n + Math.min(n - 1, Math.max(0, Math.floor(q.x / cell)));
  const mainMask = new Uint8Array(N);
  let accMouth = 1;
  if (mainPoly && cls) {
    const raw = mainPoly.map((q) => {
      // look at the neighbourhood: trench cells hold the largest accumulation
      let m = 0;
      const cx = Math.floor(q.x / cell), cy = Math.floor(q.y / cell);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < n && y < n) m = Math.max(m, acc[y * n + x]);
      }
      return m;
    });
    for (let i = 1; i < raw.length; i++) raw[i] = Math.max(raw[i], raw[i - 1]);
    const sm = movingAvg(raw, 10);
    accMouth = Math.max(...sm);
    const L = mainPoly.length;
    mainWidths = sm.map((a, i) => {
      let wd = cls.wMouth * Math.pow(a / accMouth, 0.5);
      wd = Math.max(cls.wSrc, Math.min(cls.wMouth * 1.05, wd));
      if (plan.seaSide) wd *= 1 + 0.55 * smooth((i / (L - 1) - 0.88) / 0.12);
      return wd;
    });
    mainWidths = movingAvg(mainWidths, 4);
    rivers.push({ path: mainPoly, width: mainWidths, main: true });
    // mark cells around main path
    for (const q of mainPoly) {
      const cx = Math.floor(q.x / cell), cy = Math.floor(q.y / cell);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < n && y < n) mainMask[y * n + x] = 1;
      }
    }
  }
  void mainIdx;

  // ---- lakes from fill depth
  const depth = new Float32Array(N);
  for (let i = 0; i < N; i++) depth[i] = flood.filled[i] - height.data[i];
  const depthThr = plan.relief === 'flat' ? 1.2 : plan.relief === 'mountains' ? 6 : 3;
  const { comp, sizes } = labelLakes(depth, sea2, n, n, depthThr);
  const minCells = Math.max(12, 9000 / (cell * cell));
  const maxDepth = new Float32Array(sizes.length);
  for (let i = 0; i < N; i++) if (comp[i] >= 0 && depth[i] > maxDepth[comp[i]]) maxDepth[comp[i]] = depth[i];
  const lakeDeep = plan.relief === 'flat' ? 2.2 : plan.relief === 'mountains' ? 14 : 7;
  const ranked = sizes.map((s, id) => ({ s, id })).filter((e) => e.s >= minCells && e.s <= N * 0.02 && maxDepth[e.id] >= lakeDeep).sort((a, b) => b.s - a.s || a.id - b.id).slice(0, 2);
  const keep = new Set(ranked.map((e) => e.id));
  const lakeField = new Float32Array(N).fill(-1);
  for (let i = 0; i < N; i++) if (comp[i] >= 0 && keep.has(comp[i])) lakeField[i] = 1;
  const t3 = performance.now();

  // ---- natural streams
  const recv = flood.receiver;
  const thr = Math.max(180, N * (cls ? 0.010 : 0.014));
  const isStream = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (acc[i] >= thr && !sea2[i] && lakeField[i] <= 0) isStream[i] = 1;
  const hasUp = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (isStream[i] && recv[i] >= 0 && isStream[recv[i]]) hasUp[recv[i]] = 1;
  const sources: number[] = [];
  for (let i = 0; i < N; i++) if (isStream[i] && !hasUp[i] && !mainMask[i]) sources.push(i);
  // deterministic order: descending accumulation of the stream's eventual size is unknown; use index order
  const visited = new Uint8Array(N);
  const naturalRaw: { cells: number[]; endsAt: number }[] = [];
  for (const s of sources) {
    if (visited[s]) continue;
    const cells: number[] = [];
    let c = s;
    let endsAt = -1;
    for (;;) {
      if (mainMask[c] || (visited[c] && cells.length > 0)) { endsAt = c; break; }
      cells.push(c); visited[c] = 1;
      const r = recv[c];
      if (r < 0) break;
      if (sea2[r] || lakeField[r] > 0) { endsAt = r; break; }
      c = r;
    }
    if (cells.length >= 4) naturalRaw.push({ cells, endsAt });
  }
  const refMouth = cls ? accMouth : Math.max(thr * 2, ...naturalRaw.map((r) => acc[r.cells[r.cells.length - 1]]));
  const wRefMouth = cls ? cls.wMouth : 4.6;
  const wMinNat = cls ? 1.8 : 1.6;
  for (const r of naturalRaw) {
    const pts: Vec2[] = r.cells.map((i) => ({ x: ((i % n) + 0.5) * cell, y: (((i / n) | 0) + 0.5) * cell }));
    if (r.endsAt >= 0) pts.push({ x: ((r.endsAt % n) + 0.5) * cell, y: (((r.endsAt / n) | 0) + 0.5) * cell });
    if (polylineLength(pts) < 120) continue;
    const rawAcc = r.cells.map((i) => acc[i]);
    if (r.endsAt >= 0) rawAcc.push(acc[r.endsAt]);
    const simp = simplify(pts, cell * 1.4);
    const sm = smoothAndMeander(simp, Math.max(cell * 0.9, 3), 4, slopeAt, rng.fork('nm:' + r.cells[0]), true, false, 200, 7);
    // widths: sample accumulation from nearest cell
    let wv = sm.map((q) => {
      let m = 0;
      const cx = Math.floor(q.x / cell), cy = Math.floor(q.y / cell);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < n && y < n && isStream[y * n + x]) m = Math.max(m, acc[y * n + x]);
      }
      return Math.max(m, thr);
    });
    for (let i = 1; i < wv.length; i++) wv[i] = Math.max(wv[i], wv[i - 1]);
    wv = movingAvg(wv, 8);
    const widths = wv.map((a) => Math.max(wMinNat, Math.min(wRefMouth * 0.8, wRefMouth * Math.pow(a / refMouth, 0.5))));
    rivers.push({ path: sm, width: widths });
  }

  // ---- water mask
  const water = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (sea2[i]) water[i] = 1;
    else if (lakeField[i] > 0) water[i] = 2;
  }
  for (const r of rivers) {
    for (let i = 1; i < r.path.length; i++) {
      const a = r.path[i - 1], b = r.path[i];
      const wd = Math.max(r.width[i - 1], r.width[i]);
      const rad = Math.max(wd / 2, cell * 0.6);
      const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - rad) / cell)), x1 = Math.min(n - 1, Math.floor((Math.max(a.x, b.x) + rad) / cell));
      const y0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - rad) / cell)), y1 = Math.min(n - 1, Math.floor((Math.max(a.y, b.y) + rad) / cell));
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = (x + 0.5) * cell, py = (y + 0.5) * cell;
        const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2));
        if (Math.hypot(px - a.x - t * dx, py - a.y - t * dy) <= rad && water[y * n + x] === 0) water[y * n + x] = 3;
      }
    }
  }

  // ---- polygons
  const seaField = new Float32Array(N);
  for (let i = 0; i < N; i++) seaField[i] = sea2[i] ? Math.max(0.05, seaLevel - height.data[i]) : -Math.max(0.05, height.data[i] - seaLevel);
  const coastline = regionPolygons(seaField, n, n, cell, cell * cell * 6);
  let lakes = regionPolygons(lakeField, n, n, cell, cell * cell * 6);
  void comp;
  lakes = lakes.filter((p) => Math.abs(polygonArea(p)) >= 9000);

  const slope = slopeGrid(height);
  const flowGrid: Grid = createGrid(n, n, cell);
  flowGrid.data.set(acc);
  void idxAt; void seaFrac;
  const t4 = performance.now();

  let seaCells = 0;
  for (let i = 0; i < N; i++) if (sea2[i]) seaCells++;

  const terrain: TerrainLayer = {
    height, slope, water, flow: flowGrid, seaLevel, seaFraction: seaCells / N, coastline, lakes, rivers,
    receiver: flood.receiver, filled: flood.filled, downSide: plan.downSide, seaSide: plan.seaSide,
  };
  return { terrain, timings: { height: t1 - t0, hydrology: t2 - t1, rivers: t3 - t2, polygons: t4 - t3 } };
}
