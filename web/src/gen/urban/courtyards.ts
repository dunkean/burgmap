/**
 * Courtyard / compound plots (URBAN_GEOMETRY.md §3.3): recursive OBB splitting (Vanegas 2012, OBB method)
 * constrained by access. A block is cut near the middle of its oriented bounding box, perpendicular to the long
 * axis (then the short axis), with a small random tilt for irregular fabrics; a cut is accepted only if both halves
 * keep ≥ 3.5 m of frontage on a street or a dead end (slits count: they are streets of role 'close'), are wide
 * enough and have no sharp corners. Splitting stops in the zone's lot-area range: medina houses 80–400 m², domus
 * 250–700 m², samurai yashiki 900–2600 m², elven glades. Lots are compact (aspect < 2), inward-facing.
 */
import type { Vec2, Polygon } from '../core/geom';
import { dist } from '../core/geom';
import type { Rng } from '../core/rng';
import type { MorphologyParams, Zone } from './morphology';
import type { Streets } from './streets';
import type { Plot, PlotResult } from './plots';
import { area, obb, orientPos, distToSeg, interiorAngle, segSegT, pointInRing, isSimple, inscribed } from '../geo/poly';
import { stitchUnion } from '../geo/stitch';
import { splitByChord, lpoly } from '../geo/split';
import { shapeOf } from './buildings';

interface FEdge { a: Vec2; b: Vec2; rank: number }

/** Block edges that front a street (or a dead end), with the street rank. */
export function frontageEdges(B: Polygon, streets: Streets): FEdge[] {
  const out: FEdge[] = [];
  const n = B.length;
  for (let i = 0; i < n; i++) {
    const a = B[i], b = B[(i + 1) % n];
    const l = dist(a, b);
    if (l < 0.5) continue;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const ns = streets.nearest(m, 14);
    if (!ns) continue;
    const tol = Math.max(0.8, 0.3 * ns.hw);
    if (!(Math.abs(ns.d - ns.hw) < tol || (ns.d < ns.hw * 1.3 && ns.d > ns.hw * 0.7))) continue;
    // the street lies on the outer side of the edge
    const o = { x: (b.y - a.y) / l, y: -(b.x - a.x) / l };
    const q = { x: m.x + o.x * ns.d, y: m.y + o.y * ns.d };
    if (!streets.nearest(q, ns.hw + 1.5)) continue;
    out.push({ a, b, rank: streets.list[ns.s].rank });
  }
  return out;
}

/** Length of the boundary of X lying on the frontage edges. */
function frontLen(X: Polygon, F: FEdge[]): { len: number; best: [Vec2, Vec2] | null; rank: number } {
  let len = 0, bl = 0, best: [Vec2, Vec2] | null = null, rank = 9;
  for (let i = 0; i < X.length; i++) {
    const a = X[i], b = X[(i + 1) % X.length];
    const l = dist(a, b);
    if (l < 0.3) continue;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    for (const f of F) {
      if (distToSeg(m, f.a, f.b) < 0.05 && distToSeg(a, f.a, f.b) < 0.05 && distToSeg(b, f.a, f.b) < 0.05) {
        len += l;
        if (l > bl) { bl = l; best = [a, b]; rank = f.rank; }
        break;
      }
    }
  }
  return { len, best, rank };
}

