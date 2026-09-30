/** Capacity / emptiness survey: npx tsx scripts/capacity.ts [size] [culture] */
import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { pointInRing, area } from '../src/gen/geo/poly';
import { interiorPoint } from '../src/gen/urban';

const size = (process.argv[2] ?? 'town') as SizeName;
const culture = process.argv[3] ?? 'european-organic';
for (const relief of ['flat', 'hills', 'valley', 'mountains']) {
  const row: string[] = [];
  for (const seed of ['1', '2', '3', '4', '5', '6']) {
    const w = generate(makeOptions({ seed, size, relief: relief as never, culture: culture as never }));
    const u = w.urban!;
    const pts = u.blocks.map(interiorPoint);
    const emptyWalls = (u.walls ?? []).filter((wl) => !pts.some((p) => pointInRing(wl.path, p))).length;
    let emptyReg = 0;
    for (const ph of u.phases) for (const r of ph.region) if (area(r.outer) > 3000 && !pts.some((p) => pointInRing(r.outer, p) && !r.holes.some((h) => pointInRing(h, p)))) emptyReg++;
    const cap = Number(w.stats['urban.capacity']) / Number(w.stats['urban.pop']);
    row.push(`${seed}:${(cap * 100).toFixed(0)}%${emptyWalls ? ' W!' + emptyWalls : ''}${emptyReg ? ' R!' + emptyReg : ''}`);
  }
  console.log(relief.padEnd(10), row.join('  '));
}
