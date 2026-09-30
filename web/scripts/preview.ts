import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { generate } from '../src/gen/pipeline';
import { makeOptions, applyOverride, StyleName, SizeName } from '../src/gen/options';
import { renderSvg } from '../src/render/svg';

const args = process.argv.slice(2);
const opts = makeOptions({});
let out = 'out/preview.png';
let width = 1600;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const v = args[i + 1];
  if (a === '--seed') { opts.seed = v; i++; }
  else if (a === '--size') { opts.size = v as SizeName; i++; }
  else if (a === '--style') { opts.style = v as StyleName; i++; }
  else if (a === '--out') { out = v; i++; }
  else if (a === '--width') { width = Number(v); i++; }
  else if (a === '--opt') { const [k, val] = v.split('='); applyOverride(opts, k, val); i++; }
}

const t0 = performance.now();
const world = generate(opts);
const t1 = performance.now();
const svg = renderSvg(world, { style: opts.style });
const t2 = performance.now();
const png = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: true } }).render().asPng();
const t3 = performance.now();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
writeFileSync(out.replace(/\.png$/, '.svg'), svg);
console.log(JSON.stringify({ out, options: opts, stats: world.stats, ms: { generate: Math.round(t1 - t0), svg: Math.round(t2 - t1), rasterize: Math.round(t3 - t2) }, svgKB: Math.round(svg.length / 1024) }, null, 1));
