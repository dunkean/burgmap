/**
 * Road network of the settlement system (M3c): a pruned Delaunay graph over all settlements (minimum spanning tree
 * plus the Delaunay edges that save a long detour between villages and towns), plus map exits for secondary towns.
 * Edges are routed by decreasing importance with the regional A* (same cost grid, bridges, fords), each new road
 * running from the smaller settlement until it meets the network of the other end, so later roads merge into shared
 * trunks. The main town's roads are hosts too, but junctions stay outside its footprint (its plan is not touched).
 */
import { Delaunay } from 'd3-delaunay';
import type { Rng } from '../core/rng';
import { Vec2, Polyline, dist, polylineLength } from '../core/geom';
import { forCellsNearPolyline } from '../core/field';
import { nearestOn } from '../core/pline';
import { rasterizePolys } from '../geo/raster';
import { distanceField } from '../core/field';
import { roadContext, astarFewCrossings, ROAD_WIDTH } from '../roads/regional';
import { bridgeRoad, attachEnd, clearRibbons, BridgeSeg } from '../roads/junctions';
import { passability } from '../site/site';
import type { World, Settlement } from '../types';

type Road = NonNullable<World['roads']>[number];

export interface NetworkResult {
  roads: Road[]; bridges: BridgeSeg[];
  /** Settlement index → indices (into the final world.roads) of the roads that end at it. */
  warnings: string[];
  stats: Record<string, number>;
  /** Settlements not connected to the main settlement (should be empty). */
  unreachable: number[];
}

class UF {
  p: number[];
  constructor(n: number) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(a: number): number { while (this.p[a] !== a) { this.p[a] = this.p[this.p[a]]; a = this.p[a]; } return a; }
  union(a: number, b: number): void { const x = this.find(a), y = this.find(b); if (x !== y) this.p[Math.max(x, y)] = Math.min(x, y); }
}

const kindFor = (pop: number): Road['kind'] => (pop >= 1000 ? 'major' : pop >= 150 ? 'minor' : 'track');

