import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { generate } from '../src/gen/pipeline';
import { makeOptions, applyOverride, StyleName, SizeName } from '../src/gen/options';
import { renderSvg } from '../src/render/svg';
import { encodePng } from '../src/render/raster';

const args = process.argv.slice(2);
const opts = makeOptions({});
let out = 'out/preview.png';
let width = 1600;
let crop: { x: number; y: number; w: number } | undefined;
let debug = false;
let focus = 0;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const v = args[i + 1];
  if (a === '--seed') { opts.seed = v; i++; }
  else if (a === '--size') { opts.size = v as SizeName; i++; }
  else if (a === '--style') { opts.style = v as StyleName; i++; }
  else if (a === '--out') { out = v; i++; }
  else if (a === '--width') { width = Number(v); i++; }
  else if (a === '--crop') { const [x, y, w] = v.split(',').map(Number); crop = { x, y, w }; i++; }
  else if (a === '--debug') { debug = true; }
  else if (a === '--focus') { focus = Number(v); i++; }
  else if (a === '--opt') { const eq = v.indexOf('='); applyOverride(opts, v.slice(0, eq), v.slice(eq + 1)); i++; }
}

const t0 = performance.now();
const world = generate(opts);
if (focus > 0 && world.site) {
  const c = world.site.center;
  const w = Math.min(world.mapSize, focus);
  crop = { x: Math.max(0, Math.min(world.mapSize - w, c.x - w / 2)), y: Math.max(0, Math.min(world.mapSize - w, c.y - w / 2)), w };
}
const t1 = performance.now();
const svg = renderSvg(world, { style: opts.style, debug });
const t2 = performance.now();
let png: Uint8Array;
if (crop) {
  // render the whole map at a matching scale and cut the window out (resvg panics on offset viewBoxes when zoomed)
  const full = Math.round((width * world.mapSize) / crop.w);
  const img = new Resvg(svg, { fitTo: { mode: 'width', value: full }, font: { loadSystemFonts: true } }).render();
  const k = img.width / world.mapSize;
  const x0 = Math.round(crop.x * k), y0 = Math.round(crop.y * k), cw = Math.round(crop.w * k);
  const src = img.pixels, out8 = new Uint8Array(cw * cw * 4);
  for (let y = 0; y < cw; y++) out8.set(src.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + cw) * 4), y * cw * 4);
  png = encodePng(out8, cw, cw, 4);
} else png = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: true } }).render().asPng();
const t3 = performance.now();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
writeFileSync(out.replace(/\.png$/, '.svg'), svg);
console.log(JSON.stringify({ out, options: opts, stats: world.stats, ms: { generate: Math.round(t1 - t0), svg: Math.round(t2 - t1), rasterize: Math.round(t3 - t2) }, svgKB: Math.round(svg.length / 1024) }, null, 1));
