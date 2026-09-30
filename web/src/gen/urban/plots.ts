/**
 * Level 3 — plots (URBAN_GEOMETRY.md §3). Exact partition of each block into street-fronting plots and back land.
 *
 * 1. Frontage: each block edge is classified by the street ribbon it lies on (rank, street id).
 * 2. Runs: consecutive frontage edges with small turns form frontage runs.
 * 3. Territories (α/β strips): each run sweeps inward to its depth (capped at ~half the local block width, so
 *    opposite runs meet near the medial line). Runs are processed by priority (street rank, then length); a
 *    higher-priority run's sweep is extended around convex corners along the neighbouring street, and later
 *    runs only get what is left (boolean difference) — the corner plots face the more important street.
 *    This replaces the straight-skeleton construction of §3.2 (see report: CGAL-WASM was too slow).
 * 4. Each territory is cut into plots by straight chords along the fanned inward normals of the run.
 * 5. Back land = block minus territories; slivers are merged into the adjacent plot.
 */
import type { Vec2, Polygon, Polyline } from '../core/geom';
import { dist, polygonArea } from '../core/geom';
import type { Rng } from '../core/rng';
import type { MorphologyParams, Zone } from './morphology';
import type { Streets } from './streets';
import { MultiPoly, PolyH, intersectionS, differenceS, difference, unionS, mpArea } from '../geo/bool';
import { area, interiorAngle, pointInRing, distToSeg, inscribed, cleanRing, orientPos, bboxOf, snapPt, isSimple, convexWidth } from '../geo/poly';
import { sweepLeft } from '../geo/offset';
import { stitchUnion } from '../geo/stitch';
import { rayHit, splitByChord, lpoly, isConvex } from '../geo/split';

export interface Plot {
  poly: Polygon;
  block: number;
  zone: Zone;
  /** Frontage segment on the street and inward unit normal. */
  front: [Vec2, Vec2];
  nrm: Vec2;
  /** Side lines (point on frontage + inward direction) at both ends of the frontage. */
  sideA: { p: Vec2; d: Vec2 };
  sideB: { p: Vec2; d: Vec2 };
  rank: number;
  depth: number;
  wide: boolean;
  /** Other street-facing edges of the plot (corner plots), as segments. */
  sideFronts: [Vec2, Vec2][];
}

interface Run { pts: Vec2[]; edges: number[]; rank: number; street: number; len: number; prio: number }

const TURN = (20 * Math.PI) / 180;

function turnAt(a: Vec2, b: Vec2, c: Vec2): number {
  const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
  return Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
}

const unit = (a: Vec2, b: Vec2): Vec2 => { const l = dist(a, b) || 1; return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; };
const leftN = (d: Vec2): Vec2 => ({ x: -d.y, y: d.x });

/** Point and inward normal at arclength s along an open polyline (normal averaged over ±win). */
function pointAt(pl: Vec2[], cum: number[], s: number): { p: Vec2; seg: number } {
  let i = 1;
  while (i < pl.length - 1 && cum[i] < s) i++;
  const a = pl[i - 1], b = pl[i];
  const L = cum[i] - cum[i - 1] || 1;
  const t = Math.max(0, Math.min(1, (s - cum[i - 1]) / L));
  return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, seg: i - 1 };
}
function normalAt(pl: Vec2[], cum: number[], s: number, win: number): Vec2 {
  const a = pointAt(pl, cum, Math.max(0, s - win)).p, b = pointAt(pl, cum, Math.min(cum[cum.length - 1], s + win)).p;
  return leftN(unit(a, b));
}

export interface PlotResult { plots: Plot[]; back: Polygon[] }

function polyCenter(p: Polygon): Vec2 {
  // a point strictly inside (inscribed-circle center), robust for concave rings
  return inscribed(p, [], 0.2).c;
}

/** Splits a polygon with holes by lines through its holes until every piece is hole-free. */
export function openHoles(ph: PolyH, depth = 0): MultiPoly {
  if (!ph.holes.length || depth > 4) return [{ outer: ph.outer, holes: [] }];
  const h = ph.holes[0];
  const c = polyCenter(h);
  const bb = bboxOf(ph.outer);
  const W = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) + 10;
  const left = [{ x: c.x - W, y: bb.y0 - W }, { x: c.x, y: bb.y0 - W }, { x: c.x, y: bb.y1 + W }, { x: c.x - W, y: bb.y1 + W }];
  const right = [{ x: c.x, y: bb.y0 - W }, { x: c.x + W, y: bb.y0 - W }, { x: c.x + W, y: bb.y1 + W }, { x: c.x, y: bb.y1 + W }];
  const out: MultiPoly = [];
  for (const half of [left, right]) for (const q of intersectionS([ph], half)) out.push(...openHoles(q, depth + 1));
  return out;
}

