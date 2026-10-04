/** Conservative, shared permission for natural cover inside genuinely unoccupied residential plots. */
import type { World, UrbanLayer, PolyH, Polygon, Vec2 } from '../types';
import { bbox, polygonContains } from '../core/geom';
import { forCellsNearPolyline } from '../core/field';
import { rasterizePolys } from '../geo/raster';

const CELL = 8;
const MAX_CELLS = 1_000_000;
const HOUSE_CLEARANCE = 3;
const EDGE_CLEARANCE = Math.SQRT2 * CELL / 2 + 0.01;

export function naturalGroundEligible(u: UrbanLayer): boolean {
  return !u.renderHints?.openGround && !u.renderHints?.stilts && !u.phases.some((p) => p.walled)
    && !u.walls?.some((w) => !w.role || w.role === 'town' || w.role === 'outer')
    && !u.lines?.some((l) => l.closed && ['hedge', 'palisade', 'turf-wall', 'kraal-fence', 'albarrada'].includes(l.kind));
}

interface Grid { x: number; y: number; w: number; h: number; cells: Uint8Array }
const local = (g: Grid, poly: Polygon): Polygon => poly.map((p) => ({ x: p.x - g.x, y: p.y - g.y }));

/** Centres plus the entire boundary's half-cell diagonal protect every intersecting cell, including thin shapes. */
function markPolygon(g: Grid, poly: Polygon, value: 0 | 1, boundary = false, holes: Polygon[] = []): void {
  if (poly.length < 3) return;
  if ([poly, ...holes].some((r) => r.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))) throw new Error('Invalid ground polygon');
  const points = local(g, poly);
  if (value === 1) rasterizePolys([points], g.w, g.h, CELL, g.cells);
  else {
    // Limit temporary rasterisation to this polygon's local box, rather than allocate a grid per house.
    const b = bbox(points), x0 = Math.max(0, Math.floor(b.minX / CELL)), y0 = Math.max(0, Math.floor(b.minY / CELL));
    const x1 = Math.min(g.w, Math.ceil(b.maxX / CELL)), y1 = Math.min(g.h, Math.ceil(b.maxY / CELL));
    const w = x1 - x0, h = y1 - y0;
    if (w > 0 && h > 0) {
      const rings = [points, ...holes.map((hole) => local(g, hole))].map((r) => r.map((p) => ({ x: p.x - x0 * CELL, y: p.y - y0 * CELL })));
      const mask = rasterizePolys(rings, w, h, CELL);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) g.cells[(y + y0) * g.w + x + x0] = 0;
    }
  }
  if (boundary) for (const ring of [points, ...holes.map((hole) => local(g, hole))]) {
    if (ring.length) forCellsNearPolyline([...ring, ring[0]], g.w, g.h, CELL, EDGE_CLEARANCE,
      (idx) => { g.cells[idx] = 0; });
  }
}

