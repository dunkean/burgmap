/**
 * Render worker (R): owns the scene and the Canvas 2D renderer on an OffscreenCanvas.
 *
 * It receives World snapshots straight from the generation worker (never through the page), builds the Scene,
 * and answers `view` requests with an ImageBitmap that the page puts on screen (together with resetting its
 * CSS pan/zoom transform, so the swap is atomic). The page keeps at most one request in flight, so a busy
 * worker never accumulates a backlog: the latest view always wins.
 */
import { createCanvasRenderer, CanvasRenderer, CanvasLike } from '../render/canvas';
import { buildScene, Scene } from '../render/scene';
import { PALETTES } from '../render/styles';
import type { World } from '../gen/types';
import type { RRequest, RResponse, RView, DisplayOpts, WorldMsg, RAttach, PortMsg, SettlementMsg } from './protocol';

const ctx = self as unknown as Worker;
const post = (r: RResponse, transfer: Transferable[] = []): void => ctx.postMessage(r, transfer);

let canvas: OffscreenCanvas | null = null;
let miniCanvas: OffscreenCanvas | null = null;
let display: DisplayOpts = { style: 'parchment' };
let gen = -1;
let port: MessagePort | null = null;
let world: World | null = null;
let final = false;
let sceneCache: { world: World; contours: boolean; scene: Scene } | null = null;
let renderer: CanvasRenderer | null = null;
let curDpr = 1;
let ver = 0;
let miniDirty = true;
let miniSize = 0;
let lastView: RView | null = null;

function probe(): { ok: boolean; reason?: string } {
  try {
    if (typeof OffscreenCanvas === 'undefined') return { ok: false, reason: 'no OffscreenCanvas' };
    if (typeof Path2D === 'undefined') return { ok: false, reason: 'no Path2D' };
    const c = new OffscreenCanvas(8, 8);
    if (!c.getContext('2d')) return { ok: false, reason: 'no 2d context' };
    if (typeof c.transferToImageBitmap !== 'function') return { ok: false, reason: 'no transferToImageBitmap' };
    return { ok: true };
  } catch (e) { return { ok: false, reason: String((e as Error).message) }; }
}

/** (Re)build scene + renderer from the current snapshot and display options. */
function rebuild(): number {
  if (!world || !canvas) return 0;
  const t0 = performance.now();
  const w: World = { ...world, options: { ...world.options, style: display.style as never, contours: !!display.contours, landuse: !!display.landuse, labels: display.labels, legend: display.legend } };
  if (!sceneCache || sceneCache.world !== world || sceneCache.contours !== !!display.contours) {
    sceneCache = { world, contours: !!display.contours, scene: buildScene(w) };
  }
  renderer?.dispose();
  // `dpr` stays a live getter: the page's devicePixelRatio can change between frames
  renderer = createCanvasRenderer(canvas as unknown as CanvasLike, w, display.style, { scene: sceneCache.scene, get dpr(): number { return curDpr; } });
  renderer.setOverlays({ cartouche: final }); // the title block needs the names: skip it on partial snapshots
  miniDirty = true; ver++;
  return performance.now() - t0;
}

function announce(sceneMs: number): void {
  if (!world) return;
  const pal = PALETTES[display.style];
  post({ type: 'content', gen, ver, mapSize: world.mapSize, final, sceneMs, marker: pal.marker, paper: pal.paper });
}

function onWorld(m: WorldMsg): void {
  if (m.gen !== gen) return;
  world = m.world; final = m.final;
  sceneCache = null;
  announce(rebuild());
}

/** A lazily generated settlement plan (M3c): merged into the World, the scene is rebuilt. */
function onSettlement(m: SettlementMsg): void {
  if (m.gen !== gen || !world) return;
  const list = world.settlements ? world.settlements.slice() : [];
  if (!list[m.index]) return;
  list[m.index] = { ...list[m.index], urban: m.urban };
  world = { ...world, settlements: list, bridges: [...(world.bridges ?? []), ...m.bridges] };
  sceneCache = null;
  announce(rebuild());
}

function onAttach(m: RAttach): void {
  port?.close();
  gen = m.gen; port = m.port;
  port.onmessage = (e: MessageEvent<PortMsg>): void => {
    try { if (e.data.type === 'settlement') onSettlement(e.data); else onWorld(e.data as WorldMsg); } catch (err) { post({ type: 'error', error: String((err as Error)?.stack ?? err) }); }
  };
  // the previous world stays on screen until the first snapshot of the new one arrives
}

function onView(v: RView): void {
  lastView = v;
  curDpr = v.dpr;
  if (!renderer || !canvas) { post({ type: 'frame', seq: v.seq, ver, view: v.view, w: v.w, h: v.h, dpr: v.dpr, ms: 0, band: 0, scale: v.view.scale, labels: [] }); return; }
  const pw = Math.max(1, Math.round(v.w * v.dpr)), ph = Math.max(1, Math.round(v.h * v.dpr));
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  const st = renderer.draw(v.view);
  const bitmap = canvas.transferToImageBitmap();
  const out: Transferable[] = [bitmap];
  let mini: ImageBitmap | undefined;
  if (v.mini > 0 && (miniDirty || miniSize !== v.mini)) {
    if (!miniCanvas || miniCanvas.width !== v.mini) miniCanvas = new OffscreenCanvas(v.mini, v.mini);
    renderer.drawMinimap(miniCanvas as unknown as CanvasLike, v.view, v.w, v.h, false);
    mini = miniCanvas.transferToImageBitmap();
    out.push(mini);
    miniDirty = false; miniSize = v.mini;
  }
  const labels = renderer.lastPlaced().map((p) => ({ kind: p.label.kind, text: p.label.text, size: p.size }));
  post({ type: 'frame', seq: v.seq, ver, view: v.view, w: v.w, h: v.h, dpr: v.dpr, bitmap, mini, ms: st.ms, band: st.band, scale: st.scale, labels }, out);
}

ctx.onmessage = (e: MessageEvent<RRequest>): void => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init': {
        curDpr = m.dpr;
        const p = probe();
        if (p.ok) canvas = new OffscreenCanvas(1, 1);
        post({ type: 'ready', ok: p.ok, reason: p.reason });
        break;
      }
      case 'attach': onAttach(m); break;
      case 'display': {
        display = m.display;
        if (world) announce(rebuild());
        break;
      }
      case 'view': onView(m); break;
      case 'dispose': port?.close(); renderer?.dispose(); world = null; renderer = null; break;
    }
  } catch (err) {
    post({ type: 'error', error: String((err as Error)?.stack ?? err) });
    // never leave the page waiting for a frame
    if (m.type === 'view') post({ type: 'frame', seq: m.seq, ver, view: m.view, w: m.w, h: m.h, dpr: m.dpr, ms: 0, band: 0, scale: m.view.scale, labels: [] });
  }
};
void lastView;
