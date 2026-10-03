/**
 * Open-field system: arable regions are partitioned (never filled with seeds) by a network of field ways, headlands and
 * hedges that follows a direction field (contours on slopes, perpendicular to roads on the flat, a slow noise elsewhere).
 * Each furlong is then cut into long thin strips running in its own direction, with a slight reverse-S (aratral) curve.
 *
 *   region --(recursive cuts along streamlines of the direction field)--> furlongs / closes --> strips
 *
 * A cut across the strip direction is a headland (the strips end on it); a cut along the strip direction is a way or a
 * baulk. The first cuts of a region are cart ways (drawn as tracks), the later ones narrow headlands. In closed ground
 * (bocage, farm closes, assarts) the same recursion makes small irregular hedged closes instead.
 */
import polygonClipping from 'polygon-clipping';
import type { Rng } from '../core/rng';
import type { Noise2D } from '../core/noise';
import { Vec2, Polygon, Polyline, simplify, polygonArea, polygonCentroid, polygonContains, offsetRibbon, distToPolyline } from '../core/geom';

export type Ring = [number, number][];


export const toRing = (p: Polygon): Ring => {
  const r = p.map((q) => [q.x, q.y] as [number, number]);
  r.push([p[0].x, p[0].y]);
  return r;
};
export const fromRing = (r: Ring): Polygon => {
  const out = r.map(([x, y]) => ({ x, y }));
  if (out.length > 1 && out[0].x === out[out.length - 1].x && out[0].y === out[out.length - 1].y) out.pop();
  return out;
};

export interface FieldCtx {
  /** Strip direction (radians, mod pi) at a world point. */
  dirAt(x: number, y: number): number;
  /** Slope (rise/run) at a world point. */
  slopeAt(x: number, y: number): number;
  /** True where the ground is enclosed (hedged closes) rather than open field. */
  closeAt(x: number, y: number): boolean;
  noise: Noise2D;
  rng: Rng;
  /** Level of detail: cut the strips only where this returns true. */
  stripsAt?(c: Vec2): boolean;
}

export interface Furlong {
  outer: Polygon; holes: Polygon[];
  angle: number;
  enclosed: boolean;
  strips?: Polygon[];
  /** Strip width used (m). */
  stripW: number;
}

export interface FieldNet { furlongs: Furlong[]; ways: Polyline[]; headlands: Polyline[] }

/** Largest total bending (rad) of the central line for which the strips follow it. */
const MAX_BEND = 0.42;
const GAP = { way: 4.4, headland: 2.4, hedge: 1.3 };

interface Node { rings: Ring[]; rot: number; depth: number }

/** Streamline of the field `ang(x, y)` through p0, in both directions, until it leaves `box`, loops back on itself or runs `maxLen` m. */
function trace(p0: Vec2, ang: (x: number, y: number) => number, box: { x0: number; y0: number; x1: number; y1: number }, step: number, maxLen: number, wob: (x: number, y: number) => number): Polyline {
  const run = (sign: number): Vec2[] => {
    const out: Vec2[] = [];
    let p = p0;
    let dx = 0, dy = 0, prevHd = 0, turned = 0;
    const kmax = Math.ceil(maxLen / step);
    for (let k = 0; k < kmax; k++) {
      const a = ang(p.x, p.y);
      let ux = Math.cos(a), uy = Math.sin(a);
      if (k === 0) { ux *= sign; uy *= sign; } else if (ux * dx + uy * dy < 0) { ux = -ux; uy = -uy; }
      dx = ux; dy = uy;
      // a cut that curls round a summit is dropped from there on (no whorls)
      const hd = Math.atan2(dy, dx);
      if (k > 0) { let dh = Math.abs(hd - prevHd); if (dh > Math.PI) dh = 2 * Math.PI - dh; turned += dh; if (turned > 1.6) break; }
      prevHd = hd;
      const w = wob(p.x, p.y);
      p = { x: p.x + dx * step - dy * w, y: p.y + dy * step + dx * w };
      out.push(p);
      if (p.x < box.x0 || p.x > box.x1 || p.y < box.y0 || p.y > box.y1) break;
      // spiral on a hill: stop where the line comes back to itself
      if (k > 8) {
        const lim = step * step * 0.64;
        let loop = false;
        for (let j = 0; j < k - 8; j++) { const q = out[j]; if ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 < lim) { loop = true; break; } }
        if (loop) break;
      }
    }
    return out;
  };
  const back = run(-1).reverse();
  return [...back, p0, ...run(1)];
}

