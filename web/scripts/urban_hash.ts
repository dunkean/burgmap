/** Prints a hash of the urban layer per seed × size (regression guard): npx tsx scripts/urban_hash.ts [culture] */
import { createHash } from 'node:crypto';
import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';

const culture = process.argv[2] ?? 'european-organic';
const sizes: SizeName[] = ['hamlet', 'village', 'town', 'city'];
for (const size of sizes) {
  const row: string[] = [];
  for (const seed of ['1', '2', '3', '4']) {
    const w = generate(makeOptions({ seed, size, culture: culture as never }));
    const u = { ...w.urban } as Record<string, unknown>;
    // only the M3 fields (new additive fields are ignored)
    const keep = ['footprint', 'streets', 'blocks', 'parcels', 'buildings', 'walls', 'landmarks', 'squares', 'masses', 'backLand'];
    const sub: Record<string, unknown> = {};
    for (const k of keep) sub[k] = u[k];
    row.push(createHash('sha1').update(JSON.stringify(sub)).digest('hex').slice(0, 8));
  }
  console.log(size.padEnd(8), row.join(' '));
}
