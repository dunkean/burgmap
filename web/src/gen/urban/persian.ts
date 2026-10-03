/**
 * Persian city (Isfahan, Yazd, Kashan, Herat): the maidan (a vast rectangular square ringed by two-storey arcades
 * of shops, a pool in its middle), the covered bazaar spine running from it through the old town (a vaulted street
 * under a file of small domes), caravanserais by the bazaar and at the gates, the Friday mosque with its four iwans
 * round the court and the dome chamber behind the qibla iwan, the palace on the maidan, chahar-bagh gardens
 * (quartered by water channels, the pavilion in the middle) and the qanat lines that bring the water from the
 * mountain foot (shaft mouths in a file across the plain). Houses are mud-brick courtyard houses.
 */
import type { Vec2, Polygon, Polyline } from '../core/geom';
import { dist } from '../core/geom';
import type { Rng } from '../core/rng';
import type { UrbanLine } from '../types';
import type { UrbanCtx } from './context';
import type { Streets } from './streets';
import type { CompoundCtx, CompoundOut } from './compounds';
import { registerBuilders } from './compounds';
import { orientPos, pointInRing, inscribed, obb, distToRing } from '../geo/poly';
import { disk } from '../geo/offset';
import type { MultiPoly } from '../geo/bool';
import { fits, alongEdge, minus, largest } from './m4/kit';
import { rectAt, inMP } from './m4/lots';

const overlap = (A: Polygon, B: Polygon): boolean => A.some((q) => pointInRing(B, q)) || B.some((q) => pointInRing(A, q));
/** Qibla from Iran: south-west (map angle, y down). */
const QIBLA_IR = (3 * Math.PI) / 4;

/** Frame of a lot: its OBB centre, long-axis angle and half sizes. */
function frameOf(P: Polygon): { c: Vec2; ang: number; hu: number; hv: number } {
  const o = obb(P);
  return { c: o.c, ang: Math.atan2(o.u.y, o.u.x), hu: o.hu, hv: o.hv };
}

/** The largest rectangle at `ang` centred on c that fits the lot with a margin (scaled down from hu × hv). */
function fitRect(P: Polygon, c: Vec2, ang: number, hu: number, hv: number, margin: number): { r: Polygon; hu: number; hv: number } | null {
  for (let k = 1; k > 0.3; k -= 0.05) {
    const r = rectAt(c, ang, -hu * k, hu * k, -hv * k, hv * k);
    if (fits(P, r, margin)) return { r, hu: hu * k, hv: hv * k };
  }
  return null;
}

/**
 * The largest rectangle at `ang` in a lot (centre offsets on a 5 × 5 grid round the frame centre, three aspects,
 * the scale by bisection).
 */
export function bestRect(P: Polygon, ang: number, hu: number, hv: number, margin: number): { r: Polygon; c: Vec2; hu: number; hv: number } | null {
  const o = obb(P);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  let best: { r: Polygon; c: Vec2; hu: number; hv: number } | null = null;
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    const c = { x: o.c.x + ca * i * hu * 0.12 - sa * j * hv * 0.12, y: o.c.y + sa * i * hu * 0.12 + ca * j * hv * 0.12 };
    if (!pointInRing(P, c)) continue;
    for (const asp of [0.75, 1, 1.33]) {
      const a = Math.sqrt(asp);
      const at = (k: number) => rectAt(c, ang, -hu * k * a, hu * k * a, -hv * k / a, hv * k / a);
      let lo = 0, hi = 1;
      if (fits(P, at(1), margin)) lo = 1;
      else for (let it = 0; it < 7; it++) { const m = (lo + hi) / 2; if (fits(P, at(m), margin)) lo = m; else hi = m; }
      if (lo < 0.2) continue;
      const A = hu * hv * lo * lo;
      if (!best || A > best.hu * best.hv) best = { r: at(lo), c, hu: hu * lo * a, hv: hv * lo / a };
    }
  }
  return best;
}

/**
 * The maidan: the open square; arcades of shops (two storeys, 7–9 m deep) along its four sides with gateways at the
 * middles of the long sides and the bazaar portal (qeysarie) in the middle of one short side; the long pool.
 */
