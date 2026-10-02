/**
 * M4 previews: full map and crops centred on landmark sites.
 *   npx tsx scripts/m4_shot.ts --seed 2 --size city [--opt k=v ...] [--site castle] [--w 420] [--px 1100] --out out/x.png
 * Without --site it writes the town view (focus 1.4 × footprint); with --site it crops around the first site of
 * that kind (or the n-th: --site monastery:1).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { generate } from '../src/gen/pipeline';
import { makeOptions, applyOverride, SizeName } from '../src/gen/options';
import { renderSvg } from '../src/render/svg';
import { encodePng } from '../src/render/raster';

const args = process.argv.slice(2);
const opts = makeOptions({ labels: false });
let out = 'out/m4.png', site = '', W = 0, px = 1200;
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--seed') { opts.seed = v; i++; } else if (a === '--size') { opts.size = v as SizeName; i++; } else if (a === '--out') { out = v; i++; } else if (a === '--site') { site = v; i++; } else if (a === '--w') { W = Number(v); i++; } else if (a === '--px') { px = Number(v); i++; } else if (a === '--opt') { const [k, val] = v.split('='); applyOverride(opts, k, val); i++; }
}
const t0 = performance.now();
const world = generate(opts);
const ms = Math.round(performance.now() - t0);
const u = world.urban!;
let c = world.site!.center;
let w = W || 1400;
if (site) {
  const [kind, idx] = site.split(':');
  const list = (u.sites ?? []).filter((s) => s.kind === kind || s.kind.startsWith(kind));
  const s = list[Number(idx ?? 0)];
  if (s) { c = s.anchor; w = W || 420; } else console.log('no site', site, (u.sites ?? []).map((x) => x.kind).join(','));
} else if (!W) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ph of u.phases) for (const r of ph.region) for (const q of r.outer) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  if (Number.isFinite(x0)) { c = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }; w = Math.max(x1 - x0, y1 - y0) * 1.25; }
}
w = Math.min(world.mapSize, w);
const crop = { x: Math.max(0, Math.min(world.mapSize - w, c.x - w / 2)), y: Math.max(0, Math.min(world.mapSize - w, c.y - w / 2)), w };
const svg = renderSvg(world, { style: opts.style });
const full = Math.round((px * world.mapSize) / crop.w);
const img = new Resvg(svg, { fitTo: { mode: 'width', value: full }, font: { loadSystemFonts: true } }).render();
const k = img.width / world.mapSize;
const X0 = Math.round(crop.x * k), Y0 = Math.round(crop.y * k), cw = Math.min(Math.round(crop.w * k), img.width - X0, img.height - Y0);
const src = img.pixels, o8 = new Uint8Array(cw * cw * 4);
for (let y = 0; y < cw; y++) o8.set(src.subarray(((Y0 + y) * img.width + X0) * 4, ((Y0 + y) * img.width + X0 + cw) * 4), y * cw * 4);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, encodePng(o8, cw, cw, 4));
const st = world.stats;
console.log(JSON.stringify({ out, ms, urban: st['ms.urban'], pop: st['urban.pop'], sites: (u.sites ?? []).map((s) => s.kind), walls: (u.walls ?? []).map((x) => x.role), crop }));
