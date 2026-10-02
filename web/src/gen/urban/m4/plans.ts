/**
 * Internal plans of the level-1 landmark lots (URBAN_LANDMARKS.md §1.3): each builder partitions its carved lot
 * into built and open parcels and lays the buildings inside them.
 *
 * cathedral close  parvis on the west front; cruciform cathedral (west towers, aisled nave, transept, choir,
 *                  chevet) oriented east, 80–140 m; cloister on the south side; bishop's palace; canons' houses
 *                  along the close wall
 * palace           forecourt toward the town, corps de logis and wings around the cour d'honneur, garden behind
 * monastery        church on the north side of the cloister, ranges round the garth, gatehouse and guest house,
 *                  garden and orchard inside the precinct wall
 * madrasa          (medina) cells round a court with iwans on the axes and a prayer hall
 */
import type { Vec2, Polygon } from '../../core/geom';
import { dist } from '../../core/geom';
import type { CompoundCtx } from '../compounds';
import type { UrbanTree } from '../../types';
import { area, orientPos, pointInRing, distToRing, inscribed } from '../../geo/poly';
import { unionS, intersectionS } from '../../geo/bool';
import { disk } from '../../geo/offset';
import { rectAt, frameAt } from './lots';
import { emptyOut, splitLine, largest, fits, placeRect, alongEdge, minus, inter, type Out } from './kit';
import type { CloseData, PalaceData, MonasteryData } from './catalogue';

type B = Out['buildings'][number];

/** Extent of a polygon in the frame (c, ang): [umin, umax, vmin, vmax]. */
function extent(p: Polygon, c: Vec2, ang: number): [number, number, number, number] {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const q of p) {
    const u = (q.x - c.x) * ca + (q.y - c.y) * sa, v = -(q.x - c.x) * sa + (q.y - c.y) * ca;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  return [u0, u1, v0, v1];
}

/** Ring of four rectangles (N/S full length, E/W between) around a rectangular court. */
function ringRects(c: Vec2, ang: number, u0: number, u1: number, v0: number, v1: number, w: number): Polygon[] {
  return [
    rectAt(c, ang, u0, u1, v0, v0 + w), rectAt(c, ang, u0, u1, v1 - w, v1),
    rectAt(c, ang, u0, u0 + w, v0 + w, v1 - w), rectAt(c, ang, u1 - w, u1, v0 + w, v1 - w),
  ];
}

/** Cruciform cathedral of length Lc starting at u0 (west front) on the axis v = vc. */
function cathedralParts(c: Vec2, ang: number, u0: number, vc: number, Lc: number): Polygon[] {
  // (the parts overlap by 10 cm so that their union is one polygon whatever the rounding)
  const W = 0.26 * Lc, R = (u: number, uu: number, a: number, b: number) => rectAt(c, ang, u0 + u * Lc - (u > 0 ? 0.1 : 0), u0 + uu * Lc + (uu < 0.87 ? 0.1 : 0), vc + a, vc + b);
  const tw = 0.03 * Lc;
  const apse: Polygon = orientPos(Array.from({ length: 11 }, (_, k) => {
    const a = -Math.PI / 2 + (k / 10) * Math.PI;
    return frameAt(c, ang, u0 + 0.87 * Lc - 0.1 + Math.cos(a) * (W * 0.5 + 0.1), vc + Math.sin(a) * W * 0.5);
  }));
  return [
    R(0, 0.12, -W / 2 - tw, W / 2 + tw), // west front with its two towers
    R(0.12, 0.58, -W / 2, W / 2), // aisled nave
    R(0.58, 0.7, -0.24 * Lc, 0.24 * Lc), // transept
    R(0.7, 0.87, -W / 2, W / 2), // choir
    apse, // chevet
  ];
}

