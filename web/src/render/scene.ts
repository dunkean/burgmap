import { isUnderdarkBiome } from '../gen/biomes';
/**
 * Renderer-independent scene: the World flattened into spatially indexed layers.
 * Pure (no DOM, no Path2D) so it can be built and tested in Node.
 * Read-only w.r.t. the World; tolerant of missing optional layers.
 */
import type { World, LandKind, LandArea, Polygon, Polyline, Vec2, PolyH } from '../gen/types';
import { contourSet } from './contours';
import { countrysideFringe, fringeStreetWidth } from './countryside';
import { currentLandscapeGround } from '../gen/landuse/landscapeGround';
import { worldGroundAppearance, earthCourt, type GroundAppearance } from '../gen/landuse/groundAppearance';
import { plotLines } from './plotLines';
import { worldCampCover } from './campCover';
import { renderView } from '../gen/settlements/merge';
import { seaWithIslands } from './util';
import { farmPlots, farmRidges, treePolys } from './farms';
import { fieldHedges } from './hedges';
import { terraceMarks } from './terraces';
import { urbanStrokeSpace } from './roadSurfaces';
import { offsetRibbon, polygonCentroid } from '../gen/core/geom';
import { pointInRing, orientPos } from '../gen/geo/poly';
import { TileIndex, boxesOf, chunkPolyline } from './tileindex';

export const TILE_SIZE = 250;

export interface PolyLayer {
  name: string;
  polys: Polygon[];
  /** Optional holes per polygon (same indexing as polys). */
  holes?: (Polygon[] | undefined)[];
  index: TileIndex;
  /** Stable contributing-part identities per tile, supplied by the incremental builder. */
  tileKeys?: string[];
  bigKeys?: string[];
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
  tileKeys?: string[];
  bigKeys?: string[];
}
export interface DensityMap { w: number; h: number; cell: number; /** built-up fraction 0..1 */ cov: Float32Array; max: number }
export interface TextureArea { kind: LandKind; poly: Polygon; holes?: Polygon[] }
export interface TextureLayer { kind: LandKind; areas: TextureArea[]; index: TileIndex }
export interface FurrowArea { poly: Polygon; holes?: Polygon[]; strips: Polygon[]; angle: number }

export interface Scene {
  mapSize: number;
  tileSize: number;
  poly: Map<string, PolyLayer>;
  lines: LineLayer[];
  textures: TextureLayer[];
  furrows?: { areas: FurrowArea[]; index: TileIndex };
  density: DensityMap | null;
  /** Number of source geometries indexed (for stats). */
  counts: Record<string, number>;
  buildMs: number;
  /** Changed source bounds; absent means a complete scene replacement. */
  dirty?: { minX: number; minY: number; maxX: number; maxY: number }[];
  /** Exact merged renderer view assembled from retained immutable parts, avoiding repeated stand-in generation. */
  renderedWorld?: World;
  earthStreets?: boolean;
}

/**
 * Shared urban kind lists: what `render/urban.ts` (SVG) draws and what the Canvas scene indexes.
 * tests/canvas_urban_kinds.test.ts fails when urban.ts draws a kind that is missing here.
 */
