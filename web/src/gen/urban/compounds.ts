/**
 * Compounds and landmarks (URBAN_GEOMETRY.md §3.4): large lots claimed BEFORE plot cutting — a whole block, or the
 * nucleus piece — and filled by a footprint builder. The claiming is generic (a placement rule and an area range),
 * so later milestones (docks, mills, arenas, suburbs) plug in with their own builders.
 *
 * Builders return an exact partition of the lot into parcels (usually one; moats, baileys, tanks split it), the
 * buildings inside those parcels (kind 'landmark', with architecture metadata), plan lines (enclosure walls,
 * prakaras, stone walls) and water pieces. Every footprint is fitted inside its parcel with a margin.
 */
import type { Vec2, Polygon } from '../core/geom';
import { dist, polygonCentroid } from '../core/geom';
import type { Rng } from '../core/rng';
import { area, inscribed, pointInRing, distToRing, orientPos, obb, cleanRing } from '../geo/poly';
import { MultiPoly, differenceS, intersectionS, unionS } from '../geo/bool';
import { disk } from '../geo/offset';
import { churchFootprint } from './landmarks';
import type { ArchBldg } from './bops';
import { dropOverlaps } from './buildings';
import { polyInside } from '../geo/split';
import type { UrbanLine } from '../types';

export interface CompoundOut {
  parcels: { poly: Polygon; use: string }[];
  /** Buildings with the index of their parcel in `parcels`. */
  buildings: (ArchBldg & { parcel: number })[];
  lines: UrbanLine[];
  water: Polygon[];
  landmarks: { kind: string; poly: Polygon }[];
  /** Fortified curtains drawn as walls with towers (castle enceinte, M4). */
  walls?: { ring: Polygon; gates: { p: Vec2; dir: Vec2; width: number }[]; role: 'castle' | 'quarter'; skip?: (p: Vec2) => boolean }[];
  /** Trees of orchards and gardens inside the compound (canopy layer). */
  trees?: { x: number; y: number; r: number }[];
}
export interface CompoundCtx {
  angle: number; pop: number; rng: Rng; center: Vec2;
  /** Plan data of a level-1 landmark lot (M4: castle enceinte, close layout, quay...). */
  data?: unknown;
}

const rectAt = (c: Vec2, ang: number, u0: number, u1: number, v0: number, v1: number): Polygon => {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const at = (u: number, v: number): Vec2 => ({ x: c.x + u * ca - v * sa, y: c.y + u * sa + v * ca });
  return orientPos([at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)]);
};
const inside = (lot: Polygon, pts: Polygon, margin: number) => pts.every((p) => pointInRing(lot, p) && distToRing(lot, p) >= margin);

/**
 * Largest scale factor s ≤ 1 (bisection) such that the layout built at scale s fits inside the lot with a margin.
 * The layout is a function of the scale returning all its polygons.
 */
function fitScale(lot: Polygon, build: (s: number) => Polygon[], margin: number): number {
  if (build(1).every((p) => inside(lot, p, margin))) return 1;
  let lo = 0.001, hi = 1;
  if (!build(lo).every((p) => inside(lot, p, margin))) return 0;
  for (let k = 0; k < 20; k++) {
    const m = (lo + hi) / 2;
    if (build(m).every((p) => inside(lot, p, margin))) lo = m; else hi = m;
  }
  return lo;
}

/**
 * Frame of a lot: the largest centred rectangle at angle `ang` (around the inscribed centre), trying the lot's own
 * aspect and more compact ones; scored by area × √(short / long side).
 */
function lotFrame(lot: Polygon, ang: number): { c: Vec2; hu: number; hv: number } {
  const ins = inscribed(lot, [], 1);
  const c = ins.c;
  const ob = obb(lot);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const projU = Math.abs(ob.u.x * ca + ob.u.y * sa);
  const r0 = projU > 0.7 ? ob.hu / Math.max(1, ob.hv) : ob.hv / Math.max(1, ob.hu);
  let best = { c, hu: 0, hv: 0 }, bs = -1;
  for (const ratio of [r0, Math.sqrt(r0), 1]) {
    const s = fitScale(lot, (k) => [rectAt(c, ang, -k * 400 * ratio, k * 400 * ratio, -k * 400, k * 400)], 0.5);
    const hu = s * 400 * ratio, hv = s * 400;
    const sc = hu * hv * Math.sqrt(Math.min(hu, hv) / Math.max(1e-6, Math.max(hu, hv)));
    if (sc > bs) { bs = sc; best = { c, hu, hv }; }
  }
  return best;
}

const emptyOut = (lot: Polygon, use: string): CompoundOut => ({ parcels: [{ poly: lot, use }], buildings: [], lines: [], water: [], landmarks: [] });

