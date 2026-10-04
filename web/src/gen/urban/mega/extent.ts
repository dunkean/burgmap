import type { Polygon, Vec2 } from '../../core/geom';

/** Circular land demand plus room for eccentric growth and the surrounding countryside. */
export function requiredMegaExtent(radius: number): number {
  return Math.ceil((2.6 * radius + 1200) / 1000) * 1000;
}

/** One common homothety preserves shared vertices and nested rings; clipping each ring would not. */
export function containMegaRings(rings: Polygon[], center: Vec2, mapSize: number, margin = 150): { rings: Polygon[]; scale: number } {
  const pad = Math.max(0, Math.min(margin, mapSize * 0.05, center.x / 2, center.y / 2, (mapSize - center.x) / 2, (mapSize - center.y) / 2));
  let scale = 1;
  for (const ring of rings) for (const p of ring) {
    const dx = p.x - center.x, dy = p.y - center.y;
    if (dx > 0) scale = Math.min(scale, (mapSize - pad - center.x) / dx);
    if (dx < 0) scale = Math.min(scale, (pad - center.x) / dx);
    if (dy > 0) scale = Math.min(scale, (mapSize - pad - center.y) / dy);
    if (dy < 0) scale = Math.min(scale, (pad - center.y) / dy);
  }
  scale = Math.max(0, Math.min(1, scale));
  if (scale === 1) return { rings, scale };
  return { scale, rings: rings.map((r) => r.map((p) => ({ x: center.x + (p.x - center.x) * scale, y: center.y + (p.y - center.y) * scale }))) };
}
