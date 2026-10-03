/**
 * Hanseatic town (Lübeck, Stralsund, Wismar, Rostock): parallel rib streets running down from the ridge to the
 * harbour, crossed by a few long streets along the ridge; the market with the town hall (an L of brick halls with
 * the arcades and the show gable) and the brick hall church beside it (twin west towers, the choir with its
 * ambulatory); gabled narrow deep merchant houses (Dielenhaus) with their rear wings, the Gänge (alleys through the
 * front houses to rows of one-room cottages in the back yards), warehouses along the quay.
 */
import type { Vec2, Polygon } from '../core/geom';
import { dist } from '../core/geom';
import type { CompoundCtx, CompoundOut } from './compounds';
import { registerBuilders } from './compounds';
import { orientPos, pointInRing, inscribed, obb } from '../geo/poly';
import { unionS } from '../geo/bool';
import { fits, alongEdge } from './m4/kit';
import { rectAt } from './m4/lots';

/** Church axis on a lot: east within ±20°, along the lot's long side. */
function eastAxis(lot: Polygon): number {
  const o = obb(lot);
  let a = Math.atan2(o.u.y, o.u.x);
  while (a > Math.PI / 4) a -= Math.PI / 2;
  while (a < -Math.PI / 4) a += Math.PI / 2;
  return Math.max(-0.35, Math.min(0.35, a));
}

/**
 * Brick Gothic hall church (Marienkirche): the three-aisled hall, the choir closed by a polygonal ambulatory on the
 * east, the twin towers of the west front; one footprint.
 */
export function hallChurchFootprint(c: Vec2, L: number, ang: number): Polygon[] {
  const W = L * 0.36;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const T = (u: number, v: number): Vec2 => ({ x: c.x + u * ca - v * sa, y: c.y + u * sa + v * ca });
  const rect = (u0: number, u1: number, v0: number, v1: number): Polygon => orientPos([T(u0, v0), T(u1, v0), T(u1, v1), T(u0, v1)]);
  const hall = rect(-L * 0.38, L * 0.22, -W / 2, W / 2);
  const choir = rect(L * 0.22 - 0.1, L * 0.36, -W * 0.42, W * 0.42);
  // the ambulatory: a half decagon round the choir end
  const amb = orientPos(Array.from({ length: 7 }, (_, k) => { const t = -Math.PI / 2 + (k / 6) * Math.PI; return T(L * 0.36 + Math.cos(t) * W * 0.42, Math.sin(t) * W * 0.42); }));
  const tw = W * 0.34;
  const towers = [rect(-L * 0.5, -L * 0.38 + 0.1, -W / 2, -W / 2 + tw), rect(-L * 0.5, -L * 0.38 + 0.1, W / 2 - tw, W / 2)];
  const parts = [hall, choir, amb, ...towers];
  const u = unionS([{ outer: parts[0], holes: [] }], ...parts.slice(1).map((p) => [{ outer: p, holes: [] }]));
  return u.map((ph) => orientPos(ph.outer));
}

function hallChurch(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'church' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const ins = inscribed(P, [], 0.5);
  const ang = eastAxis(P);
  const big = cx.pop > 6000;
  for (let L = Math.min(big ? 100 : 60, ins.r * 2.6); L >= 24; L *= 0.9) {
    const fp = hallChurchFootprint(ins.c, L, ang);
    if (!fp.every((p) => fits(P, p, 2))) continue;
    for (const p of fp) out.buildings.push({ poly: p, kind: 'church', parcel: 0, arch: 'brick-hall-church', roof: 'gable', material: 'brick', storeys: 3, orientation: ang });
    out.landmarks.push({ kind: 'hall-church', poly: fp[0] });
    break;
  }
  return out;
}

/**
 * The town hall (Rathaus): an L of brick halls along the lot's two longest sides (the market side first), the
 * arcade (Laube) and the show gable on the market, the court behind.
 */
function rathaus(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'compound:rathaus' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const edges = P.map((a, i) => ({ i, L: dist(a, P[(i + 1) % P.length]) })).filter((e) => e.L > 16).sort((a, b) => b.L - a.L);
  const placed: Polygon[] = [];
  const overlap = (A: Polygon, B: Polygon): boolean => A.some((q) => pointInRing(B, q)) || B.some((q) => pointInRing(A, q));
  for (const [j, e] of edges.slice(0, 2).entries()) {
    const r = alongEdge(P, e.i, cx.rng.range(11, 14), Math.min(e.L - 4, j === 0 ? 60 : 40), 0.5);
    if (r && !placed.some((q) => overlap(q, r))) {
      placed.push(r);
      out.buildings.push({ poly: r, kind: 'landmark', parcel: 0, arch: j === 0 ? 'rathaus' : 'rathaus-wing', roof: 'gable', material: 'brick', storeys: 3 });
    }
  }
  if (placed.length) out.landmarks.push({ kind: 'rathaus', poly: placed[0] });
  return out;
}

let registered = false;
export function registerHanse(): void {
  if (registered) return;
  registered = true;
  registerBuilders({ 'hall-church': hallChurch, rathaus });
}