// ---------------------------------------------------------------- great mosque (hypostyle, sahn, minaret)
function greatMosque(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = emptyOut(lot, 'compound:great-mosque');
  const f = lotFrame(lot, cx.angle);
  const hu = f.hu - 1, hv = f.hv - 1;
  if (hu < 7 || hv < 7) return out;
  // u points to the qibla: the prayer hall is on the qibla side (55 %), the court (sahn) behind it with arcades
  const hallU0 = hu - 2 * hu * 0.55;
  const hall = rectAt(f.c, cx.angle, hallU0, hu, -hv, hv);
  const riw = Math.max(2.4, Math.min(5, hv * 0.18));
  const riwaqs = [
    rectAt(f.c, cx.angle, -hu, hallU0 - 1.2, -hv, -hv + riw),
    rectAt(f.c, cx.angle, -hu, hallU0 - 1.2, hv - riw, hv),
  ];
  const mS = Math.min(8, Math.max(4.5, hv * 0.22));
  const minaret = rectAt(f.c, cx.angle, -hu, -hu + mS, -mS / 2, mS / 2);
  const back = [rectAt(f.c, cx.angle, -hu, -hu + riw, -hv + riw + 1.2, -mS / 2 - 1.2), rectAt(f.c, cx.angle, -hu, -hu + riw, mS / 2 + 1.2, hv - riw - 1.2)];
  out.buildings.push({ poly: hall, kind: 'landmark', parcel: 0, arch: 'hypostyle-prayer-hall', roof: 'flat', material: 'mud', storeys: 1, orientation: cx.angle });
  for (const r of [...riwaqs, ...back]) if (area(r) > 20) out.buildings.push({ poly: r, kind: 'landmark', parcel: 0, arch: 'riwaq-arcade', roof: 'flat', material: 'mud', storeys: 1 });
  out.buildings.push({ poly: minaret, kind: 'landmark', parcel: 0, arch: 'minaret', roof: 'pyramidal', material: 'stone', storeys: 6 });
  out.landmarks.push({ kind: 'sahn', poly: rectAt(f.c, cx.angle, -hu + riw, hallU0 - 1.2, -hv + riw, hv - riw) });
  out.lines.push({ kind: 'compound-wall', path: lot, closed: true, width: 1.2 });
  return out;
}

// ---------------------------------------------------------------- kasbah (walled citadel with palace)
export function kasbah(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = emptyOut(lot, 'compound:kasbah');
  out.lines.push({ kind: 'citadel-wall', path: lot, closed: true, width: 2.5 });
  const f = lotFrame(lot, cx.angle);
  const hu = f.hu - 2, hv = f.hv - 2;
  if (hu < 11 || hv < 11) return out;
  // palace: a courtyard building in the middle, a small mosque, barracks ranges along the walls
  const pw = Math.min(hu, hv) * 0.55;
  const palace = [rectAt(f.c, cx.angle, -pw, pw, -pw, -pw * 0.45), rectAt(f.c, cx.angle, -pw, pw, pw * 0.45, pw), rectAt(f.c, cx.angle, -pw, -pw * 0.55, -pw * 0.45 + 1, pw * 0.45 - 1), rectAt(f.c, cx.angle, pw * 0.55, pw, -pw * 0.45 + 1, pw * 0.45 - 1)];
  for (const p of palace) out.buildings.push({ poly: p, kind: 'landmark', parcel: 0, arch: 'kasbah-palace', roof: 'flat', material: 'mud', storeys: 2 });
  out.buildings.push({ poly: rectAt(f.c, cx.angle, -hu, -hu + 7, -hv, hv * 0.4), kind: 'landmark', parcel: 0, arch: 'barracks', roof: 'flat', material: 'mud', storeys: 1 });
  const ms = Math.min(14, hv * 0.35);
  out.buildings.push({ poly: rectAt(f.c, cx.angle, hu - ms, hu, hv - ms, hv), kind: 'landmark', parcel: 0, arch: 'kasbah-mosque', roof: 'flat', material: 'mud', storeys: 1 });
  return out;
}

// ---------------------------------------------------------------- hammam
function hammam(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = emptyOut(lot, 'compound:hammam');
  const f = lotFrame(lot, cx.angle);
  const s = Math.min(9, f.hu - 1, f.hv - 1);
  if (s < 3) return out;
  out.buildings.push({ poly: rectAt(f.c, cx.angle, -s, s, -s * 0.6, s * 0.6), kind: 'landmark', parcel: 0, arch: 'hammam', roof: 'dome', material: 'stone', storeys: 1 });
  return out;
}

// ---------------------------------------------------------------- Chinese drum / bell tower (on its square)
function drumTower(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = emptyOut(lot, 'place');
  const f = lotFrame(lot, cx.angle);
  const s = Math.min(10, f.hu * 0.55, f.hv * 0.55);
  if (s < 3) return out;
  out.buildings.push({ poly: rectAt(f.c, cx.angle, -s, s, -s, s), kind: 'landmark', parcel: 0, arch: 'drum-tower', roof: 'pagoda', material: 'brick', storeys: 3 });
  return out;
}

/** Axial compound (yamen, Chinese temple): gate at the south, halls across the N–S axis, side ranges. */
function axialCompound(lot: Polygon, cx: CompoundCtx, typ: 'yamen' | 'chinese-temple'): CompoundOut {
  const out = emptyOut(lot, 'compound:' + typ);
  // the axis is N–S: u = north (−y)
  const ang = -Math.PI / 2;
  const f = lotFrame(lot, ang);
  const hu = f.hu - 1, hv = f.hv - 1;
  if (hu < 14 || hv < 10) return out;
  const hw = Math.min(hv * 0.62, 22);
  // gate hall (south), then 2–3 halls northward
  out.buildings.push({ poly: rectAt(f.c, ang, -hu, -hu + 6, -hw * 0.6, hw * 0.6), kind: 'landmark', parcel: 0, arch: typ + '-gate', roof: 'tiled-hip', material: 'brick', storeys: 1 });
  const nH = hu > 40 ? 3 : 2;
  for (let k = 0; k < nH; k++) {
    const c0 = -hu + 6 + ((2 * hu - 6) * (k + 0.55)) / nH;
    const d = Math.min(11, (2 * hu - 6) / nH - 7);
    if (d < 5) continue;
    out.buildings.push({ poly: rectAt(f.c, ang, c0 - d / 2, c0 + d / 2, -hw, hw), kind: 'landmark', parcel: 0, arch: k === nH - 1 ? typ + '-rear-hall' : typ + '-main-hall', roof: 'tiled-hip', material: 'wood', storeys: 1, orientation: Math.PI / 2 });
  }
  // side ranges (east and west)
  if (hv - hw > 7) for (const sgn of [-1, 1]) {
    const v0 = sgn < 0 ? -hv : hv - 5, v1 = sgn < 0 ? -hv + 5 : hv;
    out.buildings.push({ poly: rectAt(f.c, ang, -hu + 9, hu - 4, v0, v1), kind: 'landmark', parcel: 0, arch: typ + '-side-range', roof: 'tiled-hip', material: 'wood', storeys: 1 });
  }
  // pagoda in the side corridor just inside the gate, clear of the halls and the side range
  const ps = 4.5;
  if (typ === 'chinese-temple' && hv - hw > 2 * ps + 7) {
    out.buildings.push({ poly: rectAt(f.c, ang, -hu + 7.5, -hu + 7.5 + 2 * ps, -hv + 6, -hv + 6 + 2 * ps), kind: 'landmark', parcel: 0, arch: 'pagoda', roof: 'pagoda', material: 'brick', storeys: 7 });
  }
  out.lines.push({ kind: 'compound-wall', path: lot, closed: true, width: 1.4 });
  return out;
}

