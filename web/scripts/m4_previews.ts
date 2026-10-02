/**
 * M4 preview set (in-process): full views and crops on the landmarks, saved as out/m4_*.png, and the contact sheet
 * out/m4_contact.png.   npx tsx scripts/m4_previews.ts [name ...]
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { generate } from '../src/gen/pipeline';
import { makeOptions, Options } from '../src/gen/options';
import type { World } from '../src/gen/types';
import { renderSvg } from '../src/render/svg';
import { encodePng } from '../src/render/raster';

interface Shot { name: string; label: string; o: Partial<Options>; crop?: { site: string; w: number }; px: number }
const SHOTS: Shot[] = [
  { name: 'coastal_city', label: 'Coastal city: harbour, quays, moles, shipyard', o: { seed: '5', size: 'city', coast: 'E', siteType: 'harbor' }, px: 1400 },
  { name: 'river_city', label: 'River city: castle, cathedral close, river port', o: { seed: '2', size: 'city' }, px: 1400 },
  { name: 'castle_spur', label: 'Castle on a meander spur', o: { seed: '3', size: 'town' }, crop: { site: 'castle', w: 520 }, px: 1100 },
  { name: 'suburbs_shanty', label: 'Suburbs (outer wall, absorbed village) and shanty towns', o: { seed: '1', size: 'city', suburbs: 'many', shantytowns: 'many' }, px: 1400 },
  { name: 'medina', label: 'Medina: kasbah, madrasas, mellah', o: { seed: '2', size: 'city', culture: 'medina' }, px: 1400 },
  { name: 'chinese', label: 'Chinese walled city (yamen, temples) with port and suburbs', o: { seed: '2', size: 'city', culture: 'chinese' }, px: 1400 },
  { name: 'japanese', label: 'Japanese castle town with river port', o: { seed: '2', size: 'city', culture: 'japanese-jokamachi' }, px: 1400 },
  // detail crops
  { name: 'crop_castle', label: 'Castle: enceinte, baileys, keep, ditch, esplanade', o: { seed: '2', size: 'city' }, crop: { site: 'castle', w: 380 }, px: 1100 },
  { name: 'crop_cathedral', label: 'Cathedral close: parvis, cloister, canons', o: { seed: '2', size: 'city' }, crop: { site: 'cathedral-close', w: 360 }, px: 1100 },
  { name: 'crop_harbour', label: 'Harbour: straight quays, quay street, piers, fish market', o: { seed: '5', size: 'city', coast: 'E', siteType: 'harbor' }, crop: { site: 'harbour', w: 520 }, px: 1100 },
  { name: 'crop_monastery', label: 'Monastery precinct', o: { seed: '2', size: 'city' }, crop: { site: 'monastery', w: 300 }, px: 1000 },
  { name: 'crop_shanty', label: 'Shanty town: huts and footpaths', o: { seed: '1', size: 'city', suburbs: 'many', shantytowns: 'many' }, crop: { site: 'shanty', w: 260 }, px: 1000 },
  { name: 'crop_arena', label: 'Arena fossilized as an oval of houses', o: { seed: '4', size: 'town', culture: 'roman-core', arena: 'yes' }, crop: { site: 'arena', w: 300 }, px: 1000 },
  { name: 'double_walls', label: 'Double enceinte, two castles', o: { seed: '1', size: 'town', walls: 'double', castles: '2' }, px: 1300 },
  { name: 'crop_parish', label: 'Parish church embedded in the fabric', o: { seed: '2', size: 'city' }, crop: { site: 'parish-church', w: 220 }, px: 900 },
  { name: 'crop_bridge', label: 'Inhabited bridge', o: { seed: '2', size: 'city' }, crop: { site: 'inhabited-bridge', w: 260 }, px: 900 },
  { name: 'crop_mill', label: 'Watermill: weir, race, mill', o: { seed: '2', size: 'city' }, crop: { site: 'watermill', w: 240 }, px: 900 },
];

function frame(w: World, shot: Shot): { x: number; y: number; w: number } {
  const u = w.urban!;
  if (shot.crop) {
    const s = (u.sites ?? []).find((x) => x.kind === shot.crop!.site);
    if (s) { const W = shot.crop.w; return { x: s.anchor.x - W / 2, y: s.anchor.y - W / 2, w: W }; }
  }
  // the walled town and its suburbs (not the windmills and gallows far out in the fields)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ph of u.phases) for (const r of ph.region) for (const q of r.outer) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  const W = Math.min(w.mapSize, Math.max(x1 - x0, y1 - y0) * 1.25);
  return { x: (x0 + x1) / 2 - W / 2, y: (y0 + y1) / 2 - W / 2, w: W };
}

function render(w: World, c: { x: number; y: number; w: number }, px: number): Uint8Array {
  const S = w.mapSize;
  const cw0 = Math.min(S, c.w);
  const x = Math.max(0, Math.min(S - cw0, c.x)), y = Math.max(0, Math.min(S - cw0, c.y));
  const svg = renderSvg(w, { style: w.options.style });
  const full = Math.round((px * S) / cw0);
  const img = new Resvg(svg, { fitTo: { mode: 'width', value: full }, font: { loadSystemFonts: true } }).render();
  const k = img.width / S;
  const X0 = Math.round(x * k), Y0 = Math.round(y * k), cw = Math.min(Math.round(cw0 * k), img.width - X0, img.height - Y0);
  const o8 = new Uint8Array(cw * cw * 4);
  for (let r = 0; r < cw; r++) o8.set(img.pixels.subarray(((Y0 + r) * img.width + X0) * 4, ((Y0 + r) * img.width + X0 + cw) * 4), r * cw * 4);
  return encodePng(o8, cw, cw, 4);
}

const only = process.argv.slice(2);
mkdirSync('out', { recursive: true });
const cache = new Map<string, World>();
for (const sh of SHOTS) {
  if (only.length && !only.includes(sh.name) && !only.includes('contact')) continue;
  if (only.includes('contact') && existsSync(`out/m4_${sh.name}.png`) && !only.includes(sh.name)) continue;
  const key = JSON.stringify(sh.o);
  let w = cache.get(key);
  if (!w) { w = generate(makeOptions({ labels: false, ...sh.o })); cache.set(key, w); }
  const png = render(w, frame(w, sh), sh.px);
  writeFileSync(`out/m4_${sh.name}.png`, png);
  console.log('wrote', `out/m4_${sh.name}.png`, 'urban ms', w.stats['ms.urban'], (w.urban!.sites ?? []).map((s) => s.kind).join(','));
}
// contact sheet: the seven full views + two crops, 3 × 3, with captions
const sheet = ['coastal_city', 'river_city', 'castle_spur', 'suburbs_shanty', 'medina', 'chinese', 'japanese', 'crop_harbour', 'crop_cathedral'];
const T = 620, pad = 14, cap = 30;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${3 * T + 4 * pad}" height="${3 * (T + cap) + 4 * pad}"><rect width="100%" height="100%" fill="#f3ead6"/>`;
sheet.forEach((n, i) => {
  const f = `out/m4_${n}.png`;
  if (!existsSync(f)) return;
  const sh = SHOTS.find((s) => s.name === n)!;
  const x = pad + (i % 3) * (T + pad), y = pad + Math.floor(i / 3) * (T + cap + pad);
  svg += `<image href="data:image/png;base64,${readFileSync(f).toString('base64')}" x="${x}" y="${y + cap}" width="${T}" height="${T}"/>`;
  svg += `<text x="${x + 4}" y="${y + 21}" font-family="Georgia, serif" font-size="17" fill="#3a2a1a">${sh.label}</text>`;
});
svg += '</svg>';
writeFileSync('out/m4_contact.png', new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng());
console.log('wrote out/m4_contact.png');
