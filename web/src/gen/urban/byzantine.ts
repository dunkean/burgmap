/**
 * Byzantine / Greek hillside town (Mystras, Monemvasia, Arta, Kastoria): the kastro (a polygonal citadel on the
 * summit, its small church, cisterns and the governor's house), the town on the slope below with its streets along
 * the contours and stepped lanes climbing between them, a small plateia with the metropolis church, many small
 * domed cross-in-square churches spread through the quarters, and a monastery (katholikon in a walled court of
 * cells) at the edge.
 */
import type { Vec2, Polygon } from '../core/geom';
import { dist } from '../core/geom';
import type { UrbanLine } from '../types';
import type { UrbanCtx } from './context';
import type { Streets } from './streets';
import type { CompoundCtx, CompoundOut } from './compounds';
import { registerBuilders } from './compounds';
import { area, orientPos, pointInRing, inscribed, obb } from '../geo/poly';
import { disk } from '../geo/offset';
import { unionS } from '../geo/bool';
import { fits, alongEdge, placeRect } from './m4/kit';
import { rectAt } from './m4/lots';

const overlap = (A: Polygon, B: Polygon): boolean => A.some((q) => pointInRing(B, q)) || B.some((q) => pointInRing(A, q));

/**
 * Cross-in-square church oriented east (local x = east, turned by `ang` ≤ ±20°): the naos square with the cross
 * arms, three apses on the east (bema, prothesis, diakonikon), the narthex (and an exonarthex on the large ones)
 * on the west; the central dome and, for a katholikon or metropolis, four corner domes (plan lines).
 */
export function crossInSquare(c: Vec2, s: number, ang: number, big: boolean): { parts: Polygon[]; domes: Polygon[] } {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const T = (u: number, v: number): Vec2 => ({ x: c.x + u * ca - v * sa, y: c.y + u * sa + v * ca });
  const rect = (u0: number, u1: number, v0: number, v1: number): Polygon => orientPos([T(u0, v0), T(u1, v0), T(u1, v1), T(u0, v1)]);
  const h = s / 2;
  const parts: Polygon[] = [rect(-h, h, -h, h)];
  const apse = (v: number, r: number): Polygon => orientPos(Array.from({ length: 9 }, (_, i) => { const t = -Math.PI / 2 + (i / 8) * Math.PI; return T(h - 0.2 + Math.cos(t) * r, v + Math.sin(t) * r); }));
  parts.push(apse(0, s * 0.2));
  parts.push(apse(-s * 0.33, s * 0.1), apse(s * 0.33, s * 0.1));
  const nx = s * (big ? 0.3 : 0.24);
  parts.push(rect(-h - nx, -h + 0.2, -h, h));
  if (big) parts.push(rect(-h - nx - s * 0.2, -h - nx + 0.2, -h * 1.05, h * 1.05));
  const domes: Polygon[] = [orientPos(disk(c, s * 0.17, 14).map((q) => q))];
  if (big) for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) domes.push(orientPos(disk(T(du * s * 0.29, dv * s * 0.29), s * 0.085, 10)));
  // the cross arms read on the roof: a cross of barrel vaults over the naos
  const u = unionS([{ outer: parts[0], holes: [] }], ...parts.slice(1).map((p) => [{ outer: p, holes: [] }]));
  return { parts: u.map((ph) => ph.outer), domes };
}

/** Axis of a church on a lot: east within ±20°, following the lot's long side. */
function eastAxis(lot: Polygon): number {
  const o = obb(lot);
  let a = Math.atan2(o.u.y, o.u.x);
  while (a > Math.PI / 4) a -= Math.PI / 2;
  while (a < -Math.PI / 4) a += Math.PI / 2;
  return Math.max(-0.35, Math.min(0.35, a));
}

/** Fits a church in a lot (largest size first) clear of the footprints already placed. */
function fitChurch(P: Polygon, c: Vec2, sMax: number, sMin: number, big: boolean, placed: Polygon[], margin: number): { parts: Polygon[]; domes: Polygon[] } | null {
  const ang = eastAxis(P);
  for (let s = sMax; s >= sMin; s *= 0.88) {
    const ch = crossInSquare(c, s, ang, big);
    if (ch.parts.every((p) => fits(P, p, margin) && !placed.some((o) => overlap(o, p)))) return ch;
  }
  return null;
}

