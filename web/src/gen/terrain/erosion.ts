import { priorityFloodFast } from '../core/flood';
import { Grid, sampleGrid, D8, D8_DIST } from '../core/grid';
import type { Noise2D } from '../core/noise';

/**
 * Fast landscape-evolution approximation used to make mountains read as real mountains:
 * implicit stream-power incision (Braun & Willett 2013, linear n=1) with rock uplift that follows
 * the initial relief, plus thermal (talus) relaxation for the hillslopes.
 * Runs on a coarse copy of the grid (<= maxN cells per side) and the resulting elevation change is
 * upsampled onto the full-resolution field, so cost is independent of the final grid size.
 */

interface Flood { filled: Float32Array; receiver: Int32Array; order: Int32Array }

/** Priority flood; outlets = border cells and cells at/below `seaLevel` (pass a negative level for borders only). */
function flood(h: Float32Array, w: number, hh: number, seaLevel: number): Flood {
  let outlet: Uint8Array | null = null;
  if (seaLevel >= 0) { outlet = new Uint8Array(h.length); for (let i = 0; i < h.length; i++) if (h[i] <= seaLevel) outlet[i] = 1; }
  return priorityFloodFast(h, w, hh, outlet, 0.01);
}

/**
 * Resolve closed depressions by partially filling them and breaching the pour point (a short gorge), instead of
 * filling to the spill height (which leaves flat plateaus between ridges).
 */
function resolvePits(h: Float32Array, fl: Flood, w: number, hh: number, cell: number, frac = 0.35): number {
  const N = w * hh;
  const comp = new Int32Array(N).fill(-1);
  const stack: number[] = [];
  let resolved = 0;
  for (let s = 0; s < N; s++) {
    if (comp[s] >= 0 || fl.filled[s] - h[s] <= 0.05) continue;
    const id = s;
    const cells: number[] = [];
    comp[s] = id; stack.push(s);
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      const cx = c % w, cy = (c / w) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = cx + D8[k][0], ny = cy + D8[k][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= hh) continue;
        const j = ny * w + nx;
        if (comp[j] < 0 && fl.filled[j] - h[j] > 0.05) { comp[j] = id; stack.push(j); }
      }
    }
    let bottom = Infinity, spill = -Infinity, pour = -1;
    for (const c of cells) {
      if (h[c] < bottom) bottom = h[c];
      if (fl.filled[c] > spill) spill = fl.filled[c];
    }
    for (const c of cells) {
      const r = fl.receiver[c];
      if (r >= 0 && comp[r] !== id && (pour < 0 || fl.filled[c] > fl.filled[pour])) pour = c;
    }
    if (pour < 0) continue;
    const L = bottom + frac * (spill - bottom);
    for (const c of cells) if (h[c] < L) h[c] = L;
    let cur = Math.min(h[pour], L);
    h[pour] = cur;
    let r = fl.receiver[pour];
    for (let step = 0; step < 400 && r >= 0; step++) {
      cur = Math.max(0.5, cur - 0.01 * cell);
      if (h[r] <= cur) break;
      h[r] = cur;
      r = fl.receiver[r];
    }
    resolved++;
  }
  return resolved;
}

/** Move material down slopes steeper than `talus` (rise/run). */
function thermal(h: Float32Array, w: number, hh: number, cell: number, talus: number, passes: number, rate = 0.45): void {
  const delta = new Float32Array(w * hh);
  for (let p = 0; p < passes; p++) {
    delta.fill(0);
    for (let y = 1; y < hh - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let bestDrop = 0, bi = -1, bd = 1;
      for (let k = 0; k < 8; k++) {
        const j = i + D8[k][0] + D8[k][1] * w;
        const dh = h[i] - h[j];
        const s = dh / (D8_DIST[k] * cell);
        if (s > talus && dh > bestDrop) { bestDrop = dh; bi = j; bd = D8_DIST[k] * cell; }
      }
      if (bi >= 0) {
        const mv = rate * 0.5 * (bestDrop - talus * bd);
        delta[i] -= mv; delta[bi] += mv;
      }
    }
    for (let i = 0; i < h.length; i++) h[i] += delta[i];
  }
}

