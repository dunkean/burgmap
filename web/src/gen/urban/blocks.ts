/**
 * Level 2 — blocks by guided recursive splitting (URBAN_GEOMETRY.md §2). Every cut is a street; pieces that
 * are small forks become places; deep blocks get closes (slits); blocks = pieces minus street ribbons.
 */
import type { Vec2, Polygon, Polyline } from '../core/geom';
import { dist, polygonCentroid, simplify } from '../core/geom';
import type { Rng } from '../core/rng';
import { smoothstep } from '../core/field';
import type { UrbanCtx } from './context';
import type { Zone, MorphologyParams } from './morphology';
import type { Quarter } from './primary';
import type { GuidanceField } from './field';
import { Streets, jitterWidths, LAB_WALL, LAB_OPEN as LAB_OPEN_B } from './streets';
import { polygonArea } from '../core/geom';
import { LPoly, splitByChord, rayHit, locate, isConvex, segCrossesRing } from '../geo/split';
import { area, obb, inscribed, interiorAngle, pointInRing, cleanRing, bboxOf, isSimple, convexWidth, segSegT } from '../geo/poly';
import { GridIndex } from '../geo/spatial';
import { MultiPoly, union, difference, differenceS, intersectionS, mpArea } from '../geo/bool';
import { ribbon, disk } from '../geo/offset';

export const SPLIT_DBG: { on: boolean; why: Record<string, number> } = { on: false, why: {} };
export type PieceKind = 'block' | 'place' | 'market' | 'church' | 'compound' | 'green' | 'shanty';
export interface Piece { lp: LPoly; phase: number; zone: Zone; age: number; quarter: number; kind: PieceKind; level: number; morph?: MorphologyParams; compound?: string; lot?: string }

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

export interface SplitOpts {
  nucleus: Vec2; gridAngle: number; terrainAngle?: number; waterAngle?: number;
  /**
   * Megacity quarters: points on the bounding arterials where the main streets of the quarters on both sides start
   * (organic splits of the first levels begin there or snap their ends to them), so streets continue across.
   */
  anchors?: Vec2[];
}

