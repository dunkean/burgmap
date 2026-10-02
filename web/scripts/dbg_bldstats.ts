import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { BLD_STATS } from '../src/gen/urban/buildings';

BLD_STATS.on = true;
generate(makeOptions({ seed: process.argv[2] ?? '4', size: 'city' }));
const f = (x: number) => ((100 * x) / BLD_STATS.plot).toFixed(1) + '%';
console.log('core plots: raw', f(BLD_STATS.raw), 'after normalize', f(BLD_STATS.norm), 'after overlaps', f(BLD_STATS.fin));
