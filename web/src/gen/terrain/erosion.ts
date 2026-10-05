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
function flood(h: Float32Array, w: number, hh: number, seaLevel: number, eps = 0.01): Flood {
  let outlet: Uint8Array | null = null;
  if (seaLevel >= 0) { outlet = new Uint8Array(h.length); for (let i = 0; i < h.length; i++) if (h[i] <= seaLevel) outlet[i] = 1; }
  const result = priorityFloodFast(h, w, hh, outlet, eps);
  steepestReceivers(result, w, hh);
  return result;
}

/** Choose physical steepest descent without changing the flood's outlet or topological order. */
export function steepestReceivers(fl: Flood, w: number, hh: number): void {
  const rank = new Int32Array(fl.order.length);
  for (let k = 0; k < fl.order.length; k++) rank[fl.order[k]] = k;
  for (let k = 0; k < fl.order.length; k++) {
    const c = fl.order[k];
    if (fl.receiver[c] < 0) continue;
    const x = c % w, y = (c / w) | 0;
    let best = fl.receiver[c], gradient = 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + D8[d][0], ny = y + D8[d][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= hh) continue;
      const r = ny * w + nx;
      // The rank check also handles equal Float32 elevations on extensive flats.
      if (rank[r] >= k) continue;
      const drop = (fl.filled[c] - fl.filled[r]) / D8_DIST[d];
      if (drop > gradient) { gradient = drop; best = r; }
    }
    fl.receiver[c] = best;
  }
}

interface SplitFlow { first: Int32Array; second: Int32Array; fraction: Float32Array; distance: Float32Array }

/** D-infinity facets split a hillslope's drainage between its two downhill neighbours (Tarboton 1997). */
export function continuousFlow(fl: Flood, w: number, hh: number): SplitFlow {
  const N = fl.order.length;
  const rank = new Int32Array(N);
  for (let k = 0; k < N; k++) rank[fl.order[k]] = k;
  const first = new Int32Array(fl.receiver), second = new Int32Array(N).fill(-1);
  const fraction = new Float32Array(N), distance = new Float32Array(N).fill(1);
  for (let k = 0; k < N; k++) {
    const c = fl.order[k], r = first[c];
    if (r < 0) continue;
    const x = c % w, y = (c / w) | 0;
    const diagonal = Math.abs(x - r % w) + Math.abs(y - ((r / w) | 0)) === 2;
    let best = (fl.filled[c] - fl.filled[r]) / (diagonal ? Math.SQRT2 : 1);
    distance[c] = diagonal ? Math.SQRT2 : 1;
    for (let d = 0; d < 8; d++) {
      const u = D8[d], v = D8[(d + 1) & 7];
      const ax = x + u[0], ay = y + u[1], bx = x + v[0], by = y + v[1];
      if (ax < 0 || ay < 0 || bx < 0 || by < 0 || ax >= w || ay >= hh || bx >= w || by >= hh) continue;
      const a = ay * w + ax, b = by * w + bx;
      if (rank[a] >= k || rank[b] >= k) continue;
      const da = fl.filled[c] - fl.filled[a], db = fl.filled[c] - fl.filled[b];
      const det = u[0] * v[1] - u[1] * v[0];
      const gx = (da * v[1] - db * u[1]) / det;
      const gy = (db * u[0] - da * v[0]) / det;
      const ca = u[0] * gy - u[1] * gx, cb = gx * v[1] - gy * v[0];
      // A facet points outside its 45-degree wedge: its best descent is already a D8 edge.
      if (ca < 0 || cb < 0) continue;
      const slope = Math.hypot(gx, gy);
      if (slope <= best) continue;
      const t = Math.max(0, Math.min(1, Math.atan2(ca, u[0] * gx + u[1] * gy) / (Math.PI / 4)));
      best = slope; first[c] = a; second[c] = b; fraction[c] = t;
      distance[c] = (1 - t) * D8_DIST[d] + t * D8_DIST[(d + 1) & 7];
    }
  }
  return { first, second, fraction, distance };
}

