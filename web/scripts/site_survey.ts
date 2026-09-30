import { Rng } from '../src/gen/core/rng';
import { makeOptions, SIZE_PRESETS, SizeName, Relief, CoastOpt, RiverOpt } from '../src/gen/options';
import { generateTerrain } from '../src/gen/terrain/hydrology';
import { chooseSite } from '../src/gen/site/site';
const size = (process.argv[2] ?? 'town') as SizeName;
const nSeeds = Number(process.argv[3] ?? 6);
const S = SIZE_PRESETS[size].mapSize;
const count: Record<string, number> = {};
for (let seed = 1; seed <= nSeeds; seed++) for (const relief of ['flat', 'hills', 'valley', 'mountains'] as Relief[]) for (const coast of ['none', 'random'] as CoastOpt[]) {
  const o = makeOptions({ seed: String(seed), relief, coast, river: 'river' as RiverOpt, size });
  const root = new Rng('burgmap:' + o.seed);
  const { terrain } = generateTerrain(o, root);
  const t0 = performance.now();
  const site = chooseSite(terrain, o, S, root);
  const ms = Math.round(performance.now() - t0);
  count[site.archetype] = (count[site.archetype] ?? 0) + 1;
  console.log(`${seed} ${relief} ${coast} -> ${site.archetype} @${Math.round(site.center.x)},${Math.round(site.center.y)} ${ms}ms offers ${JSON.stringify(site.offers)}`);
}
console.log(count);
