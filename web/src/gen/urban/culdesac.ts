/**
 * culDeSacTree (URBAN_GEOMETRY.md §2.4, URBAN_MORPHOLOGY.md §2): the dead-end derbs of a medina. Deep blocks are
 * served by a tree of slits grown from the streets: while some point of the block is farther than `accessDepth`
 * from any street or derb, a derb grows toward it from the nearest access point — a street edge (the slit opens
 * onto the street) or an existing derb (a T junction), with an occasional bend. Derbs keep clear of the block
 * boundary and of each other, so the block stays one polygon notched by a tree and every courtyard lot cut from it
 * can front a street or a derb.
 */
import type { Vec2, Polyline } from '../core/geom';
import { dist } from '../core/geom';
import type { Rng } from '../core/rng';
import type { Piece } from './blocks';
import type { Streets } from './streets';
import { pointInRing, distToRing, distToSeg } from '../geo/poly';

function distPl(p: Vec2, pl: Polyline): number {
  let d = Infinity;
  for (let i = 1; i < pl.length; i++) d = Math.min(d, distToSeg(p, pl[i - 1], pl[i]));
  return d;
}
function nearestOnSeg(p: Vec2, a: Vec2, b: Vec2): { q: Vec2; d: number } {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  const q = { x: a.x + t * dx, y: a.y + t * dy };
  return { q, d: dist(p, q) };
}

export function culDeSacTree(pieces: Piece[], streets: Streets, rng: Rng): number {
  let count = 0;
  for (const pc of pieces) {
    const P = pc.morph;
    if (!P || pc.kind !== 'block' || P.closeOp !== 'culDeSacTree') continue;
    const pts = pc.lp.pts;
    const n = pts.length;
    const Dmax = P.accessDepth;
    const w = P.widthByRank[4] * P.widthScale;
    // access edges: connected streets around the piece
    const acc: { a: Vec2; b: Vec2; hw: number; nrm: Vec2 }[] = [];
    for (let i = 0; i < n; i++) {
      const l = pc.lp.lab[i];
      if (l < 0 || !streets.connected.has(l) || !streets.list[l].ribbon) continue;
      const a = pts[i], b = pts[(i + 1) % n], L = dist(a, b);
      if (L < 4) continue;
      acc.push({ a, b, hw: (streets.list[l].widths[0] ?? 4) / 2, nrm: { x: -(b.y - a.y) / L, y: (b.x - a.x) / L } });
    }
    if (!acc.length) continue;
    // sample the interior
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of pts) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    const S: Vec2[] = [], D: number[] = [];
    for (let y = y0 + 2; y < y1; y += 4) for (let x = x0 + 2; x < x1; x += 4) {
      const p = { x, y };
      if (!pointInRing(pts, p) || distToRing(pts, p) < 2) continue;
      let d = Infinity;
      for (const e of acc) d = Math.min(d, distToSeg(p, e.a, e.b));
      S.push(p); D.push(d);
    }
    if (!S.length) continue;
    const slits: Polyline[] = [];
    const gapB = w / 2 + 6.5, gapS = w + 12;
    for (let iter = 0; iter < 60; iter++) {
      let bi = -1, bd = Dmax;
      for (let i = 0; i < S.length; i++) if (D[i] > bd) { bd = D[i]; bi = i; }
      if (bi < 0) break;
      const target = S[bi];
      // nearest access point: a street edge or a derb
      let q: Vec2 | null = null, qd = Infinity, onStreet: typeof acc[number] | null = null, parent = -1;
      for (const e of acc) { const r = nearestOnSeg(target, e.a, e.b); if (r.d < qd) { qd = r.d; q = r.q; onStreet = e; parent = -1; } }
      slits.forEach((sl, si) => {
        for (let i = 1; i < sl.length; i++) { const r = nearestOnSeg(target, sl[i - 1], sl[i]); if (r.d < qd - 3) { qd = r.d; q = r.q; onStreet = null; parent = si; } }
      });
      if (!q) break;
      const q0: Vec2 = q;
      const L = dist(q0, target);
      const stop = Math.min(L - 4, L - Dmax * 0.35);
      const reject = () => { for (let i = 0; i < S.length; i++) if (dist(S[i], target) < 9) D[i] = 0; };
      if (stop < 8) { reject(); continue; }
      const u = { x: (target.x - q0.x) / L, y: (target.y - q0.y) / L };
      const e = { x: q0.x + u.x * stop, y: q0.y + u.y * stop };
      // start: just inside the street ribbon (the notch opens onto the street), or on the parent derb
      const start = onStreet ? { x: q0.x - (onStreet as typeof acc[number]).nrm.x * (onStreet as typeof acc[number]).hw * 0.8, y: q0.y - (onStreet as typeof acc[number]).nrm.y * (onStreet as typeof acc[number]).hw * 0.8 } : q0;
      let path: Polyline = [start, e];
      if (stop > 22 && rng.chance(0.55)) {
        const m = { x: (q0.x + e.x) / 2, y: (q0.y + e.y) / 2 };
        const off = rng.range(-0.22, 0.22) * stop;
        path = [start, { x: m.x - u.y * off, y: m.y + u.x * off }, e];
      }
      // validity: clear of the boundary and of the other derbs (except at the root)
      let ok = true;
      const total = stop + (onStreet ? (onStreet as typeof acc[number]).hw : 0);
      for (let i = 1; i < path.length && ok; i++) {
        const a = path[i - 1], b = path[i];
        const l = dist(a, b), k = Math.max(1, Math.ceil(l / 2));
        for (let j = 0; j <= k && ok; j++) {
          const p = { x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k };
          const along = dist(start, p);
          // the root necessarily starts at the edge (street) or on the parent derb
          if (along < (onStreet ? (onStreet as typeof acc[number]).hw + gapB + 1 : w + 6)) continue;
          if (!pointInRing(pts, p) || distToRing(pts, p) < gapB) ok = false;
          for (let si = 0; si < slits.length && ok; si++) if (si !== parent || along > 10) if (distPl(p, slits[si]) < (si === parent ? w + 6 : gapS)) ok = false;
        }
      }
      void total;
      if (!ok) { reject(); continue; }
      slits.push(path);
      const id = streets.add(path, w, 4, 'close', pc.phase);
      streets.connected.add(id);
      count++;
      for (let i = 0; i < S.length; i++) D[i] = Math.min(D[i], distPl(S[i], path));
    }
  }
  return count;
}
