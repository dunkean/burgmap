/** Label layer hook: label model plus greedy collision avoidance (pure, testable). */
import type { View } from './view';
import { worldToScreen } from './view';

export interface Label {
  x: number; y: number; text: string;
  /** Font size in CSS px. */
  size?: number;
  /** Higher wins collisions. */
  priority?: number;
  /** Visible only when view scale is within [minScale, maxScale] (px/m). */
  minScale?: number; maxScale?: number;
  color?: string;
}
export interface PlacedLabel { label: Label; x: number; y: number; w: number; h: number }

/**
 * Greedy placement: labels sorted by priority (then input order) are accepted if their
 * screen rect does not overlap an already accepted one. `measure` returns text width in px.
 * This is a stub: no leader lines, no alternative anchor positions.
 */
export function placeLabels(labels: Label[], view: View, w: number, h: number, measure: (text: string, size: number) => number, maxLabels = 400): PlacedLabel[] {
  const cands: { l: Label; i: number }[] = [];
  labels.forEach((l, i) => {
    if (l.minScale !== undefined && view.scale < l.minScale) return;
    if (l.maxScale !== undefined && view.scale > l.maxScale) return;
    cands.push({ l, i });
  });
  cands.sort((a, b) => (b.l.priority ?? 0) - (a.l.priority ?? 0) || a.i - b.i);
  const placed: PlacedLabel[] = [];
  for (const { l } of cands) {
    if (placed.length >= maxLabels) break;
    const size = l.size ?? 12;
    const [sx, sy] = worldToScreen(view, w, h, l.x, l.y);
    const tw = measure(l.text, size), th = size * 1.2;
    const x0 = sx - tw / 2, y0 = sy - th / 2;
    if (x0 + tw < 0 || y0 + th < 0 || x0 > w || y0 > h) continue;
    let ok = true;
    for (const p of placed) {
      if (x0 < p.x + p.w + 2 && x0 + tw + 2 > p.x && y0 < p.y + p.h && y0 + th > p.y) { ok = false; break; }
    }
    if (ok) placed.push({ label: l, x: x0, y: y0, w: tw, h: th });
  }
  return placed;
}
