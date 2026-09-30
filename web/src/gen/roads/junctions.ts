import type { Rng } from '../core/rng';
import { Vec2, Polyline, dist, polylineLength } from '../core/geom';
import {
  nearestOn, pointAt, tangentAt, lengths, insertVertex, blendEnd, rot, bezier, firstCrossing, selfIntersects,
} from '../core/pline';
import type { River } from '../types';

export interface BridgeSeg { a: Vec2; b: Vec2; width: number }

const DEG = Math.PI / 180;
const angleBetween = (a: Vec2, b: Vec2): number => {
  const l = Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y) || 1;
  return Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y) / l)));
};

const arcAt = (pl: Polyline, i: number, t: number): number => lengths(pl)[i] + t * dist(pl[i], pl[i + 1]);

export interface AttachCtx {
  wet: (p: Vec2) => boolean;
  hostBridges: BridgeSeg[];
  ownBridges: BridgeSeg[];
  rng: Rng;
  /** return null instead of a badly angled junction when no blend works (tracks) */
  strict?: boolean;
  /** acceptable approach angle to the host's forward direction (radians) */
  lo?: number;
  hi?: number;
}

/**
 * Join one end of `joiner` to `host` with a proper Y/T junction: the junction point becomes a vertex of both
 * polylines and the last stretch is bent to an acceptable angle. `host` is mutated (vertex inserted).
 */