export function cutPlots(
  block: Polygon, bi: number, zone: Zone, infill: number, P: MorphologyParams, streets: Streets, rng: Rng,
): PlotResult {
  const B = orientPos(block);
  const n = B.length;
  // ---- 1. frontage classification
  const fr: { rank: number; street: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = B[i], b = B[(i + 1) % n];
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const ns = streets.nearest(m, 14);
    let ok = false;
    if (ns) {
      const tol = Math.max(0.8, 0.3 * ns.hw);
      if (Math.abs(ns.d - ns.hw) < tol || (ns.d < ns.hw * 1.3 && ns.d > ns.hw * 0.7)) {
        // the street must lie on the outer side of the edge
        const d = unit(a, b), o = { x: d.y, y: -d.x };
        const q = { x: m.x + o.x * ns.d, y: m.y + o.y * ns.d };
        const back = streets.nearest(q, ns.hw + 1.5);
        ok = !!back;
      }
    }
    fr.push(ok ? { rank: streets.list[ns!.s].rank, street: ns!.s } : { rank: 99, street: -1 });
  }
  // ---- 2. runs
  const isF = (i: number) => fr[(i + n) % n].street >= 0;
  const brk = (i: number): boolean => { // break between edge i-1 and edge i
    const i0 = (i - 1 + n) % n;
    if (isF(i0) !== isF(i)) return true;
    if (!isF(i)) return false;
    return turnAt(B[i0], B[i], B[(i + 1) % n]) > TURN;
  };
  let start = -1;
  for (let i = 0; i < n; i++) if (brk(i)) { start = i; break; }
  const runs: Run[] = [];
  const pushRun = (edges: number[]) => {
    if (!edges.length || !isF(edges[0])) return;
    const pts = [B[edges[0]], ...edges.map((e) => B[(e + 1) % n])];
    let len = 0;
    for (let k = 1; k < pts.length; k++) len += dist(pts[k - 1], pts[k]);
    let rank = 99; const cnt = new Map<number, number>();
    for (const e of edges) { rank = Math.min(rank, fr[e].rank); cnt.set(fr[e].street, (cnt.get(fr[e].street) ?? 0) + dist(B[e], B[(e + 1) % n])); }
    let street = -1, bl = -1;
    for (const [s, l] of cnt) if (l > bl) { bl = l; street = s; }
    runs.push({ pts, edges, rank, street, len, prio: 0 });
  };
  if (start < 0) {
    // one closed frontage loop (a street all around): open it at the sharpest vertex
    if (!isF(0)) return { plots: [], back: [B] };
    let si = 0, st = -1;
    for (let i = 0; i < n; i++) { const t = turnAt(B[(i - 1 + n) % n], B[i], B[(i + 1) % n]); if (t > st) { st = t; si = i; } }
    const edges: number[] = [];
    for (let k = 0; k < n; k++) edges.push((si + k) % n);
    pushRun(edges);
  } else {
    let cur: number[] = [];
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      if (k > 0 && brk(i)) { pushRun(cur); cur = []; }
      cur.push(i);
    }
    pushRun(cur);
  }
  const good = runs.filter((r) => r.len >= 4);
  if (!good.length) return { plots: [], back: [B] };
  // priority: lower rank first, then longer
  good.sort((a, b) => a.rank - b.rank || b.len - a.len);
  good.forEach((r, i) => (r.prio = i));
  const byStartVertex = new Map<number, Run>();
  const byEndVertex = new Map<number, Run>();
  for (const r of good) { byStartVertex.set(r.edges[0], r); byEndVertex.set((r.edges[r.edges.length - 1] + 1) % n, r); }

  // ---- depth per run vertex (medial cap)
  const [dmin, dmax] = P.plotDepth[zone];
  const territories: { run: Run; poly: MultiPoly; depth: number }[] = [];
  let taken: MultiPoly = [];
  const deepFill = infill > 0.85;
  for (const run of good) {
    const pl = run.pts.slice();
    const dz = dmin + (dmax - dmin) * rng.float();
    const nr = pl.map((_, j) => {
      const a = pl[Math.max(0, j - 1)], b = pl[Math.min(pl.length - 1, j + 1)];
      return leftN(unit(a, b));
    });
    let depth = pl.map((p, j) => {
      const q = { x: p.x + nr[j].x * 0.05, y: p.y + nr[j].y * 0.05 };
      const h = rayHit(B, q, nr[j]);
      if (!h) return dz;
      const farFront = isF(h.edge);
      // opposite runs meet near the medial line; a much more important street takes a larger share
      const frac = Math.max(0.5, Math.min(0.85, 0.5 + 0.17 * (fr[h.edge].rank - run.rank)));
      const cap = farFront ? frac * h.t + 1.2 : h.t + 0.5;
      return deepFill ? Math.max(Math.min(dz, cap), Math.min(cap, h.t * 0.5 + 1.2)) : Math.min(dz, cap);
    });
    // smooth depths along the run
    depth = depth.map((_, j) => {
      let s = 0, w = 0;
      for (let k = Math.max(0, j - 2); k <= Math.min(depth.length - 1, j + 2); k++) { s += depth[k]; w++; }
      return Math.min(depth[j] + 2, s / w);
    });
    // ---- corner handling: extend along the neighbouring edge at convex corners
    let startDir: Vec2 | undefined, endDir: Vec2 | undefined, startLen: number | undefined, endLen: number | undefined;
    const sv = run.edges[0], ev = (run.edges[run.edges.length - 1] + 1) % n;
    const prevRun = byEndVertex.get(sv), nextRun = byStartVertex.get(ev);
    const angS = interiorAngle(B, sv), angE = interiorAngle(B, ev);
    const leadS = !prevRun || prevRun.prio > run.prio;
    const leadE = !nextRun || nextRun.prio > run.prio;
    if (leadE && angE >= Math.PI / 2 - 0.05 && angE < Math.PI - 0.1) {
      const u = unit(B[ev], B[(ev + 1) % n]);
      endDir = u; endLen = Math.min(2.2 * depth[depth.length - 1], depth[depth.length - 1] / Math.max(0.3, Math.sin(angE)));
    }
    if (leadS && angS >= Math.PI / 2 - 0.05 && angS < Math.PI - 0.1) {
      const u = unit(B[sv], B[(sv - 1 + n) % n]);
      startDir = u; startLen = Math.min(2.2 * depth[0], depth[0] / Math.max(0.3, Math.sin(angS)));
    }
    const S = sweepLeft(pl, depth, startDir, endDir, startLen, endLen);
    if (S.length < 3) continue;
    let T = intersectionS(B, S);
    if (taken.length) {
      const tb = T.length ? bboxOf(T.flatMap((ph) => ph.outer)) : null;
      const prev = tb ? taken.filter((ph) => { const b = bboxOf(ph.outer); return !(b.x0 > tb.x1 || b.x1 < tb.x0 || b.y0 > tb.y1 || b.y1 < tb.y0); }) : [];
      if (prev.length) T = differenceS(T, ...prev.map((ph) => [ph] as MultiPoly));
    }
    // keep the pieces touching the run
    T = T.filter((ph) => {
      if (area(ph.outer) < 4) return false;
      for (let j = 1; j < pl.length; j++) {
        const m = { x: (pl[j - 1].x + pl[j].x) / 2, y: (pl[j - 1].y + pl[j].y) / 2 };
        for (let k = 0; k < ph.outer.length; k++) if (distToSeg(m, ph.outer[k], ph.outer[(k + 1) % ph.outer.length]) < 0.05) return true;
      }
      return false;
    });
    if (!T.length) continue;
    // plots never have holes: back land fully enclosed by a territory joins it; a hole holding an earlier
    // territory is opened by splitting the piece through it
    const T2: MultiPoly = [];
    for (const ph of T) {
      const keep = ph.holes.filter((h) => {
        const c = polyCenter(h);
        return taken.some((t) => pointInRing(t.outer, c));
      });
      if (!keep.length) { T2.push({ outer: ph.outer, holes: [] }); continue; }
      for (const piece of openHoles({ outer: ph.outer, holes: keep })) T2.push(piece);
    }
    T = T2;
    taken = taken.concat(T);
    territories.push({ run, poly: T, depth: dz });
  }
  // ---- 4. cut territories into plots
  const plots: Plot[] = [];
  const [fwMin, fwMax] = P.frontage[zone];
  const tiltMax = (P.plotTilt * Math.PI) / 180;
  const leftovers: Polygon[] = [];
  for (const { run, poly: T, depth } of territories) {
    const pl = run.pts;
    const cum = [0];
    for (let j = 1; j < pl.length; j++) cum.push(cum[j - 1] + dist(pl[j - 1], pl[j]));
    const L = cum[cum.length - 1];
    for (const ph of T) {
      if (ph.holes.length) { leftovers.push(ph.outer); continue; }
      // frontage interval of this piece along the run
      let s0 = -1, s1 = -1;
      for (let s = 0.25; s <= L - 0.25; s += 0.5) {
        const pa = pointAt(pl, cum, s);
        const nn = leftN(unit(pl[pa.seg], pl[pa.seg + 1]));
        const q = { x: pa.p.x + nn.x * 0.08, y: pa.p.y + nn.y * 0.08 };
        if (pointInRing(ph.outer, q)) { if (s0 < 0) s0 = s; s1 = s; }
      }
      if (s0 < 0 || s1 - s0 < 2.5) { leftovers.push(ph.outer); continue; }
      s0 = Math.max(0, s0 - 0.25); s1 = Math.min(L, s1 + 0.25);
      const FL = s1 - s0;
      // plot widths
      const widths: number[] = [];
      let acc = 0;
      while (acc < FL) {
        let w = fwMin + (fwMax - fwMin) * rng.float();
        if (rng.chance(P.wideLotChance)) w *= rng.range(1.8, 2.8);
        widths.push(w); acc += w;
      }
      if (widths.length > 1 && acc - FL > 0.5 * widths[widths.length - 1]) { acc -= widths.pop()!; }
      const k = FL / acc;
      const cuts: number[] = [];
      let s = s0;
      for (let j = 0; j < widths.length - 1; j++) { s += widths[j] * k; cuts.push(s); }
      // walk the cuts, splitting the remaining polygon by chords along the (fanned, tilted) normals
      let rem = lpoly(ph.outer, 0);
      let prevS = s0;
      let tilt = 0;
      let prevSide: { p: Vec2; d: Vec2 } = { p: pointAt(pl, cum, s0).p, d: normalAt(pl, cum, s0, 3) };
      for (let j = 0; j <= cuts.length; j++) {
        const last = j === cuts.length;
        const sc = last ? s1 : cuts[j];
        const w = sc - prevS;
        let plotPoly: Polygon | null = null;
        let side: { p: Vec2; d: Vec2 };
        if (!last) {
          const pp = pointAt(pl, cum, sc).p;
          tilt = Math.max(-tiltMax, Math.min(tiltMax, 0.6 * tilt + rng.range(-0.6, 0.6) * tiltMax));
          const nn = normalAt(pl, cum, sc, Math.max(2, w / 2));
          const c = Math.cos(tilt), si = Math.sin(tilt);
          const d = { x: nn.x * c - nn.y * si, y: nn.x * si + nn.y * c };
          side = { p: pp, d };
          const h = rayHit(rem.pts, { x: pp.x + d.x * 0.02, y: pp.y + d.y * 0.02 }, d, 1e4, 0.01);
          const res = h ? splitByChord(rem, [pp, h.p], 0) : null;
          if (!res) { continue; }
          // the plot is the part holding the frontage just before the cut
          const tp = pointAt(pl, cum, Math.max(prevS, sc - Math.min(0.5, w / 2)));
          const tn = normalAt(pl, cum, sc, 1);
          const probe = { x: tp.p.x + tn.x * 0.08, y: tp.p.y + tn.y * 0.08 };
          const [A, Bp] = res;
          if (pointInRing(A.pts, probe)) { plotPoly = A.pts; rem = Bp; }
          else { plotPoly = Bp.pts; rem = A; }
        } else {
          plotPoly = rem.pts;
          side = { p: pointAt(pl, cum, s1).p, d: normalAt(pl, cum, s1, 3) };
        }
        const fa = pointAt(pl, cum, prevS).p, fb = pointAt(pl, cum, sc).p;
        const nrm = normalAt(pl, cum, (prevS + sc) / 2, Math.max(2, w / 2));
        plots.push({ poly: plotPoly, block: bi, zone, front: [fa, fb], nrm, sideA: prevSide, sideB: side, rank: run.rank, depth, wide: w > fwMax * 1.5, sideFronts: [] });
        prevSide = side;
        prevS = sc;
      }
    }
  }
  // ---- 5. back land = block − territories
  let backMP: MultiPoly = taken.length ? differenceS(B, ...taken.map((ph) => [ph] as MultiPoly)) : [{ outer: B, holes: [] }];
  // area accounting: the snapped boolean occasionally drops a real sliver; redo it exactly if so
  const covered = taken.reduce((a, ph) => a + area(ph.outer), 0) + mpArea(backMP);
  if (taken.length && area(B) - covered > Math.max(0.3, 0.001 * area(B))) backMP = difference(B, ...taken.map((ph) => [ph] as MultiPoly));
  const gardens: Polygon[] = [...leftovers];
  for (const ph of backMP) {
    if (!ph.holes.length) { gardens.push(ph.outer); continue; }
    // rare: back land around an island of plots; keep it exact by cutting it open with the island
    const pieces = differenceS(ph.outer, ...ph.holes.map((h) => [{ outer: h, holes: [] }] as MultiPoly));
    for (const q of pieces) gardens.push(q.outer);
  }
  // ---- 6. cleanup: slivers, acute wedges and tiny pieces merge into the neighbour sharing the longest edge
  type Cell = { poly: Polygon; plot: Plot | null };
  const cells: Cell[] = plots.map((p) => ({ poly: p.poly, plot: p as Plot | null })).concat(gardens.map((g) => ({ poly: g, plot: null })));
  const minAng = (p: Polygon) => { let m = Infinity; for (let i = 0; i < p.length; i++) m = Math.min(m, interiorAngle(p, i)); return m; };
  const isBad = (c: Cell): boolean => {
    const a = area(c.poly);
    if (a < (c.plot ? 35 : 25)) return true;
    if (c.plot && dist(c.plot.front[0], c.plot.front[1]) < 3.5) return true;
    if (minAng(c.poly) < (15 * Math.PI) / 180) return true;
    if (a >= 600) return false;
    return (isConvex(c.poly, 1e-3) ? convexWidth(c.poly) / 2 : inscribed(c.poly, [], 0.2).r) < 1.25;
  };
  const shared = (X: Polygon, Y: Polygon): number => {
    let s2 = 0;
    for (let k = 0; k < X.length; k++) {
      const a = X[k], b = X[(k + 1) % X.length];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      for (let j = 0; j < Y.length; j++) if (distToSeg(m, Y[j], Y[(j + 1) % Y.length]) < 0.05) { s2 += dist(a, b); break; }
    }
    return s2;
  };
  const bbs = cells.map((c) => bboxOf(c.poly));
  const bad = cells.map((c) => isBad(c));
  const near = (i: number, j: number) => {
    const a = bbs[i], b = bbs[j];
    return !(b.x0 > a.x1 + 0.1 || b.x1 < a.x0 - 0.1 || b.y0 > a.y1 + 0.1 || b.y1 < a.y0 - 0.1);
  };
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c || !bad[i]) continue;
      let best = -1, bl = 0;
      for (let j = 0; j < cells.length; j++) {
        if (j === i || !cells[j] || !near(i, j)) continue;
        let sh = shared(c.poly, cells[j].poly);
        if (sh <= 0) continue;
        if (c.plot && cells[j].plot) sh *= 1.5; // plots prefer plots
        if (!c.plot && cells[j].plot && area(c.poly) > 150) sh *= 0.5; // real gardens stay gardens
        if (sh > bl) { bl = sh; best = j; }
      }
      if (best < 0) continue;
      const st = stitchUnion(cells[best].poly, c.poly);
      let merged1: Polygon | null = st;
      if (!merged1) {
        const u = unionS(cells[best].poly, c.poly);
        if (u.length === 1 && !u[0].holes.length) merged1 = u[0].outer;
      }
      if (!merged1) continue;
      const tgt = cells[best];
      // a plot swallowed by a garden keeps its frontage: the merged cell becomes the plot
      if (c.plot && !tgt.plot) { if (dist(c.plot.front[0], c.plot.front[1]) >= 3.5) tgt.plot = c.plot; }
      else if (c.plot && tgt.plot && dist(tgt.plot.front[1], c.plot.front[0]) < 0.05) { tgt.plot.front = [tgt.plot.front[0], c.plot.front[1]]; tgt.plot.sideB = c.plot.sideB; }
      else if (c.plot && tgt.plot && dist(c.plot.front[1], tgt.plot.front[0]) < 0.05) { tgt.plot.front = [c.plot.front[0], tgt.plot.front[1]]; tgt.plot.sideA = c.plot.sideA; }
      tgt.poly = merged1;
      bbs[best] = bboxOf(tgt.poly);
      bad[best] = isBad(tgt);
      (cells as (Cell | null)[])[i] = null;
      changed = true;
    }
    if (!changed) break;
  }
  const merged: Plot[] = [];
  const keepBack: Polygon[] = [];
  for (const c of cells) {
    if (!c) continue;
    const poly = cleanRing(c.poly, 0.005, 0.5, 0.002, false);
    const pp = poly.length >= 3 && isSimple(poly) ? poly : c.poly;
    if (c.plot) { c.plot.poly = pp; merged.push(c.plot); } else keepBack.push(pp);
  }
  // side fronts: plot edges lying on a frontage edge of the block, not parallel to the main frontage
  const frontEdges: [Vec2, Vec2][] = [];
  for (let i = 0; i < n; i++) if (isF(i)) frontEdges.push([B[i], B[(i + 1) % n]]);
  // final guarantee (§6.3): every plot has ≥ 3 m of boundary on a street frontage; others merge into the
  // neighbouring plot sharing the longest edge, or become back land
  const onStreet = (q: Vec2): boolean => {
    const ns = streets.nearest(q, 12);
    return !!ns && (Math.abs(ns.d - ns.hw) < Math.max(0.5, 0.25 * ns.hw) || ns.d < ns.hw);
  };
  const frontLen = (P: Polygon): number => {
    let L = 0;
    for (let k = 0; k < P.length && L < 3.2; k++) {
      const a = P[k], b = P[(k + 1) % P.length];
      const le = dist(a, b), m = Math.max(1, Math.ceil(le / 0.5));
      for (let j = 0; j < m; j++) {
        const t = (j + 0.5) / m;
        if (onStreet({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) L += le / m;
      }
    }
    return L;
  };
  for (let i = 0; i < merged.length; i++) {
    const p = merged[i];
    if (!p || frontLen(p.poly) >= 3.2) continue;
    let best = -1, bl = 0;
    for (let j = 0; j < merged.length; j++) {
      if (j === i || !merged[j] || frontLen(merged[j].poly) < 3.2) continue;
      const sh = shared(p.poly, merged[j].poly);
      if (sh > bl) { bl = sh; best = j; }
    }
    let joined: Polygon | null = null;
    if (best >= 0) {
      joined = stitchUnion(merged[best].poly, p.poly);
      if (!joined) { const u = unionS(merged[best].poly, p.poly); if (u.length === 1 && !u[0].holes.length) joined = u[0].outer; }
    }
    if (joined) merged[best].poly = joined;
    else keepBack.push(p.poly);
    (merged as (Plot | null)[])[i] = null;
  }
  for (let i = merged.length - 1; i >= 0; i--) if (!merged[i]) merged.splice(i, 1);
  for (const p of merged) {
    const t = unit(p.front[0], p.front[1]);
    const segs: [Vec2, Vec2][] = [];
    for (let k = 0; k < p.poly.length; k++) {
      const a = p.poly[k], b = p.poly[(k + 1) % p.poly.length];
      const l = dist(a, b);
      if (l < 1) continue;
      const u = unit(a, b);
      if (Math.abs(u.x * t.x + u.y * t.y) > 0.85) continue; // parallel to the main frontage
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (frontEdges.some(([c, d]) => distToSeg(m, c, d) < 0.05)) segs.push([a, b]);
    }
    // merge consecutive collinear-ish segments
    const out: [Vec2, Vec2][] = [];
    for (const sg of segs) {
      const last = out[out.length - 1];
      if (last && dist(last[1], sg[0]) < 0.01) { last[1] = sg[1]; continue; }
      out.push([sg[0], sg[1]]);
    }
    p.sideFronts = out.filter(([a, b]) => dist(a, b) >= 3.5);
  }
  return { plots: merged.filter((p) => p.poly.length >= 3), back: keepBack };
}
