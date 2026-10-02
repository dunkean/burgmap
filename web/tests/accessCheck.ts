/** Building access invariant: every building of a block touches a street or reaches it through open ground. */
import type { World, UrbanStreet } from '../src/gen/types';
import type { Vec2, Polygon } from '../src/gen/core/geom';
import { distToSeg, pointInRing, distToRing } from '../src/gen/geo/poly';
import { GridIndex } from '../src/gen/geo/spatial';
import { blockReach, makeStreetAt } from '../src/gen/urban/access';

export function unreachableBuildings(w: World): { n: number; total: number; where: Vec2[] } {
  const u = w.urban!;
  const streetAt = makeStreetAt(u.streets, u.parcels.filter((p) => ['place', 'market', 'quay', 'green'].includes(String(p.use))).map((p) => p.poly));
  const byBlock = new Map<number, Polygon[]>();
  const counted = new Map<number, number>();
  for (const b of u.buildings) {
    if (b.parcel === undefined) continue;
    const pc = u.parcels[b.parcel];
    if (pc.use !== 'plot' && pc.use !== 'inn') continue;
    const bk = pc.block;
    if (!byBlock.has(bk)) byBlock.set(bk, []);
    byBlock.get(bk)!.push(b.poly);
    counted.set(bk, (counted.get(bk) ?? 0) + 1);
  }
  // the other footprints of the block are obstacles too
  const all = new Map<number, Polygon[]>();
  for (const b of u.buildings) if (b.parcel !== undefined) { const bk = u.parcels[b.parcel].block; if (!all.has(bk)) all.set(bk, []); all.get(bk)!.push(b.poly); }
  let n = 0, total = 0;
  const where: Vec2[] = [];
  for (const [bk, list] of byBlock) {
    const extra = (all.get(bk) ?? []).filter((p) => !list.includes(p));
    const ok = blockReach(u.blocks[bk], [...list, ...extra], streetAt);
    for (let k = 0; k < list.length; k++) { total++; if (!ok[k]) { n++; if (where.length < 8) where.push({ ...list[k][0], use: 0 } as Vec2); } }
  }
  return { n, total, where };
}
