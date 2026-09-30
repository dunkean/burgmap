import { writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { PLOT_DEBUG } from '../src/gen/urban/plots';
import type { Vec2 } from '../src/gen/core/geom';
import { area, isSimple } from '../src/gen/geo/poly';
import { union, intersection, difference, differenceS, mpArea } from '../src/gen/geo/bool';

PLOT_DEBUG.on = true;
PLOT_DEBUG.dump = Number(process.argv[4] ?? -1);
generate(makeOptions({ seed: process.argv[2] ?? '1', size: (process.argv[3] ?? 'city') as SizeName }));
for (const st of PLOT_DEBUG.stages) {
  if (Math.abs(st.B - st.cells) > 1 || Math.abs(st.B - st.taken - st.back) > 1) console.log(JSON.stringify(st));
}
const P = PLOT_DEBUG.polys as { B: Vec2[]; taken: Vec2[][]; takenHoles: Vec2[][]; back: Vec2[][] } | undefined;
if (P) {
  console.log('taken', P.taken.length, 'holes', P.takenHoles.map((h) => area(h).toFixed(1)), 'back', P.back.map((b) => area(b).toFixed(1)));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of P.B) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const pd = (r: Vec2[]) => 'M' + r.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join('L') + 'Z';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0 - 5} ${y0 - 5} ${x1 - x0 + 10} ${y1 - y0 + 10}" width="1600" height="1000"><rect x="${x0 - 5}" y="${y0 - 5}" width="${x1 - x0 + 10}" height="${y1 - y0 + 10}" fill="red"/><path d="${pd(P.B)}" fill="white"/>` +
    P.taken.map((t, i) => `<path d="${pd(t)}" fill="hsl(${i * 67 % 360},60%,70%)" stroke="#000" stroke-width="0.2"/>`).join('') +
    P.back.map((t) => `<path d="${pd(t)}" fill="green" stroke="#000" stroke-width="0.2"/>`).join('') +
    P.takenHoles.map((t) => `<path d="${pd(t)}" fill="blue"/>`).join('') + '</svg>';
  writeFileSync('out/dbg_area.png', new Resvg(svg).render().asPng());
  console.log(P.B.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
  console.log('B simple', isSimple(P.B), 'shoelace', area(P.B).toFixed(1), 'boolean', mpArea(union(P.B)).toFixed(1));
  const U = union(P.taken[0], ...P.taken.slice(1));
  const inter = P.taken.map((t, i) => P.taken.map((q, j) => (j > i ? mpArea(intersection(t, q)) : 0)).reduce((a, b) => a + b, 0)).reduce((a, b) => a + b, 0);
  const outside = mpArea(difference(U, P.B));
  const gap = difference(P.B, U, ...P.back);
  console.log('taken simple', P.taken.map((t) => isSimple(t)), 'areas', P.taken.map((t) => area(t).toFixed(1) + '/' + mpArea(union(t)).toFixed(1)));
  const d1 = difference(P.B, U);
  const dS = differenceS(P.B, ...P.taken.map((t) => [{ outer: t, holes: [] }]));
  const dSeq = P.taken.reduce((acc, t) => difference(acc, t), [{ outer: P.B, holes: [] }] as ReturnType<typeof difference>);
  console.log('diffS', mpArea(dS).toFixed(2), 'sequential', mpArea(dSeq).toFixed(2));
  let cx = 0, cy = 0;
  for (const p of P.B) { cx += p.x / P.B.length; cy += p.y / P.B.length; }
  for (const k of [1e-6, 1e-5, 1e-4]) {
    const Bs = P.B.map((p) => ({ x: cx + (p.x - cx) * (1 + k), y: cy + (p.y - cy) * (1 + k) }));
    const dd = difference(Bs, U);
    console.log('scaled', k, mpArea(dd).toFixed(2), dd.map((g) => area(g.outer).toFixed(2)).join(' '));
  }
  const inter2 = intersection(P.B, U);
  console.log('B∩U', mpArea(inter2).toFixed(2));
  console.log('B-U', mpArea(d1).toFixed(2), d1.map((g) => [area(g.outer).toFixed(1), g.holes.length]), 'U∪back', mpArea(union(U, ...P.back)).toFixed(1), 'U holes', U.map((g) => g.holes.map((h) => area(h).toFixed(1))));
  console.log('union', mpArea(U).toFixed(1), 'pairwise overlap', inter.toFixed(2), 'outside B', outside.toFixed(2), 'gap', mpArea(gap).toFixed(2), gap.map((g) => g.outer.length));
}
