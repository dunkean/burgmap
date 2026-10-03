/**
 * Sahelian town (Djenné, Timbuktu, Agadez, Kano): the great mud mosque on its platform by the market (a hypostyle
 * prayer hall whose walls are ribbed with buttresses, three tower-minarets on the qibla wall, the court on the
 * west), smaller mosques with a pyramidal minaret (Sankoré), the chief's palace, compound houses round their
 * courts with granaries, sand lanes widening into irregular open spaces.
 */
import type { Vec2, Polygon } from '../core/geom';
import type { CompoundCtx, CompoundOut } from './compounds';
import { registerBuilders } from './compounds';
import { orientPos, obb, area } from '../geo/poly';
import { unionS } from '../geo/bool';
import { fits } from './m4/kit';
import { rectAt } from './m4/lots';
import { bestRect } from './persian';

/** Qibla from the Sahel: east (map angle). */
const QIBLA_SAHEL = 0.05;

/**
 * A mud wall outline ribbed with buttresses: the rectangle [−hu, hu] × [−hv, hv] (local frame at c, angle ang)
 * with pilasters (`w` wide, `d` deep) every `step` m along its four sides; one polygon.
 */
export function buttressed(c: Vec2, ang: number, hu: number, hv: number, step: number, w: number, d: number): Polygon {
  const parts: Polygon[] = [rectAt(c, ang, -hu, hu, -hv, hv)];
  const nU = Math.max(1, Math.floor((2 * hu) / step)), nV = Math.max(1, Math.floor((2 * hv) / step));
  for (let i = 0; i <= nU; i++) {
    const u = -hu + (2 * hu * i) / nU;
    parts.push(rectAt(c, ang, u - w / 2, u + w / 2, -hv - d, -hv + 0.3), rectAt(c, ang, u - w / 2, u + w / 2, hv - 0.3, hv + d));
  }
  for (let j = 1; j < nV; j++) {
    const v = -hv + (2 * hv * j) / nV;
    parts.push(rectAt(c, ang, -hu - d, -hu + 0.3, v - w / 2, v + w / 2), rectAt(c, ang, hu - 0.3, hu + d, v - w / 2, v + w / 2));
  }
  const u = unionS([{ outer: parts[0], holes: [] }], ...parts.slice(1).map((p) => [{ outer: p, holes: [] }]));
  let best = u[0]?.outer ?? parts[0];
  for (const ph of u) if (area(ph.outer) > area(best)) best = ph.outer;
  return orientPos(best);
}

/**
 * The great mosque (Djenné): on the market square, the buttressed prayer hall with three tower-minarets on its
 * qibla wall (east), the court (sahn) walled on the west; the rest of the lot is the market (and the platform).
 */
