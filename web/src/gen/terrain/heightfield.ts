import { Rng } from '../core/rng';
import { Noise2D } from '../core/noise';
import { Grid, createGrid } from '../core/grid';
import { mountainRelief } from './erosion';
import type { Options, Relief } from '../options';
import { importedHeightfield } from './import';

export type Side = 'N' | 'E' | 'S' | 'W';
export const SIDES: Side[] = ['N', 'E', 'S', 'W'];
export const SIDE_VEC: Record<Side, { x: number; y: number }> = {
  N: { x: 0, y: -1 }, E: { x: 1, y: 0 }, S: { x: 0, y: 1 }, W: { x: -1, y: 0 },
};
export const OPPOSITE: Record<Side, Side> = { N: 'S', S: 'N', E: 'W', W: 'E' };

export interface HeightPlan {
  downSide: Side;
  seaSide: Side | null;
  relief: Relief;
  /** nominal maximum relief in meters (after normalisation, before erosion) */
  amp: number;
  /** Fraction of the map (edge to coast) covered by sea; 0 without coast. */
  seaCover: number;
  /** relief-dependent length scale factor for this map extent (1 at 2400 m) */
  k: number;
}

/** Minimum land elevation per relief; the maximum is derived from the extent (see `reliefHeight`). */
export const RELIEF_RANGE: Record<Relief, [number, number]> = {
  flat: [1, 20],
  hills: [1, 80],
  valley: [1, 110],
  mountains: [1, 400],
};

/** Nominal relief height (m) for an extent; grows sub-linearly so a 40 km map has regional relief. */
export function reliefHeight(relief: Relief, mapSize: number): number {
  const e = mapSize / 2400;
  switch (relief) {
    case 'flat': return 20 * Math.pow(e, 0.6);
    case 'hills': return 80 * Math.pow(e, 0.85);
    case 'valley': return 110 * Math.pow(e, 0.85);
    case 'mountains': return 400 * Math.pow(e, 0.78);
  }
}

/** Distance inland over which land rises from the shoreline to full height. */
const COAST_RAMP: Record<Relief, number> = { flat: 260, hills: 420, valley: 420, mountains: 380 };

const smooth = (t: number): number => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

/** fBm with octave wavelengths expressed in meters: from lam0 down to lamMin. Roughly [-1, 1]. */
function fbmL(nz: Noise2D, x: number, y: number, lam0: number, lamMin: number, gain = 0.5): number {
  let amp = 1, f = 1 / lam0, sum = 0, norm = 0;
  for (let o = 0; o < 9 && lam0 / (1 << o) >= lamMin; o++) {
    sum += amp * nz.noise(x * f + o * 17.3, y * f - o * 9.1);
    norm += amp; amp *= gain; f *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Chamfer distance (in cells) to the nearest cell where `isTarget` is set. */
function chamfer(target: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = target[i] ? 0 : INF;
  const S = Math.SQRT2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 1);
    if (y > 0) {
      v = Math.min(v, d[i - w] + 1);
      if (x > 0) v = Math.min(v, d[i - w - 1] + S);
      if (x < w - 1) v = Math.min(v, d[i - w + 1] + S);
    }
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
    if (y < h - 1) {
      v = Math.min(v, d[i + w] + 1);
      if (x < w - 1) v = Math.min(v, d[i + w + 1] + S);
      if (x > 0) v = Math.min(v, d[i + w - 1] + S);
    }
    d[i] = v;
  }
  return d;
}

/** Morphological opening of the land mask: removes land strips thinner than ~2*rho cells (thin peninsulas). */
function removeThinLand(H: Float32Array, n: number, rho: number): void {
  const N = n * n;
  const sea = new Uint8Array(N);
  for (let i = 0; i < N; i++) sea[i] = H[i] <= 0 ? 1 : 0;
  const dSea = chamfer(sea, n, n);
  const keep = new Uint8Array(N);
  for (let i = 0; i < N; i++) keep[i] = dSea[i] >= rho ? 1 : 0;
  const dKeep = chamfer(keep, n, n);
  for (let i = 0; i < N; i++) if (H[i] > 0 && dKeep[i] > rho) H[i] = -0.35;
}

