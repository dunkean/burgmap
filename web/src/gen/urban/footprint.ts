/** Keep unserved planning land out of the exported urban/rural reserve. */
import type { Polygon } from '../core/geom';
import type { UrbanStreet } from '../types';
import { differenceS, differenceSafeS, mpArea, unionMany, type MultiPoly } from '../geo/bool';
import { disk, miterNormals, ribbon } from '../geo/offset';

export function servedFootprint(planned: MultiPoly, quarters: MultiPoly, streets: UrbanStreet[], walls: Polygon[]): MultiPoly {
  if (!planned.length || !quarters.length) return planned;
  // Whole quarters retain their squares, parks, courtyards and street space. Fully served legacy
  // outlines need no road booleans. A failed subtraction returns no candidate to release.
  const gaps = differenceSafeS(planned, quarters);
  if (!gaps.some((p) => mpArea([p]) >= 1000)) return planned;
  // Segment quads use the full path's normals, so variable widths retain the exact street miters.
  // Their union cannot turn a closed road into a solid filled enclosure. Wall
  // edges plus vertex disks form a hollow curtain strip rather than a repaired solid enclosure.
  const strips: Polygon[] = [];
  for (const s of streets) {
    if (s.path.length < 2) continue;
    const normals = miterNormals(s.path, 2.5);
    const side = (i: number, sign: number) => {
      const half = (s.widths?.[i] ?? s.width) / 2;
      return { x: s.path[i].x + sign * normals[i].x * half, y: s.path[i].y + sign * normals[i].y * half };
    };
    for (let i = 0; i < s.path.length - 1; i++) strips.push([side(i, 1), side(i + 1, 1), side(i + 1, -1), side(i, -1)]);
  }
  for (const ring of walls) for (let i = 0; i < ring.length; i++) {
    strips.push(ribbon([ring[i], ring[(i + 1) % ring.length]], 5.6), disk(ring[i], 2.8));
  }
  // Protection may extend past planned, but subtraction is bounded by planned itself. Avoid a
  // separate intersection whose empty-on-error fallback could silently lose road protection.
  const protectedLand = unionMany([quarters, ...strips.filter((p) => p.length >= 3)], 24, true);
  const unserved = differenceSafeS(planned, protectedLand);
  // Do not change legacy outlines for junction remnants and small edge slivers. Only actual
  // abandoned districts are released; snapping noise can never remove quarter or road land.
  const abandoned = unserved.filter((p) => mpArea([p]) >= 1000);
  // A failed final subtraction must preserve the original reserve, never expose built land to farms.
  return abandoned.length ? differenceS(planned, abandoned) : planned;
}
