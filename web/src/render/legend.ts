import { cavernWallFill } from './caverns';
import { isUnderdarkBiome } from '../gen/biomes';
/**
 * Cartouche (town name, population, scale bar) and legend (land use + urban symbology per style),
 * described once as drawing primitives in a pixel-like coordinate system. `drawPanelCanvas` paints
 * them on the interactive canvas, `panelSvg` emits the same thing for the SVG export.
 */
import type { World } from '../gen/types';
import type { Palette, MapStyle } from './styles';
import { FONT_STACKS } from './labelStyles';
import { SETTLEMENT_CLASS } from '../gen/names';
import { NameFamily } from '../gen/names/types';
import { underdarkMark } from './underdark';

export type Prim =
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; sw?: number; op?: number }
  | { t: 'line'; pts: [number, number][]; stroke: string; sw: number; dash?: number[]; op?: number }
  | { t: 'poly'; pts: [number, number][]; fill?: string; stroke?: string; sw?: number; op?: number }
  | { t: 'circle'; x: number; y: number; r: number; fill?: string; stroke?: string; sw?: number; op?: number }
  | { t: 'text'; x: number; y: number; s: string; size: number; anchor: 'start' | 'middle' | 'end'; fill: string; italic?: boolean; bold?: boolean; caps?: boolean; spacing?: number };
export interface Panel { w: number; h: number; prims: Prim[] }
export interface MapInformation { cartouche: Panel; legend: Panel; fontFamily: string }
/** Interactive viewport dimensions are CSS pixels, independent of its backing-store DPR. */
export const compactMapPanels = (w: number, h: number): boolean => w <= 640 || h <= 360;

