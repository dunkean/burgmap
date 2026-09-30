/**
 * Interactive Canvas 2D renderer with level of detail (SVG stays for export).
 *
 * - The World is flattened once into a `Scene` (tile-indexed layers, see scene.ts).
 * - Per (layer, LOD band, tile) a Path2D is built lazily and cached; a frame only
 *   touches tiles intersecting the viewport, and only layers enabled by `selectLod`.
 * - The context transform is world->screen, so all widths are in meters; screen-space
 *   minimum widths are applied with `lineWidth(w, minPx, scale)`.
 * - Palettes come from styles.ts (read-only).
 * Everything DOM-ish is injectable (`CanvasRendererDeps`) so a mock 2D context can drive it in Node.
 */
import type { World, LandKind, Vec2 } from '../gen/types';
import type { StyleName } from '../gen/options';
import { PALETTES, Palette } from './styles';
import { renderTerrainRaster } from './raster';
import { buildScene, Scene, PolyLayer, LineLayer, TextureLayer, textureMarks, LAND_ORDER } from './scene';
import { selectLod, lineWidth, Lod, BAND_MIN_EDGE } from './lod';
import { View, viewRect, Rect4 } from './view';
import { Label, placeLabels } from './labels';
import { buildMapLabels, placeMapLabels, MapLabel, PlacedMapLabel, estimateWidth } from './mapLabels';
import { fontString, FONT_STACKS, KindStyle } from './labelStyles';
import { cartoucheModel, legendModel, drawPanelCanvas, Panel } from './legend';

export interface CanvasLike { width: number; height: number; getContext(id: '2d'): CanvasRenderingContext2D | null }

export interface CanvasRendererDeps {
  /** Path2D constructor (default: global). */
  Path2D?: new () => Path2D;
  /** Offscreen canvas factory (default: OffscreenCanvas / document canvas). Return null if unavailable. */
  createCanvas?: (w: number, h: number) => CanvasLike | null;
  /** Terrain bitmap provider (default: hillshade raster). Return null to skip terrain. */
  terrain?: (world: World, pal: Palette) => CanvasImageSource | null;
  dpr?: number;
  now?: () => number;
  tileSize?: number;
  /** Pre-built scene (avoids rebuilding when only the style changes). */
  scene?: Scene;
}

export interface FrameStats {
  band: number; scale: number; ms: number;
  tilesDrawn: number; bigDrawn: number; pathsBuilt: number; pathCache: number;
  buildingsCandidate: number; buildingsDrawn: boolean; textureTiles: number;
}

export interface Overlays { labels: boolean; legend: boolean; cartouche: boolean }

export interface CanvasRenderer {
  scene: Scene;
  palette: Palette;
  draw(view: View): FrameStats;
  setLabels(labels: Label[]): void;
  /** Toggle the name labels, the legend and the cartouche (defaults: labels per world.options.labels, legend per world.options.legend, cartouche on). */
  setOverlays(o: Partial<Overlays>): void;
  /** Labels placed in the last frame (debug / tests). */
  lastPlaced(): PlacedMapLabel[];
  drawMinimap(target: CanvasLike, view: View, viewW: number, viewH: number): void;
  lastStats(): FrameStats;
  dispose(): void;
}

const BUILDING_BUDGET_FULL = 120_000;
const BUILDING_BUDGET_MAX = 450_000;
const CACHE_MAX = 8000;
const TAU = Math.PI * 2;

interface TexSpec { sp: number; shape: 'circle' | 'tuft' | 'reed' | 'dot'; r: number; fill?: keyof Palette; stroke: keyof Palette; alpha: number }
const TEX: Record<string, TexSpec> = {
  forest: { sp: 9, shape: 'circle', r: 3.1, fill: 'treeFill', stroke: 'treeInk', alpha: 0.95 },
  orchard: { sp: 11, shape: 'circle', r: 2.3, fill: 'treeFill', stroke: 'orchardDot', alpha: 0.95 },
  meadow: { sp: 16, shape: 'tuft', r: 3, stroke: 'grass', alpha: 0.9 },
  pasture: { sp: 24, shape: 'tuft', r: 2.4, stroke: 'grass', alpha: 0.8 },
  marsh: { sp: 15, shape: 'reed', r: 3.2, stroke: 'reed', alpha: 0.9 },
  commons: { sp: 18, shape: 'dot', r: 0.7, fill: 'grass', stroke: 'grass', alpha: 0.75 },
};
const TEX_SALT: Record<string, number> = { forest: 11, orchard: 23, meadow: 37, pasture: 41, marsh: 53, commons: 67 };

type PathMap = Map<string, Path2D | null>;

