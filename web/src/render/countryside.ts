/** Rural ground restored under the fabric at exposed countryside edges, without changing urban geometry. */
import type { World, UrbanLayer, PolyH, Polygon, TerrainLayer } from '../gen/types';
import polygonClipping from 'polygon-clipping';
import { differenceSafeS, intersectionS, unionMany, mpArea, toGeom, fromGeom } from '../gen/geo/bool';
import { offsetRibbon, simplify } from '../gen/core/geom';
import { bboxOf, cleanRing, orientPos, isSimple } from '../gen/geo/poly';
import { seaWithIslands, pathD } from './util';
import type { Palette } from './styles';

/** Actual terrain-derived cover to replay inside unoccupied residential land; no cultivation. */
export const NATURAL_LAND_KINDS = ['meadow', 'marsh', 'pasture', 'commons', 'forest'] as const;

export const FRINGE_ALPHA = [0.98, 0.86, 0.72, 0.56, 0.4, 0.26, 0.14, 0.05] as const;
/** Nested regions paint from widest to narrowest; composited opacity keeps the target edge profile. */
export const FRINGE_PAINT = FRINGE_ALPHA.map((alpha, i) => {
  const below = FRINGE_ALPHA[i + 1] ?? 0;
  return (alpha - below) / (1 - below);
});
export const FRINGE_ORDER = FRINGE_ALPHA.map((_, i) => FRINGE_ALPHA.length - 1 - i);
export interface CountryFringe { bands: PolyH[][]; ground: PolyH[]; streets: UrbanLayer['streets'] }
const ph = (outer: Polygon): PolyH => ({ outer: orientPos(outer), holes: [] });
export const fringeStreetWidth = (width: number): number => Math.round(width * 2) / 2;
const protectedPieces = (u: UrbanLayer): PolyH[] => [
  ...u.parcels.filter((p) => p.use !== 'plot').map((p) => ph(p.poly)), ...u.backLand, ...(u.water ?? []),
  ...u.landmarks.map((l) => ph(l.poly)), ...u.squares.map(ph),
];
type Box = ReturnType<typeof bboxOf>;
const meets = (a: Box, b: Box): boolean => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
const grown = (b: Box, d: number): Box => ({ x0: b.x0 - d, y0: b.y0 - d, x1: b.x1 + d, y1: b.y1 + d });
const boxPolygon = (b: Box): PolyH => ph([{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 }]);
const finite = (p: Polygon): boolean => p.every((v) => Number.isFinite(v.x) && Number.isFinite(v.y));
const finiteShape = (shape: PolyH[]): boolean => shape.every((p) => finite(p.outer) && p.holes.every(finite));
// Overlapping corner pieces normalize faster in small balanced groups, without changing the buffer geometry.
const FRINGE_UNION_BATCH = 4;

/** Convex pieces have positive winding independently: tight bends and arms narrower than 2d cannot cancel. */
function boundaryPieces(ring0: Polygon, depth: number): PolyH[] {
  if (!finite(ring0)) return [];
  const ring = cleanRing(ring0, 0.005, 0.5, 0.002, false);
  const pieces: PolyH[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len <= 0.005 || !Number.isFinite(len)) continue;
    const nx = -dy * depth / len, ny = dx * depth / len;
    pieces.push(ph([{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }]));
    // Circumscribed 12-gon covers the radius-d join, with horizontal/vertical facets at exactly +/-d.
    // It stays in the existing edge-box prefilter, unlike square corners reaching sqrt(2)*d diagonally.
    const radius = depth / Math.cos(Math.PI / 12);
    pieces.push(ph(Array.from({ length: 12 }, (_, j) => {
      const angle = (j + 0.5) * Math.PI / 6;
      return { x: a.x + radius * Math.cos(angle), y: a.y + radius * Math.sin(angle) };
    })));
  }
  return pieces;
}
/** Original shapes and independent convex pieces form the exact protection, before bounded batch normalization. */
function paddingPieces(shape: PolyH[], depth: number): PolyH[] {
  return [...shape, ...shape.flatMap((p) => [p.outer, ...p.holes]).flatMap((ring) => boundaryPieces(ring, depth))];
}
/** Discard only pieces that cannot touch ground, then normalize in small batches before the final cut.
 * A huge overlapping operand would generate quadratic segment intersections inside one engine sweep.
 */
