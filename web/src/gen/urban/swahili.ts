/** Coral-stone coast architecture. All plans use the existing exact lot and courtyard engine. */
import type { Polygon, Vec2 } from '../core/geom';
import type { UrbanBuilding, UrbanLine, UrbanParcel } from '../types';
import { area, obb, orientPos, pointInRing } from '../geo/poly';
import { registerBuilders, type CompoundCtx, type CompoundOut } from './compounds';
import { bestRect } from './persian';
import { rectAt } from './m4/lots';
import { buildOn } from './bops';
import { MORPHOLOGIES, deepMerge } from './morphology';
import type { Plot } from './plots';

const empty = (lot: Polygon, kind: string): CompoundOut => ({ parcels: [{ poly: lot, use: 'compound:' + kind }], buildings: [], lines: [], water: [], landmarks: [] });

/** A compact flat-roofed prayer hall and open forecourt, rather than a domed North-African hypostyle plan. */
function mosque(lot: Polygon, cx: CompoundCtx, friday = false): CompoundOut {
  const kind = friday ? 'swahili-juma-mosque' : 'swahili-mosque';
  const out = empty(lot, kind), o = obb(lot);
  const f = bestRect(lot, cx.angle, Math.min(friday ? 24 : 13, o.hu), Math.min(friday ? 30 : 18, o.hv), 1);
  if (!f || Math.min(f.hu, f.hv) < 5) return out;
  const R = (u0: number, u1: number, v0: number, v1: number) => rectAt(f.c, cx.angle, u0, u1, v0, v1);
  const hall = R(-f.hu, f.hu, -f.hv * 0.15, f.hv);
  const porch = R(-f.hu, f.hu, -f.hv * 0.15 - 2.5, -f.hv * 0.15 - 0.01);
  const court = R(-f.hu, f.hu, -f.hv, -f.hv * 0.15 - 2.51);
  out.buildings.push({ poly: hall, kind: 'landmark', parcel: 0, arch: kind, roof: 'flat', material: 'coral-stone', storeys: 1, orientation: cx.angle });
  out.buildings.push({ poly: porch, kind: 'landmark', parcel: 0, arch: 'swahili-veranda', roof: 'flat', material: 'coral-stone', storeys: 1, orientation: cx.angle });
  // Pillar rows read the hall as a roof carried by timber/stone columns; they are plan lines, not extra masses.
  for (let u = -f.hu + 4; u < f.hu - 2; u += 4) out.lines.push({ kind: 'colonnade', path: [R(u, u + 0.01, 0, f.hv - 1)[0], R(u, u + 0.01, 0, f.hv - 1)[3]], width: 0.25 });
  out.landmarks.push({ kind, poly: hall });
  out.landmarks.push({ kind: 'swahili-mosque-court', poly: court });
  return out;
}

/** Mansion court with a wide veranda on the inside; the street entrance remains an actual open passage. */
function merchantHouse(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = empty(lot, 'swahili-merchant-house'), P = orientPos(lot);
  let edge = 0, length = 0;
  for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length], l = Math.hypot(b.x - a.x, b.y - a.y); if (l > length) { length = l; edge = i; } }
  if (length < 10) return out;
  const a = P[edge], b = P[(edge + 1) % P.length], n = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
  const pl: Plot = { poly: P, block: 0, zone: 'middle', front: [a, b], nrm: n, sideA: { p: a, d: n }, sideB: { p: b, d: n }, rank: 1, depth: 50, wide: true, sideFronts: [], run: 0, order: 0 };
  const params = deepMerge(MORPHOLOGIES['swahili-stone'], { houseArea: { middle: [area(P), area(P)] }, courtyardShare: [0.3, 0.4], arch: { typology: 'swahili-merchant-mansion', storeys: [2, 3] } });
  out.buildings.push(...buildOn(pl, 0.78, params, cx.rng).filter((bld) => bld.kind !== 'garden').map((bld) => ({ ...bld, kind: 'landmark' as const, parcel: 0 })));
  const courts = out.buildings.flatMap((bld) => bld.courtyards ?? []);
  for (const court of courts.slice(0, 1)) out.lines.push({ kind: 'veranda-edge', path: court.concat([court[0]]), width: 0.35 });
  if (out.buildings.length) out.landmarks.push({ kind: 'swahili-merchant-house', poly: out.buildings[0].poly });
  return out;
}

