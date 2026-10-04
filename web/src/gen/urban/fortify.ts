/**
 * Fortification geometry: enclosure lines are polygons of straight curtains between towers, not smoothed curves.
 *
 * polygonizeRing: closed Douglas–Peucker fit of the isoline (max deviation `tol`), vertices snapped to local
 * height maxima (towers on high points), long edges split at points of the original curve, short edges merged,
 * then every edge is shifted outward by the excursion of the original curve beyond it, so that the polygon
 * CIRCUMSCRIBES the region. Circumscription keeps phases nested (R_k ⊇ R_{k−1}) and never cuts built land.
 */
import type { Vec2, Polygon } from '../core/geom';
import { dist, polygonArea } from '../core/geom';
import { cleanRing, isSimple, orientPos, area, pointInRing, distToRing, distToSeg } from '../geo/poly';
import type { UrbanCtx } from './context';
import { MultiPoly, unionS, differenceS, repairRing } from '../geo/bool';
import { smoothstep } from '../core/field';
import { ribbon } from '../geo/offset';
import { dryPieces } from './waterland';

export interface FitOpts {
  /** Max deviation of the DP fit (m). */
  tol: number;
  /** Curtain length range (m); lMax may depend on the ground (shorter on steep ground). */
  lMin: number;
  lMax: (a: Vec2, b: Vec2) => number;
  /** Optional vertex snap (e.g. to a local height maximum). */
  snap?: (p: Vec2) => Vec2;
}

export const FIT_STATS: { ok: number; fallback: number; log: ((ring: Polygon, fit: Polygon) => void) | null; why?: (s: string) => void; last?: { ring: Polygon; fit: Polygon } } = { ok: 0, fallback: 0, log: null };

/** Closed Douglas–Peucker: indices of the kept vertices (sorted), anchored at two mutually far vertices. */
export function dpClosed(ring: Vec2[], tol: number): number[] {
  const n = ring.length;
  if (n <= 4) return ring.map((_, i) => i);
  // anchors: vertex 0's farthest vertex, then that one's farthest
  let a = 0, b = 0, bd = -1;
  for (let i = 0; i < n; i++) { const d = dist(ring[0], ring[i]); if (d > bd) { bd = d; a = i; } }
  bd = -1;
  for (let i = 0; i < n; i++) { const d = dist(ring[a], ring[i]); if (d > bd) { bd = d; b = i; } }
  const keep = new Uint8Array(n);
  keep[a] = 1; keep[b] = 1;
  const rec = (i: number, j: number) => {
    // open chain i → j (indices modulo n, walking forward)
    const len = (j - i + n) % n;
    if (len < 2) return;
    const p = ring[i], q = ring[j];
    const dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy) || 1e-9;
    let best = -1, bdv = tol;
    for (let k = 1; k < len; k++) {
      const m = ring[(i + k) % n];
      const d = Math.abs(dx * (m.y - p.y) - dy * (m.x - p.x)) / l;
      if (d > bdv) { bdv = d; best = (i + k) % n; }
    }
    if (best < 0) return;
    keep[best] = 1;
    rec(i, best); rec(best, j);
  };
  rec(a, b); rec(b, a);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

const turn = (a: Vec2, b: Vec2, c: Vec2): number => {
  const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
  return Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
};

/**
 * Polygonal circumscription of a closed ring (positively oriented, interior on the left). Returns the polygon and,
 * per polygon vertex, whether it is a real corner (turn > 2°).
 */
export function polygonizeRing(ring0: Polygon, o: FitOpts): Polygon | null {
  const ring = orientPos(ring0);
  for (const f of [1, 0.6]) {
    const r = fitOnce(ring, { ...o, tol: o.tol * f });
    if (r) { FIT_STATS.ok++; return r; }
  }
  return null;
}

