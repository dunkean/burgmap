/**
 * Ottoman town (Bursa, Safranbolu, Edirne, Plovdiv): the çarşı (market streets of shop rows round the bedesten, the
 * domed hall of the precious goods, and the hans), the Ulu Cami (a hypostyle mosque under a grid of domes) on the
 * market, külliye complexes (the domed mosque in its court, the madrasa round its own court, the imaret, the
 * hammam and the founder's türbe) on the edges of the town, and the mahalle quarters each round its small mosque
 * (mescit) with its fountain and graves; wooden houses (konak) on the street front with their gardens behind.
 */
import type { Vec2, Polygon } from '../core/geom';
import { dist } from '../core/geom';
import type { CompoundCtx, CompoundOut } from './compounds';
import { registerBuilders } from './compounds';
import { orientPos, pointInRing, inscribed, obb } from '../geo/poly';
import { disk } from '../geo/offset';
import { fits } from './m4/kit';
import { rectAt } from './m4/lots';
import { bestRect } from './persian';

const overlap = (A: Polygon, B: Polygon): boolean => A.some((q) => pointInRing(B, q)) || B.some((q) => pointInRing(A, q));
/** Qibla from Anatolia and the Balkans: south-east (map angle, y down). */
export const QIBLA_TR = 1.05;
type B = CompoundOut['buildings'][number];

/**
 * A domed mosque at c (local u = toward the qibla): the square prayer hall under its dome (half domes on the
 * large ones), the portico of five small domes before it, the minaret at the corner; for a large mosque the court
 * (avlu) with its arcades and the şadırvan before the portico. Returns false when it does not fit.
 */
function mosque(out: CompoundOut, P: Polygon, c: Vec2, s: number, big: boolean, parcel = 0): boolean {
  const ang = QIBLA_TR;
  const R = (u0: number, u1: number, v0: number, v1: number) => rectAt(c, ang, u0, u1, v0, v1);
  const h = s / 2;
  const hall = R(-h, h, -h, h);
  const portico = R(-h - s * 0.28, -h, -h, h);
  const court = big ? R(-h - s * 0.28 - s * 1.1, -h - s * 0.28 - 0.01, -h * 1.05, h * 1.05) : null;
  const mc = { x: c.x + Math.cos(ang) * (-h - 2) - Math.sin(ang) * (h + 2.2), y: c.y + Math.sin(ang) * (-h - 2) + Math.cos(ang) * (h + 2.2) };
  const minaret = orientPos(disk(mc, big ? 2.4 : 1.7, 10));
  const parts: [Polygon, string, B['roof'], number][] = [[hall, big ? 'kulliye-mosque' : 'mescit', 'dome', big ? 2 : 1], [portico, 'son-cemaat-portico', 'dome', 1], [minaret, 'minaret', 'dome', big ? 10 : 6]];
  if (big) {
    const mc2 = { x: c.x + Math.cos(ang) * (-h - 2) + Math.sin(ang) * (h + 2.2), y: c.y + Math.sin(ang) * (-h - 2) - Math.cos(ang) * (h + 2.2) };
    parts.push([orientPos(disk(mc2, 2.4, 10)), 'minaret', 'dome', 10]);
  }
  const placed = out.buildings.map((b) => b.poly);
  if (!parts.every(([p]) => fits(P, p, 0.6) && !placed.some((o) => overlap(o, p)))) return false;
  if (court && !(fits(P, court, 0.5) && !placed.some((o) => overlap(o, court)))) return mosque(out, P, c, s, false, parcel);
  for (const [poly, arch, roof, storeys] of parts) out.buildings.push({ poly, kind: 'landmark', parcel, arch, roof, material: big ? 'stone' : 'wood', storeys, orientation: ang });
  const dome = orientPos(disk(c, h * 0.82, 18));
  out.lines.push({ kind: 'dome', path: dome.concat([dome[0]]), width: 0.6 });
  // the portico's small domes
  for (let k = 0; k < 5; k++) {
    const v = -h + (s * (k + 0.5)) / 5;
    const q = { x: c.x + Math.cos(ang) * (-h - s * 0.14) - Math.sin(ang) * v, y: c.y + Math.sin(ang) * (-h - s * 0.14) + Math.cos(ang) * v };
    const d = orientPos(disk(q, Math.min(s * 0.09, s * 0.12), 8));
    out.lines.push({ kind: 'dome', path: d.concat([d[0]]), width: 0.35 });
  }
  if (court) {
    // the avlu: arcades on three sides, the şadırvan (ablution fountain) in the middle
    const cu0 = -h - s * 0.28 - s * 1.1, cu1 = -h - s * 0.28 - 0.01, w = Math.max(3, s * 0.12);
    for (const r of [R(cu0, cu0 + w, -h * 1.05, h * 1.05), R(cu0 + w + 0.01, cu1, -h * 1.05, -h * 1.05 + w), R(cu0 + w + 0.01, cu1, h * 1.05 - w, h * 1.05)]) {
      if (!out.buildings.some((b) => overlap(b.poly, r))) out.buildings.push({ poly: r, kind: 'landmark', parcel, arch: 'avlu-arcade', roof: 'dome', material: 'stone', storeys: 1 });
    }
    const sc = { x: c.x + Math.cos(ang) * ((cu0 + cu1) / 2 + w / 2), y: c.y + Math.sin(ang) * ((cu0 + cu1) / 2 + w / 2) };
    const sad = orientPos(Array.from({ length: 8 }, (_, k) => ({ x: sc.x + Math.cos((k / 8) * Math.PI * 2) * 2.4, y: sc.y + Math.sin((k / 8) * Math.PI * 2) * 2.4 })));
    out.buildings.push({ poly: sad, kind: 'landmark', parcel, arch: 'sadirvan', roof: 'dome', material: 'stone', storeys: 1 });
  }
  return true;
}

