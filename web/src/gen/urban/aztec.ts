/**
 * Aztec city (Tenochtitlan, Tlatelolco): landmark plans and site features.
 * - the walled ceremonial precinct (the serpent wall, coatepantli) on the cardinal axes: the twin-shrine Templo
 *   Mayor on its east side facing west, the round temple of Ehecatl before it, lesser pyramids, the ballcourt and
 *   the skull rack, the priests' school (calmecac);
 * - the calpulli temples: a small pyramid on its own plaza in each ward;
 * - the palace (tecpan): ranges round courts and a garden;
 * - the great market (tianguis): a plaza with rows of stalls;
 * - canals along the streets, and the chinampas round the city: long raised field strips between canals,
 *   reaching into the lake where the shore is near.
 */
import type { Vec2, Polygon } from '../core/geom';
import { dist } from '../core/geom';
import type { UrbanLine } from '../types';
import type { UrbanCtx } from './context';
import type { CompoundCtx, CompoundOut } from './compounds';
import { registerBuilders } from './compounds';
import { area, orientPos, pointInRing, inscribed, obb } from '../geo/poly';
import { MultiPoly, differenceS } from '../geo/bool';
import { disk, ribbon } from '../geo/offset';
import { placeRect, fits } from './m4/kit';
import { rectAt } from './m4/lots';
import { dilate } from './phases';
import { openRing } from './camps/kit';
import type { Streets } from './streets';

const empty = (lot: Polygon, use: string): CompoundOut => ({ parcels: [{ poly: lot, use }], buildings: [], lines: [], water: [], landmarks: [] });
const overlap = (A: Polygon, B: Polygon): boolean => A.some((q) => pointInRing(B, q)) || B.some((q) => pointInRing(A, q));

/** A stepped pyramid: one square footprint, its terraces and the stair drawn as plan lines over it. */
export function pyramid(out: CompoundOut, lot: Polygon, c: Vec2, ang: number, half: number, arch: string, faceDir: number, twin: boolean, parcel = 0): Polygon | null {
  const sq = placeRect(lot, c, ang, half, half, 1.5);
  if (!sq || out.buildings.some((b) => overlap(b.poly, sq))) return null;
  out.buildings.push({ poly: sq, kind: 'landmark', parcel, arch, roof: 'flat', material: 'stone', storeys: 4, orientation: faceDir });
  const o = obb(sq);
  const h = Math.min(o.hu, o.hv);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const at = (u: number, v: number): Vec2 => ({ x: o.c.x + u * ca - v * sa, y: o.c.y + u * sa + v * ca });
  // terraces: nested squares
  for (let k = 1; k <= 3; k++) {
    const r = h * (1 - k * 0.2);
    out.lines.push({ kind: 'pyramid-step', path: [at(-r, -r), at(r, -r), at(r, r), at(-r, r), at(-r, -r)], width: 0.5 });
  }
  // the stair (twin stairs for the Templo Mayor) on the face toward `faceDir` (local u axis sign)
  const sgn = Math.cos(faceDir - ang) >= 0 ? 1 : -1;
  const stairs = twin ? [-h * 0.3, h * 0.3] : [0];
  for (const v of stairs) {
    const w = h * (twin ? 0.16 : 0.22);
    out.lines.push({ kind: 'pyramid-step', path: [at(sgn * h, v - w), at(sgn * h * 0.35, v - w)], width: 0.5 });
    out.lines.push({ kind: 'pyramid-step', path: [at(sgn * h, v + w), at(sgn * h * 0.35, v + w)], width: 0.5 });
  }
  // the shrines on the summit
  const sh = h * 0.18;
  for (const v of twin ? [-h * 0.3, h * 0.3] : [0]) {
    const cu = -sgn * h * 0.25;
    out.lines.push({ kind: 'pyramid-step', path: [at(cu - sh, v - sh), at(cu + sh, v - sh), at(cu + sh, v + sh), at(cu - sh, v + sh), at(cu - sh, v - sh)], width: 0.7 });
  }
  return sq;
}

