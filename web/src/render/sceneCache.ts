/** Persistent scene preparation for immutable worker snapshots. Painter order stays layer-major. */
import type { World, UrbanLayer, PolyH } from '../gen/types';
import { LandscapeGroundCache } from '../gen/landuse/landscapeGround';
import { groundAppearance } from '../gen/landuse/groundAppearance';
import { campCover } from './campCover';
import { megaView, placeholderUrban, mergeUrban } from '../gen/settlements/merge';
import { fabricBudget } from '../gen/urban/mega/standin';
import { MEGA_KEY } from '../gen/urban/mega/types';
import { buildScene, buildDensity, TILE_SIZE, type Scene, type PolyLayer, type LineLayer } from './scene';
import { boxesOf, TileIndex, type Rect } from './tileindex';

interface Part { source: unknown; owner?: UrbanLayer; coverOwners?: UrbanLayer[]; variant: string; scene: Scene; urban: UrbanLayer; id: number; bounds?: Rect }
let nextPart = 1;

function emptyUrban(u: UrbanLayer): UrbanLayer {
  return { ...u, macro: undefined, footprint: [], footprintH: [], streets: [], blocks: [], blockInfo: [],
    parcels: [], buildings: [], landmarks: [], squares: [], quarters: [], masses: [], backLand: [],
    walls: [], lines: [], trees: [], water: [], moats: [], ruralReserve: [], sites: [], quays: [] };
}

function bounds(scene: Scene): Rect | undefined {
  const b: Rect = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const l of [...scene.poly.values(), ...scene.lines]) for (let i = 0; i < l.index.boxes.length; i += 4) {
    b.minX = Math.min(b.minX, l.index.boxes[i]); b.minY = Math.min(b.minY, l.index.boxes[i + 1]);
    b.maxX = Math.max(b.maxX, l.index.boxes[i + 2]); b.maxY = Math.max(b.maxY, l.index.boxes[i + 3]);
  }
  return Number.isFinite(b.minX) ? b : undefined;
}

/** Layer tile keys include contributing part identities, not unstable flattened item offsets. */
function identities(parts: { id: number; layer: PolyLayer | LineLayer }[], index: TileIndex): { tileKeys: string[]; bigKeys: string[] } {
  const tileKeys = Array<string>(index.nx * index.ny).fill('');
  const owners = new Int32Array(index.count), local = new Int32Array(index.count);
  let offset = 0;
  for (const { id, layer } of parts) {
    for (let i = 0; i < layer.index.count; i++) { owners[offset] = id; local[offset++] = i; }
  }
  for (let t = 0; t < tileKeys.length; t++) {
    let last = -1;
    for (const i of index.itemsOf(t)) if (owners[i] !== last) { last = owners[i]; tileKeys[t] += `${last},`; }
  }
  const bigKeys = Array.from(index.big, (i) => `${owners[i]}:${local[i]}`);
  return { tileKeys, bigKeys };
}

