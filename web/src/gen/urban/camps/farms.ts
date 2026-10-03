/**
 * Farmsteads of the barbarian and northern villages: the household hierarchy (chief, large farm, ordinary farm,
 * cottar), the longhouse sized by it (11–55 m, with its byre end and stalls), granaries on posts, sunken huts, a
 * second house, pens, the trampled yard round the buildings, a tree or two; and the fences, drawn once along the
 * shared yard boundaries and opened at the gates.
 */
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import { dist } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { UrbanLine } from '../../types';
import { area, orientPos, pointInRing, inscribed, obb, distToRing, convexHull } from '../../geo/poly';
import { intersectionS, unionMany, MultiPoly } from '../../geo/bool';
import type { CampOut } from './kit';
import { rect, hut, bowSided, fitIn, openRing, pieces } from './kit';

/** 0 chief, 1 large farm, 2 ordinary farm, 3 cottar. */
export type Status = 0 | 1 | 2 | 3;

/** The households of a village: one chief, then large farms (~15 %), ordinary farms (~55 %) and cottars. */
export function statusLadder(n: number, r: Rng, chief = true): Status[] {
  const out: Status[] = chief ? [0] : [];
  while (out.length < n) { const x = r.float(); out.push(x < 0.16 ? 1 : x < 0.7 ? 2 : 3); }
  return out;
}

/** Longhouse length and width (m) by status and culture. */
export function houseSize(st: Status, kind: 'germanic' | 'norse', r: Rng): { L: number; W: number } {
  const L: [number, number][] = kind === 'norse' ? [[38, 50], [28, 36], [19, 28], [10, 15]] : [[36, 48], [26, 34], [18, 26], [10, 15]];
  const W: [number, number][] = [[7.4, 8.6], [6.2, 7.2], [5.4, 6.4], [4.6, 5.4]];
  return { L: r.range(L[st][0], L[st][1]), W: r.range(W[st][0], W[st][1]) };
}

/** Rectangle with rounded corners (radius `rr`), length L along `ang`. */
export function roundedRect(c: Vec2, ang: number, L: number, W: number, rr: number, k = 2): Polygon {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const r0 = Math.max(0, Math.min(rr, W / 2 - 0.05, L / 2 - 0.05));
  const hx = L / 2 - r0, hy = W / 2 - r0;
  const pts: Vec2[] = [];
  const corner = (cx: number, cy: number, a0: number) => { for (let i = 0; i <= k; i++) { const t = a0 + (i / k) * (Math.PI / 2); pts.push({ x: cx + Math.cos(t) * r0, y: cy + Math.sin(t) * r0 }); } };
  if (r0 < 0.05) pts.push({ x: hx, y: hy }, { x: -hx, y: hy }, { x: -hx, y: -hy }, { x: hx, y: -hy });
  else { corner(hx, hy, 0); corner(-hx, hy, Math.PI / 2); corner(-hx, -hy, Math.PI); corner(hx, -hy, 1.5 * Math.PI); }
  return orientPos(pts.map((q) => ({ x: c.x + q.x * ca - q.y * sa, y: c.y + q.x * sa + q.y * ca })));
}

/** Plan marks on a longhouse roof: the ridge, the cross wall between dwelling and byre, the cattle stalls. */
export function byreMarks(out: CampOut, fp: Polygon, ang: number, withByre: boolean): void {
  const o = obb(fp);
  const ux = Math.cos(ang), uy = Math.sin(ang);
  // the half length along `ang` and half width across it (the OBB may be turned by 90°)
  const along = Math.abs(o.u.x * ux + o.u.y * uy) > 0.7;
  const hl = along ? o.hu : o.hv, hw = along ? o.hv : o.hu;
  const P = (u: number, v: number): Vec2 => ({ x: o.c.x + u * ux - v * uy, y: o.c.y + u * uy + v * ux });
  if (hl < 5) return;
  out.lines.push({ kind: 'roof-line', path: [P(-hl + hw * 0.9, 0), P(hl - hw * 0.9, 0)], width: 0.22 });
  if (!withByre || hl < 7) return;
  const x0 = hl * 0.08;
  out.lines.push({ kind: 'roof-line', path: [P(x0, -hw + 0.35), P(x0, hw - 0.35)], width: 0.3 });
  for (let x = x0 + 1.5; x < hl - 1.6; x += 1.5) for (const s of [-1, 1]) out.lines.push({ kind: 'roof-line', path: [P(x, s * (hw - 0.35)), P(x, s * (hw - 1.5))], width: 0.18 });
}

