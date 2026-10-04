/** Exact dry-land clipping shared by eager phases, camp quarters and macro faces. */
import type { Polygon, Vec2 } from '../core/geom';
import { tryDifference, tryDifferenceS, tryIntersection, mpArea, BOOL_AREA_EPS, type MultiPoly, type PolyH } from '../geo/bool';
import { area, bboxOf, pointInRing, distToSeg } from '../geo/poly';
import { GridIndex } from '../geo/spatial';

type Land = Polygon | PolyH | MultiPoly;
const asMP = (land: Land): MultiPoly => Array.isArray(land)
  ? !land.length || !('x' in land[0]) ? land as MultiPoly : [{ outer: land as Polygon, holes: [] }]
  : [land];
const meets = (a: ReturnType<typeof bboxOf>, b: ReturnType<typeof bboxOf>) => !(a.x0 > b.x1 || a.x1 < b.x0 || a.y0 > b.y1 || a.y1 < b.y0);
const BOXES = new WeakMap<MultiPoly, ReturnType<typeof bboxOf>[]>();
const PIECE_BOXES = new WeakMap<PolyH, ReturnType<typeof bboxOf>>();
const IMMUTABLE = new WeakSet<MultiPoly>();
const immutablePiece = (ph: PolyH) => Object.isFrozen(ph) && Object.isFrozen(ph.outer) && Object.isFrozen(ph.holes) &&
  ph.outer.every((p) => Object.isFrozen(p)) && ph.holes.every((ring) => Object.isFrozen(ring) && ring.every((p) => Object.isFrozen(p)));
const pieceBox = (ph: PolyH) => {
  const cached = PIECE_BOXES.get(ph);
  if (cached) return cached;
  const bb = bboxOf(ph.outer);
  if (immutablePiece(ph)) PIECE_BOXES.set(ph, bb);
  return bb;
};
const immutable = (water: MultiPoly): boolean => {
  if (IMMUTABLE.has(water)) return true;
  if (!Object.isFrozen(water) || !water.every(immutablePiece)) return false;
  IMMUTABLE.add(water); return true;
};
const boxes = (water: MultiPoly) => {
  if (!immutable(water)) return water.map(pieceBox);
  let result = BOXES.get(water);
  if (!result) { result = water.map(pieceBox); BOXES.set(water, result); }
  return result;
};

/** Natural water membership excludes land islands even when the sea outer encloses the whole town. */
export function waterContains(water: MultiPoly, p: Vec2): boolean {
  const bb = boxes(water);
  return water.some((ph, i) => p.x >= bb[i].x0 && p.x <= bb[i].x1 && p.y >= bb[i].y0 && p.y <= bb[i].y1 &&
    pointInRing(ph.outer, p) && !ph.holes.some((hole) => pointInRing(hole, p)));
}
const EDGES = new WeakMap<MultiPoly, GridIndex<{ a: Vec2; b: Vec2 }>>();
/** Wet interior or within a dry-bank clearance of any shoreline, including an island's shore. */
export function waterNear(water: MultiPoly, p: Vec2, clearance: number): boolean {
  const cacheable = immutable(water);
  let idx = cacheable ? EDGES.get(water) : undefined;
  if (!idx) {
    idx = new GridIndex<{ a: Vec2; b: Vec2 }>(25);
    for (const ph of water) for (const ring of [ph.outer, ...ph.holes]) for (let i = 0; i < ring.length; i++) {
      idx.insertSegThin(ring[i], ring[(i + 1) % ring.length], { a: ring[i], b: ring[(i + 1) % ring.length] });
    }
    if (cacheable) EDGES.set(water, idx);
  }
  return idx.queryPt(p, clearance).some((edge) => distToSeg(p, edge.a, edge.b) < clearance) || waterContains(water, p);
}

/** Whole-polygon wet area with cheap spatial rejection before materialising large water rings for a boolean.
 * Unprovable contact is wet: a failed intersection may never admit a terrestrial plaza or houselot. */
export function wetArea(poly: Polygon, water: MultiPoly): number {
  if (!poly.length || !water.length) return 0;
  const bb = bboxOf(poly), wb = boxes(water);
  const near = water.filter((_, i) => meets(bb, wb[i]));
  if (!near.length) return 0;
  const center = { x: (bb.x0 + bb.x1) / 2, y: (bb.y0 + bb.y1) / 2 };
  const radius = Math.hypot(bb.x1 - bb.x0, bb.y1 - bb.y0) / 2 + 1e-3;
  if (!waterNear(water, center, radius)) return 0;
  const wet = tryIntersection(poly, near);
  return wet.failed ? Infinity : mpArea(wet.pieces);
}