/** Small coastal stone fort: four bastions round an open court, a curtain with an open town-side gate. */
function fort(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = empty(lot, 'swahili-fort'), o = obb(lot);
  const f = bestRect(lot, cx.angle, Math.min(35, o.hu), Math.min(30, o.hv), 1.5);
  if (!f || Math.min(f.hu, f.hv) < 12) return out;
  const R = (u0: number, u1: number, v0: number, v1: number) => rectAt(f.c, cx.angle, u0, u1, v0, v1);
  const w = Math.min(9, Math.min(f.hu, f.hv) * 0.45);
  for (const u of [-f.hu, f.hu - w]) for (const v of [-f.hv, f.hv - w]) out.buildings.push({ poly: R(u, u + w, v, v + w), kind: 'landmark', parcel: 0, arch: 'swahili-fort-bastion', roof: 'flat', material: 'coral-stone', storeys: 2 });
  const ring = R(-f.hu, f.hu, -f.hv, f.hv);
  const gateA = R(-2, 2, -f.hv, -f.hv + 0.01);
  out.lines.push({ kind: 'stone-wall', path: [gateA[1], ring[1], ring[2], ring[3], ring[0], gateA[0]], width: 1.8 });
  out.landmarks.push({ kind: 'swahili-fort', poly: ring });
  return out;
}

export function registerSwahili(): void {
  registerBuilders({ 'swahili-juma-mosque': (p, cx) => mosque(p, cx, true), 'swahili-mosque': mosque, 'swahili-merchant-house': merchantHouse, 'swahili-fort': fort });
}

/** Door glyphs occupy the real 1.8 m gaps cut through courtyard fronts. No geometry or access is changed. */
export function swahiliDoorLines(buildings: UrbanBuilding[], parcels: UrbanParcel[]): UrbanLine[] {
  const out: UrbanLine[] = [], seen = new Set<string>();
  for (const b of buildings) {
    if ((b.arch !== 'swahili-stone-house' && b.arch !== 'swahili-seafront-house') || !b.courtyards?.length || b.parcel === undefined) continue;
    const front = parcels[b.parcel]?.front;
    if (!front) continue;
    const [a, c] = front, L = Math.hypot(c.x - a.x, c.y - a.y);
    if (L < 4) continue;
    const t = { x: (c.x - a.x) / L, y: (c.y - a.y) / L };
    let n = { x: -t.y, y: t.x };
    if (!pointInRing(parcels[b.parcel].poly, { x: (a.x + c.x) / 2 + n.x * 0.2, y: (a.y + c.y) / 2 + n.y * 0.2 })) n = { x: -n.x, y: -n.y };
    const u = (p: Vec2) => (p.x - a.x) * t.x + (p.y - a.y) * t.y;
    const d = (p: Vec2) => (p.x - a.x) * n.x + (p.y - a.y) * n.y;
    const runs: [number, number][] = [];
    for (let i = 0; i < b.poly.length; i++) {
      const p = b.poly[i], q = b.poly[(i + 1) % b.poly.length];
      if (Math.abs(d(p)) < 0.03 && Math.abs(d(q)) < 0.03) runs.push([Math.min(u(p), u(q)), Math.max(u(p), u(q))]);
    }
    runs.sort((x, y) => x[0] - y[0]);
    let end = runs[0]?.[1] ?? L;
    for (let i = 1; i < runs.length; i++) {
      const start = runs[i][0], gap = start - end;
      if (gap >= 1.5 && gap <= 2.2 && end >= 0 && start <= L) {
        const key = b.parcel + ':' + end.toFixed(2);
        if (!seen.has(key)) {
          const at = (x: number, y: number): Vec2 => ({ x: a.x + t.x * x + n.x * y, y: a.y + t.y * x + n.y * y });
          out.push({ kind: 'carved-door', path: [at(end, 0.45), at(end, 0.15), at(start, 0.15), at(start, 0.45)], width: 0.25 });
          out.push({ kind: 'carved-door', path: [at((end + start) / 2, 0.15), at((end + start) / 2, 0.65)], width: 0.2 });
          seen.add(key);
        }
      }
      end = Math.max(end, runs[i][1]);
    }
  }
  return out;
}
