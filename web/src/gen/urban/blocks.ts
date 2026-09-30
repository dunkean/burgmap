/**
 * Level 2 — blocks by guided recursive splitting (URBAN_GEOMETRY.md §2). Every cut is a street; pieces that
 * are small forks become places; deep blocks get closes (slits); blocks = pieces minus street ribbons.
 */
import type { Vec2, Polygon, Polyline } from '../core/geom';
import { dist, polygonCentroid, simplify } from '../core/geom';
import type { Rng } from '../core/rng';
import { smoothstep } from '../core/field';
import type { UrbanCtx } from './context';
import type { Zone } from './morphology';
import type { Quarter } from './primary';
import type { GuidanceField } from './field';
import { Streets, jitterWidths, LAB_WALL } from './streets';
import { LPoly, splitByChord, rayHit, locate } from '../geo/split';
import { area, obb, inscribed, interiorAngle, pointInRing, cleanRing, bboxOf } from '../geo/poly';
import { GridIndex } from '../geo/spatial';
import { MultiPoly, union, difference, mpArea } from '../geo/bool';
import { ribbon, disk } from '../geo/offset';

export type PieceKind = 'block' | 'place' | 'market';
export interface Piece { lp: LPoly; phase: number; zone: Zone; age: number; quarter: number; kind: PieceKind; level: number }

const TMP_LABEL = -100;

interface Cand { A: LPoly; B: LPoly; chord: Polyline; cost: number; placeA: boolean; placeB: boolean; rank: number }

function isJunction(lp: LPoly, i: number): boolean {
  const n = lp.pts.length;
  const lPrev = lp.lab[(i - 1 + n) % n], lNext = lp.lab[i];
  if (lPrev !== lNext && (lPrev >= 0 || lNext >= 0)) return true;
  return interiorAngle(lp.pts, i) < (150 * Math.PI) / 180;
}

/** Snap chord ends to junction vertices of the piece within r. */
function snapEnds(lp: LPoly, chord: Polyline, r: number): Polyline {
  const out = chord.slice();
  for (const end of [0, out.length - 1]) {
    const p = out[end];
    let bi = -1, bd = r;
    for (let i = 0; i < lp.pts.length; i++) {
      const d = dist(lp.pts[i], p);
      if (d < bd && isJunction(lp, i)) { bd = d; bi = i; }
    }
    if (bi >= 0) out[end] = lp.pts[bi];
  }
  return out;
}

