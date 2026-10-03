/**
 * Satellites and outlying settlements of the camp cultures: what stands round a large village or camp, and what
 * the settlement system's secondary settlements are, instead of copies of the main plan (BUGS.md: "stop copying
 * the same style for peripheral villages"). Each culture has its own outlying form, with its own function:
 * Viking farms round a ring fortress, raths round a hillfort or an oppidum, single homesteads and cattle posts round
 * a kraal, band camps strung along the streams round a Plains camp circle, unpalisaded hamlets by the cornfields
 * round an Iroquoian town, ails round an ordu, houselot hamlets round a Maya centre, farm hamlets in the Shire.
 */
import type { Vec2, Polygon } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { CampCtx } from './index';
import type { CampOut } from './kit';
import { statusLadder, fillFarm, fences, Status } from './farms';
import { dispersedFarms } from './homesteads';
import { germanicVillage, wetness } from './germanic';
import { raths } from './celtic';
import { norseFarms } from './norse';
import { nearestOn } from './norse';
import { openRing } from './kit';
import { shireVillage, shireFarms } from './shire';

/** Germanic hamlet: a few fenced farmyards (Einzelhöfe) along their tracks. */
export function germanicHamlet(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  const sk = Math.sqrt(cc.sprawl);
  const n = Math.max(1, Math.round(pop / 12));
  const st = statusLadder(n, rng.fork('status'));
  return dispersedFarms(cc, c, st, {
    radius: (s: Status, r: Rng) => [r.range(40, 46), r.range(33, 39), r.range(27, 33), r.range(19, 23)][s] * sk,
    gap: 22 * sk,
    spread: (50 + Math.sqrt(n) * 70) * sk,
    wobble: 0,
    shape: 'rect',
    aspect: [1.1, 1.5],
    fill: (o, pi, yard, home, s, gate, r) => {
      const ic = yard.reduce((a, q) => ({ x: a.x + q.x / yard.length, y: a.y + q.y / yard.length }), { x: 0, y: 0 });
      fillFarm(o, pi, yard, s, { kind: 'germanic', axis: null, fence: 'yard-fence' }, gate, r);
      const g = gate ? nearestOn(home, gate) : null;
      for (const pl of openRing(home, g ? [{ p: g, width: 4 }] : [])) o.lines.push({ kind: 'yard-fence', path: pl, width: 0.4 });
      if (s === 0) o.sites.push({ id: 'chief', kind: 'chieftain-farm', role: 'power', lot: yard, anchor: ic });
    },
  }, rng);
}

/**
 * The outlying form of a culture for a settlement of `pop` (k: rank in a cluster, 0 for a secondary settlement of
 * the settlement system), or null when the culture's own plan is used.
 */
export function satellite(culture: string, cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut | null {
  switch (culture) {
    case 'barbarian':
      if (pop < 170) return germanicHamlet(cc, c, pop, rng);
      // (by the water a wurt, else a street village of its own size)
      return germanicVillage(cc, c, pop, rng, wetness(cc, c, 260) > 0.04 && pop <= 340 ? 'wurt' : 'street');
    case 'barbarian-celtic':
    case 'celtic-oppidum':
      return raths(cc, c, pop, rng);
    case 'halfling':
      // (farm hamlets and smaller hill villages)
      return pop < 260 || (pop < 600 && rng.fork('form').chance(0.5)) ? shireFarms(cc, c, pop, rng) : shireVillage(cc, c, pop, rng);
    case 'norse-ringfort':
      return norseFarms(cc, c, Math.min(pop, 600), rng);
    default:
      return null;
  }
}

export type { Polygon };
void fences;
