/** Last footprint pass, after edge-roof and density mutations and before rebuilding masses. */
import type { Polygon } from '../core/geom';
import type { UrbanBuilding, UrbanParcel } from '../types';
import type { PolyH } from '../geo/bool';
import { area, cleanRing, isSimple, interiorAngle, minAngle, minNeck, inscribed } from '../geo/poly';
import { lpoly, polyInside, splitByChord } from '../geo/split';

export interface FootprintFinalInput {
  buildings: UrbanBuilding[];
  parcels: UrbanParcel[];
  /** Optional receiver for released substandard arms, in native coordinates. */
  backLand?: PolyH[];
}
export interface FootprintFinalResult { changed: Set<number>; invalid: number[]; cleaned: number; releasedArea: number }

function proper(p: Polygon): boolean {
  if (p.length < 3 || !isSimple(p) || area(p) < 12) return false;
  if (p.length === 3) return 2 * inscribed(p, [], 0.02).r >= 3.2 && minAngle(p) >= 20 * Math.PI / 180;
  return (minNeck(p)?.w ?? Infinity) >= 3.6 - 1e-6;
}

function normalize(p: Polygon): Polygon | null {
  // No coordinate snapping: the native partition and world-scale translations stay exact.
  const q = cleanRing(p, 1e-6, 0.0001, 1e-9, false);
  return q.length >= 3 && isSimple(q) && Math.abs(area(q) - area(p)) < 1e-6 ? q : null;
}

/** Clip only a disproportionately sharp building tip; keep its land as open owner land. */
function clipSharpTip(p: Polygon, owner: Polygon): { house: Polygon; tip: Polygon } | null {
  if (p.length < 3 || !isSimple(p)) return null;
  for (let i = 0; i < p.length; i++) {
    const angle = interiorAngle(p, i);
    if (angle >= 18 * Math.PI / 180) continue;
    const v = p[i], a = p[(i - 1 + p.length) % p.length], b = p[(i + 1) % p.length];
    const la = Math.hypot(a.x - v.x, a.y - v.y), lb = Math.hypot(b.x - v.x, b.y - v.y);
    if (la < 3 || lb < 3) continue;
    let len = Math.min(0.45 * Math.min(la, lb), 1.2 / Math.max(0.05, Math.sin(angle / 2)));
    // Limit land released to 3% of the current building; the cut must remain visible.
    const maxLen = Math.sqrt(0.06 * area(p) / Math.max(1e-6, Math.sin(angle)));
    len = Math.min(len, maxLen);
    if (len < 0.4) continue;
    const pa = { x: v.x + (a.x - v.x) * len / la, y: v.y + (a.y - v.y) * len / la };
    const pb = { x: v.x + (b.x - v.x) * len / lb, y: v.y + (b.y - v.y) * len / lb };
    const house = [...p.slice(0, i), pa, pb, ...p.slice(i + 1)];
    const tip = [pa, v, pb];
    if (isSimple(house) && area(house) >= 12 && polyInside(owner, house)
      && Math.abs(area(house) + area(tip) - area(p)) < 1e-6 && area(tip) < 0.03 * area(p) + 1e-6) return { house, tip };
  }
  return null;
}

export function finalizeFootprints(u: FootprintFinalInput): FootprintFinalResult {
  const changed = new Set<number>(), invalid: number[] = [];
  let cleaned = 0, releasedArea = 0;
  const count = u.buildings.length;
  for (let i = 0; i < count; i++) {
    const b = u.buildings[i], owner = b.parcel === undefined ? undefined : u.parcels[b.parcel];
    const block = owner?.block;
    const q = normalize(b.poly);
    if (q && q.length !== b.poly.length && (!owner || polyInside(owner.poly, q))) {
      b.poly = q; cleaned++;
      if (block !== undefined) changed.add(block);
    }
    // Courtyard ranges are deliberately narrow rooms; their minimum is set by the builder's rd.
    if (b.courtyards?.length || /courtyard|souk|ring/.test(b.arch ?? '') || b.kind === 'landmark') continue;
    if (owner && u.backLand) {
      const tip = clipSharpTip(b.poly, owner.poly);
      if (tip) {
        b.poly = tip.house;
        u.backLand.push({ outer: tip.tip, holes: [] });
        releasedArea += area(tip.tip);
        if (block !== undefined) changed.add(block);
      }
    }
    if (proper(b.poly)) continue;
    const neck = minNeck(b.poly);
    if (!neck || neck.w >= 3.6 || !owner || !u.backLand) { invalid.push(i); continue; }
    const cut = splitByChord(lpoly(b.poly, 0), [neck.a, neck.b], 0, 0.02);
    if (!cut) { invalid.push(i); continue; }
    const parts = cut.map((p) => p.pts);
    if (Math.abs(area(parts[0]) + area(parts[1]) - area(b.poly)) > 1e-6 || !parts.every((p) => polyInside(owner.poly, p))) {
      invalid.push(i); continue;
    }
    const good = parts.filter(proper), bad = parts.filter((p) => !proper(p));
    if (!good.length || (bad.length && area(good[0]) < 0.7 * area(b.poly))) { invalid.push(i); continue; }
    b.poly = good[0];
    for (let j = 1; j < good.length; j++) u.buildings.push({ ...b, poly: good[j] });
    for (const p of bad) { u.backLand.push({ outer: p, holes: [] }); releasedArea += area(p); }
    if (block !== undefined) changed.add(block);
  }
  return { changed, invalid, cleaned, releasedArea };
}