/** Midpoint of the longest chord of the rings (even-odd) along the line o + t d. */
function chordMid(rings: Ring[], ox: number, oy: number, dx: number, dy: number): Vec2 | null {
  const ts: number[] = [];
  for (const r of rings) for (let i = 1; i < r.length; i++) {
    const cx = r[i - 1][0], cy = r[i - 1][1], ex = r[i][0] - cx, ey = r[i][1] - cy;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((cx - ox) * ey - (cy - oy) * ex) / den, u = ((cx - ox) * dy - (cy - oy) * dx) / den;
    if (u >= 0 && u < 1) ts.push(t);
  }
  ts.sort((a, b) => a - b);
  let best = -1, bt = 0;
  for (let i = 0; i + 1 < ts.length; i += 2) if (ts[i + 1] - ts[i] > best) { best = ts[i + 1] - ts[i]; bt = (ts[i] + ts[i + 1]) / 2; }
  return best > 0 ? { x: ox + dx * bt, y: oy + dy * bt } : null;
}

/** Parts of polyline `pl` that lie inside the rings (even-odd), cut exactly at the boundary. */
export function clipToRings(pl: Polyline, rings: Ring[]): Polyline[] {
  const inside = (p: Vec2): boolean => {
    let c = false;
    for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i], b = r[j];
      if ((a[1] > p.y) !== (b[1] > p.y) && p.x < a[0] + ((p.y - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) c = !c;
    }
    return c;
  };
  const crossing = (a: Vec2, b: Vec2): Vec2 => {
    let bt = 1;
    for (const r of rings) for (let i = 1; i < r.length; i++) {
      const c = r[i - 1], d = r[i];
      const rx = b.x - a.x, ry = b.y - a.y, sx = d[0] - c[0], sy = d[1] - c[1];
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((c[0] - a.x) * sy - (c[1] - a.y) * sx) / den, u = ((c[0] - a.x) * ry - (c[1] - a.y) * rx) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t < bt) bt = t;
    }
    return { x: a.x + (b.x - a.x) * bt, y: a.y + (b.y - a.y) * bt };
  };
  const out: Polyline[] = [];
  let cur: Vec2[] = [];
  let prevIn = false, prev: Vec2 | null = null;
  for (const p of pl) {
    const ins = inside(p);
    if (prev) {
      if (ins && !prevIn) cur = [crossing(p, prev)];
      else if (!ins && prevIn) { cur.push(crossing(prev, p)); if (cur.length > 1) out.push(cur); cur = []; }
    }
    if (ins) cur.push(p);
    prevIn = ins; prev = p;
  }
  if (prevIn && cur.length > 1) out.push(cur);
  return out;
}

const extents = (outer: Ring, ca: number, sa: number) => {
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (const [x, y] of outer) {
    const u = x * ca + y * sa, v = -x * sa + y * ca;
    if (u < umin) umin = u; if (u > umax) umax = u;
    if (v < vmin) vmin = v; if (v > vmax) vmax = v;
  }
  return { umin, umax, vmin, vmax };
};

/**
 * Exact intersection of a simple polygon with the band v0 <= v <= v1 (any number of pieces): the ring is cut into fragments
 * inside the band, which are joined along the two band lines (CCW rings: along the top line towards -u, along the bottom line towards +u).
 */