function join(parts: Part[], staticScene: Scene, world: World, tile: number): Scene {
  const poly = new Map(staticScene.poly), counts = { ...staticScene.counts }, lines = staticScene.lines.slice();
  const groups = new Map<string, { id: number; layer: PolyLayer }[]>();
  const lineGroups = new Map<string, { id: number; layer: LineLayer }[]>();
  for (const part of parts) {
    for (const [name, layer] of part.scene.poly) { const list = groups.get(name) ?? []; list.push({ id: part.id, layer }); groups.set(name, list); }
    for (const layer of part.scene.lines) { const list = lineGroups.get(layer.name) ?? []; list.push({ id: part.id, layer }); lineGroups.set(layer.name, list); }
  }
  for (const [name, group] of groups) {
    const polys = group.flatMap(({ layer }) => layer.polys);
    const holes = group.flatMap(({ layer }) => layer.polys.map((_, i) => layer.holes?.[i]));
    const index = new TileIndex(world.mapSize, tile, boxesOf(polys), 'center');
    poly.set(name, { name, polys, holes, index, ...identities(group, index) }); counts[name] = polys.length;
  }
  const urbanLines: LineLayer[] = [];
  for (const [name, group] of lineGroups) {
    const source = group.flatMap(({ layer }) => layer.lines), index = new TileIndex(world.mapSize, tile, boxesOf(source), 'center');
    urbanLines.push({ ...group[0].layer, name, lines: source, index, ...identities(group, index) }); counts[name] = source.length;
  }
  // buildScene groups every merged street by descending rank, including widths first encountered in detail.
  const plots = urbanLines.filter((l) => l.role === 'plot'), remainder = urbanLines.filter((l) => l.role !== 'plot');
  const streets = remainder.filter((l) => l.role === 'street').sort((a, b) => Number(b.kind.slice(1, 2)) - Number(a.kind.slice(1, 2)));
  let si = 0;
  lines.push(...plots, ...remainder.map((l) => l.role === 'street' ? streets[si++] : l));
  const addedTextures = parts.flatMap((p) => p.scene.textures);
  let textures = staticScene.textures;
  if (addedTextures.length) {
    const groups = new Map(staticScene.textures.map((t) => [t.kind, t.areas.slice()]));
    for (const t of addedTextures) groups.set(t.kind, (groups.get(t.kind) ?? []).concat(t.areas));
    textures = [...groups].map(([kind, areas]) => ({ kind, areas, index: new TileIndex(world.mapSize, tile, boxesOf(areas.map((a) => a.poly)), 'overlap') }));
  }
  return { ...staticScene, poly, lines, textures, counts, density: buildDensity(world), renderedWorld: world, buildMs: 0,
    earthStreets: parts.some((p) => p.scene.earthStreets) };
}

export class SceneBuilder {
  private parts = new Map<string, Part>();
  private ground = new LandscapeGroundCache();
  private staticScene: Scene | undefined;
  private staticInputs: unknown[] = [];
  private hints: UrbanLayer['renderHints'];
  private legacy = false;
  /** Diagnostic counters count actual preparation, not redraws. */
  readonly stats = { staticBuilds: 0, partBuilds: 0, retainedParts: 0 };

  constructor(readonly tileSize = TILE_SIZE) {}