function endLabel(lp: LPoly, p: Vec2): number {
  let best = -1, bd = Infinity;
  const n = lp.pts.length;
  for (let i = 0; i < n; i++) {
    const a = lp.pts[i], b = lp.pts[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const d = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    if (d < bd - 1e-9) { bd = d; best = lp.lab[i]; }
    else if (Math.abs(d - bd) < 1e-6 && lp.lab[i] >= 0) best = lp.lab[i];
  }
  return best;
}

/** Interior angles of piece X at the two chord end vertices. */
function endAngles(X: LPoly, a: Vec2, b: Vec2): number[] {
  const out: number[] = [];
  for (let i = 0; i < X.pts.length; i++) {
    const q = X.pts[i];
    if ((q.x === a.x && q.y === a.y) || (q.x === b.x && q.y === b.y)) out.push(interiorAngle(X.pts, i));
  }
  return out;
}

export interface SplitOpts { nucleus: Vec2; gridAngle: number }

export function splitQuarter(ctx: UrbanCtx, q: Quarter, qi: number, streets: Streets, field: GuidanceField, o: SplitOpts, rng: Rng): Piece[] {
  const P = ctx.params;
  const out: Piece[] = [];
  const root: Piece = { lp: q.lp, phase: q.phase, zone: q.zone, age: q.age, quarter: qi, kind: q.kind === 'market' ? 'market' : 'block', level: 1 };
  if (root.kind === 'market') return [root];
  const queue: Piece[] = [root];
  const maxTurn = (P.curvature * 10 * Math.PI) / 180;
  let places = 0;
  let guard = 0;
  while (queue.length && guard++ < 4000) {
    const pc = queue.pop()!;
    if (pc.kind !== 'block') { out.push(pc); continue; }
    const pts = pc.lp.pts;
    const A0 = area(pts);
    const ob = obb(pts);
    const [bmin, bmax] = P.blockSize[pc.zone];
    const dn = dist(ob.c, o.nucleus);
    let target = bmin * Math.pow(bmax / bmin, rng.float());
    target *= 0.65 + 0.35 * smoothstep(dn, 50, 320);
    const aspect = ob.hu / Math.max(1, ob.hv);
    if ((A0 < target && aspect < 2.6) || A0 < 2 * P.minBlock) { out.push(pc); continue; }
    const cands: Cand[] = [];
    const th = field.angle(ob.c);
    const fams = [th, th + Math.PI / 2];
    const perp = fams.map((f) => Math.abs(Math.cos(f) * ob.u.x + Math.sin(f) * ob.u.y));
    const order = perp[0] <= perp[1] ? [0, 1] : [1, 0];
    const rank = Math.min(3, pc.level + 1);
    const seeds: Vec2[][] = [[], []];
    if (P.streetOp === 'grid') {
      // lattice lines of each family
      for (const fi of [0, 1]) {
        const f = fams[fi];
        const d = { x: Math.cos(f), y: Math.sin(f) }, nrm = { x: -d.y, y: d.x };
        const sp = P.gridSpacing[Math.abs(Math.cos(f - o.gridAngle)) > 0.7 ? 0 : 1];
        let m0 = Infinity, m1 = -Infinity;
        for (const q2 of pts) { const m = (q2.x - o.nucleus.x) * nrm.x + (q2.y - o.nucleus.y) * nrm.y; m0 = Math.min(m0, m); m1 = Math.max(m1, m); }
        const cm = (ob.c.x - o.nucleus.x) * nrm.x + (ob.c.y - o.nucleus.y) * nrm.y;
        const lines: number[] = [];
        for (let k = Math.ceil((m0 + P.minWidth) / sp); k * sp < m1 - P.minWidth; k++) lines.push(k * sp + sp / 2);
        lines.sort((a, b) => Math.abs(a - cm) - Math.abs(b - cm));
        for (const L of lines.slice(0, 3)) seeds[fi].push({ x: ob.c.x + nrm.x * (L - cm), y: ob.c.y + nrm.y * (L - cm) });
      }
    } else {
      for (const fi of [0, 1]) for (const t of [0.5, 0.4, 0.6, 0.33, 0.67]) {
        const tt = t + rng.range(-0.04, 0.04);
        const off = rng.range(-0.15, 0.15) * ob.hv;
        seeds[fi].push({ x: ob.c.x + ob.u.x * (tt - 0.5) * 2 * ob.hu * 0.92 + ob.v.x * off, y: ob.c.y + ob.u.y * (tt - 0.5) * 2 * ob.hu * 0.92 + ob.v.y * off });
      }
    }
    // access seeds: streamlines entering from the middle of street edges (needed when a piece touches
    // streets only along a short part of its boundary)
    const access: { p: Vec2; h: number }[] = [];
    if (P.streetOp === 'organic') {
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        if (pc.lp.lab[i] < 0) continue;
        const a = pts[i], b = pts[(i + 1) % n];
        const l = dist(a, b);
        if (l < 12) continue;
        const nx = -(b.y - a.y) / l, ny = (b.x - a.x) / l;
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const p0 = { x: m.x + nx * 0.05, y: m.y + ny * 0.05 };
        access.push({ p: m, h: field.follow(p0, Math.atan2(ny, nx)) });
      }
      access.sort((x, y) => dist(y.p, ob.c) - dist(x.p, ob.c));
    }
    const tries: { seed: Vec2; fi: number; entry?: number; bonus: number }[] = [];
    for (const fi of order) for (const seed of seeds[fi]) tries.push({ seed, fi, bonus: 0 });
    for (const ac of access.slice(-4)) tries.push({ seed: ac.p, fi: -1, entry: ac.h, bonus: 0.25 });
    // continuation seeds: carry streets that T into this piece's boundary across it (crossroads, long streets)
    if (P.streetOp === 'organic') {
      for (const st of streets.query(pts, 12)) {
        if (st.rank < 2 || st.role === 'close' || st.path.length < 2) continue;
        for (const end of [0, st.path.length - 1]) {
          const e = st.path[end], e2 = st.path[end === 0 ? 1 : st.path.length - 2];
          if (pointInRing(pts, e)) continue;
          const loc = locate(pts, e);
          if (loc.d > 7 || loc.d < 0.5 || pc.lp.lab[loc.edge] < 0) continue;
          const a = pts[loc.edge], b = pts[(loc.edge + 1) % pts.length];
          const q = { x: a.x + (b.x - a.x) * loc.t, y: a.y + (b.y - a.y) * loc.t };
          if (dist(q, a) < 3 || dist(q, b) < 3) continue;
          const h = Math.atan2(e.y - e2.y, e.x - e2.x);
          tries.push({ seed: q, fi: -1, entry: h, bonus: -0.3 });
        }
      }
    }
    for (const tr of tries) {
      const fi = tr.fi;
      const famPenalty = fi < 0 ? 0 : fi === order[0] ? 0 : 0.35;
      const seed = tr.seed;
      let chord: Polyline;
      if (tr.entry !== undefined) {
        const inPt = { x: seed.x + Math.cos(tr.entry) * 0.02, y: seed.y + Math.sin(tr.entry) * 0.02 };
        if (!pointInRing(pts, inPt)) continue;
        const fwd = field.trace(pts, inPt, tr.entry, maxTurn);
        if (!fwd) continue;
        chord = [seed, ...fwd.slice(1)];
      } else {
        if (!pointInRing(pts, seed)) continue;
        const f = fams[fi];
        const fwd = field.trace(pts, seed, f, maxTurn);
        const back = field.trace(pts, seed, f + Math.PI, maxTurn);
        if (!fwd || !back) continue;
        chord = back.slice().reverse().concat(fwd.slice(1));
      }
      chord = simplify(chord, 0.25);
      const snapped = tr.entry !== undefined ? [chord[0], ...snapEnds(pc.lp, chord, 6).slice(1)] : snapEnds(pc.lp, chord, 6);
      let res = splitByChord(pc.lp, snapped, TMP_LABEL);
      let used = snapped;
      if (!res) { res = splitByChord(pc.lp, chord, TMP_LABEL); used = chord; }
      if (!res) continue;
      const la = endLabel(pc.lp, used[0]), lb = endLabel(pc.lp, used[used.length - 1]);
      if (la < 0 && lb < 0) continue; // must connect to the network
      if ((la === LAB_WALL && lb < 0) || (lb === LAB_WALL && la < 0)) continue;
      const [A, B] = res;
      const aA = area(A.pts), aB = area(B.pts);
      let placeA = false, placeB = false;
      let cost = Math.abs(aA - aB) / (aA + aB) + famPenalty + tr.bonus;
      let ok = true;
      for (const [X, aX, isA] of [[A, aA, true], [B, aB, false]] as [LPoly, number, boolean][]) {
        const angs = endAngles(X, used[0], used[used.length - 1]);
        const acute = Math.min(...angs) < (25 * Math.PI) / 180;
        if (aX < P.minBlock || acute) {
          const canPlace = P.streetOp === 'organic' && aX >= 120 && aX <= P.placeThreshold && places < 6 && aX <= Math.min(aA, aB);
          if (canPlace) { if (isA) placeA = true; else placeB = true; }
          else { ok = false; break; }
        }
        for (const a of angs) cost += Math.max(0, Math.abs(a - Math.PI / 2) - Math.PI / 6) * 0.6;
        const obx = obb(X.pts);
        cost += 0.25 * Math.max(0, obx.hu / Math.max(1, obx.hv) - 2.5);
      }
      if (!ok) continue;
      cost += rng.float() * 0.08;
      cands.push({ A, B, chord: used, cost, placeA, placeB, rank });
    }
    cands.sort((a, b) => a.cost - b.cost);
    // expensive width test only on the best-ranked candidates
    let best: Cand | null = null;
    for (const c of cands.slice(0, 6)) {
      let ok = true;
      for (const [X, isPlace] of [[c.A, c.placeA], [c.B, c.placeB]] as [LPoly, boolean][]) {
        const w = inscribed(X.pts, [], 1).r * 2;
        if (isPlace ? w < 6 : w < P.minWidth) { ok = false; break; }
      }
      if (ok) { best = c; break; }
    }
    if (!best) { out.push(pc); continue; }
    const role = best.rank <= 2 ? 'street' : 'lane';
    const w = P.widthByRank[best.rank] * P.widthScale;
    const id = streets.add(best.chord, jitterWidths(best.chord, w, P.widthJitter, () => rng.float()), best.rank, role, pc.phase);
    for (const X of [best.A, best.B]) X.lab = X.lab.map((l) => (l === TMP_LABEL ? id : l));
    if (best.placeA || best.placeB) places++;
    queue.push({ ...pc, lp: best.A, level: pc.level + 1, kind: best.placeA ? 'place' : 'block' });
    queue.push({ ...pc, lp: best.B, level: pc.level + 1, kind: best.placeB ? 'place' : 'block' });
  }
  for (const pc of queue) out.push(pc);
  return out;
}