function clearBox(g: Grid, poly: Polygon, margin: number): void {
  if (!poly.length) return;
  if (poly.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error('Invalid building');
  const b = bbox(poly);
  const x0 = Math.max(0, Math.floor((b.minX - margin - g.x) / CELL));
  const x1 = Math.min(g.w - 1, Math.floor((b.maxX + margin - g.x) / CELL));
  const y0 = Math.max(0, Math.floor((b.minY - margin - g.y) / CELL));
  const y1 = Math.min(g.h - 1, Math.floor((b.maxY + margin - g.y) / CELL));
  if (x1 < x0 || y1 < y0) return;
  for (let y = y0; y <= y1; y++) g.cells.fill(0, y * g.w + x0, y * g.w + x1 + 1);
}

function clearWay(g: Grid, path: Vec2[], width: number): void {
  if (path.length < 2) return;
  if (!Number.isFinite(width) || path.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error('Invalid ground way');
  forCellsNearPolyline(local(g, path), g.w, g.h, CELL,
    Math.max(0, width / 2) + 2 + EDGE_CLEARANCE, (idx) => { g.cells[idx] = 0; });
}

/** Rural vectorisation cannot represent isolated yard-sized patches: neither renderer may expose those cells. */
function pruneSmallComponents(g: Grid, minArea: number): void {
  const seen = new Uint8Array(g.cells.length);
  const minCells = Math.ceil(minArea / (CELL * CELL));
  for (let seed = 0; seed < g.cells.length; seed++) {
    if (!g.cells[seed] || seen[seed]) continue;
    const component = [seed]; seen[seed] = 1;
    for (let cursor = 0; cursor < component.length; cursor++) {
      const i = component[cursor], x = i % g.w;
      for (const j of [x > 0 ? i - 1 : -1, x + 1 < g.w ? i + 1 : -1, i - g.w, i + g.w]) {
        if (j < 0 || j >= g.cells.length || !g.cells[j] || seen[j]) continue;
        seen[j] = 1; component.push(j);
      }
    }
    if (component.length < minCells) for (const i of component) g.cells[i] = 0;
  }
}

/** Merge matching horizontal runs vertically. Rectangles are disjoint, so a single clip path needs no booleans. */
function rectangles(g: Grid): PolyH[] {
  type Run = { x0: number; x1: number; y0: number; y1: number };
  const finished: Run[] = [];
  let active = new Map<string, Run>();
  for (let y = 0; y < g.h; y++) {
    const next = new Map<string, Run>();
    for (let x = 0; x < g.w;) {
      if (!g.cells[y * g.w + x]) { x++; continue; }
      const x0 = x;
      while (x < g.w && g.cells[y * g.w + x]) x++;
      const key = `${x0}:${x}`, old = active.get(key);
      const run = old ?? { x0, x1: x, y0: y, y1: y + 1 };
      run.y1 = y + 1;
      next.set(key, run); active.delete(key);
    }
    for (const run of active.values()) finished.push(run);
    active = next;
  }
  for (const run of active.values()) finished.push(run);
  return finished.map((r) => ({ outer: [
    { x: g.x + r.x0 * CELL, y: g.y + r.y0 * CELL }, { x: g.x + r.x1 * CELL, y: g.y + r.y0 * CELL },
    { x: g.x + r.x1 * CELL, y: g.y + r.y1 * CELL }, { x: g.x + r.x0 * CELL, y: g.y + r.y1 * CELL },
  ], holes: [] }));
}

function buildLayer(u: UrbanLayer, others: UrbanLayer[], world: World): PolyH[] {
  if (!naturalGroundEligible(u)) return [];
  const plots = u.parcels.filter((p) => p.use === 'plot').map((p) => p.poly);
  if (!plots.length) return [];
  const b = bbox(plots.flat());
  const x = Math.floor(b.minX / CELL) * CELL, y = Math.floor(b.minY / CELL) * CELL;
  const w = Math.ceil((b.maxX - x) / CELL), h = Math.ceil((b.maxY - y) / CELL);
  // Undetailed macro plans and corrupt/excessive bounds remain fully protected.
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0 || w * h > MAX_CELLS) return [];
  const g: Grid = { x, y, w, h, cells: new Uint8Array(w * h) };
  for (const plot of plots) markPolygon(g, plot, 1);
  for (const plot of plots) {
    const points = local(g, plot);
    forCellsNearPolyline([...points, points[0]], w, h, CELL, EDGE_CLEARANCE, (idx) => { g.cells[idx] = 0; });
  }
  for (const house of u.buildings) clearBox(g, house.poly, HOUSE_CLEARANCE);
  for (const mass of u.masses) markPolygon(g, mass.outer, 0, true);
  const protectedPolys = [
    ...u.parcels.filter((p) => p.use !== 'plot').map((p) => p.poly), ...u.backLand.map((p) => p.outer),
    ...u.landmarks.map((l) => l.poly), ...u.squares, ...(u.water ?? []).map((p) => p.outer),
    ...(u.ruralReserve ?? []).map((p) => p.outer), ...others.flatMap((layer) => layer.footprintH.map((p) => p.outer)),
  ];
  for (const poly of protectedPolys) markPolygon(g, poly, 0, true);
  for (const street of u.streets) clearWay(g, street.path, street.width);
  for (const road of world.roads ?? []) clearWay(g, road.path, road.width);
  // Protect vector water even if a malformed/custom plot crosses it. Sea holes retain actual dry islands.
  if (world.terrain) {
    const terrain = world.terrain;
    for (const sea of terrain.coastline) markPolygon(g, sea, 0, true,
      (terrain.islands ?? []).filter((island) => island.length >= 3 && polygonContains(sea, island[0])));
    for (const lake of terrain.lakes) markPolygon(g, lake, 0, true);
    for (const river of terrain.rivers) for (let i = 1; i < river.path.length; i++) {
      const width = Math.max(river.width[i - 1], river.width[i], 2.5);
      // A river ribbon's capped miter can reach 1.25 full widths; this covers the join and visual casing.
      clearWay(g, [river.path[i - 1], river.path[i]], 3 * width + 7 * (world.mapSize ?? 1600) / 1600);
    }
  }
  for (const wall of u.walls ?? []) clearWay(g, wall.closed ? [...wall.path, wall.path[0]] : wall.path, wall.thickness + 4);
  const terrainCell = world.terrain?.height?.cell ?? CELL;
  if (!Number.isFinite(terrainCell) || terrainCell <= 0) return [];
  pruneSmallComponents(g, Math.max(1200, 2.2 * terrainCell * terrainCell));
  return rectangles(g);
}

interface Cached { signature: string; ground: PolyH[] }
const CACHE = new WeakMap<UrbanLayer, Cached>();
interface Revision { signature: string; id: number }
const CONTEXT_CACHE = new WeakMap<object, Revision>();
const FOOT_CACHE = new WeakMap<UrbanLayer, Revision>();
let revision = 0;
function coordinateRevision<K extends object>(cache: WeakMap<K, Revision>, key: K, signature: string): number {
  let cached = cache.get(key);
  if (cached?.signature !== signature) { cached = { signature, id: ++revision }; cache.set(key, cached); }
  return cached.id;
}

/** No DOM, random draws or geometry mutation; generation and both renderers consume the identical permission. */
export function urbanNaturalGround(world: World): PolyH[] {
  const layers = [world.urban, ...(world.settlements ?? []).filter((s) => !s.main).map((s) => s.urban),
    ...Object.values(world.megaDetail ?? {})].filter((u): u is UrbanLayer => !!u);
  if (!layers.some((u) => naturalGroundEligible(u) && u.parcels.some((p) => p.use === 'plot'))) return [];
  // Shared shoreline/road coordinates are inspected once, not re-serialised for each settlement.
  const contextRevision = coordinateRevision(CONTEXT_CACHE, world.terrain ?? world, JSON.stringify([
    world.mapSize, world.roads, world.terrain && [world.terrain.coastline, world.terrain.islands, world.terrain.lakes, world.terrain.rivers, world.terrain.height?.cell],
  ]));
  const footprintRevisions = new Map<UrbanLayer, number>();
  for (const u of layers) footprintRevisions.set(u, coordinateRevision(FOOT_CACHE, u, JSON.stringify(u.footprintH)));
  const ground: PolyH[] = [];
  for (const u of layers) {
    if (!naturalGroundEligible(u)) continue;
    const others = layers.filter((layer) => layer !== u);
    const signature = JSON.stringify([u.parcels, u.buildings, u.masses, u.backLand, u.landmarks, u.squares,
      u.water, u.ruralReserve, u.streets, u.walls, others.map((layer) => footprintRevisions.get(layer)), contextRevision]);
    let cached = CACHE.get(u);
    if (cached?.signature !== signature) {
      let result: PolyH[] = [];
      try { result = buildLayer(u, others, world); } catch { /* Decorative permission fails closed. */ }
      cached = { signature, ground: result }; CACHE.set(u, cached);
    }
    for (const piece of cached.ground) ground.push(piece);
  }
  return ground;
}
