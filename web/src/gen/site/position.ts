import type { Vec2 } from '../core/geom';
import type { TerrainLayer } from '../types';

export interface PositionConstraints {
  inset: number;
  slopeMax: number;
  /** Limit a secondary settlement's correction to its local neighbourhood. */
  maxMove?: number;
  allowed?: (index: number, point: Vec2) => boolean;
}

/** Keep a usable requested point exactly; otherwise choose the nearest safe cell deterministically. */
export function resolvePosition(terrain: TerrainLayer, mapSize: number, requested: Vec2, constraints: PositionConstraints): Vec2 | null {
  if (!Number.isFinite(requested.x) || !Number.isFinite(requested.y)) return null;
  const { w, h, cell } = terrain.height;
  const inset = Math.min(mapSize / 2 - cell / 2, Math.max(cell / 2, constraints.inset));
  const target = {
    x: Math.max(inset, Math.min(mapSize - inset, requested.x)),
    y: Math.max(inset, Math.min(mapSize - inset, requested.y)),
  };
  const indexAt = (p: Vec2): number => Math.min(h - 1, Math.max(0, Math.floor(p.y / cell))) * w + Math.min(w - 1, Math.max(0, Math.floor(p.x / cell)));
  const limit = constraints.maxMove === undefined ? Infinity : constraints.maxMove ** 2;
  const origin = constraints.maxMove === undefined ? target : requested;
  const distanceSquared = (p: Vec2): number => (p.x - origin.x) ** 2 + (p.y - origin.y) ** 2;
  const safe = (i: number, p: Vec2): boolean => p.x >= inset && p.y >= inset && p.x <= mapSize - inset && p.y <= mapSize - inset
    && terrain.water[i] === 0 && Number.isFinite(terrain.slope.data[i]) && terrain.slope.data[i] <= constraints.slopeMax
    && (!constraints.allowed || constraints.allowed(i, p));
  if (distanceSquared(target) <= limit && safe(indexAt(target), target)) return target;
  let chosen: Vec2 | null = null;
  let best = Infinity;
  const radius = constraints.maxMove;
  const x0 = radius === undefined ? 0 : Math.max(0, Math.ceil((origin.x - radius) / cell - 0.5));
  const x1 = radius === undefined ? w - 1 : Math.min(w - 1, Math.floor((origin.x + radius) / cell - 0.5));
  const y0 = radius === undefined ? 0 : Math.max(0, Math.ceil((origin.y - radius) / cell - 0.5));
  const y1 = radius === undefined ? h - 1 : Math.min(h - 1, Math.floor((origin.y + radius) / cell - 0.5));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const p = { x: (x + 0.5) * cell, y: (y + 0.5) * cell };
    const d = distanceSquared(p);
    if (d > limit || d >= best || !safe(y * w + x, p)) continue;
    chosen = p; best = d;
  }
  return chosen;
}
