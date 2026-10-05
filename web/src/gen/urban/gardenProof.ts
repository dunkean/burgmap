/** Reuse only successful, unchanged hole-free garden conservation proofs within one pass. */
import type { Polygon } from '../core/geom';
import { isSimple } from '../geo/poly';
import { tryDifference, mpArea, type MultiPoly } from '../geo/bool';
import { openHoles } from './plots';

export function makeGardenOpening(): (pieces: MultiPoly) => Polygon[] | null {
  const proved = new WeakMap<Polygon, Float64Array>();
  return (pieces) => {
    const result: Polygon[] = [];
    for (const piece of pieces) {
      const coordinates = !piece.holes.length ? proved.get(piece.outer) : undefined;
      if (coordinates?.length === piece.outer.length * 2
        && piece.outer.every((p, i) => coordinates[2 * i] === p.x && coordinates[2 * i + 1] === p.y)) {
        // openHoles returns this very ring for a hole-free piece; preserve that alias.
        result.push(piece.outer); continue;
      }
      const opened = openHoles(piece, 0, true);
      if (opened.some((p) => p.holes.length || !isSimple(p.outer))) return null;
      const lost = tryDifference([piece], opened), added = tryDifference(opened, [piece]);
      if (lost.failed || added.failed || mpArea(lost.pieces) > 1e-6 || mpArea(added.pieces) > 1e-6
        || Math.abs(mpArea([piece]) - mpArea(opened)) > 0.01) return null;
      // Holed openings can create new polygons: keep their full checked path and avoid
      // caching derived mutable outputs. Failed proofs never populate the cache.
      if (!piece.holes.length) proved.set(piece.outer, new Float64Array(piece.outer.flatMap((p) => [p.x, p.y])));
      result.push(...opened.map((p) => p.outer));
    }
    return result;
  };
}
