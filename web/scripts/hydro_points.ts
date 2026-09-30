/** Prints interesting spots (confluences, bridges, road junctions) of one generated map: tsx scripts/hydro_points.ts seed relief coast river size */
import { Rng } from '../src/gen/core/rng';
import { makeOptions, SIZE_PRESETS, SizeName } from '../src/gen/options';
import { generateTerrain } from '../src/gen/terrain/hydrology';
import { chooseSite } from '../src/gen/site/site';
import { routeRoads } from '../src/gen/roads/regional';
import { nearestOn } from '../src/gen/core/pline';
const [seed, relief, coast, river, size] = process.argv.slice(2);
const o = makeOptions({ seed, relief: relief as never, coast: coast as never, river: river as never, size: size as SizeName });
const S = SIZE_PRESETS[size as SizeName].mapSize;
const root = new Rng('burgmap:' + o.seed);
const { terrain: t } = generateTerrain(o, root);
const site = chooseSite(t, o, S, root);
const rr = routeRoads(t, site, o, S, root);
const f = (p: { x: number; y: number }) => `${Math.round(p.x)},${Math.round(p.y)}`;
console.log('center', f(site.center));
for (const r of t.rivers) if (r.mouth === 'river') console.log('confluence river#' + r.id, '->', r.host, f(r.path[r.path.length - 1]), r.cls);
for (const r of t.rivers) console.log('river#' + r.id, r.cls, r.source, 'start', f(r.path[0]), 'end', f(r.path[r.path.length - 1]), r.mouth);
for (const b of rr.bridges) console.log('bridge', f({ x: (b.a.x + b.b.x) / 2, y: (b.a.y + b.b.y) / 2 }));
rr.roads.forEach((rd, i) => {
  for (const end of [rd.path[0], rd.path[rd.path.length - 1]]) {
    rr.roads.forEach((h, j) => { if (j !== i && nearestOn(h.path, end).d < 0.6) console.log('junction road#' + i + '->' + j, f(end)); });
  }
});
