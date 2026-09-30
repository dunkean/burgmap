/** Pure view math shared by the canvas renderer and the viewer. */
export interface View { cx: number; cy: number; /** CSS pixels per meter */ scale: number }
export interface Rect4 { minX: number; minY: number; maxX: number; maxY: number }

export const MAX_SCALE = 8;

export function viewRect(v: View, w: number, h: number, pad = 0): Rect4 {
  const hw = w / (2 * v.scale) + pad, hh = h / (2 * v.scale) + pad;
  return { minX: v.cx - hw, minY: v.cy - hh, maxX: v.cx + hw, maxY: v.cy + hh };
}
export const worldToScreen = (v: View, w: number, h: number, x: number, y: number): [number, number] =>
  [(x - v.cx) * v.scale + w / 2, (y - v.cy) * v.scale + h / 2];
export const screenToWorld = (v: View, w: number, h: number, sx: number, sy: number): [number, number] =>
  [(sx - w / 2) / v.scale + v.cx, (sy - h / 2) / v.scale + v.cy];

export function fitScale(mapSize: number, w: number, h: number, margin = 24): number {
  return Math.max(1, Math.min(w, h) - margin) / mapSize;
}
export function fitView(mapSize: number, w: number, h: number): View {
  return { cx: mapSize / 2, cy: mapSize / 2, scale: fitScale(mapSize, w, h) };
}
/** Keep scale in range and the view center inside the map. */
export function clampView(v: View, mapSize: number, w: number, h: number): View {
  const scale = Math.max(fitScale(mapSize, w, h) * 0.5, Math.min(MAX_SCALE, v.scale));
  return { cx: Math.max(0, Math.min(mapSize, v.cx)), cy: Math.max(0, Math.min(mapSize, v.cy)), scale };
}
/** Zoom by `factor`, keeping the world point under screen (sx, sy) fixed. */
export function zoomAt(v: View, factor: number, sx: number, sy: number, w: number, h: number): View {
  const [wx, wy] = screenToWorld(v, w, h, sx, sy);
  const scale = v.scale * factor;
  return { scale, cx: wx - (sx - w / 2) / scale, cy: wy - (sy - h / 2) / scale };
}
export function panBy(v: View, dxPx: number, dyPx: number): View {
  return { ...v, cx: v.cx - dxPx / v.scale, cy: v.cy - dyPx / v.scale };
}