/** Walled market (Chinese east / west market): stall rows along lanes. */
function walledMarket(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = emptyOut(lot, 'compound:walled-market');
  const f = lotFrame(lot, 0);
  const hu = f.hu - 2, hv = f.hv - 2;
  if (hu < 7 || hv < 7) return out;
  const pitch = 13, rowD = 5;
  for (let v = -hv; v + rowD <= hv; v += pitch) {
    for (const [a, b] of [[-hu, -2], [2, hu]] as [number, number][]) {
      if (b - a < 8) continue;
      out.buildings.push({ poly: rectAt(f.c, 0, a, b, v, v + rowD), kind: 'landmark', parcel: 0, arch: 'market-stall-row', roof: 'gable', material: 'wood', storeys: 1 });
      if (v + rowD + 2 + rowD <= hv) out.buildings.push({ poly: rectAt(f.c, 0, a, b, v + rowD + 0.01, v + 2 * rowD), kind: 'landmark', parcel: 0, arch: 'market-stall-row', roof: 'gable', material: 'wood', storeys: 1 });
    }
  }
  out.lines.push({ kind: 'compound-wall', path: lot, closed: true, width: 1.4 });
  void cx;
  return out;
}

/**
 * Concentric rings of a convex-ish lot cut by causeways: moat / bailey bands as separate parcels. Returns the
 * inner core (the rest) and the parcels of each band.
 */
function bands(lot: Polygon, widths: { w: number; use: string }[], axis: Vec2, c: Vec2, causeway: number): { parcels: { poly: Polygon; use: string }[]; core: Polygon | null; rings: Polygon[] } {
  const parcels: { poly: Polygon; use: string }[] = [];
  const rings: Polygon[] = [];
  let cur: MultiPoly = [{ outer: lot, holes: [] }];
  const ob = obb(lot);
  const L = 2 * (ob.hu + ob.hv) + 50;
  // the causeway strip along `axis` through c (both sides)
  const nx = -axis.y, ny = axis.x;
  const strip: Polygon = orientPos([
    { x: c.x - axis.x * L + nx * causeway / 2, y: c.y - axis.y * L + ny * causeway / 2 }, { x: c.x + axis.x * L + nx * causeway / 2, y: c.y + axis.y * L + ny * causeway / 2 },
    { x: c.x + axis.x * L - nx * causeway / 2, y: c.y + axis.y * L - ny * causeway / 2 }, { x: c.x - axis.x * L - nx * causeway / 2, y: c.y - axis.y * L - ny * causeway / 2 },
  ]);
  for (const { w, use } of widths) {
    const outer = cur.reduce((b, ph) => (area(ph.outer) > area(b.outer) ? ph : b)).outer;
    rings.push(outer);
    const inner = shrink(outer, w);
    if (!inner) return { parcels, core: outer, rings };
    const band = differenceS(outer, inner);
    const moat = differenceS(band, strip);
    for (const ph of moat) if (!ph.holes.length && area(ph.outer) > 5) parcels.push({ poly: ph.outer, use });
    for (const ph of intersectionS(band, strip)) if (!ph.holes.length && area(ph.outer) > 1) parcels.push({ poly: ph.outer, use: use === 'moat' ? 'causeway' : use + '-gate' });
    cur = [{ outer: inner, holes: [] }];
  }
  const core = cur[0].outer;
  rings.push(core);
  return { parcels, core, rings };
}

/** Inward offset of a ring by d (difference with its boundary ribbon), largest piece. */
function shrink(p: Polygon, d: number): Polygon | null {
  const closed = p.concat([p[0]]);
  const n = closed.length;
  // boundary band as a union of edge rectangles (exact enough for straight-sided lots)
  const parts: Polygon[] = [];
  for (let i = 1; i < n; i++) {
    const a = closed[i - 1], b = closed[i], l = dist(a, b) || 1;
    const nx = -(b.y - a.y) / l * d, ny = (b.x - a.x) / l * d;
    const ux = (b.x - a.x) / l * d, uy = (b.y - a.y) / l * d;
    parts.push(orientPos([{ x: a.x - nx - ux, y: a.y - ny - uy }, { x: b.x - nx + ux, y: b.y - ny + uy }, { x: b.x + nx + ux, y: b.y + ny + uy }, { x: a.x + nx - ux, y: a.y + ny - uy }]));
  }
  const band = unionS(parts[0], ...parts.slice(1).map((q): MultiPoly => [{ outer: q, holes: [] }]));
  const r = differenceS(p, band);
  let best: Polygon | null = null;
  for (const ph of r) if (!best || area(ph.outer) > area(best)) best = ph.outer;
  return best && area(best) > 50 ? cleanRing(best, 0.3, 1) : null;
}

