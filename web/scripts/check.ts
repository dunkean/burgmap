/** Runs the urban invariant checks on a set of seeds/sizes/cultures and prints a table (dev tool). */
import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName, Culture } from '../src/gen/options';
import { checkWorld } from '../tests/urbanCheck';

const args = process.argv.slice(2);
const seeds = (args[0] ?? '1,2,3').split(',');
const sizes = (args[1] ?? 'hamlet,village,town,city').split(',') as SizeName[];
const cultures = (args[2] ?? 'european-organic,bastide').split(',') as Culture[];
const verbose = args.includes('-v');
for (const culture of cultures) for (const size of sizes) for (const seed of seeds) {
  const t0 = performance.now();
  const w = generate(makeOptions({ seed, size, culture }));
  const t1 = performance.now();
  const r = checkWorld(w);
  const s = w.stats;
  console.log([culture.slice(0, 4), size.padEnd(7), 'seed ' + seed, String(s['urban.archetype']).padEnd(17), `pop ${s['urban.pop']}`,
    `q${r.quarters} b${r.blocks} p${r.plots} B${r.buildings}`, `err ${(r.blockAreaErr * 100).toFixed(2)}%`,
    `out ${r.blockOutside.toFixed(1)}`, `ov ${r.overlapsBlocks}/${r.overlapsPlots}/${r.overlapsBuildings}`, `nf ${r.noFrontage}`,
    `bo ${r.bldgOutside}`, `ac ${r.acute}`, `th ${r.thin}`, `cc ${r.components}/${r.orphanMain}`,
    `urban ${s['ms.urban']}ms total ${Math.round(t1 - t0)}ms`].join(' | '));
  if (verbose) for (const d of r.details.slice(0, 12)) console.log('    ' + d);
}
