import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { SPLIT_DBG } from '../src/gen/urban/blocks';

SPLIT_DBG.on = true;
generate(makeOptions({ seed: process.argv[3] ?? '2', size: (process.argv[4] ?? 'town') as SizeName, culture: process.argv[2] ?? 'chinese' }));
console.log(SPLIT_DBG.why);
