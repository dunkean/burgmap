/**
 * Port (URBAN_LANDMARKS.md §2: coast or navigable river).
 *
 * Quay line: the shore stretch nearest the nucleus (or the site's harbour), on navigable water, simplified into
 * straight segments (Ramer–Douglas–Peucker, min segment length) and shifted by the simplification tolerance toward
 * the water, so the whole natural shore lies on the land side: the stone edge Q lies on the shoreline within
 * 2 × tol (the sliver between is reclaimed land).
 *
 * Partition: the quay apron (an open paved place between Q and the quay street K, the offset of Q by the apron
 * width), the harbour strip behind K (an ordinary quarter whose blocks front the quay: the warehouse row), rib
 * streets perpendicular to the quay every 50–80 m, piers / moles over the water (the only urban pieces allowed over
 * water, with slipways and mills), a shipyard with slipways beyond the quay end, and a rope walk (200–260 m) on
 * open land near the port.
 */
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import { dist, polygonCentroid, simplify } from '../../core/geom';
import type { ReserveApi, ReservedLot } from '../primary';
import { MultiPoly, differenceS, intersectionS, unionS, mpArea } from '../../geo/bool';
import { area, pointInRing, distToRing, orientPos, isSimple, segSegT } from '../../geo/poly';
import { insidePieces } from '../../geo/split';
import { dilate } from '../phases';
import { rectAt, LineIndex, findConnectorX, plLen, plAt, nearestOnPl } from './lots';
import { Mask, siteLot, gridAround } from './site';
import { giveAccess, phaseAt, type M4State } from './reserve';
import type { CompoundCtx } from '../compounds';
import { emptyOut, fits, placeRect, type Out } from './kit';
import { inscribed, obb } from '../../geo/poly';
import { frameAt } from './lots';
import type { UrbanBuilding } from '../../types';


export interface PortIn {
  avoid: Polygon[];
  nucleus: Vec2;
  harbor?: Vec2;
  roads: Polyline[];
  bridges: { a: Vec2; b: Vec2 }[];
}
export interface QuayData { kind: 'quay'; edge: Polyline; seaward: Vec2[]; main: boolean }
export interface PierData { kind: 'pier' | 'mole' | 'slipway'; base: [Vec2, Vec2]; out: Vec2 }
export interface YardData { kind: 'shipyard' | 'ropewalk'; ang: number }

/** Left offset of a polyline by d (per segment line shift, mitred joints, capped). */
export function offsetLeft(pl: Polyline, d: number): Polyline {
  const n = pl.length;
  const L = (i: number) => { const a = pl[i], b = pl[i + 1], l = dist(a, b) || 1; return { a, u: { x: (b.x - a.x) / l, y: (b.y - a.y) / l } }; };
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0 || i === n - 1) {
      const s = L(i === 0 ? 0 : n - 2);
      out.push({ x: pl[i].x - s.u.y * d, y: pl[i].y + s.u.x * d });
      continue;
    }
    const A = L(i - 1), B = L(i);
    const pa = { x: A.a.x - A.u.y * d, y: A.a.y + A.u.x * d }, pb = { x: B.a.x - B.u.y * d, y: B.a.y + B.u.x * d };
    const den = A.u.x * B.u.y - A.u.y * B.u.x;
    if (Math.abs(den) < 1e-6) { out.push({ x: pl[i].x - B.u.y * d, y: pl[i].y + B.u.x * d }); continue; }
    const t = ((pb.x - pa.x) * B.u.y - (pb.y - pa.y) * B.u.x) / den;
    const q = { x: pa.x + A.u.x * t, y: pa.y + A.u.y * t };
    if (dist(q, pl[i]) > 3 * Math.abs(d)) { out.push({ x: pl[i].x - B.u.y * d, y: pl[i].y + B.u.x * d }); continue; }
    out.push(q);
  }
  return out;
}

/** Ramer–Douglas–Peucker returning the kept indices. */
function rdpIdx(pl: Polyline, tol: number): number[] {
  const keep = new Uint8Array(pl.length);
  keep[0] = keep[pl.length - 1] = 1;
  const stack: [number, number][] = [[0, pl.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const p = pl[i], A = pl[a], B = pl[b];
      const dx = B.x - A.x, dy = B.y - A.y, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((p.x - A.x) * dx + (p.y - A.y) * dy) / l2)) : 0;
      const d = Math.hypot(p.x - A.x - t * dx, p.y - A.y - t * dy);
      if (d > md) { md = d; mi = i; }
    }
    if (mi >= 0 && md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  const out: number[] = [];
  keep.forEach((k, i) => { if (k) out.push(i); });
  return out;
}

