import type { World, TerrainLayer, CavernLayer, Vec2, Polygon, Polyline, PolyH, UrbanLayer } from '../types';
import { Rng } from '../core/rng';
import { Noise2D } from '../core/noise';
import { distanceField, forCellsNearPolyline } from '../core/field';
import { nearestOn } from '../core/pline';
import { ribbon, disk } from '../geo/offset';
import { rasterizePolys } from '../geo/raster';
import { renderView } from '../settlements/merge';
import { GridIndex } from '../geo/spatial';
import { bboxOf, pointInRing } from '../geo/poly';
import { intersectionS, tryDifference, mpArea, type MultiPoly } from '../geo/bool';
import { vectorize } from '../landuse/rural';

const CACHE = new WeakMap<World, unknown[]>();
const same = (a: unknown[], b: unknown[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** Display-only geometry. Generation and all existing roads, rivers and settlements remain normal Underdark. */
export function refreshCavernMask(world: World): void {
  if (world.options.biome !== 'underdark-caverns') return;
  const t = world.terrain;
  const signature: unknown[] = [world.seed, world.mapSize, t.height, t.water, t.rivers, t.lakes, t.coastline, t.islands,
    world.urban, world.roads, world.roads?.length, world.bridges, world.bridges?.length, world.landuse,
    ...(world.settlements ?? []).flatMap((s) => [s, s.urban, s.center, s.extent]),
    ...Object.entries(world.megaDetail ?? {}).sort(([a], [b]) => Number(a) - Number(b)).flat()];
  const old = CACHE.get(world);
  if (old && same(old, signature)) return;
  const started = performance.now();
  const caverns = generateCavernMask(world);
  world.terrain = { ...t, caverns };
  CACHE.set(world, signature);
  world.stats['ms.caverns'] = Math.round(performance.now() - started);
}

/** Normal occupied geometry is the skeleton. Noise changes only its surrounding cave envelope. */
export function generateCavernMask(world: World): CavernLayer {
  const { w, h, cell } = world.terrain.height;
  const support = new Uint8Array(w * h), towns = new Uint8Array(w * h);
  const protectedPieces: MultiPoly = [];
  const skeleton: Polyline[] = [];
  const root = new Rng('burgmap:' + world.seed).fork('cavern-mask');
  const noise = new Noise2D(root.fork('wall-noise'));
  const polygon = (ph: PolyH, room = false) => {
    if (ph.outer.length < 3) return;
    protectedPieces.push(ph);
    const rings = [ph.outer, ...ph.holes];
    rasterizePolys(rings, w, h, cell, support);
    if (room) rasterizePolys(rings, w, h, cell, towns);
    // Protect sub-cell roofs/segments and the entire polygon boundary before smoothing.
    for (const ring of rings) forCellsNearPolyline([...ring, ring[0]], w, h, cell, 2 * cell, (i) => {
      support[i] = 1; if (room) towns[i] = 1;
    });
  };
  const poly = (p: Polygon, room = false) => polygon({ outer: p, holes: [] }, room);
  const path = (points: Polyline, width: number | number[], room = false) => {
    if (points.length < 2) return;
    poly(ribbon(points, width), room);
  };
  const urban = (u: UrbanLayer) => {
    for (const ph of u.footprintH) polygon(ph, true);
    if (!u.footprintH.length) for (const p of u.footprint) poly(p, true);
    for (const ph of [...u.masses, ...u.backLand, ...(u.ruralReserve ?? []), ...(u.water ?? []), ...(u.moats ?? [])]) polygon(ph, true);
    for (const b of u.buildings) poly(b.poly, true);
    for (const p of u.parcels) poly(p.poly, true);
    for (const l of u.landmarks) poly(l.poly, true);
    for (const p of u.squares) poly(p, true);
    for (const s of u.sites ?? []) poly(s.lot, true);
    for (const st of u.streets) path(st.path, st.widths ?? st.width, true);
    for (const line of u.lines ?? []) path(line.closed ? [...line.path, line.path[0]] : line.path, line.width ?? 2, true);
    for (const quay of u.quays ?? []) path(quay, 4, true);
    for (const wall of u.walls ?? []) {
      path(wall.closed ? [...wall.path, wall.path[0]] : wall.path, wall.thickness, true);
      const radius = Math.max(12, wall.thickness * 3);
      for (let i = 0; i < wall.towers.length; i++) poly(disk(wall.towers[i], radius * (wall.towerScale?.[i] ?? 1)), true);
      for (const p of [...wall.gates, ...(wall.gateTowers ?? [])]) poly(disk(p, radius * 1.5), true);
    }
    for (const tree of u.trees ?? []) poly(disk(tree, 10), true);
    if (u.macro) for (const q of u.macro.quarters) poly(q.pts, true);
  };
  const visible = renderView(world).urban;
  if (visible) urban(visible);
  if (world.urban?.macro) for (const q of world.urban.macro.quarters) poly(q.pts, true);
  for (const s of world.settlements ?? []) {
    if (s.main) continue;
    if (s.urban?.macro) for (const q of s.urban.macro.quarters) poly(q.pts, true);
    if (!s.urban && s.extent.length >= 3) poly(s.extent, true);
  }
  for (const road of world.roads ?? []) { path(road.path, road.width); skeleton.push(road.path); }
  for (const bridge of world.bridges ?? []) path([bridge.a, bridge.b], bridge.width + 4);
  for (const river of world.terrain.rivers) { path(river.path, river.width.map((v) => Math.max(2, v))); skeleton.push(river.path); }
  for (const lake of world.terrain.lakes) poly(lake);
  for (const coast of world.terrain.coastline) polygon({ outer: coast, holes: (world.terrain.islands ?? []).filter((p) => p.length >= 3 && pointInRing(coast, p[0])) });
  for (const f of world.landuse?.farmsteads ?? []) {
    if (f.lot) poly(f.lot, true);
    poly(f.yard, true);
    for (const building of f.buildings) poly(building, true);
    path(f.drive, 5);
    for (const plot of f.plots ?? []) poly(plot.poly, true);
    for (const wall of f.walls ?? []) path(wall, 3, true);
    for (const tree of f.trees ?? []) poly(disk(tree, 10), true);
  }
  for (const area of world.landuse?.areas ?? []) if (area.cultivation === 'fungal' || area.kind === 'garden' || area.kind === 'field' || area.kind === 'orchard') polygon({ outer: area.poly, holes: area.holes ?? [] }, true);

  // A placed village has a small footprint-driven room. Add a visual passage only when no normal route reaches it.
  for (const s of world.settlements ?? []) {
    if (s.main) continue;
    let target: Vec2 | undefined, best = Infinity;
    for (const pl of skeleton) {
      const near = nearestOn(pl, s.center);
      if (near.d < best) { best = near.d; target = near.pt; }
    }
    if (!target && world.site) { target = world.site.center; best = Math.hypot(target.x - s.center.x, target.y - s.center.y); }
    if (!target || best < 1) continue;
    const rng = root.fork('passage:' + s.key), count = Math.min(36, Math.max(4, Math.ceil(best / Math.max(70, cell * 3))));
    const dx = target.x - s.center.x, dy = target.y - s.center.y, length = Math.hypot(dx, dy);
    const bend = Math.min(length * 0.1, Math.max(25, cell * 3)), phase = rng.range(0, 6.283);
    const passage: Polyline = Array.from({ length: count + 1 }, (_, i) => {
      const t = i / count, offset = Math.sin(t * Math.PI) * (0.55 * Math.sin(t * 9 + phase) + 0.45 * Math.sin(t * 4)) * bend;
      return { x: s.center.x + dx * t - dy / length * offset, y: s.center.y + dy * t + dx / length * offset };
    });
    path(passage, Math.max(12, cell)); skeleton.push(passage);
  }
  if (!protectedPieces.length) {
    // Environment-only maps without water still show a natural branching cave, not a seven-room template.
    const size = world.mapSize, r = root.fork('empty-environment');
    const main = Array.from({ length: 10 }, (_, i) => ({ x: size * (0.08 + i * 0.09), y: size * (0.5 + r.range(-0.2, 0.2)) }));
    path(main, Math.max(18, cell * 2));
    for (const i of [2, 5, 7]) path([main[i], { x: main[i].x + size * r.range(-0.08, 0.08), y: size * r.range(0.15, 0.85) }], Math.max(14, cell));
  }
  const carry = Float32Array.from(support, (_, i) => towns[i] ? 38 : 18);
  const field = distanceField(support, w, h, cell, carry);
  const envelope = new Float32Array(w * h);
  const lowScale = Math.max(90, cell * 12), fineScale = Math.max(18, cell * 3);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    const wx = (x + 0.5) * cell, wy = (y + 0.5) * cell;
    const low = noise.warped(wx / lowScale, wy / lowScale, 0.85, 3);
    const fine = noise.fbm(wx / fineScale, wy / fineScale, 3);
    const margin = Math.max(2 * cell, (field.val?.[i] ?? 18) + 2 * cell + 18 * low + 9 * fine);
    if (support[i] || field.dist[i] <= margin) envelope[i] = 1;
  }
  const rough = vectorize(envelope, w, h, cell, 1, { x0: 0, y0: 0, x1: w - 1, y1: h - 1 });
  const size = world.mapSize;
  const square = [{ x: 0, y: 0 }, { x: size, y: 0 }, { x: size, y: size }, { x: 0, y: size }];
  // Protection is applied after contour smoothing: rock may never erase a roof, full street or river ribbon.
  // Skip operands only when their ENTIRE box is provably within a single rough-floor component:
  // its centre is inside and no outer/hole boundary segment box intersects it. This preserves concave holes.
  const boundary = new GridIndex<ReturnType<typeof bboxOf>>(Math.max(30, cell * 4));
  for (const ph of rough) for (const ring of [ph.outer, ...ph.holes]) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    boundary.insertSeg(a, b, { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) });
  }
  const mandatory = protectedPieces.filter((ph) => {
    const b = bboxOf(ph.outer), centre = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
    if (!rough.some((r) => pointInRing(r.outer, centre) && !r.holes.some((hole) => pointInRing(hole, centre)))) return true;
    let contact = false;
    boundary.forEachIn(b.x0, b.y0, b.x1, b.y1, (edge) => {
      if (edge.x0 <= b.x1 + 1e-6 && edge.x1 >= b.x0 - 1e-6 && edge.y0 <= b.y1 + 1e-6 && edge.y1 >= b.y0 - 1e-6) contact = true;
    });
    return contact;
  });
  const rock = tryDifference(square, [...rough, ...mandatory]);
  const solid = rock.failed ? [] : rock.pieces;
  const inverse = tryDifference(square, solid);
  const floor = inverse.failed ? [{ outer: square, holes: [] }] : inverse.pieces;
  const mask = rasterizePolys(floor.flatMap((p) => [p.outer, ...p.holes]), w, h, cell);
  const clearance = distanceField(Uint8Array.from(mask, (v) => v ? 0 : 1), w, h, cell).dist;
  return { floor, solid: inverse.failed ? [] : solid, mask, clearance, chambers: [] };
}

/** Exact checks are diagnostic tests of the display mask; they do not constrain or modify normal generation. */
export function cavernContains(terrain: TerrainLayer, poly: Polygon): boolean {
  if (!terrain.caverns) return true;
  const out = tryDifference(poly, terrain.caverns.floor);
  return !out.failed && mpArea(out.pieces) <= 0.001;
}
export function cavernPathContains(terrain: TerrainLayer, points: Polyline, width: number): boolean {
  if (!terrain.caverns) return true;
  const size = terrain.height.w * terrain.height.cell;
  const visible = intersectionS(ribbon(points, width), [{ x: 0, y: 0 }, { x: size, y: 0 }, { x: size, y: size }, { x: 0, y: size }]);
  const out = tryDifference(visible, terrain.caverns.floor);
  return !out.failed && mpArea(out.pieces) <= 0.001;
}
