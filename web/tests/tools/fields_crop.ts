/** npx tsx tests/tools/fields_crop.ts in.svg out.png x y w [px=1300]: crop of a rendered map (renders the whole map at a matching scale, then cuts). */
import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { encodePng } from '../../src/render/raster';

const [inp, out, xs, ys, ws, pxs] = process.argv.slice(2);
const svg = readFileSync(inp, 'utf8');
const S = Number(/viewBox="0 0 ([\d.]+)/.exec(svg)?.[1] ?? 2400);
const x = Number(xs), y = Number(ys), w = Number(ws), px = Number(pxs ?? 1300);
const full = Math.round((px * S) / w);
const img = new Resvg(svg, { fitTo: { mode: 'width', value: full }, font: { loadSystemFonts: true } }).render();
const k = img.width / S;
const x0 = Math.round(x * k), y0 = Math.round(y * k), cw = Math.min(Math.round(w * k), img.width - x0, img.height - y0);
const out8 = new Uint8Array(cw * cw * 4); const px8 = img.pixels;
for (let r = 0; r < cw; r++) out8.set(px8.subarray(((y0 + r) * img.width + x0) * 4, ((y0 + r) * img.width + x0 + cw) * 4), r * cw * 4);
writeFileSync(out, encodePng(out8, cw, cw, 4));
console.log('ok', cw);