/**
 * Straight-segment quay line: RDP with growing tolerance until every segment is ≥ minSeg (or tol hits maxTol).
 * Returns the vertices, the tolerance and, per segment, the index range of the shore points it stands for.
 */
export function straighten(run: Polyline, minSeg: number, tol0 = 2.5, maxTol = 5): { q: Polyline; tol: number; spans: [number, number][] } {
  let tol = tol0, idx = rdpIdx(run, tol);
  while (tol < maxTol) {
    let ok = true;
    for (let i = 1; i < idx.length; i++) if (dist(run[idx[i - 1]], run[idx[i]]) < minSeg) { ok = false; break; }
    if (ok) break;
    tol += 0.75;
    idx = rdpIdx(run, tol);
  }
  // drop remaining short interior segments by merging their vertices
  const keep = [idx[0]];
  for (let i = 1; i < idx.length - 1; i++) if (dist(run[keep[keep.length - 1]], run[idx[i]]) >= minSeg * 0.6) keep.push(idx[i]);
  keep.push(idx[idx.length - 1]);
  return { q: keep.map((i) => run[i]), tol, spans: keep.slice(1).map((b, i) => [keep[i], b]) };
}

/**
 * The stone edge: each straight segment shifted toward the water just enough for every shore point it stands for
 * to lie on its land side (+ 0.3 m), consecutive segment lines intersected (mitred joints).
 */
export function stoneEdge(run: Polyline, st: { q: Polyline; spans: [number, number][] }, side: number): Polyline {
  const Q = st.q;
  const lines = st.spans.map(([i0, i1], k) => {
    const a = Q[k], b = Q[k + 1], l = dist(a, b) || 1;
    const u = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
    const nw = { x: -u.y * side, y: u.x * side }; // toward the water
    let s = 0;
    for (let j = i0; j <= i1; j++) s = Math.max(s, (run[j].x - a.x) * nw.x + (run[j].y - a.y) * nw.y);
    const d = s + 0.3;
    return { p: { x: a.x + nw.x * d, y: a.y + nw.y * d }, u };
  });
  const out: Vec2[] = [];
  const hit = (A: { p: Vec2; u: Vec2 }, B: { p: Vec2; u: Vec2 }): Vec2 | null => {
    const den = A.u.x * B.u.y - A.u.y * B.u.x;
    if (Math.abs(den) < 1e-6) return null;
    const t = ((B.p.x - A.p.x) * B.u.y - (B.p.y - A.p.y) * B.u.x) / den;
    return { x: A.p.x + A.u.x * t, y: A.p.y + A.u.y * t };
  };
  const proj = (L: { p: Vec2; u: Vec2 }, q: Vec2): Vec2 => { const t = (q.x - L.p.x) * L.u.x + (q.y - L.p.y) * L.u.y; return { x: L.p.x + L.u.x * t, y: L.p.y + L.u.y * t }; };
  out.push(proj(lines[0], Q[0]));
  for (let k = 1; k < lines.length; k++) {
    const h = hit(lines[k - 1], lines[k]);
    out.push(h && dist(h, Q[k]) < 25 ? h : proj(lines[k], Q[k]));
  }
  out.push(proj(lines[lines.length - 1], Q[Q.length - 1]));
  return out;
}

const ringPoly = (a: Polyline, b: Polyline): Polygon => {
  let r = orientPos(a.concat(b.slice().reverse()));
  if (!isSimple(r)) { const u = unionS(r); r = u.length ? u.reduce((x, y) => (area(y.outer) > area(x.outer) ? y : x)).outer : []; }
  return r;
};