// ---------------------------------------------------------------- Japanese castle (moats, baileys, keep)
/**
 * Nested rectangles in the lot's frame: outer ground (the lot minus the outer moat rectangle), outer moat, ninomaru
 * bailey, inner moat, honmaru. Each band is split by a causeway on the side facing the town centre axis, so the
 * parcels are simple polygons that partition the lot exactly.
 */
function jpCastle(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [], buildings: [], lines: [], water: [], landmarks: [] };
  const ang = cx.angle;
  const f = lotFrame(lot, ang);
  const H = Math.min(f.hu, f.hv) - 1, aspect = f.hu / Math.max(1, f.hv);
  if (H < 30) return emptyOut(lot, 'compound:castle');
  const rect = (k: number) => rectAt(f.c, ang, -(H * aspect) * k, H * aspect * k, -H * k, H * k);
  const widths = [{ k: 1, use: 'moat' }, { k: 0.8, use: 'bailey' }, { k: 0.52, use: 'moat' }, { k: 0.42, use: 'compound:castle-honmaru' }];
  const cw = 7; // causeway width
  const causeway = rectAt(f.c, ang, -3 * H * aspect, 0, -cw / 2, cw / 2);
  // outer ground: lot minus the outer rectangle (may be several pieces)
  // (cut open along the causeway line so that no piece has a hole)
  const slit = rectAt(f.c, ang, -4 * H * aspect - 400, 0, -0.01, 0.01);
  for (const ph of differenceS(lot, rect(1), slit)) if (!ph.holes.length && area(ph.outer) > 4) out.parcels.push({ poly: ph.outer, use: 'bailey' });
  for (let i = 0; i < widths.length; i++) {
    const outer = rect(widths[i].k);
    const inner = i + 1 < widths.length ? rect(widths[i + 1].k) : null;
    const band = inner ? differenceS(outer, inner) : [{ outer, holes: [] }];
    const use = widths[i].use;
    if (use === 'moat') {
      // the band is cut by the causeway: two C-shaped halves become one U after removing the strip
      for (const ph of differenceS(band, causeway)) if (!ph.holes.length && area(ph.outer) > 4) { out.parcels.push({ poly: ph.outer, use: 'moat' }); out.water.push(ph.outer); }
      for (const ph of intersectionS(band, causeway)) if (!ph.holes.length && area(ph.outer) > 1) out.parcels.push({ poly: ph.outer, use: 'causeway' });
    } else if (inner) {
      // a ring band (bailey): split it on the causeway line and the opposite side so each piece is simple
      const cut = rectAt(f.c, ang, -3 * H * aspect, 3 * H * aspect, -0.01, 0.01);
      for (const ph of differenceS(band, cut)) if (!ph.holes.length && area(ph.outer) > 4) out.parcels.push({ poly: ph.outer, use });
    } else out.parcels.push({ poly: outer, use });
    out.lines.push({ kind: 'stone-wall', path: widths[i].use === 'moat' ? outer : outer, closed: true, width: 1.6 });
  }
  const hon = out.parcels.findIndex((p) => p.use === 'compound:castle-honmaru');
  if (hon < 0) return out;
  const hr = H * 0.42;
  const ks = Math.min(12, hr * 0.32);
  // keep (tenshu) on its stone base in the rear corner, palace (goten) ranges in front
  const keep = rectAt(f.c, ang, hr * aspect - 2 * ks - 2.5, hr * aspect - 2.5, hr - 2 * ks - 2.5, hr - 2.5);
  out.landmarks.push({ kind: 'tenshu-base', poly: rectAt(f.c, ang, hr * aspect - 2 * ks - 4, hr * aspect - 1, hr - 2 * ks - 4, hr - 1) });
  out.buildings.push({ poly: keep, kind: 'landmark', parcel: hon, arch: 'tenshu', roof: 'pagoda', material: 'wood', storeys: 5 });
  const goten = [
    rectAt(f.c, ang, -hr * aspect * 0.75, hr * aspect * 0.15, -hr * 0.7, -hr * 0.1),
    rectAt(f.c, ang, -hr * aspect * 0.2, hr * aspect * 0.15, -hr * 0.1, hr * 0.45),
  ];
  for (const g of goten) if (inside(out.parcels[hon].poly, g, 1)) out.buildings.push({ poly: g, kind: 'landmark', parcel: hon, arch: 'goten-palace', roof: 'tiled-hip', material: 'wood', storeys: 1 });
  // corner turrets (yagura) on the bailey
  out.parcels.forEach((p, i) => {
    if (p.use !== 'bailey') return;
    const fb = lotFrame(p.poly, ang);
    const s = Math.min(4.5, fb.hu * 0.45, fb.hv * 0.45);
    if (s >= 2.3) out.buildings.push({ poly: rectAt(fb.c, ang, -s, s, -s, s), kind: 'landmark', parcel: i, arch: 'yagura-turret', roof: 'tiled-hip', material: 'wood', storeys: 2 });
  });
  return out;
}

