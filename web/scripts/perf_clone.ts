// Node: size/clone cost of the World parts (what crosses a worker boundary). Usage: tsx scripts/perf_clone.ts [size] [seed]
import * as v8 from 'node:v8';
import { generate } from '../src/gen/pipeline';
import { fromQuery } from '../src/gen/options';
import { buildScene } from '../src/render/scene';

const size = process.argv[2] ?? 'city', seed = process.argv[3] ?? '1';
const world = generate(fromQuery(`?seed=${seed}&size=${size}`));
const time = <T>(f: () => T): [T, number] => { const t = performance.now(); const r = f(); return [r, performance.now() - t]; };
for (const [k, v] of Object.entries(world) as [string, unknown][]) {
  const [b, ms] = time(() => v8.serialize(v));
  const [, ms2] = time(() => v8.deserialize(b));
  console.log(k.padEnd(10), (b.length / 1e6).toFixed(2).padStart(7), 'MB  ser', ms.toFixed(0), 'ms  de', ms2.toFixed(0), 'ms');
}
const [bAll, ms] = time(() => v8.serialize(world));
console.log('TOTAL', (bAll.length / 1e6).toFixed(2), 'MB ser', ms.toFixed(0), 'ms');
const [, msS] = time(() => buildScene(world));
console.log('buildScene', msS.toFixed(0), 'ms');
for (const k of Object.keys(world.urban ?? {})) {
  const [b, m] = time(() => v8.serialize((world.urban as never)[k]));
  console.log('  urban.' + k.padEnd(12), (b.length / 1e6).toFixed(2), 'MB', m.toFixed(0), 'ms');
}
