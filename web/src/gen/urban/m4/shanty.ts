/**
 * Shanty towns (URBAN_LANDMARKS.md §3): informal settlements on the least valued land around the town.
 *
 * Siting: a land-value field over the terrain cells in a band around the footprint (20–320 m out); low value on
 * floodplains (low above the water, near it), steep slopes, the glacis outside the wall, next to the tanneries
 * and at the fringe between two roads; the culture picks the flavour (the Parisian "zone" on the glacis, hillside
 * gecekondu, river-bank bidonvilles). The lowest cells are grown into regions of the target area, outlined with
 * marching squares, clipped off the footprint, the roads (8 m) and the water.
 *
 * Partition (its own, no plots): relaxed Voronoi cells of hut seeds (Lloyd ×2) partition the lot exactly; a
 * winding footpath tree (randomized spanning tree over the cell edges, pruned to what serves every cell) is the cut
 * network; each cell is a hut lot and its hut is the cell inset by half a footpath (1–2 m paths) on path edges and
 * a hand's breadth elsewhere, kept to 15–40 m²: coverage 50–70 %, no gardens.
 */
import { Delaunay } from 'd3-delaunay';
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import { dist, polygonCentroid } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { UrbanCtx } from '../context';
import type { ReserveApi, ReservedLot } from '../primary';
import type { CompoundCtx } from '../compounds';
import { isoRegions, dilate } from '../phases';
import { distanceField } from '../../core/field';
import { rasterizePolys } from '../../geo/raster';
import { MultiPoly, differenceS, intersectionS, mpArea } from '../../geo/bool';
import { area, orientPos, pointInRing, distToRing, bboxOf, cleanRing, inscribed, obb, isSimple } from '../../geo/poly';
import { stitchUnion } from '../../geo/stitch';
import { ribbon } from '../../geo/offset';
import { insetConvex } from '../../geo/offset';
import { isConvex, segCrossesRing, polyInside, clipHalfPlaneConvex } from '../../geo/split';
import { shapeOf, clipPlot } from '../buildings';
import { Noise2D } from '../../core/noise';
import { Mask } from './site';
import { giveAccess, phaseAt, type M4State } from './reserve';
import { emptyOut, type Out } from './kit';

export const RECT = { ok: 0, fail: 0 };
export type ShantyKind = 'zone' | 'bidonville' | 'gecekondu' | 'riverbank';

export interface ShantyIn {
  avoid: Polygon[];
  roads: Polyline[];
  nucleus: Vec2;
  /** Tannery lots (nuisance): low land value next to them. */
  nuisance: Polygon[];
  walled: boolean;
}

