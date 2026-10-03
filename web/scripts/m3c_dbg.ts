/** Debug one secondary settlement: npx tsx scripts/m3c_dbg.ts <index> k=v ... */
import { generate } from '../src/gen/pipeline';
import { makeOptions, applyOverride } from '../src/gen/options';
import { generateUrban } from '../src/gen/urban';
import { Rng } from '../src/gen/core/rng';
import { roadsFor, settlementSite } from '../src/gen/settlements/urban';
import { sizeForPop } from '../src/gen/options';
import { dist } from '../src/gen/core/geom';

const args = process.argv.slice(2);
const idx = args.filter((a) => !a.includes('=')).map(Number);
const o = makeOptions({ seed: '5', mapSize: 10000, population: 2500 });
for (const a of args.filter((x) => x.includes('='))) { const i = a.indexOf('='); applyOverride(o, a.slice(0, i), a.slice(i + 1)); }
const w = generate(o, undefined, { lazy: true });
for (const k of idx) {
  const s = w.settlements![k];
  const roads = roadsFor(w, s);
  console.log(k, s.key, s.population, s.center, 'roads:', roads.map((r) => `${r.kind} n=${r.path.length} end=${Math.round(dist(r.path[r.path.length - 1], s.center))} start=${Math.round(dist(r.path[0], s.center))}`));
  const sub = { ...w, options: { ...w.options, culture: s.culture, population: s.population, size: sizeForPop(s.population) }, site: settlementSite(w, s), roads, bridges: [] };
  const res = generateUrban(sub, new Rng('burgmap:' + w.seed).fork('settlement:' + s.key));
  console.log('  raw:', res.layer.buildings.length, 'bldg', res.layer.blocks.length, 'blocks', res.layer.footprint.length, 'fp', JSON.stringify(res.stats).slice(0, 400));
  const c = s.center;
  let inR = 0;
  for (const b of res.layer.buildings) { const p = b.poly[0]; if (dist(p, c) < 400) inR++; }
  console.log('  within 400 m:', inR, 'region pts', s.region.length);
}
