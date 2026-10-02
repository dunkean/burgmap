/**
 * Grand-place (URBAN_LANDMARKS.md §2): the market hall (towns) or the town hall with its belfry (cities) standing
 * on the square, along its long axis, leaving a paved margin all round (stalls, the town's open space).
 */
import type { Polygon } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { UrbanBuilding } from '../../types';
import { area, inscribed, obb, orientPos } from '../../geo/poly';
import { unionS } from '../../geo/bool';
import { rectAt } from './lots';
import { fits } from './kit';

export function marketHall(sq: Polygon, pop: number, rng: Rng): Omit<UrbanBuilding, 'parcel'> | null {
  const A = area(sq);
  if (A < 1500) return null;
  const o = obb(sq);
  const ang = Math.atan2(o.u.y, o.u.x);
  const c = inscribed(sq, [], 1).c;
  const city = pop >= 9000;
  for (let k = 1; k >= 0.55; k -= 0.075) {
    const L = Math.max(16, Math.min(city ? 46 : 38, Math.sqrt(A) * 0.5)) * k;
    const W = Math.max(8, Math.min(17, L * 0.42));
    const hall = rectAt(c, ang, -L / 2, L / 2, -W / 2, W / 2);
    let poly = hall;
    if (city) {
      // the belfry at one end of the town hall
      const b = Math.max(6, W * 0.55);
      const belfry = rectAt(c, ang, L / 2 - 0.01, L / 2 + b, -b / 2, b / 2);
      const u = unionS(hall, belfry);
      if (u.length === 1 && !u[0].holes.length) poly = orientPos(u[0].outer);
    }
    if (fits(sq, poly, 4.5)) {
      return { poly, kind: 'landmark', arch: city ? 'town-hall-belfry' : 'market-hall', roof: city ? 'hip' : 'gable', material: city ? 'stone' : 'timber', storeys: city ? 2 : 1, orientation: ang };
    }
  }
  void rng;
  return null;
}
