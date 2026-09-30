/** Built coverage per phase and footprint shape measures (shared by tests and scripts). */
import type { World } from '../src/gen/types';
import { area, obb, inscribed, cleanRing, interiorAngle, orientPos, distToRing } from '../src/gen/geo/poly';
import type { Polygon } from '../src/gen/core/geom';

/** A footprint is rectangular when it has 4 corners (collinear vertices ignored), all within 3° of a right angle. */
export function isRect(p: Polygon): boolean {
  const c = orientPos(cleanRing(p, 0.05, 2, Infinity, false));
  if (c.length !== 4) return false;
  for (let i = 0; i < 4; i++) if (Math.abs(interiorAngle(c, i) - Math.PI / 2) > (3 * Math.PI) / 180) return false;
  return true;
}

export interface CoverageReport {
  /** Area-weighted built share of the blocks per phase id (faubourg phases have the highest id). */
  byPhase: Map<number, { built: number; area: number; blocks: number; zone: string; rect: number; n: number }>;
  minWidth: number; maxAspect: number; narrow: number; long: number; buildings: number;
  /** Faubourg coverage within 150 m of the enclosure (gate side) and beyond (the ribbon fades out). */
  faubNear: number; faubFar: number;
}

export function coverage(w: World, landmarkKinds = new Set(['church', 'cathedral', 'landmark'])): CoverageReport {
  const u = w.urban!;
  const byPhase = new Map<number, { built: number; area: number; blocks: number; zone: string; rect: number; n: number }>();
  const blockBuilt = new Float64Array(u.blocks.length);
  for (const b of u.buildings) {
    if (b.parcel === undefined || landmarkKinds.has(b.kind)) continue;
    blockBuilt[u.parcels[b.parcel].block] += area(b.poly);
  }
  u.blocks.forEach((poly, i) => {
    const info = u.blockInfo[i];
    if (info.kind !== 'block') return;
    const rec = byPhase.get(info.phase) ?? { built: 0, area: 0, blocks: 0, zone: info.zone, rect: 0, n: 0 };
    rec.built += blockBuilt[i]; rec.area += area(poly); rec.blocks++;
    byPhase.set(info.phase, rec);
  });
  for (const b of u.buildings) {
    if (b.parcel === undefined || landmarkKinds.has(b.kind)) continue;
    const info = u.blockInfo[u.parcels[b.parcel].block];
    const rec = byPhase.get(info.phase);
    if (!rec) continue;
    rec.n++;
    if (isRect(b.poly)) rec.rect++;
  }
  // faubourgs: near the enclosure vs far
  const enc = u.phases.filter((ph) => ph.zone !== 'faubourg').flatMap((ph) => ph.region.map((r) => r.outer));
  let nb = 0, na = 0, fb = 0, fa = 0;
  u.blocks.forEach((poly, i) => {
    const info = u.blockInfo[i];
    if (info.kind !== 'block' || info.zone !== 'faubourg') return;
    const c = poly.reduce((s, q) => ({ x: s.x + q.x / poly.length, y: s.y + q.y / poly.length }), { x: 0, y: 0 });
    const d = enc.length ? Math.min(...enc.map((r) => distToRing(r, c))) : 0;
    if (d <= 150) { nb += blockBuilt[i]; na += area(poly); } else { fb += blockBuilt[i]; fa += area(poly); }
  });
  let minWidth = Infinity, maxAspect = 0, narrow = 0, long = 0, n = 0;
  for (const b of u.buildings) {
    if (landmarkKinds.has(b.kind)) continue;
    n++;
    const o = obb(b.poly);
    const wdt = 2 * o.hv, asp = o.hu / Math.max(1e-6, o.hv);
    minWidth = Math.min(minWidth, wdt); maxAspect = Math.max(maxAspect, asp);
    if (wdt < 4.4) narrow++;
    if (asp > 4.05) long++;
  }
  void inscribed;
  return { byPhase, minWidth, maxAspect, narrow, long, buildings: n, faubNear: na ? nb / na : NaN, faubFar: fa ? fb / fa : NaN };
}