export function attachEnd(joiner: Polyline, atStart: boolean, host: Polyline, ctx: AttachCtx, depth = 0): Polyline | null {
  const pl = atStart ? joiner.slice().reverse() : joiner.slice();
  const lo = ctx.lo ?? 35 * DEG, hi = ctx.hi ?? 145 * DEG;
  const end = pl[pl.length - 1];
  let nn = nearestOn(host, end);
  // keep the junction off the host's bridges
  const clash = (p: Vec2): boolean => ctx.hostBridges.some((b) => nearestOn([b.a, b.b], p).d < 10) || ctx.wet(p);
  if (clash(nn.pt)) {
    const s0 = arcAt(host, nn.i, nn.t), L = polylineLength(host);
    for (let k = 1; k <= 12; k++) {
      let done = false;
      for (const sg of [1, -1]) {
        const s = s0 + sg * k * 4;
        if (s < 6 || s > L - 6) continue;
        const c = pointAt(host, s).pt;
        if (!clash(c)) { nn = nearestOn(host, c); done = true; break; }
      }
      if (done) break;
    }
  }
  const vi = insertVertex(host, nn.i, nn.t, 3);
  const Jv = host[vi];
  const sJ = lengths(host)[vi];
  const th = tangentAt(host, sJ, 12);
  const cur = dist(end, Jv) <= 30 ? pl.slice(0, -1).concat([{ x: Jv.x, y: Jv.y }]) : pl.concat([{ x: Jv.x, y: Jv.y }]);
  const Lp = polylineLength(cur);
  const qPt = pointAt(cur, Math.max(0, Lp - 30)).pt;
  const app = { x: Jv.x - qPt.x, y: Jv.y - qPt.y };
  const alpha = angleBetween(app, th);
  const q12 = pointAt(cur, Math.max(0, Lp - 12)).pt;
  const alpha12 = angleBetween({ x: Jv.x - q12.x, y: Jv.y - q12.y }, th);
  let result = cur;
  const hs = lengths(host)[vi];
  const hf = pointAt(host, Math.min(polylineLength(host), hs + 12)).pt, hbk = pointAt(host, Math.max(0, hs - 12)).pt;
  const mine = { x: q12.x - Jv.x, y: q12.y - Jv.y };
  const branchAng = Math.min(angleBetween(mine, { x: hf.x - Jv.x, y: hf.y - Jv.y }), angleBetween(mine, { x: hbk.x - Jv.x, y: hbk.y - Jv.y }));
  if (branchAng < 30 * DEG || alpha < lo || alpha > hi || alpha12 < lo || alpha12 > hi) {
    const side = th.x * (qPt.y - Jv.y) - th.y * (qPt.x - Jv.x) >= 0 ? 1 : -1;
    const acute = (alpha + alpha12) / 2 < 90 * DEG;
    const base = acute ? ctx.rng.range(40, 54) : ctx.rng.range(126, 140);
    let u = rot(th, -side * base * DEG);
    const ok = (cand: Polyline): boolean => {
      if (selfIntersects(cand)) return false;
      if (firstCrossing(cand.slice(0, -1), host)) return false;
      {
        const Lc = polylineLength(cand);
        const q = pointAt(cand, Math.max(0, Lc - 12)).pt;
        const o = { x: q.x - Jv.x, y: q.y - Jv.y };
        if (angleBetween(o, { x: hf.x - Jv.x, y: hf.y - Jv.y }) < 28 * DEG || angleBetween(o, { x: hbk.x - Jv.x, y: hbk.y - Jv.y }) < 28 * DEG) return false;
      }
      // bridges of the joiner must survive
      for (const b of ctx.ownBridges) {
        const ia = cand.findIndex((q) => dist(q, b.a) < 0.3), ib = cand.findIndex((q) => dist(q, b.b) < 0.3);
        if (ia < 0 || ib < 0) return false;
        // the road still lines up with the bridge 14 m before and after it
        const axis = { x: b.b.x - b.a.x, y: b.b.y - b.a.y };
        const pre = cand.slice(0, ia + 1), post = cand.slice(ib);
        const back = pointAt(pre, Math.max(0, polylineLength(pre) - 14)).pt, fwd = pointAt(post, Math.min(polylineLength(post), 14)).pt;
        if (angleBetween({ x: b.a.x - back.x, y: b.a.y - back.y }, axis) > 24 * DEG || angleBetween({ x: fwd.x - b.b.x, y: fwd.y - b.b.y }, axis) > 24 * DEG) return false;
      }
      const L = polylineLength(cand);
      for (let s = Math.max(0, L - 120); s <= L; s += 2.5) { if (ctx.wet(pointAt(cand, s).pt) && !ctx.ownBridges.some((b) => nearestOn([b.a, b.b], pointAt(cand, s).pt).d < 3)) return false; }
      return true;
    };
    let b: Polyline | null = null;
    for (const dth of [0, 12, -12, 24, -24, 36]) {
      u = rot(th, -side * (base + (acute ? dth : -dth)) * DEG);
      for (const [lead, tail] of [[34, 12], [22, 9], [14, 6], [60, 10], [90, 8]] as [number, number][]) { b = blendEnd(cur, Jv, u, lead, ok, tail); if (b) break; }
      if (b) break;
    }
    if (b) result = b;
    else if (ctx.strict) return null;
    else if (depth < 3 && Lp > 110) {
      // the road runs along the host for a stretch: cut it back and join further up
      const keep = pl.slice(0, pl.length);
      const cutAt = Lp - 35;
      const head: Vec2[] = [];
      let acc = 0;
      for (let i = 0; i < keep.length; i++) { if (i > 0) acc += dist(keep[i - 1], keep[i]); if (acc < cutAt) head.push(keep[i]); else break; }
      head.push(pointAt(keep, cutAt).pt);
      const lost = ctx.ownBridges.some((bb) => !head.some((q) => dist(q, bb.a) < 0.3) || !head.some((q) => dist(q, bb.b) < 0.3));
      if (!lost) return attachEnd(atStart ? head.slice().reverse() : head, atStart, host, ctx, depth + 1);
    }
  }
  result[result.length - 1] = { x: Jv.x, y: Jv.y };
  return atStart ? result.slice().reverse() : result;
}

export interface BridgeCtx {
  rivers: River[];
  wet: (p: Vec2) => boolean;
  roadWidth: number;
}