export function buildCathedralClose(Bk: Polygon, cx: CompoundCtx): Out {
  const d = cx.data as CloseData | undefined;
  const out = emptyOut();
  const ang = d?.ang ?? 0;
  const c0 = inscribed(Bk, [], 1).c;
  const [umin, umax, vmin, vmax] = extent(Bk, c0, ang);
  let Lc = Math.min(d?.Lc ?? 90, umax - umin - 24);
  const pd = Math.max(16, Math.min(32, 0.22 * Lc));
  // parvis: the west part of the lot
  const cutP = frameAt(c0, ang, umin + pd, 0);
  const [eastP, westP] = splitLine(Bk, cutP, { x: Math.cos(ang), y: Math.sin(ang) });
  const close = largest(eastP);
  if (!close || area(close) < 2000) return { ...emptyOut(), parcels: [{ poly: Bk, use: 'green' }] };
  for (const w of westP) { out.parcels.push({ poly: w, use: 'place' }); out.landmarks.push({ kind: 'parvis', poly: w }); }
  for (const e of eastP) if (e !== close) out.parcels.push({ poly: e, use: 'green' });
  const ci = out.parcels.length;
  out.parcels.push({ poly: close, use: 'green' });
  const bld = (poly: Polygon | null, kind: B["kind"], arch: string, storeys: number, roof: B["roof"] = "gable"): boolean => {
    if (!poly || !fits(close, poly, 0.5)) return false;
    if (out.buildings.some((b) => intersectionS(b.poly, poly).some((ph) => area(ph.outer) > 0.05))) return false;
    out.buildings.push({ poly, kind, parcel: ci, arch, roof, material: 'stone', storeys, orientation: ang });
    return true;
  };
  // cathedral: the longest cruciform that fits (west front on the parvis), north of the middle so the cloister
  // fits on the south side; positions across the lot and a short west shift are tried before shrinking
  let placed = false;
  for (let it = 0; it < 12 && !placed; it++, Lc *= 0.95) {
    const ht = 0.24 * Lc, W = 0.26 * Lc;
    let pick: { u0: number; vc: number; body: Polygon } | null = null;
    for (const du of [3, 8, 14]) {
      const u0 = umin + pd + du;
      for (let f = 0.15; f <= 0.75 && !pick; f += 0.1) {
        const vc = vmin + 2 + ht + f * Math.max(0, vmax - vmin - 4 - 2 * ht);
        const parts = cathedralParts(c0, ang, u0, vc, Lc);
        if (!parts.every((p) => fits(close, p, 1.2))) continue;
        const u = unionS(parts[0], ...parts.slice(1).map((p) => [{ outer: p, holes: [] }]));
        const body = largest(u.filter((ph) => !ph.holes.length).map((ph) => ph.outer));
        if (body && fits(close, body, 1)) pick = { u0, vc, body };
      }
      if (pick) break;
    }
    if (!pick) continue;
    const { u0, vc, body } = pick;
    out.buildings.push({ poly: body, kind: 'cathedral', parcel: ci, arch: 'gothic-cathedral', roof: 'gable', material: 'stone', storeys: 3, orientation: ang });
    out.landmarks.push({ kind: 'cathedral', poly: body });
    placed = true;
    // cloister on the south side of the nave (else the north side), ranges round the garth
    const rw = Math.max(5, 0.065 * Lc);
    let done = false;
    for (const G0 of [0.3, 0.24, 0.19]) {
      const G = Math.max(14, G0 * Lc);
      for (const side of [1, -1]) for (const sh of [0.2, 0.12, 0.28]) {
        if (done) break;
        const ua = u0 + sh * Lc;
        const va = side > 0 ? vc + W / 2 + 1.2 : vc - W / 2 - 1.2 - G - 2 * rw;
        const ring = ringRects(c0, ang, ua, ua + G + 2 * rw, va, va + G + 2 * rw, rw);
        if (ring.every((p) => fits(close, p, 0.8)) && !ring.some((p) => intersectionS(p, body).length)) {
          ring.forEach((p, i) => bld(p, 'landmark', i === 3 ? 'chapter-house-range' : 'cloister-range', 2));
          out.landmarks.push({ kind: 'garth', poly: rectAt(c0, ang, ua + rw, ua + rw + G, va + rw, va + rw + G) });
          done = true;
        }
      }
      if (done) break;
    }
    // bishop's palace north of the cathedral (or east of the chevet)
    const vn = vc - 0.24 * Lc - 5;
    for (const [pu, pv] of [[u0 + 0.3 * Lc, vn - 11], [u0 + 0.75 * Lc, vn - 11], [u0 + Lc + 18, vc], [u0 + 0.5 * Lc, vc + 0.24 * Lc + 16]] as [number, number][]) {
      const hu = 14, hv = 9;
      const main = rectAt(c0, ang, pu - hu, pu + hu, pv - hv, pv + hv);
      if (bld(main, 'landmark', 'bishops-palace', 2)) { bld(rectAt(c0, ang, pu + hu - 9, pu + hu, pv + hv + 0.01, pv + hv + 12), 'landmark', 'bishops-palace-wing', 2); break; }
    }
  }
  // canons' houses along the close wall
  const P = orientPos(close);
  let nh = 0;
  for (let i = 0; i < P.length && nh < 18; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    const L = dist(a, b);
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (L < 24 || westP.some((w) => distToRing(w, m) < 1)) continue;
    const k = Math.floor((L - 6) / 17);
    for (let j = 0; j < k && nh < 18; j++) {
      const r = alongEdge(P, i, cx.rng.range(9, 12), cx.rng.range(8, 11), 1.5, (j + 0.5) / k);
      if (r && bld(r, 'landmark', 'canons-house', 2)) nh++;
    }
  }
  // the close wall (open on the parvis)
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (!westP.some((w) => distToRing(w, m) < 0.5)) out.lines.push({ kind: 'compound-wall', path: [a, b], width: 1 });
  }
  return out;
}