// ---------------------------------------------------------------- Japanese temple precinct
function jpTemple(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = emptyOut(lot, 'compound:jp-temple');
  const f = lotFrame(lot, cx.angle);
  const hu = f.hu - 1.5, hv = f.hv - 1.5;
  if (hu < 10 || hv < 10) return out;
  const hs = Math.min(13, hu * 0.45, hv * 0.55);
  out.buildings.push({ poly: rectAt(f.c, cx.angle, hu * 0.1, hu * 0.1 + 2 * hs * 0.85, -hs, hs), kind: 'landmark', parcel: 0, arch: 'hondo-main-hall', roof: 'tiled-hip', material: 'wood', storeys: 1 });
  out.buildings.push({ poly: rectAt(f.c, cx.angle, -hu, -hu + 6, -hs * 0.45, hs * 0.45), kind: 'landmark', parcel: 0, arch: 'sanmon-gate', roof: 'tiled-hip', material: 'wood', storeys: 2 });
  if (cx.rng.chance(0.5) && hv - hs > 10) {
    const ps = 4;
    out.buildings.push({ poly: rectAt(f.c, cx.angle, -hu + 10, -hu + 10 + 2 * ps, hv - 2 * ps - 1, hv - 1), kind: 'landmark', parcel: 0, arch: 'pagoda', roof: 'pagoda', material: 'wood', storeys: 5 });
  }
  out.landmarks.push({ kind: 'cemetery', poly: rectAt(f.c, cx.angle, hu * 0.1 + 2 * hs * 0.85 + 2, hu, -hv, hv) });
  out.lines.push({ kind: 'compound-wall', path: lot, closed: true, width: 1.2 });
  return out;
}

// ---------------------------------------------------------------- Hindu temple (prakaras, gopurams, shrine)
function hinduTemple(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = emptyOut(lot, 'compound:hindu-temple');
  const ang = cx.angle;
  const f = lotFrame(lot, ang);
  const H = Math.min(f.hu, f.hv) - 1;
  if (H < 20) return out;
  // nested enclosures (prakaras) at 100 %, 64 %, 36 % of the half size
  const levels = [1, 0.64, 0.36];
  const go = [[Math.max(9, H * 0.2), Math.max(6, H * 0.12)], [Math.max(7, H * 0.14), Math.max(5, H * 0.09)], [Math.max(5, H * 0.1), Math.max(4, H * 0.07)]];
  levels.forEach((k, li) => {
    const h = H * k;
    out.lines.push({ kind: 'prakara', path: rectAt(f.c, ang, -h, h, -h, h), closed: true, width: li === 0 ? 2.2 : 1.6 });
    // gopuram gates at the four cardinal midpoints, just inside the wall (the outer ones the tallest)
    const [gw, gd] = go[li];
    for (let q = 0; q < 4; q++) {
      if (li > 0 && q % 2 === 1 && cx.rng.chance(0.4)) continue;
      const a = ang + (q * Math.PI) / 2;
      const g = rectAt(f.c, a, h - gd - 0.6, h - 0.6, -gw / 2, gw / 2);
      out.buildings.push({ poly: g, kind: 'landmark', parcel: 0, arch: li === 0 ? 'gopuram' : 'gopuram-inner', roof: 'pyramidal', material: 'stone', storeys: li === 0 ? 9 : 5, orientation: a });
    }
  });
  // sanctum (vimana) and its mandapa (hall) in front, to the east
  const vs = H * 0.13;
  out.buildings.push({ poly: rectAt(f.c, ang, -vs, vs, -vs, vs), kind: 'landmark', parcel: 0, arch: 'vimana-sanctum', roof: 'pyramidal', material: 'stone', storeys: 4 });
  out.buildings.push({ poly: rectAt(f.c, ang, vs + 1.5, H * 0.36 - go[2][1] - 2, -vs * 0.8, vs * 0.8), kind: 'landmark', parcel: 0, arch: 'mandapa', roof: 'flat', material: 'stone', storeys: 1 });
  // pillared hall and a tank in the outer court
  const hi = H * 0.64 + 3, ho = H - go[0][1] - 3;
  if (ho - hi > 10) {
    out.buildings.push({ poly: rectAt(f.c, ang, hi, ho, -H * 0.55, -H * 0.2), kind: 'landmark', parcel: 0, arch: 'thousand-pillar-hall', roof: 'flat', material: 'stone', storeys: 1 });
    const tk = rectAt(f.c, ang, -ho, -hi, H * 0.2, Math.min(H * 0.55, H * 0.2 + (ho - hi)));
    out.water.push(tk);
    out.landmarks.push({ kind: 'temple-tank', poly: tk });
  }
  return out;
}

// ---------------------------------------------------------------- sacred tank (a block)
function tank(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [], buildings: [], lines: [], water: [], landmarks: [] };
  const f = lotFrame(lot, cx.angle);
  const hu = f.hu - 5, hvv = f.hv - 5;
  const h = Math.min(hu, hvv);
  if (h < 6) return emptyOut(lot, 'place');
  const water = rectAt(f.c, cx.angle, -hu, hu, -hvv, hvv);
  // the ghat ring is cut open by a thin slit (parcels have no holes)
  const slit = rectAt(f.c, cx.angle, -hu - 400, 0, -0.01, 0.01);
  const ghats = differenceS(lot, water, slit);
  for (const ph of ghats) if (!ph.holes.length) out.parcels.push({ poly: ph.outer, use: 'ghat' });
  if (!out.parcels.length) return emptyOut(lot, 'place');
  out.parcels.push({ poly: water, use: 'tank' });
  out.water.push(water);
  for (const k of [0.7, 0.4]) out.lines.push({ kind: 'ghat-steps', path: rectAt(f.c, cx.angle, -hu - 4 * k, hu + 4 * k, -hvv - 4 * k, hvv + 4 * k), closed: true, width: 0.3 });
  // pavilion (mandapa) in the middle of the water
  const ms = Math.min(4, h * 0.2);
  out.buildings.push({ poly: rectAt(f.c, cx.angle, -ms, ms, -ms, ms), kind: 'landmark', parcel: out.parcels.length - 1, arch: 'tank-mandapa', roof: 'pyramidal', material: 'stone', storeys: 1 });
  return out;
}

