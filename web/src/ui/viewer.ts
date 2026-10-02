/**
 * Pan/zoom viewer.
 * Drag + touch pan, wheel zoom toward cursor, pinch, double-click zoom, keyboard (+ - 0 arrows),
 * fit-to-map, devicePixelRatio aware, work only when dirty (requestAnimationFrame).
 *
 * Two drawing modes:
 *  - sync (fallback): a CanvasRenderer on this thread draws every dirty frame (`setRenderer`).
 *  - async (default when OffscreenCanvas works): a render worker draws frames (`setSource`). The page shows the
 *    last delivered bitmap and moves/scales it with a CSS transform to follow the current view at once (compositor
 *    only, so panning and zooming stay at the display rate however long a real frame takes); at most one frame
 *    request is in flight and the newest view always wins. When a fresh bitmap arrives it replaces the old one and
 *    the transform is recomputed in the same task, so the swap is seamless.
 * Optional minimap canvas (drawn by the renderer, or from a base bitmap + the view rectangle).
 */
import type { CanvasRenderer } from '../render/canvas';
import { View, fitView, clampView, zoomAt, panBy, viewRect } from '../render/view';

export interface ViewerOptions {
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  minimap?: HTMLCanvasElement;
  onFrame?: (ms: number, band: number, scale: number) => void;
}

export interface FrameRequest { seq: number; view: View; w: number; h: number; dpr: number; /** minimap size in device px */ mini: number }
export interface FrameSource { request(r: FrameRequest): void }
export interface PresentedFrame {
  seq: number; ver?: number; view: View; w: number; h: number; dpr: number;
  bitmap?: ImageBitmap; mini?: ImageBitmap; ms: number; band: number; scale: number;
}

export interface Viewer {
  setRenderer(r: CanvasRenderer, mapSize: number, keepView?: boolean): void;
  /** Async mode: frames come from `src` (a worker); call `present` for every answer. */
  setSource(src: FrameSource): void;
  present(f: PresentedFrame): void;
  /** The drawn content changed (new world snapshot, style...): request a new frame; refit if the map size changed (or `keepView` is false). */
  contentChanged(mapSize: number, keepView: boolean, markerColor?: string): void;
  fit(): void;
  /** Set the view directly (clamped). Debug / scripted screenshots. */
  setView(v: View): void;
  zoomBy(factor: number): void;
  invalidate(): void;
  getView(): View;
  destroy(): void;
}

const sameView = (a: View, b: View): boolean => a.cx === b.cx && a.cy === b.cy && a.scale === b.scale;

