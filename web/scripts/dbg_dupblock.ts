import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { mixFromString } from '../src/gen/urban/culture';
import { intersectionS, mpArea } from '../src/gen/geo/bool';
import { area } from '../src/gen/geo/poly';

const [cu, mix] = (process.argv[2] ?? 'roman-core+european-organic:0.6:phases').split('+');
const w = generate(makeOptions({ seed: process.argv[3] ?? '4', size: (process.argv[4] ?? 'town') as SizeName, culture: cu, cultureMix: mix ? mixFromString(mix) : null }));
const u = w.urban!;
for (let i = 0; i < u.blocks.length; i++) for (let j = i + 1; j < u.blocks.length; j++) {
  const a = mpArea(intersectionS(u.blocks[i], u.blocks[j]));
  if (a > 1) console.log('blocks', i, j, a.toFixed(0), 'areas', area(u.blocks[i]).toFixed(0), area(u.blocks[j]).toFixed(0), JSON.stringify(u.blockInfo[i]), JSON.stringify(u.blockInfo[j]));
}
