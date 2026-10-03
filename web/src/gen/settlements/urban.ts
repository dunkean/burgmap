/**
 * Urban generation of one secondary settlement (M3c): the existing urban engine runs on a view of the World centred
 * on the settlement (its own site layer with a bounded travel-cost field, the roads that reach it, its culture and
 * population), with its own rng stream `fork('settlement:' + key)`, then the result is clipped to the settlement's
 * region (the Voronoi cell of its site). Pure and deterministic: the same call in a worker (lazy detail) gives the
 * same layer as the eager pipeline.
 */
import { Rng } from '../core/rng';
import { MinHeap } from '../core/pq';
import { createGrid, D8, D8_DIST } from '../core/grid';
import { Vec2, Polygon, Polyline, dist, polygonCentroid } from '../core/geom';
import { nearestOn, insertVertex } from '../core/pline';
import { pointInRing } from '../geo/poly';
import { passability } from '../site/site';
import { generateUrban } from '../urban';
import { sizeForPop } from '../options';
import type { World, Settlement, SiteLayer, UrbanLayer, PolyH } from '../types';

type Road = NonNullable<World['roads']>[number];
type Bridge = NonNullable<World['bridges']>[number];

/** Passability per (terrain, fields): the same for every settlement of a map (read-only here). */
const PASS_CACHE = new WeakMap<object, { water: Uint8Array; pass: Uint8Array }>();

/** Travel cost from `start`, explored only up to `limit` (m-equivalents); Infinity beyond. */
export function boundedCost(world: World, start: Vec2, limit: number): SiteLayer['cost'] {
  const t = world.terrain, f = world.site!.fields;
  const { w: n, cell } = t.height;
  const H = t.height.data;
  let pc = PASS_CACHE.get(f);
  if (!pc || pc.water !== t.water) { pc = { water: t.water, pass: passability(t, f) }; PASS_CACHE.set(f, pc); }
  const pass = pc.pass;
  const d = new Float32Array(n * n).fill(Infinity);
  const s0 = Math.min(n - 1, Math.max(0, Math.floor(start.y / cell))) * n + Math.min(n - 1, Math.max(0, Math.floor(start.x / cell)));
  const heap = new MinHeap<number>();
  d[s0] = 0; heap.push(s0, 0);
  while (heap.size) {
    const key = heap.peekKey();
    const c = heap.pop()!;
    if (key > d[c]) continue;
    if (key > limit) break;
    const cx = c % n, cy = (c / n) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = cx + D8[k][0], ny = cy + D8[k][1];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const m = ny * n + nx;
      const pt = pass[m];
      if (!pt) continue;
      const dd = D8_DIST[k];
      const g = pt >= 2 || pass[c] >= 2 ? 0 : Math.abs(H[m] - H[c]) / (dd * cell);
      const nd = key + dd * cell * (1 + 100 * g * g) * (pt === 1 ? 1 : pt === 2 ? 4 : 3);
      if (nd < d[m]) { d[m] = nd; heap.push(m, nd); }
    }
  }
  for (let i = 0; i < d.length; i++) if (d[i] > limit) d[i] = Infinity;
  const g = createGrid(n, n, cell);
  g.data.set(d);
  return g;
}

/** Window (m) around the settlement in which roads are handed to its plan. */
const windowOf = (s: Settlement): number => 3 * s.radius + 450;

/**
 * Roads of the settlement's plan: every road ending at its center (oriented to end there), roads through the center
 * split there, and the pieces of other roads crossing its window. Copies: the engine may bend them towards gates.
 */
export function roadsFor(world: World, s: Settlement): Road[] {
  const W = windowOf(s);
  const c = s.center;
  const out: Road[] = [];
  const clipEnd = (pl: Polyline): Polyline => {
    // keep the stretch within the window, walking back from the end at the center
    const keep: Polyline = [];
    for (let i = pl.length - 1; i >= 0; i--) {
      keep.push({ x: pl[i].x, y: pl[i].y });
      if (dist(pl[i], c) > W) break;
    }
    return keep.reverse();
  };
  for (const rd of world.roads ?? []) {
    const pl = rd.path;
    if (pl.length < 2) continue;
    const d0 = dist(pl[0], c), d1 = dist(pl[pl.length - 1], c);
    // tracks reaching the settlement are its roads (the engine ignores tracks)
    const asRoad = rd.kind === 'track' ? { ...rd, kind: 'minor' as const } : rd;
    if (d1 < 12) { out.push({ ...asRoad, path: clipEnd(pl) }); continue; }
    if (d0 < 12) { out.push({ ...asRoad, path: clipEnd(pl.slice().reverse()) }); continue; }
    const nn = nearestOn(pl, c);
    if (nn.d < 12) {
      const cp = pl.map((q) => ({ x: q.x, y: q.y }));
      const vi = insertVertex(cp, nn.i, nn.t, 0.5);
      cp[vi] = { x: c.x, y: c.y };
      const a = cp.slice(0, vi + 1), b = cp.slice(vi).reverse();
      if (a.length >= 2) out.push({ ...asRoad, path: clipEnd(a) });
      if (b.length >= 2) out.push({ ...asRoad, path: clipEnd(b) });
      continue;
    }
    if (nn.d > W) continue;
    // a road crossing the window without stopping: its pieces inside the window
    let cur: Polyline = [];
    for (let i = 0; i < pl.length; i++) {
      const inside = dist(pl[i], c) <= W;
      if (inside || (i > 0 && dist(pl[i - 1], c) <= W) || (i + 1 < pl.length && dist(pl[i + 1], c) <= W)) cur.push({ x: pl[i].x, y: pl[i].y });
      else if (cur.length) { if (cur.length >= 2) out.push({ ...rd, path: cur }); cur = []; }
    }
    if (cur.length >= 2) out.push({ ...rd, path: cur });
  }
  return out;
}

