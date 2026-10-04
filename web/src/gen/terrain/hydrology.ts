import { Rng } from '../core/rng';
import { Noise2D } from '../core/noise';
import { MinHeap } from '../core/pq';
import { priorityFloodFast, type FloodResult } from '../core/flood';
import { Grid, createGrid, sampleGrid, slopeGrid, blurGrid, D8, D8_DIST, kthSmallest } from '../core/grid';
import { Vec2, Polyline, Polygon, chaikin, simplify, resample, polylineLength, dist, polygonArea, polygonContains, distToPolyline } from '../core/geom';
import { Options, SIZE_PRESETS, RiverOpt } from '../options';
import type { TerrainLayer, River } from '../types';
import { generateHeightfield, HeightPlan, OPPOSITE, SIDE_VEC, Side } from './heightfield';
import { marchingSquares } from './contour';
import { carveEstuary } from './estuary';
import { resolveDepressions } from './erosion';
import { scaleFor, areaOfWidth, assembleChannels, assignHydraulics, RawChan } from './rivernet';

const EPS = 0.002;
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
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

export type { FloodResult };

/**
 * Priority-flood depression filling with epsilon (Barnes, Lehman & Mulla 2014).
 * Outlets: every border cell and every sea cell. Each cell's receiver is the neighbor
 * it was discovered from, so the receiver graph is acyclic and drains to an outlet.
 * `order` lists cells in pop order (receivers always precede their donors).
 */