/** A small parish church in its lot: the church set in its little yard (graves round it), domes as plan lines. */
function byzChurch(lot: Polygon, cx: CompoundCtx, big = false): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'church' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const ins = inscribed(P, [], 0.5);
  const ch = fitChurch(P, ins.c, Math.min(big ? 24 : 13, ins.r * 0.9), 5.5, big, [], 1);
  if (!ch) return out;
  for (const p of ch.parts) out.buildings.push({ poly: p, kind: 'landmark', parcel: 0, arch: big ? 'metropolis-church' : 'cross-in-square-church', roof: 'dome', material: 'stone', storeys: 1, orientation: eastAxis(P) });
  for (const d of ch.domes) out.lines.push({ kind: 'dome', path: d.concat([d[0]]), width: 0.5 });
  out.landmarks.push({ kind: big ? 'metropolis-church' : 'byzantine-church', poly: ch.parts[0] });
  // the metropolis: the bishop's house along the lot's longest side, the paved court before the church
  if (big) {
    let bi = 0, bl = 0;
    for (let i = 0; i < P.length; i++) { const l = dist(P[i], P[(i + 1) % P.length]); if (l > bl) { bl = l; bi = i; } }
    const r = alongEdge(P, bi, cx.rng.range(7, 9), Math.min(bl * 0.6, 30), 1);
    if (r && !ch.parts.some((p) => overlap(p, r))) out.buildings.push({ poly: r, kind: 'landmark', parcel: 0, arch: 'episkopeion', roof: 'tiled-hip', material: 'stone', storeys: 2 });
  }
  return out;
}

/**
 * Monastery (Pantanassa, Brontochion, Hosios Loukas): the walled court, ranges of cells along its walls, the
 * katholikon free-standing in the middle, the refectory (trapeza) opposite its west door, a phiale (fountain).
 */
function byzMonastery(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'compound:byz-monastery' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const ins = inscribed(P, [], 1);
  if (ins.r < 12) return byzChurch(lot, cx);
  const placed: Polygon[] = [];
  const add = (poly: Polygon | null, arch: string, roof: CompoundOut['buildings'][number]['roof'], storeys: number) => {
    if (!poly || placed.some((o) => overlap(o, poly))) return false;
    placed.push(poly);
    out.buildings.push({ poly, kind: 'landmark', parcel: 0, arch, roof, material: 'stone', storeys });
    return true;
  };
  // cell ranges along the walls (long sides first), the corners left open
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    const L = dist(a, b);
    if (L < 18) continue;
    add(alongEdge(P, i, cx.rng.range(5.5, 7), L - 14, 1), 'monastic-cells', 'tiled-hip', 2);
  }
  const ch = fitChurch(P, ins.c, Math.min(20, ins.r * 0.65), 7, true, placed, 3);
  if (ch) {
    for (const p of ch.parts) { placed.push(p); out.buildings.push({ poly: p, kind: 'landmark', parcel: 0, arch: 'katholikon', roof: 'dome', material: 'stone', storeys: 1 }); }
    for (const d of ch.domes) out.lines.push({ kind: 'dome', path: d.concat([d[0]]), width: 0.5 });
    out.landmarks.push({ kind: 'katholikon', poly: ch.parts[0] });
    // the trapeza west of the katholikon, the phiale between them
    const ang = eastAxis(P);
    const s = Math.sqrt(area(ch.parts[0])) * 0.9;
    const w = { x: ins.c.x - Math.cos(ang) * (s * 1.6 + 6), y: ins.c.y - Math.sin(ang) * (s * 1.6 + 6) };
    add(placeRect(P, w, ang + Math.PI / 2, Math.min(14, s * 0.8), 4.5, 2), 'trapeza', 'gable', 1);
    const ph = orientPos(disk({ x: ins.c.x - Math.cos(ang) * (s * 0.95 + 2.5), y: ins.c.y - Math.sin(ang) * (s * 0.95 + 2.5) }, 1.8, 8));
    if (fits(P, ph, 1)) add(ph, 'phiale', 'dome', 1);
  }
  out.lines.push({ kind: 'compound-wall', path: P, closed: true, width: 1.2 });
  return out;
}