/** Low-value regions around the town, as lots (piece 'lot', builder m4-shanty). */
export function reserveShanty(s: M4State, api: ReserveApi, si: ShantyIn, amount: 'some' | 'many', kind: ShantyKind): ReservedLot[] {
  const ctx = s.ctx, r = s.rng.fork('shanty');
  const t = ctx.terrain, g = t.height, n = g.w, cell = g.cell;
  const target = (s.pop < 20000 ? 18000 : s.pop < 45000 ? 40000 : 70000) * (amount === 'many' ? 2.5 : 1);
  // distance to the footprint and to the other lots (raster masks + chamfer distance: no polygon dilation)
  const polyField = (polys: Polygon[]): Float32Array => distanceField(rasterizePolys(polys, n, n, cell), n, n, cell).dist;
  const dFoot = polyField(api.footprint.flatMap((ph) => [ph.outer]));
  const dAvoid = si.avoid.length ? polyField(si.avoid) : null;
  // distance fields (chamfer) to the wall line, the roads and the nuisance trades, on the terrain grid
  const lineField = (lines: Polyline[]): Float32Array => {
    const mask = new Uint8Array(n * n);
    for (const pl of lines) for (let i = 1; i < pl.length; i++) {
      const a = pl[i - 1], b = pl[i], L = dist(a, b), k = Math.max(1, Math.ceil(L / (cell * 0.5)));
      for (let j = 0; j <= k; j++) {
        const x = Math.floor((a.x + ((b.x - a.x) * j) / k) / cell), y = Math.floor((a.y + ((b.y - a.y) * j) / k) / cell);
        if (x >= 0 && y >= 0 && x < n && y < n) mask[y * n + x] = 1;
      }
    }
    return distanceField(mask, n, n, cell).dist;
  };
  const dWall = lineField(api.enclosure.map((ph) => ph.outer.concat([ph.outer[0]])));
  const dRoad = lineField(si.roads);
  const dNuis = si.nuisance.length ? lineField(si.nuisance.map((p) => p.concat([p[0]]))) : null;
  const hab = ctx.site.fields.hab;
  const W = { zone: [2.2, 0.6, 0.6, 0.8], bidonville: [0.8, 0.8, 0.6, 1.8], gecekondu: [0.5, 2.0, 0.6, 0.8], riverbank: [0.6, 0.6, 2.2, 0.8] }[kind];
  // value field (lower = less valued); NaN where not allowed
  const v = new Float32Array(n * n).fill(-1e6);
  let ok = 0;
  // only the cells within 330 m of the footprint
  let fx0 = Infinity, fy0 = Infinity, fx1 = -Infinity, fy1 = -Infinity;
  for (const ph of api.footprint) for (const q of ph.outer) { fx0 = Math.min(fx0, q.x); fy0 = Math.min(fy0, q.y); fx1 = Math.max(fx1, q.x); fy1 = Math.max(fy1, q.y); }
  const gx0 = Math.max(0, Math.floor((fx0 - 330) / cell)), gx1 = Math.min(n - 1, Math.ceil((fx1 + 330) / cell));
  const gy0 = Math.max(0, Math.floor((fy0 - 330) / cell)), gy1 = Math.min(n - 1, Math.ceil((fy1 + 330) / cell));
  for (let y = gy0; y <= gy1; y++) for (let x = gx0; x <= gx1; x++) {
    const i = y * n + x;
    const p = { x: (x + 0.5) * cell, y: (y + 0.5) * cell };
    if (t.water[i] || dFoot[i] > 320 || dFoot[i] < 12 + (s.listsW ? s.listsW + 8 : 0) || (dAvoid && dAvoid[i] < 25)) continue;
    const sl = ctx.slopeAt(p);
    if (sl > 0.42) continue;
    const dr = dRoad[i];
    if (dr < 9) continue;
    const dW = dWall[i];
    const glacis = api.gates.length && dW < 110 ? 1 - dW / 110 : 0;
    const steep = Math.max(0, Math.min(1, (sl - 0.08) / 0.2));
    const flood = hab[i] < 4 ? 1 - hab[i] / 4 : 0;
    // between two roads: near a road but the second road also within 150 m in another direction is approximated by
    // the road distance being moderate
    const fringe = dr < 70 ? 0.5 : 0.2;
    const dn = dNuis ? dNuis[i] : 1e9;
    const near = dn < 150 ? 1 - dn / 150 : 0;
    const value = 1 - (W[0] * glacis + W[1] * steep + W[2] * flood + W[3] * fringe + 1.2 * near) / 3 + 0.25 * Math.min(1, dist(p, si.nucleus) / 1500) + 0.08 * r.float() * 0;
    v[i] = -value; // isoRegions keeps v > level
    ok++;
  }
  const dbg = (globalThis as Record<string, unknown>).__sh ? (...a: unknown[]) => console.log('[shanty]', ...a) : () => undefined;
  dbg('cells ok', ok);
  if (!ok) return [];
  // smooth the value over ~4 cells (contiguous low-value land, not speckle); invalid cells stay out
  for (let pass = 0; pass < 3; pass++) {
    const src = v.slice();
    for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      if (src[i] < -1e5) continue;
      let t = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const q = src[i + dy * n + dx]; if (q > -1e5) { t += q; c++; } }
      v[i] = t / c;
    }
  }
  // level: the lowest-valued cells adding up to the target area (with a margin for the clipping)
  const vals = Array.from(v).filter((x) => x > -1e5).sort((a, b) => b - a);
  const k = Math.min(vals.length - 1, Math.floor((target * 3) / (cell * cell)));
  if (k < 20) return [];
  const level = vals[k];
  const regions = isoRegions(v, n, cell, level, 2000);
  dbg('k', k, 'level', level, 'regions', regions.length, regions.map((r) => Math.round(area(r.outer))));
  let m: MultiPoly = regions.map((ph) => ({ outer: ph.outer, holes: [] as Polygon[] }));
  // (the cells were taken ≥ 12 m from the footprint: the footprint itself is enough to cut)
  m = differenceS(m, s.listsW ? dilate(api.enclosure, s.listsW + 6).concat(api.footprint) : api.footprint);
  if (ctx.water.length) m = differenceS(m, ctx.water);
  const roadRb = si.roads.map((pl) => ribbon(pl, 18)).filter((rb) => rb.length >= 3).map((rb) => [{ outer: rb, holes: [] }] as MultiPoly);
  if (roadRb.length) m = differenceS(m, ...roadRb);
  if (si.avoid.length) m = differenceS(m, ...si.avoid.map((p) => [{ outer: p, holes: [] }] as MultiPoly));
  const pcs = m.filter((ph) => !ph.holes.length && area(ph.outer) > 4000).sort((a, b) => area(b.outer) - area(a.outer));
  dbg('pieces', m.length, m.map((ph) => [Math.round(area(ph.outer)), ph.holes.length]));
  const out: ReservedLot[] = [];
  let total = 0;
  for (const ph of pcs) {
    if (total >= target) break;
    const lot = orientPos(cleanRing(ph.outer, 0.5, 2));
    if (lot.length < 3) continue;
    const c = polygonCentroid(lot);
    const acc = giveAccess(s, api, lot, { mode: 'none', toward: si.nucleus, width: 3, rank: 4, maxLen: 200 }, si.avoid);
    // no street near: the shanty town stands on the road side (a footpath to the road is enough)
    const id = 'shanty:' + out.length;
    const pa = phaseAt(api, c);
    s.lotData.set(id, { kind });
    out.push({ id, kind: 'm4-shanty', poly: lot, phase: pa.phase, zone: 'faubourg', cuts: acc?.cuts ?? [] });
    s.sites.push({ id, kind: 'shanty', role: 'shanty', lot, entrance: acc?.entrance, anchor: c, culture: s.culture, tags: { flavour: kind } });
    total += area(lot);
  }
  return out;
}

