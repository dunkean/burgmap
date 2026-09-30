import { Rng } from './rng';

const NG = 32;
const GRAD: [number, number][] = Array.from({ length: NG }, (_, k) => {
  const a = ((k + 0.37) * 2 * Math.PI) / NG;
  return [Math.cos(a), Math.sin(a)] as [number, number];
});
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/** 2D simplex noise, output roughly in [-1, 1]. */
export class Noise2D {
  private perm = new Uint8Array(512);
  constructor(rng: Rng) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.float() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  noise(x: number, y: number): number {
    const perm = this.perm;
    const s = (x + y) * F2;
    const i = Math.floor(x + s), j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t), y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;
    let a = 0.5 - x0 * x0 - y0 * y0;
    if (a > 0) { const g = GRAD[perm[ii + perm[jj]] & 31]; a *= a; n += a * a * (g[0] * x0 + g[1] * y0); }
    a = 0.5 - x1 * x1 - y1 * y1;
    if (a > 0) { const g = GRAD[perm[ii + i1 + perm[jj + j1]] & 31]; a *= a; n += a * a * (g[0] * x1 + g[1] * y1); }
    a = 0.5 - x2 * x2 - y2 * y2;
    if (a > 0) { const g = GRAD[perm[ii + 1 + perm[jj + 1]] & 31]; a *= a; n += a * a * (g[0] * x2 + g[1] * y2); }
    return 75 * n;
  }

  /** Fractal Brownian motion, normalized to roughly [-1,1]. */
  fbm(x: number, y: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * freq + o * 17.3, y * freq - o * 9.1);
      norm += amp; amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal in [0,1]; sharp crests. */
  ridged(x: number, y: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
    let amp = 1, freq = 1, sum = 0, norm = 0, w = 1;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(this.noise(x * freq + o * 31.7, y * freq + o * 5.3));
      n *= n;
      n *= w;
      w = Math.min(1, Math.max(0, n * 1.6));
      sum += amp * n; norm += amp; amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Domain-warped fbm. */
  warped(x: number, y: number, strength = 0.5, octaves = 5): number {
    const [wx, wy] = this.warp(x, y, strength);
    return this.fbm(wx, wy, octaves);
  }

  /** Returns warped coordinates. */
  warp(x: number, y: number, strength: number): [number, number] {
    return [x + strength * this.fbm(x + 5.2, y + 1.3, 3), y + strength * this.fbm(x - 3.7, y + 8.1, 3)];
  }
}