export interface FarmOpts {
  kind: 'germanic' | 'norse';
  /** Preferred house axis (radians; null: along the yard). */
  axis: number | null;
  /** Fence round the yard (opened at the gate). */
  fence: 'yard-fence' | 'turf-wall' | null;
  /** House length override (from the yard sizing). */
  L?: number;
}

/** Fills one farmyard; returns the footprints placed. */
export function fillFarm(out: CampOut, pi: number, yard: Polygon, st: Status, o: FarmOpts, frontMid: Vec2 | null, r: Rng): Polygon[] {
  const placed: Polygon[] = [];
  const A = area(yard);
  const ob = obb(yard);
  const long = Math.atan2(ob.u.y, ob.u.x);
  const push = (poly: Polygon, kind: string, arch: string, roof: 'gable' | 'none' | 'thatch-round' | 'conical', material: string, orientation?: number, storeys = 1) => {
    placed.push(poly);
    out.buildings.push({ poly, kind, parcel: pi, arch, roof, storeys, material, orientation });
  };
  const sz = houseSize(st, o.kind, r);
  const L0 = o.L ?? sz.L, W0 = sz.W;
  const base = o.axis ?? long;
  const angs = o.axis === null ? [long, long + 0.12, long - 0.12, long + Math.PI / 2] : [base, base + 0.1, base - 0.1, long, base + Math.PI / 2];
  // the house: the deepest part of the yard, set back from the gate a little
  const ins = inscribed(yard, [], 0.5);
  const back = frontMid ? { x: ins.c.x + (ins.c.x - frontMid.x) * 0.12, y: ins.c.y + (ins.c.y - frontMid.y) * 0.12 } : ins.c;
  const rr = o.kind === 'norse' ? 0 : W0 * r.range(0.25, 0.5);
  const shape = (q: Vec2, a: number, s: number): Polygon => (o.kind === 'norse' ? bowSided(q, a, L0 * s, W0 * Math.max(0.85, s), st === 3 ? 0.08 : r.range(0.16, 0.24)) : roundedRect(q, a, L0 * s, W0 * Math.max(0.85, s), rr));
  let house: Polygon | null = null, hAng = angs[0];
  for (const a of angs) {
    house = fitIn(yard, (q, s) => shape(q, a, s), placed, { margin: 2, gap: 0, minScale: 0.5, cands: [back, ins.c] }) ?? fitIn(yard, (q, s) => shape(q, a, s), placed, { margin: 1.6, gap: 0, minScale: 0.5 });
    if (house) { hAng = a; break; }
  }
  if (!house) return placed;
  const byre = st !== 3 && r.chance(o.kind === 'norse' ? 0.6 : 0.85);
  const arch = st === 0 ? (o.kind === 'norse' ? 'hall' : 'chieftain-hall') : st === 3 ? 'cottage' : byre ? 'byre-house' : 'longhouse';
  push(house, st === 0 ? 'landmark' : 'house', o.kind === 'norse' && arch !== 'hall' && arch !== 'cottage' ? 'longhouse' : arch, 'gable', o.kind === 'norse' ? 'turf' : 'thatch', hAng);
  if (st === 0) out.landmarks.push({ kind: arch, poly: house });
  byreMarks(out, house, hAng, byre);
  const span = Math.sqrt(A);
  // a second dwelling (the chief's retainers, a large farm's old couple), a byre or barn of its own (norse)
  const n2 = st === 0 ? 2 : st === 1 ? (r.chance(0.6) ? 1 : 0) : st === 2 && r.chance(0.25) ? 1 : 0;
  for (let k = 0; k < n2; k++) {
    const L2 = r.range(9, 15), W2 = r.range(4.6, 5.6);
    const a2 = hAng + (r.chance(0.5) ? Math.PI / 2 : 0) + r.range(-0.1, 0.1);
    const g = fitIn(yard, (q, s) => (o.kind === 'norse' ? bowSided(q, a2, L2 * s, W2, 0.12) : roundedRect(q, a2, L2 * s, W2, 1.2)), placed, { margin: 1.4, gap: 3, minScale: 0.7 });
    if (g) push(g, 'house', o.kind === 'norse' ? 'byre' : 'small-house', 'gable', o.kind === 'norse' ? 'turf' : 'thatch', a2);
  }
  // granaries on four or six posts
  const nG = [r.int(4, 6), r.int(2, 3), r.int(1, 2), r.int(0, 1)][st];
  for (let k = 0; k < nG; k++) {
    const gs = r.range(2.4, 3.4), ga = hAng + r.range(-0.08, 0.08);
    const g = fitIn(yard, (q, s) => rect(q, ga, gs * s, (gs * s) * r.range(0.85, 1.2)), placed, { margin: 1, gap: 1.8, minScale: 0.85, step: 2.5 });
    if (g) push(g, 'outbuilding', 'granary-on-posts', 'gable', 'timber');
  }
  // sunken huts (weaving, storage) or pit houses
  const nS = [r.int(3, 5), r.int(1, 3), r.int(1, 2), r.int(0, 1)][st];
  for (let k = 0; k < nS; k++) {
    const a = hAng + r.range(-0.4, 0.4);
    const g = fitIn(yard, (q, s) => rect(q, a, r.range(3.4, 4.6) * s, r.range(2.6, 3.2) * s), placed, { margin: 1, gap: 2.2, minScale: 0.85, step: 2.5 });
    if (g) push(g, 'outbuilding', o.kind === 'norse' ? 'pit-house' : 'sunken-hut', 'gable', 'timber');
  }
  // a smithy (norse, the larger farms)
  if (o.kind === 'norse' && st <= 1) {
    const g = fitIn(yard, (q, s) => hut(q, 2.6 * s, 7, r.range(0, 1)), placed, { margin: 1.2, gap: 3, minScale: 0.85 });
    if (g) push(g, 'outbuilding', 'smithy', 'gable', 'stone');
  }
  // a fenced pen and a kitchen garden in the larger yards
  if (st <= 2 && A > 900 && r.chance(st <= 1 ? 0.8 : 0.45)) {
    const pw = Math.min(16, span * 0.35), ph = Math.min(11, span * 0.25);
    const pa = hAng + (r.chance(0.5) ? 0 : Math.PI / 2);
    const pen = fitIn(yard, (q, s) => rect(q, pa, pw * s, ph * s), placed, { margin: 1.2, gap: 2.5, minScale: 0.6 });
    if (pen) { out.lines.push({ kind: 'pen-fence', path: pen.concat([pen[0]]), width: 0.4 }); placed.push(pen); }
  }
  if (A > 700 && r.chance(0.55)) {
    const gw = r.range(7, 12), gh = r.range(5, 8);
    const bed = fitIn(yard, (q, s) => rect(q, hAng, gw * s, gh * s), placed, { margin: 1.5, gap: 2, minScale: 0.6 });
    if (bed) { out.landmarks.push({ kind: 'garden-bed', poly: bed }); placed.push(bed); }
  }
  // the way from the gate to the house, and the trampled yard round the buildings
  const extra: Polygon[] = [];
  if (frontMid) {
    const hc = inscribed(house, [], 0.3).c;
    const L = dist(frontMid, hc);
    if (L > 3) {
      const ux = (hc.x - frontMid.x) / L, uy = (hc.y - frontMid.y) / L;
      const w = st === 0 ? 2.2 : 1.5;
      extra.push(orientPos([{ x: frontMid.x - uy * w, y: frontMid.y + ux * w }, { x: frontMid.x + uy * w, y: frontMid.y - ux * w }, { x: hc.x + uy * w, y: hc.y - ux * w }, { x: hc.x - uy * w, y: hc.y + ux * w }]));
    }
  }
  yardEarth(out, yard, placed.filter((p) => area(p) > 0), 2.4, extra);
  // a tree or two at the edge of the yard
  const nt = r.int(0, st <= 1 ? 3 : 2);
  out.trees = out.trees ?? [];
  for (let k = 0; k < nt; k++) {
    const t = r.int(0, yard.length - 1);
    const a = yard[t], b = yard[(t + 1) % yard.length];
    const f = r.range(0.2, 0.8);
    const e = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    const tq = { x: e.x + (ins.c.x - e.x) * 0.12, y: e.y + (ins.c.y - e.y) * 0.12 };
    const tr = r.range(2.6, 4.2);
    if (pointInRing(yard, tq) && distToRing(yard, tq) > 1 && !placed.some((p) => pointInRing(p, tq) || p.some((q) => dist(q, tq) < tr + 1)) && !(frontMid && dist(frontMid, tq) < 6)) out.trees.push({ x: tq.x, y: tq.y, r: tr });
  }
  return placed;
}