// ---------------------------------------------------------------- Roman basilica / temple
function basilica(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = emptyOut(lot, 'compound:basilica');
  const f = lotFrame(lot, cx.angle);
  const hu = f.hu - 2, hv = Math.min(f.hv - 2, hu * 0.42);
  if (hu < 12 || hv < 6) return out;
  const nave = rectAt(f.c, cx.angle, -hu + hv * 0.8, hu - hv * 0.8, -hv, hv);
  const ap = (sgn: number) => orientPos(Array.from({ length: 9 }, (_, k) => {
    const a = -Math.PI / 2 + (k / 8) * Math.PI;
    const u = sgn * (hu - hv * 0.8) + sgn * Math.cos(a) * hv * 0.75, v = Math.sin(a) * hv * 0.75;
    return { x: f.c.x + u * Math.cos(cx.angle) - v * Math.sin(cx.angle), y: f.c.y + u * Math.sin(cx.angle) + v * Math.cos(cx.angle) };
  }));
  const u = unionS(nave, ap(1), ap(-1));
  for (const ph of u) out.buildings.push({ poly: ph.outer, kind: 'landmark', parcel: 0, arch: 'basilica', roof: 'gable', material: 'brick', storeys: 2 });
  return out;
}
function romanTemple(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = emptyOut(lot, 'compound:roman-temple');
  const f = lotFrame(lot, cx.angle);
  const hu = Math.min(f.hu - 2, 18), hv = Math.min(f.hv - 2, hu * 0.55);
  if (hu < 8) return out;
  out.buildings.push({ poly: rectAt(f.c, cx.angle, -hu, hu, -hv, hv), kind: 'landmark', parcel: 0, arch: 'podium-temple', roof: 'gable', material: 'stone', storeys: 1 });
  return out;
}

// ---------------------------------------------------------------- elven sacred grove
function grove(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = emptyOut(lot, 'compound:sacred-grove');
  const ins = inscribed(lot, [], 1);
  const R = ins.r - 2;
  if (R < 8) return out;
  // ring of standing stones around a moonlit glade; the great tree is in the canopy layer
  const n = 12;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * 2 * Math.PI;
    const p = { x: ins.c.x + Math.cos(a) * R * 0.62, y: ins.c.y + Math.sin(a) * R * 0.62 };
    out.buildings.push({ poly: orientPos(disk(p, 1.3, 8)), kind: 'landmark', parcel: 0, arch: 'standing-stone', roof: 'none', material: 'stone', storeys: 1 });
  }
  out.buildings.push({ poly: orientPos(disk(ins.c, Math.min(6, R * 0.25), 16)), kind: 'landmark', parcel: 0, arch: 'moon-pavilion', roof: 'dome', material: 'living-wood', storeys: 1 });
  out.lines.push({ kind: 'hedge', path: lot, closed: true, width: 2.5 });
  return out;
}

// ---------------------------------------------------------------- dwarven gatehouse / forge
function dwarfGate(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = emptyOut(lot, 'compound:dwarf-gate');
  const f = lotFrame(lot, cx.angle);
  const hu = f.hu - 1, hv = f.hv - 1;
  if (hu < 8 || hv < 10) return out;
  // two octagonal towers flanking the gate hall that leads into the mountain (u points up the slope)
  const tw = Math.min(8, hv * 0.3);
  for (const sgn of [-1, 1]) {
    const c = { x: f.c.x + Math.cos(cx.angle + Math.PI / 2) * sgn * (hv - tw), y: f.c.y + Math.sin(cx.angle + Math.PI / 2) * sgn * (hv - tw) };
    const oct = orientPos(Array.from({ length: 8 }, (_, k) => ({ x: c.x + Math.cos(((k + 0.5) / 8) * 2 * Math.PI) * tw, y: c.y + Math.sin(((k + 0.5) / 8) * 2 * Math.PI) * tw })));
    out.buildings.push({ poly: oct, kind: 'landmark', parcel: 0, arch: 'gate-tower', roof: 'flat', material: 'rock', storeys: 3 });
  }
  out.buildings.push({ poly: rectAt(f.c, cx.angle, -hu, hu, -hv + 2 * tw + 1, hv - 2 * tw - 1), kind: 'landmark', parcel: 0, arch: 'gate-hall', roof: 'flat', material: 'rock', storeys: 2 });
  return out;
}
function forge(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = emptyOut(lot, 'compound:forge');
  const f = lotFrame(lot, cx.angle);
  const hu = f.hu - 1.5, hv = f.hv - 1.5;
  if (hu < 6 || hv < 5) return out;
  out.buildings.push({ poly: rectAt(f.c, cx.angle, -hu, hu, -hv, hv * 0.3), kind: 'landmark', parcel: 0, arch: 'forge-hall', roof: 'flat', material: 'rock', storeys: 1 });
  const cs = Math.min(3, hv * 0.3);
  out.buildings.push({ poly: rectAt(f.c, cx.angle, -cs, cs, hv * 0.3 + 1, hv * 0.3 + 1 + 2 * cs), kind: 'landmark', parcel: 0, arch: 'forge-chimney', roof: 'none', material: 'rock', storeys: 3 });
  return out;
}