/** Closes: dead-end slits from a street edge into deep blocks (§2.4). */
export function addCloses(ctx: UrbanCtx, pieces: Piece[], streets: Streets, rng: Rng): number {
  const P = ctx.params;
  let n = 0;
  for (const pc of pieces) {
    if (pc.kind !== 'block') continue;
    const ins = inscribed(pc.lp.pts, [], 1.5);
    const maxDepth = P.plotDepth[pc.zone][1];
    if (ins.r < maxDepth * 0.95 || !rng.chance(P.deadEndRatio)) continue;
    // longest street edge
    let bi = -1, bl = 0;
    const pts = pc.lp.pts;
    for (let i = 0; i < pts.length; i++) {
      if (pc.lp.lab[i] < 0) continue;
      const l = dist(pts[i], pts[(i + 1) % pts.length]);
      if (l > bl) { bl = l; bi = i; }
    }
    if (bi < 0 || bl < 25) continue;
    const a = pts[bi], b = pts[(bi + 1) % pts.length];
    const t = rng.range(0.35, 0.65);
    const s = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const dx = (b.x - a.x) / bl, dy = (b.y - a.y) / bl;
    const nrm = { x: -dy, y: dx };
    const hit = rayHit(pts, s, nrm);
    if (!hit) continue;
    const L = Math.min(hit.t * P.slitDepth, hit.t - 16, 70);
    if (L < 18) continue;
    const e = { x: s.x + nrm.x * L, y: s.y + nrm.y * L };
    // start slightly outside the block, inside the street ribbon, so the notch opens onto the street
    const st = streets.list[pc.lp.lab[bi]];
    const hw = (st?.widths[0] ?? 4) / 2;
    const s0 = { x: s.x - nrm.x * hw * 0.8, y: s.y - nrm.y * hw * 0.8 };
    streets.add([s0, e], 2.6 * P.widthScale, 4, 'close', pc.phase);
    n++;
  }
  return n;
}

