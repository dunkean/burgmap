/** Last footprint pass, after edge-roof and density mutations and before rebuilding masses. */
import type { Polygon, Vec2 } from '../core/geom';
import type { UrbanBuilding, UrbanParcel } from '../types';
import type { PolyH } from '../geo/bool';
import { area, cleanRing, isSimple, interiorAngle, minAngle, minNeck, inscribed } from '../geo/poly';
import { lpoly, polyInside, splitByChord } from '../geo/split';
import { GridIndex } from '../geo/spatial';
import { distToRing, pointInRing } from '../geo/poly';

export interface FootprintFinalInput {
  buildings: UrbanBuilding[];
  parcels: UrbanParcel[];
  /** Optional receiver for released substandard arms, in native coordinates. */
  backLand?: PolyH[];
  /** Physical constraint beyond a sharp tip (sea/water/wall or neighbouring quarter). */
  tipConstrained?: (tip: Vec2, outward: Vec2) => boolean;
  /** True when the tip exits a labelled open quarter boundary. */
  openQuarterEdge?: (tip: Vec2, outward: Vec2) => boolean;
}
export interface FootprintFinalResult { changed: Set<number>; invalid: number[]; cleaned: number; releasedArea: number }

function proper(p: Polygon): boolean {
  if (p.length < 3 || !isSimple(p) || area(p) < 12) return false;
  if (p.length === 3) return 2 * inscribed(p, [], 0.02).r >= 3.2 && minAngle(p) >= 20 * Math.PI / 180;
  return (minNeck(p)?.w ?? Infinity) >= 3.59;
}

function normalize(p: Polygon): Polygon | null {
  // No coordinate snapping: the native partition and world-scale translations stay exact.
  const q = cleanRing(p, 1e-6, 0.0001, 1e-9, false);
  return q.length >= 3 && isSimple(q) && Math.abs(area(q) - area(p)) < 1e-6 ? q : null;
}

/** Clip only a disproportionately sharp building tip; keep its land as open owner land. */
function clipSharpTip(p: Polygon, owner: Polygon, constrained: (tip: Vec2, outward: Vec2) => boolean): { house: Polygon; tip: Polygon } | null {
  if (p.length < 3 || !isSimple(p)) return null;
  for (let i = 0; i < p.length; i++) {
    const angle = interiorAngle(p, i);
    if (angle >= 18 * Math.PI / 180) continue;
    const v = p[i], a = p[(i - 1 + p.length) % p.length], b = p[(i + 1) % p.length];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const vl = Math.hypot(v.x - mx, v.y - my) || 1;
    const outward = { x: (v.x - mx) / vl, y: (v.y - my) / vl };
    if (!constrained(v, outward)) continue;
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
  const parcelIndex = new GridIndex<number>(24);
  u.parcels.forEach((p, i) => { if (p.poly.length >= 3) parcelIndex.insertPts(p.poly, i); });
  const tipConstrained = (owner: number, tip: Vec2, outward: Vec2): boolean => {
    const beyond = { x: tip.x + 1.5 * outward.x, y: tip.y + 1.5 * outward.y };
    if (u.tipConstrained?.(tip, outward)) return true;
    return parcelIndex.queryPt(beyond, 1).some((j) => j !== owner && (pointInRing(u.parcels[j].poly, beyond)
      || distToRing(u.parcels[j].poly, beyond) < 1));
  };
  const openExterior = (owner: UrbanParcel, tip: Vec2, outward: Vec2): boolean => {
    const beyond = { x: tip.x + 1.5 * outward.x, y: tip.y + 1.5 * outward.y };
    return u.openQuarterEdge?.(tip, outward)
      ?? (!pointInRing(owner.poly, beyond) && distToRing(owner.poly, tip) < 2);
  };
  const armEdge = (main: Polygon, arm: Polygon): { tip: Vec2; outward: Vec2 } => {
    const centroid = (poly: Polygon): Vec2 => ({ x: poly.reduce((s, p) => s + p.x, 0) / poly.length,
      y: poly.reduce((s, p) => s + p.y, 0) / poly.length });
    const a = centroid(arm), m = centroid(main), len = Math.hypot(a.x - m.x, a.y - m.y) || 1;
    const outward = { x: (a.x - m.x) / len, y: (a.y - m.y) / len };
    const tip = arm.reduce((best, p) => (p.x * outward.x + p.y * outward.y > best.x * outward.x + best.y * outward.y ? p : best));
    return { tip, outward };
  };
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
    if (b.courtyards?.length || /courtyard|souk|ring/.test(b.arch ?? '')
      || !['house', 'rear', 'back'].includes(b.kind)) continue;
    if (owner && u.backLand) {
      const tip = clipSharpTip(b.poly, owner.poly, (p, d) => !openExterior(owner, p, d)
        || tipConstrained(b.parcel!, p, d));
      if (tip) {
        b.poly = tip.house;
        u.backLand.push({ outer: tip.tip, holes: [] });
        releasedArea += area(tip.tip);
        if (block !== undefined) changed.add(block);
      }
    }
    if (proper(b.poly)) continue;
    if (!owner || !u.backLand) { invalid.push(i); continue; }
    let main = b.poly;
    const extra: Polygon[] = [], released: Polygon[] = [];
    for (let pass = 0; pass < 4 && !proper(main); pass++) {
      const neck = minNeck(main);
      if (!neck || neck.w >= 3.59) break;
      const cut = splitByChord(lpoly(main, 0), [neck.a, neck.b], 0, 0.02);
      if (!cut) break;
      const parts = cut.map((p) => p.pts).sort((a, c) => area(c) - area(a));
      if (Math.abs(area(parts[0]) + area(parts[1]) - area(main)) > 1e-6 || !parts.every((p) => polyInside(owner.poly, p))) break;
      // Keep the dominant room through the next local cut; retain a second valid room as a building.
      // A failed small arm is released to the owner's open land only when total housing area stays ≥70%.
      if (!proper(parts[1])) {
        if (area(parts[0]) < 0.7 * area(main)) break;
        const { tip, outward } = armEdge(parts[0], parts[1]);
        if (openExterior(owner, tip, outward) && !tipConstrained(b.parcel!, tip, outward)) break;
      }
      main = parts[0];
      if (proper(parts[1])) extra.push(parts[1]); else released.push(parts[1]);
    }
    if (!proper(main) || area(main) + extra.reduce((s, p) => s + area(p), 0) < 0.7 * area(b.poly)) {
      invalid.push(i); continue;
    }
    b.poly = main;
    for (const p of extra) u.buildings.push({ ...b, poly: p });
    for (const p of released) { u.backLand.push({ outer: p, holes: [] }); releasedArea += area(p); }
    if (block !== undefined) changed.add(block);
  }
  return { changed, invalid, cleaned, releasedArea };
}