/** The ceremonial precinct: serpent wall, Templo Mayor, round temple, lesser pyramids, ballcourt, skull rack. */
function precinct(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = empty(lot, 'place');
  const P = orientPos(lot);
  const ins = inscribed(P, [], 1);
  const ang = 0; // cardinal
  const R = ins.r;
  if (R < 12) return out;
  // the serpent wall with three gates (west, north, south)
  const gates = [{ p: { x: ins.c.x - R, y: ins.c.y }, width: 6 }, { p: { x: ins.c.x, y: ins.c.y - R }, width: 5 }, { p: { x: ins.c.x, y: ins.c.y + R }, width: 5 }];
  const near = (q: Vec2) => { let best = P[0], bd = Infinity; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)); const s = { x: a.x + dx * t, y: a.y + dy * t }; const d = dist(s, q); if (d < bd) { bd = d; best = s; } } return best; };
  for (const pl of openRing(P, gates.map((g) => ({ p: near(g.p), width: g.width })))) out.lines.push({ kind: 'stone-wall', path: pl, width: 1.6 });
  // Templo Mayor on the east side, facing west (its twin stairs on the west face)
  const tm = Math.max(10, Math.min(42, R * 0.34));
  const tmC = { x: ins.c.x + R * 0.45, y: ins.c.y };
  const T = pyramid(out, P, tmC, ang, tm, 'templo-mayor', Math.PI, true);
  if (T) out.landmarks.push({ kind: 'templo-mayor', poly: T });
  // the round temple of Ehecatl on the axis before it
  const re = Math.max(4, tm * 0.32);
  const E = orientPos(disk({ x: ins.c.x - R * 0.12, y: ins.c.y }, re, 18));
  if (fits(P, E, 2) && !out.buildings.some((b) => overlap(b.poly, E))) out.buildings.push({ poly: E, kind: 'landmark', parcel: 0, arch: 'round-temple', roof: 'pyramidal', material: 'stone', storeys: 3 });
  // lesser pyramids on the north and south sides, facing the axis
  const lp = Math.max(5, tm * 0.42);
  for (const [dx, dy, face] of [[0.2, -0.62, Math.PI / 2], [0.2, 0.62, -Math.PI / 2], [-0.45, -0.62, Math.PI / 2], [-0.45, 0.62, -Math.PI / 2]] as [number, number, number][]) {
    if (R < 45 && dx < 0) continue;
    pyramid(out, P, { x: ins.c.x + dx * R, y: ins.c.y + dy * R }, ang, lp, 'temple-pyramid', face, false);
  }
  // the ballcourt (an I-shaped court between two parallel ranges) and the skull rack beside it
  if (R > 35) {
    const bc = { x: ins.c.x - R * 0.55, y: ins.c.y + R * 0.18 };
    const L = Math.min(48, R * 0.45), W = L * 0.28;
    const a = rectAt({ x: bc.x, y: bc.y - W / 2 - 2.5 }, 0, -L / 2, L / 2, -2.5, 2.5), b = rectAt({ x: bc.x, y: bc.y + W / 2 + 2.5 }, 0, -L / 2, L / 2, -2.5, 2.5);
    if ([a, b].every((r) => fits(P, r, 2) && !out.buildings.some((x) => overlap(x.poly, r)))) {
      for (const r of [a, b]) out.buildings.push({ poly: r, kind: 'landmark', parcel: 0, arch: 'ballcourt-range', roof: 'flat', material: 'stone', storeys: 1 });
      const e = L / 2 + 5;
      out.lines.push({ kind: 'pyramid-step', path: [{ x: bc.x - e, y: bc.y - W / 2 - 6 }, { x: bc.x - e, y: bc.y + W / 2 + 6 }], width: 0.6 }, { kind: 'pyramid-step', path: [{ x: bc.x + e, y: bc.y - W / 2 - 6 }, { x: bc.x + e, y: bc.y + W / 2 + 6 }], width: 0.6 });
      out.landmarks.push({ kind: 'ballcourt', poly: rectAt(bc, 0, -e, e, -W / 2 - 5, W / 2 + 5) });
      const tz = rectAt({ x: bc.x + L * 0.1, y: bc.y - W / 2 - 14 }, 0, -L * 0.35, L * 0.35, -2, 2);
      if (fits(P, tz, 2) && !out.buildings.some((x) => overlap(x.poly, tz))) out.buildings.push({ poly: tz, kind: 'landmark', parcel: 0, arch: 'tzompantli', roof: 'none', material: 'wood', storeys: 1 });
    }
  }
  // the calmecac (priests' school) in a corner: a range round a court
  if (R > 40) {
    const cc = { x: ins.c.x - R * 0.6, y: ins.c.y - R * 0.55 };
    const s = Math.min(18, R * 0.18);
    const parts = [rectAt(cc, 0, -s, s, -s, -s + 5), rectAt(cc, 0, -s, s, s - 5, s), rectAt(cc, 0, -s, -s + 5, -s + 6, s - 6)];
    if (parts.every((r) => fits(P, r, 2) && !out.buildings.some((x) => overlap(x.poly, r)))) for (const r of parts) out.buildings.push({ poly: r, kind: 'landmark', parcel: 0, arch: 'calmecac', roof: 'flat', material: 'adobe', storeys: 1 });
  }
  void cx;
  return out;
}