/** The settlement's site layer (fields shared with the main site, own cost field). */
export function settlementSite(world: World, s: Settlement): SiteLayer {
  const main = world.site!;
  return {
    center: s.center, crossing: s.crossing, harbor: s.harbor, archetype: s.archetype, feature: s.center, offers: {},
    cost: boundedCost(world, s.center, 2.5 * windowOf(s) + 600), reserveRadius: s.radius, fields: main.fields,
  };
}

/** Elements whose representative point lies in the region are kept; indices are remapped. */
export function clipUrban(u: UrbanLayer, region: Polygon): UrbanLayer {
  const inR = (p: Polygon): boolean => p.length > 0 && pointInRing(region, polygonCentroid(p));
  const inH = (ph: PolyH): boolean => inR(ph.outer);
  const blockKeep = u.blocks.map(inR);
  const bMap: number[] = [];
  let nb = 0;
  blockKeep.forEach((k, i) => { bMap[i] = k ? nb++ : -1; });
  const pKeep = u.parcels.map((p) => inR(p.poly) && (p.block < 0 || blockKeep[p.block] !== false));
  const pMap: number[] = [];
  let np = 0;
  pKeep.forEach((k, i) => { pMap[i] = k ? np++ : -1; });
  return {
    ...u,
    blocks: u.blocks.filter((_, i) => blockKeep[i]),
    blockInfo: u.blockInfo.filter((_, i) => blockKeep[i]),
    parcels: u.parcels.filter((_, i) => pKeep[i]).map((p) => ({ ...p, block: p.block >= 0 ? bMap[p.block] ?? -1 : p.block })),
    buildings: u.buildings.filter((b) => inR(b.poly)).map((b) => (b.parcel !== undefined && b.parcel >= 0 ? { ...b, parcel: pMap[b.parcel] >= 0 ? pMap[b.parcel] : undefined } : b)),
    masses: u.masses.filter(inH),
    backLand: u.backLand.filter(inH),
    streets: u.streets.filter((st) => st.path.length > 0 && pointInRing(region, st.path[Math.floor(st.path.length / 2)])),
    landmarks: u.landmarks.filter((l) => inR(l.poly)),
    squares: u.squares.filter(inR),
    trees: u.trees?.filter((t) => pointInRing(region, t)),
  };
}

export interface SettlementUrban { urban: UrbanLayer; bridges: Bridge[]; stats: Record<string, number | string> }

/**
 * Generate the plan of settlement `s` (not the main one, not a farmstead). Never mutates `world` (roads and bridges
 * are copied); the new town bridges are returned.
 */
export function generateSettlementUrban(world: World, s: Settlement): SettlementUrban | null {
  if (s.main || s.detail === 'farmstead') return null;
  const rng = new Rng('burgmap:' + world.seed).fork('settlement:' + s.key);
  const o = world.options;
  const options = {
    ...o, culture: s.culture, population: s.population, size: sizeForPop(s.population), siteType: 'auto' as const, sitePrefs: undefined,
    walls: 'auto' as const, castle: 'auto' as const, castles: 'auto' as const, cathedral: 'auto' as const, palace: 'auto' as const,
    monasteries: 'auto' as const, port: 'auto' as const, arena: 'auto' as const, activities: 'auto' as const, suburbs: 'auto' as const,
    shantytowns: 'auto' as const, cultureMix: null, plan: null, settlements: 'none' as const,
  };
  const W = windowOf(s);
  const bridges0 = (world.bridges ?? []).filter((b) => dist(b.a, s.center) < W + 200).map((b) => ({ ...b }));
  const sub: World = {
    seed: world.seed, options, mapSize: world.mapSize, terrain: world.terrain, stats: {},
    site: settlementSite(world, s), roads: roadsFor(world, s), bridges: bridges0,
  };
  const n0 = bridges0.length;
  // on coarse terrain grids (big maps) the region of a tiny hamlet can round down to nothing: the plan is then
  // made for a slightly bigger population (same streams, deterministic) and keeps its real population
  let res = generateUrban(sub, rng);
  for (const k of [2, 4]) {
    if (res.layer.buildings.length || s.population * k > 400) break;
    sub.roads = roadsFor(world, s);
    sub.bridges = bridges0.map((b) => ({ ...b }));
    sub.options = { ...options, population: s.population * k };
    res = generateUrban(sub, rng);
  }
  const urban = clipUrban({ ...res.layer, population: s.population }, s.region);
  return { urban, bridges: (sub.bridges ?? []).slice(n0), stats: res.stats };
}
