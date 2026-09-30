/** Urban-stage timing bench: npx tsx scripts/bench_urban.ts [culture[+mix] ...] */
import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';

const cultures = process.argv.slice(2).length ? process.argv.slice(2) : ['european-organic'];
const sizes: SizeName[] = ['hamlet', 'village', 'town', 'city'];
for (const c of cultures) {
  const row: string[] = [];
  for (const size of sizes) {
    let tot = 0;
    for (const seed of ['1', '2', '3', '4']) {
      const [cu, mix] = c.split('+');
      const o = makeOptions({ seed, size, culture: cu as never });
      if (mix) (o as unknown as Record<string, unknown>).cultureMix = mix + ':0.5';
      const w = generate(o);
      tot += Number(w.stats['ms.urban']);
    }
    row.push(`${size}=${Math.round(tot / 4)}ms`);
  }
  console.log(c.padEnd(34), row.join('  '));
}
