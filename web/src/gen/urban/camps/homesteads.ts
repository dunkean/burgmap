/**
 * Dispersed farmsteads: each household on its own homefield among the fields, the farms linked by tracks (Viking
 * farm clusters, Irish raths, Maya houselots, the hamlets and outlying farms of every camp culture).
 *
 * Partition: every farm is a quarter of its own (its homefield: a rounded, irregular disc sized by the household's
 * status, kept off the water and off the other farms); an access lane enters it from its gate; the block is the
 * homefield less the lane, cut by nothing else: one plot (the farmyard) and, when the lane splits it, a garden.
 * The tracks between the gates are plan lines over the land use (a minimum spanning tree, plus the way to the road).
 */
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import { dist } from '../../core/geom';
import type { Rng } from '../../core/rng';
import { area, orientPos, inscribed, pointInRing, bboxOf, distToRing } from '../../geo/poly';
import { differenceS, MultiPoly } from '../../geo/bool';
import type { CampCtx } from './index';
import { snapRing, CampOut, emptyCamp, street, carveBlocks, pathRibbons, FrontIndex, at, pieces } from './kit';
import type { Status } from './farms';
import { Noise2D } from '../../core/noise';

export interface DispersedOpts {
  /** Homefield radius (m) by status. */
  radius: (s: Status, r: Rng) => number;
  /** Clear ground between neighbouring homefields (m). */
  gap: number;
  /** How far the farms may spread from the centre (m). */
  spread: number;
  /** Extra site score of a farm position (shore, sunny slope, the centre). */
  prefer?: (p: Vec2) => number;
  /** Radial wobble of the homefield outline (0 = a circle). */
  wobble: number;
  /** Fills a farmyard (buildings, fences); `gate` is the midpoint of its lane frontage. */
  fill: (out: CampOut, pi: number, yard: Polygon, home: Polygon, s: Status, gate: Vec2 | null, r: Rng, i: number) => void;
  /** Maximum slope of a homefield. */
  maxSlope?: number;
  /** Homefield shape: a wobbly oval (default) or a fenced quadrilateral yard. */
  shape?: 'round' | 'rect';
  /** Elongation range of the homefield (long / short axis) along `axis` (default the contour). */
  aspect?: [number, number];
  /** Long axis of a homefield at p (null: random). */
  axis?: (p: Vec2) => number | null;
}