/** Plans the port; returns its lots (apron, harbour strip, piers, shipyard, slipways, rope walk) or [] if none. */
export function reservePort(s: M4State, api: ReserveApi, pin: PortIn): ReservedLot[] {
  const ctx = s.ctx;
  const t = ctx.terrain;
  const r = s.rng.fork('port');
  const pop = s.pop;
  const Lq = pop < 6000 ? r.range(160, 260) : pop < 25000 ? r.range(280, 460) : r.range(420, 650);
  const W = pop < 6000 ? 13 : 16; // quay apron width (stone edge → quay street centre line)
  const Dh = r.range(38, 52); // harbour strip depth
  const near = new Mask(ctx.mapSize, dilate(api.footprint, 90), 5);
  const avoidIdx = new LineIndex(pin.avoid.map((a) => ({ path: a.concat([a[0]]), hw: 0 })));
  const bridgeIdx = new LineIndex(pin.bridges.map((b) => ({ path: [b.a, b.b], hw: 6 })));
  const g = t.height, n = g.w, cell = g.cell;
  const code = (p: Vec2) => t.water[Math.min(n - 1, Math.max(0, Math.floor(p.y / cell))) * n + Math.min(n - 1, Math.max(0, Math.floor(p.x / cell)))];
  const riverW = (p: Vec2): number => {
    let bw = 0, bd = 40;
    for (const rv of t.rivers) for (let i = 0; i < rv.path.length; i += 2) { const d = dist(rv.path[i], p); if (d < bd) { bd = d; bw = rv.width[i]; } }
    return bw;
  };
  const target = pin.harbor ?? pin.nucleus;
  // ---- shore runs near the town, on navigable water, away from the other lots
  let best: { run: Polyline; d: number } | null = null;
  for (const ph of ctx.water) {
    const ring = ph.outer;
    const m = ring.length;
    if (m < 4) continue;
    const ok = ring.map((p, i) => {
      if (!near.has(p) || avoidIdx.dist(p, W + Dh + 25) < W + Dh + 20) return false;
      if (p.x < 30 || p.y < 30 || p.x > ctx.mapSize - 30 || p.y > ctx.mapSize - 30) return false;
      // probe the water next to p
      const a = ring[(i - 1 + m) % m], b = ring[(i + 1) % m];
      const ux = b.x - a.x, uy = b.y - a.y, l = Math.hypot(ux, uy) || 1;
      let q = { x: p.x - (uy / l) * 6, y: p.y + (ux / l) * 6 };
      if (!pointInRing(ring, q)) q = { x: p.x + (uy / l) * 6, y: p.y - (ux / l) * 6 };
      const c = code(q);
      if (c === 1) return true;
      if (c === 3) return riverW(q) >= 8;
      return false;
    });
    if (!ok.some(Boolean)) continue;
    let s0 = ok.findIndex((v, i) => !v && ok[(i + 1) % m]);
    if (s0 < 0) s0 = 0;
    let cur: Vec2[] = [];
    const flush = () => {
      if (cur.length >= 3 && plLen(cur) >= 90) {
        const d = Math.min(...cur.map((q) => dist(q, target)));
        if (!best || d < best.d) best = { run: cur, d };
      }
      cur = [];
    };
    for (let k = 1; k <= m; k++) { const i = (s0 + k) % m; if (ok[i]) cur.push(ring[i]); else flush(); }
    flush();
  }
  if (!best) return [];
  const run0 = (best as { run: Polyline; d: number }).run;
  // ---- window of length Lq around the point nearest the target; the shipyard continues beyond one end
  const cum = [0];
  for (let i = 1; i < run0.length; i++) cum.push(cum[i - 1] + dist(run0[i - 1], run0[i]));
  const Ltot = cum[cum.length - 1];
  let ia = 0;
  for (let i = 0; i < run0.length; i++) if (dist(run0[i], target) < dist(run0[ia], target)) ia = i;
  let s0 = Math.max(0, cum[ia] - Lq / 2), s1 = Math.min(Ltot, s0 + Lq);
  s0 = Math.max(0, s1 - Lq);
  if (s1 - s0 < 90) return [];
  const slice = (a: number, b: number): Polyline => {
    const out = [plAt(run0, a).p];
    for (let i = 0; i < run0.length; i++) if (cum[i] > a && cum[i] < b) out.push(run0[i]);
    out.push(plAt(run0, b).p);
    return out;
  };
  const runW = slice(s0, s1);
  const stq = straighten(runW, 22);
  const { q: Q, tol } = stq;
  if (Q.length < 2) return [];
  // water side: majority of the segment probes
  let left = 0;
  for (let i = 1; i < Q.length; i++) {
    const a = Q[i - 1], b = Q[i], l = dist(a, b) || 1;
    const m2 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (ctx.isWater({ x: m2.x - ((b.y - a.y) / l) * (tol + 4), y: m2.y + ((b.x - a.x) / l) * (tol + 4) })) left++; else left--;
  }
  const side = left >= 0 ? 1 : -1; // +1: water on the left of the traversal
  const Qs = stoneEdge(runW, stq, side); // the stone edge, on the water side of every shore point
  const K = offsetLeft(Qs, -side * W); // quay street centre line
  const K2 = offsetLeft(Qs, -side * (W + Dh));
  let apron = ringPoly(Qs, K);
  let strip = ringPoly(K, K2);
  if (apron.length < 3 || strip.length < 3) return [];
  // stay clear of the market and the other lots; the strip stays on land
  const clipOut = (poly: Polygon, extra: MultiPoly): Polygon[] => {
    let m: MultiPoly = [{ outer: poly, holes: [] }];
    const cut: Polygon[] = [...pin.avoid, ...(api.market ? [api.market] : [])];
    if (cut.length) m = differenceS(m, ...cut.map((c): MultiPoly => [{ outer: c, holes: [] }]));
    if (extra.length) m = differenceS(m, extra);
    return m.filter((ph) => !ph.holes.length && area(ph.outer) > 40).map((ph) => ph.outer);
  };
  const aprons = clipOut(apron, []);
  const strips = clipOut(strip, ctx.water);
  if (!aprons.length) return [];
  apron = aprons.reduce((x, y) => (area(y) > area(x) ? y : x));
  void strip;
  const out: ReservedLot[] = [];
  const phA = phaseAt(api, polygonCentroid(apron));
  // non-radial streets crossing the new pieces cut them (they were band boundaries before)
  const crossCuts = (polys: Polygon[]): Polyline[] => {
    const cuts: Polyline[] = [];
    for (const st of api.streets.list) {
      if (!st.ribbon || st.role === 'radial') continue;
      for (const p of polys) for (const pc of insidePieces(p, st.path)) if (pc.pts.length >= 2 && plLen(pc.pts) > 2) cuts.push(pc.pts);
    }
    return cuts;
  };
  const xc = crossCuts([apron, ...strips]);
  // ---- the quay street along K with rib streets inland
  const ribSp = r.range(52, 78);
  let Kp = K.slice();
  const ribStarts: { p: Vec2; dir: Vec2 }[] = [];
  const LK = plLen(Kp);
  for (let sPos = ribSp * 0.6; sPos < LK - 20; sPos += ribSp * r.range(0.85, 1.15)) {
    const at = plAt(Kp, sPos);
    const a = Kp[at.i - 1], b = Kp[at.i], l = dist(a, b) || 1;
    const dir = { x: side * ((b.y - a.y) / l), y: side * (-(b.x - a.x) / l) }; // landward
    Kp = [...Kp.slice(0, at.i), at.p, ...Kp.slice(at.i)];
    ribStarts.push({ p: at.p, dir });
  }
  const wq = s.P.widthByRank[1] * s.P.widthScale;
  const kid = api.streets.add(Kp, wq, 1, 'quay', 1);
  const cuts: Polyline[] = [];
  let connected = false;
  // a radial crossing the quay street (bridge head, harbour road) connects it
  for (const st of api.streets.list) {
    if (st.id === kid || !st.ribbon || !api.streets.connected.has(st.id)) continue;
    for (let i = 1; i < st.path.length && !connected; i++) for (let j = 1; j < Kp.length && !connected; j++) if (segSegT(st.path[i - 1], st.path[i], Kp[j - 1], Kp[j])) connected = true;
  }
  if (connected) api.streets.connected.add(kid);
  const avoidAll = [...pin.avoid];
  for (const rs of ribStarts) {
    const res = findConnectorX(ctx, api.streets, rs.p, { avoid: avoidAll, maxLen: 230, dirs: [rs.dir], preferRank: 2 });
    if (!res) continue;
    // a rib must leave the quay roughly at right angles
    const v = { x: res.path[1].x - rs.p.x, y: res.path[1].y - rs.p.y }, lv = Math.hypot(v.x, v.y) || 1;
    if ((v.x * rs.dir.x + v.y * rs.dir.y) / lv < 0.82 || lv < 12) continue;
    const id = api.streets.add(res.path, s.P.widthByRank[2] * s.P.widthScale, 2, 'street', 1);
    api.streets.connected.add(id);
    for (const m of res.met) api.streets.connected.add(m);
    api.streets.connected.add(kid);
    connected = true;
    cuts.push(res.path);
  }
  if (!connected) {
    // one connector from the quay point nearest the nucleus
    const nq = nearestOnPl(Kp, pin.nucleus);
    const res = findConnectorX(ctx, api.streets, nq.q, { avoid: avoidAll, maxLen: 420 });
    if (!res) return [];
    Kp.splice(nq.i, 0, nq.q);
    api.streets.list[kid].path = Kp;
    api.streets.list[kid].widths = Kp.map(() => wq);
    const id = api.streets.add(res.path, s.P.widthByRank[2] * s.P.widthScale, 2, 'street', 1);
    for (const m of res.met) api.streets.connected.add(m);
    api.streets.connected.add(id);
    api.streets.connected.add(kid);
    cuts.push(res.path);
  }
  out.push({ id: 'quay', kind: 'm4-quay', poly: apron, phase: phA.phase, zone: phA.zone, cuts: [...cuts, ...xc], piece: 'place' });
  s.lotData.set('quay', { kind: 'quay', edge: Qs, seaward: [], main: true } as QuayData);
  // the harbour strip, split by the enclosure line (the wall runs on a piece boundary)
  const enc = api.enclosure;
  strips.forEach((sp, i) => {
    const parts = [...intersectionS(sp, enc), ...differenceS(sp, enc)].filter((ph) => !ph.holes.length && area(ph.outer) > 150);
    parts.forEach((ph, j) => {
      const pa = phaseAt(api, polygonCentroid(ph.outer));
      out.push({ id: `harbour:${i}:${j}`, kind: 'harbour', poly: ph.outer, phase: pa.phase, zone: pa.zone, cuts: [], piece: 'quarter' });
    });
  });
  // ---- piers / moles along the stone edge (river: at most a quarter of the channel)
  const coast = code(offsetLeft([Q[0], Q[Q.length - 1]], side * 25)[0]) === 1 || ctx.isWater(pin.harbor ?? { x: -1, y: -1 });
  const piers: Polygon[] = [];
  const LQ = plLen(Qs);
  const pierSp = r.range(55, 85);
  const pierAt: number[] = [];
  for (let sPos = pierSp * 0.5; sPos < LQ - 15; sPos += pierSp) pierAt.push(sPos);
  if (coast && pierAt.length >= 2) { pierAt[0] = 6; pierAt[pierAt.length - 1] = LQ - 6; }
  pierAt.forEach((sPos, k) => {
    const at = plAt(Qs, sPos);
    const a = Qs[at.i - 1], b = Qs[at.i], l = dist(a, b) || 1;
    const u = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
    const wdir = { x: -side * u.y, y: side * u.x };
    const mole = coast && (k === 0 || k === pierAt.length - 1);
    // free water ahead (channel width for rivers)
    let free = 0;
    for (let d2 = 2; d2 < 260; d2 += 3) { if (!ctx.isWater({ x: at.p.x + wdir.x * d2, y: at.p.y + wdir.y * d2 })) break; free = d2; }
    const Lp = Math.min(mole ? r.range(55, 95) : r.range(26, 48), coast ? free - 20 : free * 0.28);
    const wp = mole ? 8 : r.range(6, 8.5);
    if (Lp < 14) return;
    // the pier starts on the edge segment (its base lies on Qs)
    const ang = Math.atan2(wdir.y, wdir.x);
    const base = { x: at.p.x, y: at.p.y };
    const poly = rectAt(base, ang, 0, Lp, -wp / 2, wp / 2);
    // its base must lie on one straight segment of the edge
    if (Math.min(dist(at.p, a), dist(at.p, b)) < wp / 2 + 1) return;
    if (bridgeIdx.dist(base, 40) < 30 || piers.some((p) => distToRing(p, base) < 18)) return;
    let wet = true;
    for (let d2 = 1; d2 <= Lp && wet; d2 += 3) for (const o of [-wp / 2 + 0.5, 0, wp / 2 - 0.5]) if (!ctx.isWater({ x: base.x + wdir.x * d2 + u.x * o, y: base.y + wdir.y * d2 + u.y * o })) wet = false;
    if (!wet) return;
    piers.push(poly);
    const id = `pier:${k}`;
    s.lotData.set(id, { kind: mole ? 'mole' : 'pier', base: [rectAt(base, ang, 0, 0, -wp / 2, wp / 2)[0], rectAt(base, ang, 0, 0, -wp / 2, wp / 2)[1]], out: wdir } as PierData);
    out.push({ id, kind: 'm4-pier', poly, phase: phA.phase, zone: phA.zone, cuts: [], piece: 'place' });
  });
  // ---- shipyard beyond the quay end away from the nucleus, with slipways
  {
    const endA = dist(Qs[0], pin.nucleus) > dist(Qs[Qs.length - 1], pin.nucleus) ? 0 : 1;
    const sa = endA === 0 ? s0 - 100 : s1 + 8, sb = endA === 0 ? s0 - 8 : s1 + 100;
    if (sa >= 0 && sb <= Ltot) {
      const runY = slice(sa, sb);
      const seg = straighten(runY, 80, 3, 8);
      if (seg.q.length === 2) {
        const Ys = stoneEdge(runY, seg, side);
        const Yb = offsetLeft(Ys, -side * r.range(42, 55));
        let yard = ringPoly(Ys, Yb);
        // the yard stands on dry land; its slipways run from the shore into the water
        const ys = yard.length >= 3 ? clipOut(yard, [{ outer: apron, holes: [] }, ...strips.map((x) => ({ outer: x, holes: [] as Polygon[] })), ...ctx.water]) : [];
        yard = ys.length ? ys.reduce((x, y) => (area(y) > area(x) ? y : x)) : [];
        if (yard.length >= 3 && area(yard) > 1500 && mpArea(intersectionS(yard, ctx.water)) < 0.12 * area(yard)) {
          const u = { x: (Ys[1].x - Ys[0].x) / dist(Ys[0], Ys[1]), y: (Ys[1].y - Ys[0].y) / dist(Ys[0], Ys[1]) };
          const wdir = { x: -side * u.y, y: side * u.x };
          const angY = Math.atan2(wdir.y, wdir.x);
          const front = (a: Vec2, b: Vec2) => { const m3 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; return !ctx.isWater({ x: m3.x - wdir.x * 3, y: m3.y - wdir.y * 3 }) && distToRing(yard, m3) < 0.5 && ((b.x - a.x) * wdir.x + (b.y - a.y) * wdir.y) ** 2 < 0.2 * dist(a, b) ** 2 && !ctx.isWater({ x: m3.x + wdir.x * 3, y: m3.y + wdir.y * 3 }) && dist(m3, Ys[0]) > 20; };
          const acc = giveAccess(s, api, yard, { mode: 'front', front, toward: { x: (Yb[0].x + Yb[1].x) / 2, y: (Yb[0].y + Yb[1].y) / 2 }, width: s.P.widthByRank[2] * s.P.widthScale, rank: 2, maxLen: 260, dirs: [{ x: -wdir.x, y: -wdir.y }] }, [...pin.avoid, apron]);
          if (acc) {
            const pa = phaseAt(api, polygonCentroid(yard));
            s.lotData.set('shipyard', { kind: 'shipyard', ang: angY } as YardData);
            out.push({ id: 'shipyard', kind: 'm4-shipyard', poly: yard, phase: pa.phase, zone: pa.zone, cuts: acc.cuts });
            s.sites.push({ id: 'shipyard', kind: 'shipyard', role: 'port', lot: yard, entrance: acc.entrance, anchor: polygonCentroid(yard), culture: s.culture });
            // slipways running into the water
            const LY = dist(Ys[0], Ys[1]);
            const nS = Math.max(1, Math.min(4, Math.floor((LY - 20) / 16)));
            for (let k = 0; k < nS; k++) {
              const q0 = { x: Ys[0].x + u.x * (14 + k * 16), y: Ys[0].y + u.y * (14 + k * 16) };
              // the slip starts a little inland (the yard, reserved first, cuts it at the shore)
              const back = seg.tol + 3;
              const p = { x: q0.x - wdir.x * back, y: q0.y - wdir.y * back };
              const Ls = r.range(26, 40) + back;
              const poly = rectAt(p, angY, 0, Ls, -4.5, 4.5);
              let wet = true;
              for (let d2 = back + 2; d2 <= Ls && wet; d2 += 3) if (!ctx.isWater({ x: p.x + wdir.x * d2, y: p.y + wdir.y * d2 })) wet = false;
              if (!wet || piers.some((pp) => distToRing(pp, p) < 12)) continue;
              const id = `slipway:${k}`;
              s.lotData.set(id, { kind: 'slipway', base: [p, p], out: wdir } as PierData);
              out.push({ id, kind: 'm4-slipway', poly, phase: pa.phase, zone: pa.zone, cuts: [], piece: 'place' });
            }
          }
        }
      }
    }
  }
  // ---- rope walk: a very long thin shed on open land near the port, parallel to the shore
  {
    const a = Q[0], b = Q[Q.length - 1];
    const ang0 = Math.atan2(b.y - a.y, b.x - a.x);
    const Lr = r.range(220, 260), Wr = 13;
    const roadIdx = new LineIndex(pin.roads.map((path) => ({ path, hw: 5 })));
    const outM = new Mask(ctx.mapSize, dilate(api.footprint, 10), 5);
    const all = [...pin.avoid, ...out.map((o) => o.poly)];
    const centers = [...gridAround(ctx, a, 380, 30), ...gridAround(ctx, b, 380, 30)].filter((p) => !outM.has(p));
    const res = siteLot(ctx, api.streets, {
      shape: (c, ang, k) => rectAt(c, ang, (-Lr / 2) * k, (Lr / 2) * k, -Wr / 2, Wr / 2),
      centers, angles: [ang0, ang0 + 0.15, ang0 - 0.15, ang0 + Math.PI / 2], scales: [1, 0.86],
      outside: outM, margin: 4, avoid: all, gap: 8,
      score: (poly, c) => (roadIdx.clear(poly, 3) ? 0 : -1e9) - Math.min(dist(c, a), dist(c, b)) / 150 - ctx.slopeAt(c) * 12,
    }, r);
    if (res) {
      const ends = [rectAt(res.c, res.ang, (-Lr / 2) * res.k, (-Lr / 2) * res.k, 0, 0)[0], rectAt(res.c, res.ang, (Lr / 2) * res.k, (Lr / 2) * res.k, 0, 0)[0]];
      const toward = dist(ends[0], pin.nucleus) < dist(ends[1], pin.nucleus) ? ends[0] : ends[1];
      const dirE = { x: (toward.x - res.c.x) / (dist(toward, res.c) || 1), y: (toward.y - res.c.y) / (dist(toward, res.c) || 1) };
      const acc = giveAccess(s, api, res.poly, { mode: 'none', toward, width: 5, rank: 3, maxLen: 260, dirs: [dirE] }, all);
      if (acc) {
        const pa = phaseAt(api, res.c);
        s.lotData.set('ropewalk', { kind: 'ropewalk', ang: res.ang } as YardData);
        out.push({ id: 'ropewalk', kind: 'm4-ropewalk', poly: res.poly, phase: pa.phase, zone: pa.zone, cuts: acc.cuts });
        s.sites.push({ id: 'ropewalk', kind: 'ropewalk', role: 'port', lot: res.poly, entrance: acc.entrance, anchor: res.c, culture: s.culture });
      }
    }
  }
  s.sites.push({ id: 'port', kind: coast ? 'harbour' : 'river-port', role: 'port', lot: apron, entrance: Kp[Math.floor(Kp.length / 2)], anchor: polygonCentroid(apron), culture: s.culture });
  s.quays = [...(s.quays ?? []), Qs];
  return out;
}

