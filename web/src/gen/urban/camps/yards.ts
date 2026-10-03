/**
 * Yard villages (barbarian Europe): irregular fenced farmyards along trampled paths, no streets.
 * - germanic (Feddersen Wierde, Flögeln, Vorbasse): byre-houses and longhouses (roughly east–west) in fenced
 *   yards, granaries on posts, sunken huts (Grubenhäuser), cattle pens; the chieftain's hall in its own large yard
 *   by the central thing place; a palisade with a ditch round the village;
 * - celtic (rath, hillfort, Danebury): roundhouses in small yards, four-post granaries and storage pits, inside a
 *   circular earthen rampart with its ditch (two banks for a village);
 * - norse (Viking farmstead cluster): scattered farmsteads with bow-sided longhouses, byres and pit houses in
 *   large fenced yards, linked by tracks; no enclosure.
 *
 * Partition: relaxed Voronoi cells of yard seeds inside the outline; the paths are a pruned random spanning tree
 * over the cell edges (every yard keeps ≥ 4 m of path frontage, the gates and the centre are joined), buffered to
 * their width. Blocks = outline \ path ribbons; lots = block ∩ cell (exact); buildings are fitted in their yard.
 */
import { Delaunay } from 'd3-delaunay';
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import { dist, polygonCentroid } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { Range } from '../morphology';
import type { UrbanStreet } from '../../types';
import { area, orientPos, pointInRing, inscribed, obb, bboxOf, distToRing } from '../../geo/poly';
import { unionS, intersectionS, differenceS, difference, unionMany, MultiPoly } from '../../geo/bool';
import { Noise2D } from '../../core/noise';
import type { CampCtx } from './index';
import {
  snapRing, CampOut, emptyCamp, street, ellipse, carveBlocks, pathRibbons, mergeSmall, cutByCells, FrontIndex, hut, rect, apsidal, bowSided,
  fitIn, openRing, roadCrossings, hachures, pieces, ringSamples,
} from './kit';
import { wallFeatures } from '../walls';
import { MinHeap } from '../../core/pq';
import { pyramid } from '../aztec';
import type { CompoundOut } from '../compounds';
import { placeRect } from '../m4/kit';

export interface YardVariant {
  id: 'germanic' | 'celtic' | 'norse' | 'maya' | 'oppidum' | 'halfling';
  /** Inhabitants per farmstead. */
  per: number;
  yardA: Range;
  pathW: number;
  /** Share of the cells that are farmsteads (1 = a nucleated village). */
  occupancy: number;
  radius: (pop: number) => number;
}

const yardRadius = (per: number, yardA: Range, occ: number) => (pop: number): number => 20 + Math.sqrt(((Math.max(3, pop / per) + 2) * ((yardA[0] + yardA[1]) / 2) * 1.15) / (occ * Math.PI));

export const YARD_VARIANTS: Record<string, YardVariant> = {
  germanic: { id: 'germanic', per: 11, yardA: [1300, 2400], pathW: 3.4, occupancy: 1, radius: yardRadius(11, [1300, 2400], 1) },
  celtic: { id: 'celtic', per: 7, yardA: [650, 1300], pathW: 2.8, occupancy: 1, radius: yardRadius(7, [650, 1300], 1) },
  oppidum: { id: 'oppidum', per: 10, yardA: [1400, 2800], pathW: 3.2, occupancy: 0.8, radius: yardRadius(10, [1400, 2800], 0.8) },
  // (the Shire: hedged gardens on gentle hills, smials dug into the banks, lanes winding between them)
  halfling: { id: 'halfling', per: 5.5, yardA: [900, 1700], pathW: 3, occupancy: 0.85, radius: yardRadius(5.5, [900, 1700], 0.85) },
  maya: { id: 'maya', per: 7, yardA: [1000, 1900], pathW: 2.8, occupancy: 0.55, radius: yardRadius(7, [1000, 1900], 0.55) },
  norse: { id: 'norse', per: 14, yardA: [2600, 5200], pathW: 3.2, occupancy: 0.32, radius: yardRadius(14, [2600, 5200], 0.32) },
};

interface GEdge { a: number; b: number; cells: number[]; len: number; inside: boolean }

/** Relaxed jittered seeds inside a ring (dart throwing with a minimum spacing, then Lloyd steps). */
function seedsIn(ring: Polygon, n: number, rng: Rng): Vec2[] {
  const bb = bboxOf(ring);
  const A = area(ring);
  const d0 = Math.sqrt(A / n) * 0.8;
  const pts: Vec2[] = [];
  // (a hash grid of cell d0: only the 3 × 3 neighbouring cells are tested)
  const grid = new Map<number, Vec2[]>();
  const key = (ix: number, iy: number) => ix * 100003 + iy;
  for (let tries = 0; tries < n * 60 && pts.length < n; tries++) {
    const p = { x: rng.range(bb.x0, bb.x1), y: rng.range(bb.y0, bb.y1) };
    if (!pointInRing(ring, p)) continue;
    const ix = Math.floor(p.x / d0), iy = Math.floor(p.y / d0);
    let near = false;
    for (let dx = -1; dx <= 1 && !near; dx++) for (let dy = -1; dy <= 1 && !near; dy++) for (const q of grid.get(key(ix + dx, iy + dy)) ?? []) if (dist(q, p) < d0) { near = true; break; }
    if (near) continue;
    pts.push(p);
    const k = key(ix, iy);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(p);
  }
  return pts;
}