  update(world: World): Scene {
    const t0 = typeof performance === 'undefined' ? Date.now() : performance.now();
    // Legacy/hand-authored Worlds have different fringe semantics. Retain their original complete path.
    if (!world.urban || world.landuse?.landscapeGround === undefined) {
      this.legacy = true;
      return buildScene(world, this.tileSize);
    }
    const staticInputs = [world.terrain, world.landuse, world.roads, world.bridges, world.mapSize, !!world.options.contours,
      world.options.biome, world.site?.fields.dWater, world.site?.fields.hab];
    const full = this.legacy || !this.staticScene || staticInputs.some((v, i) => v !== this.staticInputs[i]) || this.hints !== world.urban?.renderHints;
    this.legacy = false;
    if (full) {
      this.staticScene = buildScene(world, this.tileSize, { scope: 'static', rendered: world });
      this.staticInputs = staticInputs; this.parts.clear(); this.hints = world.urban?.renderHints; this.stats.staticBuilds++;
    }
    this.ground.prepare(world, 0, true);
    const desired = new Map<string, Part>(), dirty: Rect[] = [];
    const hosts = [{ index: 0, urban: world.urban, settlement: undefined }, ...(world.settlements ?? []).filter((s) => !s.main).map((s) => ({ index: s.index, urban: s.urban, settlement: s }))];
    const macroCount = hosts.reduce((n, h) => n + (h.urban?.macro?.quarters.length ?? 0), 0), budget = fabricBudget(macroCount);
    const variant = `${budget.blocks},${budget.masses}`;
    const coverOwners = [...hosts.map((h) => h.urban), ...Object.values(world.megaDetail ?? {})].filter((u): u is UrbanLayer => !!u);
    const hasQuarters = hosts.some((h) => h.urban?.quarters.length) || Object.values(world.megaDetail ?? {}).some((u) => u.quarters.length);
    const add = (key: string, source: unknown, make: () => UrbanLayer, ground: () => PolyH[], suffix = '', dependencyOwner?: UrbanLayer): Part => {
      const shape = variant + '|' + hasQuarters + '|' + suffix;
      const old = this.parts.get(key);
      let part = old;
      const coverChanged = old?.coverOwners && (old.coverOwners.length !== coverOwners.length || old.coverOwners.some((u, i) => u !== coverOwners[i]));
      if (!old || old.source !== source || old.owner !== dependencyOwner || old.variant !== shape || coverChanged) {
        const sourceUrban = make(), u = { ...sourceUrban, renderHints: this.hints };
        const input = { ...world, urban: u, settlements: undefined, megaDetail: undefined };
        // Parts need geometry preparation, not a map-wide dense grid each. The joined scene indexes them once.
        const scene = buildScene(world, this.tileSize, { scope: 'urban', indexTileSize: world.mapSize, rendered: input, skipGround: true, ground: ground(),
          strokeSpace: hasQuarters && !u.quarters.length ? [] : undefined, appearance: groundAppearance(sourceUrban, world),
          plotBoundary: dependencyOwner?.footprintH ?? sourceUrban.footprintH, cover: campCover(world, sourceUrban) });
        part = { source, owner: dependencyOwner, coverOwners: sourceUrban.renderHints?.openGround ? coverOwners : undefined,
          variant: shape, scene, urban: u, id: nextPart++, bounds: bounds(scene) }; this.stats.partBuilds++;
        if (old?.bounds) dirty.push(old.bounds); if (part.bounds) dirty.push(part.bounds);
      } else this.stats.retainedParts++;
      desired.set(key, part!);
      return part!;
    };
    const renderedHosts: UrbanLayer[] = [];
    for (const host of hosts) {
      let u = host.urban;
      if (!u) {
        if (!host.settlement || host.settlement.detail !== 'lazy') continue;
        const s = host.settlement;
        renderedHosts.push(add(`s:${host.index}`, s, () => placeholderUrban(s, { data: world.terrain.water, n: world.terrain.height.w, cell: world.terrain.height.cell }), () => []).urban);
        continue;
      }
      const owner = u, M = u.macro;
      if (!M) renderedHosts.push(add(`s:${host.index}`, u, () => owner, () => this.ground.layer(owner), host.index ? 'secondary' : 'main').urban);
      else {
        add(`s:${host.index}`, u, () => ({ ...owner, macro: undefined, blocks: [], blockInfo: [], parcels: [], masses: [] }), () => [], 'base');
        const standins: UrbanLayer[] = [], details: UrbanLayer[] = [];
        for (const q of M.quarters) {
          const key = host.index * MEGA_KEY + q.id;
          if (world.megaDetail?.[key]) continue;
          standins.push(add(`q:${key}`, q, () => megaView({ ...emptyUrban(owner), macro: { ...M, quarters: [q] } }, undefined, budget), () => this.ground.quarter(owner, q), '', owner).urban);
        }
        for (const key of Object.keys(world.megaDetail ?? {}).map(Number).filter((k) => Math.floor(k / MEGA_KEY) === host.index).sort((a, b) => a - b)) {
          const detail = world.megaDetail![key];
          const q = M.quarters.find((q) => q.id === key % MEGA_KEY);
          details.push(add(`q:${key}`, detail, () => detail, () => this.ground.layer(detail, 0, q?.pts, owner), 'detail', owner).urban);
        }
        // Reconstruct megaView's base with retained stand-ins. Keep its original quarter metadata;
        // mergeUrban on each stand-in would incorrectly offset the macro quarter ids.
        const blocks: UrbanLayer['blocks'] = [], parcels: UrbanLayer['parcels'] = [];
        for (const part of standins) {
          const b0 = blocks.length; blocks.push(...part.blocks);
          parcels.push(...part.parcels.map((p) => b0 && p.block >= 0 ? { ...p, block: p.block + b0 } : p));
        }
        const base = { ...owner, macro: undefined, blocks, parcels,
          blockInfo: standins.flatMap((p) => p.blockInfo), masses: standins.flatMap((p) => p.masses) };
        renderedHosts.push(details.length ? { ...mergeUrban([base, ...details])!, macro: undefined } : base);
      }
    }
    for (const [key, old] of this.parts) if (!desired.has(key) && old.bounds) dirty.push(old.bounds);
    this.parts = desired;
    const scene = join([...desired.values()], this.staticScene!, { ...world, urban: mergeUrban(renderedHosts) }, this.tileSize);
    scene.dirty = full ? undefined : dirty;
    scene.buildMs = (typeof performance === 'undefined' ? Date.now() : performance.now()) - t0;
    return scene;
  }
}
