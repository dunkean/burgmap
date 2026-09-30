/**
 * Pan/zoom viewer around a CanvasRenderer.
 * Drag + touch pan, wheel zoom toward cursor, pinch, double-click zoom, keyboard (+ - 0 arrows),
 * fit-to-map, devicePixelRatio aware, redraw through requestAnimationFrame only when dirty.
 * Optional minimap canvas drawn from the renderer.
 */
import type { CanvasRenderer } from '../render/canvas';
import { View, fitView, clampView, zoomAt, panBy } from '../render/view';

export interface ViewerOptions {
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  minimap?: HTMLCanvasElement;
  onFrame?: (ms: number, band: number, scale: number) => void;
}

export interface Viewer {
  setRenderer(r: CanvasRenderer, mapSize: number, keepView?: boolean): void;
  fit(): void;
  /** Set the view directly (clamped). Debug / scripted screenshots. */
  setView(v: View): void;
  zoomBy(factor: number): void;
  invalidate(): void;
  getView(): View;
  destroy(): void;
}

export function createViewer(o: ViewerOptions): Viewer {
  const { container, canvas, minimap } = o;
  let renderer: CanvasRenderer | null = null;
  let mapSize = 1000;
  let view: View = { cx: 500, cy: 500, scale: 0.5 };
  let w = 1, h = 1, dpr = 1;
  let dirty = false, raf = 0, destroyed = false;

  const size = (): void => {
    const r = container.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    w = Math.max(1, Math.round(r.width)); h = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    if (minimap) {
      const mw = Math.round(minimap.clientWidth || 140);
      minimap.width = Math.round(mw * dpr); minimap.height = Math.round(mw * dpr);
    }
  };
  const invalidate = (): void => {
    dirty = true;
    if (!raf && !destroyed) raf = requestAnimationFrame(frame);
  };
  function frame(): void {
    raf = 0;
    if (!dirty || !renderer) return;
    dirty = false;
    view = clampView(view, mapSize, w, h);
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
    const r = canvas.getBoundingClientRect();
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
    fit, setView: set, zoomBy: (f) => zoomBy(f), invalidate,
    getView: () => view,
    destroy() {
      destroyed = true; ro.disconnect(); window.removeEventListener('keydown', key);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