function maidan(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'place' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const f = frameOf(P);
  const d = Math.max(6, Math.min(9, f.hv * 0.16));
  const placed: Polygon[] = [];
  const add = (poly: Polygon | null, arch: string, storeys: number, roof: CompoundOut['buildings'][number]['roof'] = 'flat') => {
    if (!poly || placed.some((o) => overlap(o, poly))) return;
    placed.push(poly);
    out.buildings.push({ poly, kind: 'landmark', parcel: 0, arch, roof, material: 'brick', storeys });
  };
  // the arcades stand on the largest rectangle of the square (the rounded corners of the lot stay paved)
  // the arcades follow the square's sides (a continuous arcade broken by the gateways), stopping short of the
  // corners; the bazaar portal (qeysarie) and the palace gate stand in the middles of the two longest sides
  const fr = bestRect(P, f.ang, f.hu, f.hv, 0.4);
  const order = P.map((_, i) => i).sort((x, y) => dist(P[(y + 1) % P.length], P[y]) - dist(P[(x + 1) % P.length], P[x]));
  const portal = new Map<number, string>([[order[0], 'qeysarie-portal'], [order[1], 'ali-qapu']]);
  for (let i = 0; i < P.length; i++) {
    const L = dist(P[i], P[(i + 1) % P.length]);
    if (L < 22) continue;
    const span = L - 2 * (d + 1.5);
    if (L >= 46) {
      const half = (span - 12) / 2;
      if (half >= 8) {
        add(alongEdge(P, i, d, half, 0.4, (d + 1.5 + half / 2) / L), 'maidan-arcade', 2);
        add(alongEdge(P, i, d, half, 0.4, 1 - (d + 1.5 + half / 2) / L), 'maidan-arcade', 2);
      }
      const pk = portal.get(i);
      if (pk) add(alongEdge(P, i, d + 5, 11, 0.4), pk, 4);
    } else if (span >= 8) add(alongEdge(P, i, d, span, 0.4), 'maidan-arcade', 2);
  }
  // the pool down the long axis
  const pool = fitRect(P, fr ? fr.c : f.c, f.ang, (fr ? fr.hu : f.hu) * 0.4, Math.min(6, f.hv * 0.12), d + 10);
  if (pool) { out.water.push(pool.r); out.landmarks.push({ kind: 'maidan-pool', poly: pool.r }); }
  out.landmarks.push({ kind: 'maidan', poly: P });
  void cx;
  return out;
}

/**
 * The Friday mosque: the court (sahn) with an iwan in the middle of each side, arcaded riwaqs between them, the
 * dome chamber behind the qibla iwan with its two minarets, the ablution pool in the court.
 */
