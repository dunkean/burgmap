/** Contour polylines shared by the SVG and Canvas renderers. */
import type { World, Polyline } from '../gen/types';
import type { Relief } from '../gen/options';
import { chaikin, simplify, polylineLength } from '../gen/core/geom';
import { sampleGrid } from '../gen/core/grid';
import { marchingSquares } from '../gen/terrain/contour';

export const CONTOUR_INTERVAL: Record<Relief, number> = { flat: 2, hills: 5, valley: 5, mountains: 20 };

export interface ContourSet {
  /** Polylines; closed ones carry `closed` (the first point is NOT repeated). */
  thin: { pts: Polyline; closed: boolean }[];
  index: { pts: Polyline; closed: boolean }[];
}

/** Every 5th level is an index contour; short and near-flat loops are dropped. `u` = mapSize / 1600. */
export function contourSet(world: World, u: number): ContourSet {
  const t = world.terrain;
  const hg = t.height;
  const interval = CONTOUR_INTERVAL[world.options.relief];
  let maxH = 0;
  for (let i = 0; i < hg.data.length; i++) if (hg.data[i] > maxH) maxH = hg.data[i];
  const out: ContourSet = { thin: [], index: [] };
  for (let lv = interval, k = 1; lv < maxH; lv += interval, k++) {
    const dst = k % 5 === 0 ? out.index : out.thin;
    const paths = marchingSquares(hg.data, hg.w, hg.h, lv, hg.cell, hg.cell / 2, hg.cell / 2);
    for (const p of paths) {
      if (p.pts.length < 4) continue;
      let pts = p.pts;
      if (polylineLength(pts) < 35 * u) continue;
      let sl = 0;
      for (const q of pts) sl += sampleGrid(t.slope, q.x, q.y);
      if (sl / pts.length < (world.options.relief === 'flat' ? 0.004 : 0.012)) continue;
      pts = chaikin(pts, 2, p.closed);
      pts = simplify(pts, 0.35 * u);
      dst.push({ pts, closed: p.closed });
    }
  }
  return out;
}