/** The mescit of a mahalle: the small domed (or wooden hipped) mosque, its fountain (çeşme) and a few graves. */
function mescit(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'church' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const ins = inscribed(P, [], 0.5);
  for (let s = Math.min(15, ins.r * 1.1); s >= 6; s *= 0.88) if (mosque(out, P, ins.c, s, false)) { out.landmarks.push({ kind: 'mescit', poly: out.buildings[0].poly }); break; }
  void cx;
  return out;
}

/**
 * Külliye: the mosque with its court in the middle of the precinct, the madrasa (cells round a court, the domed
 * classroom), the imaret (soup kitchen) and the hammam on the sides, the founder's türbe behind the qibla wall.
 */
function kulliye(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'compound:kulliye' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const ins = inscribed(P, [], 1);
  const ang = QIBLA_TR;
  let s0 = 0;
  for (let s = Math.min(34, ins.r * 0.55); s >= 9; s *= 0.9) {
    // the mosque and its court lie along the qibla axis: shift back so the court has room
    const c = { x: ins.c.x + Math.cos(ang) * s * 0.75, y: ins.c.y + Math.sin(ang) * s * 0.75 };
    if (mosque(out, P, c, s, true)) { s0 = s; out.landmarks.push({ kind: 'kulliye', poly: out.buildings[0].poly }); break; }
  }
  if (!s0) return mescit(lot, cx);
  const placed = () => out.buildings.map((b) => b.poly);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const at = (u: number, v: number): Vec2 => ({ x: ins.c.x + ca * u - sa * v, y: ins.c.y + sa * u + ca * v });
  const tryAdd = (parts: [Polygon, string, B['roof'], number][], label: string): boolean => {
    if (!parts.every(([p]) => fits(P, p, 1) && !placed().some((o) => overlap(o, p)))) return false;
    for (const [poly, arch, roof, storeys] of parts) out.buildings.push({ poly, kind: 'landmark', parcel: 0, arch, roof, material: 'stone', storeys, orientation: ang });
    out.landmarks.push({ kind: label, poly: parts[0][0] });
    return true;
  };
  // the madrasa: a U of cells round its court with the domed classroom (dershane) closing it, on one side
  const ms = Math.max(14, s0 * 0.9);
  for (const sv of [1, -1]) {
    let ok = false;
    for (const off of [1.35, 1.6, 1.9]) {
      const c = at(0, sv * s0 * off);
      const R = (u0: number, u1: number, v0: number, v1: number) => rectAt(c, ang, u0, u1, v0, v1);
      const d = Math.max(4.5, ms * 0.22), hm = ms / 2;
      if (tryAdd([[R(-hm, hm, -hm, -hm + d), 'madrasa-cells', 'dome', 1], [R(-hm, hm, hm - d, hm), 'madrasa-cells', 'dome', 1], [R(-hm, -hm + d, -hm + d + 0.01, hm - d - 0.01), 'madrasa-cells', 'dome', 1], [R(hm - d * 1.6, hm, -hm * 0.45, hm * 0.45), 'dershane', 'dome', 1]], 'madrasa')) { ok = true; break; }
    }
    if (ok) {
      // the imaret and the hammam on the other side
      for (const off of [1.3, 1.6, 1.9]) {
        const c = at(-s0 * 0.4, -sv * s0 * off);
        const R = (u0: number, u1: number, v0: number, v1: number) => rectAt(c, ang, u0, u1, v0, v1);
        const hi = Math.max(7, s0 * 0.45);
        if (tryAdd([[R(-hi, hi, -hi * 0.6, hi * 0.6), 'imaret', 'dome', 1]], 'imaret')) break;
      }
      for (const off of [1.3, 1.6]) {
        const c = at(s0 * 0.9, -sv * s0 * off);
        const hh = Math.max(5, s0 * 0.32);
        if (tryAdd([[rectAt(c, ang, -hh, hh, -hh * 0.8, hh * 0.8), 'hammam', 'dome', 1]], 'hammam')) break;
      }
      break;
    }
  }
  // the founder's türbe (an octagon) behind the qibla wall
  const tc = at(s0 * 0.75 + s0 / 2 + 6, 0);
  const tr = Math.max(3, s0 * 0.16);
  const oct = orientPos(Array.from({ length: 8 }, (_, k) => ({ x: tc.x + Math.cos(((k + 0.5) / 8) * Math.PI * 2) * tr, y: tc.y + Math.sin(((k + 0.5) / 8) * Math.PI * 2) * tr })));
  tryAdd([[oct, 'turbe', 'dome', 1]], 'turbe');
  out.lines.push({ kind: 'compound-wall', path: P, closed: true, width: 1.1 });
  return out;
}

