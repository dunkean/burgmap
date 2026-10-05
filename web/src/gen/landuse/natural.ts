import { Noise2D } from '../core/noise';
import { distanceField } from '../core/field';
import type { Rng } from '../core/rng';
import { biomeName } from '../biomes';
import type { LandKind, LandUseLayer, TerrainLayer } from '../types';
import { vectorize } from './rural';

/** Undeveloped cover for the environment-only workflow: terrain and vegetation, without cultivation or sites. */
export function generateNaturalCover(terrain: TerrainLayer, biomeOption: string | undefined, root: Rng): LandUseLayer {
  const { w, h, cell } = terrain.height;
  const N = w * h;
  const water = terrain.water;
  const waterMask = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (water[i]) waterMask[i] = 1;
  const dWater = distanceField(waterMask, w, h, cell).dist;
  const slope = terrain.slope.data;
  const height = terrain.height.data;
  const noise = new Noise2D(root.fork('natural-cover'));
  const biome = biomeName(biomeOption);
  const kinds: LandKind[] = ['forest', 'meadow', 'pasture', 'commons', 'marsh'];
  const classes = new Uint8Array(N);
  const windows = kinds.map(() => ({ x0: w, y0: h, x1: -1, y1: -1, count: 0 }));
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    if (water[i]) continue;
    const wx = (x + 0.5) * cell, wy = (y + 0.5) * cell;
    const n = noise.fbm(wx / 720, wy / 720, 3);
    const wet = dWater[i] < 100 && slope[i] < 0.055;
    const low = dWater[i] < 250 && slope[i] < 0.09;
    let kind: LandKind;
    if (biome === 'underdark') kind = low && n > -0.2 ? 'marsh' : 'commons';
    else if (wet && height[i] - terrain.seaLevel < 8 && n > -0.2) kind = 'marsh';
    else if (biome === 'desert') kind = low ? (n > 0.15 ? 'pasture' : 'meadow') : 'commons';
    else if (biome === 'tundra') kind = low ? 'meadow' : n > 0.2 ? 'pasture' : 'commons';
    else if (biome === 'steppe') kind = low ? 'meadow' : n > 0.45 && dWater[i] < 500 ? 'forest' : 'pasture';
    else if (biome === 'forest' || biome === 'tropical') kind = low && n < -0.35 ? 'meadow' : slope[i] > 0.5 ? 'commons' : 'forest';
    else kind = low ? 'meadow' : slope[i] > 0.2 || n > 0.16 ? 'forest' : 'pasture';
    const k = kinds.indexOf(kind);
    classes[i] = k + 1;
    const win = windows[k];
    win.count++;
    if (x < win.x0) win.x0 = x;
    if (x > win.x1) win.x1 = x;
    if (y < win.y0) win.y0 = y;
    if (y > win.y1) win.y1 = y;
  }
  const areas: LandUseLayer['areas'] = [];
  const minArea = Math.max(1200, 2.2 * cell * cell);
  kinds.forEach((kind, k) => {
    const win = windows[k];
    if (!win.count) return;
    const mask = new Float32Array(N);
    for (let i = 0; i < N; i++) if (classes[i] === k + 1) mask[i] = 1;
    for (const region of vectorize(mask, w, h, cell, minArea, win)) {
      areas.push({ kind, poly: region.outer, holes: region.holes });
    }
  });
  return { areas, farmsteads: [], reserve: [] };
}
