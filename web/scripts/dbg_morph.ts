import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { area } from '../src/gen/geo/poly';

const [culture, seed, size] = [process.argv[2] ?? 'medina', process.argv[3] ?? '2', (process.argv[4] ?? 'town') as SizeName];
const w = generate(makeOptions({ seed, size, culture }));
const u = w.urban!;
const by = new Map<string, { n: number; a: number; plots: number }>();
u.blockInfo.forEach((b, i) => {
  const k = `${b.morphology}|${b.zone}|p${b.phase}|${b.kind}${b.compound ? ':' + b.compound : ''}`;
  const r = by.get(k) ?? { n: 0, a: 0, plots: 0 };
  r.n++; r.a += area(u.blocks[i]);
  r.plots += u.parcels.filter((p) => p.block === i && p.use === 'plot').length;
  by.set(k, r);
});
for (const [k, v] of by) console.log(k.padEnd(50), 'blocks', v.n, 'ha', (v.a / 1e4).toFixed(1), 'plots', v.plots);
const kinds = new Map<string, number>();
for (const b of u.buildings) kinds.set(b.arch ?? b.kind, (kinds.get(b.arch ?? b.kind) ?? 0) + 1);
console.log([...kinds.entries()].map(([k, v]) => `${k}:${v}`).join(' '));
console.log('streets by role', Object.entries(u.streets.reduce((m, s) => { m[s.role] = (m[s.role] ?? 0) + 1; return m; }, {} as Record<string, number>)));