/** A ward (calpulli) temple: a small pyramid facing its plaza, the priest's house. */
function calpulliTemple(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = empty(lot, 'place');
  const P = orientPos(lot);
  const ins = inscribed(P, [], 1);
  const h = Math.max(4.5, Math.min(12, ins.r * 0.45));
  const face = Math.atan2(cx.center.y - ins.c.y, cx.center.x - ins.c.x);
  const c = { x: ins.c.x - Math.cos(face) * ins.r * 0.3, y: ins.c.y - Math.sin(face) * ins.r * 0.3 };
  const T = pyramid(out, P, c, 0, h, 'calpulli-pyramid', face, false);
  if (T) out.landmarks.push({ kind: 'calpulli-temple', poly: T });
  const ph = placeRect(P, { x: c.x + Math.sin(face) * (h + 7), y: c.y - Math.cos(face) * (h + 7) }, 0, 6, 4, 1.5);
  if (ph && !out.buildings.some((b) => overlap(b.poly, ph))) out.buildings.push({ poly: ph, kind: 'landmark', parcel: 0, arch: 'priest-house', roof: 'flat', material: 'adobe', storeys: 1 });
  return out;
}

/** The tecpan: ranges of rooms round a court, a garden court behind. */
function tecpan(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = empty(lot, 'compound:tecpan');
  const P = orientPos(lot);
  const o = obb(P);
  const ins = inscribed(P, [], 1);
  const hu = Math.min(o.hu, ins.r * 1.3) - 2, hv = Math.min(o.hv, ins.r) - 2;
  const ang = Math.atan2(o.u.y, o.u.x);
  if (hu < 12 || hv < 10) return out;
  const d = cx.rng.range(6, 8);
  const ranges = [rectAt(ins.c, ang, -hu, hu, -hv, -hv + d), rectAt(ins.c, ang, -hu, hu, hv - d, hv), rectAt(ins.c, ang, -hu, -hu + d, -hv + d + 3, hv - d - 3), rectAt(ins.c, ang, -d / 2, d / 2, -hv + d + 3, hv - d - 3)];
  for (const r of ranges) if (fits(P, r, 0.8) && !out.buildings.some((x) => overlap(x.poly, r))) out.buildings.push({ poly: r, kind: 'landmark', parcel: 0, arch: 'tecpan-range', roof: 'flat', material: 'adobe', storeys: 1 });
  out.landmarks.push({ kind: 'garth', poly: rectAt(ins.c, ang, d / 2 + 2, hu - 2, -hv + d + 2, hv - d - 2) });
  out.lines.push({ kind: 'stone-wall', path: P, closed: true, width: 1.2 });
  return out;
}

/** The great market: an open plaza with rows of stalls (by trade). */
function tianguis(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = empty(lot, 'market');
  const P = orientPos(lot);
  const ins = inscribed(P, [], 1);
  const r = ins.r - 6;
  for (let y = -r; y <= r; y += 9) {
    const pts: Vec2[] = [];
    for (let x = -r; x <= r; x += 2) { const q = { x: ins.c.x + x, y: ins.c.y + y }; if (pointInRing(P, q)) pts.push(q); else if (pts.length > 2) break; }
    if (pts.length > 3) out.lines.push({ kind: 'stall-row', path: [pts[0], pts[pts.length - 1]], width: 2.2 });
  }
  void cx;
  return out;
}