export function priorityFlood(h: Grid, sea: Uint8Array): FloodResult {
  return priorityFloodFast(h.data, h.w, h.h, sea, EPS);
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
  const noiseCache = new Float32Array(N).fill(NaN);
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
      let nv = noiseCache[n];
      if (nv !== nv) { nv = rn.fbm(nx * cell / 260, ny * cell / 260, 2); noiseCache[n] = nv; }
      const nm = 1 + 0.55 * nv;
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
function carveRiver(height: Grid, pl: Polyline, widths: number[], seaLevel: number, wallS: number, amp: number, filled: Float32Array, ek = 1): Carved {
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
  const maxCut = Math.min(Math.max(30, amp * 0.45), 110 * Math.sqrt(ek));
  const reach = (wd: number) => fpHalf(wd) + (maxCut / wallSlope) * 1.3;
  const touched: number[] = [];
  const seen = new Uint8Array(w * h);
  // nearest-chord search on a decimated polyline (chords of ~2 cells); indices stay in original vertex units
  const stride = Math.max(1, Math.round((cell * 1.6) / Math.max(1e-6, ds)));
  for (let i = 0; i < n - 1; i += stride) {
    const i2 = Math.min(n - 1, i + stride), span = i2 - i;
    const a = pl[i], b = pl[i2];
    const vh = Math.max(reach(widths[i]), reach(widths[i2]));
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
          bestD[idx] = d; bestT[idx] = i + t * span;
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

interface LakeSite { idx: number }

/** Picks concave valley-floor spots on medium drainage lines and carves a bowl with a lowest rim (the outlet). */
function carveLakes(
  height: Grid, acc1: Float32Array, sea: Uint8Array, mainPoly: Polyline | null, count: number, rng: Rng, ek: number, amp: number,
): LakeSite[] {
  const { w, cell } = height;
  const H = height.data;
  const N = w * w;
  const ra0 = Math.max(3.5 * cell, 85 * Math.pow(ek, 0.75));
  const ringR = Math.max(4, Math.round((ra0 * 3.2) / cell));
  const margin = Math.floor(w * 0.13) + ringR;
  const lo = 0.02 * N, hi = 0.25 * N;
  const seed = rng.int(1, 1 << 30);
  const dirs: [number, number][] = [];
  for (let k = 0; k < 12; k++) dirs.push([Math.cos((k * Math.PI) / 6), Math.sin((k * Math.PI) / 6)]);
  const cands: { i: number; score: number; ax: number; ay: number }[] = [];
  const step = w > 400 ? 2 : 1;
  for (let y = margin; y < w - margin; y += step) for (let x = margin; x < w - margin; x += step) {
    const i = y * w + x;
    if (sea[i] || H[i] < Math.max(4, 0.05 * amp) || acc1[i] < lo || acc1[i] > hi) continue;
    let mh = 0, mn = Infinity, mx = -Infinity, seaNear = false, gx = 0, gy = 0;
    for (const [dx, dy] of dirs) {
      const j = (y + Math.round(dy * ringR)) * w + x + Math.round(dx * ringR);
      const v = H[j];
      if (sea[j] || v < 1) seaNear = true;
      mh += v; if (v < mn) mn = v; if (v > mx) mx = v;
      gx += dx * v; gy += dy * v;
    }
    if (seaNear) continue;
    mh /= dirs.length;
    const R = ringR * cell;
    const conc = (mh - H[i]) / R;
    const tilt = (mx - mn) / (2 * R);
    if (conc < 0.012 || tilt > 0.09) continue;
    const jit = ((Math.imul(i ^ seed, 2654435761) >>> 0) / 4294967296);
    cands.push({ i, score: conc * 8 - tilt * 5 + jit * 0.5, ax: -gx, ay: -gy });
  }
  void N;
  cands.sort((a, b) => b.score - a.score || a.i - b.i);
  const out: LakeSite[] = [];
  const centers: { x: number; y: number }[] = [];
  const mapSize = w * cell;
  for (const c of cands.slice(0, 400)) {
    if (out.length >= count) break;
    const cx = (c.i % w + 0.5) * cell, cy = (((c.i / w) | 0) + 0.5) * cell;
    if (mainPoly && distToPolyline({ x: cx, y: cy }, mainPoly) < 140 * Math.sqrt(ek) + ra0 * 2) continue;
    if (centers.some((o) => Math.hypot(o.x - cx, o.y - cy) < 0.3 * mapSize)) continue;
    // elongated along the valley (downhill) direction, with a lumpy shoreline
    const ang = Math.atan2(c.ay, c.ax);
    const ra = ra0 * rng.range(0.9, 1.6), rb = ra0 * rng.range(0.55, 0.9);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const ph1 = rng.range(0, 6.28), ph2 = rng.range(0, 6.28);
    const wob = (th: number) => 1 + 0.13 * Math.sin(3 * th + ph1) + 0.08 * Math.sin(5 * th + ph2);
    // level = lowest rim sample; refuse hillsides where the rim drops steeply
    let zMin = Infinity, zMax = -Infinity;
    for (let k = 0; k < 24; k++) {
      const th = (k * 2 * Math.PI) / 24;
      const lx = Math.cos(th) * ra * 1.2 * wob(th), ly = Math.sin(th) * rb * 1.2 * wob(th);
      const v = sampleGrid(height, cx + lx * ca - ly * sa, cy + lx * sa + ly * ca);
      if (v < zMin) zMin = v;
      if (v > zMax) zMax = v;
    }
    if ((zMax - zMin) / (2 * ra) > 0.07 || zMin < 2) continue;
    const level = zMin;
    const D = rng.range(4.5, 11) * Math.pow(ek, 0.3);
    const rm = Math.max(ra, rb) * 1.9;
    const x0 = Math.max(0, Math.floor((cx - rm) / cell)), x1 = Math.min(w - 1, Math.floor((cx + rm) / cell));
    const y0 = Math.max(0, Math.floor((cy - rm) / cell)), y1 = Math.min(w - 1, Math.floor((cy + rm) / cell));
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
      const px = (xx + 0.5) * cell - cx, py = (yy + 0.5) * cell - cy;
      const lx = px * ca + py * sa, ly = -px * sa + py * ca;
      const th = Math.atan2(ly, lx);
      const u = Math.hypot(lx / ra, ly / rb) / wob(th);
      const idx = yy * w + xx;
      if (u < 1) {
        const tgt = level - D * (1 - u * u);
        if (tgt < H[idx]) H[idx] = tgt;
      } else if (u < 1.7 && H[idx] > level) {
        const t = smooth((u - 1) / 0.7);
        H[idx] = level + (H[idx] - level) * t;
      }
    }
    out.push({ idx: c.i });
    centers.push({ x: cx, y: cy });
  }
  return out;
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
  // (the 98.5th percentile: an order statistic, no full sort)
  const norm = vals.length ? kthSmallest(vals, Math.floor(vals.length * 0.985)) : 1;
  const depthMax = amp * strength;
  const fine = createGrid(height.w, height.h, height.cell);
  for (let i = 0; i < N; i++) fine.data[i] = depthMax * Math.min(1.4, raw[i] / (norm || 1));
  // D8 flow paths are 45-degree biased: blur the incision delta so no diagonal channels show in the shading
  const fineS = blurGrid(fine, 2, 2);
  const broad = blurGrid(fine, 4, 2);
  const mid = blurGrid(fine, 2, 1);
  for (let i = 0; i < N; i++) {
    if (sea[i]) continue;
    const dh = 0.15 * fineS.data[i] + 0.55 * mid.data[i] + 1.4 * broad.data[i];
    const cur = height.data[i];
    height.data[i] = Math.max(Math.min(cur, 0.4), cur - dh);
  }
}

export interface TerrainTimings { height: number; hydrology: number; rivers: number; polygons: number }

/** Grid resolution for an extent: ~4 m cells for small maps, coarser for big ones, capped at MAX_GRID. */
export const MAX_GRID = 768;
export function gridForExtent(mapSize: number): number {
  const cellTarget = mapSize <= 1600 ? 4 : 4 * Math.pow(mapSize / 1600, 0.63);
  return Math.max(240, Math.min(MAX_GRID, Math.round(mapSize / cellTarget)));
}

export type LakesOpt = 'auto' | 'none' | 'some';

/** Generation entry point for the standard presets: extent comes from the size option. */
export function generateTerrain(opts: Options, root: Rng): { terrain: TerrainLayer; timings: TerrainTimings } {
  return terrainForExtent(opts, SIZE_PRESETS[opts.size].mapSize, root);
}

/**
 * Pure terrain + hydrology for any extent (600 m .. 40 km). Noise wavelengths are in meters, so a big
 * map shows regional relief (several valleys, big river, bays) and a small one local relief.
 * `opts.lakes` ('auto' | 'none' | 'some', not part of the typed Options yet) is read when present.
 */
export function terrainForExtent(opts: Options, mapSize: number, root?: Rng): { terrain: TerrainLayer; timings: TerrainTimings } {
  const n = gridForExtent(mapSize);
  const rng = (root ?? new Rng('burgmap:' + opts.seed)).fork('terrain');
  const lakesOpt: LakesOpt = ((opts as unknown as { lakes?: LakesOpt }).lakes) ?? 'auto';
  const t0 = performance.now();
  const { height, plan } = generateHeightfield(opts, mapSize, n, rng);
  // closed depressions are breached instead of filled (no flat plateaus); real lakes are carved on purpose later
  resolveDepressions(height, 2, 0.7);
  const t1 = performance.now();
  const seaLevel = 0;
  const cell = height.cell;
  const N = n * n;
  const ek = plan.k; // extent scale factor (1 at 2400 m)
  const widthK = clamp(Math.pow(mapSize / 2400, 0.55), 0.6, 6);

  // ---- pass 1: hydrology on the raw terrain
  const sea = seaMaskOf(height, seaLevel);
  let flood = priorityFlood(height, sea);

  const rivers: River[] = [];
  let mainIdx: Int32Array | null = null;
  let mainPoly: Polyline | null = null;
  let mainWidths: number[] = [];
  let inject: { idx: number; amount: number }[] = [];
  const cls0 = opts.river === 'none' ? null : RIVER_CLASS[opts.river];
  const cls: RiverClass | null = cls0 ? { wSrc: cls0.wSrc * widthK, wMouth: cls0.wMouth * widthK, inject: cls0.inject } : null;
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
      const poly = smoothAndMeander(route.poly, Math.max(cell * 0.9, 3), approxW, slopeAt, rrng.fork('meander'), true, hasSea, 90 * Math.min(ek, 6), 16 * Math.min(ek, 6));
      if (poly.length > 1) {
        // the head always sits exactly on the map edge (and so does the tail when the river leaves the map)
        const mapS = n * cell;
        const snap = (q: Vec2): void => {
          const ds = [q.x, q.y, mapS - q.x, mapS - q.y];
          let kk = 0; for (let i = 1; i < 4; i++) if (ds[i] < ds[kk]) kk = i;
          if (ds[kk] > 6 * cell) return;
          if (kk === 0) q.x = 0; else if (kk === 1) q.y = 0; else if (kk === 2) q.x = mapS; else q.y = mapS;
        };
        snap(poly[0]);
        if (!hasSea) snap(poly[poly.length - 1]);
      }
      if (hasSea && poly.length > 3) {
        const a = poly[poly.length - 4], b = poly[poly.length - 1];
        const l = dist(a, b) || 1;
        const ext = cell * 1.5;
        poly.push({ x: b.x + ((b.x - a.x) / l) * ext, y: b.y + ((b.y - a.y) / l) * ext });
      }
          // provisional widths (final widths recomputed from accumulation below)
      const provisional = poly.map((_, i) => cls.wSrc + (cls.wMouth - cls.wSrc) * Math.pow(i / Math.max(1, poly.length - 1), 0.7));
      carveRiver(height, poly, provisional, seaLevel, plan.relief === 'mountains' ? 0.5 : 0.24, plan.amp, flood.filled, ek);
          if (hasSea) carveEstuary(height, poly, provisional, 700 * Math.sqrt(ek), seaLevel, rrng.fork('estuary'));
      mainPoly = poly;
      const pi = Math.min(N - 1, Math.max(0, Math.floor(poly[Math.min(2, poly.length - 1)].y / cell) * n + Math.floor(poly[Math.min(2, poly.length - 1)].x / cell)));
      inject = [{ idx: pi, amount: cls.inject * N }];
      mainIdx = null;
      mainWidths = provisional;
    }
  }

  // erosion: dendritic valleys along drainage (main river trench already cut, so it stays dominant)
  const iters = plan.relief === 'mountains' ? [0.02] : plan.relief === 'flat' ? [0.05] : [0.04, 0.03];
  for (const st of iters) incise(height, plan.amp, st);
  if (plan.relief === 'mountains') { const sm = blurGrid(height, 1, 1); for (let i = 0; i < N; i++) if (height.data[i] > 1) height.data[i] = sm.data[i]; }

  // ---- lakes: carve a few natural basins into valley floors (before the final hydrology pass)
  const lakeSites: { idx: number }[] = [];
  {
    const lrng = rng.fork('lakes');
    const auto = ({ flat: 0.1, hills: 0.2, valley: 0.24, mountains: 0.36 } as const)[plan.relief];
    const want = lakesOpt === 'none' ? 0 : lakesOpt === 'some' ? (mapSize > 6000 ? 3 : mapSize > 2000 ? 2 : 1) : (lrng.chance(auto) ? (mapSize > 8000 && lrng.chance(0.5) ? 2 : 1) : 0);
    if (want > 0) {
      const acc1 = accumulate(flood.receiver, flood.order);
      lakeSites.push(...carveLakes(height, acc1, sea, mainPoly, want, lrng, ek, plan.amp));
    }
  }

  // ---- pass 2: hydrology on the carved terrain
  const sea2 = seaMaskOf(height, seaLevel);
  flood = priorityFlood(height, sea2);
  const acc = accumulate(flood.receiver, flood.order, inject);
  const t2 = performance.now();

  // main river: final widths/areas come from the hydraulics pass below; mark its cells for the tributary tracing
  const idxAt = (q: Vec2) => Math.min(n - 1, Math.max(0, Math.floor(q.y / cell))) * n + Math.min(n - 1, Math.max(0, Math.floor(q.x / cell)));
  const mainMask = new Uint8Array(N);
  const injectAmt = inject.length ? inject[0].amount : 0;
  if (mainPoly && cls) {
    for (const q of mainPoly) {
      const cx = Math.floor(q.x / cell), cy = Math.floor(q.y / cell);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < n && y < n) mainMask[y * n + x] = 1;
      }
    }
  }
  void mainIdx;

  // ---- lakes: only carved basins (real depressions on a valley floor) become lakes; other pits are filled
  const depth = new Float32Array(N);
  for (let i = 0; i < N; i++) depth[i] = flood.filled[i] - height.data[i];
  const { comp } = labelLakes(depth, sea2, n, n, 0.45);
  const keep = new Set<number>();
  for (const c of lakeSites) {
    let id = comp[c.idx];
    if (id < 0) {
      // centre may sit on the very rim: look at the immediate neighbourhood
      const cx = c.idx % n, cy = (c.idx / n) | 0;
      for (let dy = -2; dy <= 2 && id < 0; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < n && y < n && comp[y * n + x] >= 0) { id = comp[y * n + x]; break; }
      }
    }
    if (id >= 0) keep.add(id);
  }
  const lakeField = new Float32Array(N).fill(-1);
  for (let i = 0; i < N; i++) if (comp[i] >= 0 && keep.has(comp[i])) lakeField[i] = 1;
  // remove every other depression (no reservoirs on slopes, no wet bowls)
  for (let i = 0; i < N; i++) if (lakeField[i] < 0 && !sea2[i] && depth[i] > 0) height.data[i] = flood.filled[i];
  const t3 = performance.now();

  // ---- natural streams
  const recv = flood.receiver;
  // displayed-stream threshold scales with map size: only meaningful brooks are drawn (all of it stays in `flow`)
  const sizeK = mapSize / 2400;
  const thr = Math.max(180, N * (cls ? 0.024 : 0.03) * Math.max(0.6, Math.min(2.5, sizeK)));
  const isStream = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (acc[i] >= thr && !sea2[i] && lakeField[i] <= 0) isStream[i] = 1;
  const hasUp = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (isStream[i] && recv[i] >= 0 && isStream[recv[i]]) hasUp[recv[i]] = 1;
  const sources: number[] = [];
  for (let i = 0; i < N; i++) if (isStream[i] && !hasUp[i] && !mainMask[i]) sources.push(i);
  const visited = new Uint8Array(N);
  interface NatRaw { cells: number[]; endsAt: number; forced?: boolean; lakeSrc: number }
  const naturalRaw: NatRaw[] = [];
  // lake outlets first: every lake drains through exactly one river
  for (const id of keep) {
    let bestC = -1, bestA = -1;
    for (let i = 0; i < N; i++) {
      if (comp[i] !== id) continue;
      const r = recv[i];
      if (r < 0 || comp[r] === id) continue;
      if (acc[i] > bestA) { bestA = acc[i]; bestC = i; }
    }
    if (bestC < 0) continue;
    const cells: number[] = [bestC];
    let c = recv[bestC], endsAt = -1;
    for (let steps = 0; steps < 6000; steps++) {
      if (c < 0) break;
      if (sea2[c] || lakeField[c] > 0 || mainMask[c] || visited[c]) { endsAt = c; break; }
      cells.push(c); visited[c] = 1;
      c = recv[c];
    }
    visited[bestC] = 1;
    naturalRaw.push({ cells, endsAt, forced: true, lakeSrc: id });
  }
  const natural: NatRaw[] = [];
  const minRawLen = 100 * Math.min(ek, 3);
  for (const s0 of sources) {
    if (visited[s0]) continue;
    const cells: number[] = [];
    let c = s0;
    let endsAt = -1;
    for (;;) {
      if (mainMask[c] || (visited[c] && cells.length > 0)) { endsAt = c; break; }
      cells.push(c); visited[c] = 1;
      const r = recv[c];
      if (r < 0) break;
      if (sea2[r] || lakeField[r] > 0) { endsAt = r; break; }
      c = r;
    }
    if (cells.length >= 4 && cells.length * cell * 1.1 >= minRawLen) natural.push({ cells, endsAt, lakeSrc: -1 });
  }
  // cap the number of tributaries by upstream area
  const maxTrib = (mapSize < 2000 ? 2 : mapSize < 3000 ? 3 : mapSize < 4200 ? 4 : mapSize < 7000 ? 5 : mapSize < 15000 ? 7 : 9) + (cls ? 0 : 1);
  if (natural.length > maxTrib) {
    const ranked = natural.map((r, k) => ({ k, a: acc[r.cells[r.cells.length - 1]] }))
      .sort((p, q) => q.a - p.a || p.k - q.k).slice(0, maxTrib);
    const keepK = new Set(ranked.map((e) => e.k));
    const kept = natural.filter((_, k) => keepK.has(k));
    natural.length = 0; natural.push(...kept);
  }
  naturalRaw.push(...natural);

  // channel geometry + hydraulics (rivernet.ts): hosts, confluence angles, edge-fed tributaries
  const scale = scaleFor(widthK);
  const ownerCell = new Int32Array(N).fill(-1);
  naturalRaw.forEach((r, k) => { for (const c of r.cells) ownerCell[c] = k; });
  const rawChans: RawChan[] = naturalRaw.map((r, k) => {
    const pts: Vec2[] = r.cells.map((i) => ({ x: ((i % n) + 0.5) * cell, y: (((i / n) | 0) + 0.5) * cell }));
    if (r.endsAt >= 0) pts.push({ x: ((r.endsAt % n) + 0.5) * cell, y: (((r.endsAt / n) | 0) + 0.5) * cell });
    const simp = simplify(pts, cell * 1.4);
    const path = smoothAndMeander(simp, Math.max(cell * 0.9, 3), 4, slopeAt, rng.fork('nm:' + r.cells[0]), true, false, 200 * Math.min(ek, 4), 7 * Math.min(ek, 3));
    const e = r.endsAt;
    let end: RawChan['end'] = 'none', hostRaw = -2, endLake = -1;
    if (e < 0) end = 'none';
    else if (sea2[e]) end = 'sea';
    else if (lakeField[e] > 0) { end = 'lake'; endLake = comp[e]; }
    else if (mainMask[e]) { end = 'host'; hostRaw = -1; }
    else if (ownerCell[e] >= 0 && ownerCell[e] !== k) { end = 'host'; hostRaw = ownerCell[e]; }
    return { path, forced: !!r.forced, end, hostRaw, lakeSrc: r.lakeSrc, endLake, endAcc: acc[r.cells[r.cells.length - 1]] };
  });
  const nEdge = !cls || cls.wMouth < 8 * widthK ? 0 : mapSize < 1400 ? 1 : mapSize < 2000 ? 1 + (rng.fork('nedge').chance(0.5) ? 1 : 0) : mapSize < 3000 ? 2 : mapSize < 4200 ? 2 + (rng.fork('nedge').chance(0.5) ? 1 : 0) : 3;
  const mainMaxW = cls ? cls.wMouth * 1.2 : 0;
  const geo = assembleChannels({
    chans: rawChans, main: mainPoly, mapSize, cell, scale, rng: rng.fork('net'), nEdge,
    edgeW: [scale.brook * 1.3, scale.brook * 2.0], mainMaxW, minLen: 90,
    isWet: (q) => { const i = idxAt(q); return sea2[i] !== 0 || lakeField[i] > 0; },
  });
  const natRivers: River[] = geo.map((g) => ({
    path: g.path, width: g.path.map(() => 1), id: g.id, host: g.host >= 0 ? g.host : undefined, edgeFed: g.edgeFed, w0: g.w0,
    source: g.edgeFed ? 'edge' : g.lakeSrc >= 0 ? 'lake' : 'spring',
    mouth: g.end === 'host' ? 'river' : g.end === 'sea' ? 'sea' : g.end === 'lake' ? 'lake' : 'edge',
    lakeId: g.lakeSrc >= 0 ? g.lakeSrc : undefined, endLake: g.endLake >= 0 ? g.endLake : undefined,
  }));
  const ownerId = new Int32Array(N).fill(-1);
  for (const g of geo) for (const c of naturalRaw[g.raw].cells) ownerId[c] = g.id;
  if (mainPoly) {
    rivers.push({ path: mainPoly, width: mainPoly.map(() => 1), main: true, id: 0, edgeFed: true, source: 'edge', mouth: plan.seaSide ? 'sea' : 'edge' });
  }
  // Few channels may rise inside the map: keep the longest springs (and any spring another kept
  // channel flows into); the rest of the visible network comes in from the map edge.
  const maxSprings = mapSize < 2000 ? 1 : 2;
  const pathLen = (p: Polyline) => { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y); return s; };
  let keptNat = natRivers.slice();
  const springs = keptNat.filter((r) => r.source === 'spring').sort((a, b) => pathLen(a.path) - pathLen(b.path));
  let excess = springs.length - maxSprings;
  for (const s of springs) {
    if (excess <= 0) break;
    if (keptNat.some((r) => r !== s && r.host === s.id)) continue;
    keptNat = keptNat.filter((r) => r !== s);
    excess--;
  }
  rivers.push(...keptNat);

  // ---- polygons (sea and lakes): needed before the water mask so river ribbons can be clipped at the shore
  const seaField = new Float32Array(N);
  for (let i = 0; i < N; i++) seaField[i] = sea2[i] ? Math.max(0.05, seaLevel - height.data[i]) : -Math.max(0.05, height.data[i] - seaLevel);
  const seaLoops = regionPolygons(seaField, n, n, cell, cell * cell * 6);
  // Marching-square chaining does not prescribe winding. Nesting, rather than its arbitrary orientation,
  // distinguishes the sea's outer loops from genuinely dry islands.
  const coastline: Polygon[] = [];
  const islands: Polygon[] = [];
  const seaAreas = seaLoops.map((p) => Math.abs(polygonArea(p)));
  for (let i = 0; i < seaLoops.length; i++) {
    let depth = 0;
    for (let j = 0; j < seaLoops.length; j++) if (seaAreas[j] > seaAreas[i] && polygonContains(seaLoops[j], seaLoops[i][0])) depth++;
    (depth % 2 ? islands : coastline).push(seaLoops[i]);
  }
  let lakes = regionPolygons(lakeField, n, n, cell, cell * cell * 6);
  lakes = lakes.filter((p) => Math.abs(polygonArea(p)) >= 2500);

  // ---- clip river ribbons at the shoreline (sea and lakes): cut where a river enters water, keep the mouth point
  for (let k = rivers.length - 1; k >= 0; k--) {
    // A lake on an island is still water; apply sea holes only to the sea, then clip the remaining river at lakes.
    const seaClipped = clipRiverAtWater(rivers[k], coastline, islands, { mouth: 'sea' });
    const clipped = seaClipped && clipRiverAtWater(seaClipped, lakes, [], { mouth: 'lake', lakeAt: (p) => lakeComponentAt(height, comp, keep, p) });
    if (!clipped) rivers.splice(k, 1); else rivers[k] = clipped;
  }

  // a mouth that stops a few metres short of the shore is carried to it
  for (const rv of rivers) {
    if (rv.mouth !== 'sea' && rv.mouth !== 'lake') continue;
    const polys = rv.mouth === 'sea' ? coastline : lakes;
    const holes = rv.mouth === 'sea' ? islands : [];
    const last = rv.path[rv.path.length - 1];
    if (polys.some((pg) => polygonContains(pg, last)) && !holes.some((pg) => polygonContains(pg, last))) continue;
    let bd = 45, bp: Vec2 | null = null;
    for (const pg of polys.concat(holes)) for (let i = 0; i < pg.length; i++) {
      const nn = nearestOnPath([pg[i], pg[(i + 1) % pg.length]], last);
      if (nn.d < bd) { bd = nn.d; bp = nn.pt; }
    }
    if (bp && bd > 0.5) rv.path.push(bp), rv.width.push(rv.width[rv.width.length - 1]);
  }

  // ---- hydraulics: contributing areas, widths and classes
  {
    const at = (q: Vec2, rad: number, pick: (i: number) => boolean): number => {
      let m = 0;
      const cx = Math.floor(q.x / cell), cy = Math.floor(q.y / cell);
      for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < n && y < n && pick(y * n + x)) m = Math.max(m, acc[y * n + x]);
      }
      return m;
    };
    const mainHead = mainPoly ? Math.max(0, at(mainPoly[Math.min(3, mainPoly.length - 1)], 2, () => true) - injectAmt) : 0;
    const aint = (q: Vec2, r: River): number => r.main
      ? Math.max(0, at(q, 2, () => true) - injectAmt - mainHead) * cell * cell
      : at(q, 1, (i) => ownerId[i] === r.id) * cell * cell;
    let mainAext = 0, lam = 0;
    const main0 = rivers.find((r) => r.main);
    if (main0 && cls) {
      mainAext = areaOfWidth(cls.wSrc);
      let aMax = 0;
      for (const q of main0.path) aMax = Math.max(aMax, aint(q, main0));
      lam = Math.max(0.5, Math.min(120, (areaOfWidth(cls.wMouth) - mainAext) / Math.max(aMax, 0.05 * N * cell * cell)));
    }
    assignHydraulics({
      rivers, scale, aint, mainAext, lam, lamBrook: 4, lamEdge: 10, mainMouthW: cls ? cls.wMouth : 0, mainHeadW: cls ? cls.wSrc : 0,
      estuary: plan.seaSide ? 1.55 : 1, minBrookW: 1.4 * Math.min(widthK, 2),
    });
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
  if (islands.length) (terrain as TerrainLayer & { islands?: Polygon[] }).islands = islands;
  return { terrain, timings: { height: t1 - t0, hydrology: t2 - t1, rivers: t3 - t2, polygons: t4 - t3 } };
}