function fridayMosque(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'compound:friday-mosque' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const ins = inscribed(P, [], 1);
  // the court is turned to the qibla (south-west): u points to the qibla
  const ang = QIBLA_IR;
  let fr: { r: Polygon; hu: number; hv: number } | null = null;
  for (let s = Math.min(70, ins.r * 1.15); s >= 16 && !fr; s *= 0.9) fr = fitRect(P, ins.c, ang, s, s * 0.82, 1);
  if (!fr) return out;
  const { hu, hv } = fr;
  const c = ins.c;
  const R = (u0: number, u1: number, v0: number, v1: number) => rectAt(c, ang, u0, u1, v0, v1);
  const dr = Math.max(4.5, Math.min(9, hu * 0.16));
  // the dome chamber (maqsura) behind the qibla iwan: a square hall
  const dq = Math.max(8, Math.min(24, hv * 0.42));
  const qib = R(hu - dq * 1.6, hu, -dq * 0.8, dq * 0.8);
  // the four iwans (deep vaulted halls open to the court) and the riwaqs between them
  const iw = Math.max(5, hv * 0.22), id = Math.max(5, dr * 1.4);
  const parts: [Polygon, string, number][] = [
    [qib, 'dome-chamber', 2],
    [R(hu - dq * 1.6 - id, hu - dq * 1.6 - 0.01, -iw / 2, iw / 2), 'qibla-iwan', 3],
    [R(-hu, -hu + id, -iw / 2, iw / 2), 'iwan', 3],
    [R(-iw / 2, iw / 2, -hv, -hv + id), 'iwan', 2],
    [R(-iw / 2, iw / 2, hv - id, hv), 'iwan', 2],
  ];
  // riwaqs along the four sides, interrupted by the iwans
  const g = 0.6;
  parts.push([R(-hu, -iw / 2 - g, -hv, -hv + dr), 'riwaq', 1], [R(iw / 2 + g, hu, -hv, -hv + dr), 'riwaq', 1]);
  parts.push([R(-hu, -iw / 2 - g, hv - dr, hv), 'riwaq', 1], [R(iw / 2 + g, hu, hv - dr, hv), 'riwaq', 1]);
  parts.push([R(-hu, -hu + dr, -hv + dr + g, -iw / 2 - g), 'riwaq', 1], [R(-hu, -hu + dr, iw / 2 + g, hv - dr - g), 'riwaq', 1]);
  parts.push([R(hu - dr, hu, -hv + dr + g, -dq * 0.8 - g), 'riwaq', 1], [R(hu - dr, hu, dq * 0.8 + g, hv - dr - g), 'riwaq', 1]);
  for (const [poly, arch, st] of parts) {
    if (!fits(P, poly, 0.5) || out.buildings.some((b) => overlap(b.poly, poly))) continue;
    out.buildings.push({ poly, kind: 'landmark', parcel: 0, arch, roof: arch === 'dome-chamber' ? 'dome' : 'flat', material: 'brick', storeys: st, orientation: ang });
  }
  // the dome and the two minarets flanking the qibla iwan
  const dc = { x: c.x + Math.cos(ang) * (hu - dq * 0.8), y: c.y + Math.sin(ang) * (hu - dq * 0.8) };
  const dome = orientPos(disk(dc, dq * 0.62, 18));
  out.lines.push({ kind: 'dome', path: dome.concat([dome[0]]), width: 0.7 });
  for (const sg of [-1, 1]) {
    const mc = { x: c.x + Math.cos(ang) * (hu - dq * 1.6 - id * 0.5) - Math.sin(ang) * sg * (iw / 2 + 2.2), y: c.y + Math.sin(ang) * (hu - dq * 1.6 - id * 0.5) + Math.cos(ang) * sg * (iw / 2 + 2.2) };
    const m = orientPos(disk(mc, 1.9, 10));
    if (fits(P, m, 0.5) && !out.buildings.some((b) => overlap(b.poly, m))) out.buildings.push({ poly: m, kind: 'landmark', parcel: 0, arch: 'minaret', roof: 'dome', material: 'brick', storeys: 8 });
  }
  // the court and its ablution pool
  const sahn = R(-hu + dr, hu - dq * 1.6 - id, -hv + dr, hv - dr);
  out.landmarks.push({ kind: 'sahn', poly: sahn });
  const pool = R(-3.5, 3.5, -2.5, 2.5);
  if (fits(P, pool, 2)) out.water.push(pool);
  out.landmarks.push({ kind: 'friday-mosque', poly: qib });
  out.lines.push({ kind: 'compound-wall', path: P, closed: true, width: 1.2 });
  void cx;
  return out;
}

/**
 * Caravanserai: a square court ringed by the merchants' cells (one storey, ~6 m deep), the entrance iwan in the
 * middle of the side facing the street, stables in the corners behind the cells.
 */
function caravanserai(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'compound:caravanserai' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const ins = inscribed(P, [], 1);
  const f = frameOf(P);
  let fr: { r: Polygon; hu: number; hv: number } | null = null;
  for (let s = Math.min(45, ins.r * 1.2); s >= 12 && !fr; s *= 0.9) fr = fitRect(P, ins.c, f.ang, s, s, 1);
  if (!fr) return out;
  const { hu, hv } = fr;
  const R = (u0: number, u1: number, v0: number, v1: number) => rectAt(ins.c, f.ang, u0, u1, v0, v1);
  const d = Math.max(4.6, Math.min(7, hu * 0.22));
  const gw = 4.5;
  const ranges = [
    R(-hu, hu, -hv, -hv + d), R(-hu, -gw / 2, hv - d, hv), R(gw / 2, hu, hv - d, hv),
    R(-hu, -hu + d, -hv + d + 0.01, hv - d - 0.01), R(hu - d, hu, -hv + d + 0.01, hv - d - 0.01),
  ];
  for (const r of ranges) if (fits(P, r, 0.5)) out.buildings.push({ poly: r, kind: 'landmark', parcel: 0, arch: 'caravanserai-cells', roof: 'flat', material: 'brick', storeys: 1 });
  // the portal (pishtaq) beside the gate passage
  const portal = R(-gw / 2 - 3, -gw / 2, hv - d - 2.5, hv);
  if (fits(P, portal, 0.3) && !out.buildings.some((b) => overlap(b.poly, portal))) out.buildings.push({ poly: portal, kind: 'landmark', parcel: 0, arch: 'caravanserai-portal', roof: 'flat', material: 'brick', storeys: 2 });
  const pool = R(-2, 2, -2, 2);
  if (hu > 14) out.water.push(pool);
  out.landmarks.push({ kind: 'caravanserai', poly: R(-hu, hu, -hv, hv) });
  out.lines.push({ kind: 'compound-wall', path: P, closed: true, width: 1 });
  void cx;
  return out;
}

