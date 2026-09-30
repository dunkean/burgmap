/** Invariant survey: npx tsx scripts/inv.ts culture[+mix:t:mode] [sizes] [seeds] */
import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { mixFromString } from '../src/gen/urban/culture';
import { checkWorld } from '../tests/urbanCheck';

const [cu, mix] = (process.argv[2] ?? 'medina').split('+');
const sizes = (process.argv[3] ?? 'hamlet,village,town,city').split(',') as SizeName[];
const seeds = (process.argv[4] ?? '1,2,3,4').split(',');
for (const size of sizes) for (const seed of seeds) {
  const t = performance.now();
  const w = generate(makeOptions({ seed, size, culture: cu, cultureMix: mix ? mixFromString(mix) : null }));
  const r = checkWorld(w);
  const bad = [
    r.blockAreaErr > 0.005 ? `area ${(r.blockAreaErr * 100).toFixed(2)}%` : '', r.blockOutside >= 1 ? `outside ${r.blockOutside.toFixed(1)}` : '',
    r.overlapsBlocks ? `ovB ${r.overlapsBlocks}` : '', r.overlapsPlots ? `ovP ${r.overlapsPlots}` : '',
    r.overlapsBuildings > Math.ceil(r.buildings * 0.0005) ? `ovBd ${r.overlapsBuildings}` : '', r.noFrontage ? `nofront ${r.noFrontage}` : '',
    r.bldgOutside ? `bOut ${r.bldgOutside}` : '', r.acute + r.thin > Math.max(2, Math.ceil(0.01 * (r.plots + r.buildings))) ? `acute/thin ${r.acute}/${r.thin}` : '',
    r.orphanMain ? 'orphan' : '', r.blocks === 0 ? 'NO BLOCKS' : '',
  ].filter(Boolean);
  console.log(`${cu}${mix ? '+' + mix : ''} ${size} ${seed}: ${bad.length ? 'FAIL ' + bad.join(', ') : 'ok'} | blocks ${r.blocks} plots ${r.plots} bldgs ${r.buildings} | ${w.stats['ms.urban']}ms total ${Math.round(performance.now() - t)}ms`);
  if (bad.length && process.env.DETAIL) console.log('   ' + r.details.slice(0, 6).join('\n   '));
}