/** The Ulu Cami: a hypostyle prayer hall under a grid of domes (3 × 4 … 4 × 5), the şadırvan under the middle one. */
function uluCami(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'compound:ulu-cami' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const o = obb(P);
  const fr = bestRect(P, QIBLA_TR, Math.max(o.hu, o.hv), Math.max(o.hu, o.hv), 1.5);
  if (!fr) return mescit(lot, cx);
  const nu = Math.max(2, Math.min(4, Math.round((2 * fr.hu) / 13))), nv = Math.max(2, Math.min(5, Math.round((2 * fr.hv) / 13)));
  const cell = Math.min((2 * fr.hu) / nu, (2 * fr.hv) / nv, 16);
  const hu = (cell * nu) / 2, hv = (cell * nv) / 2;
  const hall = rectAt(fr.c, QIBLA_TR, -hu, hu, -hv, hv);
  out.buildings.push({ poly: hall, kind: 'landmark', parcel: 0, arch: 'ulu-cami', roof: 'dome', material: 'stone', storeys: 2, orientation: QIBLA_TR });
  const ca = Math.cos(QIBLA_TR), sa = Math.sin(QIBLA_TR);
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const u = -hu + cell * (i + 0.5), v = -hv + cell * (j + 0.5);
    const d = orientPos(disk({ x: fr.c.x + ca * u - sa * v, y: fr.c.y + sa * u + ca * v }, cell * 0.4, 12));
    out.lines.push({ kind: 'dome', path: d.concat([d[0]]), width: 0.4 });
  }
  const mc = { x: fr.c.x + ca * (-hu - 2.5) - sa * (hv - 2), y: fr.c.y + sa * (-hu - 2.5) + ca * (hv - 2) };
  const m = orientPos(disk(mc, 2.2, 10));
  if (fits(P, m, 0.5)) out.buildings.push({ poly: m, kind: 'landmark', parcel: 0, arch: 'minaret', roof: 'dome', material: 'stone', storeys: 10 });
  out.landmarks.push({ kind: 'ulu-cami', poly: hall });
  void dist;
  return out;
}

/** The bedesten: the domed stone hall of the precious trades (2 × 3 … 2 × 4 domes), its iron gates on the axes. */
function bedesten(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'place' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const o = obb(P);
  const ang = Math.atan2(o.u.y, o.u.x);
  const fr = bestRect(P, ang, o.hu, o.hv, 2.5);
  if (!fr) return out;
  const nu = Math.max(2, Math.min(4, Math.round((2 * fr.hu) / 11))), nv = 2;
  const cell = Math.min((2 * fr.hu) / nu, (2 * fr.hv) / nv, 12);
  const hu = (cell * nu) / 2, hv = (cell * nv) / 2;
  const hall = rectAt(fr.c, ang, -hu, hu, -hv, hv);
  out.buildings.push({ poly: hall, kind: 'landmark', parcel: 0, arch: 'bedesten', roof: 'dome', material: 'stone', storeys: 1, orientation: ang });
  const ca = Math.cos(ang), sa = Math.sin(ang);
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const u = -hu + cell * (i + 0.5), v = -hv + cell * (j + 0.5);
    const d = orientPos(disk({ x: fr.c.x + ca * u - sa * v, y: fr.c.y + sa * u + ca * v }, cell * 0.38, 12));
    out.lines.push({ kind: 'dome', path: d.concat([d[0]]), width: 0.4 });
  }
  out.landmarks.push({ kind: 'bedesten', poly: hall });
  void cx;
  return out;
}

let registered = false;
export function registerOttoman(): void {
  if (registered) return;
  registered = true;
  registerBuilders({ mescit, kulliye, 'ulu-cami': uluCami, bedesten });
}
