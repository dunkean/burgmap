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
import { intersectionS, tryIntersection, tryDifference, tryDifferenceS, mpArea, type MultiPoly } from '../geo/bool';
import { vectorize } from '../landuse/rural';

const CACHE = new WeakMap<World, unknown[]>();
/** Agricultural backdrop suppressed in cave mode and replaced with fungal cultivation rooms. */
export const CAVERN_CROP_MARKS: ReadonlySet<string> = new Set(['cornfield', 'garden-bed', 'terrace-field', 'chinampa', 'orchard', 'garth']);
const same = (a: unknown[], b: unknown[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export interface CavernRiverRoom {
  start: number; end: number; amplitude: number; peak: number; widthScale: number;
}

/** Irregular physical reaches: a quarter of the course widens, with unequal lengths and intervening gaps. */
export function cavernRiverRooms(rng: Rng, length: number): CavernRiverRoom[] {
  if (length <= 0) return [];
  const count = Math.min(32, Math.max(1, Math.round(length / rng.range(450, 850))));
  const durations = Array.from({ length: count }, () => rng.range(0.35, 1.65));
  const gaps = Array.from({ length: count + 1 }, () => rng.range(0.3, 2));
  const durationScale = length * 0.25 / durations.reduce((a, b) => a + b, 0);
  const gapScale = length * 0.75 / gaps.reduce((a, b) => a + b, 0);
  let cursor = gaps[0] * gapScale;
  return durations.map((duration, i) => {
    const start = cursor, end = start + duration * durationScale;
    cursor = end + gaps[i + 1] * gapScale;
    return { start, end, amplitude: rng.range(12, 30), peak: rng.range(0.35, 0.65), widthScale: rng.range(0.05, 0.3) };
  });
}

/** Continuous asymmetric shoulders; physical river coordinates and widths are never altered. */
export function cavernRiverBankMargin(rooms: CavernRiverRoom[], distance: number, width: number): number {
  const room = rooms.find((r) => distance >= r.start && distance <= r.end);
  if (!room) return 5;
  const t = (distance - room.start) / (room.end - room.start);
  const shoulder = t < room.peak ? t / room.peak : (1 - t) / (1 - room.peak);
  const smooth = shoulder * shoulder * (3 - 2 * shoulder);
  return 5 + (room.amplitude + Math.min(12, width * room.widthScale)) * smooth;
}

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
  const base = world.terrain.height;
  // Contour resolution must retain narrow bank galleries even on large terrain cells.
  const cell = Math.max(world.mapSize / 1200, Math.min(6, base.cell));
  const w = Math.ceil(world.mapSize / cell), h = w;
  const support = new Uint8Array(w * h), margins = new Float32Array(w * h);
  const occupied = new Uint8Array(w * h);
  const fungalRooms: PolyH[] = [];
  const laterProtection = new Map<PolyH, number>();
  const cultivationSupport = new Set<PolyH>();
  const protectedPieces: MultiPoly = [];
  const skeleton: Polyline[] = [];
  const root = new Rng('burgmap:' + world.seed).fork('cavern-mask');
  const noise = new Noise2D(root.fork('wall-noise'));
  const polygon = (ph: PolyH, room: boolean | number = false) => {
    if (ph.outer.length < 3) return;
    protectedPieces.push(ph);
    const rings = [ph.outer, ...ph.holes];
    rasterizePolys(rings, w, h, cell, support);
    const margin = typeof room === 'number' ? room : room ? 12 : 4;
    rasterizePolys(rings, w, h, cell, occupied);
    const box = bboxOf(ph.outer);
    for (let y = Math.max(0, Math.floor(box.y0 / cell)); y <= Math.min(h - 1, Math.ceil(box.y1 / cell)); y++) {
      for (let x = Math.max(0, Math.floor(box.x0 / cell)); x <= Math.min(w - 1, Math.ceil(box.x1 / cell)); x++) {
        const i = y * w + x;
        if (occupied[i]) margins[i] = Math.max(margins[i], margin);
        occupied[i] = 0;
      }
    }
    // Protect sub-cell roofs/segments and the entire polygon boundary before smoothing.
    for (const ring of rings) forCellsNearPolyline([...ring, ring[0]], w, h, cell, 0.6 * cell, (i) => {
      support[i] = 1; margins[i] = Math.max(margins[i], margin);
    });
  };
  const poly = (p: Polygon, room: boolean | number = false) => polygon({ outer: p, holes: [] }, room);
  const path = (points: Polyline, width: number | number[], room: boolean | number = false) => {
    if (points.length < 2) return;
    // A sub-decimetre guard absorbs Boolean snapping at ribbon joins.
    poly(ribbon(points, typeof width === 'number' ? width + 0.1 : width.map((v) => v + 0.1)), room);
  };
  const urban = (u: UrbanLayer) => {
    for (const ph of [...u.masses, ...(u.water ?? []), ...(u.moats ?? [])]) polygon(ph, true);
    for (const b of u.buildings) poly(b.poly, true);
    for (const l of u.landmarks) if (!CAVERN_CROP_MARKS.has(l.kind)) poly(l.poly, true);
    for (const p of u.squares) poly(p, true);
    for (const s of u.sites ?? []) poly(s.lot, true);
    for (const st of u.streets) { path(st.path, st.widths ?? st.width, true); skeleton.push(st.path); }
    for (const line of u.lines ?? []) path(line.closed ? [...line.path, line.path[0]] : line.path, line.width ?? 2, true);
    for (const quay of u.quays ?? []) path(quay, 4, true);
    for (const wall of u.walls ?? []) {
      path(wall.closed ? [...wall.path, wall.path[0]] : wall.path, wall.thickness, true);
      const radius = Math.max(12, wall.thickness * 3);
      for (let i = 0; i < wall.towers.length; i++) poly(disk(wall.towers[i], radius * (wall.towerScale?.[i] ?? 1)), true);
      for (const p of [...wall.gates, ...(wall.gateTowers ?? [])]) poly(disk(p, radius * 1.5), true);
    }
    for (const tree of u.trees ?? []) poly(disk(tree, 10), true);
  };
  const visible = renderView(world).urban;
  if (visible) urban(visible);
  for (const road of world.roads ?? []) { path(road.path, road.width, 2 + road.width * 0.6); skeleton.push(road.path); }
  for (const bridge of world.bridges ?? []) path([bridge.a, bridge.b], bridge.width + 4);
  for (const [ri, river] of world.terrain.rivers.entries()) {
    const length = river.path.slice(1).reduce((sum, p, j) => sum + Math.hypot(p.x - river.path[j].x, p.y - river.path[j].y), 0);
    const rooms = cavernRiverRooms(root.fork('river-reaches:' + ri), length);
    let travelled = 0;
    for (let j = 1; j < river.path.length; j++) {
      const a = river.path[j - 1], b = river.path[j], length = Math.hypot(b.x - a.x, b.y - a.y);
      const count = Math.max(1, Math.ceil(length / 12));
      for (let k = 0; k < count; k++) {
        const f = k / count, g = (k + 1) / count;
        const at = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        const wa = river.width[j - 1] ?? 2, wb = river.width[j] ?? wa;
        const middle = (f + g) / 2;
        const margin = cavernRiverBankMargin(rooms, travelled + length * middle, wa + (wb - wa) * middle);
        path([at(f), at(g)], [wa + (wb - wa) * f, wa + (wb - wa) * g], margin);
      }
      travelled += length;
    }
    // Retain the exact original join geometry after segmented support generation.
    protectedPieces.push({ outer: ribbon(river.path, river.width.map((v) => v + 0.1)), holes: [] });
    skeleton.push(river.path);
  }
  for (const lake of world.terrain.lakes) poly(lake);
  for (const coast of world.terrain.coastline) polygon({ outer: coast, holes: (world.terrain.islands ?? []).filter((p) => p.length >= 3 && pointInRing(coast, p[0])) });
  for (const f of world.landuse?.farmsteads ?? []) {
    poly(f.yard, true);
    for (const building of f.buildings) poly(building, true);
    path(f.drive, 5);
  }
  const crops = [
    ...(world.landuse?.areas ?? []).filter((a) => a.cultivation === 'fungal' || a.kind === 'garden' || a.kind === 'field' || a.kind === 'orchard'),
    ...(visible?.landmarks ?? []).filter((l) => CAVERN_CROP_MARKS.has(l.kind)).map((l) => ({ poly: l.poly, holes: [] as Polygon[] })),
  ];
  const centres: Vec2[] = [];
  for (const [i, area] of crops.entries()) {
    if (fungalRooms.length >= 12 || area.poly.length < 3) continue;
    const box = bboxOf(area.poly), rng = root.fork('fungal-room:' + i);
    const center = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
    if (!pointInRing(area.poly, center) || (area.holes ?? []).some((hole) => pointInRing(hole, center)) || centres.some((p) => Math.hypot(p.x - center.x, p.y - center.y) < 120)) continue;
    const radius = rng.range(24, 40);
    const extent = radius * 1.2;
    if (center.x < extent || center.y < extent || center.x > world.mapSize - extent || center.y > world.mapSize - extent) continue;
    const ring = Array.from({ length: 16 }, (_, j) => {
      const angle = j * Math.PI / 8, r = radius * rng.range(0.78, 1.16);
      return { x: center.x + Math.cos(angle) * r, y: center.y + Math.sin(angle) * r };
    });
    const free = tryDifference(ring, protectedPieces);
    if (free.failed || mpArea(free.pieces) < 100) continue;
    fungalRooms.push(...free.pieces); centres.push(center); poly(ring, 3);
    cultivationSupport.add(protectedPieces[protectedPieces.length - 1]);
    // Existing concrete geometry was already subtracted by free. Only later passages can change this room.
    for (const piece of free.pieces) laterProtection.set(piece, protectedPieces.length);
    let target: Vec2 | undefined, best = Infinity;
    for (const line of skeleton) { const near = nearestOn(line, center); if (near.d < best) { best = near.d; target = near.pt; } }
    if (!target) target = world.site?.center;
    if (target) path([center, target], 5, 2);
  }

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
    path(passage, 7, 3); skeleton.push(passage);
  }
  if (!protectedPieces.length) {
    // Environment-only maps without water still show a natural branching cave, not a seven-room template.
    const size = world.mapSize, r = root.fork('empty-environment');
    const main = Array.from({ length: 10 }, (_, i) => ({ x: size * (0.08 + i * 0.09), y: size * (0.5 + r.range(-0.2, 0.2)) }));
    path(main, Math.max(18, cell * 2));
    for (const i of [2, 5, 7]) path([main[i], { x: main[i].x + size * r.range(-0.08, 0.08), y: size * r.range(0.15, 0.85) }], Math.max(14, cell));
  }
  const field = distanceField(support, w, h, cell, margins);
  const envelope = new Float32Array(w * h);
  const lowScale = Math.max(90, cell * 12), fineScale = Math.max(18, cell * 3);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    const wx = (x + 0.5) * cell, wy = (y + 0.5) * cell;
    const low = noise.warped(wx / lowScale, wy / lowScale, 0.85, 3);
    const fine = noise.fbm(wx / fineScale, wy / fineScale, 3);
    const requested = field.val?.[i] ?? 4;
    const margin = Math.max(cell * 0.6, requested + Math.min(5, requested * 0.35) * low + 2 * fine);
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
  const operands = [...rough, ...mandatory];
  const exactRock = tryDifference(square, operands);
  // Coincident display ribbons can defeat the exact sweep. Millimetre snapping is safe inside the path guard.
  const rock = exactRock.failed ? tryDifferenceS(square, operands) : exactRock;
  const solid = rock.failed ? [] : rock.pieces;
  const exactInverse = tryDifference(square, solid);
  const inverse = exactInverse.failed ? tryDifferenceS(square, solid) : exactInverse;
  const floor = inverse.failed ? [{ outer: square, holes: [] }] : inverse.pieces;
  const mask = rasterizePolys(floor.flatMap((p) => [p.outer, ...p.holes]), base.w, base.h, base.cell);
  const clearance = distanceField(Uint8Array.from(mask, (v) => v ? 0 : 1), base.w, base.h, base.cell).dist;
  const rooms: PolyH[] = [];
  for (const room of fungalRooms) {
    const later = protectedPieces.slice(laterProtection.get(room) ?? 0).filter((p) => !cultivationSupport.has(p));
    const cultivated = tryDifference(room, later);
    if (cultivated.failed) continue;
    const inside = tryIntersection(cultivated.pieces, floor);
    if (!inside.failed) rooms.push(...inside.pieces);
  }
  return { floor, solid: inverse.failed ? [] : solid, fungalRooms: rooms, mask, clearance, chambers: [] };
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
