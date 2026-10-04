/** Drowned river mouths: connected channels rather than an enlarged terminal disc. */
import type { Grid } from '../core/grid';
import type { Polyline } from '../core/geom';
import { dist } from '../core/geom';
import type { Rng } from '../core/rng';

export type EstuaryShape = 'widening' | 'funnel' | 'tidal';
const smooth = (v: number) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };

/** A separate stream keeps mouth choice independent of river routing and tributaries. */
export function chooseEstuaryShape(rng: Rng): EstuaryShape {
  const t = rng.float();
  return t < 0.5 ? 'widening' : t < 0.8 ? 'funnel' : 'tidal';
}

/** Low tide reaches retain their river banks; broader tidal mouths have unequal, gently indented banks.
 * No distributaries are invented: a delta needs a sediment/branch network, which this terrain model lacks. */
export function carveEstuary(height: Grid, path: Polyline, widths: number[], reach: number, seaLevel: number, rng: Rng): EstuaryShape {
  const shape = chooseEstuaryShape(rng.fork('shape'));
  const mouthGain = shape === 'widening' ? rng.range(1.4, 2.2) : shape === 'funnel' ? rng.range(3.3, 5.2) : rng.range(2.6, 4.1);
  const exponent = shape === 'widening' ? 1 : shape === 'funnel' ? 1.8 : 0.8;
  const asymmetry = shape === 'tidal' ? rng.range(-0.25, 0.25) : rng.range(-0.08, 0.08);
  const phase = rng.range(0, 2 * Math.PI);
  const back = new Array<number>(path.length).fill(0);
  for (let i = path.length - 2; i >= 0; i--) back[i] = back[i + 1] + dist(path[i], path[i + 1]);
  // Each cell uses its closest centreline segment once. Sequential segment blending otherwise rounds bends
  // and lowers the same bank repeatedly, independently of the intended cross-section.
  const nearest = new Float32Array(height.data.length).fill(Infinity);
  const lateral = new Float32Array(height.data.length);
  const station = new Float32Array(height.data.length);
  const baseWidth = new Float32Array(height.data.length);
  const touched: number[] = [];
  const { w, h, cell } = height;
  for (let i = 0; i < path.length - 1; i++) {
    if (back[i + 1] > reach) continue;
    const a = path[i], b = path[i + 1], dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const wavinessMax = shape === 'tidal' ? 0.12 : 0;
    const margin = 1.6 * (Math.max(widths[i], widths[i + 1]) / 2 * mouthGain * (1 + Math.abs(asymmetry) + wavinessMax) + cell * 0.25) + cell;
    const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - margin) / cell)), x1 = Math.min(w - 1, Math.floor((Math.max(a.x, b.x) + margin) / cell));
    const y0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - margin) / cell)), y1 = Math.min(h - 1, Math.floor((Math.max(a.y, b.y) + margin) / cell));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = (x + 0.5) * cell - a.x, py = (y + 0.5) * cell - a.y;
      const projection = (px * dx + py * dy) / (len * len);
      // Interior joins remain continuous through bends; only the mouth has a butt end in the existing sea.
      if (i === path.length - 2 && projection > 1) continue;
      const t = Math.max(0, Math.min(1, projection));
      const side = (dx * py - dy * px) / len, d = Math.hypot(px - t * dx, py - t * dy), idx = y * w + x;
      if (d >= nearest[idx]) continue;
      if (!Number.isFinite(nearest[idx])) touched.push(idx);
      nearest[idx] = d; lateral[idx] = side;
      station[idx] = back[i] * (1 - t) + back[i + 1] * t;
      baseWidth[idx] = widths[i] * (1 - t) + widths[i + 1] * t;
    }
  }
  for (const idx of touched) {
    if (station[idx] > reach) continue;
    const u = Math.max(0, 1 - station[idx] / reach), grow = Math.pow(u, exponent);
    const waviness = shape === 'tidal' ? 0.12 * Math.sin(3 * Math.PI * u + phase) * smooth(u) : 0;
    const side = lateral[idx] < 0 ? -1 : 1;
    const radius = baseWidth[idx] / 2 * (1 + (mouthGain - 1) * grow) * (1 + side * asymmetry * grow + waviness) + cell * 0.25;
    const d = nearest[idx];
    if (d > radius * 1.6) continue;
    const bed = seaLevel + 2.5 - 3.2 * smooth(u / 0.65);
    const blend = smooth((d - radius) / (0.6 * radius));
    // A tidal mouth can drown its low floodplain, but should not excavate a broad basin through high banks.
    // The already-carved channel remains connected; the cap makes the outer shoreline follow the relief.
    const cutLimit = Math.max(3, Math.min(8, baseWidth[idx] * 0.12));
    const target = Math.max(height.data[idx] - cutLimit, bed * (1 - blend) + height.data[idx] * blend);
    if (target < height.data[idx]) height.data[idx] = target;
  }
  return shape;
}