export function buildPalace(Bk: Polygon, cx: CompoundCtx): Out {
  const d = cx.data as PalaceData | undefined;
  const ang = d?.ang ?? 0;
  const out = emptyOut();
  const c0 = inscribed(Bk, [], 1).c;
  const [umin, umax, vmin, vmax] = extent(Bk, c0, ang);
  const D = umax - umin, Wd = vmax - vmin;
  if (D < 40 || Wd < 36) return { ...emptyOut(), parcels: [{ poly: Bk, use: 'compound:palace' }] };
  const fd = Math.max(14, 0.2 * D);
  // forecourt at the front (+u), the palace parcel behind it, split again into the court and the garden
  const [frontP, backP] = splitLine(Bk, frameAt(c0, ang, umax - fd, 0), { x: Math.cos(ang), y: Math.sin(ang) });
  const pal = largest(backP);
  if (!pal) return { ...emptyOut(), parcels: [{ poly: Bk, use: 'compound:palace' }] };
  for (const f of frontP) { out.parcels.push({ poly: f, use: 'place' }); out.landmarks.push({ kind: 'forecourt', poly: f }); }
  const logisD = Math.min(16, Math.max(11, 0.12 * D));
  const uBack = umax - fd - 0.45 * D;
  const [courtP, gardenP] = splitLine(pal, frameAt(c0, ang, uBack - logisD - 1.5, 0), { x: Math.cos(ang), y: Math.sin(ang) });
  const court = largest(courtP);
  for (const g of gardenP) out.parcels.push({ poly: g, use: 'garden' });
  for (const q of courtP) if (q !== court) out.parcels.push({ poly: q, use: 'compound:palace' });
  if (!court) return out;
  const ci = out.parcels.length;
  out.parcels.push({ poly: court, use: 'compound:palace' });
  const vw = Math.min(Wd * 0.38, 55);
  const pieces = [
    rectAt(c0, ang, uBack - logisD, uBack, -vw, vw), // corps de logis
    rectAt(c0, ang, uBack + 0.01, umax - fd - 3, -vw, -vw + 11), // wings round the cour d'honneur
    rectAt(c0, ang, uBack + 0.01, umax - fd - 3, vw - 11, vw),
  ];
  pieces.forEach((p, i) => { if (fits(court, p, 1)) out.buildings.push({ poly: p, kind: 'landmark', parcel: ci, arch: i === 0 ? 'corps-de-logis' : 'palace-wing', roof: 'hip', material: 'stone', storeys: 3, orientation: ang }); });
  // garden: parterre axes
  const g = largest(gardenP);
  if (g) {
    const gc = inscribed(g, [], 1).c;
    out.lines.push({ kind: 'parterre', path: [frameAt(gc, ang, -0.4 * (uBack - umin), 0), frameAt(gc, ang, 0.35 * (uBack - umin), 0)], width: 0.6 });
    out.lines.push({ kind: 'parterre', path: [frameAt(gc, ang, 0, -0.35 * Wd), frameAt(gc, ang, 0, 0.35 * Wd)], width: 0.6 });
  }
  const P = orientPos(Bk);
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (!frontP.some((f) => distToRing(f, m) < 0.5)) out.lines.push({ kind: 'compound-wall', path: [a, b], width: 1.2 });
  }
  out.landmarks.push({ kind: 'palace', poly: pieces[0] });
  return out;
}

/** Orchard trees on a grid inside a parcel. */
export function orchardTrees(p: Polygon, step: number, r: number): UrbanTree[] {
  const t: UrbanTree[] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of p) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  for (let y = y0 + step / 2; y < y1; y += step) for (let x = x0 + step / 2; x < x1; x += step) {
    const q = { x, y };
    if (pointInRing(p, q) && distToRing(p, q) > r + 0.5) t.push({ x, y, r });
  }
  return t;
}