function bandClip(P: [number, number][], v0: number, v1: number, ccw: boolean): [number, number][][] {
  const n = P.length;
  const side = (v: number) => (v < v0 ? -1 : v > v1 ? 1 : 0);
  let start = -1;
  for (let i = 0; i < n; i++) if (side(P[i][1]) !== 0) { start = i; break; }
  if (start < 0) return [P.slice()];
  interface Frag { pts: [number, number][]; entry: number; exit: number; eu: number; xu: number; used: boolean }
  const frags: Frag[] = [];
  let cur: [number, number][] | null = null;
  let entrySide = 0;
  for (let k = 0; k < n; k++) {
    const a = P[(start + k) % n], b = P[(start + k + 1) % n];
    // parameter range of the edge inside the band
    let t0 = 0, t1 = 1;
    const dv = b[1] - a[1];
    if (dv === 0) { if (a[1] < v0 || a[1] > v1) continue; }
    else {
      let ta = (v0 - a[1]) / dv, tb = (v1 - a[1]) / dv;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      t0 = Math.max(0, ta); t1 = Math.min(1, tb);
      if (t0 >= t1) continue;
    }
    const sa0 = side(a[1]), sb0 = side(b[1]);
    const pa: [number, number] = t0 > 0 ? [a[0] + (b[0] - a[0]) * t0, sa0 < 0 ? v0 : v1] : [a[0], a[1]];
    const pb: [number, number] = t1 < 1 ? [a[0] + (b[0] - a[0]) * t1, sb0 < 0 ? v0 : v1] : [b[0], b[1]];
    if (t0 > 0) { cur = [pa]; entrySide = sa0; } else if (!cur) { cur = [pa]; entrySide = Math.abs(a[1] - v0) < Math.abs(a[1] - v1) ? -1 : 1; }
    if (t1 < 1) {
      cur!.push(pb);
      frags.push({ pts: cur!, entry: entrySide, exit: side(b[1]), eu: cur![0][0], xu: pb[0], used: false });
      cur = null;
    } else cur!.push(pb);
  }
  if (cur) { // cannot happen when the ring starts outside the band, kept for safety
    return [];
  }
  const out: [number, number][][] = [];
  const entries = frags.map((f, i) => ({ i, f }));
  const nextOf = (f: Frag): Frag | null => {
    // the nearest entry on the exit line in the travelling direction
    const dir = (f.exit > 0) === ccw ? -1 : 1;
    let best: Frag | null = null, bd = Infinity;
    for (const { f: g } of entries) {
      if (g.entry !== f.exit) continue;
      const du = (g.eu - f.xu) * dir;
      if (du > -1e-9 && du < bd) { bd = du; best = g; }
    }
    return best;
  };
  for (const f0 of frags) {
    if (f0.used) continue;
    const ring: [number, number][] = [];
    let f: Frag | null = f0;
    let guard = 0;
    while (f && !f.used && guard++ < 500) {
      f.used = true;
      for (const p of f.pts) ring.push(p);
      f = nextOf(f);
    }
    if (ring.length >= 3) out.push(ring);
  }
  return out;
}

const ringArea = (r: Ring): number => {
  let a = 0;
  for (let i = 1; i < r.length; i++) a += r[i - 1][0] * r[i][1] - r[i][0] * r[i - 1][1];
  return Math.abs(a) / 2;
};