// ---------------------------------------------------------------- builders

/** Shipyard: timber yard with sheds along its landward side and timber stacks. */
export function buildShipyard(B: Polygon, cx: CompoundCtx): Out {
  const d = cx.data as YardData | undefined;
  const out = emptyOut();
  out.parcels.push({ poly: B, use: 'timber-yard' });
  const ang = d?.ang ?? 0; // toward the water
  const c = inscribed(B, [], 1).c;
  const o = obb(B);
  const along = Math.atan2(o.u.y, o.u.x);
  const back = frameAt(c, ang, -o.hv * 0.55, 0);
  const shed = placeRect(B, back, along, Math.min(18, o.hu * 0.45), 6, 1.5);
  if (shed) out.buildings.push({ poly: shed, kind: 'landmark', parcel: 0, arch: 'shipwright-shed', roof: 'gable', material: 'timber', storeys: 1, orientation: along });
  for (const k of [-0.6, 0.6]) {
    const st = placeRect(B, frameAt(c, along, o.hu * k, 0), along, 6, 2.2, 1.5);
    if (st && !out.buildings.some((b) => intersects(b.poly, st))) out.buildings.push({ poly: st, kind: 'landmark', parcel: 0, arch: 'timber-stack', roof: 'none', material: 'timber', storeys: 1 });
  }
  out.lines.push({ kind: 'compound-wall', path: orientPos(B), closed: true, width: 0.8 });
  return out;
}
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const intersects = (a: Polygon, b: Polygon): boolean => intersectionS(a, b).some((ph) => area(ph.outer) > 0.05);