/** Morphological closing of a ring by r (fills inlets narrower than 2r): largest piece of (R ⊕ r) ⊖ r. */
export function closeRing(ring: Polygon, r: number): Polygon {
  const band = ribbon(ring.concat([ring[0]]), 2 * r);
  const D = unionS(ring, band);
  if (!D.length) return ring;
  let big = D[0];
  for (const ph of D) if (area(ph.outer) > area(big.outer)) big = ph;
  const E = differenceS({ outer: big.outer, holes: [] }, ribbon(big.outer.concat([big.outer[0]]), 2 * r));
  if (!E.length) return ring;
  let best = E[0];
  for (const ph of E) if (area(ph.outer) > area(best.outer)) best = ph;
  // the closing never shrinks the region: union with the original
  const U = unionS(best.outer, ring);
  let out = U[0];
  for (const ph of U) if (area(ph.outer) > area(out.outer)) out = ph;
  return out.outer;
}

/** Does polygon P contain every vertex of ring (within tol)? */
function circumscribes(P: Polygon, ring: Polygon, tol: number): boolean {
  for (const q of ring) if (!pointInRing(P, q) && distToRing(P, q) > tol) return false;
  return true;
}

function fitOnce(ring: Polygon, o: FitOpts): Polygon | null {
  const n = ring.length;
  if (n < 6) return ring;
  // arclength of the original ring
  const cum = [0];
  for (let i = 1; i <= n; i++) cum.push(cum[i - 1] + dist(ring[i - 1], ring[i % n]));
  const L = cum[n];
  let idx = dpClosed(ring, o.tol);
  // split long edges at vertices of the original curve (equal arclength parts)
  const split: number[] = [];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k], j = idx[(k + 1) % idx.length];
    split.push(i);
    const a = ring[i], b = ring[j];
    const lmax = o.lMax(a, b);
    const len = dist(a, b);
    if (len <= lmax) continue;
    const parts = Math.ceil(len / lmax);
    const s0 = cum[i], s1 = j > i ? cum[j] : cum[j] + L;
    for (let t = 1; t < parts; t++) {
      const s = s0 + ((s1 - s0) * t) / parts;
      // nearest original vertex to arclength s
      let bi = i, bdv = Infinity;
      for (let m = i; m !== j; m = (m + 1) % n) {
        const sm = m >= i ? cum[m] : cum[m] + L;
        const d = Math.abs(sm - s);
        if (d < bdv) { bdv = d; bi = m; }
      }
      if (bi !== i && split[split.length - 1] !== bi) split.push(bi);
    }
  }
  idx = split;
  // merge short edges: drop the endpoint with the smaller turn (keep corners)
  for (let guard = 0; guard < 200 && idx.length > 4; guard++) {
    let worst = -1, wl = o.lMin;
    for (let k = 0; k < idx.length; k++) {
      const l = dist(ring[idx[k]], ring[idx[(k + 1) % idx.length]]);
      if (l < wl) { wl = l; worst = k; }
    }
    if (worst < 0) break;
    const m = idx.length;
    const k1 = worst, k2 = (worst + 1) % m;
    const t1 = turn(ring[idx[(k1 - 1 + m) % m]], ring[idx[k1]], ring[idx[k2]]);
    const t2 = turn(ring[idx[k1]], ring[idx[k2]], ring[idx[(k2 + 1) % m]]);
    idx.splice(t1 < t2 ? k1 : k2, 1);
  }
  // vertices (snapped), and the original sub-curve each edge replaces
  // snapping may move a vertex along or outward, never more than 1.5 m inward
  const V: Vec2[] = idx.map((i) => {
    if (!o.snap) return ring[i];
    const q = o.snap(ring[i]);
    return pointInRing(ring, q) && distToRing(ring, q) > 1.5 ? ring[i] : q;
  });
  let m = V.length;
  // outward shift of each edge line by the excursion of its sub-curve (interior is on the left)
  const lines: { p: Vec2; d: Vec2; sh: number }[] = [];
  for (let k = 0; k < m; k++) {
    const a = V[k], b = V[(k + 1) % m];
    const l = dist(a, b) || 1e-9;
    const d = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
    let out = 0;
    // the sub-curve this edge replaces, extended a little into both neighbours (points near a convex vertex may
    // otherwise stick out past the next edge's line)
    const i = idx[k], j = idx[(k + 1) % m];
    const span = (j - i + n) % n;
    const ext = Math.max(2, Math.round(span * 0.25));
    for (let q = -ext; q <= span + ext; q++) {
      const c = ring[(((i + q) % n) + n) % n];
      // only points that project onto (or near) the segment count
      const u = (c.x - a.x) * d.x + (c.y - a.y) * d.y;
      if (u < -3 || u > l + 3) continue;
      const s = d.x * (c.y - a.y) - d.y * (c.x - a.x); // > 0 inside (left)
      if (-s > out) out = -s;
    }
    const sh = out + 0.3;
    lines.push({ p: { x: a.x + d.y * sh, y: a.y - d.x * sh }, d, sh });
  }
  const corners = (): Vec2[] => {
    // edge collapse: a line whose edge comes out reversed after the shifts is dropped (offset-polygon event)
    for (let guard = 0; guard < 20 && lines.length > 4; guard++) {
      const P0 = cornersRaw();
      const mm = lines.length;
      let bad = -1;
      for (let k = 0; k < mm; k++) {
        const a = P0[k], b = P0[(k + 1) % mm];
        if ((b.x - a.x) * lines[k].d.x + (b.y - a.y) * lines[k].d.y < 0.5) { bad = k; break; }
      }
      if (bad < 0) return P0;
      lines.splice(bad, 1);
      V.splice((bad + 1) % V.length, 1);
      m = lines.length;
    }
    return cornersRaw();
  };
  const cornersRaw = (): Vec2[] => {
    const P: Vec2[] = [];
    for (let k = 0; k < m; k++) {
      const A = lines[(k - 1 + m) % m], B = lines[k];
      const den = A.d.x * B.d.y - A.d.y * B.d.x;
      // vertex k pushed out along the mean outward normal (near-parallel edges and extreme miters)
      const nx = A.d.y + B.d.y, ny = -(A.d.x + B.d.x), nl = Math.hypot(nx, ny) || 1;
      const sh = Math.max(A.sh, B.sh);
      const fallback = { x: V[k].x + (nx / nl) * sh, y: V[k].y + (ny / nl) * sh };
      if (Math.abs(den) < 0.05) { P.push(fallback); continue; }
      const t = ((B.p.x - A.p.x) * B.d.y - (B.p.y - A.p.y) * B.d.x) / den;
      const q = { x: A.p.x + A.d.x * t, y: A.p.y + A.d.y * t };
      P.push(dist(q, V[k]) > 3 * sh + 15 ? fallback : q);
    }
    return P;
  };
  let P = corners();
  // refinement: original points still outside push their nearest edge further out
  for (let it = 0; it < 3; it++) {
    const need = new Float64Array(m);
    let any = false;
    for (const q of ring) {
      if (pointInRing(P, q)) continue;
      let be = 0, bd = Infinity;
      for (let e = 0; e < m; e++) { const dd = distToSeg(q, P[e], P[(e + 1) % m]); if (dd < bd) { bd = dd; be = e; } }
      if (bd > 0.05) { need[be] = Math.max(need[be], bd + 0.3); any = true; }
    }
    if (!any) break;
    for (let e = 0; e < m; e++) if (need[e] > 0) {
      const ln = lines[e];
      ln.p = { x: ln.p.x + ln.d.y * need[e], y: ln.p.y - ln.d.x * need[e] };
      ln.sh += need[e];
    }
    P = corners();
  }
  // short curtains (< lMin/2) collapse into their neighbours when the polygon still circumscribes the region
  const outside = (Q: Vec2[]) => ring.some((q) => !pointInRing(Q, q) && distToRing(Q, q) > 0.6);
  for (let guard = 0; guard < 40 && lines.length > 5; guard++) {
    let k = -1, kl = o.lMin / 2;
    const skip = new Set<number>();
    for (let e = 0; e < m; e++) { const l = dist(P[e], P[(e + 1) % m]); if (l < kl && !skip.has(e)) { kl = l; k = e; } }
    if (k < 0) break;
    const saveL = lines.slice(), saveV = V.slice();
    lines.splice(k, 1); V.splice((k + 1) % V.length, 1); m = lines.length;
    const Q = corners();
    if (outside(Q) || Q.length !== m) { lines.length = 0; lines.push(...saveL); V.length = 0; V.push(...saveV); m = lines.length; break; }
    P = Q;
  }
  let res = cleanRing(P, 1, 0.5);
  if (res.length >= 3 && !isSimple(res)) res = cleanRing(repairRing(res), 1, 0.5);
  if (res.length < 3 || !isSimple(res) || polygonArea(res) <= 0 || !circumscribes(res, ring, 0.6)) {
    if (FIT_STATS.why) {
      let worst = 0;
      if (res.length >= 3) for (const q of ring) if (!pointInRing(res, q)) worst = Math.max(worst, distToRing(res, q));
      FIT_STATS.last = { ring, fit: P };
      FIT_STATS.why(`n=${res.length} simple=${res.length >= 3 && isSimple(res)} area=${res.length >= 3 ? polygonArea(res).toFixed(0) : 0} worstOut=${worst.toFixed(2)} tol=${o.tol}`);
    }
    return null;
  }
  return res;
}