export function generateHeightfield(
  opts: Options, mapSize: number, n: number, rng: Rng,
): { height: Grid; plan: HeightPlan } {
  // imported heightmap replaces the procedural relief (hook, see terrain/import.ts)
  if (opts.importedHeight) return importedHeightfield(opts.importedHeight, mapSize, n, opts.heightScale ?? 120, opts.importSea ?? 0);
  const noise = new Noise2D(rng.fork('noise'));
  const noise2 = new Noise2D(rng.fork('noise2'));
  const prng = rng.fork('params');
  const relief = opts.relief;
  const cell = mapSize / n;
  const e = mapSize / 2400;
  /** length-scale factor for valley widths, meanders etc. */
  const k = clamp(Math.pow(e, 0.85), 0.25, 14);
  /** largest octave wavelength (m): several distinct valleys/ridges across the map at any extent */
  const lam0 = Math.max(450, mapSize * 0.42);
  const lamMin = Math.max(cell * 5, 16);
  const hiNominal = reliefHeight(relief, mapSize);

  const seaSide: Side | null =
    opts.coast === 'none' ? null : opts.coast === 'random' ? prng.pick(SIDES) : (opts.coast as Side);
  const downSide: Side = seaSide ?? prng.pick(SIDES);
  const seaCover = seaSide ? Math.max(0.12, Math.min(0.38, prng.range(0.2, 0.3) + (opts.seaLevel ?? 0) * 0.1)) : 0;

  // tilt direction: cardinal down side, slightly rotated for natural variety
  const ang = prng.range(-0.3, 0.3);
  const dv = SIDE_VEC[downSide];
  const tdx = dv.x * Math.cos(ang) - dv.y * Math.sin(ang);
  const tdy = dv.x * Math.sin(ang) + dv.y * Math.cos(ang);
  const off = prng.range(0, 1000);
  const cx = mapSize / 2, cy = mapSize / 2;

  const height = createGrid(n, n, cell);
  const H = height.data;

  // valley parameters (meters)
  const valleyWidth = prng.range(180, 320) * k;
  const valleyOff = prng.range(-0.08, 0.08) * mapSize;

  const ridgeOct = Math.max(3, Math.min(6, Math.round(Math.log2(Math.max(600, mapSize * 0.55) / (cell * 6)))));

  // Relief from a small landscape-evolution run (always drained: no noise pits / plateaus)
  const simCfg = { n, cell, mapSize, noise, noise2, down: { x: tdx, y: tdy }, k };
  const mtn = relief === 'mountains'
    ? mountainRelief({ ...simCfg, amp: hiNominal * 1.2, nc: mapSize > 8000 ? 224 : 192, diffuse: 0.3 })
    : relief === 'hills'
      ? mountainRelief({ ...simCfg, amp: hiNominal * 1.05, talus: 0.2, detail: 0.025, iters: 18, nc: mapSize > 8000 ? 224 : 176, diffuse: 0.7 })
      : relief === 'valley'
        ? mountainRelief({ ...simCfg, amp: hiNominal * 0.5, talus: 0.2, detail: 0.02, iters: 18, nc: mapSize > 8000 ? 224 : 176, diffuse: 0.7 })
        : null;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = (x + 0.5) * cell, py = (y + 0.5) * cell;
      const along = (px - cx) * tdx + (py - cy) * tdy; // meters toward down side
      const across = -(px - cx) * tdy + (py - cy) * tdx;
      const q = along / mapSize + 0.5; // 0 upstream .. 1 downstream
      let h = 0;
      switch (relief) {
        case 'flat': {
          // very gentle swells: wavelengths 300 m+, detail wavelengths kept tiny in amplitude
          h = 9 + 5.5 * (mapSize / 2400) ** 0.6 * fbmL(noise, px + off, py, Math.max(900, mapSize * 0.5), Math.max(lamMin, 220), 0.42)
            + 6 * e ** 0.6 * (0.5 - q);
          break;
        }
        case 'hills': {
          h = mtn ? mtn[y * n + x] : 0;
          break;
        }
        case 'mountains': {
          h = mtn ? mtn[y * n + x] : 0;
          break;
        }
        case 'valley': {
          const sMeander = 320 * k * noise.fbm((along + off) / (2600 * k), 0.37, 2) + 120 * k * noise.fbm((along + off) / (900 * k), 5.1, 2);
          const s = across - valleyOff + sMeander;
          const ds = Math.abs(s);
          const floorW = valleyWidth * (0.8 + 0.4 * noise2.fbm(along / (1500 * k), 3.3, 2));
          const wall = smooth((ds - floorW) / (mapSize * 0.42));
          const hills = mtn ? mtn[y * n + x] - 0.3 * hiNominal * 0.5 : 0;
          const ridge = 0;
          h = 4 + 62 * (hiNominal / 110) * Math.pow(wall, 1.25) + (hills + ridge) * (0.12 + 0.88 * wall) + 12 * (hiNominal / 110) * (0.5 - q);
          break;
        }
      }
      H[y * n + x] = h;
    }
  }

  // Shift so that the 1st percentile sits at the relief's minimum elevation (no rescale: slopes stay physical).
  const [lo] = RELIEF_RANGE[relief];
  {
    const sorted = Float32Array.from(H).sort();
    const p1 = sorted[Math.floor(sorted.length * 0.01)];
    for (let i = 0; i < H.length; i++) H[i] = Math.max(0.3, lo + (H[i] - p1));
  }
  let hi = 0;
  {
    const sorted = Float32Array.from(H).sort();
    hi = sorted[Math.floor(sorted.length * 0.99)];
  }

  // Coast
  if (seaSide) {
    const sv = SIDE_VEC[seaSide];
    const tv = { x: -sv.y, y: sv.x }; // along the shore
    const ramp = COAST_RAMP[relief] * Math.max(1, mapSize / 2400) ** 0.7;
    const c0 = mapSize * (0.5 - seaCover);
    // shoreline displacement at three scales (bays/headlands, coves, small wiggles), all in meters
    const L1 = Math.max(600, mapSize * 0.5), L2 = Math.max(260, mapSize * 0.12), L3 = clamp(mapSize * 0.06, 200, 2500);
    const A1 = mapSize * prng.range(0.05, 0.1), A2 = mapSize * 0.022, A3 = mapSize * 0.007;
    // occasional large natural bays
    const bigBay = prng.chance(0.55) ? mapSize * prng.range(0.05, 0.12) : 0;
    const coff = prng.range(0, 1000);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const px = (x + 0.5) * cell, py = (y + 0.5) * cell;
        const d = (px - cx) * sv.x + (py - cy) * sv.y;
        const [wx, wy] = noise2.warp((px + coff) / L1, (py + coff) / L1, 0.7);
        const s1 = noise2.fbm(wx, wy, 2);
        const s2 = noise.fbm((px + coff) / L2, (py - coff) / L2, 2);
        const s3 = noise.fbm((px - coff) / L3 + 9.1, (py + coff) / L3, 2);
        const big = bigBay > 0 ? bigBay * Math.max(0, noise2.fbm((px + coff) / (mapSize * 0.45) + 7.7, (py - coff) / (mapSize * 0.45), 2)) ** 1.5 * 4 : 0;
        const i = y * n + x;
        const bn = H[i];
        // headlands where terrain is high, bays where low
        const terr = (bn - lo) / Math.max(1, hi - lo);
        const dq = d - c0 - A1 * s1 * 1.6 - A2 * s2 - A3 * s3 + big - (terr - 0.35) * 0.03 * mapSize;
        if (dq <= 0) {
          const t = Math.min(1, -dq / ramp);
          H[i] = bn * Math.pow(t, 1.25);
        } else {
          H[i] = -Math.min(60, 0.65 * Math.sqrt(dq));
        }
      }
    }
    // no thin peninsulas: remove land strips narrower than ~2*rho
    removeThinLand(H, n, clamp(Math.round((28 * Math.sqrt(k)) / cell), 2, 7));
    // small offshore islands
    if (prng.chance(0.6)) {
      const count = prng.int(1, 4);
      const rs = Math.sqrt(k);
      for (let m = 0; m < count; m++) {
        const along = prng.range(0.15, 0.85) * mapSize;
        const out = prng.range(0.06, 0.2) * mapSize; // seaward distance from the nominal shore
        const ex = cx + sv.x * (c0 - mapSize / 2 + 0) + 0; void ex;
        // point on the nominal shoreline + seaward offset
        const bx = cx + sv.x * c0 + tv.x * (along - mapSize / 2) + sv.x * out;
        const by = cy + sv.y * c0 + tv.y * (along - mapSize / 2) + sv.y * out;
        const r = Math.max(3 * cell, prng.range(40, 140) * rs);
        const peak = prng.range(2.5, 12) * Math.sqrt(k);
        const ph = prng.range(0, 100);
        const x0 = Math.max(0, Math.floor((bx - r * 1.6) / cell)), x1 = Math.min(n - 1, Math.floor((bx + r * 1.6) / cell));
        const y0 = Math.max(0, Math.floor((by - r * 1.6) / cell)), y1 = Math.min(n - 1, Math.floor((by + r * 1.6) / cell));
        for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
          const px = (xx + 0.5) * cell, py = (yy + 0.5) * cell;
          const dd = Math.hypot(px - bx, py - by);
          const wob = 1 + 0.32 * noise2.fbm((px + ph) / (r * 0.9), (py + ph) / (r * 0.9), 2);
          const u = dd / (r * wob);
          if (u >= 1) continue;
          const dome = peak * Math.pow(1 - u * u, 1.1);
          const i = yy * n + xx;
          if (H[i] < 0 && dome > 0.15 && (bx > r * 1.3 && bx < mapSize - r * 1.3 && by > r * 1.3 && by < mapSize - r * 1.3)) H[i] = Math.max(dome, 0.2);
        }
      }
    }
  }

  return {
    height,
    plan: { downSide, seaSide, relief, amp: Math.max(hi, hiNominal * 0.35), seaCover, k },
  };
}
