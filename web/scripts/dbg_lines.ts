import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';

const w = generate(makeOptions({ seed: process.argv[3] ?? '3', size: (process.argv[4] ?? 'town') as SizeName, culture: process.argv[2] ?? 'dwarven', relief: (process.argv[5] ?? 'mountains') as never }));
const m: Record<string, number> = {};
for (const l of w.urban!.lines ?? []) m[l.kind] = (m[l.kind] ?? 0) + 1;
console.log(m, 'trees', w.urban!.trees?.length, 'water', w.urban!.water?.length, 'terrain angle', w.stats['urban.terrainAngle']);
