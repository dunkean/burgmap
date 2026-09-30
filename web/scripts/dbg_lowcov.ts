import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { area } from '../src/gen/geo/poly';

const w = generate(makeOptions({ seed: process.argv[2] ?? '3', size: (process.argv[3] ?? 'town') as SizeName }));
const u = w.urban!;
const ph = Number(process.argv[4] ?? 2);
const built = new Float64Array(u.blocks.length);
for (const b of u.buildings) if (b.parcel !== undefined && b.kind !== 'landmark' && b.kind !== 'church') built[u.parcels[b.parcel].block] += area(b.poly);
const rows: [number, number, number, number, string][] = [];
u.blocks.forEach((poly, i) => {
  const inf = u.blockInfo[i];
  if (inf.phase !== ph || inf.kind !== 'block') return;
  const a = area(poly);
  const np = u.parcels.filter((p) => p.block === i && p.use === 'plot').length;
  const ng = u.parcels.filter((p) => p.block === i && p.use === 'garden').reduce((s, p) => s + area(p.poly), 0);
  rows.push([i, a, built[i] / a, np, `gardens ${ng.toFixed(0)}`]);
});
rows.sort((x, y) => x[2] - y[2]);
for (const r of rows.slice(0, 12)) console.log('block', r[0], 'area', r[1].toFixed(0), 'cov', (r[2] * 100).toFixed(0) + '%', 'plots', r[3], r[4]);
const tot = rows.reduce((s, r) => s + r[1], 0), bt = rows.reduce((s, r) => s + r[1] * r[2], 0);
console.log('phase', ph, 'coverage', ((100 * bt) / tot).toFixed(1), '% of', (tot / 1e4).toFixed(1), 'ha');
