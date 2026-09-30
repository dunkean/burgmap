/** Rasterize (a crop of) any SVG: npx tsx scripts/svgcrop.ts in.svg out.png [x y w] [widthPx] */
import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const [inp, out, xs, ys, ws, px] = process.argv.slice(2);
let svg = readFileSync(inp, 'utf8');
if (xs) {
  const x = Number(xs), y = Number(ys), w = Number(ws);
  svg = svg.replace(/viewBox="[^"]*"/, `viewBox="${x} ${y} ${w} ${w}"`).replace(/width="[^"]*"/, `width="${w}"`).replace(/height="[^"]*"/, `height="${w}"`);
}
const img = new Resvg(svg, { fitTo: { mode: 'width', value: Number(px ?? 1200) } }).render();
writeFileSync(out, img.asPng());