export function yardsVillage(cc: CampCtx, c: Vec2, pop: number, v: YardVariant, rng: Rng): CampOut {
  const out = emptyCamp();
  const ctx = cc.ctx;
  // sprawl: larger yards (and a looser scatter of Norse farms)
  const sk = Math.pow(cc.sprawl, 0.85);
  v = { ...v, yardA: [v.yardA[0] * sk, v.yardA[1] * sk], occupancy: Math.min(1, v.occupancy / Math.pow(cc.sprawl, v.occupancy < 1 ? 0.3 : 0)), radius: (p: number) => YARD_VARIANTS[v.id].radius(p) * Math.sqrt(sk) };
  const nFarm = Math.max(3, Math.round(pop / v.per));
  const yardM = (v.yardA[0] + v.yardA[1]) / 2;
  const R = v.radius(pop) - 20;
  // ---- the outline: an oval along the road (germanic), a near circle (celtic rath / hillfort), a loose disc (norse)
  const sr = rng.fork('shape');
  const aspect = v.id === 'germanic' ? sr.range(1.15, 1.5) : v.id === 'celtic' ? sr.range(1, 1.12) : sr.range(1, 1.3);
  const ang = v.id === 'germanic' ? cc.roadAngle + sr.range(-0.3, 0.3) : sr.range(0, Math.PI);
  const nz = new Noise2D(sr.fork('noise'));
  const wob = (t: number) => (v.id === 'celtic' ? 0.04 : 0.08) * nz.noise(Math.cos(t) * 1.3 + 5, Math.sin(t) * 1.3 + 5);
  // the enclosure line at offset `off` outward: an oval (or circle) for a village; for an oppidum the brow of its
  // hill (the line where the ground falls away, smoothed), so the ramparts follow the contours
  let ringAt = (off: number): Polygon => ellipse(c, R * Math.sqrt(aspect) + off, R / Math.sqrt(aspect) + off, ang, 96, wob);
  if (v.id === 'oppidum') {
    const N = 72, hc = ctx.heightAt(c);
    const raw: number[] = [];
    for (let k = 0; k < N; k++) {
      const th = (k / N) * 2 * Math.PI;
      let r = 1.5 * R;
      for (let s2 = 0.6 * R; s2 <= 1.5 * R; s2 += 6) if (ctx.heightAt({ x: c.x + Math.cos(th) * s2, y: c.y + Math.sin(th) * s2 }) < hc - 6) { r = s2; break; }
      raw.push(r);
    }
    let rad = raw;
    for (let pass = 0; pass < 3; pass++) rad = rad.map((_, k) => (rad[(k + N - 1) % N] + 2 * rad[k] + rad[(k + 1) % N]) / 4);
    const A0 = (rad.reduce((a, r) => a + r * r, 0) * Math.PI) / N;
    const kk = Math.sqrt((Math.PI * R * R) / A0);
    rad = rad.map((r) => r * kk);
    ringAt = (off: number): Polygon => orientPos(rad.map((r, k) => { const th = (k / N) * 2 * Math.PI; return { x: c.x + Math.cos(th) * (r + off), y: c.y + Math.sin(th) * (r + off) }; }));
  }
  const outline = ringAt(0);
  // ---- seeds and relaxed Voronoi cells
  const nCells = Math.max(4, Math.round((v.occupancy < 1 ? nFarm / v.occupancy : nFarm + 2) * 1));
  let seeds = seedsIn(outline, nCells, rng.fork('seeds'));
  const bb = bboxOf(outline);
  const box: [number, number, number, number] = [bb.x0 - 60, bb.y0 - 60, bb.x1 + 60, bb.y1 + 60];
  let vor = Delaunay.from(seeds.map((p) => [p.x, p.y] as [number, number])).voronoi(box);
  for (let it = 0; it < 2; it++) {
    seeds = seeds.map((p, i) => {
      const cp = vor.cellPolygon(i);
      if (!cp) return p;
      const poly = cp.slice(0, -1).map(([x, y]) => ({ x, y }));
      const q = polygonCentroid(poly);
      return pointInRing(outline, q) ? q : p;
    });
    vor = Delaunay.from(seeds.map((p) => [p.x, p.y] as [number, number])).voronoi(box);
  }
  // (cells snapped to the boolean grid, 1 mm: the pieces cut from neighbouring cells keep identical shared edges)
  const mm = (v: number) => Math.round(v * 1000) / 1000;
  const cells: Polygon[] = seeds.map((_, i) => orientPos((vor.cellPolygon(i) ?? []).slice(0, -1).map(([x, y]) => ({ x: mm(x), y: mm(y) }))));
  // ---- which cells are farmsteads (norse: a scattered subset, nearest the centre first with gaps)
  const occ = new Set<number>();
  const order = seeds.map((p, i) => ({ i, d: dist(p, c) + rng.fork('occ:' + i).range(0, R * 0.9) })).sort((a, b) => a.d - b.d);
  if (v.occupancy < 1) {
    // scattered farmsteads: cells that do not touch an occupied one first (fields between the farms), then the rest
    const nb = (i: number): number[] => [...vor.delaunay.neighbors(i)];
    for (const o of order) if (occ.size < nFarm && pointInRing(outline, seeds[o.i]) && !nb(o.i).some((j) => occ.has(j))) occ.add(o.i);
    for (const o of order) if (occ.size < nFarm && pointInRing(outline, seeds[o.i])) occ.add(o.i);
  } else for (const o of order) occ.add(o.i);
  // the centre: the thing place (germanic), the chief's roundhouse yard (celtic), the hall farm (norse)
  const centreCell = seeds.reduce((bi, p, i) => (dist(p, c) < dist(seeds[bi], c) ? i : bi), 0);
  occ.add(centreCell);
  // maya: the ceremonial core, plaza groups on the cells round the centre
  const core = new Set<number>();
  if (v.id === 'maya') {
    const Rc = 40 + Math.sqrt(pop) * 1.3;
    seeds.forEach((p, i) => { if (dist(p, c) < Rc) { core.add(i); occ.add(i); } });
    core.add(centreCell);
  }
  // ---- the graph of cell edges
  const nodes: Vec2[] = [];
  const nodeKey = new Map<string, number>();
  const nodeOf = (p: Vec2): number => {
    const k = Math.round(p.x * 100) + ',' + Math.round(p.y * 100);
    let i = nodeKey.get(k);
    if (i === undefined) { i = nodes.length; nodes.push(p); nodeKey.set(k, i); }
    return i;
  };
  const edges: GEdge[] = [];
  const edgeKey = new Map<string, number>();
  cells.forEach((poly, ci) => {
    for (let k = 0; k < poly.length; k++) {
      const a = nodeOf(poly[k]), b = nodeOf(poly[(k + 1) % poly.length]);
      if (a === b) continue;
      const key = Math.min(a, b) + ':' + Math.max(a, b);
      const ei = edgeKey.get(key);
      if (ei !== undefined) { edges[ei].cells.push(ci); continue; }
      const pa = nodes[a], pb = nodes[b];
      const m = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
      edgeKey.set(key, edges.length);
      edges.push({ a, b, cells: [ci], len: dist(pa, pb), inside: pointInRing(outline, pa) && pointInRing(outline, pb) && pointInRing(outline, m) && !ctx.isWater(m) });
    }
  });
  // usable edges: inside, between two cells, at least one of them a farmstead
  const usable = edges.map((e) => e.inside && e.cells.length === 2 && (v.id === 'norse' || v.id === 'maya' || e.cells.some((ci) => occ.has(ci))));
  const adj: number[][] = nodes.map(() => []);
  edges.forEach((e, i) => { if (usable[i]) { adj[e.a].push(i); adj[e.b].push(i); } });
  // ---- gates: where the roads cross the outline (or toward the main road)
  const roadsIn = cc.roads.filter((pl) => dist(pl[pl.length - 1], ctx.center) < 15);
  let gates = roadCrossings(outline, roadsIn);
  if (!gates.length) {
    const a0 = cc.main ? cc.roadAngle : Math.atan2(ctx.center.y - c.y, ctx.center.x - c.x);
    // the outline point in that direction
    let lo = 0, hi = R * 3;
    for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (pointInRing(outline, { x: c.x + Math.cos(a0) * m, y: c.y + Math.sin(a0) * m })) lo = m; else hi = m; }
    gates = [{ p: { x: c.x + Math.cos(a0) * lo, y: c.y + Math.sin(a0) * lo }, dir: { x: -Math.cos(a0), y: -Math.sin(a0) }, road: -1 }];
  }
  // (at most three gates, spread apart)
  gates = gates.filter((g, i) => gates.slice(0, i).every((o) => dist(o.p, g.p) > 40)).slice(0, v.id === 'celtic' ? 2 : v.id === 'oppidum' ? 4 : 3);
  const inNodes = nodes.map((_, i) => adj[i].length > 0);
  const nearestNode = (p: Vec2, pred: (i: number) => boolean = () => true): number => {
    let bi = -1, bd = Infinity;
    nodes.forEach((q, i) => { if (inNodes[i] && pred(i)) { const d = dist(q, p); if (d < bd) { bd = d; bi = i; } } });
    return bi;
  };
  // ---- path tree: Dijkstra from the centre to every gate (main paths), then a pruned random spanning tree
  const er = rng.fork('edges');
  const wgt = edges.map((e) => e.len * er.range(0.75, 1.35));
  const cNode = nearestNode(polygonCentroid(cells[centreCell]), (i) => adj[i].some((ei) => edges[ei].cells.includes(centreCell)));
  const dij = (src: number): { prev: number[]; d: number[] } => {
    const d = nodes.map(() => Infinity), prev = nodes.map(() => -1), done = nodes.map(() => false);
    d[src] = 0;
    const heap = new MinHeap<number>();
    heap.push(src, 0);
    while (heap.size) {
      const u = heap.pop()!;
      if (done[u]) continue;
      done[u] = true;
      for (const ei of adj[u]) {
        const e = edges[ei], w = e.a === u ? e.b : e.a;
        if (d[u] + wgt[ei] < d[w]) { d[w] = d[u] + wgt[ei]; prev[w] = ei; heap.push(w, d[w]); }
      }
    }
    return { prev, d };
  };
  const inPath = new Set<number>();
  const mainEdges = new Set<number>();
  const gateLinks: { gate: Vec2; node: number; dir: Vec2 }[] = [];
  if (cNode >= 0) {
    const D = dij(cNode);
    for (const g of gates) {
      const gn = nearestNode(g.p, (i) => D.d[i] < Infinity);
      if (gn < 0) continue;
      gateLinks.push({ gate: g.p, node: gn, dir: g.dir });
      let u = gn;
      while (u !== cNode && D.prev[u] >= 0) { const ei = D.prev[u]; inPath.add(ei); mainEdges.add(ei); const e = edges[ei]; u = e.a === u ? e.b : e.a; }
    }
  }
  // Kruskal over the usable edges (random weights), the main paths first
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const ei of inPath) { const e = edges[ei]; parent[find(e.a)] = find(e.b); }
  const idx = edges.map((_, i) => i).filter((i) => usable[i] && !inPath.has(i)).sort((x, y) => wgt[x] - wgt[y]);
  const tree = new Set<number>(inPath);
  for (const ei of idx) { const e = edges[ei]; const ra = find(e.a), rb = find(e.b); if (ra !== rb) { parent[ra] = rb; tree.add(ei); } }
  // keep only the tree component holding the centre
  if (cNode >= 0) {
    const root = find(cNode);
    for (const ei of [...tree]) if (find(edges[ei].a) !== root) tree.delete(ei);
  }
  // prune: a leaf edge goes unless it is the only ≥ 4 m frontage of a farmstead or part of a main path
  const degA = new Int32Array(nodes.length);
  const cnt = new Int32Array(cells.length);
  for (const ei of tree) { const e = edges[ei]; degA[e.a]++; degA[e.b]++; if (e.len >= 4) for (const ci of e.cells) cnt[ci]++; }
  const isLeaf = (ei: number) => degA[edges[ei].a] <= 1 || degA[edges[ei].b] <= 1;
  const stack = [...tree].filter(isLeaf).reverse();
  while (stack.length) {
    const ei = stack.pop()!;
    if (!tree.has(ei) || mainEdges.has(ei) || !isLeaf(ei)) continue;
    const e = edges[ei];
    if (e.len >= 4 && e.cells.some((ci) => occ.has(ci) && cnt[ci] <= 1)) continue;
    tree.delete(ei);
    degA[e.a]--; degA[e.b]--;
    if (e.len >= 4) for (const ci of e.cells) cnt[ci]--;
    for (const u of [e.a, e.b]) if (degA[u] === 1) for (const x of adj[u]) if (tree.has(x)) stack.push(x);
  }
  const deg = (u: number): number => degA[u];
  // a few loops (paths meeting again round a yard), never along the outline
  const lr = rng.fork('loops');
  for (const ei of idx) if (!tree.has(ei) && lr.chance(v.id === 'norse' ? 0.04 : 0.26) && deg(edges[ei].a) > 0 && deg(edges[ei].b) > 0 && edges[ei].len > 6) { tree.add(ei); degA[edges[ei].a]++; degA[edges[ei].b]++; }
  // ---- chain the tree edges into path polylines (through the degree-2 nodes)
  const used = new Set<number>();
  const polylines: { pts: Vec2[]; main: boolean }[] = [];
  const treeDeg = (u: number) => deg(u);
  const walk = (start: number, ei0: number): void => {
    const pts: Vec2[] = [nodes[start]];
    let u = start, ei = ei0, main = mainEdges.has(ei0);
    for (;;) {
      used.add(ei);
      const e = edges[ei];
      const w = e.a === u ? e.b : e.a;
      pts.push(nodes[w]);
      if (treeDeg(w) !== 2) break;
      const next = adj[w].find((x) => tree.has(x) && !used.has(x) && mainEdges.has(x) === mainEdges.has(ei));
      if (next === undefined) break;
      u = w; ei = next; main = main && mainEdges.has(ei);
    }
    polylines.push({ pts, main });
  };
  for (let u = 0; u < nodes.length; u++) if (treeDeg(u) && treeDeg(u) !== 2) for (const ei of adj[u]) if (tree.has(ei) && !used.has(ei)) walk(u, ei);
  for (const ei of tree) if (!used.has(ei)) walk(edges[ei].a, ei);
  // the gate links: from the gate node straight out through the gate (a little beyond the outline)
  for (const gl of gateLinks) {
    const n = nodes[gl.node];
    const L = dist(n, gl.gate) || 1;
    const ux = (gl.gate.x - n.x) / L, uy = (gl.gate.y - n.y) / L;
    polylines.push({ pts: [n, { x: gl.gate.x + ux * 6, y: gl.gate.y + uy * 6 }], main: true });
  }
  // (maya: the main ways are the sacbeob, broad white causeways from the core)
  const streets: UrbanStreet[] = polylines.filter((p) => p.pts.length >= 2).map((p) => street(p.pts, p.main ? (v.id === 'maya' ? 8 : v.id === 'oppidum' ? 7 : v.pathW + 1.2) : v.pathW, p.main ? 1 : 3, p.main ? 'radial' : 'lane'));
  if (!streets.some((s) => s.role === 'radial') && streets.length) { streets[0].role = 'radial'; streets[0].rank = 1; streets[0].kind = 'main'; }
  out.streets.push(...streets);
  const rib = pathRibbons(streets);
  // ---- quarters and blocks. A nucleated village: the whole outline is one quarter, cut by its paths into blocks,
  // the blocks by the yard cells. A scatter of farms (norse, maya): every farm cell is a quarter of its own (cut by
  // the paths crossing it) and every path ribbon is a quarter of street space: no union of thousands of pieces.
  const ribList = rib.map((ph) => ({ ph, bb: bboxOf(ph.outer) }));
  const near = <T extends { bb: { x0: number; y0: number; x1: number; y1: number } }>(list: T[], bb: { x0: number; y0: number; x1: number; y1: number }, pad = 1): T[] => list.filter((r) => !(r.bb.x0 > bb.x1 + pad || r.bb.x1 < bb.x0 - pad || r.bb.y0 > bb.y1 + pad || r.bb.y1 < bb.y0 - pad));
  const waterList = ctx.water.map((ph) => ({ ph, bb: bboxOf(ph.outer) }));
  const minusWater = (m: MultiPoly, bb: ReturnType<typeof bboxOf>): MultiPoly => { const wn = near(waterList, bb).map((w) => [w.ph] as MultiPoly); return wn.length && m.length ? differenceS(m, ...wn) : m; };
  const blockList: { poly: Polygon; bb: ReturnType<typeof bboxOf>; bi: number; parts: { poly: Polygon; tag: number }[] }[] = [];
  const sparse = v.id === 'norse' || v.id === 'maya';
  if (sparse) {
    for (const ci of occ) {
      const cb = bboxOf(cells[ci]);
      for (const P of pieces(minusWater(intersectionS(cells[ci], outline), cb), 150)) {
        const Q = snapRing(P);
        const qi = out.quarters.length;
        out.quarters.push(Q);
        out.outline.push(Q);
        for (const blk of carveBlocks(Q, near(ribList, cb).map((r) => r.ph), [])) {
          const bi = out.blocks.length;
          out.blocks.push({ poly: blk, kind: 'block', quarter: qi });
          blockList.push({ poly: blk, bb: bboxOf(blk), bi, parts: [{ poly: blk, tag: ci }] });
        }
      }
    }
    // the paths across the fields: street space of their own
    for (const r of ribList) for (const P of pieces(minusWater(intersectionS([r.ph], outline), r.bb), 4)) { const Q = snapRing(P); out.quarters.push(Q); }
  } else {
    const quarters = (ctx.water.length ? pieces(differenceS([{ outer: outline, holes: [] }], ctx.water), 400) : [outline]).map(snapRing);
    const cellList = cells.map((poly, tag) => ({ poly, tag })).filter((x) => x.poly.length >= 3);
    quarters.forEach((Q) => {
      const qi = out.quarters.length;
      out.quarters.push(Q);
      out.outline.push(Q);
      const qbb = bboxOf(Q);
      for (const blk of carveBlocks(Q, near(ribList, qbb).map((r) => r.ph), near(waterList, qbb).map((r) => r.ph))) {
        const bi = out.blocks.length;
        out.blocks.push({ poly: blk, kind: 'block', quarter: qi });
        blockList.push({ poly: blk, bb: bboxOf(blk), bi, parts: cutByCells(blk, cellList) });
      }
    });
  }
  const front = new FrontIndex(out.streets);
  const chief: number[] = [];
  for (const blk of blockList) {
    const bi = blk.bi;
    // (whatever of the block no cell piece covers stays open ground: the block is exactly its parcels)
    const A = area(blk.poly), S = blk.parts.reduce((a, p) => a + area(p.poly), 0);
    if (S < A * 0.997) for (const q of pieces(blk.parts.length ? difference([{ outer: blk.poly, holes: [] }], ...blk.parts.map((p) => [{ outer: p.poly, holes: [] }] as MultiPoly)) : [{ outer: blk.poly, holes: [] }], 0.5)) blk.parts.push({ poly: q, tag: -1 });
    for (const pc of mergeSmall(blk.parts)) {
      const pi = out.parcels.length;
      const fr = front.frontage(pc.poly);
      const isCentre = pc.tag === centreCell;
      if (isCentre && v.id === 'germanic') { out.parcels.push({ poly: pc.poly, use: 'meadow', block: bi }); out.squares.push(pc.poly); continue; }
      if (core.has(pc.tag)) { plazaGroup(out, pc.poly, bi, isCentre, c, rng.fork('plaza:' + pc.tag)); continue; }
      if (isCentre && v.id === 'oppidum') { sanctuary(out, pc.poly, bi); continue; }
      if (isCentre && v.id === 'halfling') { partyField(out, pc.poly, bi, rng.fork('party')); continue; }
      if (!occ.has(pc.tag) || fr.len < 3.2 || area(pc.poly) < 160) { out.parcels.push({ poly: pc.poly, use: 'garden', block: bi }); continue; }
      out.parcels.push({ poly: pc.poly, use: 'plot', block: bi });
      if (isCentre || ((v.id === 'germanic' || v.id === 'halfling') && chief.length === 0 && touchesCell(pc.tag, centreCell, edges))) chief.push(pi);
      farmstead(out, pi, pc.poly, v, chief.includes(pi), fr.mid, rng.fork('farm:' + bi + ':' + pc.tag));
    }
  }
  // ---- the enclosure
  if (v.id === 'germanic') {
    // palisade (a light wall without towers), the ditch outside it
    const gs = gateLinks.map((g) => ({ p: g.gate, width: v.pathW + 2.5 }));
    const wf = wallFeatures(outline, gs, rng.fork('pal'), ctx.isWater, () => false, 1e9);
    out.walls.push({ path: outline, closed: true, towers: [], gates: gs.map((g) => g.p), thickness: 1.1, gateInfo: gateLinks.map((g) => ({ p: g.gate, dir: g.dir, width: v.pathW + 2.5 })), pieces: wf.pieces, gateTowers: wf.gateTowers, towerScale: [], curtains: [], towerShape: 'square', role: 'town' });
    const ditch = ringAt(6);
    out.lines.push(...openRing(ditch, gateLinks.map((g) => ({ p: nearestOn(ditch, g.gate), width: v.pathW + 4 }))).map((pl) => ({ kind: 'ditch', path: pl, width: 4 })));
    out.outline.push(ditch);
  } else if (v.id === 'celtic' || v.id === 'oppidum') {
    // earthen rampart on the outline, its ditch outside; a second bank and ditch for a hillfort-size village, three
    // for an oppidum (the murus gallicus and its outworks)
    const banks = v.id === 'oppidum' ? (pop > 2500 ? 3 : 2) : pop > 260 ? 2 : 1;
    for (let k = 0; k < banks; k++) {
      const off = k * 14 + 3.5;
      const ring = k === 0 ? outline : ringAt(off);
      const ringB = k === 0 ? ringAt(3.5) : ring;
      const gaps = gateLinks.map((g) => ({ p: nearestOn(ringB, g.gate), width: v.pathW + 3 }));
      for (const pl of openRing(ringB, gaps)) out.lines.push({ kind: 'rampart', path: pl, width: 6 });
      const ditch = ringAt(off + 6.5);
      for (const pl of openRing(ditch, gateLinks.map((g) => ({ p: nearestOn(ditch, g.gate), width: v.pathW + 3 })))) out.lines.push({ kind: 'ditch', path: pl, width: 3.5 });
      const outerFace = ringAt(off + 3);
      out.lines.push(...hachures(outerFace, 2.4, 2.2, -1, (p) => gateLinks.some((g) => dist(g.gate, p) < v.pathW + 5 + off)));
      if (k === banks - 1) out.outline.push(ringAt(off + 9));
    }
    out.sites.push({ id: 'ringfort', kind: v.id === 'oppidum' ? 'oppidum' : pop > 260 ? 'hillfort' : 'ringfort', role: 'power', lot: outline, anchor: c });
  }
  void inscribed; void obb; void ringSamples; void rect;
  return out;
}