export interface CarvedBlock { poly: Polygon; kind: PieceKind; phase: number; zone: Zone; age: number; quarter: number }

/**
 * Blocks = pieces minus street ribbons (§2.5), computed per piece against the ribbons of the streets around it.
 * Street space of a quarter = quarter minus its blocks.
 */
/** Street ribbons cut into short chunks in a spatial index (fast local differences). */
export type RibbonIndex = GridIndex<{ poly: Polygon; bb: { x0: number; y0: number; x1: number; y1: number } }>;
export function buildRibbonIndex(streets: Streets, extraLines: { path: Polygon; width: number }[] = []): RibbonIndex {
  const idx = new GridIndex<{ poly: Polygon; bb: { x0: number; y0: number; x1: number; y1: number } }>(40);
  const add = (poly: Polygon) => { if (poly.length >= 3) idx.insertPts(poly, { poly, bb: bboxOf(poly) }); };
  for (const st of streets.list) {
    if (!st.ribbon) continue;
    const n = st.path.length;
    const CH = 8;
    for (let i = 0; i < n - 1; i += CH) {
      const j = Math.min(n - 1, i + CH);
      add(ribbon(st.path.slice(i, j + 1), st.widths.slice(i, j + 1)));
      // round joints between chunks and widened junctions at the ends
      if (j < n - 1) add(disk(st.path[j], st.widths[j] / 2, 10));
    }
    if (st.role !== 'close') for (const end of [0, n - 1]) add(disk(st.path[end], (st.widths[end] / 2) * 1.15, 10));
  }
  for (const ln of extraLines) {
    const n = ln.path.length;
    for (let i = 0; i < n - 1; i += 8) {
      const j = Math.min(n - 1, i + 8);
      add(ribbon(ln.path.slice(i, j + 1), ln.width));
      add(disk(ln.path[j], ln.width / 2, 8));
    }
  }
  return idx;
}

export function carveBlocks(q: Quarter, pieces: Piece[], ribbonIndex: RibbonIndex, wallBands: Polygon[]): { blocks: CarvedBlock[]; streetSpace: MultiPoly } {
  const blocks: CarvedBlock[] = [];
  for (const pc of pieces) {
    const bb = bboxOf(pc.lp.pts);
    const cutters: Polygon[] = [];
    for (const c of ribbonIndex.query(bb.x0 - 1, bb.y0 - 1, bb.x1 + 1, bb.y1 + 1)) {
      if (c.bb.x1 < bb.x0 || c.bb.x0 > bb.x1 || c.bb.y1 < bb.y0 || c.bb.y0 > bb.y1) continue;
      cutters.push(c.poly);
    }
    const res = cutters.length ? difference(pc.lp.pts, ...cutters.map((c) => [{ outer: c, holes: [] }] as MultiPoly)) : [{ outer: pc.lp.pts, holes: [] }];
    for (const ph of res) {
      const poly = cleanRing(ph.outer, 0.15, 0.5);
      if (poly.length < 3) continue;
      const a = area(poly);
      if (a < 40) continue;
      if (inscribed(poly, [], 0.5).r < 2.2) continue;
      blocks.push({ poly, kind: pc.kind, phase: pc.phase, zone: pc.zone, age: pc.age, quarter: pc.quarter });
    }
  }
  // street space = quarter minus its blocks (blocks lie inside the quarter): quarter with blocks as holes
  const streetSpace: MultiPoly = [{ outer: q.lp.pts, holes: blocks.map((b) => b.poly) }];
  void union; void mpArea; void polygonCentroid;
  return { blocks, streetSpace };
}