export function splitQuarter(ctx: UrbanCtx, q: Quarter, qi: number, streets: Streets, field: GuidanceField, o: SplitOpts, rng: Rng): Piece[] {
  const P = q.morph ?? ctx.params;
  field.P = P;
  const gridAngle = P.orientation === 'cardinal' ? 0 : P.orientation === 'terrain' ? (o.terrainAngle ?? o.gridAngle) : P.orientation === 'water' ? (o.waterAngle ?? o.gridAngle) : o.gridAngle;
  const lanes = P.laneSpacing[0] > 0 || P.laneSpacing[1] > 0;
  const out: Piece[] = [];
  const root: Piece = { lp: q.lp, phase: q.phase, zone: q.zone, age: q.age, quarter: qi, kind: q.kind === 'market' ? 'market' : q.kind === 'place' ? 'place' : q.kind === 'lot' ? 'compound' : 'block', level: 1, morph: P, compound: q.compound, lot: q.lot };
  if (root.kind === 'market' || root.kind === 'place' || root.kind === 'compound') return [root];
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
    target *= 0.85 + 0.15 * smoothstep(dn, 50, 320);
    const aspect = ob.hu / Math.max(1, ob.hv);
    // faubourg ribbons are long by nature: only occasional lanes cross them
    // (a deep suburb piece is a district, not a ribbon: lanes branch away from the road)
    const maxAspect = pc.zone === 'faubourg' ? (ob.hv > 45 ? 3 : 7) : 2.6;
    if ((A0 < target && aspect < maxAspect) || A0 < 2 * P.minBlock) { out.push(pc); continue; }
    const cands: Cand[] = [];
    const th = field.angle(ob.c);
    const fams = [th, th + Math.PI / 2];
    const perp = fams.map((f) => Math.abs(Math.cos(f) * ob.u.x + Math.sin(f) * ob.u.y));
    const order = perp[0] <= perp[1] ? [0, 1] : [1, 0];
    let rank = Math.min(3, pc.level + 1);
    const seeds: Vec2[][] = [[], []];
    if (P.streetOp === 'grid') {
      // lattice lines of each family: the coarse lattice (ward streets), then lanes inside the wards
      const latt = (spacing: [number, number]) => {
        const res: Vec2[][] = [[], []];
        for (const fi of [0, 1]) {
          const f = fams[fi];
          const d = { x: Math.cos(f), y: Math.sin(f) }, nrm = { x: -d.y, y: d.x };
          const sp = spacing[Math.abs(Math.cos(f - gridAngle)) > 0.7 ? 0 : 1];
          if (!(sp > 0)) continue;
          let m0 = Infinity, m1 = -Infinity;
          for (const q2 of pts) { const m = (q2.x - o.nucleus.x) * nrm.x + (q2.y - o.nucleus.y) * nrm.y; m0 = Math.min(m0, m); m1 = Math.max(m1, m); }
          const cm = (ob.c.x - o.nucleus.x) * nrm.x + (ob.c.y - o.nucleus.y) * nrm.y;
          const lines: number[] = [];
          for (let k = Math.ceil((m0 + P.minWidth - sp / 2) / sp); k * sp + sp / 2 < m1 - P.minWidth; k++) lines.push(k * sp + sp / 2);
          lines.sort((a, b) => Math.abs(a - cm) - Math.abs(b - cm));
          // a seed in each inside interval of the lattice line (non-convex pieces)
          for (const L of lines.slice(0, 3)) {
            const o = { x: ob.c.x + nrm.x * (L - cm), y: ob.c.y + nrm.y * (L - cm) };
            const far = 1e4, a = { x: o.x - d.x * far, y: o.y - d.y * far }, b = { x: o.x + d.x * far, y: o.y + d.y * far };
            const ts: number[] = [];
            for (let i = 0; i < pts.length; i++) { const r = segSegT(a, b, pts[i], pts[(i + 1) % pts.length]); if (r) ts.push(r.t); }
            ts.sort((x, y) => x - y);
            for (let i = 0; i + 1 < ts.length && i < 4; i += 2) {
              const tm = (ts[i] + ts[i + 1]) / 2;
              if ((ts[i + 1] - ts[i]) * 2 * far < 2 * P.minWidth) continue;
              res[fi].push({ x: a.x + (b.x - a.x) * tm, y: a.y + (b.y - a.y) * tm });
            }
          }
        }
        return res;
      };
      let sd = A0 >= P.wardArea || !lanes ? latt(P.gridSpacing) : [[], []];
      if (lanes) {
        if (sd[0].length + sd[1].length === 0) { sd = latt(P.laneSpacing); rank = 3; } else rank = 2;
      }
      seeds[0] = sd[0]; seeds[1] = sd[1];
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
    // (grids too: a piece whose connected streets are only short stretches of its boundary, e.g. the gate ends of
    // roads that stop at the wall, would get no lattice line hanging off the network and never be split; a lattice
    // street is grown from them along the family closest to the inward normal)
    const gridAccess = P.streetOp === 'grid' && !pc.lp.lab.some((l, i) => l >= 0 && streets.connected.has(l) && dist(pts[i], pts[(i + 1) % pts.length]) > 40);
    if (P.streetOp === 'organic' || gridAccess) {
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        if (pc.lp.lab[i] < 0 || !streets.connected.has(pc.lp.lab[i])) continue;
        const a = pts[i], b = pts[(i + 1) % n];
        const l = dist(a, b);
        if (l < (gridAccess ? 3 : 12)) continue;
        const nx = -(b.y - a.y) / l, ny = (b.x - a.x) / l;
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const p0 = { x: m.x + nx * 0.05, y: m.y + ny * 0.05 };
        let h = Math.atan2(ny, nx);
        if (gridAccess) {
          // the lattice direction closest to the inward normal
          let bh = h, bd = Infinity;
          for (const f0 of fams) for (const f of [f0, f0 + Math.PI]) { const d = Math.abs(Math.atan2(Math.sin(f - h), Math.cos(f - h))); if (d < bd) { bd = d; bh = f; } }
          h = bh;
        } else h = field.follow(p0, h);
        access.push({ p: m, h });
      }
      access.sort((x, y) => dist(y.p, ob.c) - dist(x.p, ob.c));
    }
    const tries: { seed: Vec2; fi: number; entry?: number; bonus: number }[] = [];
    for (const fi of order) for (const seed of seeds[fi]) tries.push({ seed, fi, bonus: 0 });
    for (const ac of access.slice(-4)) tries.push({ seed: ac.p, fi: -1, entry: ac.h, bonus: 0.25 });
    // arterial anchors: a street starting there, square to the arterial (its twin across starts at the same point)
    const anchorsHere: Vec2[] = [];
    if (o.anchors && P.streetOp === 'organic' && pc.level <= 3) {
      for (const an of o.anchors) {
        if (an.x < ob.c.x - ob.hu - ob.hv || an.x > ob.c.x + ob.hu + ob.hv || an.y < ob.c.y - ob.hu - ob.hv || an.y > ob.c.y + ob.hu + ob.hv) continue;
        const loc = locate(pts, an);
        if (loc.d > 0.3 || pc.lp.lab[loc.edge] < 0 || !streets.connected.has(pc.lp.lab[loc.edge])) continue;
        const a = pts[loc.edge], b = pts[(loc.edge + 1) % pts.length];
        const l = dist(a, b);
        if (l < 1e-6 || dist(an, a) < 12 || dist(an, b) < 12) continue;
        anchorsHere.push(an);
        if (pc.level <= 2) tries.push({ seed: an, fi: -1, entry: Math.atan2((b.x - a.x) / l, -(b.y - a.y) / l), bonus: -0.32 });
      }
    }
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
        if (!pointInRing(pts, seed)) { if (SPLIT_DBG.on) SPLIT_DBG.why['seedOut'] = (SPLIT_DBG.why['seedOut'] ?? 0) + 1; continue; }
        const f = fams[fi];
        const fwd = field.trace(pts, seed, f, maxTurn);
        const back = field.trace(pts, seed, f + Math.PI, maxTurn);
        if (!fwd || !back) { if (SPLIT_DBG.on) SPLIT_DBG.why['traceFail'] = (SPLIT_DBG.why['traceFail'] ?? 0) + 1; continue; }
        chord = back.slice().reverse().concat(fwd.slice(1));
      }
      chord = simplify(chord, 0.25);
      let snapped = tr.entry !== undefined ? [chord[0], ...snapEnds(pc.lp, chord, 6).slice(1)] : snapEnds(pc.lp, chord, 6);
      // (an end near an arterial anchor moves onto it)
      if (anchorsHere.length) {
        snapped = snapped.slice();
        for (const end of [0, snapped.length - 1]) {
          const p = snapped[end];
          let ba: Vec2 | null = null, bd = 34;
          for (const an of anchorsHere) { const d = dist(an, p); if (d > 0.01 && d < bd) { bd = d; ba = an; } }
          if (ba) snapped[end] = ba;
        }
      }
      let res = splitByChord(pc.lp, snapped, TMP_LABEL);
      let used = snapped;
      if (!res) { res = splitByChord(pc.lp, chord, TMP_LABEL); used = chord; }
      if (!res) { if (SPLIT_DBG.on) SPLIT_DBG.why['splitFail'] = (SPLIT_DBG.why['splitFail'] ?? 0) + 1; continue; }
      const la = endLabel(pc.lp, used[0]), lb = endLabel(pc.lp, used[used.length - 1]);
      // must hang off the connected network
      const ca = la >= 0 && streets.connected.has(la), cb = lb >= 0 && streets.connected.has(lb);
      if (!ca && !cb) { if (SPLIT_DBG.on) SPLIT_DBG.why['notConnected'] = (SPLIT_DBG.why['notConnected'] ?? 0) + 1; continue; }
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
      if (!ok) { if (SPLIT_DBG.on) SPLIT_DBG.why['areaAngle'] = (SPLIT_DBG.why['areaAngle'] ?? 0) + 1; continue; }
      cost += rng.float() * 0.08;
      cands.push({ A, B, chord: used, cost, placeA, placeB, rank });
    }
    cands.sort((a, b) => a.cost - b.cost);
    // expensive width test only on the best-ranked candidates
    let best: Cand | null = null;
    for (const c of cands.slice(0, 6)) {
      let ok = true;
      for (const [X, isPlace] of [[c.A, c.placeA], [c.B, c.placeB]] as [LPoly, boolean][]) {
        const need = isPlace ? 6 : P.minWidth;
        const w = isConvex(X.pts, 1e-3) ? convexWidth(X.pts) : inscribed(X.pts, [], 1, need / 2).r * 2;
        if (w < need) { ok = false; break; }
      }
      if (ok) { best = c; break; }
    }
    if (!best) { if (SPLIT_DBG.on) SPLIT_DBG.why[cands.length ? 'width' : 'noCand'] = (SPLIT_DBG.why[cands.length ? 'width' : 'noCand'] ?? 0) + 1; out.push(pc); continue; }
    // (lagoon towns: every long cut is a rank-2 cut, dug as a canal)
    if (P.longCut && best.rank > 2) { let L = 0; for (let i = 1; i < best.chord.length; i++) L += dist(best.chord[i - 1], best.chord[i]); if (L >= P.longCut) best.rank = 2; }
    const role = best.rank <= 2 ? 'street' : 'lane';
    const w = P.widthByRank[best.rank] * P.widthScale;
    const id = streets.add(best.chord, jitterWidths(best.chord, w, P.widthJitter, () => rng.float()), best.rank, role, pc.phase);
    streets.connected.add(id);
    // the far end joins its street to the network too
    for (const e of [best.chord[0], best.chord[best.chord.length - 1]]) { const l = endLabel(pc.lp, e); if (l >= 0) streets.connected.add(l); }
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
  let n = 0;
  for (const pc of pieces) {
    const P = pc.morph ?? ctx.params;
    if (pc.kind !== 'block' || P.closeOp !== 'closes') continue;
    const maxDepth = P.plotDepth[pc.zone][1];
    if (!rng.chance(P.deadEndRatio)) continue;
    if (obb(pc.lp.pts).hv < maxDepth * 0.95) continue; // the inscribed radius never exceeds the OBB half-width
    const ins = inscribed(pc.lp.pts, [], 1.5);
    if (ins.r < maxDepth * 0.95) continue;
    // longest street edge
    let bi = -1, bl = 0;
    const pts = pc.lp.pts;
    for (let i = 0; i < pts.length; i++) {
      if (pc.lp.lab[i] < 0 || !streets.connected.has(pc.lp.lab[i])) continue;
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
    streets.connected.add(streets.add([s0, e], 2.6 * P.widthScale, 4, 'close', pc.phase));
    n++;
  }
  return n;
}

