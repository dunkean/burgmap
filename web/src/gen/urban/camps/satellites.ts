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
import { dispersedFarms, waterDist } from './homesteads';
import { germanicVillage, wetness } from './germanic';
import { raths } from './celtic';
import { norseFarms } from './norse';
import { nearestOn } from './norse';
import { openRing, at, hut, fitIn } from './kit';
import { orientPos, pointInRing, inscribed } from '../../geo/poly';
import { shireVillage, shireFarms } from './shire';
import { longhouseHamlet } from './longhouses';

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
    case 'native-iroquoian':
      // (fishing camps and cornfield hamlets; a large one is a village of its own)
      return pop < 450 ? longhouseHamlet(cc, c, pop, rng) : null;
    case 'kraal':
      return kraalHomesteads(cc, c, pop, rng);
    case 'native-plains':
      // (band camps along the streams; a large band raises its own smaller circle)
      return pop < 500 || rng.fork('form').chance(0.5) ? bandCamp(cc, c, pop, rng) : null;
    case 'nomad-camp':
      return pop < 700 ? ailCamps(cc, c, pop, rng) : null;
    case 'norse-ringfort':
      return norseFarms(cc, c, Math.min(pop, 600), rng);
    default:
      return null;
  }
}

/** Tipi footprint: slightly egg-shaped (wider at the back), the door toward `door`. */
function tipiFp(c: Vec2, r: number, door: number): Polygon {
  return orientPos(Array.from({ length: 12 }, (_, i) => {
    const t = ((i + 0.5) / 12) * 2 * Math.PI;
    return at(c, t, r * (1 + 0.08 * Math.cos(t - door - Math.PI)));
  }));
}

/**
 * A Southern African family homestead (umuzi): the huts in a crescent round the cattle byre, the great hut at the
 * top facing the gate, which opens downslope through the thorn fence; a raised granary. A cattle post is the byre
 * with a herder's hut. (The outlying form round a royal kraal.)
 */
export function kraalHomesteads(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  const sk = Math.sqrt(cc.sprawl);
  const n = Math.max(1, Math.round(pop / 9));
  const st = statusLadder(n, rng.fork('status'));
  return dispersedFarms(cc, c, st, {
    radius: (s: Status, r: Rng) => [r.range(26, 32), r.range(21, 26), r.range(16, 21), r.range(12, 15)][s] * sk,
    gap: 40 * sk,
    spread: (60 + Math.sqrt(n) * 75) * sk,
    wobble: 0.05,
    maxSlope: 0.3,
    fill: (o, pi, yard, home, s, gate, r) => {
      const ins = inscribed(yard, [], 0.5);
      const g = gate ?? home[0];
      const down = Math.atan2(g.y - ins.c.y, g.x - ins.c.x);
      // the byre in the middle (its fence), the huts on the arc away from the gate
      const br = ins.r * 0.36;
      const byre = orientPos(Array.from({ length: 16 }, (_, i) => at(ins.c, (i / 16) * 2 * Math.PI, br)));
      for (const pl of openRing(byre, [{ p: at(ins.c, down, br), width: 2.5 }])) o.lines.push({ kind: 'kraal-fence', path: pl, width: 1 });
      const placed: Polygon[] = [byre];
      const nh = s === 3 ? 1 : [r.int(6, 9), r.int(4, 6), r.int(3, 5)][s];
      for (let k = 0; k < nh; k++) {
        const a = down + Math.PI + (nh > 1 ? (k / (nh - 1) - 0.5) * 2.6 : 0);
        const great = k === Math.floor(nh / 2);
        const hr = (great ? 3.6 : r.range(2.4, 3)) * (s === 3 ? 0.85 : 1);
        const hq = at(ins.c, a, br + 2.5 + hr + r.range(0, 1.5));
        const hh = fitIn(yard, (q, kk) => hut(q, hr * kk, 14), placed, { margin: 1, gap: 1.2, minScale: 0.75, cands: [hq] });
        if (!hh) continue;
        placed.push(hh);
        o.buildings.push({ poly: hh, kind: 'house', parcel: pi, arch: great ? 'great-hut' : 'beehive-hut', roof: 'thatch-round', storeys: 1, material: 'thatch', orientation: a + Math.PI });
      }
      if (s <= 2) { const gg = fitIn(yard, (q, kk) => hut(q, 1.3 * kk, 8), placed, { margin: 0.8, gap: 1, minScale: 0.9, step: 2 }); if (gg) { placed.push(gg); o.buildings.push({ poly: gg, kind: 'outbuilding', parcel: pi, arch: 'raised-granary', roof: 'thatch-round', storeys: 1, material: 'thatch' }); } }
      const gp = gate ? nearestOn(home, gate) : null;
      for (const pl of openRing(home, gp ? [{ p: gp, width: 4 }] : [])) o.lines.push({ kind: 'thorn-fence', path: pl, width: 2 });
      if (s === 0) o.sites.push({ id: 'umuzi', kind: 'homestead', role: 'civic', lot: yard, anchor: ins.c });
    },
  }, rng);
}

