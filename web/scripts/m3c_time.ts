/** Timing of one generation: npx tsx scripts/m3c_time.ts size=town mapSize=10000 settlements=auto ... */
import { generate } from '../src/gen/pipeline';
import { makeOptions, applyOverride } from '../src/gen/options';

const o = makeOptions({});
for (const a of process.argv.slice(2)) { const i = a.indexOf('='); applyOverride(o, a.slice(0, i), a.slice(i + 1)); }
const t = performance.now();
const w = generate(o);
const s = w.stats;
const keep = Object.entries(s).filter(([k]) => (k.startsWith('ms.') && !k.startsWith('ms.lot') && !k.startsWith('ms.q')) || k.startsWith('settl') || k === 'urban.pop');
console.log(Math.round(performance.now() - t), 'ms', JSON.stringify(Object.fromEntries(keep)));
