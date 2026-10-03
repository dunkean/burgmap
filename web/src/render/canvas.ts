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
import { bridgeShapes, isKinded, type BridgeShapes } from './townbridges';
import type { World, LandKind, Vec2 } from '../gen/types';
import { Palette, MapStyle, ruralInk } from './styles';
import { biomePalette } from './biomes';
import { fieldHedgeStyle } from './hedges';
import { renderTerrainRaster } from './raster';
import { buildScene, Scene, PolyLayer, LineLayer, TextureLayer, textureMarks, LAND_ORDER, WALL_LINE_W, CAMP_FENCE_W, FENCE_STYLE } from './scene';
import { renderView } from '../gen/settlements/merge';
import { selectLod, lineWidth, Lod, BAND_MIN_EDGE, WAY_SCALE } from './lod';
import { View, viewRect, Rect4 } from './view';
import { Label, placeLabels } from './labels';
import { buildMapLabels, placeMapLabels, MapLabel, PlacedMapLabel, estimateWidth } from './mapLabels';
import { fontString, FONT_STACKS, KindStyle } from './labelStyles';
import { cartoucheModel, legendModel, drawPanelCanvas, Panel } from './legend';
import { frameModel, panelMargin } from './frame';
import { litDots } from './extras';

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
  /** `withRect = false` draws the static base only (the page overlays the view rectangle itself). */
  drawMinimap(target: CanvasLike, view: View, viewW: number, viewH: number, withRect?: boolean): void;
  lastStats(): FrameStats;
  dispose(): void;
}

const BUILDING_BUDGET_FULL = 120_000;
const BUILDING_BUDGET_MAX = 450_000;
/** Individually outlined buildings in view above which we fall back to merged masses. */
const BUILDING_BUDGET_INDIV = 160_000;