export interface CarvedBlock { poly: Polygon; kind: PieceKind; phase: number; zone: Zone; age: number; quarter: number; compound?: string; lot?: string }

/**
 * Blocks = pieces minus street ribbons (§2.5), computed per piece against the ribbons of the streets around it.
 * Street space of a quarter = quarter minus its blocks.
 */
/**
 * Removes the tips of vertices sharper than `minAng`: the triangle beyond the point where the tip is `width`
 * wide is cut away (exact local difference). Returns the largest remaining piece.
 */
export function truncateAcute(poly: Polygon, minAng: number, width: number): Polygon {
  let cur = poly;
  for (let guard = 0; guard < 6; guard++) {
    let hit = -1;
    for (let i = 0; i < cur.length; i++) if (interiorAngle(cur, i) < minAng) { hit = i; break; }
    if (hit < 0) return cur;
    const n = cur.length;
    const v = cur[hit], a = cur[(hit - 1 + n) % n], b = cur[(hit + 1) % n];
    const th = interiorAngle(cur, hit);
    const la = dist(v, a), lb = dist(v, b);
    const l = Math.min(width / 2 / Math.max(0.05, Math.sin(th / 2)), 0.95 * Math.min(la, lb));
    const ua = { x: (a.x - v.x) / la, y: (a.y - v.y) / la }, ubv = { x: (b.x - v.x) / lb, y: (b.y - v.y) / lb };
    // slightly larger triangle beyond the tip so the difference is clean
    const tri = [
      { x: v.x - (ua.x + ubv.x) * 0.5, y: v.y - (ua.y + ubv.y) * 0.5 },
      { x: v.x + ua.x * l, y: v.y + ua.y * l },
      { x: v.x + ubv.x * l, y: v.y + ubv.y * l },
    ];
    const res = differenceS(cur, tri);
    if (!res.length) return [];
    let best = res[0];
    for (const r of res) if (area(r.outer) > area(best.outer)) best = r;
    if (best.outer.length < 3 || Math.abs(area(best.outer) - area(cur)) < 1e-6) return cur;
    cur = best.outer;
  }
  return cur;
}