function polyPath(P: new () => Path2D, l: PolyLayer, ids: ArrayLike<number>, minEdge: number): Path2D | null {
  const path = new P();
  const e2 = minEdge * minEdge;
  let any = false;
  for (let n = 0; n < ids.length; n++) {
    const i = ids[n];
    const rings: Vec2[][] = [l.polys[i]];
    const h = l.holes?.[i];
    if (h) for (const x of h) rings.push(x);
    for (const pts of rings) {
      if (pts.length < 3) continue;
      let lx = pts[0].x, ly = pts[0].y, kept = 1;
      path.moveTo(lx, ly);
      for (let k = 1; k < pts.length; k++) {
        const p = pts[k];
        const dx = p.x - lx, dy = p.y - ly;
        if (e2 > 0 && dx * dx + dy * dy < e2 && k < pts.length - 1) continue;
        path.lineTo(p.x, p.y); lx = p.x; ly = p.y; kept++;
      }
      path.closePath();
      if (kept >= 3) any = true;
    }
  }
  return any ? path : null;
}

function linePath(P: new () => Path2D, l: LineLayer, ids: ArrayLike<number>, minEdge: number): Path2D | null {
  const path = new P();
  const e2 = minEdge * minEdge;
  let any = false;
  for (let n = 0; n < ids.length; n++) {
    const pts = l.lines[ids[n]];
    if (pts.length < 2) continue;
    let lx = pts[0].x, ly = pts[0].y;
    path.moveTo(lx, ly);
    for (let k = 1; k < pts.length; k++) {
      const p = pts[k];
      const dx = p.x - lx, dy = p.y - ly;
      if (e2 > 0 && dx * dx + dy * dy < e2 && k < pts.length - 1) continue;
      path.lineTo(p.x, p.y); lx = p.x; ly = p.y;
    }
    any = true;
  }
  return any ? path : null;
}

function defaultCreateCanvas(w: number, h: number): CanvasLike | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h) as unknown as CanvasLike;
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return null;
}

