import { describe, it, expect } from 'vitest';
import { Rng } from '../src/gen/core/rng';
import { makeOptions, SIZE_PRESETS, Relief, RiverOpt, SizeName, CoastOpt } from '../src/gen/options';
import { generateTerrain } from '../src/gen/terrain/hydrology';
import { chooseSite } from '../src/gen/site/site';
import { routeRoads } from '../src/gen/roads/regional';
import { checkRivers, checkRoads } from './hydroCheck';

/**
 * Hydrology + road-junction invariants over seeds 1-10 x reliefs x coast on/off:
 *  - width monotone downstream, width <= f(contributing area), class consistent with width
 *  - every channel wider than a brook traces upstream to a map edge; only brooks rise inside the map
 *  - the forced main river enters at a map edge; confluence angles 25-80 deg pointing downstream
 *  - no river/river crossings, no parallel touching channels, no channel ending nowhere, one outlet per lake
 *  - roads: Y/T junctions at shared vertices with sane angles, no doubled segments (< 6 m), no stubs,
 *    bridges perpendicular to the river (+-25 deg), on dry land and aligned with the road, fords on brooks only
 */
function audit(relief: Relief, river: RiverOpt, seeds: number[], size: SizeName, coasts: CoastOpt[]): string[] {
  const out: string[] = [];
  for (const seed of seeds) for (const coast of coasts) {
    const o = makeOptions({ seed: String(seed), relief, coast, river, size });
    const root = new Rng('magna-urbis:' + o.seed);
    const S = SIZE_PRESETS[size].mapSize;
    const { terrain } = generateTerrain(o, root);
    const site = chooseSite(terrain, o, S, root);
    const rr = routeRoads(terrain, site, o, S, root);
    const vs = [...checkRivers(terrain, { mapSize: S, river, widthK: 1 }), ...checkRoads(terrain, site, rr.roads, rr.bridges, S)];
    for (const m of vs) out.push(`[${relief} ${river} ${size} seed ${seed} coast ${coast}] ${m}`);
  }
  return out;
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
describe('hydrology and road junction invariants (town, river option, seeds 1-10, coast on/off)', () => {
  for (const relief of ['flat', 'hills', 'valley', 'mountains'] as Relief[]) {
    it(`${relief}`, () => {
      const v = audit(relief, 'river', SEEDS, 'town', ['none', 'random']);
      expect(v, v.slice(0, 200).join('\n')).toEqual([]);
    }, 600000);
  }
});

describe('other river options and sizes', () => {
  it('major river, village', () => {
    const v = audit('hills', 'major', [1, 2, 3, 4], 'village', ['none', 'random']);
    expect(v, v.slice(0, 200).join('\n')).toEqual([]);
  }, 600000);
  it('stream, hamlet', () => {
    const v = audit('valley', 'stream', [1, 2, 3, 4], 'hamlet', ['none', 'random']);
    expect(v, v.slice(0, 200).join('\n')).toEqual([]);
  }, 600000);
  it('no river option: only brooks, all ending in something', () => {
    const v = audit('hills', 'none', [1, 2, 3], 'town', ['none', 'random']);
    expect(v, v.slice(0, 200).join('\n')).toEqual([]);
  }, 600000);
});