// ---------------------------------------------------------------- European church (existing builder)
function church(lot: Polygon, cx: CompoundCtx, main = true): CompoundOut {
  const fp = churchFootprint(lot, cx.pop, cx.rng, main);
  if (!fp) return emptyOut(lot, 'church');
  const out = emptyOut(lot, 'church');
  for (const p of fp.parts) out.buildings.push({ poly: p, kind: fp.kind, parcel: 0, arch: fp.kind === 'cathedral' ? 'gothic-cathedral' : 'parish-church', roof: 'gable', material: 'stone', storeys: 1 });
  out.landmarks.push({ kind: fp.kind + '-yard', poly: lot });
  for (const p of fp.parts) out.landmarks.push({ kind: fp.kind, poly: p });
  return out;
}

/** Palace (Indian nayak palace, generic): courtyard ranges around a large court with a pillared hall. */
function palace(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = emptyOut(lot, 'compound:palace');
  const f = lotFrame(lot, cx.angle);
  const hu = f.hu - 2, hv = f.hv - 2;
  if (hu < 14 || hv < 14) return out;
  const d = Math.min(9, Math.min(hu, hv) * 0.22);
  for (const r of [rectAt(f.c, cx.angle, -hu, hu, -hv, -hv + d), rectAt(f.c, cx.angle, -hu, hu, hv - d, hv), rectAt(f.c, cx.angle, -hu, -hu + d, -hv + d + 0.01, hv - d - 0.01), rectAt(f.c, cx.angle, hu - d, hu, -hv + d + 0.01, hv - d - 0.01)]) {
    out.buildings.push({ poly: r, kind: 'landmark', parcel: 0, arch: 'palace-range', roof: 'flat', material: 'brick', storeys: 2 });
  }
  out.buildings.push({ poly: rectAt(f.c, cx.angle, -hu * 0.35, hu * 0.35, -hv * 0.3, hv * 0.3), kind: 'landmark', parcel: 0, arch: 'durbar-hall', roof: 'dome', material: 'stone', storeys: 2 });
  out.lines.push({ kind: 'compound-wall', path: lot, closed: true, width: 1.4 });
  return out;
}

/** Mine mouth: an adit (half disk) cut into the rock with a spoil heap and a headframe shed. */
function mine(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = emptyOut(lot, 'compound:mine');
  const f = lotFrame(lot, cx.angle);
  const s = Math.min(9, f.hu - 1.5, f.hv - 1.5);
  if (s < 4) return out;
  const n = 10;
  const adit = orientPos([...Array.from({ length: n + 1 }, (_, k) => {
    const a = (k / n) * Math.PI;
    return { x: f.c.x + Math.cos(cx.angle + a) * s * 0.6, y: f.c.y + Math.sin(cx.angle + a) * s * 0.6 };
  })]);
  out.buildings.push({ poly: adit, kind: 'landmark', parcel: 0, arch: 'mine-mouth', roof: 'none', material: 'rock', storeys: 1 });
  const sh = rectAt(f.c, cx.angle, -s, -s * 0.3, -s * 0.9, -s * 0.2);
  out.buildings.push({ poly: sh, kind: 'landmark', parcel: 0, arch: 'headframe-shed', roof: 'gable', material: 'timber', storeys: 1 });
  out.landmarks.push({ kind: 'spoil-heap', poly: rectAt(f.c, cx.angle, s * 0.2, s, -s * 0.95, -s * 0.25) });
  return out;
}

/** A compact sanctum inside the inscribed disc: no implied cavern boundary or surface religious symbol. */
function drowSanctum(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = emptyOut(lot, 'compound:drow-sanctum');
  const ins = inscribed(lot, [], 0.5), r = ins.r - 2;
  if (r < 5) return out;
  const hall = rectAt(ins.c, cx.angle, -0.65 * r, 0.65 * r, -0.48 * r, 0.48 * r);
  if (polyInside(lot, hall)) out.buildings.push({ poly: hall, kind: 'landmark', parcel: 0, arch: 'drow-sanctum', roof: 'flat', material: 'dark-stone', storeys: 3 });
  return out;
}

/** Open gathering circle and central fruiting hall, wholly inside its owned lot. */
function myconidCircle(lot: Polygon, _cx: CompoundCtx): CompoundOut {
  const out = emptyOut(lot, 'compound:myconid-circle');
  const ins = inscribed(lot, [], 0.5), r = ins.r - 2;
  if (r < 5) return out;
  const hall = orientPos(disk(ins.c, Math.min(8, Math.max(3.2, r * 0.3)), 18));
  if (polyInside(lot, hall)) out.buildings.push({ poly: hall, kind: 'landmark', parcel: 0, arch: 'myconid-fruiting-hall', roof: 'dome', material: 'fungal', storeys: 1 });
  const circle = orientPos(disk(ins.c, r * 0.82, 24));
  if (polyInside(lot, circle)) out.landmarks.push({ kind: 'myconid-spore-circle', poly: circle });
  return out;
}

function duergarSmeltery(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = forge(lot, cx);
  out.parcels[0].use = 'compound:duergar-smeltery';
  out.buildings = out.buildings.filter(b => polyInside(lot, b.poly)).map(b => ({ ...b, arch: b.arch === 'forge-chimney' ? 'duergar-flue' : 'duergar-smeltery', material: 'dark-stone' }));
  return out;
}

/** Registers more builders (M4 landmark plans). */
export function registerBuilders(map: Record<string, (lot: Polygon, cx: CompoundCtx) => CompoundOut>): void { Object.assign(COMPOUND_BUILDERS, map); }