export function buildMonastery(Bk: Polygon, cx: CompoundCtx): Out & { trees?: UrbanTree[] } {
  const d = cx.data as MonasteryData | undefined;
  const ang = d?.ang ?? 0;
  const out: Out & { trees?: UrbanTree[] } = emptyOut();
  const c0 = inscribed(Bk, [], 1).c;
  const [umin, umax, vmin, vmax] = extent(Bk, c0, ang);
  const D = umax - umin, Wd = vmax - vmin;
  // the claustral core in the west 60 %, garden (north) and orchard (south) to the east
  const ue = umin + Math.max(60, 0.62 * D);
  const [coreP, eastP] = ue < umax - 15 ? splitLine(Bk, frameAt(c0, ang, ue, 0), { x: -Math.cos(ang), y: -Math.sin(ang) }) : [[Bk], []];
  const core = largest(coreP);
  if (!core) return { ...emptyOut(), parcels: [{ poly: Bk, use: 'green' }] };
  for (const q of coreP) if (q !== core) out.parcels.push({ poly: q, use: 'garden' });
  const vm = (vmin + vmax) / 2;
  const trees: UrbanTree[] = [];
  for (const e of eastP) {
    const [gn, os] = splitLine(e, frameAt(c0, ang, 0, vm), { x: Math.sin(ang), y: -Math.cos(ang) });
    for (const g of gn) out.parcels.push({ poly: g, use: 'garden' });
    for (const o of os) { out.parcels.push({ poly: o, use: 'garden' }); trees.push(...orchardTrees(o, 9, 2.6)); out.landmarks.push({ kind: 'orchard', poly: o }); }
  }
  const ci = out.parcels.length;
  out.parcels.push({ poly: core, use: 'compound:monastery' });
  const bld = (poly: Polygon | null, kind: B["kind"], arch: string, storeys: number): boolean => {
    if (!poly || !fits(core, poly, 0.8)) return false;
    if (out.buildings.some((b) => intersectionS(b.poly, poly).some((ph) => area(ph.outer) > 0.05))) return false;
    out.buildings.push({ poly, kind, parcel: ci, arch, roof: 'gable', material: 'stone', storeys, orientation: ang });
    return true;
  };
  const [cu0, cu1, cv0, cv1] = extent(core, c0, ang);
  let Lch = Math.max(26, Math.min(64, 0.62 * (cu1 - cu0)));
  for (let it = 0; it < 8; it++, Lch *= 0.9) {
    const W = 0.3 * Lch;
    const u0 = cu0 + 6, vc = cv0 + 5 + W / 2;
    const nave = rectAt(c0, ang, u0, u0 + 0.72 * Lch + 0.1, vc - W / 2, vc + W / 2);
    const choir = rectAt(c0, ang, u0 + 0.72 * Lch - 0.1, u0 + 0.92 * Lch + 0.1, vc - W * 0.36, vc + W * 0.36);
    const apse = orientPos(Array.from({ length: 9 }, (_, k) => { const a = -Math.PI / 2 + (k / 8) * Math.PI; return frameAt(c0, ang, u0 + 0.92 * Lch - 0.1 + Math.cos(a) * (W * 0.36 + 0.1), vc + Math.sin(a) * W * 0.36); }));
    const tr = rectAt(c0, ang, u0 + 0.6 * Lch, u0 + 0.72 * Lch, vc - W * 0.85, vc + W * 0.85);
    const parts = [nave, choir, apse, tr];
    if (!parts.every((p) => fits(core, p, 1))) continue;
    const body = largest(unionS(parts[0], ...parts.slice(1).map((p) => [{ outer: p, holes: [] }])).filter((ph) => !ph.holes.length).map((ph) => ph.outer));
    if (!body || !bld(body, 'church', 'abbey-church', 2)) continue;
    out.landmarks.push({ kind: 'abbey-church', poly: body });
    // cloister south of the nave
    const rw = 6, G = Math.max(14, Math.min(32, 0.45 * Lch));
    for (const sh of [0.08, 0, 0.2]) {
      const ua = u0 + sh * Lch, va = vc + W / 2 + 1;
      const ring = ringRects(c0, ang, ua, ua + G + 2 * rw, va, va + G + 2 * rw, rw);
      if (ring.every((p) => fits(core, p, 0.8))) {
        ring.forEach((p, i) => bld(p, 'landmark', i === 3 ? 'dormitory-range' : i === 1 ? 'refectory-range' : 'cloister-range', 2));
        out.landmarks.push({ kind: 'garth', poly: rectAt(c0, ang, ua + rw, ua + rw + G, va + rw, va + rw + G) });
        // infirmary / guest house south of the cloister
        bld(placeRect(core, frameAt(c0, ang, ua + G * 0.7, va + G + 2 * rw + 9), ang, 10, 5.5, 1), 'landmark', 'guest-house', 2);
        break;
      }
    }
    break;
  }
  // gatehouse on the precinct front, and the precinct wall
  const P = orientPos(Bk);
  out.lines.push({ kind: 'compound-wall', path: P, closed: true, width: 1.2 });
  out.trees = trees;
  void Wd; void vmin; void vmax; void cv1;
  return out;
}

