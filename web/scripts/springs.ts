import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
const rows: string[] = [];
for (const relief of ['flat', 'hills', 'valley', 'mountains'] as const)
  for (const seed of ['1', '2', '3', '4']) {
    const w = generate(makeOptions({ seed, size: (process.argv[2] ?? 'town') as any, relief, river: 'river' } as any));
    const r = w.terrain.rivers as any[];
    const springs = r.filter((x) => x.source === 'spring').length;
    rows.push(`${relief} ${seed}: rivers ${r.length}, springs ${springs}, edge ${r.filter((x) => x.source === 'edge').length}`);
  }
console.log(rows.join('\n'));