function normalizedPadding(pieces: PolyH[], edges: Box[]): PolyH[] {
  const relevant = pieces.filter((p) => { const box = bboxOf(p.outer); return edges.some((edge) => meets(edge, box)); });
  return unionMany(relevant, FRINGE_UNION_BATCH, true);
}
/** Overlapping local windows share one water clip, while every original footprint keeps its 200 m margin. */
function mergeWindows(windows: Box[]): Box[] {
  const result: Box[] = [];
  for (const window of windows) {
    let box = { ...window };
    for (let i = 0; i < result.length;) {
      const other = result[i];
      if (!meets(box, other)) { i++; continue; }
      box = { x0: Math.min(box.x0, other.x0), y0: Math.min(box.y0, other.y0),
        x1: Math.max(box.x1, other.x1), y1: Math.max(box.y1, other.y1) };
      result.splice(i, 1); i = 0;
    }
    result.push(box);
  }
  return result;
}
interface GroundBase { signature: string; footprint: PolyH[]; bands?: PolyH[][]; zone?: PolyH[]; edges: Box[]; padding?: PolyH[] }
const BASE_CACHE = new WeakMap<UrbanLayer, GroundBase>();
/** Full coordinate signatures invalidate in-place edits and also allow reuse through display/options clones. */
function groundBase(u: UrbanLayer, withBands = false): GroundBase {
  const source = u.footprintH.length ? u.footprintH : u.footprint.map(ph);
  const signature = JSON.stringify(source), cached = BASE_CACHE.get(u);
  if (cached?.signature === signature && (!withBands || cached.bands)) return cached;
  const footprint = cached?.signature === signature ? cached.footprint : finiteShape(source) ? unionMany(source, 24, true) : [];
  const depth = Math.max(16, Math.min(80, Math.sqrt(mpArea(footprint)) * 0.12));
  const shells = footprint.map((p) => p.outer);
  const edges = shells.flatMap((ring) => ring.map((p, i) => grown(bboxOf([p, ring[(i + 1) % ring.length]]), depth)));
  // Normalize in bounded batches: directly clipping thousands of overlapping pieces can exhaust the sweep-line queue.
  const zone = withBands ? intersectionS(footprint, unionMany(shells.flatMap((ring) => boundaryPieces(ring, depth)), FRINGE_UNION_BATCH, true)) : undefined;
  const classified = withBands ? shells.map((ring) => {
    // Only cosmetic alpha classification is simplified; small rings retain their exact appearance.
    const tolerance = Math.min(4, depth / 16);
    if (ring.length <= 64) return { ring, error: 0 };
    const candidate = simplify([...ring, ring[0]], tolerance).slice(0, -1);
    if (candidate.length < 3 || !isSimple(candidate)) return { ring, error: 0 };
    return { ring: orientPos(candidate), error: tolerance + 0.01 };
  }) : [];
  const bands = withBands ? FRINGE_ALPHA.map((_, i) => {
    if (i === FRINGE_ALPHA.length - 1) return zone!;
    const d = depth * (i + 1) / FRINGE_ALPHA.length;
    // RDP's error bound: growing by error covers the original border. Clipping to zone keeps the EXACT outer extent.
    return intersectionS(zone!, unionMany(classified.flatMap(({ ring, error }) => boundaryPieces(ring, d + error)), FRINGE_UNION_BATCH, true));
  }) : undefined;
  const base: GroundBase = { signature, footprint, bands, zone, edges,
    padding: cached?.signature === signature ? cached.padding : undefined };
  BASE_CACHE.set(u, base);
  return base;
}
interface WaterPiece { shape: PolyH; box: Box; windows?: Map<string, PolyH[]> }
interface WaterBase { signature: number; coordinates: string; pieces: WaterPiece[]; valid: boolean }
let waterRevision = 0;
const WATER_CACHE = new WeakMap<TerrainLayer, WaterBase>();
function waterBase(world: World): WaterBase {
  const t = world.terrain;
  const coordinates = JSON.stringify([world.mapSize, t.coastline, t.islands, t.lakes, t.rivers]);
  const cached = WATER_CACHE.get(t);
  if (cached?.coordinates === coordinates) return cached;
  const sea = seaWithIslands(t.coastline, t.islands);
  const water = [...sea.sea.map((outer, i) => ({ outer, holes: sea.holes[i] })), ...t.lakes.map(ph),
    ...t.rivers.filter((r) => r.path.length >= 2).map((r) => ph(offsetRibbon(r.path, r.width.map((w, i) =>
      Math.max(1.1 * world.mapSize / 1600, w * (r.main || r.edgeFed ? 1 : Math.min(1, 0.35 + 0.65 * i / 7))) + 3.4 * world.mapSize / 1600))))];
  const valid = finiteShape(water);
  const result = { signature: ++waterRevision, coordinates, valid, pieces: valid ? water.map((shape) => ({ shape, box: bboxOf(shape.outer) })) : [] };
  WATER_CACHE.set(t, result);
  return result;
}
/** intersectionS fails to empty: safe for painted bands, unsafe for a water protection. Propagate repeated failure. */
function waterWindow(shape: PolyH, window: Box): PolyH[] {
  const a = toGeom(shape), b = toGeom(boxPolygon(window));
  const snap = (g: ReturnType<typeof toGeom>, grid: number): ReturnType<typeof toGeom> =>
    g.map((p) => p.map((ring) => ring.map(([x, y]) => [Math.round(x * grid) / grid, Math.round(y * grid) / grid] as [number, number])));
  try { return fromGeom(polygonClipping.intersection(snap(a, 1000), snap(b, 1000))); }
  catch { return fromGeom(polygonClipping.intersection(snap(a, 20), snap(b, 20))); }
}
const streetTouches = (st: UrbanLayer['streets'][number], boxes: Box[], edges: Box[]): boolean => {
  if (st.path.length < 2) return false;
  const box = grown(bboxOf(st.path), Math.max(0.2, fringeStreetWidth(st.width) / 2 + 0.2));
  return edges.some((edge) => meets(edge, box)) && boxes.some((ground) => meets(ground, box));
};
interface FringeMask { signature: string; ground: PolyH[]; bands: PolyH[][] }
const MASK_CACHE = new WeakMap<UrbanLayer, FringeMask>();

