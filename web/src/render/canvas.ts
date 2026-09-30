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

export interface CanvasRenderer {
  scene: Scene;
  palette: Palette;
  draw(view: View): FrameStats;
  setLabels(labels: Label[]): void;
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
  let terrainImg: CanvasImageSource | null | undefined;
  let densityImg: CanvasImageSource | null | undefined;
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

    // 2. land use
    const luAlpha = pal.landOpacity;
    for (const kind of LAND_ORDER) {
      const name = 'lu-' + kind;
      if (!polyL(name)) continue;
      fillPolys(name, pal.land[kind], kind === 'forest' ? 0.7 : kind === 'field' ? luAlpha : luAlpha);
      if (kind === 'field' && lod.strips) {
        fillPolys('stripA', pal.stripA, 0.55);
        fillPolys('stripB', pal.stripB, 0.5);
        if (lod.band >= 2) {
          strokePolys('stripA', pal.furrow, lw(0.28, 0.5), 0.5);
          strokePolys('stripB', pal.furrow, lw(0.28, 0.5), 0.5);
        }
      }
      if (kind === 'forest' && lod.strips) strokePolys(name, pal.treeInk, lw(0.7, 0.8), 0.5);
      if ((kind === 'orchard' || kind === 'garden') && lod.strips) strokePolys(name, pal.hedge, lw(0.8, 0.8), 0.7);
      if (kind === 'field' && lod.band >= 2) strokePolys(name, pal.hedge, lw(0.9, 0.9), 0.75, [px(4 * 1.3), px(1.6)]);
    }
    // textures (procedural marks, visible tiles only, cached per tile)
    if (lod.textures) {
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
    fillPolys('sea', pal.seaFill, 1, 'nonzero');
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
    if (lod.blocks) {
      fillPolys('blocks', pal.ink, 0.12);
      strokePolys('blocks', pal.ink, lw(0.5, 0.5), 0.4);
    }
    if (lod.parcels) strokePolys('parcels', pal.inkSoft, lw(0.25, 0.5), 0.55);
    fillPolys('squares', pal.roadFill, 0.9);
    strokePolys('squares', pal.roadEdge, lw(0.6, 0.6), 0.7);
    if (lod.streets) {
      const st = linesOf((l) => (l.role === 'street' || (lod.alleys && l.role === 'alley')));
      roadGroup(st, (l) => (l.kind === 'main' ? 1.6 : l.kind === 'alley' ? 0.6 : 1.1));
    } else {
      // far: only main streets, as thin ink lines
      const main = linesOf((l) => l.role === 'street' && l.kind === 'main');
      strokeLines(main, pal.roadEdge, () => px(1.3), 0.9);
    }
    // buildings
    const houses = polyL('houses'), special = polyL('special');
    if (lod.buildings && (houses || special)) {
      let cand = 0;
      for (const l of [houses, special]) if (l) for (const t of l.index.tilesInRect(rect)) cand += l.index.tileStart[t + 1] - l.index.tileStart[t];
      fs.buildingsCandidate = cand;
      if (cand <= BUILDING_BUDGET_MAX) {
        fs.buildingsDrawn = true;
        const full = cand <= BUILDING_BUDGET_FULL;
        const groups: [PolyLayer | undefined, string][] = [[houses, pal.farmRoof], [special, pal.inkSoft]];
        for (const [l, col] of groups) {
          if (!l) continue;
          const paths = polyPaths(l);
          if (lod.shadows && full) {
            ctx.save(); ctx.translate(1.6, 1.9);
            ctx.fillStyle = 'rgba(0,0,0,0.22)';
            for (const p of paths) ctx.fill(p, 'nonzero');
            ctx.restore();
          }
          ctx.fillStyle = col;
          for (const p of paths) ctx.fill(p, 'nonzero');
          if (full) {
            ctx.strokeStyle = pal.ink; ctx.lineWidth = lw(0.35, 0.6);
            for (const p of paths) ctx.stroke(p);
          }
        }
      }
    }
    if (lod.landmarks) {
      fillPolys('landmarks', pal.marker, 0.45);
      strokePolys('landmarks', pal.ink, lw(0.8, 0.8));
    }
    // walls
    const walls = linesOf((l) => l.role === 'wall');
    if (walls.length) {
      strokeLines(walls, pal.ink, (l) => lw(l.width, 2), 1, [], 'butt');
      if (lod.towers) {
        fillPolys('towers', pal.ink);
        fillPolys('gates', pal.roadFill);
        strokePolys('gates', pal.ink, lw(0.8, 0.8));
      }
    }

    // 6. bridges
    if (world.bridges?.length) drawBridges(ctx, world, pal, rect, sc);
    // site marker (placeholder until an urban layer exists)
    if (!world.urban && world.site) drawSiteMarker(ctx, world, pal, u, sc);

    // 7. map frame
    ctx.strokeStyle = pal.frame; ctx.lineWidth = lw(2 * u, 1.5); ctx.setLineDash([]);
    ctx.strokeRect(0, 0, S, S);

    // 8. labels (screen space)
    if (labels.length) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
    const water = (name: string, fill: string): void => {
      const l = polyL(name);
      if (!l) return;
      ctx.fillStyle = fill;
      for (const t of l.index.tilesInRect({ minX: 0, minY: 0, maxX: S, maxY: S })) {
        const p = cached(`${l.name}|0|t${t}`, () => polyPath(P, l, l.index.itemsOf(t), BAND_MIN_EDGE[0]));
        if (p) ctx.fill(p, 'nonzero');
      }
      for (const i of l.index.big) {
        const p = cached(`${l.name}|0|b${i}`, () => polyPath(P, l, [i], BAND_MIN_EDGE[0]));
        if (p) ctx.fill(p, 'nonzero');
      }
    };
    water('sea', pal.seaFill); water('lakes', pal.lakeFill); water('rivers', pal.riverFill);
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
    drawMinimap,
    lastStats: () => stats,
    dispose() { cache.clear(); terrainImg = densityImg = undefined; },
  };
}

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