/** Inside the kastro: the church, two or three cisterns, the governor's house and barracks along the curtains. */
export function kastroInterior(Cin: Polygon, out: CompoundOut, parcel: number, gate: Vec2, rng: CompoundCtx['rng']): void {
  const P = orientPos(Cin);
  const ins = inscribed(P, [], 1);
  const placed: Polygon[] = out.buildings.map((b) => b.poly);
  const add = (poly: Polygon | null, arch: string, roof: CompoundOut['buildings'][number]['roof'], storeys: number): boolean => {
    if (!poly || placed.some((o) => overlap(o, poly)) || !fits(P, poly, 1.5)) return false;
    placed.push(poly);
    out.buildings.push({ poly, kind: 'landmark', parcel, arch, roof, material: 'stone', storeys });
    return true;
  };
  const ch = fitChurch(P, ins.c, Math.min(14, ins.r * 0.35), 6, false, placed, 3);
  if (ch) {
    for (const p of ch.parts) { placed.push(p); out.buildings.push({ poly: p, kind: 'landmark', parcel, arch: 'kastro-church', roof: 'dome', material: 'stone', storeys: 1 }); }
    for (const d of ch.domes) out.lines.push({ kind: 'dome', path: d.concat([d[0]]), width: 0.5 });
  }
  // the cisterns: vaulted tanks sunk in the rock (low flat roofs) on the far side from the gate
  const away = { x: ins.c.x - gate.x, y: ins.c.y - gate.y };
  const al = Math.hypot(away.x, away.y) || 1;
  const ang = Math.atan2(away.y, away.x);
  let nC = 0;
  for (const [k, side] of [[0.55, -0.5], [0.55, 0.5], [0.25, 1]] as [number, number][]) {
    const c = { x: ins.c.x + (away.x / al) * ins.r * k - (away.y / al) * side * ins.r * 0.45, y: ins.c.y + (away.y / al) * ins.r * k + (away.x / al) * side * ins.r * 0.45 };
    if (add(rectAt(c, ang, -5, 5, -3, 3), 'cistern', 'barrel', 1)) nC++;
    if (nC >= 2 && ins.r < 40) break;
  }
  if (nC) out.landmarks.push({ kind: 'cistern', poly: placed[placed.length - 1] });
  // the governor's house (kephale) and barracks along the longest curtains away from the gate
  const edges = P.map((a, i) => ({ i, L: dist(a, P[(i + 1) % P.length]), m: { x: (a.x + P[(i + 1) % P.length].x) / 2, y: (a.y + P[(i + 1) % P.length].y) / 2 } }))
    .filter((e) => e.L > 22 && dist(e.m, gate) > e.L * 0.4).sort((a, b) => b.L - a.L);
  edges.slice(0, 3).forEach((e, j) => add(alongEdge(P, e.i, rng.range(8, 11), Math.min(e.L - 10, j === 0 ? 34 : 26), 1.5), j === 0 ? 'governors-house' : 'barracks', j === 0 ? 'tiled-hip' : 'gable', j === 0 ? 3 : 1));
}

/**
 * Stepped lanes: on the lanes that climb the slope (heading within 40° of the fall line, grade > 8 %), stair treads
 * across the lane every ~1.6 m (drawn as hachure strokes, like the terraces of a hold).
 */
export function stairLanes(ctx: UrbanCtx, streets: Streets): UrbanLine[] {
  const out: UrbanLine[] = [];
  for (const st of streets.list) {
    if (!st.ribbon || st.rank < 2 || st.path.length < 2) continue;
    const w = st.widths.reduce((a, b) => a + b, 0) / st.widths.length;
    for (let i = 1; i < st.path.length; i++) {
      const a = st.path[i - 1], b = st.path[i];
      const L = dist(a, b);
      if (L < 3) continue;
      const dh = Math.abs(ctx.heightAt(b) - ctx.heightAt(a));
      if (dh / L < 0.08) continue;
      const t = { x: (b.x - a.x) / L, y: (b.y - a.y) / L }, n = { x: -t.y, y: t.x };
      const hw = w / 2 - 0.35;
      for (let s = 0.8; s < L - 0.5; s += 1.6) {
        const p = { x: a.x + t.x * s, y: a.y + t.y * s };
        out.push({ kind: 'hachure', path: [{ x: p.x - n.x * hw, y: p.y - n.y * hw }, { x: p.x + n.x * hw, y: p.y + n.y * hw }], width: 0.25 });
      }
    }
  }
  return out;
}

let registered = false;
export function registerByzantine(): void {
  if (registered) return;
  registered = true;
  registerBuilders({ 'byz-church': (l, c) => byzChurch(l, c), 'byz-metropolis': (l, c) => byzChurch(l, c, true), 'byz-monastery': byzMonastery });
}
