/**
 * M3c previews: full maps of settlement systems + crops on a few secondary settlements.
 *   npx tsx scripts/m3c_previews.ts [case ...]     cases: auto10, city20, list5, hamlet1
 * Writes out/m3c_<case>.png (whole map) and out/m3c_<case>_s<k>.png (crops), prints timings and stats.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { generate } from '../src/gen/pipeline';
import { makeOptions, Options, applyOverride } from '../src/gen/options';
import { renderSvg } from '../src/render/svg';
import { encodePng } from '../src/render/raster';

const CASES: Record<string, Partial<Options> & { extra?: string[] }> = {
  auto10: { seed: '5', mapSize: 10000, population: 2500, settlements: 'auto' },
  city20: { seed: '3', mapSize: 20000, population: 22000, settlements: 'auto' },
  list5: {
    seed: '8', mapSize: 8000, population: 1800, relief: 'mountains', settlements: {
      list: [
        { population: 450, culture: 'dwarven' }, { population: 300 }, { population: 120, culture: 'elven' },
        { population: 2000, culture: 'medina' }, { population: 60 },
      ],
    },
  },
  hamlet1: { seed: '2', mapSize: 1000, population: 60, settlements: 'auto' },
};

const args = process.argv.slice(2);
const names = args.filter((a) => !a.includes('='));
const overrides = args.filter((a) => a.includes('='));
mkdirSync('out', { recursive: true });
for (const name of names.length ? names : Object.keys(CASES)) {
  const o = makeOptions(CASES[name]);
  for (const a of overrides) { const i = a.indexOf('='); applyOverride(o, a.slice(0, i), a.slice(i + 1)); }
  const t0 = performance.now();
  const w = generate(o);
  const t1 = performance.now();
  const svg = renderSvg(w, { style: o.style });
  const t2 = performance.now();
  const width = 1800;
  writeFileSync(`out/m3c_${name}.png`, new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: true } }).render().asPng());
  // crops: the main town and up to 3 secondary settlements (largest first)
  const secs = (w.settlements ?? []).filter((s) => !s.main && s.detail !== 'farmstead').sort((a, b) => b.population - a.population).slice(0, 3);
  const S = w.mapSize;
  const crops = [{ k: 'main', c: w.site!.center, r: 900 }, ...secs.map((s) => ({ k: 's' + s.index, c: s.center, r: Math.max(450, s.radius * 3.2) }))];
  const big = Math.min(16000, Math.round((1100 * S) / (2 * Math.min(...crops.map((c) => c.r)))));
  const img = new Resvg(svg, { fitTo: { mode: 'width', value: big }, font: { loadSystemFonts: true } }).render();
  const k = img.width / S;
  for (const cr of crops) {
    const wv = Math.min(S, 2 * cr.r);
    const x = Math.max(0, Math.min(S - wv, cr.c.x - wv / 2)), y = Math.max(0, Math.min(S - wv, cr.c.y - wv / 2));
    const x0 = Math.round(x * k), y0 = Math.round(y * k), cw = Math.min(img.width - x0, img.height - y0, Math.round(wv * k));
    const src = img.pixels, out8 = new Uint8Array(cw * cw * 4);
    for (let yy = 0; yy < cw; yy++) out8.set(src.subarray(((y0 + yy) * img.width + x0) * 4, ((y0 + yy) * img.width + x0 + cw) * 4), yy * cw * 4);
    writeFileSync(`out/m3c_${name}_${cr.k}.png`, encodePng(out8, cw, cw, 4));
  }
  const t3 = performance.now();
  const st = w.stats;
  const pick = Object.fromEntries(Object.entries(st).filter(([kk]) => kk.startsWith('settl') || kk.startsWith('network') || ['ms.total', 'ms.terrain', 'ms.urbanTotal', 'ms.planner', 'ms.network', 'ms.settlements', 'ms.landuse', 'urban.pop', 'roads', 'landuse.strips'].includes(kk)));
  console.log(name, JSON.stringify({ gen: Math.round(t1 - t0), svg: Math.round(t2 - t1), png: Math.round(t3 - t2), svgKB: Math.round(svg.length / 1024), ...pick }));
  for (const s of w.settlements ?? []) console.log('  ', s.index, s.key, s.cls, s.population, s.culture, s.archetype, s.detail, s.name, Math.round(s.center.x), Math.round(s.center.y), s.urban ? `${s.urban.buildings.length} bldg` : '');
}
