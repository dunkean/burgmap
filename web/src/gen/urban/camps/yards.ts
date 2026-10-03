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
import { area, orientPos, pointInRing, inscribed, obb, bboxOf } from '../../geo/poly';
import { unionS, intersectionS, MultiPoly } from '../../geo/bool';
import { Noise2D } from '../../core/noise';
import type { CampCtx } from './index';
import {
  CampOut, emptyCamp, street, ellipse, carveBlocks, pathRibbons, cutByCells, FrontIndex, hut, rect, apsidal, bowSided,
  fitIn, openRing, roadCrossings, hachures, pieces, ringSamples,
} from './kit';
import { wallFeatures } from '../walls';

export interface YardVariant {
  id: 'germanic' | 'celtic' | 'norse';
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
  norse: { id: 'norse', per: 14, yardA: [2600, 5200], pathW: 3.2, occupancy: 0.32, radius: yardRadius(14, [2600, 5200], 0.32) },
};

interface GEdge { a: number; b: number; cells: number[]; len: number; inside: boolean }

/** Relaxed jittered seeds inside a ring (dart throwing with a minimum spacing, then Lloyd steps). */
function seedsIn(ring: Polygon, n: number, rng: Rng): Vec2[] {
  const bb = bboxOf(ring);
  const A = area(ring);
  const d0 = Math.sqrt(A / n) * 0.8;
  const pts: Vec2[] = [];
  for (let tries = 0; tries < n * 60 && pts.length < n; tries++) {
    const p = { x: rng.range(bb.x0, bb.x1), y: rng.range(bb.y0, bb.y1) };
    if (!pointInRing(ring, p)) continue;
    if (pts.some((q) => dist(q, p) < d0)) continue;
    pts.push(p);
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
  const outline = ellipse(c, R * Math.sqrt(aspect), R / Math.sqrt(aspect), ang, 96, wob);
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
  const cells: Polygon[] = seeds.map((_, i) => orientPos((vor.cellPolygon(i) ?? []).slice(0, -1).map(([x, y]) => ({ x, y }))));
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
  const usable = edges.map((e) => e.inside && e.cells.length === 2 && (v.id === 'norse' || e.cells.some((ci) => occ.has(ci))));
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
  gates = gates.filter((g, i) => gates.slice(0, i).every((o) => dist(o.p, g.p) > 40)).slice(0, v.id === 'celtic' ? 2 : 3);
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
    for (;;) {
      let u = -1, bd = Infinity;
      for (let i = 0; i < nodes.length; i++) if (!done[i] && d[i] < bd) { bd = d[i]; u = i; }
      if (u < 0) break;
      done[u] = true;
      for (const ei of adj[u]) {
        const e = edges[ei], w = e.a === u ? e.b : e.a;
        if (d[u] + wgt[ei] < d[w]) { d[w] = d[u] + wgt[ei]; prev[w] = ei; }
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
  const frontCount = (ci: number): number => { let n = 0; for (const ei of tree) if (edges[ei].len >= 4 && edges[ei].cells.includes(ci)) n++; return n; };
  const deg = (u: number): number => { let n = 0; for (const ei of adj[u]) if (tree.has(ei)) n++; return n; };
  for (let changed = true, guard = 0; changed && guard < 50; guard++) {
    changed = false;
    for (const ei of [...tree]) {
      if (mainEdges.has(ei)) continue;
      const e = edges[ei];
      if (deg(e.a) > 1 && deg(e.b) > 1) continue;
      const needed = e.len >= 4 && e.cells.some((ci) => occ.has(ci) && frontCount(ci) <= 1);
      if (!needed) { tree.delete(ei); changed = true; }
    }
  }
  // a few loops (paths meeting again round a yard), never along the outline
  const lr = rng.fork('loops');
  for (const ei of idx) if (!tree.has(ei) && lr.chance(v.id === 'norse' ? 0.04 : 0.26) && deg(edges[ei].a) > 0 && deg(edges[ei].b) > 0 && edges[ei].len > 6) tree.add(ei);
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
  const streets: UrbanStreet[] = polylines.filter((p) => p.pts.length >= 2).map((p) => street(p.pts, p.main ? v.pathW + 1.2 : v.pathW, p.main ? 1 : 3, p.main ? 'radial' : 'lane'));
  if (!streets.some((s) => s.role === 'radial') && streets.length) { streets[0].role = 'radial'; streets[0].rank = 1; streets[0].kind = 'main'; }
  out.streets.push(...streets);
  const rib = pathRibbons(streets);
  // ---- the quarter: the whole outline (germanic, celtic); the farmsteads and their tracks (norse)
  let quarters: Polygon[];
  if (v.id === 'norse') {
    const occCells: MultiPoly = [...occ].map((ci) => ({ outer: cells[ci], holes: [] }));
    let q = unionS(occCells, rib);
    q = q.length ? intersectionS(q, outline) : q;
    quarters = pieces(q, 400).filter((p) => streets.some((s) => s.path.some((pt) => pointInRing(p, pt))));
  } else quarters = [outline];
  out.quarters.push(...quarters);
  out.outline.push(...quarters);
  const front = new FrontIndex(out.streets);
  const cellList = cells.map((poly, tag) => ({ poly, tag }));
  // ---- blocks and yards
  const chief: number[] = [];
  quarters.forEach((Q, qi) => {
    for (const b of carveBlocks(Q, rib, ctx.water)) {
      const bi = out.blocks.length;
      out.blocks.push({ poly: b, kind: 'block', quarter: qi });
      for (const pc of cutByCells(b, cellList)) {
        const pi = out.parcels.length;
        const fr = front.frontage(pc.poly);
        const isCentre = pc.tag === centreCell;
        if (isCentre && v.id === 'germanic') { out.parcels.push({ poly: pc.poly, use: 'meadow', block: bi }); out.squares.push(pc.poly); continue; }
        if (!occ.has(pc.tag) || fr.len < 3.2 || area(pc.poly) < 160) { out.parcels.push({ poly: pc.poly, use: v.id === 'norse' ? 'garden' : 'garden', block: bi }); continue; }
        out.parcels.push({ poly: pc.poly, use: 'plot', block: bi });
        if (isCentre || (v.id === 'germanic' && chief.length === 0 && touchesCell(pc.tag, centreCell, edges))) chief.push(pi);
        farmstead(out, pi, pc.poly, v, chief.includes(pi), fr.mid, rng.fork('farm:' + bi + ':' + pc.tag));
      }
    }
  });
  // ---- the enclosure
  if (v.id === 'germanic') {
    // palisade (a light wall without towers), the ditch outside it
    const gs = gateLinks.map((g) => ({ p: g.gate, width: v.pathW + 2.5 }));
    const wf = wallFeatures(outline, gs, rng.fork('pal'), ctx.isWater, () => false, 1e9);
    out.walls.push({ path: outline, closed: true, towers: [], gates: gs.map((g) => g.p), thickness: 1.1, gateInfo: gateLinks.map((g) => ({ p: g.gate, dir: g.dir, width: v.pathW + 2.5 })), pieces: wf.pieces, gateTowers: wf.gateTowers, towerScale: [], curtains: [], towerShape: 'square', role: 'town' });
    const ditch = ellipse(c, R * Math.sqrt(aspect) + 6, R / Math.sqrt(aspect) + 6, ang, 96, wob);
    out.lines.push(...openRing(ditch, gateLinks.map((g) => ({ p: nearestOn(ditch, g.gate), width: v.pathW + 4 }))).map((pl) => ({ kind: 'ditch', path: pl, width: 4 })));
    out.outline.push(ditch);
  } else if (v.id === 'celtic') {
    // earthen rampart on the outline, its ditch outside; a second bank and ditch for a hillfort-size village
    const banks = pop > 260 ? 2 : 1;
    for (let k = 0; k < banks; k++) {
      const off = k * 14 + 3.5;
      const ring = k === 0 ? outline : ellipse(c, R * Math.sqrt(aspect) + off, R / Math.sqrt(aspect) + off, ang, 96, wob);
      const ringB = k === 0 ? ellipse(c, R * Math.sqrt(aspect) + 3.5, R / Math.sqrt(aspect) + 3.5, ang, 96, wob) : ring;
      const gaps = gateLinks.map((g) => ({ p: nearestOn(ringB, g.gate), width: v.pathW + 3 }));
      for (const pl of openRing(ringB, gaps)) out.lines.push({ kind: 'rampart', path: pl, width: 6 });
      const ditch = ellipse(c, R * Math.sqrt(aspect) + off + 6.5, R / Math.sqrt(aspect) + off + 6.5, ang, 96, wob);
      for (const pl of openRing(ditch, gateLinks.map((g) => ({ p: nearestOn(ditch, g.gate), width: v.pathW + 3 })))) out.lines.push({ kind: 'ditch', path: pl, width: 3.5 });
      const outerFace = ellipse(c, R * Math.sqrt(aspect) + off + 3, R / Math.sqrt(aspect) + off + 3, ang, 96, wob);
      out.lines.push(...hachures(outerFace, 2.4, 2.2, -1, (p) => gateLinks.some((g) => dist(g.gate, p) < v.pathW + 5 + off)));
      if (k === banks - 1) out.outline.push(ellipse(c, R * Math.sqrt(aspect) + off + 9, R / Math.sqrt(aspect) + off + 9, ang, 96, wob));
    }
    out.sites.push({ id: 'ringfort', kind: pop > 260 ? 'hillfort' : 'ringfort', role: 'power', lot: outline, anchor: c });
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
  if (v.id === 'celtic') {
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