/**
 * Block of a piece = the piece inset edge by edge by the half-width of the street each edge lies on (the wall band
 * for wall edges, nothing for open land or water). Exact line-offset construction; returns null when the inset is
 * not a valid simple polygon with the same edge directions (the caller then uses the ribbon boolean).
 */
export function insetPiece(lp: LPoly, streets: Streets, wallHalf: number): Polygon | null {
  const P = lp.pts, n = P.length;
  if (n < 3) return null;
  const d: number[] = [], u: Vec2[] = [], nn: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n];
    const l = dist(a, b);
    if (l < 1e-9) return null;
    u.push({ x: (b.x - a.x) / l, y: (b.y - a.y) / l });
    nn.push({ x: -(b.y - a.y) / l, y: (b.x - a.x) / l });
    const lab = lp.lab[i];
    if (lab >= 0) {
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const ns = streets.nearest(m, 20, (st) => st.id === lab);
      const st = streets.list[lab];
      d.push(ns ? ns.hw : (st?.widths[0] ?? 4) / 2);
    } else d.push(lab === LAB_WALL ? wallHalf : 0.03);
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i - 1 + n) % n;
    const pa = { x: P[i].x + nn[j].x * d[j], y: P[i].y + nn[j].y * d[j] };
    const pb = { x: P[i].x + nn[i].x * d[i], y: P[i].y + nn[i].y * d[i] };
    const cr = u[j].x * u[i].y - u[j].y * u[i].x;
    if (Math.abs(cr) < 0.03) {
      // (nearly) collinear edges: a step if the offsets differ, else one point
      if (Math.abs(d[i] - d[j]) < 0.05) out.push({ x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 });
      else { out.push(pa, pb); }
      continue;
    }
    const t = ((pb.x - pa.x) * u[i].y - (pb.y - pa.y) * u[i].x) / cr;
    const q = { x: pa.x + u[j].x * t, y: pa.y + u[j].y * t };
    // guard against extreme miters at sharp corners
    if (dist(q, P[i]) > 6 * Math.max(d[i], d[j], 0.5)) return null;
    out.push(q);
  }
  // validity: positive, simple, inside the piece, every original edge keeps its direction
  if (polygonArea(out) <= 0 || !isSimple(out)) return null;
  for (const q of out) if (!pointInRing(P, q)) return null;
  for (let i = 0; i < out.length; i++) if (segCrossesRing(P, out[i], out[(i + 1) % out.length], 1e-9)) return null;
  const m = out.length;
  if (m === n) {
    for (let i = 0; i < n; i++) {
      const a = out[i], b = out[(i + 1) % n];
      if ((b.x - a.x) * u[i].x + (b.y - a.y) * u[i].y <= 0.02) return null;
    }
  }
  return out;
}

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