let registered = false;
export function registerAztec(): void {
  if (registered) return;
  registered = true;
  registerBuilders({ 'aztec-precinct': precinct, 'calpulli-temple': calpulliTemple, tecpan, tianguis });
}

/** Canals along the streets: a water channel down the middle of every second lane of the grid (acalotl). */
export function streetCanals(streets: Streets): UrbanLine[] {
  const out: UrbanLine[] = [];
  let k = 0;
  for (const st of streets.list) {
    if (!st.ribbon || st.rank < 2 || st.rank > 3 || st.role === 'close' || st.path.length < 2) continue;
    const w = st.widths.reduce((a, b) => a + b, 0) / st.widths.length;
    if (w < 3.5) continue;
    if (k++ % 2) continue;
    out.push({ kind: 'canal', path: st.path, width: Math.max(1.8, w * 0.5) });
  }
  return out;
}

/**
 * Chinampas: long field strips (8–10 m × 40–90 m) on a cardinal lattice, separated by canals, in a band round
 * the city (and out into shallow water by the shore). Returns the band (its water) and the strips.
 */
export function chinampas(ctx: UrbanCtx, footprint: MultiPoly, roads: Vec2[][], width: number): { water: Polygon[]; strips: Polygon[] } {
  if (!footprint.length) return { water: [], strips: [] };
  let band: MultiPoly = differenceS(dilate(footprint, width), dilate(footprint, 8));
  const rb: MultiPoly = roads.map((pl) => ribbon(pl, 14)).filter((r) => r.length >= 3).map((r) => ({ outer: r, holes: [] }));
  if (rb.length) band = differenceS(band, rb);
  // no chinampas on slopes: keep the low flat land and the shallow water within reach of the shore
  // (wetland agriculture: shallow water by the shore, or low flat ground little above the water table)
  const hab = ctx.site.fields?.hab;
  const g = ctx.terrain.height;
  const habAt = (q: Vec2): number => { if (!hab) return 0; const ix = Math.min(g.w - 1, Math.max(0, Math.floor(q.x / g.cell))), iy = Math.min(g.h - 1, Math.max(0, Math.floor(q.y / g.cell))); return hab[iy * g.w + ix]; };
  const keep = (q: Vec2) => ctx.isWater(q) || (ctx.slopeAt(q) < 0.07 && habAt(q) < 6);
  band = band.filter((ph) => area(ph.outer) > 4000);
  const water: Polygon[] = [], strips: Polygon[] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ph of band) for (const q of ph.outer) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  const inBand = (q: Vec2) => band.some((ph) => pointInRing(ph.outer, q) && !ph.holes.some((h) => pointInRing(h, q)));
  const Wd = 9.5, gap = 3.2, step = 4;
  for (let y = Math.floor(y0 / (Wd + gap)) * (Wd + gap); y < y1; y += Wd + gap) {
    // runs of land along the row (both long edges of the strip in the band), cut into strips of 40–90 m
    const row = Math.round(y / (Wd + gap));
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 2) {
        const xa = run[0], xb = run[run.length - 1] + step;
        let x = xa;
        let k = 0;
        while (xb - x >= 24) {
          const len = Math.min(xb - x, 40 + ((row * 7 + k * 13) % 6) * 10);
          if (xb - (x + len) < 24 && xb - (x + len) > 0) { /* last piece absorbs the rest */ }
          const xe = xb - (x + len) < 24 ? xb : x + len;
          strips.push(orientPos([{ x, y }, { x: xe, y }, { x: xe, y: y + Wd }, { x, y: y + Wd }]));
          water.push(orientPos([{ x: x - gap / 2, y: y - gap / 2 }, { x: xe + gap / 2, y: y - gap / 2 }, { x: xe + gap / 2, y: y + Wd + gap / 2 }, { x: x - gap / 2, y: y + Wd + gap / 2 }]));
          x = xe + gap;
          k++;
        }
      }
      run = [];
    };
    for (let x = Math.floor(x0 / step) * step; x < x1; x += step) {
      const ok = [{ x, y }, { x: x + step, y }, { x, y: y + Wd }, { x: x + step, y: y + Wd }].every((q) => inBand(q) && keep(q));
      if (ok) run.push(x); else flush();
    }
    flush();
  }
  return { water, strips };
}

export { rectAt };
