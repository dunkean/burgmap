import { Rng } from '../src/gen/core/rng';
import { makeOptions, SIZE_PRESETS, RiverOpt, SizeName } from '../src/gen/options';
import { generateTerrain } from '../src/gen/terrain/hydrology';
import { chooseSite } from '../src/gen/site/site';
import { routeRoads } from '../src/gen/roads/regional';
import { checkRivers, checkRoads } from '../tests/hydroCheck';

const river = (process.argv[2] ?? 'river') as RiverOpt;
const nSeeds = Number(process.argv[3] ?? 10);
const size = (process.argv[4] ?? 'town') as SizeName;
const only = process.argv[5] ?? 'all';
const summary = new Map<string, number>();
const verbose = process.argv.includes('-v');
let cases = 0, bad = 0;
const t0 = performance.now();
for (let s = 1; s <= nSeeds; s++) for (const relief of ['flat', 'hills', 'valley', 'mountains'] as const) for (const coast of ['none', 'random'] as const) {
  const o = makeOptions({ seed: String(s), relief, coast, river, size });
  const root = new Rng('burgmap:' + o.seed);
  const S = SIZE_PRESETS[size].mapSize;
  const { terrain } = generateTerrain(o, root);
  const needRoads = only !== 'rivers';
  const site = needRoads ? chooseSite(terrain, o, S, root) : (null as never);
  const rr = needRoads ? routeRoads(terrain, site, o, S, root) : { roads: [], bridges: [] };
  const vs = [
    ...(only === 'roads' ? [] : checkRivers(terrain, { mapSize: S, river, widthK: 1 })),
    ...(only === 'rivers' ? [] : checkRoads(terrain, site, rr.roads, rr.bridges, S)),
  ];
  cases++;
  if (vs.length) bad++;
  for (const m of vs) {
    const key = m.replace(/#\d+/g, '#').replace(/[-\d.]+/g, 'N');
    summary.set(key, (summary.get(key) ?? 0) + 1);
    if (verbose) console.log(`[${s} ${relief} ${coast}] ${m}`);
  }
}
console.log(`cases ${cases}, with violations ${bad}, ${Math.round(performance.now() - t0)} ms`);
[...summary.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, c]) => console.log(String(c).padStart(4), k));
