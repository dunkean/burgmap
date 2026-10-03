/**
 * Fantasy landmark plans: the mortuary temple of a necropolis (a stepped mausoleum on its forecourt, obelisks on
 * the processional axis) and the charnel house (ossuary range round a bone yard).
 */
import type { Polygon } from '../core/geom';
import type { CompoundCtx, CompoundOut } from './compounds';
import { registerBuilders } from './compounds';
import { orientPos, inscribed, obb, pointInRing, distToRing } from '../geo/poly';
import { disk } from '../geo/offset';
import type { Vec2 } from '../core/geom';
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


const ngon = (c: Vec2, r: number, n: number, a0 = 0): Polygon => orientPos(Array.from({ length: n }, (_, k) => ({ x: c.x + Math.cos(a0 + (k / n) * Math.PI * 2) * r, y: c.y + Math.sin(a0 + (k / n) * Math.PI * 2) * r })));
const ring = (c: Vec2, r: number, n = 48): Polygon => { const p = ngon(c, r, n); return p.concat([p[0]]); };

/**
 * The great tower of a wizard city: the tower (a 16-sided keep) on its terrace in the middle of the circus, eight
 * obelisks on the ley lines round it, two arcane circles inscribed in the paving.
 */
function wizardTower(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'place' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const ins = inscribed(P, [], 1);
  const R = ins.r;
  if (R < 10) return out;
  const tr = Math.max(6, Math.min(18, R * 0.3));
  const tower = ngon(ins.c, tr, 16, Math.PI / 16);
  if (fits(P, tower, 1)) {
    out.buildings.push({ poly: tower, kind: 'landmark', parcel: 0, arch: 'great-tower', roof: 'conical', material: 'stone', storeys: 12 });
    out.landmarks.push({ kind: 'great-tower', poly: tower });
  }
  for (const k of [0.62, 0.86]) if (R * k > tr + 3) out.lines.push({ kind: 'arcane-circle', path: ring(ins.c, R * k), width: 0.6 });
  // the obelisks on the eight ley lines
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const q = { x: ins.c.x + Math.cos(a) * R * 0.74, y: ins.c.y + Math.sin(a) * R * 0.74 };
    const ob = placeRect(P, q, a, 1.3, 1.3, 1);
    if (ob && !out.buildings.some((b) => overlap(b.poly, ob))) out.buildings.push({ poly: ob, kind: 'landmark', parcel: 0, arch: 'ley-obelisk', roof: 'pyramidal', material: 'stone', storeys: 4 });
  }
  void cx;
  return out;
}

/** A mage's tower: a round tower in its walled garden, an annex, a scrying pool. */
function mageTower(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'compound:mage-tower' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const ins = inscribed(P, [], 0.5);
  const r = Math.max(3.5, Math.min(9, ins.r * 0.45));
  const t = ngon(ins.c, r, 14);
  if (!fits(P, t, 1)) return out;
  out.buildings.push({ poly: t, kind: 'landmark', parcel: 0, arch: 'mage-tower', roof: 'conical', material: 'stone', storeys: cx.rng.int(5, 9) });
  out.landmarks.push({ kind: 'mage-tower', poly: t });
  const a = cx.rng.range(0, Math.PI * 2);
  const an = placeRect(P, { x: ins.c.x + Math.cos(a) * (r + 4.5), y: ins.c.y + Math.sin(a) * (r + 4.5) }, a, 4, 3, 1);
  if (an && !overlap(an, t)) out.buildings.push({ poly: an, kind: 'landmark', parcel: 0, arch: 'mage-annex', roof: 'hip', material: 'stone', storeys: 2 });
  const pc = { x: ins.c.x - Math.cos(a) * (r + 4), y: ins.c.y - Math.sin(a) * (r + 4) };
  if (pointInRing(P, pc) && distToRing(P, pc) > 3) out.water.push(orientPos(disk(pc, 1.8, 12)));
  out.lines.push({ kind: 'compound-wall', path: P, closed: true, width: 0.9 });
  return out;
}