const hexRgb = (h: string): number[] | null => { const m = /^#([0-9a-f]{6})$/i.exec(h); if (!m) return null; const v = parseInt(m[1], 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
const mixHex = (a: string, b: string, t: number): string => {
  const A = hexRgb(a), B = hexRgb(b);
  if (!A || !B) return a;
  return '#' + A.map((x, i) => Math.round(x + (B[i] - x) * t).toString(16).padStart(2, '0')).join('');
};
const lumHex = (h: string): number => { const c = hexRgb(h); return c ? (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 : 0.5; };
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

export function createCanvasRenderer(canvas: CanvasLike, world0: World, style: MapStyle | Palette, deps: CanvasRendererDeps = {}): CanvasRenderer {
  const world = renderView(world0);
  const pal = biomePalette(style, world.options.biome);
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
  let litCache: Float32Array | undefined;
  let stats: FrameStats = { band: 0, scale: 0, ms: 0, tilesDrawn: 0, bigDrawn: 0, pathsBuilt: 0, pathCache: 0, buildingsCandidate: 0, buildingsDrawn: false, textureTiles: 0 };

  const polyL = (n: string): PolyLayer | undefined => scene.poly.get(n);
  const linesOf = (pred: (l: LineLayer) => boolean): LineLayer[] => scene.lines.filter(pred);

  /**
   * Land = the map minus the sea and lakes (evenodd): roads, tracks and street strokes are clipped to it, so a stroke
   * widened to its minimum on-screen width never spills over the water (bridges are drawn afterwards, unclipped).
   */
  let landPath: Path2D | null | undefined;
  function landClip(): Path2D | null {
    if (landPath !== undefined) return landPath;
    const ls = ['sea', 'lakes'].map((n) => scene.poly.get(n)).filter((l): l is PolyLayer => !!l);
    if (!ls.length) return (landPath = null);
    const p = new P();
    const m = 50;
    p.moveTo(-m, -m); p.lineTo(S + m, -m); p.lineTo(S + m, S + m); p.lineTo(-m, S + m); p.closePath();
    for (const l of ls) for (let i = 0; i < l.polys.length; i++) {
      for (const r of [l.polys[i], ...(l.holes?.[i] ?? [])]) {
        if (r.length < 3) continue;
        p.moveTo(r[0].x, r[0].y);
        for (let k = 1; k < r.length; k++) p.lineTo(r[k].x, r[k].y);
        p.closePath();
      }
    }
    return (landPath = p);
  }

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
    // everything below is clipped to the map rectangle (sea polygons etc. run past it)
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, S, S); ctx.clip();

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
    const roadGroup = (ls: LineLayer[], fillMinPx: (l: LineLayer) => number, edgeK: (l: LineLayer) => number = () => 1): void => {
      if (!ls.length) return;
      strokeLines(ls, pal.roadEdge, (l) => lw(l.width, fillMinPx(l)) + 2 * edge * edgeK(l));
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
    const multiply = (on: boolean): void => { ctx.globalCompositeOperation = on && pal.landBlend === 'multiply' ? 'multiply' : 'source-over'; };
    if (pal.grid && sc * pal.grid.step > 7) {
      const g = pal.grid;
      ctx.strokeStyle = g.color; ctx.globalAlpha = g.opacity; ctx.lineWidth = Math.max(0.6 * u, 0.8 / sc);
      ctx.beginPath();
      for (let v = Math.max(g.step, Math.ceil(rect.minX / g.step) * g.step); v < Math.min(S, rect.maxX); v += g.step) { ctx.moveTo(v, Math.max(0, rect.minY)); ctx.lineTo(v, Math.min(S, rect.maxY)); }
      for (let v = Math.max(g.step, Math.ceil(rect.minY / g.step) * g.step); v < Math.min(S, rect.maxY); v += g.step) { ctx.moveTo(Math.max(0, rect.minX), v); ctx.lineTo(Math.min(S, rect.maxX), v); }
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (world.options.contours) {
      for (const l of linesOf((x) => x.role === 'contour')) {
        const idx = l.kind === 'index';
        strokeLines([l], pal.contour, () => (idx ? 0.7 * pal.contourIndexW * 0.9 : 0.7) / sc, idx ? pal.contourOpacity : pal.contourOpacity * 0.7);
      }
    }
    for (const kind of LAND_ORDER) {
      if (!luOn) break;
      const name = 'lu-' + kind;
      if (!polyL(name)) continue;
      multiply(true);
      fillPolys(name, pal.land[kind], kind === 'forest' ? 0.7 : luAlpha);
      if (kind === 'field' && lod.strips) {
        const mk = [0.5, 0.75, 0.3, 0.9];
        for (let k = 0; k < 4; k++) if (pal.stripAlpha[k & 1] > 0) fillPolys('stripT' + k, k & 1 ? pal.stripB : pal.stripA, Math.min(1, pal.stripAlpha[k & 1] * mk[k]));
      }
      multiply(false);
      if (kind === 'field' && lod.strips && lod.band >= 2) {
        for (let k = 0; k < 4; k++) strokePolys('stripT' + k, pal.furrow, lw(0.28 * Math.max(1, u), 0.5), pal.furrowAlpha * 0.85);
      }
      if (kind === 'field' && lod.strips) strokePolys('furlong-edges', pal.furrow, lw(0.45 * Math.max(1, u), 0.6), 0.55);
      if (kind === 'forest' && lod.strips) strokePolys(name, pal.treeInk, lw(0.7, 0.8), pal.tex.forest ? 0.5 : 0.35);
      if ((kind === 'orchard' || kind === 'garden') && lod.strips) strokePolys(name, pal.hedge, lw(0.8, 0.8), 0.7);
    }
    const fu = Math.max(1, u);
    // field network: ways, headlands, hedgerows (+ trees near). Ways and headlands are subtle earth-toned hairlines
    // (never paper-white bands across the fields), and the ways only show from mid-close zoom on.
    if (luOn && lod.strips) {
      const rk = ruralInk(pal);
      strokeLines(linesOf((l) => l.name === 'headlands'), pal.furrow, () => lw(0.6, 0.5), pal.rural.headland, [], 'butt');
      if (sc >= WAY_SCALE) {
        const ways = linesOf((l) => l.name === 'field-ways');
        strokeLines(ways, rk, () => lw(1.4, 0.8), pal.rural.way, lod.band >= 2 ? [px(6), px(4)] : [], 'butt');
      }
      if (pal.hedgeOn) {
        const hedge = fieldHedgeStyle(pal, u);
        strokeLines(linesOf((l) => l.name === 'hedges'), hedge.color, () => lw(hedge.width, 0.35), hedge.alpha * Math.min(1, sc / 0.3));
        if (lod.band >= 2 && polyL('hedge-trees')) {
          fillPolys('hedge-trees', pal.treeFill, 0.75);
          strokePolys('hedge-trees', pal.treeInk, lw(0.3 * fu, 0.35), 0.5);
        }
      }
    }
    // textures (procedural marks, visible tiles only, cached per tile)
    if (lod.textures && luOn) {
      for (const tl of scene.textures) if (pal.tex[tl.kind]) fs.textureTiles += drawTexture(ctx, tl, rect, band, lw);
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
    fillPolys('lakes', pal.lakeFill, 1, 'nonzero');
    const wl = pal.waterLines;
    if (wl && sc >= 0.11) {
      const gap = wl.gap;
      const wpat = getPattern(ctx, 'waterlines', gap, gap, 0, (c, k) => {
        c.globalAlpha = wl.opacity; c.strokeStyle = wl.color; c.lineWidth = Math.max(0.9, wl.width * k * 0.7);
        c.beginPath(); c.moveTo(0, gap * k / 2); c.lineTo(gap * k, gap * k / 2); c.stroke();
      });
      if (wpat) {
        ctx.fillStyle = wpat;
        for (const name of ['sea', 'lakes'] as const) { const l = polyL(name); if (l) for (const p of polyPaths(l)) ctx.fill(p, name === 'sea' ? 'evenodd' : 'nonzero'); }
      }
    }
    strokePolys('sea', pal.waterEdge, lw(1.5 * u, 1.2));
    strokePolys('lakes', pal.waterEdge, lw(1.3 * u, 1.1));

    // 4. regional roads + farmsteads
    if (lod.farmsteads && polyL('farm-yards')) {
      strokeLines(linesOf((l) => l.role === 'drive'), pal.trackFill, (l) => lw(l.width, 1), 0.7, [], 'butt');
      fillPolys('farm-gardens', pal.land.garden);
      strokePolys('farm-gardens', pal.hedge, lw(0.4, 0.3), 0.8);
      fillPolys('farm-orchards', pal.land.orchard);
      fillPolys('farm-paddocks', pal.land.pasture);
      strokePolys('farm-platforms', pal.farmInk, lw(0.5, 0.4), 0.7, [px(3), px(2)]);
      strokePolys('farm-lots', pal.hedge, lw(0.9, 0.6), 0.85);
      fillPolys('farm-yards', pal.farmYard, 0.9);
      fillPolys('farm-pens', pal.farmYard);
      strokePolys('farm-pens', pal.farmInk, lw(0.3, 0.3));
      fillPolys('farm-ponds', pal.lakeFill);
      strokePolys('farm-ponds', pal.waterEdge, lw(0.5, 0.4));
      strokeLines(linesOf((l) => l.name === 'farm-walls'), pal.farmInk, () => lw(0.9, 0.7), 1, [], 'butt');
      if (lod.band >= 2 && polyL('farm-trees')) {
        fillPolys('farm-trees', pal.treeFill);
        strokePolys('farm-trees', pal.treeInk, lw(0.3, 0.3), 0.8);
      }
      fillPolys('farm-buildings', pal.farmRoof);
      strokePolys('farm-buildings', pal.farmInk, lw(0.5, 0.6));
      if (lod.band >= 2) strokeLines(linesOf((l) => l.name === 'farm-ridges'), pal.farmInk, () => lw(0.35, 0.4), 0.8, [], 'butt');
    }
    // roads, tracks and the street strokes below never spill over the sea or the lakes (bridges come later)
    const land = landClip();
    ctx.save();
    if (land) ctx.clip(land, 'evenodd');
    // hierarchy: cased major roads; thinner cased minor roads; tracks as thin dashed earth lines from mid zoom only
    const roads = linesOf((l) => l.role === 'road' && l.kind !== 'track' && (lod.minorRoads || l.kind === 'major'));
    roadGroup(roads, (l) => (l.kind === 'major' ? 1.6 : 0.8), (l) => (l.kind === 'major' ? 1 : 0.6));
    const tracks = linesOf((l) => l.role === 'road' && l.kind === 'track' && lod.band >= 1);
    strokeLines(tracks, ruralInk(pal), () => lw(1.6, 0.9), pal.rural.track, [px(lod.band >= 2 ? 7 : 5), px(lod.band >= 2 ? 4 : 3)], 'butt');
    ctx.restore();

    // 5. urban
    const U = pal.urban;
    const uStreets = linesOf((l) => l.role === 'street');
    // (village and hamlet streets, layers 'vstreet-*', never get the far-zoom arterial strokes)
    const isVillage = (l: LineLayer): boolean => l.name.startsWith('vstreet-');
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
      ctx.save();
      if (land) ctx.clip(land, 'evenodd');
      roadGroup(mainsOf(1).filter((l) => !isVillage(l)), (l) => (l.kind.startsWith('r0') ? 1.8 : 1.2));
      ctx.restore();
    } else {
      // street space = the quarters; blocks, places and masses are laid on top
      const stilts = !!world.urban?.renderHints?.stilts;
      // open ground (camps, barbarian villages): no street space or block fill (same rules as render/urban.ts)
      const open = !!world.urban?.renderHints?.openGround && !stilts;
      const earth = mixHex(pal.trackFill, U.street, 0.52);
      const near = lod.band >= 2;
      if (open) {
        const tuft = near ? getPattern(ctx, 'tuft', 11, 9, 0, (c, k) => {
          c.globalAlpha = 0.75; c.strokeStyle = pal.grass; c.lineWidth = 0.35 * k; c.beginPath();
          for (const [x, y] of [[2.5, 4.5], [8, 8.4]]) { c.moveTo(x * k, y * k); c.lineTo((x - 0.8) * k, (y - 1.9) * k); c.moveTo(x * k, y * k); c.lineTo((x + 0.8) * k, (y - 1.9) * k); }
          c.stroke();
        }) : null;
        const tint = (name: string, color: string, alpha: number, pat: CanvasPattern | null): void => {
          const l = polyL(name);
          if (!l) return;
          if (pal.landBlend === 'multiply') ctx.globalCompositeOperation = 'multiply';
          fillPolys(name, color, alpha);
          ctx.globalCompositeOperation = 'source-over';
          if (pat) { ctx.fillStyle = pat; for (const p of polyPaths(l)) ctx.fill(p, 'evenodd'); }
        };
        // the settlement's ground (the footprint and a margin round it, off the water), opaque where it hides roads
        if (polyL('u-ground-solid')) fillPolys('u-ground-solid', mixHex(pal.paper, pal.land.meadow, 0.35), 1, 'nonzero');
        tint('u-ground', pal.land.meadow, pal.landOpacity * 0.8, tuft);
        tint('u-open-grass', pal.land.pasture, pal.landOpacity * 0.85, tuft);
        tint('u-open-green', pal.land.meadow, pal.landOpacity, tuft);
        tint('u-open-garden', pal.land.garden, pal.landOpacity, null);
        tint('u-open-field', pal.land.field, pal.landOpacity, null);
        if (polyL('u-open-field')) strokePolys('u-open-field', pal.furrow, lw(0.4, 0.4), 0.4);
        tint('u-open-commons', pal.land.pasture, pal.landOpacity * 0.8, null);
        // churned mud (a war camp), puddles
        if (polyL('u-mud')) {
          const dk = mixHex(pal.trackFill, '#000000', 0.25);
          fillPolys('u-mud', mixHex(pal.trackFill, pal.farmYard, 0.62), 0.75);
          const mudPat = near ? getPattern(ctx, 'mud', 9, 7, 17, (c, k) => {
            c.globalAlpha = 0.55; c.strokeStyle = dk; c.lineWidth = 0.35 * k; c.lineCap = 'round'; c.beginPath();
            for (const [x0, y0, x1, y1] of [[1, 1.5, 2.6, 1.9], [5.5, 4.8, 6.7, 4.3], [2.4, 5.6, 3.3, 6.2], [7.2, 1.2, 7.7, 2.2]]) { c.moveTo(x0 * k, y0 * k); c.lineTo(x1 * k, y1 * k); }
            c.stroke(); c.fillStyle = dk; c.beginPath(); c.arc(4.2 * k, 2.4 * k, 0.32 * k, 0, TAU); c.arc(7.8 * k, 5.9 * k, 0.25 * k, 0, TAU); c.fill();
          }) : null;
          if (mudPat) { const l = polyL('u-mud')!; ctx.fillStyle = mudPat; for (const p of polyPaths(l)) ctx.fill(p, 'evenodd'); }
        }
        if (polyL('u-puddle')) { fillPolys('u-puddle', pal.riverFill, 0.7); strokePolys('u-puddle', mixHex(pal.trackFill, '#000000', 0.2), lw(0.3, 0.3), 0.6); }
        fillPolys('u-yard-earth', mixHex(pal.farmYard, pal.trackFill, 0.12), 0.85);
        // paths: trampled earth (wide causeways keep the street colour)
        strokeLines(uStreets.filter((l) => !(l.width >= 6.5 && Number(l.kind.slice(1, 2)) <= 1)), earth, (l) => Math.max(1.2, l.width * 0.92, 0.8 / sc), 0.8);
        strokeLines(uStreets.filter((l) => l.width >= 6.5 && Number(l.kind.slice(1, 2)) <= 1), U.street, (l) => Math.max(1.2, l.width * 0.92, 0.8 / sc));
      } else if (stilts) {
        // a stilt town has no ground: boardwalks as planks over the water and the marsh
        strokeLines(uStreets, pal.bridgeInk, (l) => Math.max(1.6, l.width + 0.2, 1.4 / sc), 1, [], 'butt');
        strokeLines(uStreets, pal.bridgeDeck, (l) => Math.max(1, l.width - 0.7, 0.9 / sc), 1, [], 'butt');
      } else {
        fillPolys('u-streets', U.street, 1, 'nonzero');
        strokePolys('u-streets', U.street, 0.4);
      }
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
      if (!open) {
        paved('u-greens', U.garden, gardenPat, 0.6);
        paved('u-yards', U.garden, gravePat);
        if (!stilts) fillPolys('u-blocks', U.yard);
        paved('u-meadows', U.garden, gardenPat, 0.45);
      }
      paved('u-plazas', U.place, pave);
      const cornPat = near ? getPattern(ctx, 'corn', 2.6, 2.6, 12, (c, k) => { c.globalAlpha = 0.75; c.fillStyle = U.gardenInk; c.beginPath(); c.arc(1.3 * k, 1.3 * k, 0.6 * k, 0, TAU); c.fill(); }) : null;
      if (polyL('u-terraces')) { const tt = mixHex(pal.land.meadow, pal.land.garden, 0.4); fillPolys('u-terraces', tt); strokePolys('u-terraces', tt, lw(1.5, 0.5)); }
      paved('u-cornfields', mixHex(pal.land.field, U.gardenInk, 0.14), cornPat);
      if (polyL('u-cornfields') && lod.band >= 1) strokePolys('u-cornfields', U.gardenInk, lw(0.45, 0.4), 0.55);
      if (polyL('u-chinampa-canals')) fillPolys('u-chinampa-canals', pal.riverFill);
      paved('u-chinampas', U.garden, gardenPat);
      // urban water (moats, tanks, mill races) and the moat line outside a planned town's wall
      strokeLines(linesOf((l) => l.role === 'uline' && (l.kind === 'moat' || l.kind === 'canal')), pal.riverFill, (l) => lw(l.width, 1));
      if (polyL('u-water')) { fillPolys('u-water', pal.riverFill, 1, 'nonzero'); strokePolys('u-water', pal.riverEdge, lw(0.5, 0.4)); }
      // compound grounds, mosque courts (sahn), cloister garths, ditch parcels, cemeteries, castle bases
      fillPolys('u-grounds', U.place);
      if (polyL('u-sahn')) { paved('u-sahn', U.place, pave); strokePolys('u-sahn', U.plotLine, lw(0.2, 0.3)); }
      if (polyL('u-garth')) { fillPolys('u-garth', U.garden); strokePolys('u-garth', U.plotLine, lw(0.25, 0.3)); }
      if (polyL('u-ditch')) { paved('u-ditch', U.garden, gardenPat); strokePolys('u-ditch', U.plotLine, lw(0.3, 0.3)); }
      paved('u-cemetery', U.garden, gravePat);
      if (polyL('u-bases')) { fillPolys('u-bases', U.wallFill); strokePolys('u-bases', U.wall, lw(0.4, 0.5)); }
      if (!open) paved('u-backland', U.garden, world.urban?.renderHints?.graves ? gravePat : gardenPat);
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
          const sh = U.shadow;
          if (sh && lod.band >= 2 && cand <= BUILDING_BUDGET_FULL) {
            // styled cast shadow: solid sepia fringe, hatched once the fringe is wide enough on screen
            ctx.save(); ctx.translate(sh.dx, sh.dy);
            ctx.fillStyle = sh.color; ctx.globalAlpha = sh.hatch && sc >= 1.1 ? sh.alpha * 0.4 : sh.alpha;
            for (const p of paths) ctx.fill(p, 'evenodd');
            if (sh.hatch && sc >= 1.1) {
              const hp = getPattern(ctx, 'shadowhatch', 2.6, 2.6, 45, (c, k) => { c.strokeStyle = sh.color; c.globalAlpha = sh.alpha; c.lineWidth = 0.9 * k; c.beginPath(); c.moveTo(0, 1.3 * k); c.lineTo(2.6 * k, 1.3 * k); c.stroke(); });
              if (hp) { ctx.fillStyle = hp; ctx.globalAlpha = 1; for (const p of paths) ctx.fill(p, 'evenodd'); }
            }
            ctx.restore(); ctx.globalAlpha = 1;
          } else if (lod.shadows && cand <= BUILDING_BUDGET_FULL) {
            ctx.save(); ctx.translate(1.4, 1.7);
            ctx.fillStyle = 'rgba(0,0,0,0.2)';
            for (const p of paths) ctx.fill(p, 'evenodd');
            ctx.restore();
          }
          const bl = polyL('u-bldg');
          let indiv = 0;
          if (lod.individual && bl) {
            for (const t of bl.index.tilesInRect(rect)) indiv += bl.index.tileStart[t + 1] - bl.index.tileStart[t];
            indiv += bl.index.bigInRect(rect).length;
          }
          if (lod.individual && bl && indiv <= BUILDING_BUDGET_INDIV) {
            // one building at a time (as in the SVG): roof fill, then a thin outline so party walls show as lines
            const lm = lumHex(U.mass);
            const roof = lm < 0.3 ? mixHex(U.mass, U.yard, 0.42) : U.mass;
            const ink = lm < 0.3 ? mixHex(U.mass, '#000000', 0.25) : lumHex(U.massEdge) < lm ? U.massEdge : mixHex(U.mass, '#000000', 0.6);
            const bp = polyPaths(bl);
            ctx.fillStyle = roof;
            // (the masses first: a megacity quarter not detailed yet has its stand-in masses and no buildings)
            for (const p of paths) ctx.fill(p, 'evenodd');
            for (const p of bp) ctx.fill(p, 'evenodd');
            ctx.strokeStyle = ink; ctx.lineWidth = lw(Math.max(0.28, U.massEdgeW * 0.9), 0.45); ctx.lineJoin = 'miter';
            for (const p of bp) ctx.stroke(p);
            ctx.lineJoin = 'round';
          } else {
            ctx.fillStyle = U.mass;
            for (const p of paths) ctx.fill(p, 'evenodd');
            if (cand <= BUILDING_BUDGET_FULL) {
              ctx.strokeStyle = U.massEdge; ctx.lineWidth = lw(U.massEdgeW, 0.3);
              for (const p of paths) ctx.stroke(p);
            }
          }
          if (U.lit && lod.band >= 2) drawLit(ctx, rect, sc, U.lit.color, U.lit.density);
        }
      }
      // landmark buildings: the landmark tone, outlined
      const lmHatch = lod.fine ? getPattern(ctx, 'lmhatch', 1.6, 1.6, 45, (c, k) => { c.globalAlpha = 0.55; c.strokeStyle = U.landmarkEdge; c.lineWidth = 0.35 * k; c.beginPath(); c.moveTo(0, 0.8 * k); c.lineTo(1.6 * k, 0.8 * k); c.stroke(); }) : null;
      const hatched = (name: string): void => {
        const l = polyL(name);
        if (!l || !lmHatch) return;
        ctx.fillStyle = lmHatch; ctx.globalAlpha = 1;
        for (const p of polyPaths(l)) ctx.fill(p, 'evenodd');
      };
      if (polyL('u-lmb')) { fillPolys('u-lmb', U.landmark); hatched('u-lmb'); strokePolys('u-lmb', U.landmarkEdge, lw(0.7, near ? 0.5 : 1.4)); }
      // courtyard houses: the patio as a paved court with a crisp inner edge
      if (polyL('u-patios') && lod.individual) {
        fillPolys('u-patios', U.place);
        if (near && pave) { const l = polyL('u-patios')!; ctx.fillStyle = pave; for (const p of polyPaths(l)) ctx.fill(p, 'evenodd'); }
        strokePolys('u-patios', U.massEdge, lw(0.45, 0.6));
      }
      // plan lines (same rules per kind as render/urban.ts): enclosure walls, fences, terraces, hedges, footpaths,
      // canal footbridges, bazaar roofs, qanats, stair treads. Unlisted kinds fall back to the wall-like stroke.
      {
        const treeInk = pal.treeInk ?? '#4a6a3a';
        const fine = lod.fine;
        if (lod.fine) strokeLines(linesOf((x) => x.role === 'uline' && x.kind === 'andene-riser'), U.wall, () => 1.5, 0.45, [0.22, 0.85], 'butt');
        for (const l of linesOf((x) => x.role === 'uline')) {
          const k = l.kind, w = l.width;
          const one = (color: string, width: number, alpha = 1, dash: number[] = [], cap: CanvasLineCap = 'round'): void => strokeLines([l], color, () => width, alpha, dash, cap);
          if (k === 'moat' || k === 'canal') continue;
          else if (k === 'hedge') one(treeInk, lw(2.6, 0.8), 0.8, fine ? [3, 1.5] : [], 'butt');
          else if (k === 'track') one(open ? earth : U.street, lw(open ? 2.6 : 3, 0.6), open ? 0.75 : 1);
          else if (k === 'weir') one(U.wall, lw(1.4, 0.5), 1, fine ? [1.2, 0.6] : [], 'butt');
          else if (k === 'parterre') { if (fine) one(U.plotLine, lw(0.5, 0.4)); }
          else if (k === 'footpath') { if (fine) one(open ? earth : U.street, lw(1.4, 0.6)); }
          else if (k === 'roof-line') { if (near) one(U.massEdge, lw(0.2, 0.3), 0.7, [], 'butt'); }
          else if (k === 'garden-hedge') one(treeInk, lw(1.2, 0.5), 0.7, fine ? [1.6, 0.7] : [], 'butt');
          else if (k === 'bund') { if (fine) one(U.plotLine, lw(0.4, 0.3), 0.35, [], 'butt'); }
          else if (k === 'turf-wall') { one(mixHex(pal.grass, U.wall, 0.35), lw(2.2, 0.8), 0.42); if (fine) one(U.wall, lw(0.16, 0.3), 0.45); }
          else if (k === 'albarrada') one(U.wall, lw(0.85, 0.4), 0.4, fine ? [0.9, 0.45] : []);
          else if (k === 'ghat-steps') { if (fine) one(U.plotLine, lw(0.3, 0.4)); }
          else if (k === 'terrace') one(U.wall, lw(1.6, 0.8));
          else if (k === 'andene') one(U.wall, lw(0.4, 0.4), 0.8);
          else if (k === 'andene-riser') continue;
          else if (k === 'terrace-stair') { one(U.wall, lw(1.6, 0.6), 0.85, fine ? [0.35, 0.55] : [], 'butt'); }
          else if (k === 'thorn-fence') one(treeInk, lw(2.2, 0.8), 0.85, near ? [1.3, 0.9] : []);
          else if (k === 'rampart') { one(U.garden, lw(7, 1.4), 0.9); one(U.wall, lw(0.6, 0.4)); }
          else if (k === 'ditch') one(U.wall, lw(4, 0.9), 0.35);
          else if (k === 'footbridge') {
            // the deck between its parapets
            const dw = w || 2.5;
            one(pal.bridgeInk, Math.max(dw + 0.9, 2.2 / sc), 1, [], 'butt');
            one(pal.bridgeDeck, Math.max(dw, 1.4 / sc), 1, [], 'butt');
          }
          else if (k === 'bazaar-roof') {
            // the vaulted bazaar street: a roof over the street's own width
            const rw = Math.max(2, (w || 5) - 0.6);
            one(U.landmarkEdge, Math.max(rw + 0.8, 2.2 / sc), 1, [], 'butt');
            one(U.landmark, Math.max(rw, 1.4 / sc), 1, [], 'butt');
          }
          else if (k === 'qanat') one(U.wall, lw(1, 0.6), 0.7, [4, 3], 'butt');
          else if (k === 'qanat-shaft') { ctx.fillStyle = U.garden; for (const p of linePaths(l)) ctx.fill(p, 'evenodd'); one(U.wall, lw(0.7, 0.5)); }
          else if (k === 'hachure') { if (fine) one(U.wall, lw(0.55, 0.5), 0.85, [], 'butt'); }
          else if (CAMP_FENCE_W[k] !== undefined) {
            // a rail with its posts (stakes close together for a palisade); zoomed out, a thin line
            const st = FENCE_STYLE[k] ?? FENCE_STYLE['yard-fence'];
            const far = !fine && k !== 'palisade' && k !== 'kraal-fence';
            if (far) { if (lod.band >= 1) one(U.wall, lw(st[0], 0.3), 0.6); }
            else {
              one(U.wall, lw(st[0], 0.35), 0.8);
              if (near) one(U.wall, st[1], 0.9, [st[2], st[3]], 'butt');
              else if (k === 'palisade' || k === 'kraal-fence') one(U.wall, lw(st[1], 0.5), 0.75);
            }
          }
          else one(U.wall, lw(WALL_LINE_W[k] ?? 1, 0.8), 1, [], 'square');
        }
        // tree canopies (elven towns)
        const trees = polyL('u-trees');
        if (trees && lod.individual) {
          ctx.globalAlpha = 0.78; ctx.fillStyle = pal.treeFill ?? '#7f9a5a';
          for (const p of polyPaths(trees)) ctx.fill(p, 'evenodd');
          ctx.globalAlpha = 1;
          strokePolys('u-trees', treeInk, lw(0.35, 0.4));
        }
      }
      // churches: distinct outlined mass with a cross
      if (polyL('u-church')) {
        fillPolys('u-church', U.landmark);
        hatched('u-church');
        // (zoomed out, a small church keeps a legible outline: at least ~1.6 px)
        strokePolys('u-church', U.landmarkEdge, lw(0.8, near ? 0.6 : 1.6));
        if (lod.band >= 2) strokeLines(linesOf((l) => l.role === 'cross'), U.landmarkEdge, (l) => lw(l.width, 0.6));
      }
      // plot hairlines: a dark pass (reads on yards) and a light pass (reads on roofs)
      if (lod.parcels) {
        strokePolys('u-plots', U.plotLine, lw(U.plotW, 0.4), U.plotAlpha * 0.7);
        if (U.plotLightAlpha > 0) strokePolys('u-plots', U.massEdge, lw(U.plotW, 0.4), U.plotLightAlpha * 0.7);
      }
      // hierarchy: arterial / primary streets keep a legible minimum width in street colour
      const minPx = (l: LineLayer): number => (isVillage(l) ? (lod.band >= 2 ? 1.2 : 0.8) : l.kind.startsWith('r0') ? 2.6 : l.kind.startsWith('r1') ? 1.8 : 1.0);
      const thin = mainsOf(lod.band === 1 ? 2 : 1).filter((l) => l.width * sc < minPx(l));
      ctx.save();
      if (land && !stilts) ctx.clip(land, 'evenodd');
      strokeLines(thin, open ? earth : U.street, (l) => minPx(l) / sc, open ? 0.8 : 1);
      ctx.restore();
      if (!stilts && !open) strokePolys('block-edges', U.blockEdge, lw(U.blockEdgeW, 0.3));
      if (polyL('landmarks') && near) strokePolys('landmarks', U.landmark, lw(0.6, 0.6), 0.5, [px(5), px(3)]);
      // zoomed out: the landmark sites (wells, crosses, markets, compounds' named buildings) as a solid outline of at
      // least ~1.8 px, so the small ones stay visible on the full map
      else if (polyL('landmarks')) strokePolys('landmarks', U.landmarkEdge, lw(0.6, 1.8), 0.9);
    }
    // walls: casing + fill (stretches between gate openings), towers and gate towers
    const walls = linesOf((l) => l.role === 'wall');
    const ws = U.wallScale;
    for (const l of walls) strokeLines([l], U.wall, () => Math.max(l.width * ws + 1.4, 3 / sc), 1, [], 'butt');
    for (const l of walls) strokeLines([l], U.wallFill, () => Math.max(0.6, l.width * ws - 1, 1.5 / sc), 1, [], 'butt');
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

    ctx.restore();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    // 7. map frame (screen space, around the map rectangle)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.setLineDash([]);
    {
      const side = S * sc, fx = cssW / 2 - view.cx * sc, fy = cssH / 2 - view.cy * sc;
      if (pal.frameKind !== 'none' && fx < cssW && fy < cssH && fx + side > 0 && fy + side > 0) {
        drawPanelCanvas(ctx, { w: side, h: side, prims: frameModel(side, side, pal, false) }, fx, fy, family);
      }
    }

    // 8. labels, cartouche, legend (screen space)
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
        ctx.lineWidth = 3; ctx.strokeStyle = pal.lab.halo; ctx.globalAlpha = 0.85;
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
    // panels sit inside the map frame when the map corner is under them, else at the viewport corner
    const pm = panelMargin(pal) * 0.75;
    const mx0 = cssW / 2 - view.cx * sc, my0 = cssH / 2 - view.cy * sc, mapBottom = my0 + S * sc;
    const cart = overlays.cartouche ? cartoucheModel(world, pal, sc) : null;
    if (cart) {
      const inside = mx0 < 12 + cart.w && my0 < 12 + cart.h;
      drawPanelCanvas(ctx, cart, inside ? Math.max(12, mx0 + pm) : 12, inside ? Math.max(12, my0 + pm) : 12, family);
    }
    if (overlays.legend) {
      legendPanel ??= legendModel(world, pal);
      const home = Math.max(12, cssH - legendPanel.h - 34);
      const inside = mx0 < 12 + legendPanel.w && mapBottom > home && mapBottom < cssH + legendPanel.h + 60;
      drawPanelCanvas(ctx, legendPanel, inside ? Math.max(12, mx0 + pm) : 12, inside ? Math.max(12, Math.min(home, mapBottom - pm - legendPanel.h)) : home, family);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    fs.pathsBuilt = built - built0;
    fs.pathCache = cache.size;
    fs.ms = now() - t0;
    stats = fs;
    return fs;
  }

  /** Deterministic lit windows of the visible buildings (night style). */
  function drawLit(ctx: CanvasRenderingContext2D, rect: Rect4, sc: number, color: string, density: number): void {
    litCache ??= litDots(world, density);
    const d = litCache;
    const path = new P();
    let n = 0;
    for (let i = 0; i < d.length; i += 2) {
      const x = d[i], y = d[i + 1];
      if (x < rect.minX || x > rect.maxX || y < rect.minY || y > rect.maxY) continue;
      path.moveTo(x, y); path.lineTo(x, y); n++;
      if (n > 60000) break;
    }
    if (!n) return;
    ctx.lineCap = 'round'; ctx.strokeStyle = color;
    const w = Math.max(1.3, 2 / sc);
    ctx.globalAlpha = 0.16; ctx.lineWidth = w * 3.2; ctx.stroke(path);
    ctx.globalAlpha = 1; ctx.lineWidth = w; ctx.stroke(path);
  }

  function drawTexture(ctx: CanvasRenderingContext2D, tl: TextureLayer, rect: Rect4, band: number, lw: (w: number, m: number) => number): number {
    const base = TEX[tl.kind];
    if (!base) return 0;
    const crown = pal.treeShape === 'crown' && (tl.kind === 'forest' || tl.kind === 'orchard');
    const spec: TexSpec = pal.treeShape === 'dot' && (tl.kind === 'forest' || tl.kind === 'orchard') ? { ...base, r: base.r * 0.5 } : base;
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
          if (spec.shape === 'circle') {
            path.moveTo(m.x + r, m.y); path.arc(m.x, m.y, r, 0, TAU);
            if (crown) {
              // drawn crown: shadow arc on the lower right and a short trunk
              path.moveTo(m.x + r * 0.55, m.y - r * 0.5); path.arc(m.x, m.y, r * 0.78, -0.75, 2.2);
              path.moveTo(m.x, m.y + r); path.lineTo(m.x, m.y + r * 1.5);
            }
          }
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

  function drawMinimap(target: CanvasLike, view: View, viewW: number, viewH: number, withRect = true): void {
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
    if (withRect) {
      const r = viewRect(view, viewW, viewH, 0);
      ctx.strokeStyle = pal.marker; ctx.lineWidth = 1.5 / k;
      ctx.strokeRect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
    }
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
      ctx.globalAlpha = pass === 0 ? pal.lab.haloOp : 1;
      ctx.strokeStyle = pal.lab.halo; ctx.fillStyle = st.color; ctx.lineWidth = halo;
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
        case 'ring': ctx.arc(x, y, r * 0.7, 0, TAU); ctx.stroke(); break;
        default: ctx.arc(x, y, r * 0.75, 0, TAU); ctx.fill();
      }
    }
  }
  ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
}
void estimateWidth;