function nearestOnPath(pl: Polyline, p: Vec2): { pt: Vec2; d: number } {
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

/**
 * Cut a river polyline where it runs into sea/lake polygons: an initial stretch inside water (a lake outlet
 * that starts in its lake) is trimmed to the shore, and the course ends at the first entry into water (the mouth).
 */
export function clipRiverAtWater(r: River, polys: Polygon[], holes: Polygon[] = [], destination?: { mouth: 'sea' | 'lake'; lakeAt?: (p: Vec2) => number | undefined }): River | null {
  const inside = (p: Vec2): boolean => polys.some((pg) => polygonContains(pg, p)) && !holes.some((pg) => polygonContains(pg, p));
  const pts = r.path;
  const n = pts.length;
  if (n < 2 || !polys.length) return r;
  const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const flags = pts.map(inside);
  if (!flags.some((f) => f)) return r;
  // bisect the shore crossing between an inside and an outside point; returns t of the outside-most sample
  const cross = (a: Vec2, b: Vec2, aInside: boolean): number => {
    let lo = 0, hi = 1; // lo has the same state as a
    for (let it = 0; it < 24; it++) {
      const m = (lo + hi) / 2;
      if (inside(lerp(a, b, m)) === aInside) lo = m; else hi = m;
    }
    return aInside ? hi : lo; // the outside side
  };
  let start = 0;
  let mouthPoint: Vec2 | null = null;
  const path: Vec2[] = [], width: number[] = [];
  if (flags[0]) {
    let j = 0;
    while (j < n && flags[j]) j++;
    if (j >= n) return null;
    const t = cross(pts[j - 1], pts[j], true);
    path.push(lerp(pts[j - 1], pts[j], t)); width.push(r.width[j - 1] + (r.width[j] - r.width[j - 1]) * t);
    start = j;
  }
  for (let i = start; i < n; i++) {
    if (flags[i]) {
      mouthPoint = pts[i];
      const t = cross(pts[i - 1], pts[i], false);
      path.push(lerp(pts[i - 1], pts[i], t)); width.push(r.width[i - 1] + (r.width[i] - r.width[i - 1]) * t);
      break;
    }
    path.push(pts[i]); width.push(r.width[i]);
  }
  if (path.length < 2) return null;
  // Shore clipping can replace an intended downstream confluence with a genuine sea/lake mouth.
  // Trimming only a lake outlet's source must keep its original receiving river.
  const sampledLake = mouthPoint && destination?.mouth === 'lake' ? destination.lakeAt?.(mouthPoint) : undefined;
  const previousLake = r.mouth === 'lake' && r.endLake !== undefined && r.endLake >= 0 ? r.endLake : undefined;
  const endLake = sampledLake !== undefined && sampledLake >= 0 ? sampledLake : previousLake;
  return { ...r, path, width, ...(mouthPoint && destination ? {
    mouth: destination.mouth, host: undefined,
    endLake: destination.mouth === 'lake' ? endLake : undefined,
  } : {}) };
}

/** Smoothed lake shores may reach a neighbouring dry cell; use only a retained basin component. */
export function lakeComponentAt(g: Pick<Grid, 'w' | 'h' | 'cell'>, comp: Int32Array, kept: Set<number>, p: Vec2): number | undefined {
  const x = Math.min(g.w - 1, Math.max(0, Math.floor(p.x / g.cell))), y = Math.min(g.h - 1, Math.max(0, Math.floor(p.y / g.cell)));
  const direct = comp[y * g.w + x];
  if (direct >= 0 && kept.has(direct)) return direct;
  let best = Infinity, id: number | undefined;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
    const c = comp[ny * g.w + nx];
    if (c < 0 || !kept.has(c)) continue;
    const d = Math.hypot((nx + 0.5) * g.cell - p.x, (ny + 0.5) * g.cell - p.y);
    if (d < best) { best = d; id = c; }
  }
  return id;
}
