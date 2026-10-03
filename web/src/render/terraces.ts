import type { Polyline } from '../gen/types';

/** Meters and opacity shared by SVG export and Canvas; detail strokes need no heavy pixel floor. */
export const TERRACE_STROKES = {
  wall: { width: 0.9, minPx: 0.3, alpha: 0.65 },
  andene: { width: 0.5, minPx: 0.25, alpha: 0.65 },
  face: { width: 1.2, alpha: 0.16 },
  hatch: { width: 0.25, minPx: 0.15, alpha: 0.55 },
  stair: { width: 0.2, minPx: 0.15, alpha: 0.4 },
} as const;

/** Real transverse marks at fixed arc-length intervals, independent of polyline subdivision. */
export function terraceMarks(path: Polyline, gap: number, length: number): Polyline[] {
  if (!(gap > 0 && length > 0 && Number.isFinite(gap) && Number.isFinite(length))) return [];
  const segments: { a: Polyline[number]; b: Polyline[number]; start: number; length: number }[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(len > 1e-8 && Number.isFinite(len))) continue;
    segments.push({ a, b, start: total, length: len });
    total += len;
  }
  const marks: Polyline[] = [];
  let i = 0;
  for (let distance = gap / 2; distance <= total - gap / 2; distance += gap) {
    while (i < segments.length - 1 && distance > segments[i].start + segments[i].length) i++;
    const { a, b, start, length: len } = segments[i];
    const t = (distance - start) / len, dx = (b.x - a.x) / len, dy = (b.y - a.y) / len;
    const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
    const nx = -dy * length / 2, ny = dx * length / 2;
    marks.push([{ x: x - nx, y: y - ny }, { x: x + nx, y: y + ny }]);
  }
  return marks;
}

/** Hatches and stair treads fade in only once their spacing is readable on screen. */
export const terraceDetailAlpha = (scale: number): number => Math.max(0, Math.min(1, (scale - 0.3) / 0.4));
