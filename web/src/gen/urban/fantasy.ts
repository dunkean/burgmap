/**
 * Fantasy landmark plans: the mortuary temple of a necropolis (a stepped mausoleum on its forecourt, obelisks on
 * the processional axis) and the charnel house (ossuary range round a bone yard).
 */
import type { Polygon } from '../core/geom';
import type { CompoundCtx, CompoundOut } from './compounds';
import { registerBuilders } from './compounds';
import { orientPos, inscribed, obb, pointInRing } from '../geo/poly';
import { placeRect, alongEdge, longestEdge, fits } from './m4/kit';
import { pyramid } from './aztec';

const overlap = (A: Polygon, B: Polygon): boolean => A.some((q) => pointInRing(B, q)) || B.some((q) => pointInRing(A, q));

/** Mortuary temple: the great stepped tomb at the back of its forecourt, a pair of obelisks before it. */
function mortuaryTemple(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'place' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const ins = inscribed(P, [], 1);
  const ang = cx.angle;
  const h = Math.max(8, Math.min(40, ins.r * 0.55));
  const back = { x: ins.c.x - Math.cos(ang) * ins.r * 0.25, y: ins.c.y - Math.sin(ang) * ins.r * 0.25 };
  const T = pyramid(out, P, back, ang, h, 'great-mausoleum', ang, false);
  if (T) out.landmarks.push({ kind: 'great-mausoleum', poly: T });
  for (const s of [-1, 1]) {
    const q = { x: ins.c.x + Math.cos(ang) * ins.r * 0.55 - Math.sin(ang) * s * h * 0.5, y: ins.c.y + Math.sin(ang) * ins.r * 0.55 + Math.cos(ang) * s * h * 0.5 };
    const ob = placeRect(P, q, ang, 1.4, 1.4, 1);
    if (ob && !out.buildings.some((b) => overlap(b.poly, ob))) out.buildings.push({ poly: ob, kind: 'landmark', parcel: 0, arch: 'obelisk', roof: 'pyramidal', material: 'stone', storeys: 8 });
  }
  out.lines.push({ kind: 'stone-wall', path: P, closed: true, width: 1.4 });
  return out;
}

/** Charnel house: a long ossuary range along the lot's longest side, a cloister walk, the bone yard. */
function charnelHouse(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'church' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const e = longestEdge(P);
  if (e >= 0) {
    const r = alongEdge(P, e, cx.rng.range(8, 11), 60, 1.2);
    if (r) { out.buildings.push({ poly: r, kind: 'landmark', parcel: 0, arch: 'charnel-house', roof: 'gable', material: 'stone', storeys: 1 }); out.landmarks.push({ kind: 'charnel-house', poly: r }); }
  }
  const o = obb(P);
  const chap = placeRect(P, o.c, Math.atan2(o.u.y, o.u.x), 4.5, 3.5, 2);
  if (chap && !out.buildings.some((b) => overlap(b.poly, chap)) && fits(P, chap, 1)) out.buildings.push({ poly: chap, kind: 'landmark', parcel: 0, arch: 'mortuary-chapel', roof: 'gable', material: 'stone', storeys: 1 });
  out.lines.push({ kind: 'stone-wall', path: P, closed: true, width: 1.2 });
  return out;
}

let registered = false;
export function registerFantasy(): void {
  if (registered) return;
  registered = true;
  registerBuilders({ 'mortuary-temple': mortuaryTemple, 'charnel-house': charnelHouse });
}