export function routeNetwork(world: World, settlements: Settlement[], root: Rng): NetworkResult {
  const terrain = world.terrain, site = world.site!;
  const S = world.mapSize;
  const r = root.fork('network');
  const { w: n, cell } = terrain.height;
  const N = n * n;
  const warnings: string[] = [];
  const f = site.fields;
  const K = settlements.length;
  const stats: Record<string, number> = {};

  // ---- passability: the main river may also be bridged near the secondary towns and river villages
  const pass = passability(terrain, f);
  const riverMain = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (terrain.water[i] === 3 && f.riverMask[i] === 1 && pass[i] === 0) riverMain[i] = 1;
  for (const s of settlements) {
    if (s.main || s.population < 150) continue;
    const R = 260 + s.radius;
    forCellsNearPolyline([s.center, s.center], n, n, cell, R, (idx) => { if (riverMain[idx]) pass[idx] = 3; });
  }
  const rc = roadContext(terrain, f, r, S, pass);
  const cm = Float32Array.from(rc.cm);

  // ---- the main town: junctions outside its footprint, no new road through it except along its own roads
  const mainFoot = new Uint8Array(N);
  if (world.urban?.footprintH.length) rasterizePolys(world.urban.footprintH.map((ph) => ph.outer), n, n, cell, mainFoot);
  else forCellsNearPolyline([site.center, site.center], n, n, cell, settlements[0].radius, (i) => { mainFoot[i] = 1; });
  const dMain = distanceField(mainFoot, n, n, cell).dist;
  const noJunction = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (dMain[i] < 45) { noJunction[i] = 1; cm[i] *= 25; }

  // ---- network state: cells near roads (owner road), road -> component (settlement union-find)
  const roads: { path: Polyline; kind: Road['kind']; width: number; comp: number; hostA: number; hostB: number; main: boolean }[] = [];
  const owner = new Int32Array(N).fill(-1);
  const used = new Uint8Array(N);
  const uf = new UF(K);
  const unpen = new Uint8Array(N);
  const mark = (pl: Polyline, ri: number): void => {
    forCellsNearPolyline(pl, n, n, cell, 2 * cell, (idx) => { if (owner[idx] < 0) owner[idx] = ri; });
    forCellsNearPolyline(pl, n, n, cell, 0.75 * cell, (idx) => { used[idx] = 1; if (noJunction[idx] && !unpen[idx]) { unpen[idx] = 1; cm[idx] /= 25; } });
  };
  for (const rd of world.roads ?? []) {
    roads.push({ path: rd.path, kind: rd.kind, width: rd.width, comp: 0, hostA: -1, hostB: -1, main: true });
    mark(rd.path, roads.length - 1);
  }
  const compOfRoad = (ri: number): number => uf.find(roads[ri].comp);
  const idxOf = (p: Vec2): number => Math.min(n - 1, Math.max(0, Math.floor(p.y / cell))) * n + Math.min(n - 1, Math.max(0, Math.floor(p.x / cell)));

  // ---- graph: Delaunay → MST (+ shortcut edges between villages and towns)
  type Edge = { a: number; b: number; d: number; mst: boolean };
  const edges: Edge[] = [];
  if (K >= 2) {
    const centers = settlements.map((s) => s.center);
    if (K === 2) edges.push({ a: 0, b: 1, d: dist(centers[0], centers[1]), mst: false });
    else {
      const del = Delaunay.from(centers, (p) => p.x, (p) => p.y);
      const seen = new Set<string>();
      const { triangles } = del;
      for (let t = 0; t < triangles.length; t += 3) {
        for (const [u, v] of [[triangles[t], triangles[t + 1]], [triangles[t + 1], triangles[t + 2]], [triangles[t + 2], triangles[t]]]) {
          const a = Math.min(u, v), b = Math.max(u, v), key = a + ',' + b;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({ a, b, d: dist(centers[a], centers[b]), mst: false });
        }
      }
      // collinear points: Delaunay may give no triangles
      if (!edges.length) for (let i = 1; i < K; i++) edges.push({ a: i - 1, b: i, d: dist(centers[i - 1], centers[i]), mst: false });
    }
  }
  const mstUf = new UF(K);
  const byLen = [...edges].sort((x, y) => x.d - y.d || x.a - y.a || x.b - y.b);
  for (const e of byLen) if (mstUf.find(e.a) !== mstUf.find(e.b)) { mstUf.union(e.a, e.b); e.mst = true; }
  // shortcuts: graph distance over the MST > 1.6 x direct, between settlements of village size or more
  const adj: { to: number; d: number }[][] = Array.from({ length: K }, () => []);
  for (const e of edges) if (e.mst) { adj[e.a].push({ to: e.b, d: e.d }); adj[e.b].push({ to: e.a, d: e.d }); }
  const graphDist = (a: number, b: number): number => {
    const d = new Array(K).fill(Infinity);
    d[a] = 0;
    const q = [a];
    // tree: plain DFS gives the unique path length
    while (q.length) { const u = q.pop()!; for (const x of adj[u]) if (d[x.to] === Infinity) { d[x.to] = d[u] + x.d; q.push(x.to); } }
    return d[b];
  };
  const chosen = edges.filter((e) => e.mst);
  for (const e of edges) {
    if (e.mst) continue;
    const pa = settlements[e.a].population, pb = settlements[e.b].population;
    if (Math.min(pa, pb) < 150) continue;
    if (graphDist(e.a, e.b) > 1.6 * e.d) chosen.push(e);
  }
  // most important first (bigger smaller-end), then shorter
  const imp = (e: Edge): number => Math.min(settlements[e.a].population, settlements[e.b].population);
  chosen.sort((x, y) => imp(y) - imp(x) || x.d - y.d || x.a - y.a || x.b - y.b);
  stats['edges'] = chosen.length;

  // ---- routing
  const octileTo = (goal: number, k = 0.7) => {
    const gx = goal % n, gy = (goal / n) | 0;
    return (idx: number): number => {
      const dx = Math.abs((idx % n) - gx), dy = Math.abs(((idx / n) | 0) - gy);
      return k * cell * (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy));
    };
  };
  let emergency: Uint8Array | null = null;
  const route = (from: Vec2, fromNode: number, toNode: number, kind: Road['kind'], exitAt?: Vec2): boolean => {
    const t = settlements[toNode];
    const start = idxOf(from), goalC = idxOf(t.center);
    const tComp = (): number => uf.find(toNode);
    // same component already (a shortcut): only roads near the target count
    const same = fromNode >= 0 && uf.find(fromNode) === tComp();
    const nearT = (c: number): boolean => Math.hypot(((c % n) + 0.5) * cell - t.center.x, (((c / n) | 0) + 0.5) * cell - t.center.y) < t.radius + 200;
    let allowCenter = !t.main;
    const isGoal = (c: number): boolean => {
      if (c === goalC && allowCenter) return true;
      if (!used[c] || owner[c] < 0 || noJunction[c]) return false;
      if (compOfRoad(owner[c]) !== tComp()) return false;
      return !same || nearT(c);
    };
    if (isGoal(start)) { if (fromNode >= 0) uf.union(fromNode, toNode); return true; }
    const cfg = { w: n, h: n, cell, H: rc.H, pass: rc.pass, cm, used, discount: 0.45, hf: octileTo(goalC), allowBridge: true };
    let path = astarFewCrossings(cfg, start, isGoal, rc.sIds, rc.mainIds);
    if (!path && !allowCenter) { allowCenter = true; path = astarFewCrossings(cfg, start, isGoal, rc.sIds, rc.mainIds); }
    if (!path) {
      // last resort: the main river may be bridged anywhere (at a high price)
      if (!emergency) { emergency = Uint8Array.from(rc.pass); for (let i = 0; i < N; i++) if (riverMain[i]) emergency[i] = 3; }
      const cm2 = cm;
      path = astarFewCrossings({ ...cfg, pass: emergency, cm: cm2 }, start, isGoal, rc.sIds, rc.mainIds);
      if (path) stats['emergencyBridges'] = (stats['emergencyBridges'] ?? 0) + 1;
    }
    if (!path || path.length < 2) return false;
    // skip the initial run along the start settlement's own network (it already has a road there)
    const fromComp = fromNode >= 0 ? uf.find(fromNode) : -1;
    let a = 0;
    if (fromNode >= 0) {
      while (a + 1 < path.length && used[path[a + 1]] && owner[path[a + 1]] >= 0 && compOfRoad(owner[path[a + 1]]) === fromComp && !noJunction[path[a + 1]]) a++;
    }
    let b = path.length - 1;
    for (let i = a + 1; i < path.length; i++) if (isGoal(path[i])) { b = i; break; }
    let cells = path.slice(a, b + 1);
    if (cells.length < 2) {
      if (b === a && fromNode >= 0) { uf.union(fromNode, toNode); return true; }
      return false;
    }
    const hostA = a > 0 ? owner[path[a]] : -1;
    const endC = path[b];
    const hostB = endC === goalC && dist(t.center, from) > 0 ? -1 : owner[endC];
    let startPt: Vec2 = exitAt ?? from, endPt: Vec2 = t.center;
    if (hostA >= 0) startPt = nearestOn(roads[hostA].path, { x: ((path[a] % n) + 0.5) * cell, y: (((path[a] / n) | 0) + 0.5) * cell }).pt;
    if (hostB >= 0) {
      endPt = nearestOn(roads[hostB].path, { x: ((endC % n) + 0.5) * cell, y: (((endC / n) | 0) + 0.5) * cell }).pt;
      if (cells.length > 6) cells = cells.slice(0, cells.length - 2);
    }
    if (cells.length < 2) return false;
    const pl = rc.smoothPath(cells, startPt, endPt);
    if (pl.length < 2 || polylineLength(pl) < 8) { if (fromNode >= 0) uf.union(fromNode, toNode); return true; }
    const ri = roads.length;
    const comp = fromNode >= 0 ? fromNode : toNode;
    roads.push({ path: pl, kind, width: ROAD_WIDTH[kind], comp, hostA, hostB, main: false });
    if (fromNode >= 0) uf.union(fromNode, toNode);
    if (hostA >= 0) uf.union(roads[hostA].comp, toNode);
    mark(pl, ri);
    return true;
  };

  let failed = 0;
  for (const e of chosen) {
    // a tree edge between settlements a shortcut already joined is redundant
    if (e.mst && uf.find(e.a) === uf.find(e.b)) continue;
    const [s, t] = settlements[e.a].population <= settlements[e.b].population ? [e.a, e.b] : [e.b, e.a];
    // the main town is always the target (its plan stays as generated)
    const [from, to] = settlements[s].main ? [t, s] : [s, t];
    const kind = kindFor(Math.min(settlements[from].population, settlements[to].population));
    if (!route(settlements[from].center, from, to, kind)) failed++;
  }
  // ---- exits: secondary towns near a map edge get their own road out of the map
  for (let k = 1; k < K; k++) {
    const s = settlements[k];
    if (s.population < 1000) continue;
    const c = s.center;
    const cands: Vec2[] = [{ x: 0, y: c.y }, { x: S, y: c.y }, { x: c.x, y: 0 }, { x: c.x, y: S }];
    cands.sort((p, q) => dist(p, c) - dist(q, c));
    const ex = cands[0];
    if (dist(ex, c) > 0.3 * S) continue;
    const near = roads.some((rd) => [rd.path[0], rd.path[rd.path.length - 1]].some((q) => dist(q, ex) < Math.max(1500, 0.12 * S) && (q.x < 1 || q.y < 1 || q.x > S - 1 || q.y > S - 1)));
    if (near) continue;
    // start on dry land just inside the edge
    let st = -1;
    for (let o = 0; o < 40 && st < 0; o++) for (const sg of [1, -1]) {
      const along = ex.x === 0 || ex.x === S ? { x: ex.x === 0 ? 0.5 * cell : S - 0.5 * cell, y: ex.y + sg * o * cell * 2 } : { x: ex.x + sg * o * cell * 2, y: ex.y === 0 ? 0.5 * cell : S - 0.5 * cell };
      const i = idxOf(along);
      if (rc.pass[i] === 1) { st = i; break; }
    }
    if (st < 0) continue;
    const sp = { x: ((st % n) + 0.5) * cell, y: (((st / n) | 0) + 0.5) * cell };
    if (sp.x < cell) sp.x = 0; else if (sp.x > S - cell) sp.x = S;
    if (sp.y < cell) sp.y = 0; else if (sp.y > S - cell) sp.y = S;
    if (route(sp, -1, k, 'major', sp)) stats['exits'] = (stats['exits'] ?? 0) + 1;
  }

  // ---- reachability (union-find over the settlements that the routed roads joined)
  const unreachable: number[] = [];
  for (let k = 1; k < K; k++) if (uf.find(k) !== uf.find(0)) unreachable.push(k);
  if (unreachable.length) warnings.push(`${unreachable.length} settlement(s) could not be reached by road`);
  if (failed) stats['failedEdges'] = failed;

  // ---- bridges, junctions, ribbons (new roads only; hosts may be any road)
  const isWaterPt = rc.isWaterPt;
  const fresh = roads.map((rd, i) => ({ rd, i })).filter((x) => !x.rd.main);
  const own: BridgeSeg[][] = roads.map(() => []);
  for (const { rd, i } of fresh) {
    const res = bridgeRoad(rd.path, { rivers: terrain.rivers, wet: isWaterPt, roadWidth: rd.width }, 3.0);
    rd.path = res.path;
    own[i] = res.bridges;
  }
  const mainBridges = world.bridges ?? [];
  const hostBridges = (hi: number): BridgeSeg[] => (roads[hi].main ? mainBridges.filter((b) => nearestOn(roads[hi].path, b.a).d < 6) : own[hi]);
  const jrng = r.fork('junctions');
  for (const { rd, i } of fresh) {
    const mk = (hi: number) => ({ wet: isWaterPt, hostBridges: hostBridges(hi), ownBridges: own[i], rng: jrng });
    if (rd.hostB >= 0 && rd.hostB !== i) { const p = attachEnd(rd.path, false, roads[rd.hostB].path, mk(rd.hostB)); if (p) rd.path = p; }
    if (rd.hostA >= 0 && rd.hostA !== i) { const p = attachEnd(rd.path, true, roads[rd.hostA].path, mk(rd.hostA)); if (p) rd.path = p; }
  }
  for (const { rd, i } of fresh) rd.path = clearRibbons(rd.path, terrain.rivers, own[i]);
  const out: Road[] = fresh.map(({ rd }) => ({ path: rd.path, kind: rd.kind, width: rd.width }));
  stats['roads'] = out.length;
  return { roads: out, bridges: fresh.flatMap(({ i }) => own[i]), warnings, stats, unreachable };
}