/** Mean local slope along a segment (3 samples). */
function segSlope(ctx: UrbanCtx, a: Vec2, b: Vec2): number {
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return (ctx.slopeAt(a) + ctx.slopeAt(m) + ctx.slopeAt(b)) / 3;
}

/** Highest dry point within 10 m (towers stand on high points), when it is > 0.3 m higher. */
export function snapHigh(ctx: UrbanCtx, p: Vec2): Vec2 {
  let best = p, bh = ctx.heightAt(p) + 0.3;
  for (const r of [5, 10]) for (let k = 0; k < 8; k++) {
    const q = { x: p.x + Math.cos((k * Math.PI) / 4) * r, y: p.y + Math.sin((k * Math.PI) / 4) * r };
    if (ctx.isWater(q)) continue;
    const h = ctx.heightAt(q);
    if (h > bh) { bh = h; best = q; }
  }
  return best;
}

/** Curtain-length rule: 25–80 m on flat ground, down to ~45 m on steep ground. */
export const curtainMax = (ctx: UrbanCtx) => (a: Vec2, b: Vec2): number => 80 - 35 * smoothstep(segSlope(ctx, a, b), 0.06, 0.25);

/**
 * Region with a polygonal (fortified) outline that circumscribes R ∪ prev; along water the line stays the bank.
 * Small pieces keep their outline.
 */
export function fortifyRegion(ctx: UrbanCtx, R: MultiPoly, prev: MultiPoly): MultiPoly {
  const parts: MultiPoly[] = [];
  for (const ph of R) {
    if (area(ph.outer) < 4000) { parts.push([ph]); continue; }
    const opts: FitOpts = { tol: 10, lMin: 25, lMax: curtainMax(ctx), snap: (p) => snapHigh(ctx, p) };
    // a deep narrow inlet (a river biting in) is spanned by the wall, as with a water gate
    const poly = polygonizeRing(ph.outer, opts) ?? polygonizeRing(closeRing(ph.outer, 12), opts) ?? polygonizeRing(closeRing(ph.outer, 25), opts);
    if (!poly) { FIT_STATS.fallback++; if (FIT_STATS.log && FIT_STATS.last) FIT_STATS.log(FIT_STATS.last.ring, FIT_STATS.last.fit); }
    parts.push([{ outer: poly ?? ph.outer, holes: ph.holes }]);
  }
  let out: MultiPoly = parts.length ? unionS(parts[0], ...parts.slice(1), prev) : prev;
  if (ctx.water.length) out = dryPieces(out, ctx.water);
  return out;
}