/**
 * Chahar-bagh: a walled garden quartered by two water channels crossing at the pavilion (an octagon, hasht behesht),
 * the four parterres planted with plane trees and fruit trees in rows.
 */
function chaharBagh(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [], buildings: [], lines: [], water: [], landmarks: [], trees: [] };
  const P = orientPos(lot);
  const ins = inscribed(P, [], 1);
  const f = frameOf(P);
  const L = 400;
  const cw = Math.max(2.4, Math.min(4.5, ins.r * 0.06));
  const chU = rectAt(ins.c, f.ang, -L, L, -cw / 2, cw / 2), chV = rectAt(ins.c, f.ang, -cw / 2, cw / 2, -L, L);
  // the channels are parcels of water (two crossing strips): the four parterres are the rest
  const quarters = minus(P, chU, chV);
  for (const q of quarters) out.parcels.push({ poly: q, use: 'green' });
  // (the channels: the lot minus the parterres, as one or more water parcels)
  const chans = minus(P, ...quarters);
  for (const c of chans) { out.parcels.push({ poly: c, use: 'tank' }); out.water.push(c); }
  if (!out.parcels.length) return { parcels: [{ poly: lot, use: 'green' }], buildings: [], lines: [], water: [], landmarks: [] };
  // the pavilion at the crossing: an octagon on its own island in the central pool
  const pv = Math.max(4, Math.min(11, ins.r * 0.16));
  const oct = orientPos(Array.from({ length: 8 }, (_, k) => ({ x: ins.c.x + Math.cos(f.ang + ((k + 0.5) / 8) * Math.PI * 2) * pv, y: ins.c.y + Math.sin(f.ang + ((k + 0.5) / 8) * Math.PI * 2) * pv })));
  // (it stands in the largest parterre corner touching the crossing: built on land, never on the water)
  const host = out.parcels.findIndex((p) => p.use === 'green' && fits(p.poly, oct, 0));
  if (host >= 0) out.buildings.push({ poly: oct, kind: 'landmark', parcel: host, arch: 'garden-pavilion', roof: 'dome', material: 'brick', storeys: 2 });
  else {
    // the pavilion in the middle of the largest parterre
    const big = largest(quarters);
    const bi = big ? out.parcels.findIndex((p) => p.poly === big) : -1;
    if (big && bi >= 0) {
      const bc = inscribed(big, [], 1);
      const o2 = orientPos(Array.from({ length: 8 }, (_, k) => ({ x: bc.c.x + Math.cos(((k + 0.5) / 8) * Math.PI * 2) * Math.min(pv, bc.r * 0.5), y: bc.c.y + Math.sin(((k + 0.5) / 8) * Math.PI * 2) * Math.min(pv, bc.r * 0.5) })));
      if (fits(big, o2, 0.5)) out.buildings.push({ poly: o2, kind: 'landmark', parcel: bi, arch: 'garden-pavilion', roof: 'dome', material: 'brick', storeys: 2 });
    }
  }
  // rows of trees in the parterres
  const tr = cx.rng;
  for (const q of quarters) {
    const o = obb(q);
    for (let u = -o.hu + 5; u <= o.hu - 5; u += 9) for (let v = -o.hv + 5; v <= o.hv - 5; v += 9) {
      const p = { x: o.c.x + o.u.x * u + o.v.x * v, y: o.c.y + o.u.y * u + o.v.y * v };
      if (pointInRing(q, p) && distToRing(q, p) > 3) out.trees!.push({ x: p.x, y: p.y, r: tr.range(2.6, 3.6) });
    }
  }
  out.landmarks.push({ kind: 'chahar-bagh', poly: P });
  out.lines.push({ kind: 'compound-wall', path: P, closed: true, width: 1.2 });
  return out;
}

