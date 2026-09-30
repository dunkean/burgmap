/**
 * Contact sheet of full maps with the chosen site archetype written on each.
 *   npx tsx scripts/site_contact.ts [--set a|b] [--out out/site_contact.png] [--cols 4] [--tile 600]
 * Markers: white disc = town center, red ring = archetype feature, blue ring = crossing, green ring = harbor.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { generate } from '../src/gen/pipeline';
import { makeOptions, Options } from '../src/gen/options';
import { renderSvg } from '../src/render/svg';

const args = process.argv.slice(2);
const get = (k: string, d: string): string => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const out = get('out', 'out/site_contact.png');
const cols = Number(get('cols', '4'));
const tile = Number(get('tile', '600'));
const set = get('set', 'a');
const A: Partial<Options>[] = [
  { seed: '1', relief: 'hills' }, { seed: '2', relief: 'valley', coast: 'random' }, { seed: '3', relief: 'flat' }, { seed: '4', relief: 'hills', coast: 'random' },
  { seed: '5', relief: 'mountains' }, { seed: '6', relief: 'valley' }, { seed: '7', relief: 'hills' }, { seed: '8', relief: 'flat', coast: 'random' },
  { seed: '9', relief: 'hills', coast: 'random' }, { seed: '10', relief: 'valley', coast: 'random' }, { seed: '11', relief: 'flat' }, { seed: '12', relief: 'mountains', coast: 'random' },
];
const B: Partial<Options>[] = A.map((c, i) => ({ ...c, seed: String(13 + i) }));
const cfgs = set === 'b' ? B : A;
const rows = Math.ceil(cfgs.length / cols);
const LAB = 54;
let body = '';
cfgs.forEach((c, k) => {
  const o = makeOptions({ size: 'town', ...c });
  const w = generate(o);
  const s = w.site!;
  const ring = (p: { x: number; y: number } | undefined, col: string, r: number): string => p ? `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="none" stroke="${col}" stroke-width="9"/>` : '';
  const overlay = `<g>${ring(s.feature, '#e02020', 46)}${ring(s.crossing, '#2060e0', 34)}${ring(s.harbor, '#10a040', 34)}<circle cx="${s.center.x}" cy="${s.center.y}" r="24" fill="white" stroke="black" stroke-width="8"/></g>`;
  let svg = renderSvg(w, { labels: false, legend: false, cartouche: false });
  svg = svg.replace(/<\/svg>\s*$/, overlay + '</svg>');
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: tile } }).render().asPng();
  const b64 = Buffer.from(png).toString('base64');
  const x = (k % cols) * tile, y = Math.floor(k / cols) * (tile + LAB);
  const off = Object.entries(s.offers).map(([a, q]) => `${a} ${Math.round((q as number) * 100)}`).join(', ');
  body += `<image href="data:image/png;base64,${b64}" x="${x}" y="${y}" width="${tile}" height="${tile}"/>` +
    `<text x="${x + 8}" y="${y + tile + 22}" font-family="sans-serif" font-size="20" font-weight="bold" fill="#111">seed ${o.seed} ${o.relief}${o.coast !== 'none' ? ' coast' : ''}: ${s.archetype.toUpperCase()}</text>` +
    `<text x="${x + 8}" y="${y + tile + 44}" font-family="sans-serif" font-size="13" fill="#333">offers: ${off}</text>`;
  console.log(o.seed, o.relief, o.coast, s.archetype, off);
});
const W = cols * tile, Hh = rows * (tile + LAB);
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Hh}" viewBox="0 0 ${W} ${Hh}"><rect width="${W}" height="${Hh}" fill="#f4f0e6"/>${body}</svg>`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, new Resvg(sheet, { font: { loadSystemFonts: true } }).render().asPng());
console.log('wrote', out, W, 'x', Hh);
