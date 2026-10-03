/**
 * Viking farmstead cluster (Hofstaðir, Vorbasse's later farms, the Norse farms of Iceland and Norway): each farm a
 * homefield (tún) inside its turf wall, a bow-sided longhouse along the slope's contour, a byre, pit houses, a
 * smithy, granaries; the chieftain's hall farm the largest. The farms keep to the dry ground near the shore or the
 * river and to the sunny slopes, fields between them; a farm by the water has its boathouse (naust) on the shore.
 */
import type { Vec2, Polygon } from '../../core/geom';
import { dist } from '../../core/geom';
import type { Rng } from '../../core/rng';
import { orientPos, pointInRing, distToRing } from '../../geo/poly';
import type { CampCtx } from './index';
import { downhill } from './index';
import { CampOut, at, openRing, rect, fitIn } from './kit';
import { statusLadder, fillFarm, Status } from './farms';
import { dispersedFarms, contourAt, waterDist } from './homesteads';

export function norseFarms(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  const sk = Math.sqrt(cc.sprawl);
  const nF = Math.max(1, Math.round(pop / 14));
  const st = statusLadder(nF, rng.fork('status'));
  const shoreCache = new Map<string, number>();
  const shore = (p: Vec2): number => {
    const k = Math.round(p.x / 20) + ',' + Math.round(p.y / 20);
    let d = shoreCache.get(k);
    if (d === undefined) { d = waterDist(cc, p, 260); shoreCache.set(k, d); }
    return d;
  };
  const out = dispersedFarms(cc, c, st, {
    radius: (s: Status, r: Rng) => [r.range(52, 64), r.range(40, 50), r.range(31, 40), r.range(19, 25)][s] * sk,
    gap: 34 * sk,
    spread: (90 + Math.sqrt(nF) * 95) * sk,
    wobble: 0.11,
    // (homefields stretched along the slope's contour, as the farms lay along the shore and the valley side)
    aspect: [1.2, 1.85],
    // near the shore (not on it), on the sunny side of the slope
    prefer: (p) => {
      const d = shore(p);
      let s = d < 40 ? -0.3 : d < 220 ? 0.7 * (1 - (d - 40) / 180) : 0;
      const dh = downhill(cc.ctx, p, 30);
      if (dh !== null) s += 0.25 * Math.sin(dh);
      return s;
    },
    fill: (o, pi, yard, home, s, gate, r) => {
      const ic = yard.reduce((a, q) => ({ x: a.x + q.x / yard.length, y: a.y + q.y / yard.length }), { x: 0, y: 0 });
      const axis = contourAt(cc, ic);
      fillFarm(o, pi, yard, s, { kind: 'norse', axis, fence: null }, gate, r);
      // the turf wall round the homefield, open at the gate
      const g = gate ? nearestOn(home, gate) : null;
      for (const pl of openRing(home, g ? [{ p: g, width: 5 }] : [])) o.lines.push({ kind: 'turf-wall', path: pl, width: 2.2 });
      if (s === 0) o.sites.push({ id: 'hall', kind: 'hall-farm', role: 'power', lot: yard, anchor: ic });
      // a boathouse on the shore when the farm is by the water (inside the homefield, its end to the water)
      if (shore(ic) < 120) {
        let best: Vec2 | null = null, bd = Infinity;
        for (let k = 0; k < 24; k++) {
          const q = at(ic, (k / 24) * 2 * Math.PI, dist(ic, home[0]) * 0.8);
          const d = shore(q);
          if (d < bd && pointInRing(yard, q)) { bd = d; best = q; }
        }
        if (best) {
          const a = Math.atan2(best.y - ic.y, best.x - ic.x);
          const placedHere = o.buildings.filter((b) => b.parcel === pi).map((b) => b.poly);
          const nb = fitIn(yard, (q, s2) => rect(q, a, 13 * s2, 6.5 * s2), placedHere, { margin: 1, gap: 2.5, minScale: 0.7, cands: [best, { x: (best.x + ic.x) / 2, y: (best.y + ic.y) / 2 }] });
          if (nb) o.buildings.push({ poly: nb, kind: 'outbuilding', parcel: pi, arch: 'naust', roof: 'gable', storeys: 1, material: 'turf', orientation: a });
        }
      }
    },
  }, rng);
  return out;
}

function nearestOn(ring: Polygon, p: Vec2): Vec2 {
  let best = ring[0], bd = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = dist(q, p);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

export { nearestOn, orientPos, distToRing };