/** Rope walk: one very long thin shed (the allowed "matchstick"), a hemp store at its head. */
export function buildRopewalk(B: Polygon, cx: CompoundCtx): Out {
  const d = cx.data as YardData | undefined;
  const out = emptyOut();
  out.parcels.push({ poly: B, use: 'ropewalk-yard' });
  const ang = d?.ang ?? obb(B).u.x;
  const o = obb(B);
  const c = o.c;
  const L = o.hu * 2 - 6, w = Math.min(6, o.hv * 2 - 4);
  if (L > 60 && w > 3) {
    const rw = rectAt(c, ang, -L / 2, L / 2 - 10, -w / 2, w / 2);
    if (fits(B, rw, 1)) out.buildings.push({ poly: rw, kind: 'landmark', parcel: 0, arch: 'ropewalk', roof: 'gable', material: 'timber', storeys: 1, orientation: ang });
    const hs = rectAt(c, ang, L / 2 - 8.5, L / 2, -Math.min(5, o.hv - 1.5), Math.min(5, o.hv - 1.5));
    if (fits(B, hs, 0.8)) out.buildings.push({ poly: hs, kind: 'landmark', parcel: 0, arch: 'hemp-store', roof: 'gable', material: 'timber', storeys: 2, orientation: ang });
  }
  return out;
}

