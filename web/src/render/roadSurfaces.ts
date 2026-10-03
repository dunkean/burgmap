/** Physical road widths with bounded on-screen visibility, shared by SVG and Canvas. */
import type { PolyH, UrbanLayer } from '../gen/types';
import { orientPos } from '../gen/geo/poly';

export function regionalRoadSurface(kind: 'major' | 'minor', scale: number, width = kind === 'major' ? 8 : 3.6): { fill: number; casing: number } {
  const fill = Math.max(width, (kind === 'major' ? 1.6 : 0.8) / scale);
  const edge = Math.max(0.5, 0.9 / scale) * (kind === 'major' ? 1 : 0.6);
  return { fill, casing: fill + 2 * edge };
}

export function regionalBridgeSurface(width: number, scale: number): { deck: number; pad: number; rail: number } {
  return { deck: Math.max(width + 1, 2 / scale), pad: 1.5, rail: Math.max(1.1, 1 / scale) };
}

/** Visibility strokes may enlarge existing streets, but must not pave the countryside. */
export function urbanStrokeSpace(urban: UrbanLayer): PolyH[] {
  // Macro quarters retain their full graph faces (not their stand-in block insets), including
  // arterial edges. Detail layers merge into this base. A standalone legacy layer may instead
  // provide only its footprint: keep its streets visible within that known urban land.
  const space = urban.quarters.length ? urban.quarters.map(({ poly }) => poly) : urban.footprintH.length ? urban.footprintH : urban.footprint.map((outer) => ({ outer, holes: [] }));
  return space.map((poly) => ({ outer: orientPos(poly.outer), holes: poly.holes.map((h) => orientPos(h).slice().reverse()) }));
}