function drawTownBridge(ctx: CanvasRenderingContext2D, sh: BridgeShapes, pal: Palette, sc: number): void {
  const poly = (pts: Vec2[]): void => { ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y); };
  ctx.lineCap = 'butt';
  if (sh.deck) { poly(sh.deck); ctx.closePath(); ctx.fillStyle = pal.bridgeDeck; ctx.globalAlpha = sh.deckAlpha; ctx.fill(); ctx.globalAlpha = 1; }
  if (sh.seams && sc > 2) {
    poly(sh.seams.pts); ctx.strokeStyle = pal.bridgeInk; ctx.globalAlpha = 0.45; ctx.lineWidth = sh.seams.w; ctx.setLineDash(sh.seams.dash); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = pal.bridgeInk;
  for (const l of sh.lines) { poly(l.pts); ctx.lineWidth = Math.max(l.w, 0.8 / sc); ctx.stroke(); }
  if (sh.stones.length) {
    ctx.fillStyle = pal.bridgeDeck; ctx.lineWidth = Math.max(0.15, 0.6 / sc);
    for (const st of sh.stones) { ctx.beginPath(); ctx.arc(st.c.x, st.c.y, Math.max(st.r, 0.8 / sc), 0, TAU); ctx.fill(); ctx.stroke(); }
  }
  ctx.lineCap = 'round';
}

function drawBridges(ctx: CanvasRenderingContext2D, world: World, pal: Palette, rect: Rect4, sc: number): void {
  const s = Math.max(1, (world.mapSize / 1600) * 0.85);
  for (const b of world.bridges ?? []) {
    if (Math.max(b.a.x, b.b.x) < rect.minX || Math.min(b.a.x, b.b.x) > rect.maxX || Math.max(b.a.y, b.b.y) < rect.minY || Math.min(b.a.y, b.b.y) > rect.maxY) continue;
    // small town bridges (footbridges, arches, fords) at true size, by kind
    if (isKinded(b)) { drawTownBridge(ctx, bridgeShapes(b), pal, sc); continue; }
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
  ctx.strokeStyle = pal.ink; ctx.lineWidth = Math.max(1.6 * u, 1.2 / sc); ctx.stroke();
  ctx.beginPath(); ctx.arc(c.x, c.y, r * 0.38, 0, TAU); ctx.fillStyle = pal.ink; ctx.fill();
}

export type { LandKind };