/** An arcane garden: concentric circular walks crossed by the eight ley walks, the fountain in the middle. */
function arcaneGarden(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'green' }], buildings: [], lines: [], water: [], landmarks: [], trees: [] };
  const P = orientPos(lot);
  const ins = inscribed(P, [], 1);
  const R = ins.r - 2;
  if (R < 10) return out;
  for (let k = 1; k <= 3; k++) out.lines.push({ kind: 'footpath', path: ring(ins.c, (R * k) / 3.3), width: 1.4 });
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; out.lines.push({ kind: 'footpath', path: [{ x: ins.c.x + Math.cos(a) * 3, y: ins.c.y + Math.sin(a) * 3 }, { x: ins.c.x + Math.cos(a) * R, y: ins.c.y + Math.sin(a) * R }], width: 1.2 }); }
  out.water.push(orientPos(disk(ins.c, Math.min(4, R * 0.15), 16)));
  for (let k = 0; k < 3; k++) for (let i = 0; i < 8; i++) {
    const a = ((i + 0.5) / 8) * Math.PI * 2, rr = (R * (k + 0.5)) / 3.3 + 2;
    const q = { x: ins.c.x + Math.cos(a) * rr, y: ins.c.y + Math.sin(a) * rr };
    if (pointInRing(P, q) && distToRing(P, q) > 3) out.trees!.push({ x: q.x, y: q.y, r: cx.rng.range(2.2, 3.4) });
  }
  out.landmarks.push({ kind: 'arcane-garden', poly: P });
  out.lines.push({ kind: 'hedge', path: P, closed: true, width: 2 });
  return out;
}

/** The observatory: the domed star tower on its square terrace, the meridian line and the sundial circle. */
function observatory(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'place' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const ins = inscribed(P, [], 1);
  const s = Math.max(5, Math.min(14, ins.r * 0.4));
  const base = placeRect(P, ins.c, 0, s, s, 1);
  if (!base) return out;
  out.buildings.push({ poly: base, kind: 'landmark', parcel: 0, arch: 'observatory', roof: 'dome', material: 'stone', storeys: 4 });
  out.lines.push({ kind: 'dome', path: ring(ins.c, s * 0.7, 24), width: 0.6 });
  if (ins.r > s + 6) {
    out.lines.push({ kind: 'arcane-circle', path: ring(ins.c, Math.min(ins.r - 2, s + 5)), width: 0.4 });
    out.lines.push({ kind: 'arcane-circle', path: [{ x: ins.c.x, y: ins.c.y - Math.min(ins.r - 2, s + 5) }, { x: ins.c.x, y: ins.c.y + Math.min(ins.r - 2, s + 5) }], width: 0.4 });
  }
  out.landmarks.push({ kind: 'observatory', poly: base });
  void cx;
  return out;
}

/**
 * The clock-tower plaza of a gnomish town: the tall clock tower in the middle (its four dials and the great wheel
 * drawn on the paving), four fountains on the diagonals.
 */
function clocktower(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'place' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const ins = inscribed(P, [], 1);
  const o = obb(P);
  const ang = Math.atan2(o.u.y, o.u.x);
  const s = Math.max(4, Math.min(8, ins.r * 0.25));
  const t = placeRect(P, ins.c, ang, s, s, 1);
  if (!t) return out;
  out.buildings.push({ poly: t, kind: 'landmark', parcel: 0, arch: 'clock-tower', roof: 'pyramidal', material: 'brick', storeys: 10 });
  out.landmarks.push({ kind: 'clock-tower', poly: t });
  // the great wheel set in the paving round the tower (gear teeth as short spokes)
  const R = Math.min(ins.r - 2, s * 2.2);
  if (R > s + 2) {
    out.lines.push({ kind: 'arcane-circle', path: ring(ins.c, R, 40), width: 0.5 });
    for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; out.lines.push({ kind: 'arcane-circle', path: [{ x: ins.c.x + Math.cos(a) * R, y: ins.c.y + Math.sin(a) * R }, { x: ins.c.x + Math.cos(a) * (R + 1.6), y: ins.c.y + Math.sin(a) * (R + 1.6) }], width: 0.5 }); }
  }
  for (const k of [0, 1, 2, 3]) {
    const a = ang + Math.PI / 4 + (k * Math.PI) / 2;
    const q = { x: ins.c.x + Math.cos(a) * (R + 6), y: ins.c.y + Math.sin(a) * (R + 6) };
    if (pointInRing(P, q) && distToRing(P, q) > 3) out.water.push(orientPos(disk(q, 1.6, 12)));
  }
  void cx;
  return out;
}

let registered = false;
export function registerFantasy(): void {
  if (registered) return;
  registered = true;
  registerBuilders({ 'mortuary-temple': mortuaryTemple, 'charnel-house': charnelHouse, 'wizard-tower': wizardTower, 'mage-tower': mageTower, 'arcane-garden': arcaneGarden, observatory, clocktower });
}