// ---------------------------------------------------------------- the partition

/** Hut cells: relaxed Voronoi of jittered seeds, clipped exactly to the lot. */
function cells(B: Polygon, spacing: number, rng: Rng): Polygon[] {
  const bb = bboxOf(B);
  let seeds: Vec2[] = [];
  // clusters: the seed density follows a low-frequency noise (dense knots of huts, sparser patches with yards)
  const nz = new Noise2D(rng.fork('cluster'));
  for (let y = bb.y0 + spacing / 2; y < bb.y1; y += spacing * 0.87) {
    const off = (Math.round((y - bb.y0) / (spacing * 0.87)) % 2) * spacing / 2;
    for (let x = bb.x0 + off; x < bb.x1; x += spacing) {
      const p = { x: x + rng.range(-0.35, 0.35) * spacing, y: y + rng.range(-0.35, 0.35) * spacing };
      const dens = 0.5 + 0.5 * nz.noise(p.x / 45, p.y / 45);
      if (pointInRing(B, p) && rng.float() < 0.68 + 0.32 * dens) seeds.push(p);
    }
  }
  if (seeds.length < 3) return [B];
  const box: [number, number, number, number] = [bb.x0 - 1, bb.y0 - 1, bb.x1 + 1, bb.y1 + 1];
  const conv = (c: Polygon): Polygon => (c as unknown as [number, number][]).slice(0, -1).map(([x, y]) => ({ x, y }));
  // Lloyd relaxation (two steps), the centroids taken in the lot
  for (let it = 0; it < 1; it++) {
    const vor = Delaunay.from(seeds, (p) => p.x, (p) => p.y).voronoi(box);
    seeds = seeds.map((p, i) => {
      const poly = vor.cellPolygon(i);
      if (!poly) return p;
      const c = polygonCentroid(conv(poly as unknown as Polygon));
      return pointInRing(B, c) ? c : p;
    });
  }
  const vor = Delaunay.from(seeds, (p) => p.x, (p) => p.y).voronoi(box);
  const out: Polygon[] = [];
  for (let i = 0; i < seeds.length; i++) {
    const poly = vor.cellPolygon(i);
    if (!poly) continue;
    const c = orientPos(conv(poly as unknown as Polygon));
    // cells wholly inside the lot are kept as they are, the others are clipped exactly
    const inside = c.every((q) => pointInRing(B, q)) && !c.some((q, k) => segCrossesRing(B, q, c[(k + 1) % c.length], 1e-9));
    if (inside) { out.push(c); continue; }
    for (const ph of intersectionS(c, B)) if (!ph.holes.length && area(ph.outer) > 0.5) out.push(orientPos(ph.outer));
  }
  return out;
}