/** The trampled ground round the buildings of a yard: each footprint grown by `m` (rounded), joined, inside the yard. */
export function yardEarth(out: CampOut, yard: Polygon, placed: Polygon[], m: number, extra: Polygon[] = []): void {
  if (!placed.length) return;
  const grown: MultiPoly = [];
  for (const p of placed) {
    const pts: Vec2[] = [];
    for (const q of p) for (let k = 0; k < 8; k++) pts.push({ x: q.x + Math.cos((k / 8) * 2 * Math.PI) * m, y: q.y + Math.sin((k / 8) * 2 * Math.PI) * m });
    const h = orientPos(convexHull(pts));
    if (h.length >= 3) grown.push({ outer: h, holes: [] });
  }
  for (const e of extra) grown.push({ outer: e, holes: [] });
  const u = unionMany(grown.map((g): MultiPoly => [g]), 24, true);
  for (const p of pieces(intersectionS(u, yard), 4)) out.landmarks.push({ kind: 'yard-earth', poly: p });
}

/**
 * Fences along yard boundaries, each shared stretch drawn once: the edges of every ring that do not lie on a ring
 * already drawn, chained into polylines and opened at the gates.
 */
export function fences(rings: { ring: Polygon; gates: { p: Vec2; width: number }[] }[], kind: string, width: number): UrbanLine[] {
  const done: Polygon[] = [];
  const out: UrbanLine[] = [];
  for (const { ring, gates } of rings) {
    const keep = ring.map((a, i) => {
      const b = ring[(i + 1) % ring.length];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      return !done.some((d) => distToRing(d, m) < 0.05);
    });
    done.push(ring);
    if (keep.every((k) => k)) {
      for (const pl of openRing(ring, gates)) out.push({ kind, path: pl, width });
      continue;
    }
    // runs of kept edges
    const n = ring.length;
    const start = keep.findIndex((k, i) => k && !keep[(i + n - 1) % n]);
    if (start < 0) continue;
    let run: Polyline = [];
    for (let s = 0; s < n; s++) {
      const i = (start + s) % n;
      if (keep[i]) { if (!run.length) run.push(ring[i]); run.push(ring[(i + 1) % n]); }
      else if (run.length) { out.push(...openRun(run, gates).map((pl) => ({ kind, path: pl, width }))); run = []; }
    }
    if (run.length) out.push(...openRun(run, gates).map((pl) => ({ kind, path: pl, width })));
  }
  return out;
}