export const URBAN_PARCEL_USES = {
  places: ['place', 'market', 'quay', 'pier', 'slipway', 'timber-yard', 'mill-yard', 'mill', 'tannery-yard', 'bridge'],
  greens: ['green', 'mill-island', 'windmill-mound', 'gallows-hill', 'ropewalk-yard'],
  yards: ['church'],
  blocks: ['arena-plot', 'inn'],
  plazas: ['plaza'],
  meadows: ['meadow'],
  plots: ['plot'],
  ditch: ['ditch'],
  /** Compound grounds (also any `compound:*`). */
  grounds: ['bailey', 'causeway', 'ghat', 'castle-honmaru', 'compound:castle-honmaru', 'bailey-gate', 'esplanade'],
  /** Open ground (camps and barbarian villages, `renderHints.openGround`): yards and paddocks as grass, greens, gardens, fields. */
  openGrass: ['pen'],
  openGreen: ['meadow', 'green'],
  openGarden: ['garden'],
  openField: ['field'],
  openCommons: ['commons'],
} as const;
export const URBAN_LANDMARK_KINDS = ['sahn', 'garth', 'chinampa-canal', 'baray', 'pond', 'chinampa', 'cornfield', 'terrace-field', 'garden-bed', 'cemetery', 'tenshu-base', 'mebon', 'yard-earth', 'midden', 'mud', 'puddle', 'camp-ground'] as const;
/** Building kinds with a dedicated look (the rest are ordinary roofs). */
export const URBAN_BUILDING_KINDS = ['church', 'cathedral', 'landmark', 'house'] as const;
/** Plan-line widths (m) of the generic wall-like kinds, and of camp / village fences (same tables as urban.ts). */
export const WALL_LINE_W: Record<string, number> = { 'arcane-circle': 0.5, 'lock-gate': 0.8, bank: 0.8, stands: 2.4, dome: 0.6, gallery: 2.2, 'zigzag-wall': 2.4, 'canal-wall': 1, 'pyramid-step': 0.5, 'stall-row': 2.2, 'compound-wall': 1, 'citadel-wall': 2.4, 'stone-wall': 1.8, prakara: 1.6, 'ward-wall': 1.8, platform: 0.4, stela: 1.1, 'sacbe-edge': 0.5, balustrade: 1, 'round-door': 0.35, 'carved-door': 0.25, 'veranda-edge': 0.35, colonnade: 0.25, 'drying-rack': 0.6 };
export const CAMP_FENCE_W: Record<string, number> = { 'kraal-fence': 1.1, 'yard-fence': 0.45, 'pen-fence': 0.5, 'orda-fence': 0.8, palisade: 1.2, 'turf-wall': 2.2, albarrada: 0.9 };
/** Fences drawn as fences (same table as urban.ts): [rail width, post width, post length, gap] in meters. */
export const FENCE_STYLE: Record<string, [number, number, number, number]> = {
  'yard-fence': [0.16, 0.55, 0.45, 2.4], 'pen-fence': [0.14, 0.45, 0.4, 1.8], 'orda-fence': [0.2, 0.7, 0.55, 1.6],
  palisade: [0.3, 1.05, 0.55, 0.28], 'kraal-fence': [0.3, 1.15, 0.8, 0.5],
};
/** Plan-line kinds with their own rule (anything else falls back to the wall-like stroke). */
export const URBAN_SPECIAL_LINES = ['moat', 'canal', 'hedge', 'track', 'weir', 'parterre', 'footpath', 'ghat-steps', 'terrace', 'andene', 'thorn-fence', 'rampart', 'ditch', 'footbridge', 'bazaar-roof', 'qanat', 'qanat-shaft', 'hachure', 'roof-line', 'bund', 'garden-hedge', 'andene-riser', 'terrace-stair'] as const;
export const URBAN_LINE_KINDS: readonly string[] = [...URBAN_SPECIAL_LINES, ...Object.keys(WALL_LINE_W), ...Object.keys(CAMP_FENCE_W)];

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

/**
 * The ground pieces of an open-ground settlement that hide what lies under them (the regional roads): all of them
 * for a walled or muddy camp, else the large ones (a camp circle, a village; not the homefields of scattered farms).
 */
export function solidGround(ub: NonNullable<World['urban']>): Polygon[] {
  const all = !!ub.walls?.length || ub.landmarks.some((l) => l.kind === 'mud');
  return ub.landmarks.filter((l) => l.kind === 'camp-ground' && (all || polyArea(l.poly) > 20000)).map((l) => l.poly);
}