export function createViewer(o: ViewerOptions): Viewer {
  const { container, canvas, minimap } = o;
  let renderer: CanvasRenderer | null = null;
  let source: FrameSource | null = null;
  let mapSize = 1000;
  let view: View = { cx: 500, cy: 500, scale: 0.5 };
  let w = 1, h = 1, dpr = 1;
  let dirty = false, raf = 0, destroyed = false;
  // async mode state
  let bmCtx: ImageBitmapRenderingContext | null = null;
  let shown: { view: View; w: number; h: number } | null = null;
  let req: { view: View; w: number; h: number; dpr: number } | null = null;
  let seq = 0, inflight = 0, force = false;
  let miniBase: ImageBitmap | null = null, marker = '#a33';

  const size = (): void => {
    const r = container.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    w = Math.max(1, Math.round(r.width)); h = Math.max(1, Math.round(r.height));
    if (!source) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    }
    if (minimap) {
      const mw = Math.round(minimap.clientWidth || 140);
      const px = Math.round(mw * dpr);
      if (minimap.width !== px) { minimap.width = px; minimap.height = px; miniBase = null; force = true; } // the worker redraws it at the new size
    }
  };
  const invalidate = (): void => {
    dirty = true;
    if (!raf && !destroyed) raf = requestAnimationFrame(frame);
  };

  /** Pan/zoom the displayed bitmap to the current view (CSS transform: compositor only). */
  function applyTransform(): void {
    if (!shown) return;
    if (sameView(shown.view, view) && shown.w === w && shown.h === h) { canvas.style.transform = ''; return; }
    const k = view.scale / shown.view.scale;
    const tx = (shown.view.cx - view.cx) * view.scale + (w - shown.w) / 2;
    const ty = (shown.view.cy - view.cy) * view.scale + (h - shown.h) / 2;
    canvas.style.transform = `translate(${tx.toFixed(2)}px,${ty.toFixed(2)}px) scale(${k})`;
  }
  function drawMiniOverlay(): void {
    if (!minimap || !miniBase) return;
    const ctx = minimap.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, minimap.width, minimap.height);
    ctx.drawImage(miniBase, 0, 0, minimap.width, minimap.height);
    const k = minimap.width / mapSize, r = viewRect(view, w, h, 0);
    ctx.strokeStyle = marker; ctx.lineWidth = 1.5;
    ctx.strokeRect(r.minX * k, r.minY * k, (r.maxX - r.minX) * k, (r.maxY - r.minY) * k);
  }
  function sendRequest(): void {
    if (!source) return;
    const changed = !req || req.w !== w || req.h !== h || req.dpr !== dpr || !sameView(req.view, view);
    if (inflight || !(force || changed)) return;
    force = false;
    req = { view: { ...view }, w, h, dpr };
    inflight = ++seq;
    source.request({ seq: inflight, view: req.view, w, h, dpr, mini: minimap ? minimap.width : 0 });
  }

  function frame(): void {
    raf = 0;
    if (!dirty) return;
    dirty = false;
    view = clampView(view, mapSize, w, h);
    if (source) {
      applyTransform();
      drawMiniOverlay();
      sendRequest();
      return;
    }
    if (!renderer) return;
    const st = renderer.draw(view);
    if (minimap) renderer.drawMinimap(minimap, view, w, h);
    o.onFrame?.(st.ms, st.band, view.scale);
  }
  const set = (v: View): void => { view = clampView(v, mapSize, w, h); invalidate(); };
  const fit = (): void => set(fitView(mapSize, w, h));
  const zoomBy = (f: number, sx = w / 2, sy = h / 2): void => set(zoomAt(view, f, sx, sy, w, h));

  size();
  const ro = new ResizeObserver(() => { size(); invalidate(); });
  ro.observe(container);

  // --- pointers (drag = pan, two pointers = pinch) ---
  const pts = new Map<number, { x: number; y: number }>();
  let pinch: { d: number } | null = null;
  const local = (e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } => {
    const r = container.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const dist = (): number => {
    const [a, b] = [...pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const mid = (): { x: number; y: number } => {
    const [a, b] = [...pts.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  canvas.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, local(e));
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('drag');
    if (pts.size === 2) pinch = { d: dist() };
  });
  canvas.addEventListener('pointermove', (e) => {
    const prev = pts.get(e.pointerId);
    if (!prev) return;
    const cur = local(e);
    if (pts.size === 2 && pinch) {
      const m0 = mid();
      pts.set(e.pointerId, cur);
      const m1 = mid(), d = dist();
      let v = panBy(view, m1.x - m0.x, m1.y - m0.y);
      if (pinch.d > 0 && d > 0) v = zoomAt(v, d / pinch.d, m1.x, m1.y, w, h);
      pinch.d = d;
      set(v);
    } else {
      pts.set(e.pointerId, cur);
      set(panBy(view, cur.x - prev.x, cur.y - prev.y));
    }
  });
  const up = (e: PointerEvent): void => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (!pts.size) canvas.classList.remove('drag');
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = local(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    zoomBy(Math.exp(-dy * 0.0015), p.x, p.y);
  }, { passive: false });
  canvas.addEventListener('dblclick', (e) => {
    const p = local(e);
    zoomBy(e.shiftKey ? 0.5 : 2, p.x, p.y);
  });
  const key = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    switch (e.key) {
      case '+': case '=': zoomBy(1.4); break;
      case '-': case '_': zoomBy(1 / 1.4); break;
      case '0': fit(); break;
      case 'ArrowLeft': set(panBy(view, 80, 0)); break;
      case 'ArrowRight': set(panBy(view, -80, 0)); break;
      case 'ArrowUp': set(panBy(view, 0, 80)); break;
      case 'ArrowDown': set(panBy(view, 0, -80)); break;
      default: return;
    }
    e.preventDefault();
  };
  window.addEventListener('keydown', key);

  // minimap click = recenter
  const mini = (e: PointerEvent): void => {
    if (!minimap || !(e.buttons & 1)) return;
    const r = minimap.getBoundingClientRect();
    set({ ...view, cx: ((e.clientX - r.left) / r.width) * mapSize, cy: ((e.clientY - r.top) / r.height) * mapSize });
  };
  minimap?.addEventListener('pointerdown', (e) => { minimap.setPointerCapture(e.pointerId); mini(e); });
  minimap?.addEventListener('pointermove', mini);

  return {
    setRenderer(r, size2, keepView = false) {
      renderer?.dispose();
      const sizeChanged = size2 !== mapSize;
      renderer = r; mapSize = size2;
      if (!keepView || sizeChanged) view = fitView(mapSize, w, h);
      invalidate();
    },
    setSource(src) { source = src; force = true; },
    present(f) {
      if (f.seq === inflight) inflight = 0;
      if (f.mini) { miniBase?.close(); miniBase = f.mini; }
      if (f.bitmap) {
        bmCtx ??= canvas.getContext('bitmaprenderer');
        if (bmCtx) {
          bmCtx.transferFromImageBitmap(f.bitmap); // sets the canvas size to the bitmap's (w*dpr x h*dpr)
          canvas.style.width = f.w + 'px'; canvas.style.height = f.h + 'px';
          shown = { view: f.view, w: f.w, h: f.h };
          applyTransform();
          o.onFrame?.(f.ms, f.band, f.scale);
        }
      }
      drawMiniOverlay();
      invalidate(); // sends the next request if the view moved meanwhile
    },
    contentChanged(size2, keepView, markerColor) {
      const sizeChanged = size2 !== mapSize;
      mapSize = size2;
      if (markerColor) marker = markerColor;
      if (!keepView || sizeChanged) view = fitView(mapSize, w, h);
      force = true;
      invalidate();
    },
    fit, setView: set, zoomBy: (f) => zoomBy(f), invalidate,
    getView: () => view,
    destroy() {
      destroyed = true; ro.disconnect(); window.removeEventListener('keydown', key);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