/** Medina variant: madrasa (cells round a court, iwans on the axes, prayer hall on the qibla side). */
export function buildMadrasa(Bk: Polygon, cx: CompoundCtx): Out {
  const out = emptyOut();
  out.parcels.push({ poly: Bk, use: 'compound:madrasa' });
  const ang = (cx.data as MonasteryData | undefined)?.ang ?? 0;
  const c0 = inscribed(Bk, [], 1).c;
  for (let s = 1; s >= 0.5; s -= 0.1) {
    const h = Math.min(32, Math.sqrt(area(Bk)) * 0.32) * s;
    const ring = ringRects(c0, ang, -h, h, -h, h, Math.max(5, h * 0.28));
    if (!ring.every((p) => fits(Bk, p, 1))) continue;
    ring.forEach((p) => out.buildings.push({ poly: p, kind: 'landmark', parcel: 0, arch: 'madrasa-cells', roof: 'flat', material: 'mud', storeys: 2, orientation: ang }));
    out.landmarks.push({ kind: 'sahn', poly: rectAt(c0, ang, -h + h * 0.28, h - h * 0.28, -h + h * 0.28, h - h * 0.28) });
    const m = placeRect(Bk, frameAt(c0, ang, h + 12, 0), ang, 8, 5, 1);
    if (m && !out.buildings.some((b) => intersectionS(b.poly, m).length)) out.buildings.push({ poly: m, kind: 'landmark', parcel: 0, arch: 'minaret', roof: 'pyramidal', material: 'stone', storeys: 5 });
    break;
  }
  out.lines.push({ kind: 'compound-wall', path: orientPos(Bk), closed: true, width: 1.2 });
  return out;
}

export { disk, minus, inter, placeRect, splitLine };

/** Hospital (hôtel-Dieu) by a gate: the great infirmary hall along the street, its chapel at the east end, a
 * range round the yard and a garden. */
export function buildHospital(Bk: Polygon, cx: CompoundCtx): Out {
  const out = emptyOut();
  out.parcels.push({ poly: Bk, use: 'compound:hospital' });
  const P = orientPos(Bk);
  // the longest edge carries the hall (street side)
  let bi = 0, bl = 0;
  for (let i = 0; i < P.length; i++) { const l = dist(P[i], P[(i + 1) % P.length]); if (l > bl) { bl = l; bi = i; } }
  const hall = alongEdge(P, bi, cx.rng.range(11, 14), Math.min(48, bl * 0.7), 1.5);
  if (hall) out.buildings.push({ poly: hall, kind: 'landmark', parcel: 0, arch: 'infirmary-hall', roof: 'gable', material: 'stone', storeys: 2 });
  const a = P[bi], b = P[(bi + 1) % P.length];
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  let east = ang;
  while (east > Math.PI / 4) east -= Math.PI / 2;
  while (east < -Math.PI / 4) east += Math.PI / 2;
  const c = inscribed(Bk, [], 1).c;
  const ch = placeRect(Bk, c, east, 7.5, 4, 1.5);
  if (ch && !(hall && intersectionS(ch, hall).some((ph) => area(ph.outer) > 0.05))) out.buildings.push({ poly: ch, kind: 'church', parcel: 0, arch: 'hospital-chapel', roof: 'gable', material: 'stone', storeys: 1, orientation: east });
  out.lines.push({ kind: 'compound-wall', path: P, closed: true, width: 0.9 });
  out.landmarks.push({ kind: 'hospital', poly: Bk });
  return out;
}