/** Built-up fraction per cell (building footprints, else blocks). */
export function buildDensity(world: World, cell = 60): DensityMap | null {
  const u = world.urban;
  if (!u) return null;
  // megacity: the macro plan's raster (the detail exists only where the view has been)
  if (u.densityGrid) return { w: u.densityGrid.w, h: u.densityGrid.w, cell: u.densityGrid.cell, cov: u.densityGrid.cov, max: u.densityGrid.max };
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

export interface SceneBuildOptions {
  /** Already merged input, used for stable independently prepared urban parts. */
  rendered?: World;
  scope?: 'static' | 'urban';
  ground?: PolyH[];
  skipGround?: boolean;
  strokeSpace?: PolyH[];
  appearance?: GroundAppearance;
  plotBoundary?: PolyH[];
  cover?: LandArea[];
  /** Geometry-only parts use one compact index; polyline chunk lengths remain unchanged. */
  indexTileSize?: number;
}

export function buildScene(world0: World, tileSize = TILE_SIZE, build: SceneBuildOptions = {}): Scene {
  const world = build.rendered ?? renderView(world0);
  const appearance = build.appearance ?? worldGroundAppearance(world0);
  const cover = build.scope === 'static' ? [] : build.cover ?? worldCampCover(world0);
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const S = world.mapSize;
  const poly = new Map<string, PolyLayer>();
  const lines: LineLayer[] = [];
  const counts: Record<string, number> = {};
  const addPoly = (name: string, polys: Polygon[], holes?: (Polygon[] | undefined)[]) => {
    if (!polys.length) return;
    poly.set(name, polyLayer(name, polys, S, build.indexTileSize ?? tileSize, holes));
    counts[name] = polys.length;
  };
  const chunkDim = tileSize * 0.5;
  const addLines = (name: string, role: string, kind: string, width: number, src: Polyline[]) => {
    const chunks: Polyline[] = [];
    for (const pl of src) for (const c of chunkPolyline(pl, chunkDim)) chunks.push(c);
    if (!chunks.length) return;
    lines.push(lineLayer(name, role, kind, width, chunks, S, build.indexTileSize ?? tileSize));
    counts[name] = chunks.length;
  };

  const textures: TextureLayer[] = [];
  const furrowAreas: FurrowArea[] = [];
  if (build.scope !== 'urban') {
  const t = world.terrain;
  if (t.caverns) {
    addPoly('cavern-floor', t.caverns.floor.map(p => p.outer), t.caverns.floor.map(p => p.holes));
    addPoly('cavern-solid', t.caverns.solid.map(p => p.outer), t.caverns.solid.map(p => p.holes));
  }
  const swi = seaWithIslands(t.coastline, t.islands);
  addPoly('sea', swi.sea, swi.holes.map((h) => (h.length ? h : undefined)));
  addPoly('lakes', t.lakes);
  // river ribbons (same taper rule as svg.ts)
  const u16 = S / 1600;
  const minW = 1.1 * u16;
  const ribbons: Polygon[] = [];
  const centre: Polyline[] = [];
  for (const r of t.rivers) {
    if (r.path.length < 2) continue;
    const w = r.width.map((v, i) => Math.max(minW, v * (r.main || r.edgeFed ? 1 : Math.min(1, 0.35 + (0.65 * i) / 7))));
    ribbons.push(offsetRibbon(r.path, w));
    centre.push(r.path);
  }
  addPoly('rivers', ribbons);
  addLines('river-centre', 'river', 'centre', 0, centre);

  // contours (closed loops get their first point repeated: the canvas draws them as plain polylines)
  if (world.options.contours) {
    const cs = contourSet(world, u16);
    const lp = (l: { pts: Polyline; closed: boolean }[]): Polyline[] => l.map((c) => (c.closed ? [...c.pts, c.pts[0]] : c.pts));
    addLines('contour-thin', 'contour', 'thin', 0, lp(cs.thin));
    addLines('contour-index', 'contour', 'index', 0, lp(cs.index));
  }

  // land use
  const lu = world.landuse;
  if (lu) {
    const tones: Polygon[][] = [[], [], [], []];
    const open: Polygon[] = [], open_h: (Polygon[] | undefined)[] = [];
    let fi = 0;
    const byKind = new Map<LandKind, { poly: Polygon; holes?: Polygon[] }[]>();
    for (const a of lu.areas) {
      let l = byKind.get(a.kind);
      if (!l) byKind.set(a.kind, (l = []));
      l.push({ poly: a.poly, holes: a.holes });
      if (a.kind === 'field') {
        if (!(a as { enclosed?: boolean }).enclosed) { open.push(a.poly); open_h.push(a.holes); }
        if (a.strips && a.stripAngle !== undefined) {
          if (a.strips.length && Number.isFinite(a.stripAngle)) furrowAreas.push({ poly: a.poly, holes: a.holes, strips: a.strips, angle: a.stripAngle });
          a.strips.forEach((s, i) => tones[(i * 5 + fi * 3 + (i >> 2)) & 3].push(s));
          fi++;
        }
      }
    }
    for (const kind of LAND_ORDER) {
      const l = byKind.get(kind);
      if (!l) continue;
      addPoly('lu-' + kind, l.map((x) => x.poly), l.map((x) => x.holes));
      if (TEXTURE_KINDS.includes(kind) || (isUnderdarkBiome(world.options.biome) && (kind === 'garden' || kind === 'field'))) {
        const areas: TextureArea[] = l.map((x) => ({ kind, poly: x.poly, holes: x.holes }));
        textures.push({ kind, areas, index: new TileIndex(S, tileSize, boxesOf(areas.map((a) => a.poly)), 'overlap') });
      }
    }
    tones.forEach((t, k) => addPoly('stripT' + k, t));
    addPoly('furlong-edges', open, open_h);
    const hedges = fieldHedges(lu.areas, S / 1600);
    addPoly('hedge-trees', hedges.trees.map((t) => ngon(t.center, t.radius)));
    addLines('hedges', 'field', 'hedge', 1, hedges.lines);
    // farmsteads: lot pieces, hedged lot, yard, pens and ponds, walls, trees, buildings and their roof ridges
    const fms = lu.farmsteads;
    const fungalFarm = (f: typeof fms[number]): boolean => f.cultivation === 'fungal' || isUnderdarkBiome(world.options.biome);
    addPoly('farm-gardens', farmPlots(fms.filter(f => !fungalFarm(f)), 'garden'));
    addPoly('farm-fungal-gardens', farmPlots(fms.filter(fungalFarm), 'garden'));
    addPoly('farm-orchards', farmPlots(fms, 'orchard'));
    addPoly('farm-paddocks', farmPlots(fms, 'paddock'));
    addPoly('farm-platforms', farmPlots(fms, 'platform'));
    addPoly('farm-lots', fms.flatMap((f) => (f.lot ? [f.lot] : [])));
    addPoly('farm-yards', fms.map((f) => f.yard));
    addPoly('farm-pens', [...farmPlots(fms, 'pen'), ...farmPlots(fms, 'threshing-floor')]);
    addPoly('farm-ponds', farmPlots(fms, 'pond'));
    addPoly('farm-trees', treePolys(fms.flatMap((f) => f.trees ?? [])));
    addPoly('farm-buildings', fms.flatMap((f) => f.buildings));
    addLines('farm-walls', 'farm', 'wall', 0.9, fms.flatMap((f) => f.walls ?? []));
    addLines('farm-ridges', 'farm', 'ridge', 0.35, fms.flatMap(farmRidges));
    addLines('farm-drives', 'drive', 'drive', 2, lu.farmsteads.map((f) => f.drive));
    addLines('field-ways', 'field', 'way', 2.6, (lu as { ways?: Polyline[] }).ways ?? []);
    addLines('headlands', 'field', 'headland', 1.5, (lu as { headlands?: Polyline[] }).headlands ?? []);
  }

  // regional roads
  const roadW = { major: 8, minor: 3.6, track: 3 } as const;
  for (const kind of ['track', 'minor', 'major'] as const) {
    addLines('road-' + kind, 'road', kind, roadW[kind], (world.roads ?? []).filter((r) => r.kind === kind).map((r) => r.path));
  }
  }

  // urban (same layering as render/urban.ts)
  const ur = world.urban;
  if (ur && build.scope !== 'static') {
    const addH = (name: string, l: PolyH[]): void => addPoly(name, l.map((p) => p.outer), l.map((p) => (p.holes.length ? p.holes : undefined)));
    const fringe = !build.skipGround && world0.landuse?.landscapeGround === undefined ? countrysideFringe(world0) : { bands: [], ground: [], streets: [] };
    fringe.bands.forEach((pieces, i) => addH('u-country-fringe-' + i, pieces));
    addH('u-country-fringe', fringe.ground);
    addH('u-natural-ground', (!build.skipGround && world0.landuse?.landscapeGround === undefined ? world0.landuse?.naturalGround ?? [] : []).map((p) => ({ outer: orientPos(p.outer),
      holes: p.holes.map((h) => orientPos(h).slice().reverse()) })));
    addH('u-landscape-ground', (build.ground ?? (build.skipGround ? [] : currentLandscapeGround(world0, true))).concat(cover.map((a) => ({ outer: a.poly, holes: a.holes ?? [] }))).map((p) => ({ outer: orientPos(p.outer),
      holes: p.holes.map((h) => orientPos(h).slice().reverse()) })));
    const fringeStreets = new Map<number, Polyline[]>();
    for (const st of fringe.streets) {
      const width = fringeStreetWidth(st.width);
      const paths = fringeStreets.get(width) ?? [];
      paths.push(st.path); fringeStreets.set(width, paths);
    }
    for (const [width, paths] of fringeStreets) addLines('country-street-' + width, 'fringe-street', 'street', width, paths);
    addPoly('footprint', ur.footprint);
    for (const kind of TEXTURE_KINDS) {
      const added = cover.filter((a) => a.kind === kind);
      if (!added.length) continue;
      addPoly('u-cover-' + kind, added.map((a) => a.poly), added.map((a) => a.holes));
      const i = textures.findIndex((t) => t.kind === kind);
      const areas: TextureArea[] = (i >= 0 ? textures[i].areas : []).concat(added.map((a) => ({ kind, poly: a.poly, holes: a.holes })));
      const layer = { kind, areas, index: new TileIndex(S, tileSize, boxesOf(areas.map((a) => a.poly)), 'overlap') };
      if (i >= 0) textures[i] = layer; else textures.push(layer);
    }
    addH('u-streets', ur.quarters.map((q) => ({ outer: orientPos(q.poly.outer), holes: q.poly.holes.map((h) => orientPos(h).slice().reverse()) })));
    addH('u-stroke-space', build.strokeSpace ?? urbanStrokeSpace(ur));
    const parcelsOf = (use: string[]): Polygon[] => ur.parcels.filter((p) => use.includes(p.use)).map((p) => p.poly);
    const PU = URBAN_PARCEL_USES;
    addPoly('u-places', parcelsOf([...PU.places]));
    addPoly('u-greens', parcelsOf([...PU.greens]));
    addPoly('u-yards', parcelsOf([...PU.yards]));
    addPoly('u-blocks', [...ur.blocks.filter((_, i) => ur.blockInfo[i]?.kind === 'block'), ...parcelsOf([...PU.blocks])]);
    addPoly('u-meadows', parcelsOf([...PU.meadows]));
    addPoly('u-plazas', parcelsOf([...PU.plazas]));
    addPoly('u-grounds', ur.parcels.filter((p) => (typeof p.use === 'string' && p.use.startsWith('compound:')) || (PU.grounds as readonly string[]).includes(p.use)).map((p) => p.poly));
    addPoly('u-ditch', parcelsOf([...PU.ditch]));
    if (ur.renderHints?.openGround && !ur.renderHints?.stilts) {
      addPoly('u-open-grass', parcelsOf([...PU.openGrass]));
      addPoly('u-open-green', parcelsOf([...PU.openGreen]));
      addPoly('u-open-garden', parcelsOf([...PU.openGarden]));
      addPoly('u-open-field', parcelsOf([...PU.openField]));
      addPoly('u-open-commons', parcelsOf([...PU.openCommons]));
      addPoly('u-ground', ur.landmarks.filter((l) => l.kind === 'camp-ground').map((l) => l.poly));
      addPoly('u-ground-solid', solidGround(ur));
      addPoly('u-mud', ur.landmarks.filter((l) => l.kind === 'mud').map((l) => l.poly));
      addPoly('u-puddle', ur.landmarks.filter((l) => l.kind === 'puddle').map((l) => l.poly));
      addPoly('u-yard-earth', ur.landmarks.filter((l) => l.kind === 'yard-earth' || l.kind === 'midden').map((l) => l.poly));
    }
    const lmOf = (...k: string[]): Polygon[] => ur.landmarks.filter((l) => k.includes(l.kind)).map((l) => l.poly);
    addPoly('u-sahn', lmOf('sahn'));
    addPoly('u-garth', lmOf('garth'));
    addPoly('u-cemetery', lmOf('cemetery'));
    addPoly('u-bases', lmOf('tenshu-base', 'mebon'));
    addPoly('u-patios', ur.buildings.flatMap((b) => (b.kind === 'house' && !earthCourt(b, world) && b.courtyards?.length ? b.courtyards.filter((c) => c.length >= 3) : [])));
    addPoly('u-trees', (ur.trees ?? []).map((t) => ngon(t, t.r, 8)));
    addPoly('u-cornfields', ur.landmarks.filter((l) => l.kind === 'cornfield' || l.kind === 'garden-bed').map((l) => l.poly));
    addPoly('u-terraces', ur.landmarks.filter((l) => l.kind === 'terrace-field').map((l) => l.poly));
    addPoly('u-chinampa-canals', ur.landmarks.filter((l) => l.kind === 'chinampa-canal' || l.kind === 'baray' || l.kind === 'pond').map((l) => l.poly));
    addPoly('u-chinampas', ur.landmarks.filter((l) => l.kind === 'chinampa').map((l) => l.poly));
    addH('u-backland', appearance.gardens);
    addH('u-masses', ur.masses);
    {
      // individual roofs (landmarks are drawn by u-church / landmarks); courtyards are holes
      const bs = ur.buildings.filter((b) => b.kind !== 'church' && b.kind !== 'cathedral' && b.kind !== 'landmark' && b.poly.length >= 3);
      // (a courtyard is a hole only when it lies inside the footprint: the patio of a courtyard house drawn as one C
      // around it, or split in ranges, stays open ground)
      const inside = (b: { poly: Polygon }, c: Polygon) => c.length >= 3 && pointInRing(b.poly, polygonCentroid(c));
      addPoly('u-bldg', bs.map((b) => b.poly), bs.map((b) => { const h = (b.courtyards ?? []).filter((c) => inside(b, c)); return h.length ? h : undefined; }));
    }
    addLines('u-plots', 'plot', 'cadastre', 0, plotLines(ur, build.plotBoundary ?? ur.footprintH));
    addPoly('u-church', ur.buildings.filter((b) => b.kind === 'church' || b.kind === 'cathedral').map((b) => b.poly));
    // landmark buildings (keeps, halls, temples, minarets...), urban water (moats, tanks, mill races) and the plan
    // lines (compound and ward walls, moats, quay edges, terraces, hedges, footpaths)
    addPoly('u-lmb', ur.buildings.filter((b) => b.kind === 'landmark' && b.poly.length >= 3).map((b) => b.poly));
    // Nonzero fill combines overlapping pieces while preserving oppositely wound holes.
    addH('u-water', (ur.water ?? []).map((ph) => ({ outer: orientPos(ph.outer), holes: ph.holes.map((h) => orientPos(h).slice().reverse()) })));
    {
      const byLine = new Map<string, Polyline[]>();
      for (const l of ur.lines ?? []) {
        if (l.path.length < 2) continue;
        const k = l.kind + '|' + Math.round((l.width ?? 1) * 4) / 4;
        let list = byLine.get(k);
        if (!list) byLine.set(k, (list = []));
        list.push(l.closed ? [...l.path, l.path[0]] : l.path);
      }
      for (const [k, list] of byLine) { const [kind, w] = k.split('|'); addLines('ul-' + k, 'uline', kind, Number(w), list); }
      for (const [kind, gap, length] of [['andene-riser', 6, 1.2], ['terrace-stair', 2.2, 1.5]] as const) {
        const ticks = (ur.lines ?? []).filter((l) => l.kind === kind).flatMap((l) => terraceMarks(l.closed ? [...l.path, l.path[0]] : l.path, gap, length));
        const markKind = kind === 'andene-riser' ? 'andene-hachure' : 'terrace-tread';
        addLines('ul-' + markKind, 'uline', markKind, 0.25, ticks);
      }
    }
    const crosses: Polyline[] = [];
    for (const b of ur.buildings) {
      if ((b.kind !== 'church' && b.kind !== 'cathedral') || b.poly.length < 3) continue;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const q of b.poly) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = Math.max(2.5, (x1 - x0) * 0.08);
      crosses.push([{ x: cx - r, y: cy }, { x: cx + r, y: cy }], [{ x: cx, y: cy - r * 1.4 }, { x: cx, y: cy + r }]);
    }
    addLines('church-cross', 'cross', 'cross', 0.9, crosses);
    addPoly('landmarks', ur.landmarks.filter((l) => l.kind !== 'yard-earth' && l.kind !== 'midden' && l.kind !== 'mud' && l.kind !== 'puddle' && l.kind !== 'camp-ground').map((l) => l.poly));
    // streets by rank and (rounded) width so each layer shares one stroke width; the streets of the secondary
    // settlements (villages, hamlets) are kept in their own layers ('vstreet-*'): the renderer never draws them as
    // far-zoom arterials
    const secondary = new Set<unknown>();
    for (const s of world0.settlements ?? []) if (!s.main) for (const st of s.urban?.streets ?? []) secondary.add(st);
    const byW = new Map<string, Polyline[]>();
    const earthSources = new Set(appearance.streetSources);
    for (const st of ur.streets) {
      const k = `${secondary.has(st) ? 'v' : ''}${st.rank}|${st.role === 'close' ? 'c' : ''}|${Math.round(st.width * 2) / 2}${earthSources.has(st) ? '|earth' : ''}`;
      let l = byW.get(k);
      if (!l) byW.set(k, (l = []));
      l.push(st.path);
    }
    const rankOf = (k: string): number => Number(k.split('|')[0].replace('v', ''));
    const sorted = [...byW.entries()].sort((a, b) => rankOf(b[0]) - rankOf(a[0]));
    for (const [k, src] of sorted) {
      const [rank, close, w, material] = k.split('|');
      const v = rank.startsWith('v');
      addLines((v ? 'vstreet-' : 'street-') + k, 'street', `r${v ? rank.slice(1) : rank}${material ? 'e' : ''}${close}`, Number(w), src);
    }
    if (ur.walls) {
      const towers: Polygon[] = [], gateTowers: Polygon[] = [];
      const byTh = new Map<number, Polyline[]>();
      for (const w of ur.walls) {
        const th = Math.round(w.thickness * 2) / 2;
        let l = byTh.get(th);
        if (!l) byTh.set(th, (l = []));
        if (w.pieces?.length) for (const pc of w.pieces) l.push(pc);
        else l.push(w.closed && w.path.length > 2 ? [...w.path, w.path[0]] : w.path);
        for (const p of w.towers) towers.push(ngon(p, w.thickness * 1.6, 12));
        for (const p of w.gateTowers ?? []) gateTowers.push(ngon(p, w.thickness * 1.45, 12));
      }
      for (const [th, src] of byTh) addLines('wall-' + th, 'wall', 'wall', th, src);
      addPoly('towers', towers);
      addPoly('gate-towers', gateTowers);
    }
  }

  const density = build.scope ? null : buildDensity(world);
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const furrows = furrowAreas.length ? { areas: furrowAreas, index: new TileIndex(S, tileSize, boxesOf(furrowAreas.map((a) => a.poly)), 'overlap') } : undefined;
  return { mapSize: S, tileSize, poly, lines, textures, furrows, density, counts, buildMs: t1 - t0, earthStreets: appearance.earthStreets };
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
