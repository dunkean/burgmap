/**
 * Contact sheet (crop-safe): renders each map whole at a matching scale and cuts the window out (resvg panics on
 * offset viewBoxes when zoomed), then composes the cells with their labels.
 * npx tsx scripts/cultures2_contact.ts out.png cols cellPx "label|k=v,k=v,focus=600" ...
 * Each item: options (seed, size, culture, relief, coast, river, mix, sprawl...) plus focus=<window m> (default 700)
 * and dx=/dy= (window offset from the town centre, m).
 */
import { writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { generate } from '../src/gen/pipeline';
import { makeOptions, applyOverride } from '../src/gen/options';
import { renderSvg } from '../src/render/svg';
import { encodePng } from '../src/render/raster';

const [out, colsS, cellS, ...items] = process.argv.slice(2);
const cols = Number(colsS), cell = Number(cellS);
const pad = 8, top = 26;
const imgs: { label: string; png: Buffer }[] = [];
for (const it of items) {
  const [label, spec] = it.split('|');
  const o = makeOptions({ labels: false });
  let focus = 700, dx = 0, dy = 0;
  for (const kv of (spec ?? '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    if (k === 'focus') focus = Number(v);
    else if (k === 'dx') dx = Number(v);
    else if (k === 'dy') dy = Number(v);
    else applyOverride(o, k, v);
  }
  const t = performance.now();
  const w = generate(o);
  const c = w.site!.center;
  const W = Math.min(w.mapSize, focus);
  const x0 = Math.max(0, Math.min(w.mapSize - W, c.x + dx - W / 2)), y0 = Math.max(0, Math.min(w.mapSize - W, c.y + dy - W / 2));
  const svg = renderSvg(w, { style: o.style });
  const full = Math.round((cell * w.mapSize) / W);
  const img = new Resvg(svg, { fitTo: { mode: 'width', value: full } }).render();
  const k = img.width / w.mapSize;
  const X0 = Math.round(x0 * k), Y0 = Math.round(y0 * k), cw = Math.min(Math.round(W * k), img.width - X0, img.height - Y0);
  const src = img.pixels, out8 = new Uint8Array(cw * cw * 4);
  for (let y = 0; y < cw; y++) out8.set(src.subarray(((Y0 + y) * img.width + X0) * 4, ((Y0 + y) * img.width + X0 + cw) * 4), y * cw * 4);
  imgs.push({ label: `${label} (${w.stats['urban.pop']} inh.)`, png: Buffer.from(encodePng(out8, cw, cw, 4)) });
  console.log(label, Math.round(performance.now() - t), 'ms', w.stats['ms.urban'], 'ms urban');
}
const rows = Math.ceil(imgs.length / cols);
const Wt = cols * (cell + pad) + pad, Ht = rows * (cell + top + pad) + pad;
let body = `<rect width="${Wt}" height="${Ht}" fill="#fff"/>`;
imgs.forEach((im, k) => {
  const x = pad + (k % cols) * (cell + pad), y = pad + Math.floor(k / cols) * (cell + top + pad);
  body += `<text x="${x + 2}" y="${y + 18}" font-family="sans-serif" font-size="16" fill="#222">${im.label}</text>`;
  body += `<image x="${x}" y="${y + top}" width="${cell}" height="${cell}" href="data:image/png;base64,${im.png.toString('base64')}"/>`;
});
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Wt}" height="${Ht}" viewBox="0 0 ${Wt} ${Ht}">${body}</svg>`;
writeFileSync(out, new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng());
