import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { checkWorld } from '../tests/urbanCheck';
import { area } from '../src/gen/geo/poly';

const w = generate(makeOptions({ seed: process.argv[2] ?? '2', size: (process.argv[3] ?? 'city') as SizeName, culture: process.argv[4] ?? 'european-organic' }));
const u = w.urban!;
const r = checkWorld(w);
console.log(r.details.slice(0, 3));
// plots of ~195 m2 near places
u.parcels.forEach((p, i) => {
  if (p.use !== 'plot') return;
  const a = area(p.poly);
  if (Math.abs(a - 195) < 1.5) console.log('plot', i, a.toFixed(1), 'block', p.block, JSON.stringify(u.blockInfo[p.block]), 'front', p.front && Math.hypot(p.front[1].x - p.front[0].x, p.front[1].y - p.front[0].y).toFixed(2), JSON.stringify(p.poly.map((q) => [+q.x.toFixed(1), +q.y.toFixed(1)])));
});
