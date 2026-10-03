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
    if (!P || pc.kind !== 'block' || !['culDeSacTree', 'hutong', 'roji'].includes(P.closeOp)) continue;
    const hutong = P.closeOp === 'hutong';
    const roji = P.closeOp === 'roji', orthogonal = hutong || roji;
    if (orthogonal && (pc.compound || pc.lot)) continue;
    const pts = pc.lp.pts;
    const n = pts.length;
    const Dmax = P.accessDepth;
    const w = P.widthByRank[4] * P.widthScale;
    // access edges: connected streets around the piece
    const acc: { a: Vec2; b: Vec2; hw: number; nrm: Vec2 }[] = [];
    for (let i = 0; i < n; i++) {
      const l = pc.lp.lab[i];
      if (l < 0 || !streets.connected.has(l) || !streets.list[l].ribbon) continue;
      let a = pts[i], b = pts[(i + 1) % n];
      const L = dist(a, b);
      if (L < 4) continue;
      const nrm = { x: -(b.y - a.y) / L, y: (b.x - a.x) / L };
      if (orthogonal) {
        // Short street frontage must still enter away from the neighbouring wall/river corner.
        // Otherwise every shadow target chooses that corner and exhausts the rejection budget.
        const margin = w / 2 + 7.5;
        if (L <= 2 * margin) continue;
        const t = margin / L, aa = a;
        a = { x: aa.x + (b.x - aa.x) * t, y: aa.y + (b.y - aa.y) * t };
        b = { x: b.x + (aa.x - b.x) * t, y: b.y + (aa.y - b.y) * t };
      }
      acc.push({ a, b, hw: (streets.list[l].widths[0] ?? 4) / 2, nrm });
    }
    if (!acc.length) continue;
    // Japanese merchant alleys follow the local street grid, including tilted/kinked districts.
    // Chinese hutongs keep their existing world-cardinal axes and consume no organic RNG.
    const longest = roji ? acc.reduce((a, b) => dist(a.a, a.b) >= dist(b.a, b.b) ? a : b) : null;
    const axis = longest ? { x: longest.nrm.y, y: -longest.nrm.x } : { x: 1, y: 0 };
    const across = { x: -axis.y, y: axis.x };
    const alongAxis = (p: Vec2) => p.x * axis.x + p.y * axis.y;
    const acrossAxis = (p: Vec2) => p.x * across.x + p.y * across.y;
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
    // A large merchant ward needs more short branches; keep other cultures' budgets unchanged.
    // Each interior sample represents 16 m². Bound the extra work even for giant districts.
    const budget = roji ? Math.min(160, Math.max(60, Math.ceil(S.length * 16 / (Dmax * Dmax)))) : 60;
    for (let iter = 0; iter < budget; iter++) {
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
      const reject = () => { for (let i = 0; i < S.length; i++) if (dist(S[i], target) < 9) D[i] = 0; };
      type Root = { q: Vec2; onStreet: typeof acc[number] | null; parent: number };
      const roots: Root[] = [{ q, onStreet, parent }];
      if (roji) {
        // The closest root may lie at the inner corner of a concave district. Try other real
        // frontage positions and existing branches before abandoning that part of the ward.
        const roadRoots = acc.flatMap((edge) => [{ q: nearestOnSeg(target, edge.a, edge.b).q, onStreet: edge, parent: -1 },
          { q: { x: (edge.a.x + edge.b.x) / 2, y: (edge.a.y + edge.b.y) / 2 }, onStreet: edge, parent: -1 }]);
        roadRoots.sort((a, b) => dist(a.q, target) - dist(b.q, target));
        const branchRoots: Root[] = slits.map((sl, si) => {
          let best = { q: sl[0], d: Infinity };
          for (let i = 1; i < sl.length; i++) { const r = nearestOnSeg(target, sl[i - 1], sl[i]); if (r.d < best.d) best = r; }
          return { q: best.q, onStreet: null, parent: si };
        });
        branchRoots.sort((a, b) => dist(a.q, target) - dist(b.q, target));
        for (const root of [...roadRoots.slice(0, 6), ...branchRoots.slice(0, 6)]) {
          if (!roots.some((r) => dist(r.q, root.q) < 0.1 && r.parent === root.parent)) roots.push(root);
        }
      }
      const makePath = (root: Root): Polyline | null => {
        const { q: q0, onStreet, parent } = root;
        const L = dist(q0, target);
        // Long concave merchant wards need a growing trunk, not a single shortcut across their hollow.
        const stop = Math.min(L - 4, L - Dmax * 0.35, roji ? 2 * Dmax : Infinity);
        if (stop < 8) return null;
        const u = { x: (target.x - q0.x) / L, y: (target.y - q0.y) / L };
        const e = { x: q0.x + u.x * stop, y: q0.y + u.y * stop };
        // start: just inside the street ribbon (the notch opens onto the street), or on the parent derb
        const start = onStreet ? { x: q0.x - (onStreet as typeof acc[number]).nrm.x * (onStreet as typeof acc[number]).hw * 0.8, y: q0.y - (onStreet as typeof acc[number]).nrm.y * (onStreet as typeof acc[number]).hw * 0.8 } : q0;
        let path: Polyline = [start, e];
        const alternatives: Polyline[] = [];
        if (orthogonal) {
          // Wards clipped by a river have no through-going lattice chord. Serve their interior with cardinal
          // lanes instead of merging acres of back land into a lot with only a few metres of frontage.
          // A branch leaves its parent squarely; a street entry follows the closest cardinal inward normal.
          const parentPath = parent >= 0 ? slits[parent] : null;
          let horizontal = Math.abs(alongAxis({ x: target.x - q0.x, y: target.y - q0.y })) >= Math.abs(acrossAxis({ x: target.x - q0.x, y: target.y - q0.y }));
          if (onStreet) horizontal = Math.abs(alongAxis(onStreet.nrm)) >= Math.abs(acrossAxis(onStreet.nrm));
          else if (parentPath) {
            let best = Infinity;
            for (let i = 1; i < parentPath.length; i++) {
              const d = distToSeg(q0, parentPath[i - 1], parentPath[i]);
              if (d < best) { best = d; const delta = { x: parentPath[i].x - parentPath[i - 1].x, y: parentPath[i].y - parentPath[i - 1].y }; horizontal = Math.abs(acrossAxis(delta)) >= Math.abs(alongAxis(delta)); }
            }
          }
          // Oblique gate/river streets need a normal entry before turning cardinal. Turning at the edge
          // leaves the lane too close to its parent ribbon and rejects every trunk in 35–55° wards.
          const entry = onStreet ? { x: q0.x + onStreet.nrm.x * (gapB + 1), y: q0.y + onStreet.nrm.y * (gapB + 1) } : q0;
          const delta = { x: e.x - entry.x, y: e.y - entry.y };
          const dir = horizontal ? axis : across, amount = horizontal ? alongAxis(delta) : acrossAxis(delta);
          const bend = hutong ? horizontal ? { x: e.x, y: entry.y } : { x: entry.x, y: e.y }
            : { x: entry.x + dir.x * amount, y: entry.y + dir.y * amount };
          path = [start, q0, entry, bend, e].filter((p, i, arr) => i === 0 || dist(p, arr[i - 1]) > 0.05);
          if (roji) {
            const otherDir = horizontal ? across : axis, otherAmount = horizontal ? acrossAxis(delta) : alongAxis(delta);
            const otherBend = { x: entry.x + otherDir.x * otherAmount, y: entry.y + otherDir.y * otherAmount };
            alternatives.push([start, q0, entry, otherBend, e].filter((p, i, arr) => i === 0 || dist(p, arr[i - 1]) > 0.05));
            // A diagonal endpoint can lie in the hollow even when a forward axis is clear. Grow
            // along one grid family first, then turn on a later iteration as the ward opens up.
            const goal = { x: target.x - entry.x, y: target.y - entry.y };
            for (const direction of [dir, otherDir]) {
              const component = goal.x * direction.x + goal.y * direction.y;
              const advance = Math.sign(component) * Math.min(Math.abs(component), stop);
              const end = { x: entry.x + direction.x * advance, y: entry.y + direction.y * advance };
              if (Math.abs(advance) >= 8 && dist(end, target) < dist(q0, target) - 2) {
                alternatives.push([start, q0, entry, end].filter((p, i, arr) => i === 0 || dist(p, arr[i - 1]) > 0.05));
              }
            }
          }
        } else if (stop > 22 && rng.chance(0.55)) {
          const m = { x: (q0.x + e.x) / 2, y: (q0.y + e.y) / 2 };
          const off = rng.range(-0.22, 0.22) * stop;
          path = [start, { x: m.x - u.y * off, y: m.y + u.x * off }, e];
        }
        // validity: clear of the boundary and of the other derbs (except at the root)
        const valid = (candidate: Polyline): boolean => {
          let ok = true;
          for (let i = 1; i < candidate.length && ok; i++) {
            const a = candidate[i - 1], b = candidate[i];
            const l = dist(a, b), k = Math.max(1, Math.ceil(l / 2));
            for (let j = 0; j <= k && ok; j++) {
              const p = { x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k };
              const along = dist(start, p);
              // the root necessarily starts at the edge (street) or on the parent derb
              if (orthogonal && along > (onStreet ? onStreet.hw + 0.5 : 0.5) && !pointInRing(pts, p)) { ok = false; break; }
              if (along < (onStreet ? (onStreet as typeof acc[number]).hw + gapB + 1 : w + 6)) continue;
              if (!pointInRing(pts, p) || distToRing(pts, p) < gapB) ok = false;
              for (let si = 0; si < slits.length && ok; si++) if (si !== parent || along > 10) if (distPl(p, slits[si]) < (si === parent ? w + 6 : gapS)) ok = false;
            }
          }
          return ok;
        };
        let ok = valid(path);
        for (const candidate of alternatives) if (!ok) { path = candidate; ok = valid(path); }
        return ok ? path : null;
      };
      let path: Polyline | null = null;
      for (const root of roots) { path = makePath(root); if (path) break; }
      if (!path) { reject(); continue; }
      slits.push(path);
      const id = streets.add(path, w, 4, 'close', pc.phase);
      streets.connected.add(id);
      count++;
      for (let i = 0; i < S.length; i++) D[i] = Math.min(D[i], distPl(S[i], path));
    }
  }
  return count;
}
