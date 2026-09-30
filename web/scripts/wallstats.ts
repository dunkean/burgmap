/** Wall geometry survey: curtain lengths, vertex towers. npx tsx scripts/wallstats.ts */
import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { dist } from '../src/gen/core/geom';

for (const size of ['town', 'city'] as SizeName[]) for (const seed of ['1', '2', '3', '4', '5', '6']) {
  const w = generate(makeOptions({ seed, size, culture: (process.argv[2] ?? 'european-organic') as never }));
  const u = w.urban!;
  for (const wl of u.walls ?? []) {
    const cur = (wl.curtains ?? []).map(([a, b]) => dist(a, b));
    const tw = wl.towers.concat(wl.gateTowers ?? []);
    let noTower = 0, verts = 0;
    for (const pc of wl.pieces ?? []) for (let i = 1; i < pc.length - 1; i++) { verts++; if (!tw.some((t) => dist(t, pc[i]) < 4.5)) noTower++; }
    const edges: number[] = [];
    for (const pc of wl.pieces ?? []) for (let i = 1; i < pc.length; i++) edges.push(dist(pc[i - 1], pc[i]));
    const s = (a: number[]) => a.length ? `${Math.min(...a).toFixed(0)}..${Math.max(...a).toFixed(0)} (n=${a.length})` : '-';
    console.log(size, seed, 'curtains', s(cur), 'edges', s(edges), 'verts', verts, 'noTower', noTower, 'towers', wl.towers.length);
  }
}