export function createCanvasRenderer(canvas: CanvasLike, world: World, style: StyleName | Palette, deps: CanvasRendererDeps = {}): CanvasRenderer {
  const pal: Palette = typeof style === 'string' ? PALETTES[style] : style;
  const scene = deps.scene ?? buildScene(world, deps.tileSize);
  const S = world.mapSize;
  const now = deps.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const P: new () => Path2D = deps.Path2D ?? (globalThis as unknown as { Path2D: new () => Path2D }).Path2D;
  const makeCanvas = deps.createCanvas ?? defaultCreateCanvas;
  const u = S / 1600; // same unit as svg.ts, used for a few decorative widths

  const cache: PathMap = new Map();
  let built = 0;
  let labels: Label[] = [];
  const overlays: Overlays = { labels: world.options.labels !== false, legend: !!world.options.legend, cartouche: true };
  const mapLabels: MapLabel[] = buildMapLabels(world, pal.name, pal);
  const family = FONT_STACKS[pal.name] ?? pal.fontFamily;
  const widthCache = new Map<string, number>();
  let placedLast: PlacedMapLabel[] = [];
  let legendPanel: Panel | null = null;
  let terrainImg: CanvasImageSource | null | undefined;
  let densityImg: CanvasImageSource | null | undefined;
  const patterns = new Map<string, CanvasPattern | null>();
  let stats: FrameStats = { band: 0, scale: 0, ms: 0, tilesDrawn: 0, bigDrawn: 0, pathsBuilt: 0, pathCache: 0, buildingsCandidate: 0, buildingsDrawn: false, textureTiles: 0 };

  const polyL = (n: string): PolyLayer | undefined => scene.poly.get(n);
  const linesOf = (pred: (l: LineLayer) => boolean): LineLayer[] => scene.lines.filter(pred);

  function cached(key: string, make: () => Path2D | null): Path2D | null {
    let p = cache.get(key);
    if (p === undefined) {
      p = make(); built++;
      cache.set(key, p);
      if (cache.size > CACHE_MAX) {
        let drop = CACHE_MAX >> 2;
        for (const k of cache.keys()) { cache.delete(k); if (--drop <= 0) break; }
      }
    }
    return p;
  }

  // ---- offscreen bitmaps -------------------------------------------------------------
  function toBitmap(rgba: Uint8ClampedArray, w: number, h: number): CanvasImageSource | null {
    const c = makeCanvas(w, h);
    const cx = c?.getContext('2d');
    if (!c || !cx || typeof ImageData === 'undefined') return null;
    cx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer), w, h), 0, 0);
    return c as unknown as CanvasImageSource;
  }
  function getTerrain(): CanvasImageSource | null {
    if (terrainImg !== undefined) return terrainImg;
    try {
      if (deps.terrain) terrainImg = deps.terrain(world, pal);
      else {
        const r = renderTerrainRaster(world, pal);
        if (r.rgb) {
          const rgba = new Uint8ClampedArray(r.w * r.h * 4);
          for (let i = 0, j = 0; i < r.w * r.h; i++, j += 4) { rgba[j] = r.rgb[i * 3]; rgba[j + 1] = r.rgb[i * 3 + 1]; rgba[j + 2] = r.rgb[i * 3 + 2]; rgba[j + 3] = 255; }
          terrainImg = toBitmap(rgba, r.w, r.h);
        } else terrainImg = null;
      }
    } catch { terrainImg = null; }
    return terrainImg;
  }
  /** Tiling pattern (tile of `tw` x `th` meters drawn at 14 px/m, rotated `rot` degrees); null where canvases/DOMMatrix are unavailable (Node). */
  function getPattern(ctx: CanvasRenderingContext2D, key: string, tw: number, th: number, rot: number, draw: (c: CanvasRenderingContext2D, k: number) => void): CanvasPattern | null {
    let p = patterns.get(key);
    if (p !== undefined) return p;
    p = null;
    try {
      const k = 14;
      const c = makeCanvas(Math.ceil(tw * k), Math.ceil(th * k));
      const cx = c?.getContext('2d');
      if (c && cx && typeof DOMMatrix !== 'undefined') {
        cx.lineCap = 'round';
        draw(cx, k);
        p = ctx.createPattern(c as unknown as CanvasImageSource, 'repeat');
        p?.setTransform(new DOMMatrix().rotate(rot).scale(1 / k));
      }
    } catch { p = null; }
    patterns.set(key, p ?? null);
    return p ?? null;
  }
  function getDensity(): CanvasImageSource | null {
    if (densityImg !== undefined) return densityImg;
    densityImg = null;
    const d = scene.density;
    if (!d) return null;
    const m = /^#([0-9a-f]{6})$/i.exec(pal.ink);
    const v = m ? parseInt(m[1], 16) : 0x3d2f20;
    const rgba = new Uint8ClampedArray(d.w * d.h * 4);
    for (let i = 0; i < d.cov.length; i++) {
      const c = d.cov[i];
      rgba[i * 4] = (v >> 16) & 255; rgba[i * 4 + 1] = (v >> 8) & 255; rgba[i * 4 + 2] = v & 255;
      rgba[i * 4 + 3] = Math.round(255 * Math.min(0.5, Math.sqrt(c) * 0.62));
    }
    densityImg = toBitmap(rgba, d.w, d.h);
    return densityImg;
  }

  // ---- frame ---------------------------------------------------------------------------
  function draw(view: View): FrameStats {
    const t0 = now();
    const ctx = canvas.getContext('2d');
    if (!ctx) return stats;
    const built0 = built;
    const dpr = deps.dpr ?? (globalThis as unknown as { devicePixelRatio?: number }).devicePixelRatio ?? 1;
    const cssW = canvas.width / dpr, cssH = canvas.height / dpr;
    const sc = view.scale;
    const lod: Lod = selectLod(sc);
    const band = lod.band;
    const rect: Rect4 = viewRect(view, cssW, cssH, 0);
    const fs: FrameStats = { band, scale: sc, ms: 0, tilesDrawn: 0, bigDrawn: 0, pathsBuilt: 0, pathCache: 0, buildingsCandidate: 0, buildingsDrawn: false, textureTiles: 0 };
    const minEdge = BAND_MIN_EDGE[band];

    // background (device pixels)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = pal.paper;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // world -> device
    ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * (cssW / 2 - view.cx * sc), dpr * (cssH / 2 - view.cy * sc));
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.setLineDash([]);

    const px = (n: number): number => n / sc;
    const lw = (w: number, minPx: number): number => lineWidth(w, minPx, sc);

    // helpers ---------------------------------------------------------------------------
    const polyPaths = (l: PolyLayer): Path2D[] => {
      const out: Path2D[] = [];
      for (const t of l.index.tilesInRect(rect)) {
        const p = cached(`${l.name}|${band}|t${t}`, () => polyPath(P, l, l.index.itemsOf(t), minEdge));
        if (p) { out.push(p); fs.tilesDrawn++; }
      }
      for (const i of l.index.bigInRect(rect)) {
        const p = cached(`${l.name}|${band}|b${i}`, () => polyPath(P, l, [i], minEdge));
        if (p) { out.push(p); fs.bigDrawn++; }
      }
      return out;
    };
    const linePaths = (l: LineLayer): Path2D[] => {
      const out: Path2D[] = [];
      for (const t of l.index.tilesInRect(rect)) {
        const p = cached(`${l.name}|${band}|t${t}`, () => linePath(P, l, l.index.itemsOf(t), minEdge));
        if (p) { out.push(p); fs.tilesDrawn++; }
      }
      for (const i of l.index.bigInRect(rect)) {
        const p = cached(`${l.name}|${band}|b${i}`, () => linePath(P, l, [i], minEdge));
        if (p) { out.push(p); fs.bigDrawn++; }
      }
      return out;
    };
    const fillPolys = (name: string, color: string, alpha = 1, rule: CanvasFillRule = 'evenodd'): PolyLayer | undefined => {
      const l = polyL(name);
      if (!l) return undefined;
      ctx.fillStyle = color; ctx.globalAlpha = alpha;
      for (const p of polyPaths(l)) ctx.fill(p, rule);
      ctx.globalAlpha = 1;
      return l;
    };
    const strokePolys = (name: string, color: string, width: number, alpha = 1, dash: number[] = []): void => {
      const l = polyL(name);
      if (!l) return;
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha = alpha; ctx.setLineDash(dash);
      for (const p of polyPaths(l)) ctx.stroke(p);
      ctx.globalAlpha = 1; ctx.setLineDash([]);
    };
    const strokeLines = (ls: LineLayer[], color: string, widthOf: (l: LineLayer) => number, alpha = 1, dash: number[] = [], cap: CanvasLineCap = 'round'): void => {
      ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.setLineDash(dash); ctx.lineCap = cap;
      for (const l of ls) {
        ctx.lineWidth = widthOf(l);
        for (const p of linePaths(l)) ctx.stroke(p);
      }
      ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.lineCap = 'round';
    };
    const edge = Math.max(0.5, 0.9 / sc);
    /** Casing + fill for a group of road-like layers (all casings first so junctions merge). */
    const roadGroup = (ls: LineLayer[], fillMinPx: (l: LineLayer) => number): void => {
      if (!ls.length) return;
      strokeLines(ls, pal.roadEdge, (l) => lw(l.width, fillMinPx(l)) + 2 * edge);
      strokeLines(ls, pal.roadFill, (l) => lw(l.width, fillMinPx(l)));
    };

    // 1. terrain
    const tex = getTerrain();
    if (tex) {
      ctx.imageSmoothingEnabled = true;
      (ctx as { imageSmoothingQuality?: string }).imageSmoothingQuality = 'high';
      ctx.drawImage(tex, 0, 0, S, S);
    }

    // 2. land use (tints multiply over the hillshade so relief reads through them); contours under it
    const luOn = world.options.landuse;
    const luAlpha = pal.landOpacity;
    const multiply = (on: boolean): void => { ctx.globalCompositeOperation = on ? 'multiply' : 'source-over'; };
    if (world.options.contours) {
      for (const l of linesOf((x) => x.role === 'contour')) {
        const idx = l.kind === 'index';
        strokeLines([l], pal.contour, () => (idx ? 1.2 : 0.7) / sc, idx ? pal.contourOpacity : pal.contourOpacity * 0.7);
      }
    }
    for (const kind of LAND_ORDER) {
      if (!luOn) break;
      const name = 'lu-' + kind;
      if (!polyL(name)) continue;
      multiply(true);
      fillPolys(name, pal.land[kind], kind === 'forest' ? 0.7 : luAlpha);
      if (kind === 'field' && lod.strips) {
        fillPolys('stripA', pal.stripA, 0.55);
        fillPolys('stripB', pal.stripB, 0.5);
      }
      multiply(false);
      if (kind === 'field' && lod.strips && lod.band >= 2) {
        strokePolys('stripA', pal.furrow, lw(0.28, 0.5), 0.5);
        strokePolys('stripB', pal.furrow, lw(0.28, 0.5), 0.5);
      }
      if (kind === 'forest' && lod.strips) strokePolys(name, pal.treeInk, lw(0.7, 0.8), 0.5);
      if ((kind === 'orchard' || kind === 'garden') && lod.strips) strokePolys(name, pal.hedge, lw(0.8, 0.8), 0.7);
      if (kind === 'field' && lod.band >= 2) strokePolys(name, pal.hedge, lw(0.9, 0.9), 0.75, [px(4 * 1.3), px(1.6)]);
    }
    // textures (procedural marks, visible tiles only, cached per tile)
    if (lod.textures && luOn) {
      for (const tl of scene.textures) fs.textureTiles += drawTexture(ctx, tl, rect, band, lw);
    }

    // 3. rivers + water
    const rivers = polyL('rivers');
    if (rivers) {
      const paths = polyPaths(rivers);
      ctx.fillStyle = pal.riverEdge; ctx.strokeStyle = pal.riverEdge; ctx.lineWidth = lw(1.7 * u, 1.2);
      for (const p of paths) { ctx.fill(p, 'nonzero'); ctx.stroke(p); }
      ctx.fillStyle = pal.riverFill;
      for (const p of paths) ctx.fill(p, 'nonzero');
      if (sc < 0.08) strokeLines(linesOf((l) => l.name === 'river-centre'), pal.riverEdge, () => px(1.3));
    }
    fillPolys('sea', pal.seaFill, 1, 'evenodd');
    strokePolys('sea', pal.waterEdge, lw(1.5 * u, 1.2));
    fillPolys('lakes', pal.lakeFill, 1, 'nonzero');
    strokePolys('lakes', pal.waterEdge, lw(1.3 * u, 1.1));

    // 4. regional roads + farmsteads
    if (lod.farmsteads && polyL('farm-yards')) {
      strokeLines(linesOf((l) => l.role === 'drive'), pal.trackFill, (l) => lw(l.width, 1), 0.7, [], 'butt');
      fillPolys('farm-yards', pal.farmYard, 0.9);
      strokePolys('farm-yards', pal.farmInk, lw(0.5, 0.5), 1, [px(3), px(2)]);
      fillPolys('farm-buildings', pal.farmRoof);
      strokePolys('farm-buildings', pal.farmInk, lw(0.7, 0.6));
    }
    const roads = linesOf((l) => l.role === 'road' && l.kind !== 'track' && (lod.minorRoads || l.kind === 'major'));
    roadGroup(roads, (l) => (l.kind === 'major' ? 1.6 : 1.1));
    const tracks = linesOf((l) => l.role === 'road' && l.kind === 'track' && lod.minorRoads);
    strokeLines(tracks, pal.roadEdge, (l) => lw(l.width * 0.5, 1), 0.85, [px(lod.band ? 7 : 5), px(lod.band ? 4 : 3)], 'butt');

    // 5. urban
    const U = pal.urban;
    const uStreets = linesOf((l) => l.role === 'street');
    const mainsOf = (maxRank: number): LineLayer[] => uStreets.filter((l) => Number(l.kind.slice(1, 2)) <= maxRank && !l.kind.endsWith('c'));
    if (lod.densityAlpha > 0) {
      const dimg = getDensity();
      if (dimg) {
        ctx.globalAlpha = 0.9 * lod.densityAlpha;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(dimg, 0, 0, S, S);
        ctx.globalAlpha = 1;
      }
      if (polyL('footprint')) {
        fillPolys('footprint', pal.ink, 0.07 * lod.densityAlpha);
        strokePolys('footprint', pal.inkSoft, lw(1, 1), 0.55 * lod.densityAlpha, [px(7), px(5)]);
      }
    }
    if (!lod.blocks) {
      // far: arterial and primary streets only, as thin cased lines
      roadGroup(mainsOf(1), (l) => (l.kind.startsWith('r0') ? 1.8 : 1.2));
    } else {
      // street space = the quarters; blocks, places and masses are laid on top
      fillPolys('u-streets', U.street, 1, 'nonzero');
      strokePolys('u-streets', U.street, 0.4);
      const near = lod.band >= 2;
      const paved = (name: string, base: string, pat: CanvasPattern | null, patAlpha = 1): void => {
        fillPolys(name, base);
        if (near && pat) {
          const l = polyL(name);
          if (l) { ctx.fillStyle = pat; ctx.globalAlpha = patAlpha; for (const p of polyPaths(l)) ctx.fill(p, 'evenodd'); ctx.globalAlpha = 1; }
        }
      };
      const pave = near ? getPattern(ctx, 'pave', 3, 3, 0, (c, k) => { c.globalAlpha = 0.55; c.fillStyle = U.placeInk; c.beginPath(); c.arc(1.5 * k, 1.5 * k, 0.28 * k, 0, TAU); c.fill(); }) : null;
      const gardenPat = near ? getPattern(ctx, 'garden', 6, 6, 28, (c, k) => {
        c.globalAlpha = 0.7; c.strokeStyle = U.gardenInk; c.lineWidth = 0.35 * k;
        c.beginPath(); c.moveTo(0.6 * k, 1.5 * k); c.lineTo(3.4 * k, 1.5 * k); c.moveTo(3.2 * k, 4.5 * k); c.lineTo(5.6 * k, 4.5 * k); c.stroke();
      }) : null;
      const gravePat = near ? getPattern(ctx, 'grave', 5, 4, 0, (c, k) => {
        c.globalAlpha = 0.8; c.strokeStyle = U.gardenInk; c.lineWidth = 0.25 * k;
        c.beginPath(); c.moveTo(1.2 * k, 1.2 * k); c.lineTo(1.2 * k, 2.8 * k); c.moveTo(0.6 * k, 1.8 * k); c.lineTo(1.8 * k, 1.8 * k);
        c.moveTo(3.7 * k, 3.1 * k); c.lineTo(3.7 * k, 3.9 * k); c.moveTo(3.3 * k, 3.4 * k); c.lineTo(4.1 * k, 3.4 * k); c.stroke();
      }) : null;
      paved('u-places', U.place, pave);
      paved('u-greens', U.garden, gardenPat, 0.6);
      paved('u-yards', U.garden, gravePat);
      fillPolys('u-blocks', U.yard);
      paved('u-backland', U.garden, gardenPat);
      // building masses (courtyards are holes -> evenodd), with a soft drop shadow when zoomed in
      const masses = polyL('u-masses');
      if (lod.buildings && masses) {
        let cand = 0;
        for (const t of masses.index.tilesInRect(rect)) cand += masses.index.tileStart[t + 1] - masses.index.tileStart[t];
        cand += masses.index.bigInRect(rect).length;
        fs.buildingsCandidate = cand;
        if (cand <= BUILDING_BUDGET_MAX) {
          fs.buildingsDrawn = true;
          const paths = polyPaths(masses);
          if (lod.shadows && cand <= BUILDING_BUDGET_FULL) {
            ctx.save(); ctx.translate(1.4, 1.7);
            ctx.fillStyle = 'rgba(0,0,0,0.2)';
            for (const p of paths) ctx.fill(p, 'evenodd');
            ctx.restore();
          }
          ctx.fillStyle = U.mass;
          for (const p of paths) ctx.fill(p, 'evenodd');
          if (cand <= BUILDING_BUDGET_FULL) {
            ctx.strokeStyle = U.massEdge; ctx.lineWidth = lw(0.3, 0.3);
            for (const p of paths) ctx.stroke(p);
          }
        }
      }
      // churches: distinct outlined mass with a cross
      if (polyL('u-church')) {
        fillPolys('u-church', U.landmark);
        strokePolys('u-church', U.mass, lw(0.8, 0.6));
        if (lod.band >= 2) strokeLines(linesOf((l) => l.role === 'cross'), U.mass, (l) => lw(l.width, 0.6));
      }
      // plot hairlines: a dark pass (reads on yards) and a light pass (reads on roofs)
      if (lod.parcels) {
        strokePolys('u-plots', U.plotLine, lw(0.14, 0.4), 0.45);
        strokePolys('u-plots', U.massEdge, lw(0.14, 0.4), 0.28);
      }
      // hierarchy: arterial / primary streets keep a legible minimum width in street colour
      const minPx = (l: LineLayer): number => (l.kind.startsWith('r0') ? 2.6 : l.kind.startsWith('r1') ? 1.8 : 1.0);
      const thin = mainsOf(lod.band === 1 ? 2 : 1).filter((l) => l.width * sc < minPx(l));
      strokeLines(thin, U.street, (l) => minPx(l) / sc);
      strokePolys('block-edges', U.blockEdge, lw(0.4, 0.3));
      if (polyL('landmarks') && near) strokePolys('landmarks', U.landmark, lw(0.6, 0.6), 0.5, [px(5), px(3)]);
    }
    // walls: casing + fill (stretches between gate openings), towers and gate towers
    const walls = linesOf((l) => l.role === 'wall');
    for (const l of walls) strokeLines([l], U.wall, () => Math.max(l.width + 1.4, 3 / sc), 1, [], 'butt');
    for (const l of walls) strokeLines([l], U.wallFill, () => Math.max(0.6, l.width - 1, 1.5 / sc), 1, [], 'butt');
    if (walls.length && lod.towers) {
      for (const name of ['towers', 'gate-towers']) {
        fillPolys(name, U.wallFill);
        strokePolys(name, U.wall, lw(0.9, 0.8));
      }
    }

    // 6. bridges
    if (world.bridges?.length) drawBridges(ctx, world, pal, rect, sc);
    // site marker (placeholder until an urban layer exists)
    if (!world.urban && world.site) drawSiteMarker(ctx, world, pal, u, sc);

    // 7. map frame
    ctx.strokeStyle = pal.frame; ctx.lineWidth = lw(2 * u, 1.5); ctx.setLineDash([]);
    ctx.strokeRect(0, 0, S, S);

    // 8. labels, cartouche, legend (screen space)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (labels.length) {
      const measure = (text: string, size: number): number => {
        ctx.font = `${size}px ${pal.fontFamily}`;
        return ctx.measureText(text).width;
      };
      const placed = placeLabels(labels, view, cssW, cssH, measure);
      ctx.textBaseline = 'top'; ctx.lineJoin = 'round';
      for (const pl of placed) {
        const size = pl.label.size ?? 12;
        ctx.font = `${size}px ${pal.fontFamily}`;
        ctx.lineWidth = 3; ctx.strokeStyle = pal.paper; ctx.globalAlpha = 0.85;
        ctx.strokeText(pl.label.text, pl.x, pl.y);
        ctx.globalAlpha = 1; ctx.fillStyle = pl.label.color ?? pal.ink;
        ctx.fillText(pl.label.text, pl.x, pl.y);
      }
    }
    placedLast = [];
    if (overlays.labels && mapLabels.length) {
      const measure = (text: string, size: number, st: KindStyle): number => {
        const key = `${st.italic ? 'i' : ''}${st.bold ? 'b' : ''}|${Math.round(size * 10)}|${text}`;
        let w = widthCache.get(key);
        if (w === undefined) {
          ctx.font = fontString(st, Math.round(size * 10) / 10, family);
          w = ctx.measureText(text).width;
          if (widthCache.size > 20000) widthCache.clear();
          widthCache.set(key, w);
        }
        return w;
      };
      placedLast = placeMapLabels(mapLabels, view, cssW, cssH, measure);
      drawMapLabels(ctx, placedLast, pal, family);
    }
    if (overlays.cartouche) drawPanelCanvas(ctx, cartoucheModel(world, pal, sc), 12, 12, family);
    if (overlays.legend) {
      legendPanel ??= legendModel(world, pal);
      drawPanelCanvas(ctx, legendPanel, 12, Math.max(12, cssH - legendPanel.h - 34), family);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    fs.pathsBuilt = built - built0;
    fs.pathCache = cache.size;
    fs.ms = now() - t0;
    stats = fs;
    return fs;
  }

  function drawTexture(ctx: CanvasRenderingContext2D, tl: TextureLayer, rect: Rect4, band: number, lw: (w: number, m: number) => number): number {
    const spec = TEX[tl.kind];
    if (!spec) return 0;
    const tiles = tl.index.tilesInRect(rect);
    if (tiles.length > 500) return 0;
    const fillP: Path2D[] = [], strokeP: Path2D[] = [];
    for (const t of tiles) {
      const key = `tex-${tl.kind}|${band}|t${t}`;
      const p = cached(key, () => {
        const marks = textureMarks(tl, t, spec.sp, TEX_SALT[tl.kind] ?? 1);
        if (!marks.length) return null;
        const path = new P();
        for (const m of marks) {
          const r = spec.r * m.r;
          if (spec.shape === 'circle') { path.moveTo(m.x + r, m.y); path.arc(m.x, m.y, r, 0, TAU); }
          else if (spec.shape === 'dot') { path.moveTo(m.x + r, m.y); path.arc(m.x, m.y, r, 0, TAU); }
          else if (spec.shape === 'tuft') {
            path.moveTo(m.x, m.y); path.lineTo(m.x - r * 0.45, m.y - r);
            path.moveTo(m.x, m.y); path.lineTo(m.x, m.y - r * 1.1);
            path.moveTo(m.x, m.y); path.lineTo(m.x + r * 0.45, m.y - r);
          } else {
            path.moveTo(m.x - r * 0.8, m.y); path.lineTo(m.x + r * 0.8, m.y);
            path.moveTo(m.x, m.y); path.lineTo(m.x, m.y - r);
          }
        }
        return path;
      });
      if (p) { strokeP.push(p); if (spec.fill) fillP.push(p); }
    }
    if (spec.fill) {
      ctx.globalAlpha = spec.alpha; ctx.fillStyle = pal[spec.fill] as string;
      for (const p of fillP) ctx.fill(p, 'nonzero');
    }
    ctx.globalAlpha = spec.alpha; ctx.strokeStyle = pal[spec.stroke] as string;
    ctx.lineWidth = lw(spec.shape === 'circle' ? 0.5 : 0.55, 0.6);
    for (const p of strokeP) ctx.stroke(p);
    ctx.globalAlpha = 1;
    return tiles.length;
  }

  function drawMinimap(target: CanvasLike, view: View, viewW: number, viewH: number): void {
    const ctx = target.getContext('2d');
    if (!ctx) return;
    const k = target.width / S;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = pal.paper;
    ctx.fillRect(0, 0, target.width, target.height);
    const tex = getTerrain();
    if (tex) ctx.drawImage(tex, 0, 0, target.width, target.width);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const water = (name: string, fill: string, rule: CanvasFillRule = 'nonzero'): void => {
      const l = polyL(name);
      if (!l) return;
      ctx.fillStyle = fill;
      for (const t of l.index.tilesInRect({ minX: 0, minY: 0, maxX: S, maxY: S })) {
        const p = cached(`${l.name}|0|t${t}`, () => polyPath(P, l, l.index.itemsOf(t), BAND_MIN_EDGE[0]));
        if (p) ctx.fill(p, rule);
      }
      for (const i of l.index.big) {
        const p = cached(`${l.name}|0|b${i}`, () => polyPath(P, l, [i], BAND_MIN_EDGE[0]));
        if (p) ctx.fill(p, rule);
      }
    };
    water('sea', pal.seaFill, 'evenodd'); water('lakes', pal.lakeFill); water('rivers', pal.riverFill);
    const d = getDensity();
    if (d) ctx.drawImage(d, 0, 0, S, S);
    const r = viewRect(view, viewW, viewH, 0);
    ctx.strokeStyle = pal.marker; ctx.lineWidth = 1.5 / k;
    ctx.strokeRect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  return {
    scene, palette: pal,
    draw,
    setLabels(l: Label[]) { labels = l; },
    setOverlays(o: Partial<Overlays>) { Object.assign(overlays, o); },
    lastPlaced: () => placedLast,
    drawMinimap,
    lastStats: () => stats,
    dispose() { cache.clear(); terrainImg = densityImg = undefined; },
  };
}