/** The chord of Q along the line through p with direction d (the boundary crossings bracketing p). */
function chordThrough(Q: Polygon, p: Vec2, d: Vec2): [Vec2, Vec2] | null {
  const far = 1e4;
  const a = { x: p.x - d.x * far, y: p.y - d.y * far }, b = { x: p.x + d.x * far, y: p.y + d.y * far };
  const ts: number[] = [];
  for (let i = 0; i < Q.length; i++) {
    const r = segSegT(a, b, Q[i], Q[(i + 1) % Q.length]);
    if (r) ts.push(r.t);
  }
  ts.sort((x, y) => x - y);
  let lo = -1, hi = -1;
  for (const t of ts) { if (t < 0.5) lo = t; else if (hi < 0) hi = t; }
  if (lo < 0 || hi < 0) return null;
  const at = (t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  return [at(lo), at(hi)];
}

const minAng = (p: Polygon) => { let m = Infinity; for (let i = 0; i < p.length; i++) m = Math.min(m, interiorAngle(p, i)); return m; };

export function cutCourtyards(block: Polygon, bi: number, zone: Zone, P: MorphologyParams, streets: Streets, rng: Rng): PlotResult {
  const B = orientPos(block);
  const F = frontageEdges(B, streets);
  const [amin, amax] = P.houseArea[zone];
  const tiltMax = P.streetOp === 'grid' ? 0 : (8 * Math.PI) / 180;
  const minW = Math.max(6, Math.sqrt(amin) * 0.55);
  const done: Polygon[] = [];
  const queue: Polygon[] = [B];
  let guard = 0;
  while (queue.length && guard++ < 4000) {
    const Q = queue.pop()!;
    const A = area(Q);
    const target = amin * Math.pow(amax / amin, rng.float());
    if (A <= target * 1.3) { done.push(Q); continue; }
    const ob = obb(Q);
    let best: [Polygon, Polygon] | null = null, bs = Infinity;
    for (const [axis, half, pen] of [[ob.u, ob.hu, 0], [ob.v, ob.hv, 0.35]] as [Vec2, number, number][]) {
      for (const t of [0.5, 0.43, 0.57, 0.36, 0.64]) {
        const tilt = rng.range(-tiltMax, tiltMax);
        const c = { x: ob.c.x + axis.x * (t - 0.5) * 2 * half, y: ob.c.y + axis.y * (t - 0.5) * 2 * half };
        if (!pointInRing(Q, c)) continue;
        // cut direction: perpendicular to the axis, tilted
        const px = -axis.y, py = axis.x;
        const d = { x: px * Math.cos(tilt) - py * Math.sin(tilt), y: px * Math.sin(tilt) + py * Math.cos(tilt) };
        const ch = chordThrough(Q, c, d);
        if (!ch || dist(ch[0], ch[1]) < 3) continue;
        const res = splitByChord(lpoly(Q, 0), ch, 0);
        if (!res) continue;
        const [X, Y] = [res[0].pts, res[1].pts];
        const aX = area(X), aY = area(Y);
        if (Math.min(aX, aY) < amin * 0.55) continue;
        if (frontLen(X, F).len < 3.5 || frontLen(Y, F).len < 3.5) continue;
        if (shapeOf(X).w < minW || shapeOf(Y).w < minW) continue;
        if (minAng(X) < 0.35 || minAng(Y) < 0.35) continue;
        // courtyard lots are compact (inward-facing houses), not deep strips
        const sX = shapeOf(X), sY = shapeOf(Y);
        if (Math.max(sX.asp, sY.asp) > 4.5) continue;
        const sc = Math.abs(aX - aY) / A + pen + Math.abs(t - 0.5) + 0.3 * (Math.max(0, sX.asp - 2) + Math.max(0, sY.asp - 2));
        if (sc < bs) { bs = sc; best = [X, Y]; }
      }
      if (best) break;
    }
    if (!best) { done.push(Q); continue; }
    queue.push(best[0], best[1]);
  }
  const plots: Plot[] = [];
  const back: Polygon[] = [];
  let order = 0;
  for (const Q of done) {
    const fl = frontLen(Q, F);
    if (!fl.best || fl.len < 3) { back.push(Q); continue; }
    const [fa, fb] = fl.best;
    const W = dist(fa, fb);
    const t = { x: (fb.x - fa.x) / W, y: (fb.y - fa.y) / W };
    // inward normal (split pieces do not keep the block's orientation: test it)
    let nrm = { x: -t.y, y: t.x };
    const probe = { x: (fa.x + fb.x) / 2 + nrm.x * 0.3, y: (fa.y + fb.y) / 2 + nrm.y * 0.3 };
    if (!pointInRing(Q, probe)) nrm = { x: -nrm.x, y: -nrm.y };
    let D = 0;
    for (const q of Q) D = Math.max(D, (q.x - fa.x) * nrm.x + (q.y - fa.y) * nrm.y);
    plots.push({
      poly: Q, block: bi, zone, front: [fa, fb], nrm, sideA: { p: fa, d: nrm }, sideB: { p: fb, d: nrm },
      rank: fl.rank, depth: D, wide: false, sideFronts: [], run: 0, order: order++,
    });
  }
  // final guarantee (URBAN_GEOMETRY §6.3), as the checker measures it: ≥ 3 m of boundary on a street ribbon edge;
  // other lots join the neighbouring lot sharing the longest edge, or become back land
  const onStreet = (q: Vec2): boolean => {
    const ns = streets.nearest(q, 12);
    return !!ns && (Math.abs(ns.d - ns.hw) < Math.max(0.5, 0.25 * ns.hw) || ns.d < ns.hw);
  };
  const ribbonLen = (X: Polygon): number => {
    let L = 0;
    for (let k = 0; k < X.length && L < 3.3; k++) {
      const a = X[k], b = X[(k + 1) % X.length];
      const le = dist(a, b), m = Math.max(1, Math.ceil(le / 0.5));
      for (let j = 0; j < m; j++) { const t = (j + 0.5) / m; if (onStreet({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) L += le / m; }
    }
    return L;
  };
  const sharedLen = (X: Polygon, Y: Polygon): number => {
    let s2 = 0;
    for (let k = 0; k < X.length; k++) {
      const a = X[k], b = X[(k + 1) % X.length];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      for (let j = 0; j < Y.length; j++) if (distToSeg(m, Y[j], Y[(j + 1) % Y.length]) < 0.05) { s2 += dist(a, b); break; }
    }
    return s2;
  };
  // (a lot narrower than 2.2 m, a sliver along a block edge, joins its neighbour too)
  const okF = plots.map((p) => ribbonLen(p.poly) >= 3.3 && inscribed(p.poly, [], 0.1).r * 2 >= 2.2);
  for (let i = 0; i < plots.length; i++) {
    if (okF[i] || !plots[i]) continue;
    let best = -1, bl = 0;
    for (let j = 0; j < plots.length; j++) {
      if (j === i || !plots[j] || !okF[j]) continue;
      const sh = sharedLen(plots[i].poly, plots[j].poly);
      if (sh > bl) { bl = sh; best = j; }
    }
    const merged = best >= 0 ? stitchUnion(plots[best].poly, plots[i].poly) : null;
    if (merged && isSimple(merged)) plots[best].poly = merged;
    else back.push(plots[i].poly);
    (plots as (Plot | null)[])[i] = null;
  }
  return { plots: plots.filter((p): p is Plot => !!p), back };
}
