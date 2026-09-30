/** Renders the M3b preview set (in-process): npx tsx scripts/m3b_previews.ts [culture ...] */
import { writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { mixFromString } from '../src/gen/urban/culture';
import { renderSvg } from '../src/render/svg';
import { encodePng } from '../src/render/raster';

interface Item { name: string; culture: string; mix?: string; relief?: string; seed: string }
const ITEMS: Item[] = [
  { name: 'european', culture: 'european-organic', seed: '2' },
  { name: 'bastide', culture: 'bastide', seed: '2' },
  { name: 'roman', culture: 'roman-core', seed: '5' },
  { name: 'medina', culture: 'medina', seed: '2' },
  { name: 'chinese', culture: 'chinese', seed: '2' },
  { name: 'japanese', culture: 'japanese-jokamachi', seed: '2' },
  { name: 'indian', culture: 'indian-temple', seed: '5' },
  { name: 'elven', culture: 'elven', seed: '2' },
  { name: 'dwarven', culture: 'dwarven', relief: 'mountains', seed: '3' },
  { name: 'mix_roman_european', culture: 'roman-core', mix: 'european-organic:0.6:phases', seed: '4' },
  { name: 'mix_medina_bastide', culture: 'medina', mix: 'bastide:0.45:phases', seed: '4' },
];
const only = process.argv.slice(2);
const shots: { suffix: string; size: SizeName; focus: number; px: number }[] = [
  { suffix: 'town', size: 'town', focus: 1100, px: 1300 },
  { suffix: 'core', size: 'town', focus: 320, px: 1100 },
  { suffix: 'city', size: 'city', focus: 1900, px: 1400 },
  { suffix: 'village', size: 'village', focus: 600, px: 1000 },
  { suffix: 'hamlet', size: 'hamlet', focus: 420, px: 900 },
];
for (const it of ITEMS) {
  if (only.length && !only.includes(it.name)) continue;
  for (const sh of shots) {
    if (it.name.startsWith('mix') && sh.suffix !== 'city' && sh.suffix !== 'town') continue;
    const o = makeOptions({ seed: it.seed, size: sh.size, culture: it.culture, cultureMix: it.mix ? mixFromString(it.mix) : null, labels: false, ...(it.relief ? { relief: it.relief as never } : {}) });
    const w = generate(o);
    const c = w.site!.center;
    const W = Math.min(w.mapSize, sh.focus);
    const x0 = Math.max(0, Math.min(w.mapSize - W, c.x - W / 2)), y0 = Math.max(0, Math.min(w.mapSize - W, c.y - W / 2));
    // render the whole map at a matching scale and cut the window out (resvg panics on offset viewBoxes when zoomed)
    const svg = renderSvg(w, { style: o.style });
    const full = Math.round((sh.px * w.mapSize) / W);
    const img = new Resvg(svg, { fitTo: { mode: 'width', value: full } }).render();
    const k = img.width / w.mapSize;
    const X0 = Math.round(x0 * k), Y0 = Math.round(y0 * k), cw = Math.min(Math.round(W * k), img.width - X0, img.height - Y0);
    const src = img.pixels, out8 = new Uint8Array(cw * cw * 4);
    for (let y = 0; y < cw; y++) out8.set(src.subarray(((Y0 + y) * img.width + X0) * 4, ((Y0 + y) * img.width + X0 + cw) * 4), y * cw * 4);
    writeFileSync(`out/m3b_${it.name}_${sh.suffix}.png`, encodePng(out8, cw, cw, 4));
    console.log(it.name, sh.suffix, w.stats['urban.pop'], w.stats['ms.urban'] + 'ms');
  }
}