/** Glyph-by-glyph label painting (halo first): handles straight, letter-spaced, small-cap and curved text alike. */
function drawMapLabels(ctx: CanvasRenderingContext2D, placed: PlacedMapLabel[], pal: Palette, family: string): void {
  ctx.lineJoin = 'round'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const pl of placed) {
    const st = pl.label.st;
    const halo = Math.max(2.4, pl.size * 0.26);
    const curved = pl.glyphs.some((g) => g.a !== 0);
    for (const pass of [0, 1] as const) {
      ctx.globalAlpha = pass === 0 ? 0.8 : 1;
      ctx.strokeStyle = pal.paper; ctx.fillStyle = st.color; ctx.lineWidth = halo;
      let lastSize = -1;
      for (const g of pl.glyphs) {
        if (g.ch === ' ') continue;
        if (g.size !== lastSize) { ctx.font = fontString(st, Math.round(g.size * 10) / 10, family); lastSize = g.size; }
        if (curved) {
          ctx.save(); ctx.translate(g.x, g.y); ctx.rotate(g.a);
          if (pass === 0) ctx.strokeText(g.ch, 0, 0); else ctx.fillText(g.ch, 0, 0);
          ctx.restore();
        } else if (pass === 0) ctx.strokeText(g.ch, g.x, g.y); else ctx.fillText(g.ch, g.x, g.y);
      }
    }
    ctx.globalAlpha = 1;
    if (pl.symbol) {
      const { x, y, r } = pl.symbol;
      ctx.lineWidth = 1.1; ctx.strokeStyle = st.color; ctx.fillStyle = st.color;
      ctx.beginPath();
      switch (st.symbol) {
        case 'cross': ctx.moveTo(x, y - r * 1.25); ctx.lineTo(x, y + r * 1.25); ctx.moveTo(x - r * 0.85, y - r * 0.3); ctx.lineTo(x + r * 0.85, y - r * 0.3); ctx.lineWidth = 1.6; ctx.stroke(); break;
        case 'tri': ctx.moveTo(x, y - r * 1.1); ctx.lineTo(x + r * 1.1, y + r * 0.8); ctx.lineTo(x - r * 1.1, y + r * 0.8); ctx.closePath(); ctx.fill(); break;
        case 'square': ctx.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8); ctx.fill(); break;
        case 'ring': ctx.arc(x, y, r * 0.85, 0, TAU); ctx.fillStyle = pal.paper; ctx.fill(); ctx.stroke(); break;
        default: ctx.arc(x, y, r, 0, TAU); ctx.fill(); ctx.strokeStyle = pal.paper; ctx.lineWidth = 1; ctx.stroke();
      }
    }
  }
  ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
}
void estimateWidth;

