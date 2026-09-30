import { Rng } from '../core/rng';
import { Noise2D } from '../core/noise';
import { Grid, createGrid } from '../core/grid';
import type { Options, Relief } from '../options';

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
  /** nominal maximum relief in meters */
  amp: number;
  /** Fraction of the map (edge to coast) covered by sea; 0 without coast. */
  seaCover: number;
}

export const RELIEF_RANGE: Record<Relief, [number, number]> = {
  flat: [1, 20],
  hills: [1, 80],
  valley: [1, 110],
  mountains: [1, 400],
};
/** Distance inland over which land rises from the shoreline to full height. */
const COAST_RAMP: Record<Relief, number> = { flat: 260, hills: 420, valley: 420, mountains: 380 };

const smooth = (t: number): number => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

export function generateHeightfield(
  opts: Options, mapSize: number, n: number, rng: Rng,
): { height: Grid; plan: HeightPlan } {
  const noise = new Noise2D(rng.fork('noise'));
  const noise2 = new Noise2D(rng.fork('noise2'));
  const prng = rng.fork('params');
  const relief = opts.relief;
  const cell = mapSize / n;

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

  // valley parameters
  const valleyWidth = prng.range(180, 320);
  const valleyOff = prng.range(-0.08, 0.08) * mapSize;

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = (x + 0.5) * cell, py = (y + 0.5) * cell;
      const along = (px - cx) * tdx + (py - cy) * tdy; // meters toward down side
      const across = -(px - cx) * tdy + (py - cy) * tdx;
      const q = along / mapSize + 0.5; // 0 upstream .. 1 downstream
      let h = 0;
      switch (relief) {
        case 'flat': {
          h = 9 + 4.5 * noise.fbm((px + off) / 1800, py / 1800, 3)
            + 2.6 * noise.warped((px + off) / 650, py / 650, 0.6, 4)
            + 0.35 * noise.fbm(px / 200, py / 200, 2)
            + 6 * (0.5 - q);
          break;
        }
        case 'hills': {
          const [wx, wy] = noise.warp((px + off) / 1500, py / 1500, 0.6);
          const rolling = noise.fbm(wx, wy, 3, 2, 0.4);
          const crest = noise2.ridged((px + off) / 1000, py / 1000, 2) - 0.5;
          h = 40 + 30 * rolling + 12 * crest + 1.8 * noise.fbm(px / 240, py / 240, 2) + 22 * (0.5 - q);
          break;
        }
        case 'mountains': {
          const [wx, wy] = noise.warp((px + off) / 1300, py / 1300, 0.38);
          const r = noise2.ridged(wx, wy, 5, 2.05, 0.42);
          const env = 0.55 + 0.45 * noise.fbm((px + off) / 4500, py / 4500, 2);
          const massif = 0.2 + 0.8 * r * env;
          h = 400 * massif + 10 * noise.fbm(px / 300, py / 300, 3, 2, 0.45) + 40 * (0.5 - q);
          break;
        }
        case 'valley': {
          const sMeander = 320 * noise.fbm((along + off) / 2600, 0.37, 2) + 120 * noise.fbm((along + off) / 900, 5.1, 2);
          const s = across - valleyOff + sMeander;
          const ds = Math.abs(s);
          const floorW = valleyWidth * (0.8 + 0.4 * noise2.fbm(along / 1500, 3.3, 2));
          const wall = smooth((ds - floorW) / (mapSize * 0.42));
          const [wx, wy] = noise.warp((px + off) / 1000, py / 1000, 0.7);
          const hills = 24 * noise.fbm(wx, wy, 4, 2, 0.42) + 3 * noise.fbm(px / 260, py / 260, 2);
          const ridge = 12 * (noise2.ridged((px + off) / 900, py / 900, 2) - 0.5);
          h = 4 + 90 * Math.pow(wall, 1.25) + (hills + ridge) * (0.12 + 0.88 * wall) + 0.5 * noise.fbm(px / 200, py / 200, 2) + 14 * (0.5 - q);
          break;
        }
      }
      H[y * n + x] = h;
    }
  }

  // Normalize to the relief's height range using robust percentiles.
  const [lo, hi] = RELIEF_RANGE[relief];
  const sorted = Float32Array.from(H).sort();
  const p1 = sorted[Math.floor(sorted.length * 0.01)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const k = (hi - lo) / Math.max(1e-6, p99 - p1);
  for (let i = 0; i < H.length; i++) {
    let v = lo + (H[i] - p1) * k;
    if (v > hi) v = hi + (v - hi) * 0.35;
    if (v < lo) v = lo + (v - lo) * 0.35;
    H[i] = Math.max(0.3, v);
  }

  // Coast
  if (seaSide) {
    const sv = SIDE_VEC[seaSide];
    const ramp = COAST_RAMP[relief] * Math.max(1, mapSize / 2400) ** 0.5;
    const c0 = mapSize * (0.5 - seaCover);
    const bayAmp = 0.085 * mapSize, smallAmp = 0.022 * mapSize;
    const coff = prng.range(0, 1000);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const px = (x + 0.5) * cell, py = (y + 0.5) * cell;
        const d = (px - cx) * sv.x + (py - cy) * sv.y;
        const [wx, wy] = noise2.warp((px + coff) / 1700, (py + coff) / 1700, 0.8);
        const bays = noise2.fbm(wx * 1.0, wy * 1.0, 3);
        const fine = noise.fbm((px + coff) / 420, (py - coff) / 420, 3);
        const i = y * n + x;
        const bn = H[i];
        // headlands where terrain is high, bays where low
        const terr = (bn - lo) / Math.max(1, hi - lo);
        const dq = d - c0 - bayAmp * bays - smallAmp * fine - (terr - 0.35) * 0.05 * mapSize;
        if (dq <= 0) {
          const t = Math.min(1, -dq / ramp);
          H[i] = bn * Math.pow(t, 1.25);
        } else {
          H[i] = -Math.min(60, 0.65 * Math.sqrt(dq));
        }
      }
    }
  }

  return {
    height,
    plan: { downSide, seaSide, relief, amp: hi, seaCover },
  };
}
