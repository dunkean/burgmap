/**
 * Terrain-only preview at any extent: hillshade + hypsometric tint + water, no other stages.
 *   npx tsx scripts/terrain_view.ts --relief mountains --seed 3 --extent 2400 --out out/terrain_x.png
 * Options: --relief --seed --coast --river --lakes(auto|none|some) --extent(m) --px(output size)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeOptions, Relief, CoastOpt, RiverOpt } from '../src/gen/options';
import { terrainForExtent } from '../src/gen/terrain/hydrology';
import { encodePng } from '../src/render/raster';
import { slopeStats } from './terrain_stats';
import { polygonContains } from '../src/gen/core/geom';

const args = process.argv.slice(2);
const get = (k: string, d: string): string => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const extent = Number(get('extent', '2400'));
const px = Number(get('px', '1000'));
const out = get('out', 'out/terrain_view.png');
const opts = makeOptions({
  seed: get('seed', '1'), relief: get('relief', 'hills') as Relief, coast: get('coast', 'none') as CoastOpt, river: get('river', 'river') as RiverOpt,
});
(opts as unknown as { lakes: string }).lakes = get('lakes', 'auto');

const t0 = performance.now();
const { terrain: t, timings } = terrainForExtent(opts, extent);
const ms = performance.now() - t0;
const n = t.height.w, cell = t.height.cell;
const H = t.height.data;
let hmax = 1;
for (let i = 0; i < H.length; i++) if (H[i] > hmax) hmax = H[i];

const img = new Uint8Array(px * px * 4);
const sun = { x: -0.6, y: -0.6, z: 0.55 };
const exag = Math.max(1, 1.5);
const shade = (gx: number, gy: number): number => {
  const nx = -gx * exag, ny = -gy * exag, nz = 1;
  const l = Math.hypot(nx, ny, nz);
  return Math.max(0, (nx * sun.x + ny * sun.y + nz * sun.z) / l / 0.55);
};
const ramp = (h: number): [number, number, number] => {
  const t2 = Math.min(1, h / hmax);
  const g: [number, number, number] = [150, 170, 110], b: [number, number, number] = [200, 175, 120], w: [number, number, number] = [240, 236, 228];
  const a = t2 < 0.5 ? g : b, c = t2 < 0.5 ? b : w;
  const u = t2 < 0.5 ? t2 * 2 : (t2 - 0.5) * 2;
  return [a[0] + (c[0] - a[0]) * u, a[1] + (c[1] - a[1]) * u, a[2] + (c[2] - a[2]) * u];
};
for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
  const gx0 = Math.min(n - 1, Math.floor((x / px) * n)), gy0 = Math.min(n - 1, Math.floor((y / px) * n));
  const i = gy0 * n + gx0;
  const gx = ((H[Math.min(n - 1, gx0 + 1) + gy0 * n] - H[Math.max(0, gx0 - 1) + gy0 * n]) / (2 * cell));
  const gy = ((H[gx0 + Math.min(n - 1, gy0 + 1) * n] - H[gx0 + Math.max(0, gy0 - 1) * n]) / (2 * cell));
  // exaggerate relative to the extent so a 35 km map is still readable
  const k = Math.max(1, extent / 2400) ** 0.5;
  const s = shade(gx * k, gy * k);
  let [r, g, b] = ramp(H[i]);
  const wv = t.water[i];
  if (wv === 1) { r = 90; g = 130; b = 170; } else if (wv === 2) { r = 100; g = 150; b = 190; } else if (wv === 3) { r = 110; g = 160; b = 200; }
  else { const f = 0.62 + 0.5 * s; const ct = H[i] / (hmax / 14); if (Math.abs(ct - Math.round(ct)) < 0.05 * Math.max(1, extent / 2400) ** 0.3) { r *= 0.8; g *= 0.8; b *= 0.8; } r *= f; g *= f; b *= f; }
  const o = (y * px + x) * 4;
  img[o] = Math.min(255, r); img[o + 1] = Math.min(255, g); img[o + 2] = Math.min(255, b); img[o + 3] = 255;
}
// river centerlines (dark) so clipping at the shore is visible
const sc = px / extent;
for (const r of t.rivers) for (const p of r.path) {
  const X = Math.round(p.x * sc), Y = Math.round(p.y * sc);
  if (X >= 0 && Y >= 0 && X < px && Y < px) { const o = (Y * px + X) * 4; img[o] = 20; img[o + 1] = 40; img[o + 2] = 90; }
}
for (const isl of (t as unknown as { islands?: { x: number; y: number }[][] }).islands ?? []) void polygonContains(isl, isl[0]);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, encodePng(img, px, px, 4));
const st = slopeStats(t);
console.log(JSON.stringify({
  out, extent, grid: n, cell: Math.round(cell * 10) / 10, ms: Math.round(ms), timings: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v)])),
  medianSlopePct: Math.round(st.med * 1000) / 10, p95: Math.round(st.p95 * 1000) / 10, hmax: Math.round(hmax),
  rivers: t.rivers.length, lakes: t.lakes.length, sea: Math.round(t.seaFraction * 100), coastPolys: t.coastline.length,
  islands: ((t as unknown as { islands?: unknown[] }).islands ?? []).length,
}));
