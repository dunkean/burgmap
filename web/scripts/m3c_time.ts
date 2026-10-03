/** Timing of one generation: npx tsx scripts/m3c_time.ts mapSize=10000 population=2500 settlements=auto ... [--lazy] */
import { generate } from '../src/gen/pipeline';
import { makeOptions, applyOverride } from '../src/gen/options';

const o = makeOptions({});
const args = process.argv.slice(2);
for (const a of args.filter((x) => x.includes('='))) { const i = a.indexOf('='); applyOverride(o, a.slice(0, i), a.slice(i + 1)); }
const t = performance.now();
const w = generate(o, undefined, args.includes('--lazy') ? { lazy: true } : {});
const s = w.stats;
const keep = Object.entries(s).filter(([k]) => (k.startsWith('ms.') && !k.startsWith('ms.lot') && !k.startsWith('ms.q')) || k.startsWith('settl') || k.startsWith('network') || k.startsWith('planner') || k === 'urban.pop' || k === 'landuse.strips');
console.log(Math.round(performance.now() - t), 'ms', JSON.stringify(Object.fromEntries(keep)));