const NICE = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
/** A round length (m) whose on-screen size is close to `targetPx` at `pxPerM`. */
export function niceLength(pxPerM: number, targetPx = 120): number {
  let best = NICE[0];
  for (const n of NICE) if (n * pxPerM <= targetPx * 1.25) best = n;
  return best;
}
/** 12345 -> "12 345" (narrow no-break space), independent of the runtime locale. */
export function fmtPop(n: number): string {
  const r = Math.round(n);
  const s = String(Math.abs(r));
  return (r < 0 ? '-' : '') + s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
const round2 = (n: number): number => (n >= 1000 ? Math.round(n / 100) * 100 : n >= 100 ? Math.round(n / 10) * 10 : n);

export function townTitle(world: World): { title: string; sub: string } {
  if (world.options.workflow === 'environment') return { title: 'Landscape', sub: `${fmtPop(world.mapSize)} m · ${world.options.biome ?? 'temperate'}` };
  const fam: NameFamily = world.names?.family ?? 'english';
  const pop = world.urban?.population;
  const cls = SETTLEMENT_CLASS(fam, pop ?? 0);
  const title = world.names?.town ?? 'Burgmap';
  const sub = pop ? `${cls} - ${fmtPop(round2(pop))} inhabitants` : cls;
  return { title, sub };
}

/** Panel background and border (double rule; gold corner studs on ornate styles). */
function panelFrame(pal: Palette, W: number, H: number): Prim[] {
  const c = pal.cart;
  const out: Prim[] = [
    { t: 'rect', x: 0, y: 0, w: W, h: H, fill: c.fill, stroke: c.stroke, sw: 1.4, op: c.op },
    { t: 'rect', x: 3.5, y: 3.5, w: W - 7, h: H - 7, stroke: c.ornate ? c.accent : c.stroke, sw: c.ornate ? 1 : 0.6 },
  ];
  if (c.ornate) {
    for (const [cx, cy] of [[0, 0], [W, 0], [0, H], [W, H]]) {
      out.push({ t: 'poly', pts: [[cx, cy - 7], [cx + 7, cy], [cx, cy + 7], [cx - 7, cy]], fill: pal.accent, stroke: pal.frame, sw: 0.8 });
    }
    out.push({ t: 'poly', pts: [[W / 2, -5], [W / 2 + 5, 0], [W / 2, 5], [W / 2 - 5, 0]], fill: pal.accent, stroke: pal.frame, sw: 0.7 });
    out.push({ t: 'poly', pts: [[W / 2, H - 5], [W / 2 + 5, H], [W / 2, H + 5], [W / 2 - 5, H]], fill: pal.accent, stroke: pal.frame, sw: 0.7 });
  }
  return out;
}

export function cartoucheModel(world: World, pal: Palette, pxPerM: number, includeScale = true): Panel {
  const { title, sub } = townTitle(world);
  const W = 244;
  const L = niceLength(pxPerM, 112);
  const barW = Math.max(24, L * pxPerM);
  const prims: Prim[] = [];
  const H = includeScale ? 104 : 76;
  const titleChars = Array.from(title.toUpperCase());
  const titleUnits = titleChars.reduce((sum, ch) => sum + (ch === ' ' ? 0.4 : /[MW@%]/.test(ch) ? 1 : /[I|!1.,:'’]/.test(ch) ? 0.5 : 0.9), 0);
  const titleSize = Math.min(title.length > 12 ? 19 : 24, (W - 24 - Math.max(0, titleChars.length - 1) * 1.2) / Math.max(1, titleUnits));
  prims.push(...panelFrame(pal, W, H));
  prims.push({ t: 'text', x: W / 2, y: 33, s: title, size: Math.max(6, titleSize), anchor: 'middle', fill: pal.lab.town, bold: true, caps: true, spacing: 1.2 });
  prims.push({ t: 'text', x: W / 2, y: 50, s: sub, size: 11.5, anchor: 'middle', fill: pal.inkSoft, italic: true });
  // scale bar
  if (includeScale) {
  const x0 = (W - barW) / 2, y0 = 76, bh = 5;
  const seg = 4;
  for (let i = 0; i < seg; i++) prims.push({ t: 'rect', x: x0 + (barW * i) / seg, y: y0, w: barW / seg, h: bh, fill: i % 2 ? pal.paper : pal.ink, stroke: pal.ink, sw: 0.7 });
  prims.push({ t: 'text', x: x0, y: y0 - 4, s: '0', size: 10, anchor: 'middle', fill: pal.ink });
  prims.push({ t: 'text', x: x0 + barW / 2, y: y0 - 4, s: String(L / 2), size: 10, anchor: 'middle', fill: pal.ink });
  prims.push({ t: 'text', x: x0 + barW, y: y0 - 4, s: L >= 1000 ? `${L / 1000} km` : `${L} m`, size: 10, anchor: 'middle', fill: pal.ink });
  }
  prims.push({ t: 'text', x: W / 2, y: H - 9, s: `seed ${world.seed}`, size: 9, anchor: 'middle', fill: pal.inkSoft, italic: true });
  return { w: W, h: H, prims };
}

/** The only map overlay on compact screens; its scale follows the actual view. */
export function compactScaleModel(pal: Palette, pxPerM: number): Panel {
  const L = niceLength(pxPerM, 80), bw = L * pxPerM;
  const W = Math.max(60, bw + 20), H = 28;
  const prims: Prim[] = [{ t: 'rect', x: 0, y: 0, w: W, h: H, fill: pal.cart.fill, op: pal.cart.op }];
  prims.push({ t: 'text', x: 8, y: 11, s: '0', size: 9, anchor: 'start', fill: pal.ink },
    { t: 'text', x: bw + 8, y: 11, s: L >= 1000 ? `${L / 1000} km` : `${L} m`, size: 9, anchor: 'end', fill: pal.ink });
  for (let i = 0; i < 4; i++) prims.push({ t: 'rect', x: 8 + bw * i / 4, y: 17, w: bw / 4, h: 4, fill: i % 2 ? pal.paper : pal.ink, stroke: pal.ink, sw: .6 });
  return { w: W, h: H, prims };
}

interface Item { label: string; draw: (x: number, y: number) => Prim[] }

const SW = 24, SH = 12;

function fillSwatch(fill: string, stroke?: string, op = 1, lines?: string): (x: number, y: number) => Prim[] {
  return (x, y) => [{ t: 'rect', x, y, w: SW, h: SH, fill, stroke, sw: 0.7, op }, ...(lines ? [3, 6, 9].map((d): Prim => ({ t: 'line', pts: [[x + 1, y + d], [x + SW - 1, y + d]], stroke: lines, sw: 0.5, op: 0.7 })) : [])];
}
/** Tree symbol per style: blob, drawn crown (circle + shadow arc + trunk) or a small dot. */
function treeSymbol(pal: Palette, x: number, y: number, r: number): Prim[] {
  if (pal.treeShape === 'crown') {
    return [
      { t: 'circle', x, y, r, fill: pal.treeFill, stroke: pal.treeInk, sw: 0.6 },
      { t: 'line', pts: [[x + r * 0.5, y - r * 0.5], [x + r * 0.75, y], [x + r * 0.5, y + r * 0.5], [x, y + r * 0.75], [x - r * 0.5, y + r * 0.5]], stroke: pal.treeInk, sw: 0.5 },
      { t: 'line', pts: [[x, y + r], [x, y + r * 1.5]], stroke: pal.treeInk, sw: 0.6 },
    ];
  }
  const rr = pal.treeShape === 'dot' ? r * 0.55 : r;
  return [{ t: 'circle', x, y, r: rr, fill: pal.treeFill, stroke: pal.treeInk, sw: 0.6 }];
}
function lineSwatch(edge: string, fill: string | null, w: number, dash?: number[]): (x: number, y: number) => Prim[] {
  return (x, y) => {
    const pts: [number, number][] = [[x, y + SH / 2], [x + SW, y + SH / 2]];
    const out: Prim[] = [{ t: 'line', pts, stroke: edge, sw: w + 2, dash }];
    if (fill) out.push({ t: 'line', pts, stroke: fill, sw: w });
    return out;
  };
}

export function legendModel(world: World, pal: Palette): Panel {
  const underground = isUnderdarkBiome(world.options.biome);
  const U = pal.urban;
  const items: Item[] = [];
  const add = (label: string, draw: Item['draw']): void => { items.push({ label, draw }); };
  const kinds = new Set(world.landuse?.areas.map((a) => a.kind) ?? []);
  if (world.options.biome === 'underdark-caverns' && world.terrain.caverns?.fungalRooms?.length) kinds.add('garden');
  const lu = world.options.landuse;
  const t = world.terrain;
  if (t.caverns) add('Cavern walls', fillSwatch(cavernWallFill(pal), pal.treeInk, 1));
  if (t.coastline.length) add(underground ? 'Underground basin' : 'Sea', fillSwatch(pal.seaFill, pal.waterEdge, 1, pal.waterLines?.color));
  if (t.lakes.length) add(underground ? 'Underground lake' : 'Lake', fillSwatch(pal.lakeFill, pal.waterEdge, 1, pal.waterLines?.color));
  if (t.rivers.length) add('River', (x, y) => [{ t: 'line', pts: [[x, y + 9], [x + 8, y + 3], [x + 16, y + 9], [x + SW, y + 3]], stroke: pal.riverEdge, sw: 4.6 }, { t: 'line', pts: [[x, y + 9], [x + 8, y + 3], [x + 16, y + 9], [x + SW, y + 3]], stroke: pal.riverFill, sw: 3 }]);
  if (lu) {
    if (underground) {
      const swatch = (kind: 'commons' | 'garden' | 'marsh') => (x: number, y: number): Prim[] => [
        { t: 'rect', x, y, w: SW, h: SH, fill: pal.land[kind] },
        ...[[5, 5], [12, 8], [19, 4]].flatMap(([dx, dy]) => underdarkMark(kind, x + dx, y + dy, 2, pal)),
      ];
      if (kinds.has('commons')) add('Rock', swatch('commons'));
      if (kinds.has('garden') || kinds.has('field') || kinds.has('orchard')) add('Fungal cultivation', swatch('garden'));
      if (kinds.has('marsh') || kinds.has('forest')) add('Wet fungi', swatch('marsh'));
      if (kinds.has('meadow') || kinds.has('pasture')) add('Lichen', (x, y) => underdarkMark('meadow', x + 12, y + 6, 3, pal));
    } else {
    if (kinds.has('field')) add('Fields (strips)', (x, y) => [{ t: 'rect', x, y, w: SW, h: SH, fill: pal.land.field, stroke: pal.hedge, sw: 0.7 }, ...[3, 6, 9].map((d): Prim => ({ t: 'line', pts: [[x + 1, y + d], [x + SW - 1, y + d]], stroke: pal.furrow, sw: 0.6, op: 0.7 }))]);
    if (kinds.has('meadow')) add('Meadow', fillSwatch(pal.land.meadow, undefined, 0.9));
    if (kinds.has('pasture')) add('Pasture', fillSwatch(pal.land.pasture, undefined, 0.9));
    if (kinds.has('commons')) add(world.options.biome === 'desert' ? 'Bare ground, scrub' : world.options.biome === 'tundra' ? 'Heath, exposed ground' : 'Commons', fillSwatch(pal.land.commons, undefined, 0.9));
    if (kinds.has('forest')) add('Woodland', (x, y) => [{ t: 'rect', x, y, w: SW, h: SH, fill: pal.land.forest }, ...[[6, 4], [13, 8], [19, 4], [9, 8]].flatMap(([dx, dy]) => treeSymbol(pal, x + dx, y + dy, 2.4))]);
    if (kinds.has('orchard')) add('Orchard', (x, y) => [{ t: 'rect', x, y, w: SW, h: SH, fill: pal.land.orchard }, ...[[6, 4], [12, 4], [18, 4], [6, 9], [12, 9], [18, 9]].flatMap(([dx, dy]) => treeSymbol(pal, x + dx, y + dy, 1.7))]);
    if (kinds.has('marsh')) add('Marsh', (x, y) => [{ t: 'rect', x, y, w: SW, h: SH, fill: pal.land.marsh }, ...[5, 12, 19].map((dx): Prim => ({ t: 'line', pts: [[x + dx - 2, y + 8], [x + dx + 2, y + 8]], stroke: pal.reed, sw: 0.9 }))]);
    if (kinds.has('garden')) add('Gardens', fillSwatch(pal.land.garden, undefined, 0.9));
    }
  }
  if (world.roads?.some((r) => r.kind !== 'track')) add('Road', lineSwatch(pal.roadEdge, pal.roadFill, 3.2));
  if (world.roads?.some((r) => r.kind === 'track')) add('Track', (x, y) => [{ t: 'line', pts: [[x, y + SH / 2], [x + SW, y + SH / 2]], stroke: pal.roadEdge, sw: 1.3, dash: [4, 3] }]);
  if (world.bridges?.length) add('Bridge', (x, y) => [{ t: 'rect', x: x + 6, y: y + 1, w: 12, h: SH - 2, fill: pal.bridgeDeck, stroke: pal.bridgeInk, sw: 0.8 }]);
  if (world.urban) {
    add('Streets', lineSwatch(U.streetEdge, U.street, 3.4));
    add('Houses', (x, y) => {
      const sw = Math.max(0.5, U.massEdgeW * 1.7);
      const out: Prim[] = [{ t: 'rect', x, y, w: SW, h: SH, fill: U.yard }];
      if (U.shadow) out.push({ t: 'rect', x: x + 3.6, y: y + 3.8, w: 9, h: 8, fill: U.shadow.color, op: 0.7 }, { t: 'rect', x: x + 14.6, y: y + 4.8, w: 8, h: 7, fill: U.shadow.color, op: 0.7 });
      out.push({ t: 'rect', x: x + 2, y: y + 2, w: 9, h: 8, fill: U.mass, stroke: U.massEdge, sw }, { t: 'rect', x: x + 13, y: y + 3, w: 8, h: 7, fill: U.mass, stroke: U.massEdge, sw });
      if (U.lit) out.push({ t: 'circle', x: x + 5, y: y + 5.5, r: 1, fill: U.lit.color }, { t: 'circle', x: x + 17, y: y + 6, r: 1, fill: U.lit.color });
      return out;
    });
    if (U.plotAlpha >= 0.6) add('Plot boundaries', (x, y) => [{ t: 'rect', x, y, w: SW, h: SH, fill: U.yard }, { t: 'line', pts: [[x, y + 4], [x + SW, y + 4]], stroke: U.plotLine, sw: 0.6 }, { t: 'line', pts: [[x + 8, y], [x + 8, y + SH]], stroke: U.plotLine, sw: 0.6 }, { t: 'line', pts: [[x + 16, y + 4], [x + 16, y + SH]], stroke: U.plotLine, sw: 0.6 }]);
    if (world.urban.buildings.some((b) => b.kind === 'church') || world.urban.landmarks.some((l) => /church|cathedral/.test(l.kind))) {
      add('Church', (x, y) => [{ t: 'rect', x: x + 4, y: y + 1, w: 16, h: SH - 2, fill: U.landmark, stroke: U.landmarkEdge, sw: 0.9 }, { t: 'line', pts: [[x + 12, y + 3], [x + 12, y + 9]], stroke: U.landmarkEdge, sw: 0.9 }, { t: 'line', pts: [[x + 9.5, y + 5.2], [x + 14.5, y + 5.2]], stroke: U.landmarkEdge, sw: 0.9 }]);
    }
    if (world.urban.squares.length || world.urban.landmarks.some((l) => l.kind === 'market' || l.kind === 'green')) add('Market place, green', fillSwatch(U.place, U.placeInk, 1));
    add(underground ? 'Fungal beds, yards' : 'Gardens, yards', (x, y) => underground ? [{ t: 'rect', x, y, w: SW, h: SH, fill: U.garden }, ...underdarkMark('garden', x + 8, y + 6, 2.4, pal), ...underdarkMark('garden', x + 17, y + 6, 2.4, pal)] : [{ t: 'rect', x, y, w: SW, h: SH, fill: U.garden }, { t: 'line', pts: [[x + 3, y + 4], [x + 11, y + 4]], stroke: U.gardenInk, sw: 0.8 }, { t: 'line', pts: [[x + 11, y + 8], [x + 19, y + 8]], stroke: U.gardenInk, sw: 0.8 }]);
    if (world.urban.walls?.length) add('Town wall, gate', (x, y) => [{ t: 'line', pts: [[x, y + SH / 2], [x + 9, y + SH / 2]], stroke: U.wall, sw: 3.4 * U.wallScale + 1.6 }, { t: 'line', pts: [[x, y + SH / 2], [x + 9, y + SH / 2]], stroke: U.wallFill, sw: 3.4 * U.wallScale }, { t: 'line', pts: [[x + 15, y + SH / 2], [x + SW, y + SH / 2]], stroke: U.wall, sw: 3.4 * U.wallScale + 1.6 }, { t: 'line', pts: [[x + 15, y + SH / 2], [x + SW, y + SH / 2]], stroke: U.wallFill, sw: 3.4 * U.wallScale }, { t: 'circle', x: x + 9, y: y + SH / 2, r: 2.4, fill: U.wallFill, stroke: U.wall, sw: 0.8 }, { t: 'circle', x: x + 15, y: y + SH / 2, r: 2.4, fill: U.wallFill, stroke: U.wall, sw: 0.8 }]);
  }
  if (world.options.contours) add('Contour (index heavier)', (x, y) => [{ t: 'line', pts: [[x, y + 9], [x + 10, y + 3], [x + SW, y + 7]], stroke: pal.contour, sw: 0.9, op: pal.contourOpacity + 0.2 }]);
  if (world.landuse?.farmsteads.length) add('Farmstead', (x, y) => [{ t: 'rect', x: x + 4, y: y + 2, w: 7, h: 6, fill: pal.farmRoof, stroke: pal.farmInk, sw: 0.7 }, { t: 'rect', x: x + 13, y: y + 4, w: 6, h: 5, fill: pal.farmRoof, stroke: pal.farmInk, sw: 0.7 }]);

  const cols = items.length > 9 ? 2 : 1;
  const rows = Math.ceil(items.length / cols);
  const colW = 158, rowH = 17, pad = 10, head = 22;
  const W = pad * 2 + colW * cols - (cols > 1 ? 6 : 0) + (cols === 1 ? -20 : 0);
  const H = head + rows * rowH + pad + 4;
  const prims: Prim[] = [
    ...panelFrame(pal, W, H),
    { t: 'text', x: pad + 3, y: 17, s: 'Legend', size: 12, anchor: 'start', fill: pal.lab.town, bold: true, caps: true, spacing: 1.1 },
  ];
  items.forEach((it, i) => {
    const c = Math.floor(i / rows), r = i % rows;
    const x = pad + 3 + c * colW, y = head + 2 + r * rowH;
    prims.push(...it.draw(x, y));
    prims.push({ t: 'text', x: x + SW + 7, y: y + 10, s: it.label, size: 11, anchor: 'start', fill: pal.ink });
  });
  return { w: W, h: H, prims };
}

/* ---------------------------------------------------------------- renderers */
export function drawPanelCanvas(ctx: CanvasRenderingContext2D, panel: Panel, ox: number, oy: number, family: string): void {
  ctx.save();
  ctx.translate(ox, oy);
  ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
  for (const p of panel.prims) {
    ctx.globalAlpha = 'op' in p && p.op !== undefined ? p.op : 1;
    if (p.t === 'rect') {
      if (p.fill) { ctx.fillStyle = p.fill; ctx.fillRect(p.x, p.y, p.w, p.h); }
      if (p.stroke) { ctx.strokeStyle = p.stroke; ctx.lineWidth = p.sw ?? 1; ctx.strokeRect(p.x, p.y, p.w, p.h); }
    } else if (p.t === 'line') {
      ctx.strokeStyle = p.stroke; ctx.lineWidth = p.sw; ctx.setLineDash(p.dash ?? []);
      ctx.beginPath(); p.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); ctx.setLineDash([]);
    } else if (p.t === 'poly') {
      ctx.beginPath(); p.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
      if (p.fill) { ctx.fillStyle = p.fill; ctx.fill(); }
      if (p.stroke) { ctx.strokeStyle = p.stroke; ctx.lineWidth = p.sw ?? 1; ctx.stroke(); }
    } else if (p.t === 'circle') {
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      if (p.fill) { ctx.fillStyle = p.fill; ctx.fill(); }
      if (p.stroke) { ctx.strokeStyle = p.stroke; ctx.lineWidth = p.sw ?? 1; ctx.stroke(); }
    } else {
      ctx.globalAlpha = 1;
      ctx.font = `${p.italic ? 'italic ' : ''}${p.bold ? '600 ' : ''}${p.size}px ${family}`;
      ctx.fillStyle = p.fill; ctx.textBaseline = 'alphabetic';
      const s = p.caps ? p.s.toUpperCase() : p.s;
      if (p.spacing) {
        // manual letter spacing (canvas letterSpacing is not universal)
        let w = 0;
        for (const ch of s) w += ctx.measureText(ch).width + p.spacing;
        w -= p.spacing;
        let x = p.anchor === 'middle' ? p.x - w / 2 : p.anchor === 'end' ? p.x - w : p.x;
        ctx.textAlign = 'left';
        for (const ch of s) { ctx.fillText(ch, x, p.y); x += ctx.measureText(ch).width + p.spacing; }
      } else {
        ctx.textAlign = p.anchor === 'middle' ? 'center' : p.anchor;
        ctx.fillText(s, p.x, p.y);
      }
    }
  }
  ctx.restore();
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n1 = (v: number): string => String(Math.round(v * 100) / 100);

/** SVG group for a panel placed at (ox, oy) with uniform scale k (meters per panel px). */
export function panelSvg(panel: Panel, ox: number, oy: number, k: number, family: string, cls: string): string {
  let s = `<g class="${cls}" transform="translate(${n1(ox)} ${n1(oy)}) scale(${n1(k)})" font-family="${esc(family)}">`;
  for (const p of panel.prims) {
    const op = 'op' in p && p.op !== undefined && p.op !== 1 ? ` opacity="${p.op}"` : '';
    if (p.t === 'rect') s += `<rect x="${n1(p.x)}" y="${n1(p.y)}" width="${n1(p.w)}" height="${n1(p.h)}" fill="${p.fill ?? 'none'}"${p.stroke ? ` stroke="${p.stroke}" stroke-width="${p.sw ?? 1}"` : ''}${op}/>`;
    else if (p.t === 'line') s += `<path d="${p.pts.map(([x, y], i) => (i ? 'L' : 'M') + n1(x) + ' ' + n1(y)).join('')}" fill="none" stroke="${p.stroke}" stroke-width="${p.sw}"${p.dash ? ` stroke-dasharray="${p.dash.join(' ')}"` : ''}${op}/>`;
    else if (p.t === 'poly') s += `<path d="${p.pts.map(([x, y], i) => (i ? 'L' : 'M') + n1(x) + ' ' + n1(y)).join('')}Z" fill="${p.fill ?? 'none'}"${p.stroke ? ` stroke="${p.stroke}" stroke-width="${p.sw ?? 1}"` : ''}${op}/>`;
    else if (p.t === 'circle') s += `<circle cx="${n1(p.x)}" cy="${n1(p.y)}" r="${p.r}" fill="${p.fill ?? 'none'}"${p.stroke ? ` stroke="${p.stroke}" stroke-width="${p.sw ?? 1}"` : ''}${op}/>`;
    else {
      s += `<text x="${n1(p.x)}" y="${n1(p.y)}" font-size="${p.size}" text-anchor="${p.anchor}" fill="${p.fill}"${p.italic ? ' font-style="italic"' : ''}${p.bold ? ' font-weight="600"' : ''}${p.spacing ? ` letter-spacing="${p.spacing}"` : ''}>${esc(p.caps ? p.s.toUpperCase() : p.s)}</text>`;
    }
  }
  return s + '</g>';
}

export const panelFont = (style: MapStyle): string => FONT_STACKS[style];