export function carveBlocks(q: Quarter, pieces: Piece[], ribbonIndex: RibbonIndex, streets: Streets, wallHalf: number): { blocks: CarvedBlock[]; streetSpace: MultiPoly } {
  const closes = streets.list.filter((s) => s.role === 'close' && s.ribbon).map((s) => { const b = bboxOf(s.path); return { x0: b.x0 - 3, y0: b.y0 - 3, x1: b.x1 + 3, y1: b.y1 + 3, ribbon: ribbon(s.path, s.widths) }; });
  const blocks: CarvedBlock[] = [];
  for (const pc of pieces) {
    const bb = bboxOf(pc.lp.pts);
    // fast exact path: inset every edge by the half-width of the street it borders
    const near = closes.filter((c) => !(c.x0 > bb.x1 || c.x1 < bb.x0 || c.y0 > bb.y1 || c.y1 < bb.y0));
    const ins = insetPiece(pc.lp, streets, wallHalf);
    if (ins) {
      // closes (slits) notch the inset block
      let polys: Polygon[] = [ins];
      if (near.length) polys = differenceS(ins, ...near.map((c) => [{ outer: c.ribbon, holes: [] }] as MultiPoly)).map((ph) => ph.outer);
      for (const p0 of polys) {
        let poly = truncateAcute(p0, (22 * Math.PI) / 180, 5);
        if (poly.length < 3 || area(poly) < 40 || (isConvex(poly, 1e-3) ? convexWidth(poly) / 2 : inscribed(poly, [], 0.5, 2.2).r) < 2.2) continue;
        poly = cleanRing(poly, 0.05, 0.5, 0.002, false);
        if (poly.length >= 3) poly = cleanRing(truncateAcute(poly, (22 * Math.PI) / 180, 5), 0.05, 0.5, 0.002, false);
        if (poly.length >= 3) blocks.push({ poly, kind: pc.kind, phase: pc.phase, zone: pc.zone, age: pc.age, quarter: pc.quarter, compound: pc.compound, lot: pc.lot });
      }
      continue;
    }
    const cutters: Polygon[] = [];
    for (const c of ribbonIndex.query(bb.x0 - 1, bb.y0 - 1, bb.x1 + 1, bb.y1 + 1)) {
      if (c.bb.x1 < bb.x0 || c.bb.x0 > bb.x1 || c.bb.y1 < bb.y0 || c.bb.y0 > bb.y1) continue;
      cutters.push(c.poly);
    }
    // open edges (no street) get the same 3 cm margin as the exact inset: the neighbouring quarter's boundary was
    // computed by another boolean and may sit a centimetre off, so blocks on both sides must not touch
    for (let i = 0; i < pc.lp.pts.length; i++) {
      if (pc.lp.lab[i] !== LAB_OPEN_B) continue;
      const a = pc.lp.pts[i], b = pc.lp.pts[(i + 1) % pc.lp.pts.length];
      if (dist(a, b) > 0.05) cutters.push(ribbon([a, b], 0.06));
    }
    const res = cutters.length ? differenceS(pc.lp.pts, ...cutters.map((c) => [{ outer: c, holes: [] }] as MultiPoly)) : [{ outer: pc.lp.pts, holes: [] }];
    for (const ph of res) {
      let poly = cleanRing(ph.outer, 0.05, 0.5, 0.002, false);
      if (poly.length < 3) continue;
      // acute tips at forks become street space (a small open triangle), never needle blocks
      poly = truncateAcute(poly, (22 * Math.PI) / 180, 5);
      if (poly.length < 3) continue;
      // clamp to the piece (boolean cleanup must never let a block creep past its piece)
      const cl = intersectionS(poly, pc.lp.pts);
      if (!cl.length) continue;
      poly = cl.reduce((b, x) => (area(x.outer) > area(b.outer) ? x : b)).outer;
      // (the clamp may leave a micro tip: truncated again, it can only shrink, so the block stays in its piece)
      poly = cleanRing(truncateAcute(cleanRing(poly, 0.05, 0.5, 0.002, false), (22 * Math.PI) / 180, 5), 0.05, 0.5, 0.002, false);
      if (poly.length < 3) continue;
      // dropping a nearly collinear reflex vertex grows the ring a little: on long edges of large blocks that adds up,
      // so the cleaned ring is clamped to the piece once more (and only de-duplicated afterwards)
      if (mpArea(differenceS(poly, pc.lp.pts)) > 0.01) {
        const cl2 = intersectionS(poly, pc.lp.pts);
        if (!cl2.length) continue;
        poly = cleanRing(cl2.reduce((b, x) => (area(x.outer) > area(b.outer) ? x : b)).outer, 0.01, 0.01, Infinity, false);
        if (poly.length < 3) continue;
      }
      const a = area(poly);
      if (a < 40) continue;
      if (inscribed(poly, [], 0.5, 2.2).r < 2.2) continue;
      blocks.push({ poly, kind: pc.kind, phase: pc.phase, zone: pc.zone, age: pc.age, quarter: pc.quarter, compound: pc.compound, lot: pc.lot });
    }
  }
  // street space = quarter minus its blocks (blocks lie inside the quarter): quarter with blocks as holes
  const streetSpace: MultiPoly = [{ outer: q.lp.pts, holes: blocks.map((b) => b.poly) }];
  void union; void mpArea; void polygonCentroid;
  return { blocks, streetSpace };
}