/** Diagnostics only: ordinary clipping failure must never quietly turn a wet subject back into dry land. */
export const WATER_CLIP_STATS = { retries: 0, droppedPieces: 0, droppedArea: 0, snappedRetries: 0, residualArea: 0 };
/** Maximum measured numerical wet residue for one complete dryPieces result (m²), below partition tolerance. */
export const WATER_CLIP_EPS = 1e-3;
/** Only newly clipped land loses tiny components; water holes and unchanged dry subjects stay intact. */
const viableLand = (pieces: MultiPoly) => pieces.filter((ph) => area(ph.outer) >= 0.01);

/** Keep shared partition edges exact; a grid retry is reserved for an actual engine failure. */
const checkedCut = (land: Land, water: MultiPoly | PolyH) => {
  const exact = tryDifference(land, water);
  if (!exact.failed) return { ...exact, snapped: false, residual: 0 };
  WATER_CLIP_STATS.snappedRetries++;
  const snapped = tryDifferenceS(land, water);
  if (snapped.failed) return { ...snapped, snapped: true, residual: 0 };
  // Measure in the original exact frame: a millimetre retry may leave numerical bank slivers.
  // The bound applies to the aggregate result, so splitting it into pieces cannot multiply the allowance.
  const wet = tryIntersection(snapped.pieces, water);
  const residual = mpArea(wet.pieces);
  return wet.failed || residual > WATER_CLIP_EPS
    ? { pieces: [], failed: true, snapped: true, residual: 0 }
    : { ...snapped, snapped: true, residual };
};

/** Preserve already dry geometry verbatim. A failed large subtraction retries by local subject and water piece;
 * only a local piece that still cannot be proved dry is lost, with a diagnostic count/area. */
export function dryPieces(land: Land, water: MultiPoly): MultiPoly {
  const subject = asMP(land);
  if (!subject.length || !water.length) return subject;
  const sb = subject.map((ph) => bboxOf(ph.outer)), wb = boxes(water);
  const near = water.filter((_, i) => sb.some((b) => meets(b, wb[i])));
  if (!near.length) return subject;
  const wet = tryIntersection(subject, near);
  if (!wet.failed && mpArea(wet.pieces) <= BOOL_AREA_EPS) return subject;
  const cut = checkedCut(subject, near);
  if (!cut.failed) { WATER_CLIP_STATS.residualArea += cut.residual; return viableLand(cut.pieces); }
  WATER_CLIP_STATS.retries++;
  const result: MultiPoly = [];
  let usedSnapped = false;
  for (const original of subject) {
    let local = [original];
    for (const waterPiece of near) {
      const next: MultiPoly = [];
      for (const part of local) {
        if (!meets(bboxOf(part.outer), pieceBox(waterPiece))) { next.push(part); continue; }
        const contact = tryIntersection(part, waterPiece);
        if (!contact.failed && mpArea(contact.pieces) <= BOOL_AREA_EPS) { next.push(part); continue; }
        const removed = checkedCut(part, waterPiece);
        usedSnapped ||= removed.snapped;
        if (removed.failed) {
          WATER_CLIP_STATS.droppedPieces++;
          WATER_CLIP_STATS.droppedArea += mpArea([part]);
        } else next.push(...removed.pieces);
      }
      local = next;
      if (!local.length) break;
    }
    result.push(...local);
  }
  if (usedSnapped) {
    // Recheck all banks after sequential local retries; each retry can also move an earlier cut edge.
    // Keep independently proven pieces within a single aggregate budget, never a budget per water operand.
    let residue = 0;
    const safe: MultiPoly = [];
    for (const part of result) {
      const wet = tryIntersection(part, near);
      const amount = mpArea(wet.pieces);
      if (wet.failed || residue + amount > WATER_CLIP_EPS) {
        WATER_CLIP_STATS.droppedPieces++;
        WATER_CLIP_STATS.droppedArea += mpArea([part]);
      } else { residue += amount; safe.push(part); }
    }
    WATER_CLIP_STATS.residualArea += residue;
    return viableLand(safe);
  }
  return viableLand(result);
}