const key = (p: Vec2) => `${Math.round(p.x * 20)},${Math.round(p.y * 20)}`;

export function buildShanty(B: Polygon, cx: CompoundCtx): Out {
  const out = emptyOut();
  const rng = cx.rng;
  const cs = cells(B, rng.range(7.3, 7.9), rng);
  // ---- edge graph: cell edges keyed by their end points; boundary edges belong to one cell only
  const edges = new Map<string, { a: Vec2; b: Vec2; cells: number[] }>();
  const ek = (a: Vec2, b: Vec2) => { const ka = key(a), kb = key(b); return ka < kb ? ka + '|' + kb : kb + '|' + ka; };
  cs.forEach((c, ci) => c.forEach((q, k) => {
    const b = c[(k + 1) % c.length];
    if (dist(q, b) < 0.2) return;
    const id = ek(q, b);
    const e = edges.get(id);
    if (e) e.cells.push(ci); else edges.set(id, { a: q, b, cells: [ci] });
  }));
  const onBoundary = (e: { a: Vec2; b: Vec2 }) => distToRing(B, { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 }) < 0.05;
  // ---- footpath tree: randomized Prim over the interior edges from the boundary, pruned to serve every cell
  const adj = new Map<string, { to: string; id: string }[]>();
  const interior: string[] = [];
  for (const [id, e] of edges) {
    if (e.cells.length < 2 || onBoundary(e)) continue;
    interior.push(id);
    for (const [u, w] of [[key(e.a), key(e.b)], [key(e.b), key(e.a)]]) { if (!adj.has(u)) adj.set(u, []); adj.get(u)!.push({ to: w, id }); }
  }
  const served = new Uint8Array(cs.length);
  for (const e of edges.values()) if (e.cells.length === 1 && onBoundary(e)) served[e.cells[0]] = 1;
  const inTree = new Set<string>();
  const visited = new Set<string>();
  // the main winding paths: from the boundary point nearest the town across the settlement (Dijkstra on the cell
  // edges with jittered weights), then to the far side; the other paths branch off them
  const mainE = new Set<string>();
  const bverts: Vec2[] = [];
  for (const e of edges.values()) if (e.cells.length === 1) bverts.push(e.a, e.b);
  if (bverts.length) {
    const entry = bverts.reduce((b, q) => (dist(q, cx.center) < dist(b, cx.center) ? q : b));
    const far = bverts.reduce((b, q) => (dist(q, entry) > dist(b, entry) ? q : b));
    const side = bverts.reduce((b, q) => (Math.min(dist(q, entry), dist(q, far)) > Math.min(dist(b, entry), dist(b, far)) ? q : b));
    const vpos = new Map<string, Vec2>();
    for (const e of edges.values()) { vpos.set(key(e.a), e.a); vpos.set(key(e.b), e.b); }
    const wgt = new Map<string, number>();
    for (const id of interior) wgt.set(id, 0.6 + rng.float() * 0.9);
    const route = (from: Vec2, to: Vec2) => {
      const src = key(from), dst = key(to);
      const dd = new Map<string, number>([[src, 0]]), prev = new Map<string, string>();
      const q: [number, string][] = [[0, src]];
      // also start from boundary vertices next to the entry (they connect through the interior)
      while (q.length) {
        let bi = 0;
        for (let i = 1; i < q.length; i++) if (q[i][0] < q[bi][0]) bi = i;
        const [d0, u] = q.splice(bi, 1)[0];
        if (u === dst) break;
        if (d0 > (dd.get(u) ?? Infinity)) continue;
        for (const nb of adj.get(u) ?? []) {
          const e = edges.get(nb.id)!;
          const nd = d0 + dist(e.a, e.b) * (wgt.get(nb.id) ?? 1);
          if (nd < (dd.get(nb.to) ?? Infinity)) { dd.set(nb.to, nd); prev.set(nb.to, nb.id); q.push([nd, nb.to]); }
        }
      }
      let v = dst;
      while (prev.has(v)) { const id = prev.get(v)!; mainE.add(id); const e = edges.get(id)!; v = key(e.a) === v ? key(e.b) : key(e.a); }
    };
    // (boundary vertices may not be in the interior graph: route from their nearest interior vertex)
    const nearIn = (p: Vec2): Vec2 => { let b = p, bd = Infinity; for (const k of adj.keys()) { const q = vpos.get(k)!; const d2 = dist(q, p); if (d2 < bd) { bd = d2; b = q; } } return b; };
    if (adj.size) { const e0 = nearIn(entry); route(e0, nearIn(far)); route(e0, nearIn(side)); }
  }
  for (const id of mainE) { inTree.add(id); const e = edges.get(id)!; visited.add(key(e.a)); visited.add(key(e.b)); }
  // start at the vertices on the lot boundary
  const frontier: { w: number; id: string; to: string }[] = [];
  for (const [id, e] of edges) if (e.cells.length === 1) for (const q of [e.a, e.b]) {
    const kq = key(q);
    if (visited.has(kq)) continue;
    visited.add(kq);
    for (const nb of adj.get(kq) ?? []) frontier.push({ w: rng.float(), id: nb.id, to: nb.to });
    void id;
  }
  while (frontier.length) {
    let bi = 0;
    for (let i = 1; i < frontier.length; i++) if (frontier[i].w < frontier[bi].w) bi = i;
    const f = frontier.splice(bi, 1)[0];
    if (visited.has(f.to)) continue;
    visited.add(f.to);
    inTree.add(f.id);
    for (const nb of adj.get(f.to) ?? []) if (!visited.has(nb.to)) frontier.push({ w: rng.float(), id: nb.id, to: nb.to });
  }
  // prune: drop a tree edge when both its cells are served without it (repeat while something changes)
  const touch = new Uint16Array(cs.length);
  for (const id of inTree) for (const c of edges.get(id)!.cells) touch[c]++;
  let changed = true;
  const deg = new Map<string, number>();
  for (const id of inTree) { const e = edges.get(id)!; for (const q of [key(e.a), key(e.b)]) deg.set(q, (deg.get(q) ?? 0) + 1); }
  while (changed) {
    changed = false;
    for (const id of [...inTree]) {
      const e = edges.get(id)!;
      // only leaves (one end free), so the paths stay a connected tree hanging off the boundary
      const leaf = (deg.get(key(e.a)) ?? 0) === 1 || (deg.get(key(e.b)) ?? 0) === 1;
      if (!leaf || mainE.has(id)) continue;
      if (e.cells.every((c) => served[c] || touch[c] > 1)) {
        inTree.delete(id);
        for (const c of e.cells) touch[c]--;
        for (const q of [key(e.a), key(e.b)]) deg.set(q, (deg.get(q) ?? 1) - 1);
        changed = true;
      }
    }
  }
  // ---- huts: the cell inset by half a path on path edges, a hand's breadth elsewhere; a second, tighter pass
  // when the packing came out under 52 %
  const pathHalf = rng.range(0.55, 0.85);
  for (const c of cs) out.parcels.push({ poly: c, use: 'hut-lot' });
  const BA = Math.max(1, area(B));
  const hutsFor = (k: number, cap: [number, number], hr: Rng, rect = true) => {
    const list: { poly: Polygon; parcel: number }[] = [];
    let built = 0;
    cs.forEach((c, ci) => {
      if (c.length < 3) return;
      const d = c.map((q, j) => {
        const b = c[(j + 1) % c.length];
        const e = edges.get(ek(q, b));
        if (!e) return 0.2 * k;
        if (e.cells.length === 1) return (onBoundary(e) ? 0.3 : 0.15) * k;
        const id = ek(q, b);
        return mainE.has(id) ? 0.95 : inTree.has(id) ? Math.max(0.5, pathHalf * Math.sqrt(k)) : 0.15 * k;
      });
      const convex = isConvex(c, 1e-3);
      let h: Polygon = [];
      if (convex) {
        h = insetConvex(c, d);
        // a rectangular hut facing its path (the cell's longest path edge), the rest of the cell a tiny yard
        let fe = -1, fl = 0;
        c.forEach((q, j) => { const b2 = c[(j + 1) % c.length]; const id = ek(q, b2); if (inTree.has(id) && dist(q, b2) > fl) { fl = dist(q, b2); fe = j; } });
        if (rect && fe >= 0 && h.length >= 3 && area(h) > 22) {
          const a2 = c[fe], b2 = c[(fe + 1) % c.length];
          const u = { x: (b2.x - a2.x) / fl, y: (b2.y - a2.y) / fl };
          let nIn = { x: -u.y, y: u.x };
          const cc = polygonCentroid(c);
          if ((cc.x - a2.x) * nIn.x + (cc.y - a2.y) * nIn.y < 0) nIn = { x: -nIn.x, y: -nIn.y };
          const want = hr.range(cap[0] - 4, cap[1]);
          const wd = Math.min(fl - 0.4, Math.max(5.2, Math.sqrt(want) * hr.range(0.95, 1.3)));
          const dep = Math.max(5.2, want / wd);
          const t0 = hr.range(0, Math.max(0, fl - wd));
          const hp = [
            { p: { x: a2.x + u.x * t0, y: a2.y + u.y * t0 }, n: u }, { p: { x: a2.x + u.x * (t0 + wd), y: a2.y + u.y * (t0 + wd) }, n: { x: -u.x, y: -u.y } },
            { p: { x: a2.x + nIn.x * (dep + d[fe]), y: a2.y + nIn.y * (dep + d[fe]) }, n: { x: -nIn.x, y: -nIn.y } },
          ];
          const r = clipPlot(h, hp, true)[0];
          if (r && r.length >= 3 && area(r) >= 15 && shapeOf(r).w >= 4.5 && shapeOf(r).asp <= 3) { h = r; RECT.ok++; } else RECT.fail++;
        }
      } else {
        // clipped boundary cells: a uniform inset by boolean, the largest piece
        const rb = ribbon(c.concat([c[0]]), 2 * 0.45 * k);
        const r = rb.length >= 3 ? differenceS(c, rb) : [];
        h = r.filter((ph) => !ph.holes.length).map((ph) => ph.outer).sort((x, y) => area(y) - area(x))[0] ?? [];
      }
      if (h.length < 3) return;
      // no pebbles: a hut is a rectangle (the oriented box of the cell's inset, of the same area, trimmed by the
      // inset where it pokes out: square corners, now and then a cut one)
      // (the last, tightest pass keeps the cell insets: the packing comes first there)
      if (rect && !(h.length === 4 && shapeOf(h).w >= 4.5)) { const r = rectFit(h); if (r && area(r) >= 0.8 * area(h)) h = r; }
      let A = area(h);
      if (A > 40) {
        // keep huts to 15–40 m²: scale about a point inside (the centroid of a convex inset, else its inscribed centre)
        const g = convex ? polygonCentroid(h) : inscribed(h, [], 0.3).c, f = Math.sqrt(hr.range(cap[0], cap[1]) / A);
        const q = h.map((p) => ({ x: g.x + (p.x - g.x) * f, y: g.y + (p.y - g.y) * f }));
        if (convex || polyInside(h, q)) { h = q; A = area(h); } else return;
      }
      if (A < 15) return;
      const sh = shapeOf(h);
      if (sh.w < 4.5 || sh.asp > 3) return;
      list.push({ poly: h, parcel: ci });
      built += A;
    });
    return { list, cov: built / BA };
  };
  /**
   * The oriented box of a polygon, as large as possible with at most one corner cut by the polygon (a rectangle,
   * now and then with one chamfer), ≥ 4.5 m wide; null when none fits (convex polygons only).
   */
  function rectFit(p: Polygon): Polygon | null {
    if (!isConvex(p, 1e-3)) return null;
    const o = obb(p);
    const q = orientPos(p);
    const s0 = Math.min(1, Math.sqrt(area(p) / Math.max(1, 4 * o.hu * o.hv)));
    for (const maxV of [4, 5]) for (let s = s0 * 1.04; s >= s0 * 0.72; s *= 0.95) {
      const hu = o.hu * s, hv = o.hv * s;
      if (2 * hv < 4.5) break;
      let r: Polygon = orientPos([
        { x: o.c.x - o.u.x * hu - o.v.x * hv, y: o.c.y - o.u.y * hu - o.v.y * hv }, { x: o.c.x + o.u.x * hu - o.v.x * hv, y: o.c.y + o.u.y * hu - o.v.y * hv },
        { x: o.c.x + o.u.x * hu + o.v.x * hv, y: o.c.y + o.u.y * hu + o.v.y * hv }, { x: o.c.x - o.u.x * hu + o.v.x * hv, y: o.c.y - o.u.y * hu + o.v.y * hv },
      ]);
      for (let i = 0; i < q.length && r.length >= 3; i++) {
        const a2 = q[i], b2 = q[(i + 1) % q.length];
        const l = dist(a2, b2);
        if (l < 1e-6) continue;
        r = clipHalfPlaneConvex(r, a2, { x: -(b2.y - a2.y) / l, y: (b2.x - a2.x) / l });
      }
      if (r.length < 3) continue;
      r = cleanRing(r, 0.15, 3, 0.002, false);
      if (r.length >= 3 && r.length <= maxV && area(r) >= 15 && shapeOf(r).w >= 4.5 && shapeOf(r).asp <= 3) return r;
    }
    return null;
  }
  let huts = hutsFor(1, [30, 40], rng.fork('huts'));
  // under 52 %: a tighter packing (narrower gaps), then huts filling their whole cell
  if (huts.cov < 0.52) { const h2 = hutsFor(0.55, [36, 40], rng.fork('huts2')); if (h2.cov > huts.cov) huts = h2; }
  if (huts.cov < 0.52) { const h3 = hutsFor(0.55, [36, 40], rng.fork('huts3'), false); if (h3.cov > huts.cov) huts = h3; }
  // still under 50 % (a rare draw): a few more tight packings until one reaches it
  for (let t = 4; t < 8 && huts.cov < 0.5; t++) { const h = hutsFor(t % 2 ? 0.45 : 0.5, [36, 40], rng.fork('huts' + t), t % 2 === 0); if (h.cov > huts.cov) huts = h; }
  // too dense: huts are shrunk about their centroid
  const kk = huts.cov > 0.66 ? Math.sqrt(0.62 / huts.cov) : 1;
  for (const h of huts.list) {
    let poly = h.poly;
    if (kk < 1) {
      const g = polygonCentroid(poly);
      const q = poly.map((p) => ({ x: g.x + (p.x - g.x) * kk, y: g.y + (p.y - g.y) * kk }));
      if (area(q) >= 15 && shapeOf(q).w >= 4.5 && polyInside(poly, q)) poly = q;
    }
    // a lean-to against one long side (a shed roof on posts, 1.8–2.4 m deep), inside the hut's cell
    const lt = rng.fork('lean:' + h.parcel);
    if (lt.chance(0.45)) {
      const cell = cs[h.parcel];
      const o = obb(poly);
      const side = lt.chance(0.5) ? 1 : -1, dd = lt.range(1.8, 2.4), ext = o.hu * lt.range(0.5, 0.9);
      const off = lt.range(-1, 1) * (o.hu - ext);
      const at = (s: number, t: number) => ({ x: o.c.x + o.u.x * s + o.v.x * t, y: o.c.y + o.u.y * s + o.v.y * t });
      const t0 = side * o.hv, t1 = side * (o.hv + dd);
      const leanTo = orientPos([at(off - ext, t0), at(off + ext, t0), at(off + ext, t1), at(off - ext, t1)]);
      if (polyInside(cell, leanTo) && leanTo.every((q) => distToRing(cell, q) >= 0.9)) {
        const u = stitchUnion(poly, leanTo);
        if (u && isSimple(u) && shapeOf(u).asp <= 3 && area(u) <= 40) poly = u;
      }
    }
    out.buildings.push({ poly, kind: 'hut', parcel: h.parcel, arch: 'shack', roof: 'flat', material: 'timber', storeys: 1 });
  }
  for (const id of inTree) { const e = edges.get(id)!; out.lines.push({ kind: 'footpath', path: [e.a, e.b], width: 2 * pathHalf }); }
  // a few water points at path junctions
  let wells = 0;
  for (const [q, dg] of deg) if (dg >= 3 && wells < Math.max(1, Math.floor(cs.length / 120)) && rng.chance(0.15)) {
    const [x, y] = q.split(',').map((v) => Number(v) / 20);
    out.landmarks.push({ kind: 'well', poly: orientPos([{ x: x - 0.8, y: y - 0.8 }, { x: x + 0.8, y: y - 0.8 }, { x: x + 0.8, y: y + 0.8 }, { x: x - 0.8, y: y + 0.8 }]) });
    wells++;
  }
  void mpArea;
  return out;
}
