/**
 * Contact sheet: renders a grid of maps (same scale) in-process and composes one PNG.
 * npx tsx scripts/contact.ts out.png cols focus cellPx "label|k=v,k=v" ...
 * Each item: a label and comma-separated options (seed, size, culture, relief, coast, river, mix, crop=x,y,w).
 */
import { writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { generate } from '../src/gen/pipeline';
import { makeOptions, applyOverride } from '../src/gen/options';
import { renderSvg } from '../src/render/svg';

const [out, colsS, focusS, cellS, ...items] = process.argv.slice(2);
const cols = Number(colsS), focus = Number(focusS), cell = Number(cellS);
const pad = 8, top = 26;
const imgs: { label: string; png: Buffer }[] = [];
for (const it of items) {
  const [label, spec] = it.split('|');
  const o = makeOptions({ labels: false });
  let crop: { x: number; y: number; w: number } | null = null;
  for (const kv of (spec ?? '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    if (k === 'crop') { const [x, y, w] = v.split(':').map(Number); crop = { x, y, w }; } else applyOverride(o, k, v);
  }
  const t = performance.now();
  const w = generate(o);
  const c = w.site!.center;
  const W = crop?.w ?? Math.min(w.mapSize, focus);
  const x0 = crop?.x ?? Math.max(0, Math.min(w.mapSize - W, c.x - W / 2)), y0 = crop?.y ?? Math.max(0, Math.min(w.mapSize - W, c.y - W / 2));
  const svg = renderSvg(w, { style: o.style }).replace(/viewBox="[^"]*"/, `viewBox="${x0} ${y0} ${W} ${W}"`);
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: cell } }).render().asPng();
  imgs.push({ label: `${label} (${w.stats['urban.pop']} inh.)`, png });
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
