/**
 * Renderer-independent scene: the World flattened into spatially indexed layers.
 * Pure (no DOM, no Path2D) so it can be built and tested in Node.
 * Read-only w.r.t. the World; tolerant of missing optional layers.
 */
import type { World, LandKind, Polygon, Polyline, Vec2 } from '../gen/types';
import { offsetRibbon } from '../gen/core/geom';
import { TileIndex, boxesOf, chunkPolyline } from './tileindex';

export const TILE_SIZE = 250;

export interface PolyLayer {
  name: string;
  polys: Polygon[];
  /** Optional holes per polygon (same indexing as polys). */
  holes?: (Polygon[] | undefined)[];
  index: TileIndex;
}
export interface LineLayer {
  name: string;
  /** 'road' | 'street' | 'alley' | 'wall' | 'river' | 'drive' */
  role: string;
  kind: string;
  /** Nominal width in meters. */
  width: number;
  lines: Polyline[];
  index: TileIndex;
}
export interface DensityMap { w: number; h: number; cell: number; /** built-up fraction 0..1 */ cov: Float32Array; max: number }
export interface TextureArea { kind: LandKind; poly: Polygon; holes?: Polygon[] }
export interface TextureLayer { kind: LandKind; areas: TextureArea[]; index: TileIndex }

export interface Scene {
  mapSize: number;
  tileSize: number;
  poly: Map<string, PolyLayer>;
  lines: LineLayer[];
  textures: TextureLayer[];
  density: DensityMap | null;
  /** Number of source geometries indexed (for stats). */
  counts: Record<string, number>;
  buildMs: number;
}

export const LAND_ORDER: LandKind[] = ['meadow', 'marsh', 'pasture', 'commons', 'forest', 'garden', 'orchard', 'field'];
export const TEXTURE_KINDS: LandKind[] = ['forest', 'orchard', 'meadow', 'pasture', 'marsh', 'commons'];

function polyLayer(name: string, polys: Polygon[], mapSize: number, tile: number, holes?: (Polygon[] | undefined)[]): PolyLayer {
  return { name, polys, holes, index: new TileIndex(mapSize, tile, boxesOf(polys), 'center') };
}

function lineLayer(name: string, role: string, kind: string, width: number, lines: Polyline[], mapSize: number, tile: number): LineLayer {
  return { name, role, kind, width, lines, index: new TileIndex(mapSize, tile, boxesOf(lines), 'center') };
}

function ngon(c: Vec2, r: number, n = 8): Polygon {
  const out: Polygon = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }); }
  return out;
}

function polyArea(p: Polygon): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j].x + p[i].x) * (p[j].y - p[i].y);
  return Math.abs(a) / 2;
}

/** Built-up fraction per cell (building footprints, else blocks). */
export function buildDensity(world: World, cell = 60): DensityMap | null {
  const u = world.urban;
  if (!u) return null;
  const src: Polygon[] = u.buildings.length ? u.buildings.map((b) => b.poly) : u.blocks;
  const factor = u.buildings.length ? 1 : 0.6;
  if (!src.length) return null;
  const w = Math.max(1, Math.ceil(world.mapSize / cell));
  const cov = new Float32Array(w * w);
  const cellArea = cell * cell;
  for (const p of src) {
    if (p.length < 3) continue;
    let cx = 0, cy = 0;
    for (const q of p) { cx += q.x; cy += q.y; }
    cx /= p.length; cy /= p.length;
    const ix = Math.max(0, Math.min(w - 1, Math.floor(cx / cell))), iy = Math.max(0, Math.min(w - 1, Math.floor(cy / cell)));
    cov[iy * w + ix] += (polyArea(p) * factor) / cellArea;
  }
  let max = 0;
  for (let i = 0; i < cov.length; i++) { if (cov[i] > 1) cov[i] = 1; if (cov[i] > max) max = cov[i]; }
  return { w, h: w, cell, cov, max };
}

