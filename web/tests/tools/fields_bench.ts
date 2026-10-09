/** Land-use timing: new vs the previous generator on the same world. npx tsx tests/tools/fields_bench.ts <seed> <town|10km> */
import { generate } from '../../src/gen/pipeline';
import { makeOptions, effectiveSize } from '../../src/gen/options';
import { Rng } from '../../src/gen/core/rng';
import { generateRural } from '../../src/gen/landuse/rural';
import { generateRural as baseRural } from '../legacy/rural_legacy';

const [seed, kind] = process.argv.slice(2);
const o = kind === '10km'
  ? makeOptions({ seed, mapSize: 10000, population: 2500, settlements: 'auto' })
  : makeOptions({ seed, size: 'town' });
const w = generate(o);
const size = effectiveSize(o);
const mv = size !== o.size ? { ...w, options: { ...o, size } } : w;
const main = w.roads?.length;
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const run = (fn: typeof generateRural) => {
  const ts: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    const r = fn(mv, new Rng('magna-urbis:' + o.seed), main); if (i === 4) console.log(JSON.stringify(Object.fromEntries(Object.entries(r.stats).filter(([k]) => k.startsWith('ms')))));
    ts.push(performance.now() - t);
  }
  return Math.round(med(ts));
};
if (process.env.NEWONLY) { for (let k = 0; k < 6; k++) run(generateRural); } else console.log('pipeline ms.landuse', w.stats['ms.landuse'], 'new', run(generateRural), 'base', run(baseRural));