/** The roofed bazaar: the main spines through the old town under a file of small domes (every ~8 m). */
export function bazaarRoofs(streets: Streets, old: MultiPoly, nucleus: Vec2): UrbanLine[] {
  const out: UrbanLine[] = [];
  // the two radials with the longest run in the old town
  const runs = streets.list.filter((s) => s.ribbon && s.role === 'radial' && s.path.length >= 2).map((s) => {
    const pts = s.path.filter((q) => inMP(old, q));
    let L = 0;
    for (let i = 1; i < s.path.length; i++) if (inMP(old, s.path[i]) && inMP(old, s.path[i - 1])) L += dist(s.path[i - 1], s.path[i]);
    return { s, L, near: pts.length ? Math.min(...pts.map((q) => dist(q, nucleus))) : Infinity };
  }).filter((r) => r.L > 40 && r.near < 120).sort((a, b) => b.L - a.L).slice(0, 1);
  for (const { s } of runs) {
    let run: Vec2[] = [];
    const flush = () => {
      if (run.length >= 2) {
        const w = s.widths[0];
        out.push({ kind: 'bazaar-roof', path: run, width: w });
        // the domes: one every 8 m along the vault
        let acc = 0;
        for (let i = 1; i < run.length; i++) {
          const a = run[i - 1], b = run[i], l = dist(a, b);
          for (let t = (8 - acc) % 8; t < l; t += 8) {
            const c = { x: a.x + ((b.x - a.x) * t) / l, y: a.y + ((b.y - a.y) * t) / l };
            const d = orientPos(disk(c, Math.min(2.2, w * 0.3), 10));
            out.push({ kind: 'dome', path: d.concat([d[0]]), width: 0.35 });
          }
          acc = (acc + l) % 8;
        }
      }
      run = [];
    };
    for (const q of s.path) { if (inMP(old, q)) run.push(q); else flush(); }
    flush();
  }
  return out;
}

/**
 * Qanats: from the mother wells at the mountain foot down to the edge of the town, a file of shaft mouths (spoil
 * rings) every ~30 m across the fields; 2–4 lines climbing the slope away from the town.
 */
export function qanats(ctx: UrbanCtx, footprint: MultiPoly, rng: Rng, n: number): UrbanLine[] {
  const out: UrbanLine[] = [];
  let big = footprint[0];
  for (const ph of footprint) if (!big || ph.outer.length > big.outer.length) big = ph;
  if (!big) return out;
  const ring = big.outer;
  const S = ctx.mapSize;
  const used: Vec2[] = [];
  for (let k = 0; k < n * 4 && out.filter((l) => l.kind === 'qanat').length < n; k++) {
    const i = rng.int(0, ring.length - 1);
    const st = ring[i];
    if (used.some((u) => dist(u, st) < 150)) continue;
    // climb: the steepest ascent of the smoothed ground, a little wandering
    const pl: Polyline = [st];
    let p = st;
    let hdg = Math.atan2(st.y - ctx.center.y, st.x - ctx.center.x);
    const L = rng.range(350, 800);
    for (let s = 0; s < L; s += 20) {
      const h0 = ctx.heightAt(p);
      let best = hdg, bh = -Infinity;
      for (const da of [-0.5, -0.25, 0, 0.25, 0.5]) {
        const a = hdg + da;
        const q = { x: p.x + Math.cos(a) * 30, y: p.y + Math.sin(a) * 30 };
        const h = ctx.heightAt(q) - Math.abs(da) * 0.3;
        if (h > bh) { bh = h; best = a; }
      }
      hdg = best + rng.range(-0.08, 0.08);
      const q = { x: p.x + Math.cos(hdg) * 20, y: p.y + Math.sin(hdg) * 20 };
      if (q.x < 10 || q.y < 10 || q.x > S - 10 || q.y > S - 10 || ctx.isWater(q) || inMP(footprint, q)) break;
      if (ctx.heightAt(q) < h0 - 1) break;
      pl.push(q);
      p = q;
    }
    if (pl.length < 8) continue;
    used.push(st);
    out.push({ kind: 'qanat', path: pl.slice().reverse(), width: 0.6 });
    for (let j = 1; j < pl.length; j += 1 + (j % 2)) { const d = orientPos(disk(pl[j], 3.6, 12)); out.push({ kind: 'qanat-shaft', path: d.concat([d[0]]), closed: true, width: 1 }); }
  }
  return out;
}

let registered = false;
export function registerPersian(): void {
  if (registered) return;
  registered = true;
  registerBuilders({ maidan, 'friday-mosque': fridayMosque, caravanserai, 'chahar-bagh': chaharBagh });
}
