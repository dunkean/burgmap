/**
 * Korean walled capital or town (Hanyang/Seoul, Suwon, Jeonju; Hahoe for the villages), laid out by pungsu: the
 * mountain behind (north), the water in front (south). The palace (Gyeongbokgung) at the north end of the main
 * axis: the gate on the south, the throne hall on its stone terrace inside a cloister, the council hall and the
 * residential halls behind, the pond pavilion on the west; the royal ancestral shrine (Jongmyo) east of the axis;
 * the Confucian school (hyanggyo); Buddhist temples outside the walls; the main east–west street (Jongno) with
 * its market rows; hanok courtyard houses (ㄱ, ㄷ and ㅁ plans round the madang) behind their walls.
 */
import type { Vec2, Polygon } from '../core/geom';
import type { CompoundCtx, CompoundOut } from './compounds';
import { registerBuilders } from './compounds';
import { orientPos, pointInRing, obb } from '../geo/poly';
import { fits, minus } from './m4/kit';
import { rectAt } from './m4/lots';
import { bestRect } from './persian';

const overlap = (A: Polygon, B: Polygon): boolean => A.some((q) => pointInRing(B, q)) || B.some((q) => pointInRing(A, q));
/** South-facing compounds: u = north (−y on the map). */
const NORTH = -Math.PI / 2;
type B = CompoundOut['buildings'][number];

/** The frame of a south-facing compound: the largest rectangle with u pointing north. */
function frameN(P: Polygon, margin: number): { c: Vec2; hu: number; hv: number } | null {
  const o = obb(P);
  const r = bestRect(P, NORTH, Math.max(o.hu, o.hv), Math.max(o.hu, o.hv), margin);
  return r ? { c: r.c, hu: r.hu, hv: r.hv } : null;
}

/**
 * The palace: Gwanghwamun on the south wall, a first court, Geunjeongmun, the throne hall (Geunjeongjeon) on its
 * terrace in a cloistered court, the council hall and the king's and queen's halls behind it, the pond with the
 * banquet pavilion on its island in the west of the precinct.
 */
function koreanPalace(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'compound:korean-palace' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const f = frameN(P, 1.5);
  if (!f || f.hu < 25 || f.hv < 18) return out;
  const R = (u0: number, u1: number, v0: number, v1: number) => rectAt(f.c, NORTH, u0, u1, v0, v1);
  const { hu, hv } = f;
  const add = (poly: Polygon, arch: string, roof: B['roof'], storeys: number): boolean => {
    if (!fits(P, poly, 0.5) || out.buildings.some((b) => overlap(b.poly, poly))) return false;
    out.buildings.push({ poly, kind: 'landmark', parcel: 0, arch, roof, material: 'wood', storeys, orientation: Math.PI / 2 });
    return true;
  };
  const aw = Math.min(hv * 0.55, 60);
  // the main gate on the south wall (u = −hu is the south), the inner gate, then the cloister of the throne hall
  add(R(-hu, -hu + 7, -9, 9), 'gwanghwamun-gate', 'tiled-hip', 2);
  const c0 = -hu + hu * 0.3, c1 = c0 + Math.min(hu * 0.75, aw * 1.4);
  add(R(c0, c0 + 5, -6, 6), 'palace-gate', 'tiled-hip', 1);
  // the cloister (corridors round the throne court)
  const cw = 4;
  for (const r of [R(c0 + 5.01, c1, -aw / 2, -aw / 2 + cw), R(c0 + 5.01, c1, aw / 2 - cw, aw / 2), R(c1 - cw, c1, -aw / 2 + cw + 0.01, aw / 2 - cw - 0.01), R(c0, c0 + 5, -aw / 2, -6.01), R(c0, c0 + 5, 6.01, aw / 2)]) add(r, 'cloister-corridor', 'tiled-hip', 1);
  const th = Math.min(18, (c1 - c0) * 0.25), tw = Math.min(aw * 0.32, 30);
  const tc = c0 + (c1 - c0) * 0.62;
  if (add(R(tc - th / 2, tc + th / 2, -tw / 2, tw / 2), 'throne-hall', 'tiled-hip', 2)) {
    out.landmarks.push({ kind: 'throne-hall', poly: R(tc - th / 2, tc + th / 2, -tw / 2, tw / 2) });
    out.lines.push({ kind: 'pyramid-step', path: [...R(tc - th / 2 - 4, tc + th / 2 + 2, -tw / 2 - 4, tw / 2 + 4), R(tc - th / 2 - 4, tc + th / 2 + 2, -tw / 2 - 4, tw / 2 + 4)[0]], width: 0.5 });
  }
  // the halls behind, on the axis
  let u = c1 + 6;
  for (const [arch, d, w] of [['council-hall', 12, 0.5], ['kings-hall', 13, 0.6], ['queens-hall', 12, 0.55]] as [string, number, number][]) {
    if (u + d > hu - 4) break;
    add(R(u, u + d, -aw * w / 2, aw * w / 2), arch, 'tiled-hip', 1);
    u += d + 9;
  }
  // the pond and its pavilion in the west of the precinct
  const pv0 = -hv + 6, pv1 = Math.min(-aw / 2 - 8, pv0 + hv * 0.5);
  if (pv1 - pv0 > 18) {
    const pond = R(c0 + 6, Math.min(hu - 6, c0 + 6 + (pv1 - pv0) * 0.9), pv0, pv1);
    if (fits(P, pond, 2)) {
      const isl = R((c0 + 6 + Math.min(hu - 6, c0 + 6 + (pv1 - pv0) * 0.9)) / 2 - 7, (c0 + 6 + Math.min(hu - 6, c0 + 6 + (pv1 - pv0) * 0.9)) / 2 + 7, (pv0 + pv1) / 2 - 5, (pv0 + pv1) / 2 + 5);
      // (the pond is a parcel round its island: the island is the pavilion's own parcel)
      // (cut open by a slit westward from the pond: parcels have no holes)
      const po = obb(pond);
      const slit = rectAt(po.c, NORTH, -0.01, 0.01, -400, 0);
      const rest = minus(P, pond, slit);
      out.parcels = rest.map((poly) => ({ poly, use: 'compound:korean-palace' }));
      for (const w of minus(pond, isl)) { out.parcels.push({ poly: w, use: 'tank' }); out.water.push(w); }
      out.parcels.push({ poly: isl, use: 'compound:korean-palace' });
      const ii = out.parcels.length - 1;
      // re-home the buildings already placed in the piece that holds them
      for (const b of out.buildings) { const k = out.parcels.findIndex((pp) => pp.use !== 'tank' && fits(pp.poly, b.poly, 0)); b.parcel = k >= 0 ? k : 0; }
      out.buildings = out.buildings.filter((b) => fits(out.parcels[b.parcel].poly, b.poly, 0));
      out.buildings.push({ poly: rectAt(obb(isl).c, NORTH, -5, 5, -3.6, 3.6), kind: 'landmark', parcel: ii, arch: 'gyeonghoeru-pavilion', roof: 'tiled-hip', material: 'wood', storeys: 2 });
    }
  }
  out.landmarks.push({ kind: 'korean-palace', poly: P });
  out.lines.push({ kind: 'compound-wall', path: P, closed: true, width: 1.6 });
  void cx;
  return out;
}