/**
 * Buildings standing on the open port pieces: fish market and customs house on the quay apron (the piece nearest
 * the nucleus), chain towers at the tips of the moles, ships on the stocks of the slipways.
 */
export function portPieceBuildings(kind: string, poly: Polygon, data: unknown, nucleus: Vec2, first: boolean): Omit<UrbanBuilding, 'parcel'>[] {
  const out: Omit<UrbanBuilding, 'parcel'>[] = [];
  const o = obb(poly);
  const along = Math.atan2(o.u.y, o.u.x);
  if (kind === 'm4-quay' && first) {
    // on the straight quay segment nearest the nucleus, set back from the stone edge
    const qd = data as QuayData | undefined;
    const E = qd?.edge ?? [];
    const segs = E.slice(1).map((b, i) => ({ a: E[i], b })).sort((x, y) => dist(mid(x.a, x.b), nucleus) - dist(mid(y.a, y.b), nucleus));
    for (const sg of segs) {
      if (out.length >= 2) break;
      const l = dist(sg.a, sg.b);
      if (l < 30) continue;
      const u = { x: (sg.b.x - sg.a.x) / l, y: (sg.b.y - sg.a.y) / l };
      let nl = { x: -u.y, y: u.x };
      const m0 = mid(sg.a, sg.b);
      if (!pointInRing(poly, { x: m0.x + nl.x * 3, y: m0.y + nl.y * 3 })) nl = { x: u.y, y: -u.x };
      const along = Math.atan2(u.y, u.x);
      for (const [t, arch, hu] of [[0.3, 'fish-market', 9], [0.7, 'customs-house', 6]] as [number, string, number][]) {
        if (out.some((b) => b.arch === arch)) continue;
        const p = { x: sg.a.x + u.x * l * t + nl.x * 5, y: sg.a.y + u.y * l * t + nl.y * 5 };
        const r = rectAt(p, along, -hu, hu, -3.1, 3.1);
        if (fits(poly, r, 0.8) && !out.some((b) => intersects(b.poly, r))) out.push({ poly: r, kind: 'landmark', arch, roof: arch === 'fish-market' ? 'gable' : 'hip', material: 'stone', storeys: arch === 'fish-market' ? 1 : 2, orientation: along });
      }
    }
  }
  const pd = data as PierData | undefined;
  if (kind === 'm4-pier' && pd?.kind === 'mole') {
    // chain tower at the mole head
    const tip = { x: o.c.x + pd.out.x * (o.hu - 4.5), y: o.c.y + pd.out.y * (o.hu - 4.5) };
    const t = rectAt(tip, Math.atan2(pd.out.y, pd.out.x), -3.6, 3.6, -3.6, 3.6);
    if (fits(poly, t, 0.2)) out.push({ poly: t, kind: 'landmark', arch: 'chain-tower', roof: 'pyramidal', material: 'stone', storeys: 3 });
  }
  if (kind === 'm4-slipway' && pd) {
    // a hull on the stocks: a pointed lens along the slip
    const a = Math.atan2(pd.out.y, pd.out.x);
    const hl = Math.min(o.hu - 2, 15), hw = Math.min(o.hv - 1.2, 3.2);
    if (hl > 5 && hw > 1.5) {
      const hull = orientPos(Array.from({ length: 14 }, (_, k) => { const tt = (k / 14) * 2 * Math.PI; return frameAt(o.c, a, hl * Math.cos(tt), hw * Math.sin(tt) * (Math.cos(tt) > 0 ? 1 - 0.55 * Math.cos(tt) : 1)); }));
      if (fits(poly, hull, 0.3)) out.push({ poly: hull, kind: 'landmark', arch: 'ship-on-stocks', roof: 'none', material: 'timber', storeys: 1 });
    }
  }
  void nucleus;
  return out;
}