/** Partition one arable region (outer ring + holes) into furlongs / closes and cut the strips. */
export function partitionRegion(outer: Polygon, holes: Polygon[], ctx: FieldCtx, net: FieldNet): void {
  const rng = ctx.rng;
  const leaves: { rings: Ring[]; rot: number; enclosed: boolean }[] = [];
  const closed = ctx.closeAt(0, 0);

  /** Cut `rings` along (or across) the strips of direction field + rot with a streamline cut of width `gap`; null when it does not split. */
  const cutOnce = (rings: Ring[], rot: number, across: boolean, f: number, gap: number, wobAmp: number, bucket: Polyline[], jitter: boolean, straightCut = false): Ring[][] | null => {
    const cen = polygonCentroid(fromRing(rings[0]));
    const phi = ctx.dirAt(cen.x, cen.y) + rot;
    const ca = Math.cos(phi), sa = Math.sin(phi);
    const ex = extents(rings[0], ca, sa);
    let ox: number, oy: number, cdx: number, cdy: number;
    let angFn: (x: number, y: number) => number;
    if (across) {
      const u = ex.umin + (ex.umax - ex.umin) * f, v = (ex.vmin + ex.vmax) / 2;
      ox = u * ca - v * sa; oy = u * sa + v * ca; cdx = -sa; cdy = ca;
      angFn = straightCut ? () => phi + Math.PI / 2 : (x, y) => ctx.dirAt(x, y) + rot + Math.PI / 2;
    } else {
      const u = (ex.umin + ex.umax) / 2, v = ex.vmin + (ex.vmax - ex.vmin) * f;
      ox = u * ca - v * sa; oy = u * sa + v * ca; cdx = ca; cdy = sa;
      angFn = straightCut ? () => phi : (x, y) => ctx.dirAt(x, y) + rot;
    }
    const mid = chordMid(rings, ox, oy, cdx, cdy);
    if (!mid) return null;
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    for (const q of rings[0]) { if (q[0] < bx0) bx0 = q[0]; if (q[0] > bx1) bx1 = q[0]; if (q[1] < by0) by0 = q[1]; if (q[1] > by1) by1 = q[1]; }
    bx0 -= 30; bx1 += 30; by0 -= 30; by1 += 30;
    const wob = (x: number, y: number) => ctx.noise.noise(x / 55 + 11, y / 55 - 3) * wobAmp * 0.08;
    let line = trace(mid, angFn, { x0: bx0, y0: by0, x1: bx1, y1: by1 }, 10, 1.15 * Math.hypot(bx1 - bx0, by1 - by0), wob);
    if (jitter) line = line.map((p, i) => (i % 3 === 0 ? { x: p.x + ctx.noise.noise(p.x / 28, p.y / 28) * 3, y: p.y + ctx.noise.noise(p.x / 28 + 9, p.y / 28) * 3 } : p));
    line = simplify(line, 0.9);
    let pieces: Ring[][];
    try {
      pieces = polygonClipping.difference([rings as unknown as [number, number][][]], [[toRing(offsetRibbon(line, gap))]]).map((pg) => pg as unknown as Ring[]);
    } catch { return null; }
    const real = pieces.filter((pg) => ringArea(pg[0]) > 300);
    if (real.length < 2) return null;
    for (const seg of clipToRings(line, rings)) bucket.push(seg);
    return real;
  };
  /** A cut that does not split (degenerate geometry) is retried at other positions. */
  const cut = (rings: Ring[], rot: number, across: boolean, f: number, gap: number, wobAmp: number, bucket: Polyline[], jitter: boolean): Ring[][] | null => {
    for (const straightCut of [false, true]) for (const df of [0, 0.13, -0.13]) {
      const r = cutOnce(rings, rot, across, Math.max(0.25, Math.min(0.75, f + df)), gap * (df ? 1.07 : 1), wobAmp, bucket, jitter, straightCut);
      if (r) return r;
    }
    return null;
  };
  const areaOf = (rings: Ring[]) => ringArea(rings[0]) - rings.slice(1).reduce((a, r) => a + ringArea(r), 0);
  const dims = (rings: Ring[], rot: number) => {
    const cen = polygonCentroid(fromRing(rings[0]));
    const phi = ctx.dirAt(cen.x, cen.y) + rot;
    const ex = extents(rings[0], Math.cos(phi), Math.sin(phi));
    const L = ex.umax - ex.umin;
    // mean width (a curved band has a large bounding box but a narrow body)
    const Wb = ex.vmax - ex.vmin;
    return { cen, L, W: Math.min(Wb, areaOf(rings) / Math.max(L, 1)), fill: areaOf(rings) / Math.max(1, L * Wb) };
  };

  // phase A: blocks of ~15-30 ha cut by cart ways (open fields only), each with its own strip direction (the patchwork)
  const blocks: { rings: Ring[]; rot: number }[] = [];
  const root: Ring[] = [toRing(outer), ...holes.map(toRing)];
  if (closed) blocks.push({ rings: root, rot: 0 });
  else {
    const stack: { rings: Ring[]; depth: number }[] = [{ rings: root, depth: 0 }];
    let guard = 0;
    while (stack.length && guard++ < 2000) {
      const nd = stack.pop()!;
      const a = areaOf(nd.rings);
      const { L, W } = dims(nd.rings, 0);
      const Ab = rng.range(14, 28) * 1e4;
      let pcs: Ring[][] | null = null;
      if (a > Ab && nd.depth < 10) pcs = cut(nd.rings, 0, L >= W * 1.15, rng.range(0.4, 0.6), GAP.way, 3.5, net.ways, false);
      if (!pcs) { blocks.push({ rings: nd.rings, rot: 0 }); continue; }
      for (const pg of pcs) stack.push({ rings: pg, depth: nd.depth + 1 });
    }
    for (const b of blocks) {
      const c = polygonCentroid(fromRing(b.rings[0]));
      const sl = ctx.slopeAt(c.x, c.y);
      const flat = 1 - Math.min(1, Math.max(0, (sl - 0.03) / 0.05));
      // mostly a quarter turn (the furlongs stay square to the block's ways); an occasional skew
      if (blocks.length > 1) { const r = rng.float(); if (r < 0.4) b.rot = Math.PI / 2; else if (r < 0.52) b.rot = rng.range(0.25, 0.5) * (rng.chance(0.5) ? 1 : -1) * flat; }
    }
  }

  // phase B: furlongs (strips ~150-300 m long) / closes, cut by headlands across and baulks along the block's strip direction
  for (const bl of blocks) {
    const stack: Node[] = [{ rings: bl.rings, rot: bl.rot, depth: 0 }];
    let guard = 0;
    while (stack.length && guard++ < 3000) {
      const nd = stack.pop()!;
      const a = areaOf(nd.rings);
      const { L, W, fill } = dims(nd.rings, nd.rot);
      const Lmax = closed ? rng.range(110, 190) : rng.range(305, 345);
      const Wmax = closed ? rng.range(100, 170) : rng.range(130, 250);
      // a bent furlong (low fill of its box) is cut across so that each part is straight enough for long strips
      const bent = !closed && fill < 0.6 && L > 270;
      const across = bent || (L > Lmax && (L / Lmax >= W / Wmax || W <= Wmax));
      const along = !across && W > Wmax;
      if (a < (closed ? 5000 : 14000) || nd.depth > 14 || (!across && !along)) { leaves.push({ rings: nd.rings, rot: nd.rot, enclosed: closed }); continue; }
      const pcs = cut(nd.rings, nd.rot, across, closed || !across ? rng.range(0.4, 0.6) : rng.range(0.46, 0.54), closed ? GAP.hedge : GAP.headland, closed ? 5.5 : 3.5, net.headlands, closed);
      if (!pcs) { leaves.push({ rings: nd.rings, rot: nd.rot, enclosed: closed }); continue; }
      for (const pg of pcs) stack.push({ rings: pg, rot: closed ? nd.rot + rng.range(-0.5, 0.5) : nd.rot, depth: nd.depth + 1 });
    }
  }

  // leaves: strips
  for (const lf of leaves) {
    const o = fromRing(lf.rings[0]);
    const a = ringArea(lf.rings[0]) - lf.rings.slice(1).reduce((s, r) => s + ringArea(r), 0);
    if (a < 1400) continue;
    const cen = polygonCentroid(o);
    const ang0 = ((ctx.dirAt(cen.x, cen.y) + lf.rot) % Math.PI + Math.PI) % Math.PI;
    const ca = Math.cos(ang0), sa = Math.sin(ang0);
    const ex = extents(lf.rings[0], ca, sa);
    const holes = lf.rings.slice(1).map(fromRing);
    const fl: Furlong = { outer: o, holes, angle: ang0, enclosed: lf.enclosed, stripW: 0 };
    net.furlongs.push(fl);
    if (lf.enclosed) continue;
    const ws = rng.range(11, 22);
    fl.stripW = ws;
    const L = ex.umax - ex.umin;
    const slabs = Math.ceil((ex.vmax - ex.vmin) / ws);
    if (slabs < 2 || slabs > 70 || a <= 2500 || (ctx.stripsAt && !ctx.stripsAt(cen))) continue;
    const A = rng.range(-1, 1) * Math.min(0.03 * L, 7);
    const phase = rng.range(0, 0.4);
    const d = (u: number) => A * Math.sin(2 * Math.PI * ((u - ex.umin) / (L || 1) + phase));
    const us: number[] = [];
    for (let k = 0; k <= 6; k++) us.push(ex.umin - 5 + ((L + 10) * k) / 6);
    const strips: Polygon[] = [];
    const vlo = (s: number) => ex.vmin + s * ws;
    const gaps: number[] = [];
    for (let s = 0; s < slabs; s++) gaps.push(rng.range(0.9, 0.99));
    if (lf.rings.length === 1) {
      // the strips follow the field: a central streamline C(t) through the furlong, strips are bands at offsets v from it
      const attempt = (allowCurve: boolean): Polygon[] => {
        const strips: Polygon[] = [];
        const rg = lf.rings[0];
        const dense: [number, number][] = [];
        let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
        for (let k = 0; k < rg.length - 1; k++) {
          const p0 = rg[k], p1 = rg[k + 1];
          const m = Math.max(1, Math.ceil(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 14));
          for (let q = 0; q < m; q++) dense.push([p0[0] + ((p1[0] - p0[0]) * q) / m, p0[1] + ((p1[1] - p0[1]) * q) / m]);
          if (p0[0] < bx0) bx0 = p0[0]; if (p0[0] > bx1) bx1 = p0[0]; if (p0[1] < by0) by0 = p0[1]; if (p0[1] > by1) by1 = p0[1];
        }
        const C = trace(cen, (x, y) => ctx.dirAt(x, y) + lf.rot, { x0: bx0 - 40, y0: by0 - 40, x1: bx1 + 40, y1: by1 + 40 }, 8, 1.15 * Math.hypot(bx1 - bx0, by1 - by0), () => 0);
        let straight = !allowCurve;
        const nC = C.length;
        const S = [0];
        for (let k = 1; k < nC; k++) S.push(S[k - 1] + Math.hypot(C[k].x - C[k - 1].x, C[k].y - C[k - 1].y));
        const T = C.map((_, k) => { const a1 = C[Math.max(0, k - 1)], b1 = C[Math.min(nC - 1, k + 1)]; const l = Math.hypot(b1.x - a1.x, b1.y - a1.y) || 1; return { x: (b1.x - a1.x) / l, y: (b1.y - a1.y) / l }; });
        const toTV = (x: number, y: number): [number, number] => {
          let bd = Infinity, bt = 0, bv = 0;
          for (let k = 1; k < nC; k++) {
            const ax = C[k - 1].x, ay = C[k - 1].y, dx = C[k].x - ax, dy = C[k].y - ay, l2 = dx * dx + dy * dy || 1;
            const f = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
            const px = ax + f * dx, py = ay + f * dy;
            const dd = (x - px) * (x - px) + (y - py) * (y - py);
            if (dd < bd) {
              bd = dd; bt = S[k - 1] + f * (S[k] - S[k - 1]);
              bv = ((x - px) * -dy + (y - py) * dx) / Math.sqrt(l2);
            }
          }
          return [bt, bv];
        };
        const fromTV = (t: number, v: number): Vec2 => {
          let lo = 1, hi = nC - 1;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (S[mid] < t) lo = mid + 1; else hi = mid; }
          const k = lo, f = Math.max(0, Math.min(1, (t - S[k - 1]) / ((S[k] - S[k - 1]) || 1)));
          const px = C[k - 1].x + f * (C[k].x - C[k - 1].x), py = C[k - 1].y + f * (C[k].y - C[k - 1].y);
          const dx = C[k].x - C[k - 1].x, dy = C[k].y - C[k - 1].y, tl = Math.hypot(dx, dy) || 1;
          return { x: px - (dy / tl) * v, y: py + (dx / tl) * v };
        };
        // turning of the central line over the furlong: only a gently bending one is used as the frame
        let tvC = straight ? dense.map((q) => [q[0] * ca + q[1] * sa, -q[0] * sa + q[1] * ca] as [number, number]) : dense.map((q) => toTV(q[0], q[1]));
        if (!straight) {
          let t0 = Infinity, t1 = -Infinity;
          for (const [t] of tvC) { if (t < t0) t0 = t; if (t > t1) t1 = t; }
          const segOf = (t: number) => { let k = 1; while (k < nC - 1 && S[k] < t) k++; return k; };
          const ka = segOf(t0), kb = segOf(t1);
          let turn = 0; // total bending (not the net: an S-bend must not pass)
        for (let k = ka; k < kb; k++) turn += Math.abs(Math.atan2(T[k].x * T[k + 1].y - T[k].y * T[k + 1].x, T[k].x * T[k + 1].x + T[k].y * T[k + 1].y));
          let vabs = 0;
          for (const [, v] of tvC) vabs = Math.max(vabs, Math.abs(v));
          // the offset lines must not fold: radius of the central line >= 2.5 x the half width
          if (!straight && (turn > MAX_BEND || turn * 2.5 * vabs > Math.max(1, t1 - t0))) { straight = true; tvC = dense.map((q) => [q[0] * ca + q[1] * sa, -q[0] * sa + q[1] * ca] as [number, number]); }
        }
        const tv = tvC;
        let tmin = Infinity, tmax = -Infinity, vmin = Infinity, vmax = -Infinity;
        for (const [t, v] of tv) { if (t < tmin) tmin = t; if (t > tmax) tmax = t; if (v < vmin) vmin = v; if (v > vmax) vmax = v; }
        const Lc = tmax - tmin;
        const nSlab = Math.ceil((vmax - vmin) / ws);
        if (nSlab >= 2 && nSlab <= 70) {
          const A2 = A * Math.min(1, Lc / (L || 1));
          const dd = (t: number) => A2 * Math.sin(2 * Math.PI * ((t - tmin) / (Lc || 1) + phase));
          const base: [number, number][] = tv.map(([t, v]) => [t, v - dd(t)]);
          let sg = 0;
          for (let k = 0; k < base.length; k++) { const p = base[k], q = base[(k + 1) % base.length]; sg += p[0] * q[1] - q[0] * p[1]; }
          const bmin = Math.min(...base.map((q) => q[1]));
          for (let sIdx = 0; sIdx < nSlab; sIdx++) {
            const v0 = bmin + sIdx * ws, v1 = v0 + ws * gaps[sIdx % gaps.length];
            for (const pg of bandClip(base, v0, v1, sg > 0)) {
              const out: Polygon = [];
              for (let k = 0; k < pg.length; k++) {
                const a0 = pg[k], b0 = pg[(k + 1) % pg.length];
                const m = Math.max(1, Math.ceil(Math.abs(b0[0] - a0[0]) / 14));
                for (let q = 0; q < m; q++) {
                  const t = a0[0] + ((b0[0] - a0[0]) * q) / m, vv = a0[1] + ((b0[1] - a0[1]) * q) / m + dd(t);
                  out.push(straight ? { x: t * ca - vv * sa, y: t * sa + vv * ca } : fromTV(t, vv));
                }
              }
              if (Math.abs(polygonArea(out)) >= 120) strips.push(out);
            }
          }
        }
        return strips;
      };
      const furlongA = a;
      const oc = [...o, o[0]];
      const okStrips = (st: Polygon[], strict: boolean) => {
        let sum = 0;
        for (const p of st) {
          sum += Math.abs(polygonArea(p));
          let cx = 0, cy = 0;
          for (const q of p) { cx += q.x; cy += q.y; if (q.x < bxA - 3 || q.x > bxB + 3 || q.y < byA - 3 || q.y > byB + 3) return false; }
          if (!polygonContains(o, { x: cx / p.length, y: cy / p.length })) return false;
          if (strict) for (const q of p) if (!polygonContains(o, q) && distToPolyline(q, oc) > 1.2) return false;
        }
        return sum <= 1.02 * furlongA + 60;
      };
      let bxA = Infinity, bxB = -Infinity, byA = Infinity, byB = -Infinity;
      for (const q of lf.rings[0]) { if (q[0] < bxA) bxA = q[0]; if (q[0] > bxB) bxB = q[0]; if (q[1] < byA) byA = q[1]; if (q[1] > byB) byB = q[1]; }
      let got = attempt(true);
      if (!okStrips(got, true)) got = attempt(false);
      if (okStrips(got, false)) strips.push(...got);
    } else {
      const furlongMP = [lf.rings as unknown as [number, number][][]];
      const ww = (u: number, v: number): [number, number] => [u * ca - v * sa, u * sa + v * ca];
      for (let sIdx = 0; sIdx < slabs; sIdx++) {
        const v0 = vlo(sIdx), v1 = v0 + ws * gaps[sIdx];
        const ring: Ring = [];
        for (const u of us) ring.push(ww(u, v0 + d(u)));
        for (let k = us.length - 1; k >= 0; k--) ring.push(ww(us[k], v1 + d(us[k])));
        ring.push(ring[0]);
        let res: ReturnType<typeof polygonClipping.intersection>;
        try { res = polygonClipping.intersection(furlongMP as never, [[ring]]); } catch { continue; }
        for (const sp of res) {
          const poly = fromRing(sp[0] as Ring);
          if (Math.abs(polygonArea(poly)) >= 120) strips.push(poly);
        }
      }
    }
    if (strips.length) fl.strips = strips;
  }
}