function riverAt(rivers: River[], p: Vec2): { r: River; nn: ReturnType<typeof nearestOn>; w: number } | null {
  let best: { r: River; nn: ReturnType<typeof nearestOn>; w: number; score: number } | null = null;
  for (const r of rivers) {
    const nn = nearestOn(r.path, p);
    const w = Math.max(r.width[nn.i], r.width[Math.min(r.width.length - 1, nn.i + 1)]);
    const score = nn.d - w / 2;
    if (nn.d < 60 && (!best || score < best.score)) best = { r, nn, w, score };
  }
  return best;
}

/**
 * Turn every river crossing of a road into a bridge that meets the river at a right angle, starts and ends on
 * dry land and lines up with the road on both sides. Crossings of brooks narrower than `fordW` stay fords.
 */
export function bridgeRoad(path: Polyline, ctx: BridgeCtx, fordW = 3.0): { path: Polyline; bridges: BridgeSeg[] } {
  let cur = path.slice();
  const bridges: BridgeSeg[] = [];
  const handled: Vec2[] = [];
  const free = (p: Vec2, r: River, w: number): boolean => !ctx.wet(p) && nearestOn(r.path, p).d >= w / 2 + 1.4;
  for (let iter = 0; iter < 12; iter++) {
    // wet runs along the current path
    const L = polylineLength(cur);
    const runs: [number, number][] = [];
    let s = 0, open = -1, lastWet = -1;
    for (; s <= L; s += 1.5) {
      const w = ctx.wet(pointAt(cur, s).pt);
      if (w) { if (open < 0) open = s; lastWet = s; }
      else if (open >= 0 && s - lastWet > 10) { runs.push([open, lastWet]); open = -1; }
    }
    if (open >= 0) runs.push([open, lastWet]);
    let target: [number, number] | null = null;
    for (const r of runs) {
      const mid = pointAt(cur, (r[0] + r[1]) / 2).pt;
      if (bridges.some((b) => nearestOn([b.a, b.b], mid).d < 4)) continue;
      if (handled.some((h) => dist(h, mid) < 10)) continue;
      target = r; break;
    }
    if (!target) break;
    const sM = (target[0] + target[1]) / 2;
    const M = pointAt(cur, sM).pt;
    handled.push(M);
    const ri = riverAt(ctx.rivers, M);
    const wLoc = ri ? ri.w : 6;
    if (ri && wLoc < fordW && target[1] - target[0] < 12) continue; // ford over a brook
    let built: { path: Polyline; br: BridgeSeg } | null = null;
    if (ri) {
      const r = ri.r;
      const sr = arcAt(r.path, ri.nn.i, ri.nn.t);
      const Lr = polylineLength(r.path);
      for (const off of [0, 14, -14, 28, -28, 46, -46, 70, -70]) {
        if (built) break;
        const sc = sr + off;
        if (sc < 4 || sc > Lr - 4) continue;
        const C = pointAt(r.path, sc).pt;
        const thc = tangentAt(r.path, sc, 10);
        let nc = { x: -thc.y, y: thc.x };
        const nnRoad = nearestOn(cur, C);
        const sMc = arcAt(cur, nnRoad.i, nnRoad.t);
        const rdc = tangentAt(cur, sMc, 10);
        if (nc.x * rdc.x + nc.y * rdc.y < 0) nc = { x: -nc.x, y: -nc.y };
        if (off !== 0 && nnRoad.d > 70) continue;
        const nn2 = nc;
        for (let hl = wLoc / 2 + 3; hl <= wLoc / 2 + 22 && !built; hl += 2) {
          const a = { x: C.x - nn2.x * hl, y: C.y - nn2.y * hl }, b = { x: C.x + nn2.x * hl, y: C.y + nn2.y * hl };
          if (!free(a, r, wLoc) || !free(b, r, wLoc)) continue;
          for (const lead of [26, 40, 58, 80]) {
            const sP1 = Math.max(0, sMc - hl - lead), sP2 = Math.min(L, sMc + hl + lead);
            const p1 = pointAt(cur, sP1), p2 = pointAt(cur, sP2);
            const d1 = tangentAt(cur, sP1, 6), d2 = tangentAt(cur, sP2, 6);
            const tailA = { x: a.x - nn2.x * 13, y: a.y - nn2.y * 13 }, tailB = { x: b.x + nn2.x * 13, y: b.y + nn2.y * 13 };
            const D1 = dist(p1.pt, tailA), D2 = dist(tailB, p2.pt);
            if (D1 < 3 || D2 < 3) continue;
            const bz1 = bezier(p1.pt, { x: p1.pt.x + d1.x * D1 * 0.38, y: p1.pt.y + d1.y * D1 * 0.38 }, { x: tailA.x - nn2.x * D1 * 0.38, y: tailA.y - nn2.y * D1 * 0.38 }, tailA, Math.max(5, Math.round(D1 / 6)));
            const bz2 = bezier(tailB, { x: tailB.x + nn2.x * D2 * 0.38, y: tailB.y + nn2.y * D2 * 0.38 }, { x: p2.pt.x - d2.x * D2 * 0.38, y: p2.pt.y - d2.y * D2 * 0.38 }, p2.pt, Math.max(5, Math.round(D2 / 6)));
            const head: Vec2[] = [];
            let acc = 0;
            for (let i = 0; i < cur.length; i++) { if (i > 0) acc += dist(cur[i - 1], cur[i]); if (acc < sP1 - 1e-6) head.push(cur[i]); else break; }
            const tail: Vec2[] = [];
            acc = 0;
            for (let i = 0; i < cur.length; i++) { if (i > 0) acc += dist(cur[i - 1], cur[i]); if (acc > sP2 + 1e-6) tail.push(cur[i]); }
            const np = head.concat([p1.pt], bz1, [a, b], [tailB], bz2, tail);
            if (selfIntersects(np)) continue;
            // the road lines up with the bridge 14 m before and after it
            {
              const ia = np.findIndex((q) => q === a);
              const ib = ia + 1;
              const pre = np.slice(0, ia + 1), post = np.slice(ib);
              const back = pointAt(pre, Math.max(0, polylineLength(pre) - 14)).pt;
              const fwd = pointAt(post, Math.min(polylineLength(post), 14)).pt;
              const axis = { x: nn2.x, y: nn2.y };
              const angA = angleBetween({ x: a.x - back.x, y: a.y - back.y }, axis), angB = angleBetween({ x: fwd.x - b.x, y: fwd.y - b.y }, axis);
              if (angA > 20 * DEG || angB > 20 * DEG) continue;
            }
            // approaches stay dry and clear of the river (the bridge itself is exempt)
            let okp = true;
            const pieces: Polyline[] = [[p1.pt, ...bz1, a], [b, tailB, ...bz2]];
            for (const pc of pieces) {
              const Lp = polylineLength(pc);
              for (let q = 0; q <= Lp && okp; q += 2) {
                const p = pointAt(pc, q).pt;
                if (ctx.wet(p)) okp = false;
                else for (const rv of ctx.rivers) { const nr = nearestOn(rv.path, p); const wv = Math.max(rv.width[nr.i], rv.width[Math.min(rv.width.length - 1, nr.i + 1)]); if (nr.d < wv / 2 + 1.2) { okp = false; break; } }
              }
            }
            if (!okp) continue;
            built = { path: np, br: { a, b, width: ctx.roadWidth + 1 } };
            break;
          }
        }
      }
    }
    if (built) { cur = built.path; bridges.push(built.br); continue; }
    // fallback: bridge the wet run as it lies
    const sa = Math.max(0, target[0] - 3), sb = Math.min(L, target[1] + 3);
    const pa = pointAt(cur, sa).pt, pb = pointAt(cur, sb).pt;
    const na = nearestOn(cur, pa), ia = insertVertex(cur, na.i, na.t, 0.3);
    const nb = nearestOn(cur, pb), ib = insertVertex(cur, nb.i, nb.t, 0.3);
    bridges.push({ a: cur[ia], b: cur[ib > ia ? ib : ib], width: ctx.roadWidth + 1 });
  }
  return { path: cur, bridges };
}