/** Called on the original World: walls and render hints belong to each settlement, not its merged renderer view. */
function buildCountrysideFringe(world: World): CountryFringe {
  const result: CountryFringe = { bands: FRINGE_ALPHA.map(() => []), ground: [], streets: [] };
  const layers = [world.urban, ...(world.settlements ?? []).filter((s) => !s.main).map((s) => s.urban)]
    .filter((u): u is UrbanLayer => !!u);
  const eligible = layers.map((u) => !u.renderHints?.openGround && !u.renderHints?.stilts && !u.phases.some((p) => p.walled) &&
    !u.walls?.some((w) => !w.role || w.role === 'town' || w.role === 'outer') &&
    !u.lines?.some((l) => ['hedge', 'palisade', 'turf-wall', 'kraal-fence', 'albarrada'].includes(l.kind) && l.closed));
  if (!eligible.some(Boolean)) return result;
  const details = Object.values(world.megaDetail ?? {});
  const detailedGround = details.flatMap(protectedPieces);
  const water = waterBase(world);
  if (!water.valid) return result;
  const bases = layers.map((u, i) => groundBase(u, eligible[i]));
  const groundBoxes: Box[] = [], fringeEdges: Box[] = [];
  for (let layer = 0; layer < layers.length; layer++) {
    const u = layers[layer], base = bases[layer];
    if (!eligible[layer] || !base.zone?.length) continue;
    const windows = mergeWindows(base.footprint.map((p) => grown(bboxOf(p.outer), 200)));
    const boxes = base.footprint.map((p) => grown(bboxOf(p.outer), 80));
    // Reject far-away water/settlements BEFORE padding and deep interior lots BEFORE boolean cuts.
    const shores = water.pieces.map((piece, index) => ({ piece, index })).filter(({ piece }) => windows.some((b) => meets(b, piece.box)));
    const neighbours = bases.filter((b, i) => i !== layer && b.footprint.some((p) => boxes.some((box) => meets(box, bboxOf(p.outer)))));
    const protectedGround = [...protectedPieces(u), ...detailedGround, ...(u.macro?.quarters
      .filter((q) => q.kind !== 'quarter' || q.district === 'gardens').map((q) => ph(q.pts)) ?? [])]
      .filter((p) => { const box = bboxOf(p.outer); return base.edges.some((edge) => meets(edge, box)); });
    if (!finiteShape(protectedGround)) continue;
    const signature = JSON.stringify([base.signature, protectedGround, water.signature, shores.map((p) => p.index), windows, neighbours.map((b) => b.signature)]);
    let mask = MASK_CACHE.get(u);
    if (!mask || mask.signature !== signature) {
      const shorePadding = shores.flatMap(({ piece }) => windows.flatMap((window) => {
        if (!meets(window, piece.box)) return [];
        const key = JSON.stringify(window), cache = piece.windows ??= new Map<string, PolyH[]>();
        let pad = cache.get(key);
        if (!pad) {
          // Artificial clipping edges are 200 m away, farther than the full 80 m guard.
          pad = paddingPieces(waterWindow(piece.shape, window), 80);
          cache.set(key, pad);
        }
        // A piece whose box misses all original edge boxes cannot protect any point of the exact ground zone.
        return normalizedPadding(pad, base.edges);
      }));
      const urbanPadding = neighbours.flatMap((b) => normalizedPadding(b.padding ??= paddingPieces(b.footprint, 80), base.edges));
      // Cut protections once; intersect each nested edge region with the same surviving mask.
      const ground = differenceSafeS(base.zone, shorePadding, urbanPadding, protectedGround);
      const bands = base.bands!.map((band) => intersectionS(band, ground));
      mask = { signature, ground, bands }; MASK_CACHE.set(u, mask);
    }
    mask.bands.forEach((band, i) => { for (const p of band) result.bands[i].push(p); });
    const maskBoxes = mask.ground.map((p) => bboxOf(p.outer));
    for (const p of mask.ground) result.ground.push(p);
    for (const box of maskBoxes) groundBoxes.push(box);
    for (const edge of base.edges) fringeEdges.push(edge);
    for (const st of u.streets) if (streetTouches(st, maskBoxes, base.edges)) result.streets.push(st);
  }
  if (result.ground.length) for (const detail of details) for (const st of detail.streets) {
    if (streetTouches(st, groundBoxes, fringeEdges)) result.streets.push(st);
  }
  return result;
}

/** A decorative layer must never prevent an otherwise valid map from rendering. */
export function countrysideFringe(world: World): CountryFringe {
  try { return buildCountrysideFringe(world); }
  catch { return { bands: FRINGE_ALPHA.map(() => []), ground: [], streets: [] }; }
}

export const countryKind = (biome?: string): 'pasture' | 'commons' => biome === 'desert' || biome === 'tundra' ? 'commons' : 'pasture';
/** The same small, world-sized marks in SVG and Canvas; no trees that could obscure an urban plan. */
export function countryPatternSvg(pal: Palette): string {
  return `<pattern id="p-country-ground" patternUnits="userSpaceOnUse" width="26" height="20"><path d="M5 8l-1.2-2.4M5 8l1.2-2.4M18 17l-1.2-2.4M18 17l1.2-2.4" stroke="${pal.grass}" stroke-width="0.4" fill="none" stroke-linecap="round" opacity="0.6"/><circle cx="15" cy="5" r="0.55" fill="${pal.grass}" opacity="0.5"/></pattern>`;
}
export const fringePath = (pieces: PolyH[]): string => pieces.map((p) => pathD(p.outer, true) + p.holes.map((h) => pathD(h, true)).join('')).join('');