export const COMPOUND_BUILDERS: Record<string, (lot: Polygon, cx: CompoundCtx) => CompoundOut> = {
  church, 'parish-church': (l, c) => church(l, c, false), 'great-mosque': greatMosque, kasbah, hammam, 'drum-tower': drumTower,
  yamen: (l, c) => axialCompound(l, c, 'yamen'), 'chinese-temple': (l, c) => axialCompound(l, c, 'chinese-temple'),
  'walled-market': walledMarket, castle: jpCastle, 'jp-temple': jpTemple, 'hindu-temple': hinduTemple, tank,
  basilica, 'roman-temple': romanTemple, grove, 'dwarf-gate': dwarfGate, forge, palace, mine,
  'drow-sanctum': drowSanctum, 'duergar-smeltery': duergarSmeltery, 'myconid-circle': myconidCircle,
};

/** Builds a compound; unknown kinds leave the lot as one parcel of that use. */
export function buildCompound(kind: string, lot: Polygon, cx: CompoundCtx): CompoundOut {
  // Explicit plan builders may name unknown ids; inherited Object keys are not registered programmes.
  if (!Object.prototype.hasOwnProperty.call(COMPOUND_BUILDERS, kind)) return emptyOut(lot, 'compound:' + kind);
  const b = COMPOUND_BUILDERS[kind];
  if (!b) return emptyOut(lot, 'compound:' + kind);
  const out = b(orientPos(lot), cx);
  // safety: keep only footprints inside their parcel
  out.buildings = out.buildings.filter((bd) => {
    const par = out.parcels[bd.parcel]?.poly;
    return par && polyInside(par, bd.poly) && area(bd.poly) > 2;
  });
  // no overlapping footprints (small lots squeeze nested layouts); hut cells are disjoint by construction
  if (kind !== 'm4-shanty') out.buildings = dropOverlaps(out.buildings) as typeof out.buildings;
  return out;
}

// ---------------------------------------------------------------- claiming
export interface ClaimBlock { poly: Polygon; kind: string; phase: number; zone: string; quarter: number; height?: number }

/**
 * Picks a block for a landmark: area within range (scored by fit), then by the placement rule (next to the
 * nucleus street, near the nucleus, at the enclosure edge, north on the axis, east / west, near a gate).
 */
const R_INS = new WeakMap<ClaimBlock, { poly: Polygon; r: number }>();
export function pickBlock(
  blocks: ClaimBlock[], place: string, [amin, amax]: [number, number], nucleus: Vec2, R: number,
  ctx: { frontsNucleus: (i: number) => number; edgeDist: (p: Vec2) => number; gates: Vec2[]; rng: Rng; taken: Set<number>; others?: Vec2[]; sep?: number; targets?: Vec2[] },
): number {
  let best = -1, bs = -Infinity;
  blocks.forEach((b, i) => {
    if (b.kind !== 'block' || ctx.taken.has(i)) return;
    const a = area(b.poly);
    if (a < amin * 0.7 || a > amax * 1.8) return;
    // landmark lots are compact (the radius is kept per block: every landmark scans all blocks)
    let ri = R_INS.get(b);
    if (!ri || ri.poly !== b.poly) { ri = { poly: b.poly, r: inscribed(b.poly, [], 2).r }; R_INS.set(b, ri); }
    const rIns = ri.r;
    if (rIns < 0.3 * Math.sqrt(amin)) return;
    const c = polygonCentroid(b.poly);
    const d = dist(c, nucleus);
    let s = a >= amin && a <= amax ? 1 : 0.3;
    s += Math.min(1, (rIns / Math.sqrt(amin)) * 0.8) + ctx.rng.float() * 0.3;
    switch (place) {
      case 'adjacent-nucleus': { const fr = ctx.frontsNucleus(i); if (fr <= 8 && d > 0.45 * R) return; s += (fr > 8 ? 2 : 0) - d / Math.max(120, R * 0.4); break; }
      case 'near-nucleus': s -= d / Math.max(80, R * 0.3); break;
      case 'edge': { const e = ctx.edgeDist(c); if (e > Math.max(90, R * 0.25)) return; s += 1.5 - e / 60 + 0.4 * b.phase; break; }
      case 'axis-north': { if (c.y > nucleus.y - 20) return; s += 2 - Math.abs(c.x - nucleus.x) / 40 - d / Math.max(150, R * 0.5); break; }
      case 'east': case 'west': { const sg = place === 'east' ? 1 : -1; if ((c.x - nucleus.x) * sg < R * 0.15) return; s += 1.5 - Math.abs(c.y - nucleus.y) / 80 - Math.abs(d - R * 0.45) / 150; break; }
      case 'high': { s += (b.height ?? 0) / 4; break; }
      case 'spread': {
        // parishes spread across the quarters: at least `sep` from the other landmarks of the kind
        const dOther = Math.min(...(ctx.others ?? []).map((q) => dist(q, c)), 1e9);
        if (dOther < (ctx.sep ?? 150)) return;
        s += Math.min(2, dOther / (ctx.sep ?? 150)) - d / Math.max(300, R * 1.2) + (b.phase <= 2 ? 0.5 : 0);
        break;
      }
      case 'gate': { const g = Math.min(...ctx.gates.map((q) => dist(q, c)), 1e9); if (g > 200) return; s += 1.5 - g / 80; break; }
      case 'suburb': {
        // a suburb (faubourg or absorbed village) block, near its village green, apart from the other churches
        if (b.zone !== 'faubourg' && b.zone !== 'village') return;
        const dOther = Math.min(...(ctx.others ?? []).map((q) => dist(q, c)), 1e9);
        if (dOther < (ctx.sep ?? 200)) return;
        const dt = Math.min(...(ctx.targets ?? []).map((q) => dist(q, c)), 1e9);
        s += (ctx.targets?.length ? 1.5 - Math.min(dt, 600) / 120 : 0) + Math.min(1.5, dOther / 400);
        break;
      }
      default: break;
    }
    if (s > bs) { bs = s; best = i; }
  });
  return best;
}