/**
 * A Plains band camp: the lodges of a few families each, strung loosely along the stream in a sheltered bottom (no
 * circle: that was raised for the tribal gatherings), doors east, drying racks; the outlying form round a camp
 * circle, and a hamlet's.
 */
export function bandCamp(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  const sk = Math.sqrt(cc.sprawl);
  const n = Math.max(1, Math.round(pop / 22));
  const st = statusLadder(n, rng.fork('status'), false);
  return dispersedFarms(cc, c, st, {
    radius: (s: Status, r: Rng) => [r.range(15, 18), r.range(13, 16), r.range(11, 14), r.range(9, 11)][s] * sk,
    gap: 12 * sk,
    spread: (35 + Math.sqrt(n) * 38) * sk,
    wobble: 0.12,
    prefer: (p) => { const d = waterDist(cc, p, 200); return d < 200 ? 0.6 * (1 - d / 200) : 0; },
    fill: (o, pi, yard, home, s, gate, r) => {
      const ins = inscribed(yard, [], 0.5);
      const placed: Polygon[] = [];
      const nt = [4, 3, r.int(2, 3), 2][s];
      for (let k = 0; k < nt; k++) {
        const rr = r.range(2.3, 3);
        const tp = fitIn(yard, (q, kk) => tipiFp(q, rr * kk, 0), placed, { margin: 1, gap: 2.2, minScale: 0.8, cands: [at(ins.c, r.range(0, 2 * Math.PI), ins.r * r.range(0.2, 0.55))] }) ?? fitIn(yard, (q, kk) => tipiFp(q, rr * kk, 0), placed, { margin: 1, gap: 2.2, minScale: 0.8 });
        if (!tp) continue;
        placed.push(tp);
        o.buildings.push({ poly: tp, kind: 'house', parcel: pi, arch: 'tipi', roof: 'conical', storeys: 1, material: 'hide', orientation: 0 });
      }
      if (r.chance(0.7)) { const a = r.range(0, 3); o.lines.push({ kind: 'drying-rack', path: [at(ins.c, a, -2.5), at(ins.c, a, 2.5)], width: 0.8 }); }
      void home; void gate;
    },
  }, rng);
}

/** Steppe ails: a few gers of a family facing south, their pen, scattered on the pasture (the outlying form). */
export function ailCamps(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  const sk = Math.sqrt(cc.sprawl);
  const n = Math.max(1, Math.round(pop / 18));
  const st = statusLadder(n, rng.fork('status'), false);
  return dispersedFarms(cc, c, st, {
    radius: (s: Status, r: Rng) => [r.range(20, 24), r.range(17, 20), r.range(14, 17), r.range(11, 13)][s] * sk,
    gap: 45 * sk,
    spread: (60 + Math.sqrt(n) * 90) * sk,
    wobble: 0.1,
    fill: (o, pi, yard, home, s, gate, r) => {
      const ins = inscribed(yard, [], 0.5);
      const placed: Polygon[] = [];
      const ng = [4, 3, r.int(2, 3), 2][s];
      // the gers in a row facing south, the pen behind them
      for (let k = 0; k < ng; k++) {
        const q = { x: ins.c.x + (k - (ng - 1) / 2) * 8, y: ins.c.y + ins.r * 0.2 };
        const gg = fitIn(yard, (p, kk) => hut(p, r.range(2.8, 3.4) * kk, 14), placed, { margin: 1, gap: 1.6, minScale: 0.8, cands: [q] });
        if (gg) { placed.push(gg); o.buildings.push({ poly: gg, kind: 'house', parcel: pi, arch: 'ger', roof: 'dome', storeys: 1, material: 'felt', orientation: Math.PI / 2 }); }
      }
      const pen = orientPos(Array.from({ length: 14 }, (_, i) => at({ x: ins.c.x, y: ins.c.y - ins.r * 0.45 }, (i / 14) * 2 * Math.PI, ins.r * 0.38)));
      if (pen.every((q) => pointInRing(yard, q)) && !placed.some((p) => p.some((q) => pointInRing(pen, q)))) o.lines.push({ kind: 'pen-fence', path: pen.concat([pen[0]]), width: 0.5 });
      void home; void gate;
    },
  }, rng);
}

export type { Polygon };
void fences;
