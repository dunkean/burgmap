/** Ordinary settlement ground keeps the same opaque landscape as the surrounding land. */
import type { World, UrbanLayer, PolyH, Polygon, TerrainLayer } from '../types';
import { offsetRibbon, polygonContains } from '../core/geom';
import { differenceSafeS, unionMany } from '../geo/bool';
import { area, orientPos } from '../geo/poly';
import { MEGA_KEY } from '../urban/mega/types';
import type { MacroQuarter } from '../urban/mega/types';
import { bboxOf } from '../geo/poly';

const piece = (outer: Polygon): PolyH => ({ outer: orientPos(outer), holes: [] });
const finite = (shapes: PolyH[]): boolean => shapes.every((p) => [p.outer, ...p.holes]
  .every((ring) => ring.length >= 3 && ring.every((v) => Number.isFinite(v.x) && Number.isFinite(v.y))));

/** Paving, cultivated yards and defensive works retain their own material. Hut cells are unpaved ground. */
function protectedGround(u: UrbanLayer): PolyH[] {
  return [
    ...u.parcels.filter((p) => p.use !== 'plot' && p.use !== 'hut-lot').map((p) => piece(p.poly)),
    ...u.backLand, ...u.squares.map(piece), ...(u.water ?? []), ...(u.ruralReserve ?? []),
    ...u.landmarks.filter((l) => l.kind !== 'camp-ground').map((l) => piece(l.poly)),
    // A macro quarter extends to arterial centre lines. Keep the host's real street ribbons paved until the
    // quarter's exact blocks take over; ordinary eager/detail blocks already exclude their street space.
    ...(u.macro ? u.streets.filter((st) => st.path.length >= 2).map((st) => piece(
      offsetRibbon(st.path, st.widths ?? st.path.map(() => st.width)))) : []),
  ];
}

/** Exact land occupied by ordinary blocks. Real walls do not change the material of the land they enclose. */
function layerGround(u: UrbanLayer, replaced: Set<number> = new Set()): PolyH[] {
  if (u.renderHints?.stilts) return [];
  let source: PolyH[];
  if (u.macro) {
    source = u.macro.quarters.filter((q) => q.kind === 'quarter' && q.district !== 'gardens' && !replaced.has(q.id)).map((q) => piece(q.pts));
  } else if (u.renderHints?.openGround) source = u.footprintH;
  else source = u.blocks.filter((_, i) => ['block', 'shanty'].includes(u.blockInfo[i]?.kind ?? '')).map(piece);
  if (!source.length && !u.macro) source = u.parcels.filter((p) => p.use === 'plot' || p.use === 'hut-lot').map((p) => piece(p.poly));
  const protection = protectedGround(u);
  if (!source.length || !finite(source) || !finite(protection)) return [];
  return differenceSafeS(unionMany(source, 24, true), unionMany(protection, 24, true));
}

/** Vector sea/lake/channel interiors remain protected; an island is genuinely dry ground. */
function waterGround(world: World): PolyH[] {
  const t = world.terrain, S = world.mapSize;
  if (!t) return [];
  const coast = t.coastline.filter((ring) => ring.length >= 3);
  const holes = coast.filter((ring, i) => coast.filter((other, j) => i !== j && area(other) > area(ring)
    && polygonContains(other, ring[0])).length % 2 === 1);
  const sea = differenceSafeS(coast.filter((ring) => !holes.includes(ring)).map(piece),
    [...(t.islands ?? []), ...holes].map(piece));
  // Replay is painted after water. Keep its real shoreline ink as well as the wet interior, using a metre-scale
  // guard rather than the former 80 m dry-bank exclusion which left a pale coastal strip.
  const bank: PolyH[] = [];
  const guard = 1.5 * S / 1600;
  for (const ring of [...coast, ...(t.islands ?? []), ...t.lakes]) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (!len) continue;
    const nx = -dy * guard / len, ny = dx * guard / len;
    bank.push(piece([{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }]));
    const radius = guard / Math.cos(Math.PI / 24);
    bank.push(piece(Array.from({ length: 24 }, (_, j) => ({
      x: a.x + radius * Math.cos((j + 0.5) * Math.PI / 12),
      y: a.y + radius * Math.sin((j + 0.5) * Math.PI / 12),
    }))));
  }
  return [...sea, ...bank, ...t.lakes.map(piece), ...t.rivers.filter((r) => r.path.length >= 2).map((r) => piece(
    offsetRibbon(r.path, r.width.map((width, i) => {
      const taper = r.main || r.edgeFed ? 1 : Math.min(1, 0.35 + 0.65 * i / 7);
      return Math.max(1.1 * S / 1600, width * taper) + 3.4 * S / 1600;
    })))),
  ];
}

interface Cached { signature: string; ground: PolyH[] }
const CACHE = new WeakMap<World, Cached>();