function mudMosque(lot: Polygon, cx: CompoundCtx, great = true): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: great ? 'market' : 'place' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const o = obb(P);
  const ang = QIBLA_SAHEL;
  const fr = bestRect(P, ang, Math.max(o.hu, o.hv) * 0.8, Math.max(o.hu, o.hv) * 0.8, 3);
  if (!fr) return out;
  // the mosque takes the east part of the frame (the market spreads on its west, before the court)
  const H = Math.min(fr.hv * (great ? 0.8 : 0.9), great ? 38 : 16);
  const L = Math.min(fr.hu * (great ? 0.75 : 0.9), H * (great ? 1.15 : 1.1));
  const c = { x: fr.c.x + Math.cos(ang) * (fr.hu - L), y: fr.c.y + Math.sin(ang) * (fr.hu - L) };
  const hallU0 = great ? 0 : -L;
  const hall = buttressed({ x: c.x + Math.cos(ang) * ((L + hallU0) / 2), y: c.y + Math.sin(ang) * ((L + hallU0) / 2) }, ang, (L - hallU0) / 2 - 1.2, H - 1.2, 3.2, 1.1, 0.8);
  if (!fits(P, hall, 1)) return out;
  // the tower-minarets on the qibla wall (three for the great mosque, one pyramidal minaret for the small one)
  const towers: Vec2[] = great ? [-0.55, 0, 0.55].map((k) => ({ x: c.x + Math.cos(ang) * (L + 0.6) - Math.sin(ang) * k * H, y: c.y + Math.sin(ang) * (L + 0.6) + Math.cos(ang) * k * H })) : [{ x: c.x + Math.cos(ang) * (L - 2) - Math.sin(ang) * (H + 1.5), y: c.y + Math.sin(ang) * (L - 2) + Math.cos(ang) * (H + 1.5) }];
  // (the towers are part of the wall: one footprint with the hall; their tops drawn as small squares)
  let body = hall;
  for (const t of towers) {
    const s = great ? Math.max(2.6, H * 0.12) : Math.max(2.4, H * 0.28);
    const tw = buttressed(t, ang, s, s, s, 0.9, 0.6);
    if (!fits(P, tw, 0.5)) continue;
    const u = unionS([{ outer: body, holes: [] }], [{ outer: tw, holes: [] }]);
    if (u.length !== 1 || u[0].holes.length) continue;
    body = orientPos(u[0].outer);
    out.lines.push({ kind: 'pyramid-step', path: [...rectAt(t, ang, -s * 0.5, s * 0.5, -s * 0.5, s * 0.5), rectAt(t, ang, -s * 0.5, s * 0.5, -s * 0.5, s * 0.5)[0]], width: 0.5 });
  }
  if (!fits(P, body, 0.5)) body = hall;
  out.buildings.push({ poly: body, kind: 'landmark', parcel: 0, arch: great ? 'mud-great-mosque' : 'mud-mosque', roof: 'flat', material: 'mud', storeys: 2, orientation: ang });
  if (great) {
    // the court on the west, walled; its gates on the north and south
    const court = rectAt(c, ang, -L * 0.9, -0.5, -H + 1, H - 1);
    if (fits(P, court, 1)) {
      out.landmarks.push({ kind: 'sahn', poly: court });
      out.lines.push({ kind: 'compound-wall', path: court, closed: true, width: 1.2 });
    }
    out.landmarks.push({ kind: 'great-mosque', poly: hall });
  } else out.landmarks.push({ kind: 'mud-mosque', poly: hall });
  void cx;
  return out;
}

/** The chief's palace: buttressed ranges round two courts, the audience hall on the street. */
function sahelPalace(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'compound:sahel-palace' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const o = obb(P);
  const ang = Math.atan2(o.u.y, o.u.x);
  const fr = bestRect(P, ang, o.hu, o.hv, 1.5);
  if (!fr || fr.hu < 12 || fr.hv < 9) return out;
  const d = Math.max(5, Math.min(7, fr.hv * 0.25));
  const R = (u0: number, u1: number, v0: number, v1: number) => rectAt(fr.c, ang, u0, u1, v0, v1);
  const parts = [R(-fr.hu, fr.hu, -fr.hv, -fr.hv + d), R(-fr.hu, fr.hu, fr.hv - d, fr.hv), R(-fr.hu, -fr.hu + d, -fr.hv + d + 0.01, fr.hv - d - 0.01), R(-d / 2, d / 2, -fr.hv + d + 0.01, fr.hv - d - 0.01), R(fr.hu - d, fr.hu, -fr.hv + d + 0.01, fr.hv - d - 0.01)];
  for (const p of parts) if (fits(P, p, 0.5)) out.buildings.push({ poly: p, kind: 'landmark', parcel: 0, arch: 'sahel-palace', roof: 'flat', material: 'mud', storeys: 2 });
  out.landmarks.push({ kind: 'sahel-palace', poly: R(-fr.hu, fr.hu, -fr.hv, fr.hv) });
  out.lines.push({ kind: 'compound-wall', path: P, closed: true, width: 1.2 });
  void cx;
  return out;
}

let registered = false;
export function registerSahel(): void {
  if (registered) return;
  registered = true;
  registerBuilders({ 'mud-mosque': (l, c) => mudMosque(l, c, true), 'sahel-mosque': (l, c) => mudMosque(l, c, false), 'sahel-palace': sahelPalace });
}