function smoothInPlace(h: Float32Array, w: number, hh: number, keep: Uint8Array | null): void {
  const t = new Float32Array(h);
  for (let y = 1; y < hh - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (keep && keep[i]) continue;
    h[i] = 0.5 * t[i] + 0.125 * (t[i - 1] + t[i + 1] + t[i - w] + t[i + w]);
  }
}

export interface MountainCfg {
  n: number; cell: number; mapSize: number;
  /** target relief (p99 elevation) in meters */
  amp: number;
  noise: Noise2D; noise2: Noise2D;
  /** direction water flows towards (unit vector); uplift is higher on the opposite side */
  down: { x: number; y: number };
  /** extent length-scale factor (1 at 2400 m) */
  k: number;
  iters?: number;
  nc?: number;
  /** hillslope talus (rise/run); low values give rounded hills */
  talus?: number;
  /** fine-detail amplitude as a fraction of amp */
  detail?: number;
  /** hillslope diffusion per iteration (0..1): rounds ridges, removes D8 diamond artefacts */
  diffuse?: number;
}

/**
 * Mountain relief from a small landscape-evolution run: uplift field + implicit stream-power incision
 * (Braun & Willett, n=1, m=0.5) + thermal talus, on a coarse grid that extends past the map so the drainage
 * is coherent across its borders. Gives branching valleys and continuous ridgelines instead of noise slabs.
 * Returns elevations (m, >= 0) for the n*n grid.
 */