/** An open polyline cut at the gates that lie on it. */
function openRun(pl: Polyline, gates: { p: Vec2; width: number }[]): Polyline[] {
  let parts: Polyline[] = [pl];
  for (const g of gates) {
    const next: Polyline[] = [];
    for (const p of parts) {
      // the gate's position along p
      let best = -1, bt = 0, bd = 0.6;
      for (let i = 1; i < p.length; i++) {
        const a = p[i - 1], b = p[i];
        const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((g.p.x - a.x) * dx + (g.p.y - a.y) * dy) / l2));
        const d = Math.hypot(a.x + dx * t - g.p.x, a.y + dy * t - g.p.y);
        if (d < bd) { bd = d; best = i; bt = t; }
      }
      if (best < 0) { next.push(p); continue; }
      const cum: number[] = [0];
      for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + dist(p[i - 1], p[i]));
      const s0 = cum[best - 1] + bt * (cum[best] - cum[best - 1]);
      const at = (s: number): Vec2 => {
        let i = 1;
        while (i < p.length - 1 && cum[i] < s) i++;
        const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
        return { x: p[i - 1].x + (p[i].x - p[i - 1].x) * t, y: p[i - 1].y + (p[i].y - p[i - 1].y) * t };
      };
      const a = s0 - g.width / 2, b = s0 + g.width / 2;
      if (a > 0.8) next.push([...p.filter((_, i) => cum[i] < a), at(a)]);
      if (b < cum[cum.length - 1] - 0.8) next.push([at(b), ...p.filter((_, i) => cum[i] > b)]);
    }
    parts = next;
  }
  return parts.filter((p) => p.length >= 2);
}

export { rect, hut };
