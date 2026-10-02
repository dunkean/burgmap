import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';

const w = generate(makeOptions({ seed: process.argv[2], size: process.argv[3] as SizeName, culture: process.argv[4] }));
for (const i of process.argv.slice(5).map(Number)) console.log(i, JSON.stringify(w.urban!.blockInfo[i]));
