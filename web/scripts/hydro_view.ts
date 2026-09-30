/**
 * Fast hydrology/road view (no urban, no land use): hillshade + river ribbons by class + roads + bridges.
 *   npx tsx scripts/hydro_view.ts --seed 3 --relief hills --coast none --size town --out out/hydro_x.png [--crop x,y,w] [--width 1400]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { Rng } from '../src/gen/core/rng';
import { offsetRibbon } from '../src/gen/core/geom';
import { makeOptions, SIZE_PRESETS, Relief, CoastOpt, RiverOpt, SizeName } from '../src/gen/options';
import { generateTerrain } from '../src/gen/terrain/hydrology';
import { chooseSite } from '../src/gen/site/site';
import { routeRoads } from '../src/gen/roads/regional';
import { encodePng } from '../src/render/raster';

const args = process.argv.slice(2);
const get = (k: string, d: string): string => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const size = get('size', 'town') as SizeName;
const opts = makeOptions({ seed: get('seed', '1'), relief: get('relief', 'hills') as Relief, coast: get('coast', 'none') as CoastOpt, river: get('river', 'river') as RiverOpt, size });
const out = get('out', 'out/hydro_view.png');
const width = Number(get('width', '1400'));
const cropArg = get('crop', '');
const mapSize = SIZE_PRESETS[size].mapSize;
const root = new Rng('burgmap:' + opts.seed);
const { terrain: t } = generateTerrain(opts, root);
const site = chooseSite(t, opts, mapSize, root);
const rr = routeRoads(t, site, opts, mapSize, root);

const n = t.height.w, cell = t.height.cell, H = t.height.data;
let rx = 0, ry = 0, rw = mapSize;
if (cropArg) { [rx, ry, rw] = cropArg.split(',').map(Number); }
const px = cropArg ? 400 : 500;
const img = new Uint8Array(px * px * 4);
let hmax = 1; for (let i = 0; i < H.length; i++) if (H[i] > hmax) hmax = H[i];
for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
  const gx0 = Math.min(n - 1, Math.max(0, Math.floor(((rx + (x / px) * rw) / mapSize) * n))), gy0 = Math.min(n - 1, Math.max(0, Math.floor(((ry + (y / px) * rw) / mapSize) * n)));
  const gx = (H[Math.min(n - 1, gx0 + 1) + gy0 * n] - H[Math.max(0, gx0 - 1) + gy0 * n]) / (2 * cell);
  const gy = (H[gx0 + Math.min(n - 1, gy0 + 1) * n] - H[gx0 + Math.max(0, gy0 - 1) * n]) / (2 * cell);
  const nx = -gx * 1.5, ny = -gy * 1.5, l = Math.hypot(nx, ny, 1);
  const sh = Math.max(0, (nx * -0.6 + ny * -0.6 + 0.55) / l / 0.55);
  const f = 0.62 + 0.5 * sh, hv = Math.min(1, H[gy0 * n + gx0] / hmax);
  let r = 170 + 60 * hv, g = 185 + 20 * hv - 30 * hv * hv, b = 130 + 70 * hv;
  if (t.water[gy0 * n + gx0] === 1) { r = 120; g = 150; b = 185; }
  const o = (y * px + x) * 4;
  img[o] = Math.min(255, r * f); img[o + 1] = Math.min(255, g * f); img[o + 2] = Math.min(255, b * f); img[o + 3] = 255;
}
const b64 = Buffer.from(encodePng(img, px, px, 4)).toString('base64');
const X = (v: number): string => (v - rx).toFixed(1), Y = (v: number): string => (v - ry).toFixed(1);
const cl = (v: number, a: number): number => Math.max(a - 80, Math.min(a + rw + 80, v));
const d = (pts: { x: number; y: number }[], close = false): string => pts.map((p, i) => (i ? 'L' : 'M') + X(cl(p.x, rx)) + ' ' + Y(cl(p.y, ry))).join('') + (close ? 'Z' : '');
const col = { brook: '#4f8fd6', stream: '#2f6fd0', river: '#1f4fb0', major: '#10307f' } as const;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${rw} ${rw}"><image href="data:image/png;base64,${b64}" x="0" y="0" width="${rw}" height="${rw}" preserveAspectRatio="none"/>`;
const clampPt = (p: { x: number; y: number }) => ({ x: Math.max(rx - 50, Math.min(rx + rw + 50, p.x)), y: Math.max(ry - 50, Math.min(ry + rw + 50, p.y)) });
for (const p of t.coastline) svg += `<path d="${d(p.map(clampPt), true)}" fill="#7aa0c8" opacity="0.8"/>`;
for (const p of t.lakes) svg += `<path d="${d(p, true)}" fill="#6aa0d8" stroke="#2a5a9a" stroke-width="1.5"/>`;
for (const r of t.rivers) {
  const rib = offsetRibbon(r.path, r.width.map((w) => Math.max(1.5, w)));
  svg += `<path d="${d(rib, true)}" fill="${col[r.cls ?? 'brook']}" stroke="#0a2050" stroke-width="0.6"/>`;
  svg += `<circle cx="${X(r.path[0].x)}" cy="${Y(r.path[0].y)}" r="${r.edgeFed ? 4 : 6}" fill="${r.edgeFed ? 'lime' : 'yellow'}" stroke="black" stroke-width="1"/>`;
}
for (const r of rr.roads) {
  const c = r.kind === 'major' ? '#6b3a10' : r.kind === 'minor' ? '#a05a20' : '#c08040';
  svg += `<path d="${d(r.path)}" fill="none" stroke="${c}" stroke-width="${r.width}" stroke-linejoin="round" opacity="0.9"/>`;
}
for (const r of rr.roads) {
  for (const k of [0, r.path.length - 1]) svg += `<circle cx="${X(r.path[k].x)}" cy="${Y(r.path[k].y)}" r="3.5" fill="none" stroke="red" stroke-width="1.2"/>`;
}
for (const b of rr.bridges) svg += `<path d="M${X(b.a.x)} ${Y(b.a.y)}L${X(b.b.x)} ${Y(b.b.y)}" stroke="#ff00ff" stroke-width="${b.width + 2}" stroke-linecap="butt"/>`;
svg += `<circle cx="${X(site.center.x)}" cy="${Y(site.center.y)}" r="9" fill="white" stroke="black"/></svg>`;

const png: Uint8Array = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(out, 'rivers', t.rivers.length, 'roads', rr.roads.length, 'bridges', rr.bridges.length);