function drawBridges(ctx: CanvasRenderingContext2D, world: World, pal: Palette, rect: Rect4, sc: number): void {
  const s = Math.max(1, (world.mapSize / 1600) * 0.85);
  for (const b of world.bridges ?? []) {
    if (Math.max(b.a.x, b.b.x) < rect.minX || Math.min(b.a.x, b.b.x) > rect.maxX || Math.max(b.a.y, b.b.y) < rect.minY || Math.min(b.a.y, b.b.y) > rect.maxY) continue;
    const dx = b.b.x - b.a.x, dy = b.b.y - b.a.y, l = Math.hypot(dx, dy) || 1;
    const tx = dx / l, ty = dy / l, nx = -ty, ny = tx, pad = 1.5 * s;
    const h = (Math.max(b.width * s + 1, 2 / sc)) / 2;
    const ax = b.a.x - tx * pad, ay = b.a.y - ty * pad, bx = b.b.x + tx * pad, by = b.b.y + ty * pad;
    ctx.beginPath();
    ctx.moveTo(ax + nx * h, ay + ny * h); ctx.lineTo(bx + nx * h, by + ny * h);
    ctx.lineTo(bx - nx * h, by - ny * h); ctx.lineTo(ax - nx * h, ay - ny * h); ctx.closePath();
    ctx.fillStyle = pal.bridgeDeck; ctx.fill();
    ctx.strokeStyle = pal.bridgeInk; ctx.lineCap = 'butt'; ctx.lineWidth = Math.max(1.1 * s, 1 / sc);
    ctx.beginPath();
    ctx.moveTo(ax + nx * h, ay + ny * h); ctx.lineTo(bx + nx * h, by + ny * h);
    ctx.moveTo(ax - nx * h, ay - ny * h); ctx.lineTo(bx - nx * h, by - ny * h);
    ctx.stroke(); ctx.lineCap = 'round';
  }
}

function drawSiteMarker(ctx: CanvasRenderingContext2D, world: World, pal: Palette, u: number, sc: number): void {
  const c = world.site!.center;
  ctx.setLineDash([Math.max(9 * u, 6 / sc), Math.max(6 * u, 4 / sc)]);
  ctx.strokeStyle = pal.ink; ctx.globalAlpha = 0.7; ctx.lineWidth = Math.max(1.5 * u, 1 / sc);
  for (const poly of world.landuse?.reserve ?? []) {
    if (poly.length < 3) continue;
    ctx.beginPath(); ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    ctx.closePath(); ctx.stroke();
  }
  ctx.setLineDash([]); ctx.globalAlpha = 1;
  const r = Math.max(9 * u, 5 / sc);
  ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, TAU);
  ctx.fillStyle = pal.paper; ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1;
  ctx.strokeStyle = pal.ink; ctx.lineWidth = Math.max(1.6 * u, 1.2 / sc); ctx.stroke();
  ctx.beginPath(); ctx.arc(c.x, c.y, r * 0.38, 0, TAU); ctx.fillStyle = pal.ink; ctx.fill();
}

export type { LandKind };