const touchesCell = (a: number, b: number, edges: GEdge[]): boolean => edges.some((e) => e.cells.includes(a) && e.cells.includes(b));

function nearestOn(ring: Polygon, p: Vec2): Vec2 {
  let best = ring[0], bd = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = dist(q, p);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

/** The buildings of one farmstead (or the chieftain's hall yard), fitted inside the yard. */
function farmstead(out: CampOut, pi: number, yard: Polygon, v: YardVariant, chief: boolean, frontMid: Vec2 | null, r: Rng): void {
  const placed: Polygon[] = [];
  const A = area(yard);
  const o = obb(yard);
  const long = Math.atan2(o.u.y, o.u.x);
  const push = (poly: Polygon, kind: string, arch: string, roof: Parameters<typeof out.buildings.push>[0]['roof'], material: string, orientation?: number) => {
    placed.push(poly);
    out.buildings.push({ poly, kind, parcel: pi, arch, roof, storeys: 1, material, orientation });
  };
  if (v.id === 'halfling') {
    // a smial dug into the bank at the back of the garden, its round door to the lane; the garden in front, a
    // shed, fruit trees; a hedge round the garden, open at the gate (the inn by the party field is bigger)
    const ins = inscribed(yard, [], 0.5);
    const toward = frontMid ? { x: frontMid.x - ins.c.x, y: frontMid.y - ins.c.y } : { x: 0, y: 1 };
    const tl = Math.hypot(toward.x, toward.y) || 1;
    const u = { x: toward.x / tl, y: toward.y / tl };
    const a = Math.atan2(u.y, u.x) + Math.PI / 2;
    const L0 = chief ? r.range(20, 26) : r.range(11, 16), W0 = chief ? r.range(11, 13) : r.range(7, 9);
    const back = { x: ins.c.x - u.x * ins.r * 0.35, y: ins.c.y - u.y * ins.r * 0.35 };
    const sm = fitIn(yard, (q, s2) => apsidal(q, a, L0 * s2, W0 * Math.max(0.8, s2), 6), placed, { margin: 2, gap: 0, minScale: 0.6, cands: [back, ins.c] });
    if (!sm) return;
    push(sm, chief ? 'landmark' : 'house', chief ? 'inn' : 'smial', 'dome', 'turf', a);
    if (chief) out.landmarks.push({ kind: 'inn', poly: sm });
    // the bank the smial is dug into: hachures behind it
    out.lines.push({ kind: 'bank', path: sm.filter((q) => (q.x - ins.c.x) * u.x + (q.y - ins.c.y) * u.y < -0.5), width: 0.8 });
    const sh = fitIn(yard, (q, s2) => rect(q, a, 4 * s2, 3 * s2), placed, { margin: 1.2, gap: 2.5, minScale: 0.85 });
    if (sh && r.chance(0.6)) push(sh, 'outbuilding', 'garden-shed', 'gable', 'timber');
    // the vegetable garden in front of the door, fruit trees round the garden
    const bed = rect({ x: ins.c.x + u.x * ins.r * 0.45, y: ins.c.y + u.y * ins.r * 0.45 }, a, Math.min(14, ins.r * 1.1), Math.min(7, ins.r * 0.5));
    if (bed.every((q) => pointInRing(yard, q)) && !placed.some((p) => p.some((q) => pointInRing(bed, q)) || bed.some((q) => pointInRing(p, q)))) out.landmarks.push({ kind: 'garden-bed', poly: bed });
    out.trees = out.trees ?? [];
    for (let k = 0; k < r.int(1, 4); k++) {
      const tq = { x: ins.c.x + r.range(-1, 1) * ins.r * 0.8, y: ins.c.y + r.range(-1, 1) * ins.r * 0.8 };
      const tr = r.range(2.5, 4);
      if (pointInRing(yard, tq) && !placed.some((p) => pointInRing(p, tq) || p.some((q) => dist(q, tq) < tr + 0.5))) out.trees.push({ x: tq.x, y: tq.y, r: tr });
    }
    for (const pl of openRing(yard, frontMid ? [{ p: frontMid, width: 2.6 }] : [])) out.lines.push({ kind: 'hedge', path: pl, width: 1.6 });
    return;
  }
  if (v.id === 'maya') {
    // a houselot (solar): two to four rooms on low platforms round a patio, the house garden round them
    const ins = inscribed(yard, [], 0.5).c;
    const sp = r.range(6.5, 8.5);
    const n = r.int(2, 4);
    const sides: [number, number, number][] = [[0, -sp, 0], [sp, 0, Math.PI / 2], [0, sp, 0], [-sp, 0, Math.PI / 2]];
    for (const [dx, dy, a] of sides.slice(0, n)) {
      const g = fitIn(yard, (q, s2) => rect(q, a, r.range(7, 10) * s2, 4.2 * s2), placed, { margin: 1.5, gap: 1.2, minScale: 0.75, cands: [{ x: ins.x + dx, y: ins.y + dy }] });
      if (g) push(g, 'house', 'maya-house', 'thatch-round', 'wattle', a);
    }
    if (placed.length) {
      const pf = rect(ins, 0, 2 * sp + 8, 2 * sp + 8);
      if (pf.every((q) => pointInRing(yard, q))) out.lines.push({ kind: 'platform', path: pf.concat([pf[0]]), width: 0.6 });
    }
    return;
  }
  if (v.id === 'celtic' || v.id === 'oppidum') {
    const R0 = chief ? r.range(7, 9) : Math.min(7, Math.max(4.2, Math.sqrt(A) * 0.17 + r.range(-0.6, 0.6)));
    const main = fitIn(yard, (q, s) => hut(q, R0 * s, 16), placed, { margin: 1.6, gap: 0, minScale: 0.65 });
    if (!main) return;
    push(main, chief ? 'landmark' : 'house', chief ? 'chief-roundhouse' : 'roundhouse', 'thatch-round', 'wattle');
    if (chief) out.landmarks.push({ kind: 'chief-roundhouse', poly: main });
    // a second roundhouse in larger yards, four-post granaries, storage pits
    if (A > 900 && r.chance(0.45)) { const h2 = fitIn(yard, (q, s) => hut(q, R0 * 0.7 * s, 14), placed, { margin: 1.2, gap: 2, minScale: 0.75 }); if (h2) push(h2, 'house', 'roundhouse', 'thatch-round', 'wattle'); }
    const ng = 1 + (r.chance(0.5) ? 1 : 0) + (chief ? 2 : 0);
    for (let k = 0; k < ng; k++) { const g = fitIn(yard, (q, s) => rect(q, long, 2.8 * s, 2.8 * s), placed, { margin: 1, gap: 1.5, minScale: 0.85 }); if (g) push(g, 'outbuilding', 'four-post-granary', 'gable', 'timber'); }
    for (let k = 0; k < (chief ? 4 : 2); k++) { const g = fitIn(yard, (q, s) => hut(q, 1.15 * s, 8), placed, { margin: 1, gap: 1.2, minScale: 0.95 }); if (g) push(g, 'pit', 'storage-pit', 'none', 'earth'); }
    // oppidum yards: a rectangular timber hall or workshop (smith, potter, mint) on the street front, the yard fenced
    if (v.id === 'oppidum' && frontMid) {
      const o2 = obb(yard);
      const wk = fitIn(yard, (q, s) => rect(q, Math.atan2(o2.u.y, o2.u.x), r.range(9, 14) * s, r.range(6, 7.5) * s), placed, { margin: 1.2, gap: 2, minScale: 0.75, cands: [{ x: frontMid.x + (o2.c.x - frontMid.x) * 0.3, y: frontMid.y + (o2.c.y - frontMid.y) * 0.3 }] });
      if (wk) push(wk, 'house', r.pick(['workshop', 'workshop', 'forge', 'timber-hall']), 'gable', 'timber');
    }
    if (v.id === 'oppidum') for (const pl of openRing(yard, frontMid ? [{ p: frontMid, width: 3 }] : [])) out.lines.push({ kind: 'yard-fence', path: pl, width: 0.45 });
    return;
  }
  // longhouse: germanic roughly east–west (with the yard's axis when it is narrow), norse along the yard
  const W = chief ? r.range(7.5, 9) : r.range(5.4, 6.8);
  const Lmax = chief ? r.range(32, 44) : Math.min(v.id === 'norse' ? 34 : 30, Math.max(15, Math.sqrt(A) * 0.75));
  const eastWest = r.range(-0.2, 0.2);
  const angs = v.id === 'germanic' ? [eastWest, long, eastWest + 0.35, eastWest - 0.35] : [long, long + 0.25, long - 0.25];
  let house: Polygon | null = null, hAng = angs[0];
  for (const a of angs) {
    house = fitIn(yard, (q, s) => (v.id === 'norse' ? bowSided(q, a, Lmax * s, W * Math.max(0.85, s)) : apsidal(q, a, Lmax * s, W * Math.max(0.85, s), 2)), placed, { margin: 1.6, gap: 0, minScale: 0.55 });
    if (house) { hAng = a; break; }
  }
  if (!house) return;
  const arch = chief ? (v.id === 'norse' ? 'hall' : 'chieftain-hall') : v.id === 'norse' ? 'longhouse' : r.chance(0.65) ? 'byre-house' : 'longhouse';
  push(house, chief ? 'landmark' : 'house', arch, 'gable', v.id === 'norse' ? 'turf' : 'thatch', hAng);
  if (chief) out.landmarks.push({ kind: arch, poly: house });
  // outbuildings: granary on posts, sunken huts / pit houses, a byre or barn (norse), a fenced cattle pen
  const nG = chief ? 3 : r.int(1, 2);
  for (let k = 0; k < nG; k++) { const g = fitIn(yard, (q, s) => rect(q, hAng, 3 * s, 3 * s), placed, { margin: 1, gap: 2, minScale: 0.85 }); if (g) push(g, 'outbuilding', 'granary-on-posts', 'gable', 'timber'); }
  const nS = chief ? 3 : r.int(1, v.id === 'norse' ? 2 : 3);
  for (let k = 0; k < nS; k++) { const g = fitIn(yard, (q, s) => rect(q, hAng + r.range(-0.3, 0.3), 4 * s, 3 * s), placed, { margin: 1, gap: 2, minScale: 0.85 }); if (g) push(g, 'outbuilding', v.id === 'norse' ? 'pit-house' : 'sunken-hut', 'gable', 'timber'); }
  if (v.id === 'norse' || chief) {
    const g = fitIn(yard, (q, s) => rect(q, hAng + Math.PI / 2 * (r.chance(0.5) ? 1 : 0), 10 * s, 5 * s), placed, { margin: 1.2, gap: 3, minScale: 0.7 });
    if (g) push(g, 'outbuilding', v.id === 'norse' ? 'byre' : 'barn', 'gable', v.id === 'norse' ? 'turf' : 'thatch');
  }
  if (A > 1100 && r.chance(0.6)) {
    const pen = fitIn(yard, (q, s) => rect(q, hAng, 11 * s, 8 * s), placed, { margin: 1.2, gap: 2.5, minScale: 0.7 });
    if (pen) { out.lines.push({ kind: 'pen-fence', path: pen.concat([pen[0]]), width: 0.5 }); placed.push(pen); }
  }
  // the yard fence, open at the path
  const gate = frontMid ? [{ p: frontMid, width: 3 }] : [];
  for (const pl of openRing(yard, gate)) out.lines.push({ kind: 'yard-fence', path: pl, width: 0.45 });
}

/** A plaza group of the Maya ceremonial core: an open plaza with its temple pyramid (or palace ranges, a ballcourt). */
function plazaGroup(out: CampOut, poly: Polygon, bi: number, main: boolean, centre: Vec2, r: Rng): void {
  const pi = out.parcels.length;
  out.parcels.push({ poly, use: 'plaza', block: bi });
  if (main) out.squares.push(poly);
  const tmp: CompoundOut = { parcels: [{ poly, use: 'place' }], buildings: [], lines: [], water: [], landmarks: [] };
  const ins = inscribed(poly, [], 0.5);
  const toC = Math.atan2(centre.y - ins.c.y, centre.x - ins.c.x);
  const kind = main ? 'temple' : r.pick(['temple', 'temple', 'palace', 'ballcourt']);
  const clear = (g: Polygon) => !tmp.buildings.some((b) => b.poly.some((q) => pointInRing(g, q)) || g.some((q) => pointInRing(b.poly, q)));
  if (kind === 'temple') {
    // the temple pyramid on the side away from the centre, facing the plaza (the great one east of the main plaza)
    const h = Math.max(6, Math.min(main ? 24 : 15, ins.r * (main ? 0.5 : 0.6)));
    const pc = main ? { x: ins.c.x + ins.r * 0.45, y: ins.c.y } : { x: ins.c.x - Math.cos(toC) * ins.r * 0.3, y: ins.c.y - Math.sin(toC) * ins.r * 0.3 };
    const T = pyramid(tmp, poly, pc, 0, h, main ? 'great-pyramid' : 'temple-pyramid', main ? Math.PI : toC, false);
    if (T) tmp.landmarks.push({ kind: 'maya-temple', poly: T });
    // the great plaza: a second temple facing the first across it (Tikal's Temples I and II)
    if (main) {
      const T2 = pyramid(tmp, poly, { x: ins.c.x - ins.r * 0.5, y: ins.c.y }, 0, h * 0.8, 'temple-pyramid', 0, false);
      if (T2) tmp.landmarks.push({ kind: 'maya-temple', poly: T2 });
    }
    for (let k = 0; k < (main ? 3 : 1); k++) {
      const st = placeRect(poly, { x: ins.c.x - ins.r * 0.2, y: ins.c.y + (k - 1) * 6 }, 0, 1.15, 1.15, 1);
      if (st && clear(st)) tmp.buildings.push({ poly: st, kind: 'landmark', parcel: 0, arch: 'stela', roof: 'none', material: 'stone', storeys: 1 });
    }
  } else if (kind === 'palace') {
    // range buildings round a courtyard (acropolis)
    const s = Math.min(16, ins.r * 0.7);
    for (const [dx, dy, a] of [[0, -s, 0], [0, s, 0], [-s, 0, Math.PI / 2], [s, 0, Math.PI / 2]] as [number, number, number][]) {
      const g = placeRect(poly, { x: ins.c.x + dx, y: ins.c.y + dy }, a, s * 0.75, 2.6, 1);
      if (g && clear(g)) tmp.buildings.push({ poly: g, kind: 'landmark', parcel: 0, arch: 'palace-range', roof: 'flat', material: 'stone', storeys: 1 });
    }
  } else {
    const L = Math.min(30, ins.r * 1.2);
    for (const sg of [-1, 1]) {
      const g = placeRect(poly, { x: ins.c.x, y: ins.c.y + sg * 6 }, 0, L / 2, 2.5, 1);
      if (g && clear(g)) tmp.buildings.push({ poly: g, kind: 'landmark', parcel: 0, arch: 'ballcourt-range', roof: 'flat', material: 'stone', storeys: 1 });
    }
  }
  for (const b of tmp.buildings) out.buildings.push({ ...b, parcel: pi });
  out.lines.push(...tmp.lines);
  out.landmarks.push(...tmp.landmarks);
}

/** The sanctuary of an oppidum: a square ditched enclosure (Viereckschanze) with its square temple (fanum). */
function sanctuary(out: CampOut, poly: Polygon, bi: number): void {
  const pi = out.parcels.length;
  out.parcels.push({ poly, use: 'compound:sanctuary', block: bi });
  const ins = inscribed(poly, [], 0.5);
  const h = Math.min(32, ins.r * 0.78);
  if (h < 8) return;
  const sqr = (k: number): Polygon => rect(ins.c, 0, 2 * h * k, 2 * h * k);
  out.lines.push({ kind: 'ditch', path: sqr(1).concat([sqr(1)[0]]), width: 2.5 });
  const cella = sqr(0.18), gal = sqr(0.34);
  if (gal.every((q) => pointInRing(poly, q))) {
    out.buildings.push({ poly: gal, kind: 'landmark', parcel: pi, arch: 'fanum', roof: 'pyramidal', material: 'timber', storeys: 1 });
    out.lines.push({ kind: 'pyramid-step', path: cella.concat([cella[0]]), width: 0.6 });
    out.landmarks.push({ kind: 'sanctuary', poly: sqr(1) });
  }
  out.sites.push({ id: 'sanctuary', kind: 'sanctuary', role: 'worship', lot: poly, anchor: ins.c });
}

/** The party field of a halfling village: open grass with the party tree in the middle. */
function partyField(out: CampOut, poly: Polygon, bi: number, r: Rng): void {
  out.parcels.push({ poly, use: 'meadow', block: bi });
  out.squares.push(poly);
  const ins = inscribed(poly, [], 0.5);
  out.trees = out.trees ?? [];
  if (ins.r > 8) out.trees.push({ x: ins.c.x + r.range(-2, 2), y: ins.c.y + r.range(-2, 2), r: Math.min(9, ins.r * 0.35) });
  out.landmarks.push({ kind: 'party-field', poly });
}