/** An axial south-facing precinct: gate on the south, halls in file up the axis (shrine, school, temple). */
function axialPrecinct(lot: Polygon, kind: string, halls: [string, number, number][], extra?: (out: CompoundOut, P: Polygon, R: (u0: number, u1: number, v0: number, v1: number) => Polygon, hu: number, hv: number) => void): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'compound:' + kind }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const f = frameN(P, 1);
  if (!f || f.hu < 12 || f.hv < 8) return out;
  const R = (u0: number, u1: number, v0: number, v1: number) => rectAt(f.c, NORTH, u0, u1, v0, v1);
  const add = (poly: Polygon, arch: string, storeys: number) => {
    if (fits(P, poly, 0.5) && !out.buildings.some((b) => overlap(b.poly, poly))) out.buildings.push({ poly, kind: 'landmark', parcel: 0, arch, roof: 'tiled-hip', material: 'wood', storeys, orientation: Math.PI / 2 });
  };
  add(R(-f.hu, -f.hu + 5, -Math.min(6, f.hv * 0.4), Math.min(6, f.hv * 0.4)), kind + '-gate', 1);
  let u = -f.hu + 5 + Math.max(6, f.hu * 0.2);
  for (const [arch, d, w] of halls) {
    const dd = Math.min(d, f.hu * 0.4);
    if (u + dd > f.hu - 1) break;
    add(R(u, u + dd, -f.hv * w, f.hv * w), arch, 1);
    u += dd + Math.max(5, f.hu * 0.12);
  }
  extra?.(out, P, R, f.hu, f.hv);
  if (out.buildings.length) out.landmarks.push({ kind, poly: out.buildings[out.buildings.length - 1].poly });
  out.lines.push({ kind: 'compound-wall', path: P, closed: true, width: 1.1 });
  return out;
}

let registered = false;
export function registerKorea(): void {
  if (registered) return;
  registered = true;
  registerBuilders({
    'korean-palace': koreanPalace,
    // Jongmyo: the long hall of the royal ancestors (a single range of 19 bays) behind its gate
    jongmyo: (l) => axialPrecinct(l, 'jongmyo', [['jongmyo-jeongjeon', 14, 0.85]]),
    // the Confucian school: the shrine hall (daeseongjeon) in front, the lecture hall (myeongnyundang) behind, dormitories
    hyanggyo: (l) => axialPrecinct(l, 'hyanggyo', [['daeseongjeon-shrine', 10, 0.35], ['myeongnyundang-hall', 9, 0.45]], (out, P, R, hu, hv) => {
      for (const sv of [-1, 1]) { const r = R(-hu * 0.1, hu * 0.5, sv < 0 ? -hv : hv - 5, sv < 0 ? -hv + 5 : hv); if (fits(P, r, 0.5) && !out.buildings.some((b) => overlap(b.poly, r))) out.buildings.push({ poly: r, kind: 'landmark', parcel: 0, arch: 'dormitory', roof: 'tiled-hip', material: 'wood', storeys: 1 }); }
    }),
    // a Buddhist temple: the gates, the stone pagoda, the main hall (daeungjeon)
    'korean-temple': (l) => axialPrecinct(l, 'korean-temple', [['daeungjeon-hall', 11, 0.4]], (out, P, R, hu) => {
      const pg = R(-hu * 0.25 - 2.5, -hu * 0.25 + 2.5, -2.5, 2.5);
      if (fits(P, pg, 0.5) && !out.buildings.some((b) => overlap(b.poly, pg))) out.buildings.push({ poly: pg, kind: 'landmark', parcel: 0, arch: 'stone-pagoda', roof: 'pagoda', material: 'stone', storeys: 5 });
    }),
  });
}