/**
 * Resolve closed depressions by partially filling them and breaching the pour point (a short gorge), instead of
 * filling to the spill height (which leaves flat plateaus between ridges).
 */
function resolvePits(h: Float32Array, fl: Flood, w: number, hh: number, cell: number, frac = 0.35, maxReach = Infinity): number {
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
    let bottom = Infinity, pour = -1;
    for (const c of cells) {
      if (h[c] < bottom) bottom = h[c];
    }
    for (const c of cells) {
      const r = fl.receiver[c];
      if (r >= 0 && comp[r] !== id && (pour < 0 || fl.filled[c] < fl.filled[pour])) pour = c;
    }
    if (pour < 0) continue;
    const spill = fl.filled[pour];
    const L = bottom + frac * (spill - bottom);
    // Compress basin relief towards the spill instead of replacing its lower half by a flat slab.
    for (const c of cells) if (h[c] < spill) h[c] += frac * (spill - h[c]);
    let cur = Math.min(h[pour], L);
    if (Number.isFinite(maxReach)) {
      // Plan the complete outlet before cutting: a failed short breach must not leave a long dead-end scar.
      const path: { i: number; level: number }[] = [{ i: pour, level: cur }];
      let previous = pour, r = fl.receiver[pour], travel = 0, connected = r < 0;
      while (r >= 0) {
        const diagonal = Math.abs(r % w - previous % w) + Math.abs(((r / w) | 0) - ((previous / w) | 0)) === 2;
        const ds = cell * (diagonal ? Math.SQRT2 : 1);
        travel += ds;
        if (travel > maxReach) break;
        cur = Math.max(0.5, cur - Math.min(0.01, ds * 0.0004));
        if (h[r] <= cur) { connected = true; break; }
        path.push({ i: r, level: cur });
        previous = r; r = fl.receiver[r];
        if (r < 0) connected = true;
      }
      if (connected) for (const p of path) {
        const x = p.i % w, y = (p.i / w) | 0;
        const width = Math.min(cell * 8, Math.max(cell * 1.5, (h[p.i] - p.level) / 0.2));
        const radius = Math.ceil(width / cell);
        for (let yy = Math.max(0, y - radius); yy <= Math.min(hh - 1, y + radius); yy++)
          for (let xx = Math.max(0, x - radius); xx <= Math.min(w - 1, x + radius); xx++) {
            const d = cell * Math.hypot(xx - x, yy - y);
            if (d > width) continue;
            const i = yy * w + xx, target = p.level + 0.2 * d;
            if (h[i] > target) h[i] = target;
          }
      }
      resolved++;
      continue;
    }
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

function smoothInPlace(h: Float32Array, w: number, hh: number, keep: Uint8Array | null, strength = 0.5): void {
  const t = new Float32Array(h);
  for (let y = 1; y < hh - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    // Soft protection preserves valley depth without freezing one-cell-wide D8 staircases.
    const weight = strength * (keep && keep[i] ? 0.75 : 1);
    h[i] = (1 - weight) * t[i] + weight * 0.25 * (t[i - 1] + t[i + 1] + t[i - w] + t[i + w]);
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
  /** A low-uplift valley corridor, applied before drainage rather than cut into unrelated hills afterwards. */
  valley?: { width: number; offset: number; noiseOffset: number };
}

const smooth = (t: number): number => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};

/** Smooth, bounded bicubic interpolation; unlike bilinear cells its slopes do not jump at every coarse edge. */
function sampleRelief(g: Grid, px: number, py: number): number {
  const fx = px / g.cell - 0.5, fy = py / g.cell - 0.5;
  const x = Math.floor(fx), y = Math.floor(fy), tx = fx - x, ty = fy - y;
  const at = (dx: number, dy: number) => g.data[Math.max(0, Math.min(g.h - 1, y + dy)) * g.w + Math.max(0, Math.min(g.w - 1, x + dx))];
  const cubic = (a: number, b: number, c: number, d: number, t: number) =>
    b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
  const a = cubic(at(-1, -1), at(0, -1), at(1, -1), at(2, -1), tx);
  const b = cubic(at(-1, 0), at(0, 0), at(1, 0), at(2, 0), tx);
  const c = cubic(at(-1, 1), at(0, 1), at(1, 1), at(2, 1), tx);
  const d = cubic(at(-1, 2), at(0, 2), at(1, 2), at(2, 2), tx);
  // Limit cubic overshoot to the complete local support, retaining finite nonnegative elevations.
  let lo = Infinity, hi = -Infinity;
  for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 2; dx++) { const v = at(dx, dy); lo = Math.min(lo, v); hi = Math.max(hi, v); }
  return Math.max(lo, Math.min(hi, cubic(a, b, c, d, ty)));
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
    let corridor = 1;
    if (cfg.valley) {
      const along = (px - mapSize / 2) * down.x + (py - mapSize / 2) * down.y;
      const across = -(px - mapSize / 2) * down.y + (py - mapSize / 2) * down.x;
      const meander = 320 * cfg.k * noise.fbm((along + cfg.valley.noiseOffset) / (2600 * cfg.k), 0.37, 2)
        + 120 * cfg.k * noise.fbm((along + cfg.valley.noiseOffset) / (900 * cfg.k), 5.1, 2);
      const floor = cfg.valley.width * (0.8 + 0.4 * noise2.fbm(along / (1500 * cfg.k), 3.3, 2));
      const wall = smooth((Math.abs(across - cfg.valley.offset + meander) - floor) / (mapSize * 0.42));
      corridor = 0.055 + 0.945 * Math.pow(wall, 1.25);
    }
    U[y * nc + x] = u * corridor * (0.25 + 0.75 * e);
    h[y * nc + x] = corridor * (2.5 * u + 0.6 * noise2.fbm(px / (D * 0.12), py / (D * 0.12), 3));
  }
  const bord = (i: number) => { const x = i % nc, y = (i / nc) | 0; return x === 0 || y === 0 || x === nc - 1 || y === nc - 1; };
  for (let i = 0; i < Nc; i++) if (bord(i)) h[i] = 0;
  const um = (amp * 1.25) / T;
  const kk = 1 / Math.sqrt(0.004 * Nc);
  const acc = new Float32Array(Nc);
  const channels = new Uint8Array(Nc);
  for (let it = 0; it < T; it++) {
    for (let i = 0; i < Nc; i++) if (!bord(i)) h[i] += U[i] * um;
    const fl = flood(h, nc, nc, -1);
    resolvePits(h, fl, nc, nc, cc, 0.6);
    const flow = continuousFlow(fl, nc, nc);
    acc.fill(1);
    for (let k = Nc - 1; k >= 0; k--) {
      const c = fl.order[k], r = flow.first[c], s = flow.second[c], t = flow.fraction[c];
      if (r >= 0) acc[r] += acc[c] * (1 - t);
      if (s >= 0) acc[s] += acc[c] * t;
    }
    for (let k = 0; k < Nc; k++) {
      const c = fl.order[k];
      const r = flow.first[c], s = flow.second[c], t = flow.fraction[c];
      if (r < 0) continue;
      const lower = s >= 0 ? (1 - t) * h[r] + t * h[s] : h[r];
      const F = Math.min(6, (kk * Math.sqrt(acc[c])) / flow.distance[c]);
      const cur = h[c];
      h[c] = Math.min(cur, (cur + F * lower) / (1 + F));
    }
    thermal(h, nc, nc, cc, talus, 3);
    // Keep converged valleys; diffuse only their hillsides, with a genuine fractional final pass.
    for (let i = 0; i < Nc; i++) channels[i] = acc[i] >= Nc * 0.001 ? 1 : 0;
    const diffusion = Math.max(0, Math.min(1, cfg.diffuse ?? 0)) * 3;
    for (let dpass = 0; dpass < Math.floor(diffusion); dpass++) smoothInPlace(h, nc, nc, channels);
    const remainder = diffusion - Math.floor(diffusion);
    if (remainder > 0) smoothInPlace(h, nc, nc, channels, 0.5 * remainder);
    for (let i = 0; i < Nc; i++) if (bord(i)) h[i] = 0;
  }
  for (let i = 0; i < Nc; i++) if (h[i] < 0) h[i] = 0;
  thermal(h, nc, nc, cc, talus * 0.95, 4);
  for (let pass = 0; pass < 2; pass++) { const f2 = flood(h, nc, nc, -1); if (!resolvePits(h, f2, nc, nc, cc, 0.5)) break; }
  smoothInPlace(h, nc, nc, channels);
  // normalise: p99 of the map window = amp
  const hg: Grid = { w: nc, h: nc, cell: cc, data: h };
  const ag: Grid = { w: nc, h: nc, cell: cc, data: acc };
  const out = new Float32Array(n * n);
  const drainageWeight = new Float32Array(n * n);
  const samples: number[] = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const px = (x + 0.5) * cell, py = (y + 0.5) * cell;
    const drainage = sampleGrid(ag, px - x0, py - x0);
    // Apply one continuous coordinate deformation to hills and valleys together; abrupt per-channel
    // warp suppression disconnects the sampled hillsides from their unwarped drainage lines.
    const warp = 0.9 * cc;
    const wpx = px + warp * noise2.fbm(px / (cc * 6) + 11.3, py / (cc * 6), 2);
    const wpy = py + warp * noise2.fbm(px / (cc * 6) - 4.7, py / (cc * 6) + 2.9, 2);
    drainageWeight[y * n + x] = 1 - 0.85 * smooth((drainage - 4) / Math.max(12, Nc * 0.001 - 4));
    const v = sampleRelief(hg, wpx - x0, wpy - x0);
    out[y * n + x] = v;
    if (((x + y * 7) & 15) === 0) samples.push(v);
  }
  samples.sort((a, b) => a - b);
  const p99 = samples[Math.floor(samples.length * 0.99)] || 1;
  const sc = amp / p99;
  const slopes = new Float32Array(out);
  // detail on the slopes (rock texture, gullies); valley floors stay smooth
  const lamD = Math.max(cell * 6, 260 * cfg.k);
  const octD = Math.max(3, Math.min(6, Math.round(Math.log2(lamD / (cell * 4)))));
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    const px = (x + 0.5) * cell, py = (y + 0.5) * cell;
    const gx = slopes[y * n + Math.min(n - 1, x + 1)] - slopes[y * n + Math.max(0, x - 1)];
    const gy = slopes[Math.min(n - 1, y + 1) * n + x] - slopes[Math.max(0, y - 1) * n + x];
    const sl = (Math.hypot(gx, gy) * sc) / (2 * cell);
    const f = smooth((sl - 0.015) / 0.3) * drainageWeight[i];
    const det = (noise2.ridged(px / lamD, py / lamD, octD, 2, 0.5) - 0.5) * (cfg.detail ?? 0.05) * amp * f;
    out[i] = Math.max(0.3, out[i] * sc + det);
  }
  return out;
}

/** Fine-resolution pit resolution (partial fill + breach) so the final filled surface stays close to the terrain. */
export function resolveDepressions(height: Grid, passes = 2, frac = 0.5): void {
  const n = height.w;
  const reach = Math.max(6 * height.cell, Math.min(400, n * height.cell * 0.04));
  for (let p = 0; p < passes; p++) {
    // An epsilon ramp across a long, already-drained flat is not a real closed depression.
    // Receiver rank supplies acyclicity here, so classify physical basins with exact spill heights.
    const fl = flood(height.data, n, n, 0, 0);
    if (!resolvePits(height.data, fl, n, n, height.cell, frac, reach)) break;
  }
}