export function buildScene(world: World, tileSize = TILE_SIZE): Scene {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const S = world.mapSize;
  const poly = new Map<string, PolyLayer>();
  const lines: LineLayer[] = [];
  const counts: Record<string, number> = {};
  const addPoly = (name: string, polys: Polygon[], holes?: (Polygon[] | undefined)[]) => {
    if (!polys.length) return;
    poly.set(name, polyLayer(name, polys, S, tileSize, holes));
    counts[name] = polys.length;
  };
  const chunkDim = tileSize * 0.5;
  const addLines = (name: string, role: string, kind: string, width: number, src: Polyline[]) => {
    const chunks: Polyline[] = [];
    for (const pl of src) for (const c of chunkPolyline(pl, chunkDim)) chunks.push(c);
    if (!chunks.length) return;
    lines.push(lineLayer(name, role, kind, width, chunks, S, tileSize));
    counts[name] = chunks.length;
  };

  const t = world.terrain;
  addPoly('sea', t.coastline);
  addPoly('lakes', t.lakes);
  // river ribbons (same taper rule as svg.ts)
  const u16 = S / 1600;
  const minW = 1.1 * u16;
  const ribbons: Polygon[] = [];
  const centre: Polyline[] = [];
  for (const r of t.rivers) {
    if (r.path.length < 2) continue;
    const w = r.width.map((v, i) => Math.max(minW, v * (r.main ? 1 : Math.min(1, 0.35 + (0.65 * i) / 7))));
    ribbons.push(offsetRibbon(r.path, w));
    centre.push(r.path);
  }
  addPoly('rivers', ribbons);
  addLines('river-centre', 'river', 'centre', 0, centre);

  // land use
  const textures: TextureLayer[] = [];
  const lu = world.landuse;
  if (lu) {
    const stripA: Polygon[] = [], stripB: Polygon[] = [];
    const byKind = new Map<LandKind, { poly: Polygon; holes?: Polygon[] }[]>();
    for (const a of lu.areas) {
      let l = byKind.get(a.kind);
      if (!l) byKind.set(a.kind, (l = []));
      l.push({ poly: a.poly, holes: a.holes });
      if (a.kind === 'field' && a.strips) a.strips.forEach((s, i) => (i & 1 ? stripB : stripA).push(s));
    }
    for (const kind of LAND_ORDER) {
      const l = byKind.get(kind);
      if (!l) continue;
      addPoly('lu-' + kind, l.map((x) => x.poly), l.map((x) => x.holes));
      if (TEXTURE_KINDS.includes(kind)) {
        const areas: TextureArea[] = l.map((x) => ({ kind, poly: x.poly, holes: x.holes }));
        textures.push({ kind, areas, index: new TileIndex(S, tileSize, boxesOf(areas.map((a) => a.poly)), 'overlap') });
      }
    }
    addPoly('stripA', stripA);
    addPoly('stripB', stripB);
    addPoly('farm-yards', lu.farmsteads.map((f) => f.yard));
    addPoly('farm-buildings', lu.farmsteads.flatMap((f) => f.buildings));
    addLines('farm-drives', 'drive', 'drive', 2, lu.farmsteads.map((f) => f.drive));
  }

  // regional roads
  const roadW = { major: 8, minor: 5, track: 3 } as const;
  for (const kind of ['track', 'minor', 'major'] as const) {
    addLines('road-' + kind, 'road', kind, roadW[kind], (world.roads ?? []).filter((r) => r.kind === kind).map((r) => r.path));
  }

  // urban
  const ur = world.urban;
  if (ur) {
    addPoly('footprint', ur.footprint);
    addPoly('blocks', ur.blocks);
    addPoly('parcels', ur.parcels.map((p) => p.poly));
    addPoly('squares', ur.squares);
    addPoly('landmarks', ur.landmarks.map((l) => l.poly));
    const houses: Polygon[] = [], special: Polygon[] = [];
    for (const b of ur.buildings) (b.kind === 'house' || b.kind === 'home' || b.kind === 'residential' || b.kind === 'dwelling' ? houses : special).push(b.poly);
    addPoly('houses', houses);
    addPoly('special', special);
    const byW = new Map<string, Polyline[]>();
    for (const s of ur.streets) {
      const k = `${s.kind}|${Math.round(s.width * 2) / 2}`;
      let l = byW.get(k);
      if (!l) byW.set(k, (l = []));
      l.push(s.path);
    }
    const sorted = [...byW.entries()].sort((a, b) => Number(a[0].split('|')[1]) - Number(b[0].split('|')[1]));
    for (const [k, src] of sorted) {
      const [kind, w] = k.split('|');
      addLines('street-' + k, kind === 'alley' ? 'alley' : 'street', kind, Number(w), src);
    }
    if (ur.walls) {
      const wallLines: Polyline[] = [];
      const towers: Polygon[] = [], gates: Polygon[] = [];
      let thick = 0, n = 0;
      for (const w of ur.walls) {
        wallLines.push(w.closed && w.path.length > 2 ? [...w.path, w.path[0]] : w.path);
        thick += w.thickness; n++;
        for (const p of w.towers) towers.push(ngon(p, Math.max(3, w.thickness * 1.7)));
        for (const p of w.gates) gates.push(ngon(p, Math.max(3.5, w.thickness * 1.5)));
      }
      addLines('walls', 'wall', 'wall', n ? thick / n : 2.5, wallLines);
      addPoly('towers', towers);
      addPoly('gates', gates);
    }
  }

  const density = buildDensity(world);
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { mapSize: S, tileSize, poly, lines, textures, density, counts, buildMs: t1 - t0 };
}

/** Deterministic integer hash -> [0,1). Independent of view/tile so marks never flicker. */
export function hash3(x: number, y: number, salt: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function pointInPoly(p: Polygon, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[i], b = p[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function insideArea(a: TextureArea, x: number, y: number): boolean {
  if (!pointInPoly(a.poly, x, y)) return false;
  if (a.holes) for (const h of a.holes) if (pointInPoly(h, x, y)) return false;
  return true;
}

export interface Mark { x: number; y: number; r: number; k: number }

/**
 * Procedural texture marks for one tile of one kind. Points live on a global jittered
 * grid (spacing `sp`), a tile owns the grid cells whose origin lies inside it, so marks
 * are deterministic and never duplicated or shifted between tiles or frames.
 */
export function textureMarks(layer: TextureLayer, tile: number, sp: number, salt: number): Mark[] {
  const idx = layer.index;
  const tr = idx.tileRect(tile);
  const out: Mark[] = [];
  const ids = idx.itemsOf(tile);
  if (!ids.length) return out;
  const i0 = Math.floor(tr.minX / sp) - 1, i1 = Math.ceil(tr.maxX / sp);
  const j0 = Math.floor(tr.minY / sp) - 1, j1 = Math.ceil(tr.maxY / sp);
  const regular = layer.kind === 'orchard';
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const jx = regular ? 0.5 : hash3(i, j, salt), jy = regular ? 0.5 : hash3(i, j, salt + 7);
    const x = (i + jx) * sp, y = (j + jy) * sp;
    // a tile owns exactly the marks whose point lies inside it (no duplicates, no seams)
    if (x < tr.minX || x >= tr.maxX || y < tr.minY || y >= tr.maxY) continue;
    for (let n = 0; n < ids.length; n++) {
      const a = layer.areas[ids[n]];
      if (insideArea(a, x, y)) { out.push({ x, y, r: 0.75 + 0.25 * hash3(i, j, salt + 13), k: hash3(i, j, salt + 29) }); break; }
    }
  }
  return out;
}