export function mountainRelief(cfg: MountainCfg): Float32Array {
  const { n, cell, mapSize, amp, noise, noise2, down } = cfg;
  const margin = 0.22;
  const D = mapSize * (1 + 2 * margin);
  const nc = cfg.nc ?? 192;
  const cc = D / nc;
  const x0 = -margin * mapSize;
  const Nc = nc * nc;
  const T = cfg.iters ?? 22;
  const talus = cfg.talus ?? 0.85;
  const U = new Float32Array(Nc);
  const h = new Float32Array(Nc);
  for (let y = 0; y < nc; y++) for (let x = 0; x < nc; x++) {
    const px = x0 + (x + 0.5) * cc, py = x0 + (y + 0.5) * cc;
    const env = noise.fbm(px / (D * 0.55) + 3.1, py / (D * 0.55) - 1.7, 3);
    const q = ((px - mapSize / 2) * down.x + (py - mapSize / 2) * down.y) / mapSize; // + = downstream
    const edge = Math.min(x, y, nc - 1 - x, nc - 1 - y) / (0.1 * nc);
    const e = edge >= 1 ? 1 : edge * edge * (3 - 2 * edge);
    const u = Math.max(0.12, 0.7 + 0.5 * env - 0.55 * q);
    U[y * nc + x] = u * (0.25 + 0.75 * e);
    h[y * nc + x] = 2.5 * u + 0.6 * noise2.fbm(px / (D * 0.12), py / (D * 0.12), 3);
  }
  const bord = (i: number) => { const x = i % nc, y = (i / nc) | 0; return x === 0 || y === 0 || x === nc - 1 || y === nc - 1; };
  for (let i = 0; i < Nc; i++) if (bord(i)) h[i] = 0;
  const um = (amp * 1.25) / T;
  const kk = 1 / Math.sqrt(0.004 * Nc);
  const acc = new Float32Array(Nc);
  for (let it = 0; it < T; it++) {
    for (let i = 0; i < Nc; i++) if (!bord(i)) h[i] += U[i] * um;
    const fl = flood(h, nc, nc, -1);
    resolvePits(h, fl, nc, nc, cc, 0.6);
    acc.fill(1);
    for (let k = Nc - 1; k >= 0; k--) { const c = fl.order[k]; const r = fl.receiver[c]; if (r >= 0) acc[r] += acc[c]; }
    for (let k = 0; k < Nc; k++) {
      const c = fl.order[k];
      const r = fl.receiver[c];
      if (r < 0) continue;
      const dx = Math.abs((c % nc) - (r % nc)), dy = Math.abs(((c / nc) | 0) - ((r / nc) | 0));
      const dl = dx + dy === 2 ? Math.SQRT2 : 1;
      const F = Math.min(6, (kk * Math.sqrt(acc[c])) / dl);
      const cur = h[c];
      h[c] = Math.min(cur, (cur + F * h[r]) / (1 + F));
    }
    thermal(h, nc, nc, cc, talus, 3);
    for (let dpass = 0; dpass < (cfg.diffuse ?? 0) * 3; dpass++) smoothInPlace(h, nc, nc, null);
    for (let i = 0; i < Nc; i++) if (bord(i)) h[i] = 0;
  }
  for (let i = 0; i < Nc; i++) if (h[i] < 0) h[i] = 0;
  thermal(h, nc, nc, cc, talus * 0.95, 4);
  for (let pass = 0; pass < 2; pass++) { const f2 = flood(h, nc, nc, -1); if (!resolvePits(h, f2, nc, nc, cc, 0.5)) break; }
  smoothInPlace(h, nc, nc, null);
  // normalise: p99 of the map window = amp
  const hg: Grid = { w: nc, h: nc, cell: cc, data: h };
  const out = new Float32Array(n * n);
  const warpX = new Float32Array(n * n), warpY = new Float32Array(n * n);
  const samples: number[] = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const wpx = (x + 0.5) * cell + 0.9 * cc * noise2.fbm(((x + 0.5) * cell) / (cc * 6) + 11.3, ((y + 0.5) * cell) / (cc * 6), 2);
    const wpy = (y + 0.5) * cell + 0.9 * cc * noise2.fbm(((x + 0.5) * cell) / (cc * 6) - 4.7, ((y + 0.5) * cell) / (cc * 6) + 2.9, 2);
    warpX[y * n + x] = wpx; warpY[y * n + x] = wpy;
    const v = sampleGrid(hg, wpx - x0, wpy - x0);
    out[y * n + x] = v;
    if (((x + y * 7) & 15) === 0) samples.push(v);
  }
  samples.sort((a, b) => a - b);
  const p99 = samples[Math.floor(samples.length * 0.99)] || 1;
  const sc = amp / p99;
  // detail on the slopes (rock texture, gullies); valley floors stay smooth
  const lamD = Math.max(cell * 6, 260 * cfg.k);
  const octD = Math.max(3, Math.min(6, Math.round(Math.log2(lamD / (cell * 4)))));
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    const px = (x + 0.5) * cell, py = (y + 0.5) * cell;
    const qx = warpX[i] - x0, qy = warpY[i] - x0;
    const gx = sampleGrid(hg, qx + cc, qy) - sampleGrid(hg, qx - cc, qy);
    const gy = sampleGrid(hg, qx, qy + cc) - sampleGrid(hg, qx, qy - cc);
    const sl = (Math.hypot(gx, gy) * sc) / (2 * cc);
    const f = Math.min(1, Math.max(0.15, sl / 0.4));
    const det = (noise2.ridged(px / lamD, py / lamD, octD, 2, 0.5) - 0.5) * (cfg.detail ?? 0.05) * amp * f;
    out[i] = Math.max(0.3, out[i] * sc + det);
  }
  return out;
}

/** Fine-resolution pit resolution (partial fill + breach) so the final filled surface stays close to the terrain. */
export function resolveDepressions(height: Grid, passes = 2, frac = 0.5): void {
  const n = height.w;
  for (let p = 0; p < passes; p++) {
    const fl = flood(height.data, n, n, 0);
    if (!resolvePits(height.data, fl, n, n, height.cell, frac)) break;
  }
}