/** Generation stores this permission. Rendering derives it again when lazy settlement/quarter ownership changes. */
export function urbanLandscapeGround(world: World): PolyH[] {
  const detail = Object.values(world.megaDetail ?? {});
  // Detail deliberately has no footprint/quarter frames: the host owns those polygons. The same keyed handover
  // as renderView suppresses precisely that host quarter, including secondary-settlement macro plans.
  const hosts = [{ u: world.urban, si: 0 }, ...(world.settlements ?? []).filter((s) => !s.main).map((s) => ({ u: s.urban, si: s.index }))]
    .filter((host): host is { u: UrbanLayer; si: number } => !!host.u);
  const replaced = new Map<UrbanLayer, Set<number>>(hosts.map(({ u, si }) => [u, new Set(
    (u.macro?.quarters ?? []).filter((q) => world.megaDetail?.[si * MEGA_KEY + q.id]).map((q) => q.id))]));
  const layers = [world.urban, ...(world.settlements ?? []).filter((s) => !s.main).map((s) => s.urban), ...detail]
    .filter((u): u is UrbanLayer => !!u);
  const signature = JSON.stringify([world.mapSize, hosts.map(({ u, si }) => [si, [...replaced.get(u)!]]), layers.map((u) => [u.blocks, u.blockInfo, u.parcels, u.backLand,
    u.squares, u.landmarks, u.water, u.ruralReserve, u.renderHints, u.footprintH, u.macro?.quarters, u.streets]),
    world.terrain && [world.terrain.coastline, world.terrain.islands, world.terrain.lakes, world.terrain.rivers]]);
  const cached = CACHE.get(world);
  if (cached?.signature === signature) return cached.ground;
  let ground: PolyH[] = [];
  try {
    const source = layers.flatMap((u) => layerGround(u, replaced.get(u)));
    const t = world.terrain;
    const waterRings = t ? [...t.coastline, ...(t.islands ?? []), ...t.lakes, ...t.rivers.map((r) => r.path)] : [];
    if (waterRings.some((ring) => ring.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))
      || t?.rivers.some((r) => r.width.some((width) => !Number.isFinite(width)))) return [];
    const water = waterGround(world);
    if (finite(source) && finite(water)) ground = differenceSafeS(unionMany(source, 24, true), unionMany(water, 24, true));
  } catch { /* Decorative ground fails closed for malformed geometry. */ }
  CACHE.set(world, { signature, ground });
  return ground;
}

/** Stored cover may only be replayed on current ordinary ground, never on a newly arrived paved compound. */
export function currentLandscapeGround(world: World): PolyH[] {
  if (world.landuse?.landscapeGround === undefined) return [];
  return urbanLandscapeGround(world);
}

/** Visible natural cover avoids occupied roofs; the opaque terrain base still continues under the whole block. */
export function landscapeCoverGround(world: World, ground: PolyH[]): PolyH[] {
  const layers = [world.urban, ...(world.settlements ?? []).filter((s) => !s.main).map((s) => s.urban),
    ...Object.values(world.megaDetail ?? {})]
    .filter((u): u is UrbanLayer => !!u);
  const roofs = layers.flatMap((u) => u.masses.length ? u.masses : u.buildings.map((b) => piece(b.poly)));
  if (!finite(roofs)) return [];
  return differenceSafeS(ground, unionMany(roofs, 24, true));
}

/**
 * Interactive snapshots have immutable layer objects. This cache is owned by one displayed generation;
 * unlike the export helper it never hashes/re-unions all previous quarters after a detail batch.
 * A caller editing an object in place must explicitly bump its version.
 */
export class LandscapeGroundCache {
  private terrain: TerrainLayer | undefined;
  private mapSize = 0;
  private terrainVersion = -1;
  private water: PolyH[] = [];
  private waterSafe = false;
  private layers = new WeakMap<UrbanLayer, { version: number; ground: PolyH[] }>();
  private quarters = new WeakMap<MacroQuarter, { owner: UrbanLayer; version: number; ground: PolyH[] }>();
  private protections = new WeakMap<UrbanLayer, { version: number; pieces: PolyH[] }>();

  prepare(world: World, terrainVersion = 0): void {
    if (this.terrain === world.terrain && this.mapSize === world.mapSize && this.terrainVersion === terrainVersion) return;
    this.terrain = world.terrain; this.mapSize = world.mapSize; this.terrainVersion = terrainVersion;
    const t = world.terrain;
    const rings = [...t.coastline, ...(t.islands ?? []), ...t.lakes, ...t.rivers.map((r) => r.path)];
    this.waterSafe = rings.every((ring) => ring.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)))
      && t.rivers.every((r) => r.width.every(Number.isFinite));
    this.water = [];
    try { if (this.waterSafe) this.water = waterGround(world); } catch { this.waterSafe = false; }
    // Terrain changes invalidate every dry-land permission, including cached macro pieces.
    this.layers = new WeakMap(); this.quarters = new WeakMap(); this.protections = new WeakMap();
  }

  private dry(source: PolyH[], protection: PolyH[]): PolyH[] {
    if (!this.waterSafe || !source.length || !finite(source) || !finite(protection) || !finite(this.water)) return [];
    const boxes = source.map((p) => bboxOf(p.outer));
    const near = (pieces: PolyH[]): PolyH[] => pieces.filter((p) => {
      const b = bboxOf(p.outer);
      return boxes.some((a) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0);
    });
    try {
      const protectedLand = unionMany(near(protection), 24, true);
      const ground = differenceSafeS(unionMany(source, 24, true), protectedLand);
      return differenceSafeS(ground, unionMany(near(this.water), 24, true));
    } catch { return []; }
  }

  layer(u: UrbanLayer, version = 0): PolyH[] {
    const cached = this.layers.get(u);
    if (cached?.version === version) return cached.ground;
    const ground = this.dry(layerGround(u), []);
    this.layers.set(u, { version, ground });
    return ground;
  }

  quarter(owner: UrbanLayer, q: MacroQuarter, version = 0): PolyH[] {
    const cached = this.quarters.get(q);
    if (cached?.owner === owner && cached.version === version) return cached.ground;
    let protectedLand = this.protections.get(owner);
    if (protectedLand?.version !== version) {
      protectedLand = { version, pieces: protectedGround(owner) };
      this.protections.set(owner, protectedLand);
    }
    const source = !owner.renderHints?.stilts && q.kind === 'quarter' && q.district !== 'gardens' ? [piece(q.pts)] : [];
    const ground = this.dry(source, protectedLand.pieces);
    this.quarters.set(q, { owner, version, ground });
    return ground;
  }
}
