import { writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { FIT_STATS } from '../src/gen/urban/fortify';
import type { Vec2 } from '../src/gen/core/geom';

const dumps: { ring: Vec2[]; fit: Vec2[] }[] = [];
FIT_STATS.log = (ring, fit) => dumps.push({ ring, fit });
FIT_STATS.why = (w) => console.log('  why', w);
const only = process.argv[2];
for (const size of ['town', 'city'] as SizeName[]) for (const seed of ['1', '2', '3', '4']) {
  if (only && only !== `${size}${seed}`) continue;
  FIT_STATS.ok = 0; FIT_STATS.fallback = 0;
  generate(makeOptions({ seed, size }));
  console.log(size, seed, FIT_STATS.ok, FIT_STATS.fallback);
}
dumps.slice(0, 3).forEach((d, i) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of d.ring.concat(d.fit)) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const pd = (r: Vec2[]) => 'M' + r.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L') + 'Z';
  const dots = d.fit.map((p, k) => `<circle cx="${p.x}" cy="${p.y}" r="3" fill="${k === 0 ? 'green' : 'red'}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0 - 20} ${y0 - 20} ${x1 - x0 + 40} ${y1 - y0 + 40}" width="1000"><rect x="${x0 - 20}" y="${y0 - 20}" width="${x1 - x0 + 40}" height="${y1 - y0 + 40}" fill="white"/><path d="${pd(d.ring)}" fill="#cde" stroke="#036" stroke-width="1"/><path d="${pd(d.fit)}" fill="none" stroke="red" stroke-width="1.5"/>${dots}</svg>`;
  writeFileSync(`out/dbg_fit_${i}.png`, new Resvg(svg).render().asPng());
});