/** Plans `statuses.length` dispersed farms round c; returns the camp and the farm centres actually placed. */
export function dispersedFarms(cc: CampCtx, c: Vec2, statuses: Status[], o: DispersedOpts, rng: Rng): CampOut & { centres: Vec2[] } {
  const out = emptyCamp();
  const ctx = cc.ctx;
  const maxSlope = o.maxSlope ?? 0.24;
  const pr = rng.fork('place');
  const placed: { p: Vec2; r: number; s: Status }[] = [];
  const avoid = (cc.avoid ?? []).map((poly) => ({ poly, bb: bboxOf(poly) }));
  const ok = (p: Vec2, r: number): number => {
    // share of the disc on dry, gentle ground inside the map
    let good = 0, n = 0;
    for (const f of [0, 0.55, 1]) for (let k = 0; k < (f ? 12 : 1); k++) {
      const q = at(p, (k / 12) * 2 * Math.PI, r * f);
      n++;
      if (q.x < 12 || q.y < 12 || q.x > ctx.mapSize - 12 || q.y > ctx.mapSize - 12) continue;
      if (!ctx.isWater(q) && ctx.slopeAt(q) < maxSlope) good++;
    }
    return good / n;
  };
  for (const s of statuses) {
    const r = o.radius(s, pr);
    let best: Vec2 | null = null, bs = -Infinity;
    const first = !placed.length;
    const tries = first ? 1 : 90;
    for (let t = 0; t < tries + (first ? 40 : 0); t++) {
      const p = first && t === 0 ? c : at(c, pr.range(0, 2 * Math.PI), (first ? pr.range(0, 0.25) : Math.sqrt(pr.float())) * o.spread);
      if (placed.some((q) => dist(q.p, p) < q.r + r + o.gap)) continue;
      if (avoid.some((t) => (p.x > t.bb.x0 - r - o.gap && p.x < t.bb.x1 + r + o.gap && p.y > t.bb.y0 - r - o.gap && p.y < t.bb.y1 + r + o.gap) && (pointInRing(t.poly, p) || distToRing(t.poly, p) < r + o.gap * 0.6))) continue;
      const g = ok(p, r);
      if (g < 0.8) continue;
      // close to the others (a cluster, not a scatter over the whole map), the preferred ground
      let dn = Infinity;
      for (const q of placed) dn = Math.min(dn, dist(q.p, p) - q.r - r);
      const sc = g * 2 - (placed.length ? Math.max(0, dn - o.gap) / 90 : 0) - dist(p, c) / (o.spread * 2.5) + (o.prefer ? o.prefer(p) : 0) + pr.float() * 0.25;
      if (sc > bs) { bs = sc; best = p; }
      if (first && t === 0 && g >= 0.95) break;
    }
    if (!best) continue;
    placed.push({ p: best, r, s });
  }
  if (!placed.length) return { ...out, centres: [] };
  // ---- tracks: a minimum spanning tree over the farms, rooted at the first (the chief's); the root's way out goes to
  // the nearest regional road (or the site centre)
  const n = placed.length;
  const parent = new Array<number>(n).fill(-1);
  const inT = new Array<boolean>(n).fill(false);
  const dBest = new Array<number>(n).fill(Infinity);
  dBest[0] = 0;
  for (let it = 0; it < n; it++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!inT[i] && (u < 0 || dBest[i] < dBest[u])) u = i;
    inT[u] = true;
    for (let v = 0; v < n; v++) if (!inT[v]) { const d = dist(placed[u].p, placed[v].p); if (d < dBest[v]) { dBest[v] = d; parent[v] = u; } }
  }
  // the way out of the root: toward the nearest point of a regional road
  let exit: Vec2 = ctx.center;
  {
    let bd = dist(placed[0].p, ctx.center);
    for (const pl of cc.roads) for (const q of pl) { const d = dist(q, placed[0].p); if (d < bd) { bd = d; exit = q; } }
    if (dist(exit, placed[0].p) < placed[0].r + 2) exit = at(placed[0].p, cc.roadAngle, placed[0].r + 30);
  }
  // ---- homefields: rounded wobbly discs, each kept on its side of the bisectors with its neighbours, off the water
  const nz = new Noise2D(rng.fork('wob'));
  const homesRaw: Polygon[] = [];
  const ar = rng.fork('aspect');
  const homes: Polygon[] = placed.map((f, i) => {
    const ph = i * 3.7;
    const N = 28;
    const asp = o.aspect ? ar.range(o.aspect[0], o.aspect[1]) : 1;
    const ax = (o.axis ? o.axis(f.p) : contourAt(cc, f.p)) ?? ar.range(0, Math.PI);
    const ka = Math.sqrt(asp), kb = 1 / Math.sqrt(asp);
    let ring: Polygon;
    if (o.shape === 'rect') {
      // a quadrilateral yard, its corners a little out of square
      const hx = f.r * ka * 0.89, hy = f.r * kb * 0.89;
      const ca = Math.cos(ax), sa = Math.sin(ax);
      ring = orientPos([[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([u, v]) => {
        const du = ar.range(-0.08, 0.08) * hx, dv = ar.range(-0.08, 0.08) * hy;
        return { x: f.p.x + (u + du) * ca - (v + dv) * sa, y: f.p.y + (u + du) * sa + (v + dv) * ca };
      }));
    } else {
      ring = orientPos(Array.from({ length: N }, (_, k) => {
        const t = (k / N) * 2 * Math.PI;
        const w = 1 + o.wobble * nz.noise(Math.cos(t) * 1.2 + ph, Math.sin(t) * 1.2 + ph);
        const u = Math.cos(t) * f.r * ka * w, v = Math.sin(t) * f.r * kb * w;
        return { x: f.p.x + u * Math.cos(ax) - v * Math.sin(ax), y: f.p.y + u * Math.sin(ax) + v * Math.cos(ax) };
      }));
    }
    let m: MultiPoly = [{ outer: ring, holes: [] }];
    if (ctx.water.length) m = differenceS(m, ctx.water);
    // (kept off the earlier homefields)
    for (let j = 0; j < i; j++) if (dist(placed[j].p, f.p) < (placed[j].r + f.r) * 1.6) m = differenceS(m, [{ outer: homesRaw[j], holes: [] }]);
    const ps = pieces(m, 60);
    if (!ps.length) { homesRaw.push(ring); return []; }
    ring = ps.reduce((a, b) => (area(b) > area(a) ? b : a));
    homesRaw.push(ring);
    return snapRing(ring);
  });
  const gateOf = (i: number, toward: Vec2): Vec2 => {
    const ring = homes[i];
    const f = placed[i].p;
    // the outline point in the direction of `toward`
    const a = Math.atan2(toward.y - f.y, toward.x - f.x);
    let lo = 0, hi = placed[i].r * 2;
    for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (pointInRing(ring, at(f, a, m))) lo = m; else hi = m; }
    return at(f, a, lo);
  };
  const front: Vec2[] = placed.map((_, i) => (homes[i].length ? gateOf(i, i === 0 ? exit : placed[parent[i]].p) : placed[i].p));
  // tracks (plan lines) from each farm's gate to its parent's gate, and from the root to the road
  for (let i = 1; i < n; i++) if (homes[i].length && homes[parent[i]].length) out.lines.push({ kind: 'track', path: [front[i], front[parent[i]]], width: 2.6 });
  if (homes[0].length && dist(front[0], exit) > 4) out.lines.push({ kind: 'track', path: [front[0], exit], width: 3 });
  // ---- per farm: quarter, lane, block, yard
  const fr = rng.fork('farms');
  placed.forEach((f, i) => {
    const Q = homes[i];
    if (Q.length < 3 || area(Q) < 150) return;
    const qi = out.quarters.length;
    out.quarters.push(Q); out.outline.push(Q);
    const g = front[i];
    const ins = inscribed(Q, [], 1);
    const L = dist(g, ins.c);
    const ux = (ins.c.x - g.x) / (L || 1), uy = (ins.c.y - g.y) / (L || 1);
    const lane = street([{ x: g.x - ux * 4, y: g.y - uy * 4 }, { x: g.x + ux * Math.max(6, L * 0.38), y: g.y + uy * Math.max(6, L * 0.38) }], 3.2, i === 0 ? 1 : 3, i === 0 ? 'radial' : 'lane');
    out.streets.push(lane);
    const fi = new FrontIndex([lane]);
    const blocks = carveBlocks(Q, pathRibbons([lane]), []);
    blocks.forEach((blk) => {
      const bi = out.blocks.length;
      out.blocks.push({ poly: blk, kind: 'block', quarter: qi });
    });
    const order = blocks.map((b, k) => ({ b, k, a: area(b) })).sort((x, y) => y.a - x.a);
    const b0 = out.blocks.length - blocks.length;
    let yardDone = false;
    for (const { b, k } of order) {
      const pi = out.parcels.length;
      const fl = fi.frontage(b);
      if (!yardDone && fl.len >= 3.2 && area(b) >= 120) {
        out.parcels.push({ poly: b, use: 'plot', block: b0 + k });
        yardDone = true;
        o.fill(out, pi, b, Q, f.s, fl.mid ?? g, fr.fork('f' + i), i);
      } else out.parcels.push({ poly: b, use: 'garden', block: b0 + k });
    }
  });
  return { ...out, centres: placed.map((f) => f.p) };
}

/** Direction of the contour (the level line) at p, or null on flat ground. */
export function contourAt(cc: CampCtx, p: Vec2, d = 12): number | null {
  const h = (q: Vec2) => cc.ctx.heightAt(q);
  const gx = (h({ x: p.x + d, y: p.y }) - h({ x: p.x - d, y: p.y })) / (2 * d);
  const gy = (h({ x: p.x, y: p.y + d }) - h({ x: p.x, y: p.y - d })) / (2 * d);
  if (Math.hypot(gx, gy) < 0.015) return null;
  return Math.atan2(gx, -gy);
}

/** Distance (m) from p to the nearest water, searched up to `max` (Infinity beyond). */
export function waterDist(cc: CampCtx, p: Vec2, max: number): number {
  for (let r = 10; r <= max; r += 10) for (let k = 0; k < 16; k++) if (cc.ctx.isWater(at(p, (k / 16) * 2 * Math.PI, r))) return r;
  return Infinity;
}

export type { Polyline };
