/**
 * Building operators (URBAN_MORPHOLOGY.md §2): each builds the footprints of one plot, inside it by construction
 * (plot ∩ half-planes, insets, or disks placed at the plot's inscribed centre), and tags them with architecture
 * metadata (typology, roof, storeys, material, courtyards, orientation) for later rendering and 3D.
 *
 * streetFrontRow  European burgage cycle (buildings.ts)
 * machiya         Japanese merchant house: narrow deep front house with a light court, storehouse (kura) behind
 * courtyardHouse  medina / domus / haveli: ring of rooms around a court, blank outer walls
 * pavilionCompound siheyuan: separate halls on the north, east and west sides of a court, gate range on the lane,
 *                 strictly orthogonal and south-facing
 * yashiki         samurai residence: gatehouse range (nagaya-mon) on the street, detached main house, storehouse,
 *                 garden
 * treeHouse       elven: circular footprints among the trees
 * hall            dwarven: rectilinear stone hall, chamfered (octagonal) corners
 */
import type { Vec2, Polygon } from '../core/geom';
import { dist } from '../core/geom';
import type { Rng } from '../core/rng';
import type { MorphologyParams, ArchSpec } from './morphology';
import type { Plot } from './plots';
import { buildPlot, clipPlot, courtyardRing, rectify, shapeOf, dropOverlaps, MIN_BW, MAX_ASPECT, type Bldg, type HalfPlane, type CourtHint } from './buildings';
import { area, inscribed, distToRing, orientPos, cleanRing, pointInRing, obb, isSimple } from '../geo/poly';
import { difference, union } from '../geo/bool';
import { isConvex, polyInside } from '../geo/split';
import { stitchUnion } from '../geo/stitch';
import { disk } from '../geo/offset';

export interface ArchBldg extends Bldg {
  arch?: string; roof?: ArchSpec['roof']; storeys?: number; material?: string; courtyards?: Polygon[]; orientation?: number;
  /** A range of a courtyard ring (or a souk cell): judged on its room depth, not on the no-matchstick rule. */
  ring?: boolean;
}

const tag = (b: Bldg, a: ArchSpec, rng: Rng, over: Partial<ArchBldg> = {}): ArchBldg => ({
  ...b, arch: a.typology, roof: a.roof, material: a.material, storeys: Math.round(rng.range(a.storeys[0], a.storeys[1] + 0.99) - 0.49), ...over,
});

/** Plot frame: frontage origin, along-street t, inward n, width W, depth D. */
function frame(pl: Plot): { fa: Vec2; t: Vec2; n: Vec2; W: number; D: number } | null {
  const [fa, fb] = pl.front;
  const W = dist(fa, fb);
  if (W < 2.5) return null;
  const t = { x: (fb.x - fa.x) / W, y: (fb.y - fa.y) / W };
  let n = { x: -t.y, y: t.x };
  if (n.x * pl.nrm.x + n.y * pl.nrm.y < 0) n = { x: -n.x, y: -n.y };
  let D = 0;
  for (const q of pl.poly) D = Math.max(D, (q.x - fa.x) * n.x + (q.y - fa.y) * n.y);
  return { fa, t, n, W, D };
}

/** Half-planes of the rectangle [u0,u1] × [d0,d1] in the frame. */
function rectHP(f: { fa: Vec2; t: Vec2; n: Vec2 }, u0: number, u1: number, d0: number, d1: number): HalfPlane[] {
  const at = (u: number, d: number): Vec2 => ({ x: f.fa.x + f.t.x * u + f.n.x * d, y: f.fa.y + f.t.y * u + f.n.y * d });
  return [
    { p: at(u0, 0), n: f.t }, { p: at(u1, 0), n: { x: -f.t.x, y: -f.t.y } },
    { p: at(0, d0), n: f.n }, { p: at(0, d1), n: { x: -f.n.x, y: -f.n.y } },
  ];
}

/** Lateral extent [lo, hi] of the plot in the frame (t coordinates) at depth d. */
function lateral(poly: Polygon, f: { fa: Vec2; t: Vec2; n: Vec2 }, d: number): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  const nc = (p: Vec2) => (p.x - f.fa.x) * f.n.x + (p.y - f.fa.y) * f.n.y;
  const tc = (p: Vec2) => (p.x - f.fa.x) * f.t.x + (p.y - f.fa.y) * f.t.y;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = nc(a) - d, db = nc(b) - d;
    if ((da <= 0 && db >= 0) || (da >= 0 && db <= 0)) {
      const k = da === db ? 0 : da / (da - db);
      const u = tc(a) + (tc(b) - tc(a)) * k;
      lo = Math.min(lo, u); hi = Math.max(hi, u);
    }
  }
  return lo < hi ? [lo, hi] : null;
}

/**
 * The orthogonal part of a lot: lateral bounds [u0, u1] valid from the frontage to depth `D` (the deepest depth at
 * which the lot keeps ≥ 80 % of its frontage width), so skewed or tapering lot backs do not shrink the layout.
 */
function usable(pl: Plot, f: { fa: Vec2; t: Vec2; n: Vec2; W: number; D: number }): { u0: number; u1: number; D: number } | null {
  const L0 = lateral(pl.poly, f, Math.min(1, f.D / 2));
  if (!L0) return null;
  let u0 = L0[0], u1 = L0[1], D = Math.min(1, f.D / 2);
  for (let d = 2; d <= f.D - 0.5; d += 1) {
    const L = lateral(pl.poly, f, d);
    if (!L) break;
    const a = Math.max(u0, L[0]), b = Math.min(u1, L[1]);
    if (b - a < 0.8 * (L0[1] - L0[0])) break;
    u0 = a; u1 = b; D = d;
  }
  return u1 - u0 > 2 ? { u0, u1, D: Math.min(f.D, D + 0.5) } : null;
}

/** Orthogonal rectangle clipped to the plot; kept only when it is a clean, wide enough piece. */
function rectIn(pl: Plot, f: { fa: Vec2; t: Vec2; n: Vec2 }, u0: number, u1: number, d0: number, d1: number, minArea = 12): Polygon | null {
  if (u1 - u0 < MIN_BW || d1 - d0 < MIN_BW) return null;
  const r = clipPlot(pl.poly, rectHP(f, u0, u1, d0, d1), isConvex(pl.poly, 1e-3));
  if (r.length !== 1) return null;
  const c = cleanRing(r[0], 0.02, 0.5, 0.002, false);
  if (c.length < 3 || area(c) < minArea) return null;
  const s = shapeOf(c);
  return s.w >= MIN_BW && s.asp <= 4.05 ? c : null;
}

// ---------------------------------------------------------------- courtyard house
/**
 * Courtyard house (dar, domus, haveli): the ring of rooms around a patio, sized to the lot so that every house
 * keeps one (the patio ≈ 35–45 % of the lot's side, ≥ 3 × 3 m; the room depth shrinks on small lots down to 2.4 m).
 * The street walls are blank; the house is entered through a bent passage (skifa): in from the lane beside the
 * patio, a turn, then into the patio, so that the patio is never seen from the lane.
 */
function courtyardHouse(pl: Plot, P: MorphologyParams, rng: Rng, cov = 0.93): ArchBldg[] {
  const f = frame(pl);
  const A = area(pl.poly);
  const okShape = (p: Polygon) => { const s = shapeOf(p); return s.w >= MIN_BW && s.asp <= MAX_ASPECT; };
  // (a lot too small or too thin for a patio is built whole; long ones are cut into rooms later)
  const solid = (): ArchBldg[] => (shapeOf(pl.poly).w >= MIN_BW ? [tag({ poly: pl.poly, kind: 'house' }, P.arch, rng)] : []);
  if (!f || A < 42) return solid();
  // the patio takes ~14–24 % of the lot (≥ 9 m²) at the medina's dense baseline, more on looser land (coverage
  // lowered by the sprawl): the deepest room ring that still leaves it. (Large enough to read on a town plan.)
  const want = Math.max(9, A * Math.max(0.1, Math.min(0.42, 0.14 + 0.55 * (0.95 - cov) + rng.range(-0.02, 0.07))));
  const ringFor = (axis: Vec2): ReturnType<typeof courtyardRing> => {
    for (let rd = P.roomDepth[1] + 1.5; rd >= 2.3; rd *= 0.92) {
      const r = courtyardRing(pl.poly, rd, axis);
      // (the ring must cover the lot: a failed half would leave a gaping U)
      if (r && area(r.court) >= want && r.pieces.reduce((s2, x) => s2 + area(x), 0) + area(r.court) >= 0.97 * A) return r;
    }
    return null;
  };
  /** The entrance legs: a bent passage (skifa) from the lane to the patio, or a straight one. */
  const entranceLegs = (court: Polygon, bent: boolean): Polygon[] => {
    const tc = (p: Vec2) => (p.x - f.fa.x) * f.t.x + (p.y - f.fa.y) * f.t.y;
    const nc = (p: Vec2) => (p.x - f.fa.x) * f.n.x + (p.y - f.fa.y) * f.n.y;
    // the patio's nearest point to the lane (its corner or edge facing the door)
    let cd0 = Infinity, e0 = 0;
    for (const q of court) { const d = nc(q); if (d < cd0) { cd0 = d; e0 = tc(q); } }
    let cu0 = Infinity, cu1 = -Infinity;
    for (const q of court) if (nc(q) < cd0 + 1.5) { cu0 = Math.min(cu0, tc(q)); cu1 = Math.max(cu1, tc(q)); }
    e0 = Math.max(cu0 + 1, Math.min(cu1 - 1, e0));
    const at = (u: number, d: number): Vec2 => ({ x: f.fa.x + f.t.x * u + f.n.x * d, y: f.fa.y + f.t.y * u + f.n.y * d });
    const rect = (u0: number, u1: number, d0: number, d1: number): Polygon => [at(u0, d0), at(u1, d0), at(u1, d1), at(u0, d1)];
    const hw = 0.9;
    const left = rng.chance(0.5);
    // the door: beside the patio, so that the patio is not seen from the lane
    let e = left ? e0 - 2.2 : e0 + 2.2;
    if (e - hw < 0.6 || e + hw > f.W - 0.6) e = left ? e0 + 2.2 : e0 - 2.2;
    if (e - hw < 0.6 || e + hw > f.W - 0.6) e = e0;
    if (bent && cd0 > 2.2 && e !== e0) {
      const dm = Math.max(hw + 0.6, cd0 * 0.5);
      return [rect(e - hw, e + hw, -1, dm + hw), rect(Math.min(e, e0) - hw, Math.max(e, e0) + hw, dm - hw, dm + hw), rect(e0 - hw, e0 + hw, dm - hw, cd0 + 0.5)];
    }
    return [rect(e0 - hw, e0 + hw, -1, cd0 + 0.5)];
  };
  const ori = Math.atan2(f.n.y, f.n.x);
  const ring = ringFor(obb(pl.poly).v) ?? ringFor(f.n);
  if (!ring) return solid();
  // one footprint: the lot minus the patio and the entrance passage that joins it to the lane (a C around the
  // patio); exact, simple and a proper footprint, else the next variant
  for (const bent of [true, false]) {
    const cur = difference(pl.poly, ring.court, ...entranceLegs(ring.court, bent));
    const big = cur.filter((ph) => area(ph.outer) > 4);
    if (big.length !== 1 || big[0].holes.length) continue;
    const h = cleanRing(big[0].outer, 0.005, 0.5, 0.002, false);
    if (h.length < 3 || !isSimple(h) || !polyInside(pl.poly, h) || !okShape(h)) continue;
    pl.gated = true;
    return [tag({ poly: h, kind: 'house' }, P.arch, rng, { courtyards: [ring.court], orientation: ori, ring: true })];
  }
  // a long lot: two ranges either side of the patio, both on the lane
  const r2 = ringFor(f.n);
  if (r2 && r2.pieces.every(okShape)) return r2.pieces.map((pc, i) => tag({ poly: pc, kind: 'house' }, P.arch, rng, { courtyards: i === 0 ? [r2.court] : undefined, orientation: ori, ring: true }));
  return solid();
}

// ---------------------------------------------------------------- souk shops
/** Souk: one small shop cell per lot (4.6–6.5 m wide), back to back across the narrow souk blocks. */
function shopRow(pl: Plot, P: MorphologyParams, rng: Rng): ArchBldg[] {
  const f = frame(pl);
  if (!f) return [];
  const d1 = Math.min(f.D, rng.range(5.5, 8));
  const r = clipPlot(pl.poly, [{ p: { x: f.fa.x + f.n.x * 0.1, y: f.fa.y + f.n.y * 0.1 }, n: f.n }, { p: { x: f.fa.x + f.n.x * d1, y: f.fa.y + f.n.y * d1 }, n: { x: -f.n.x, y: -f.n.y } }], isConvex(pl.poly, 1e-3));
  const out: ArchBldg[] = [];
  for (const q of r) {
    const c = cleanRing(q, 0.005, 0.5, 0.002, false);
    if (c.length >= 3 && area(c) >= 6 && shapeOf(c).w >= MIN_BW && shapeOf(c).asp <= MAX_ASPECT) out.push(tag({ poly: c, kind: 'house' }, P.arch, rng, { orientation: Math.atan2(f.n.y, f.n.x), ring: true }));
  }
  return out;
}

// ---------------------------------------------------------------- siheyuan (pavilion compound)
/**
 * Siheyuan: halls enclosing one court or a file of courts (jin) along the lot's depth, built against the lot lines
 * (the outer walls of neighbouring compounds are shared, so a hutong block reads as rows of courts):
 * - the gate range (daozuo) along the lane, with the gate in one corner;
 * - per court: side halls (xiangfang) on the east and west sides (one side on narrow lots), then a cross hall
 *   (the main hall, zhengfang, on the north side of the main court, with its ear rooms: the full width);
 * - deep lots: several courts in file (2–4 jin), a rear range (houzhaofang) closing the last one.
 */
function pavilionCompound(pl: Plot, P: MorphologyParams, rng: Rng): ArchBldg[] {
  const f = frame(pl);
  if (!f) return [];
  // lateral bounds valid over the usable depth (orthogonal halls); a tapering lot back stays garden
  const us = usable(pl, f);
  if (!us) return [];
  const D = us.D;
  const u0 = us.u0 + 0.05, u1 = us.u1 - 0.05;
  const Wi = u1 - u0;
  const out: ArchBldg[] = [];
  const hall = (poly: Polygon | null, typ: string, storeys = 1) => {
    if (poly) out.push({ poly, kind: 'house', arch: typ, roof: P.arch.roof, material: P.arch.material, storeys, orientation: -Math.PI / 2 });
  };
  if (Wi < 9 || D < 14) {
    hall(rectIn(pl, f, u0, u1, 0.3, Math.min(D - 0.6, 10)), 'siheyuan-hall');
    return out;
  }
  const front0 = 0.3, back1 = D - 0.3;
  // gate range along the lane, the gate (2.6–3.2 m) in one corner
  const gs = rng.range(4.6, 5.4), gap = rng.range(2.6, 3.2);
  const gateLeft = rng.chance(0.5);
  hall(rectIn(pl, f, gateLeft ? u0 + gap : u0, gateLeft ? u1 : u1 - gap, front0, front0 + gs), 'siheyuan-gate-range');
  // courts in file: each ~14–20 m deep (court + its cross hall)
  const avail = back1 - (front0 + gs);
  const n = Math.max(1, Math.min(4, Math.round(avail / rng.range(15, 19))));
  const rear = avail - n * 12 >= 4.6 && D > 28 ? rng.range(4.6, 5.4) : 0;
  const step = (avail - rear) / n;
  const both = Wi >= 4.6 * 2 + 5.5;
  const sw = both ? Math.min(5.4, Math.max(4.6, Wi * 0.24)) : Math.min(5.4, Math.max(4.6, Wi * 0.3));
  const eastSide = rng.chance(0.5);
  let d = front0 + gs;
  for (let j = 0; j < n; j++) {
    const hd = Math.min(step - 5, j === n - 1 ? rng.range(7.5, 9.5) : rng.range(5.5, 7.5));
    const c0 = d + (j === 0 ? rng.range(1.2, 2.4) : 0), c1 = d + step - hd;
    // side halls flank the court (rooms off the court, gaps at the corners)
    if (c1 - c0 >= 6) {
      if (both || eastSide) hall(rectIn(pl, f, u1 - sw, u1, c0 + 0.6, c1 - 0.6), 'siheyuan-side-hall');
      if (both || !eastSide) hall(rectIn(pl, f, u0, u0 + sw, c0 + 0.6, c1 - 0.6), 'siheyuan-side-hall');
    }
    // the cross hall: the main hall with its ear rooms on the last court, middle halls before it; a side passage
    // (1.8 m, beside the hall) leads on to the next court
    const pass = j < n - 1 || rear ? 1.8 : 0;
    const pl0 = (j % 2 === 0) === gateLeft;
    hall(rectIn(pl, f, pl0 ? u0 + pass : u0, pl0 ? u1 : u1 - pass, c1, c1 + hd), j === n - 1 ? 'siheyuan-main-hall' : 'siheyuan-middle-hall');
    d += step;
  }
  if (rear) hall(rectIn(pl, f, u0, u1, back1 - rear, back1), 'siheyuan-rear-range');
  return out;
}

// ---------------------------------------------------------------- samurai yashiki
/**
 * Samurai residence (buke-yashiki), a walled lot (the wall is drawn along the lot line):
 * - the nagaya-mon: a long gate range (retainers' quarters) on the street front, the gate in it;
 * - a forecourt, then the main house in the stepped "flying geese" plan (ganko-gata: 2–3 blocks of rooms offset on
 *   the diagonal toward the garden);
 * - one or two storehouses (kura) in a back corner; the rest is garden.
 * Sizes scale with the lot (the house ≈ 16–22 % of it): a ranking samurai's lot is larger, not emptier.
 */
function yashiki(pl: Plot, P: MorphologyParams, rng: Rng): ArchBldg[] {
  const f = frame(pl);
  if (!f) return [];
  // the lot's lateral extent over its middle (irregular compound lots: pieces are clipped to the lot anyway)
  const Lm = lateral(pl.poly, f, f.D * 0.45), Lf = lateral(pl.poly, f, Math.min(6, f.D * 0.2));
  if (!Lm || !Lf) return [];
  const u0 = Math.max(Lm[0], Lf[0]), u1 = Math.min(Lm[1], Lf[1]);
  const D = f.D, W = u1 - u0, A = area(pl.poly);
  const out: ArchBldg[] = [];
  const ori = Math.atan2(f.n.y, f.n.x);
  const add = (poly: Polygon | null, arch: string, kind: Bldg['kind'] = 'house', storeys = 1) => {
    if (poly) out.push({ poly, kind, arch, roof: arch === 'kura' ? 'gable' : 'tiled-hip', material: 'wood', storeys, orientation: ori });
  };
  if (W < 12 || D < 16) { add(rectIn(pl, f, u0 + 0.6, u1 - 0.6, 0.6, Math.min(D - 1, 10)), 'yashiki-main-house'); return out; }
  // (the gate in the nagaya-mon, or an open forecourt on small lots: the garden is reached from the street)
  pl.gated = true;
  // nagaya-mon along the street, the gate (3.6 m) off-centre
  const gd = rng.range(4.2, 5.2);
  if (W >= 18) {
    const g = u0 + W * rng.range(0.3, 0.6);
    add(rectIn(pl, f, u0 + 0.5, g - 1.8, 0.5, 0.5 + gd), 'nagaya-mon');
    add(rectIn(pl, f, g + 1.8, u1 - 0.5, 0.5, 0.5 + gd), 'nagaya-mon');
  }
  // main house, ganko plan: blocks stepping back on the diagonal
  const target = A * rng.range(0.16, 0.22);
  const n = A > 1400 ? 3 : 2;
  const bw = Math.min(W * 0.42, Math.sqrt(target / n) * rng.range(1.05, 1.25));
  const bd = Math.min((D - gd - 8) / (n * 0.7 + 0.3), target / n / bw);
  const leftToRight = rng.chance(0.5);
  let ux = leftToRight ? u0 + rng.range(2.5, 5) : u1 - rng.range(2.5, 5) - bw;
  let dd = gd + rng.range(5, 9);
  let main: Polygon | null = null;
  for (let k = 0; k < n && bd >= 6 && bw >= 6; k++) {
    const r = rectIn(pl, f, ux, ux + bw, dd, dd + bd, 20);
    if (!r) break;
    if (!main) main = r;
    else {
      // the blocks overlap at their corners: one footprint
      const u2 = union(main, r);
      if (u2.length === 1 && !u2[0].holes.length && polyInside(pl.poly, u2[0].outer)) main = cleanRing(u2[0].outer, 0.005, 0.5, 0.002, false);
      else break;
    }
    // the next block: overlapping a third of this one's width, set back by 60–75 % of its depth
    ux += (leftToRight ? 1 : -1) * bw * rng.range(0.62, 0.75);
    dd += bd * rng.range(0.6, 0.75);
    if (ux < u0 + 1 || ux + bw > u1 - 1 || dd + bd > D - 9) break;
  }
  add(main, 'yashiki-main-house');
  // storehouses in the back corner opposite the house's last block
  const kd = rng.range(5.5, 7), kw = rng.range(4.6, 5.6);
  const kx = leftToRight ? u0 + 1.5 : u1 - 1.5 - kw;
  const fits = (r: Polygon | null) => !!r && !(main && bboxHit(main, r));
  const kura = rectIn(pl, f, kx, kx + kw, D - 1.5 - kd, D - 1.5);
  if (fits(kura)) add(kura, 'kura', 'back', 2);
  if (A > 1600) {
    const kx2 = leftToRight ? kx + kw + 1.5 : kx - kw - 1.5;
    const k2 = rectIn(pl, f, kx2, kx2 + kw, D - 1.5 - kd, D - 1.5);
    if (fits(k2)) add(k2, 'kura', 'back', 2);
  }
  void P;
  return out;
}

/** Bounding boxes closer than 1 m (storehouses keep clear of the house). */
function bboxHit(a: Polygon, b: Polygon): boolean {
  const bb = (p: Polygon) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const q of p) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); } return { x0, y0, x1, y1 }; };
  const A = bb(a), B = bb(b);
  return !(A.x0 > B.x1 + 1 || B.x0 > A.x1 + 1 || A.y0 > B.y1 + 1 || B.y0 > A.y1 + 1);
}

// ---------------------------------------------------------------- machiya (new)
/**
 * Kyō-machiya / Edo merchant house on a narrow deep lot (4.5–7 m × 20–35 m), the street front continuous:
 * - the front block (mise, the shop, and the living rooms), 8–11 m deep over the whole frontage;
 * - the tsuboniwa (a light court 2.5–3.6 m deep) beside a roofed corridor along one side (the tori-niwa), then
 *   the back rooms (okuzashiki): front block, corridor and back rooms make one C-shaped house;
 * - the back garden, and the kura (two-storey storehouse, 4.6–5.5 m wide) at the back of the lot.
 * Every fourth lot keeps a roji (a 1.7 m alley) along one side to the back gardens, where the kura stand (and,
 * in Edo, the back tenements): the gardens behind the row are reached from the street.
 */
function machiya(pl: Plot, cov: number, P: MorphologyParams, rng: Rng): ArchBldg[] {
  const f = frame(pl);
  if (!f) return [];
  const { W, D } = f;
  const ori = Math.atan2(f.n.y, f.n.x);
  const conv = isConvex(pl.poly, 1e-3);
  // pieces follow the lot (depth bands, strips along a side line): robust on skewed and fanned lots
  const sideHP = (k: number): HalfPlane => {
    const s = k === 0 ? pl.sideA : pl.sideB;
    const tw = k === 0 ? f.t : { x: -f.t.x, y: -f.t.y };
    let m = { x: -s.d.y, y: s.d.x };
    if (m.x * tw.x + m.y * tw.y < 0) m = { x: -m.x, y: -m.y };
    return { p: s.p, n: m };
  };
  const piece = (d0: number, d1: number, side?: { k: number; w: number; off?: number }): Polygon | null => {
    const hps: HalfPlane[] = [{ p: { x: f.fa.x + f.n.x * d0, y: f.fa.y + f.n.y * d0 }, n: f.n }, { p: { x: f.fa.x + f.n.x * d1, y: f.fa.y + f.n.y * d1 }, n: { x: -f.n.x, y: -f.n.y } }];
    if (side) {
      const h = sideHP(side.k), o = side.off ?? 0;
      hps.push({ p: { x: h.p.x + h.n.x * o, y: h.p.y + h.n.y * o }, n: h.n }, { p: { x: h.p.x + h.n.x * (o + side.w), y: h.p.y + h.n.y * (o + side.w) }, n: { x: -h.n.x, y: -h.n.y } });
    }
    let best: Polygon | null = null;
    for (const r of clipPlot(pl.poly, keep(hps), conv)) { const c = cleanRing(r, 0.005, 0.5, 0.002, false); if (c.length >= 3 && (!best || area(c) > area(best))) best = c; }
    return best && area(best) > 6 ? best : null;
  };
  const out: ArchBldg[] = [];
  const put = (poly: Polygon | null, arch: string, kind: Bldg['kind'], storeys: number) => {
    if (poly && shapeOf(poly).w >= MIN_BW) out.push({ poly, kind, arch, roof: 'gable', material: 'wood', storeys, orientation: ori });
  };
  // the roji: every fourth lot, along side 1
  const roji = pl.order % 4 === 1 && W >= MIN_BW + 1.7 ? 1.7 : 0;
  const keep = (hp: HalfPlane[]): HalfPlane[] => {
    if (!roji) return hp;
    const h = sideHP(1);
    return [...hp, { p: { x: h.p.x + h.n.x * roji, y: h.p.y + h.n.y * roji }, n: h.n }];
  };
  if (W > 12) {
    // a wide merchant lot (odana): a deep front range, then a storehouse range across a court
    const hd = Math.min(D - 0.5, rng.range(10, 13));
    put(piece(0, hd), 'machiya', 'house', 2);
    if (D - hd > 12) put(piece(hd + rng.range(4, 6), Math.min(D, hd + rng.range(10, 13)), { k: 0, w: W * rng.range(0.5, 0.8) }), 'kura', 'back', 2);
    return out;
  }
  const hd = Math.min(D, rng.range(8, 11));
  const front = piece(0, hd);
  if (!front) return out;
  // (the tori-niwa, an earthen-floored passage through the house, leads to the garden and the kura)
  pl.gated = true;
  const court = rng.range(2.5, 3.6);
  // (the C-shaped house stays within 1:3)
  const rd = Math.min(rng.range(5, 7.5), 2.9 * W - hd - court);
  let house: Polygon = front;
  let backEnd = hd;
  const k = rng.chance(0.5) ? 0 : 1;
  if (rd >= 4 && D - hd >= court + rd + 0.5 && cov > 0.6) {
    const corr = piece(hd, hd + court, { k, w: Math.min(1.8, W - 2.5) });
    const back = piece(hd + court, hd + court + rd);
    if (corr && back) {
      const j1 = stitchUnion(house, corr);
      const j2 = j1 ? stitchUnion(j1, back) : null;
      if (j2) house = j2; else put(back, 'machiya-okuzashiki', 'rear', 2);
      backEnd = hd + court + rd;
    }
  }
  put(house, 'machiya', 'house', rng.chance(0.3) ? 1 : 2);
  // the kura at the back of the lot, against one side line
  const kd = rng.range(5.5, 7), kw = Math.min(W - 0.6, rng.range(4.6, 5.5));
  if (D - kd - 1 > backEnd + 2 && kw >= 3.6) put(piece(D - 0.8 - kd, D - 0.8, { k: 0, w: kw, off: 0.3 }), 'kura', 'back', 2);
  void P;
  return out;
}

// ---------------------------------------------------------------- elven tree houses
function treeHouse(pl: Plot, P: MorphologyParams, rng: Rng): ArchBldg[] {
  const ins = inscribed(pl.poly, [], 0.5);
  const out: ArchBldg[] = [];
  const r = Math.min(ins.r - 1.2, rng.range(3.2, 6));
  if (r < 2.5) return out;
  // off-centre toward the path (frontage)
  const f = frame(pl);
  let c = ins.c;
  if (f) {
    const toward = rng.range(0, Math.max(0, ins.r - r - 1.5));
    const q = { x: c.x - f.n.x * toward, y: c.y - f.n.y * toward };
    if (pointInRing(pl.poly, q) && distToRing(pl.poly, q) >= r + 0.8) c = q;
  }
  const main = orientPos(disk(c, r, 18));
  out.push({ poly: main, kind: 'house', arch: 'tree-house', roof: 'dome', material: 'living-wood', storeys: rng.int(1, 3) });
  // satellite pods
  const nSat = rng.int(0, 2);
  const placed: { c: Vec2; r: number }[] = [{ c, r }];
  for (let k = 0; k < nSat; k++) {
    const r2 = rng.range(2.5, 3.4);
    for (let tries = 0; tries < 8; tries++) {
      const a = rng.range(0, 2 * Math.PI);
      const dd = r + r2 + rng.range(0.6, 2.5);
      const q = { x: c.x + Math.cos(a) * dd, y: c.y + Math.sin(a) * dd };
      if (!pointInRing(pl.poly, q) || distToRing(pl.poly, q) < r2 + 0.6) continue;
      if (placed.some((o) => dist(o.c, q) < o.r + r2 + 0.5)) continue;
      placed.push({ c: q, r: r2 });
      out.push({ poly: orientPos(disk(q, r2, 14)), kind: 'rear', arch: 'tree-pod', roof: 'dome', material: 'living-wood', storeys: 1 });
      break;
    }
  }
  void P;
  return out;
}

// ---------------------------------------------------------------- dwarven hall
/**
 * Dwarven terrace lot: a stone house over the frontage (or, on wide rich lots, a great hall with chamfered corners),
 * a workshop or forge behind it across a narrow yard, and dwellings cut into the slope at the back of the lot (a
 * full-width range against the terrace wall); a 2.2 m stair-lane along one side line leads to the back.
 */
function hall(pl: Plot, P: MorphologyParams, rng: Rng): ArchBldg[] {
  const f = frame(pl);
  if (!f) return [];
  const us = usable(pl, f);
  if (!us) return [];
  const { u0, u1 } = us;
  const D = us.D, W = u1 - u0;
  const ori = Math.atan2(f.n.y, f.n.x);
  const out: ArchBldg[] = [];
  const put = (poly: Polygon | null, arch: string, kind: Bldg['kind'], storeys: number) => {
    if (poly && shapeOf(poly).w >= MIN_BW) out.push({ poly, kind, arch, roof: P.arch.roof, material: P.arch.material, storeys, orientation: ori });
  };
  // the stair-lane (2.2 m) along one side line leads to the back of the lot (dwarven lots are stepped: the back is
  // a terrace higher or lower than the street)
  const lane = 2.2;
  const left = rng.chance(0.5);
  const a0 = left ? u0 + lane : u0, a1 = left ? u1 : u1 - lane;
  const great = W >= 14 && (pl.wealth ?? 0.5) > 0.45 && rng.chance(0.55);
  // the front: a great hall (chamfered corners on the large ones), or a stone house over the frontage
  const hd = great ? Math.min(D - 1, Math.max(10, D * rng.range(0.5, 0.65))) : Math.min(D - 1, rng.range(8, 10.5));
  let front = rectIn(pl, f, a0, a1, 0.3, hd, 20);
  if (front && great && a1 - a0 > 12 && hd > 12) {
    const c = Math.min(a1 - a0, hd) * 0.2;
    const at = (u: number, d: number): Vec2 => ({ x: f.fa.x + f.t.x * u + f.n.x * d, y: f.fa.y + f.t.y * u + f.n.y * d });
    const oct = orientPos([at(a0 + c, 0.3), at(a1 - c, 0.3), at(a1, 0.3 + c), at(a1, hd - c), at(a1 - c, hd), at(a0 + c, hd), at(a0, hd - c), at(a0, 0.3 + c)]);
    if (polyInside(pl.poly, oct)) front = oct;
  }
  put(front, great ? (front && front.length === 8 ? 'octagonal-hall' : 'stone-hall') : 'stone-house', 'house', great ? 2 : rng.int(1, 2));
  // the back of the lot: dwellings cut into the slope (a full-width range against the back terrace wall)
  const rd = rng.range(5.5, 8);
  const backAt = D - 0.3 - rd;
  if (backAt > hd + 3) put(rectIn(pl, f, u0, u1, backAt, D - 0.3, 20), 'rock-cut-dwelling', 'back', 1);
  // between them, across narrow yards: a workshop or a forge
  const mid0 = hd + 2.5, mid1 = backAt - 2.5;
  if (mid1 - mid0 >= MIN_BW) put(rectIn(pl, f, a0, a1, mid0, mid1, 20), rng.chance(0.3) ? 'forge' : 'workshop', 'rear', 1);
  pl.gated = true;
  return out;
}

/** Buildings of a plot by the morphology's building operator (gardens have kind 'garden'). */
export function buildOn(pl: Plot, cov: number, P: MorphologyParams, rng: Rng, hint?: CourtHint): ArchBldg[] {
  const all = buildOnRaw(pl, cov, P, rng, hint);
  const gardens = all.filter((b) => b.kind === 'garden');
  return (dropOverlaps(all.filter((b) => b.kind !== 'garden')) as ArchBldg[]).concat(gardens);
}

function buildOnRaw(pl: Plot, cov: number, P: MorphologyParams, rng: Rng, hint?: CourtHint): ArchBldg[] {
  switch (P.buildingOp) {
    case 'courtyardHouse': return courtyardHouse(pl, P, rng, cov);
    case 'shopRow': return shopRow(pl, P, rng);
    case 'pavilionCompound': return pavilionCompound(pl, P, rng).map((b) => ({ ...b, poly: rectify(b.poly, pl.front[0], unitT(pl), pl.nrm) ?? b.poly }));
    case 'yashiki': return yashiki(pl, P, rng);
    case 'machiya': return machiya(pl, cov, P, rng);
    case 'treeHouse': return treeHouse(pl, P, rng);
    case 'hall': return hall(pl, P, rng);
    default: {
      const ori = Math.atan2(pl.nrm.y, pl.nrm.x);
      return buildPlot(pl, cov, P, rng, hint).map((b) => (b.kind === 'garden' ? b : {
        ...b, arch: b.kind === 'hall' ? 'courtyard-hall' : b.kind === 'house' ? P.arch.typology : P.arch.typology + '-' + b.kind,
        roof: P.arch.roof, material: P.arch.material, storeys: b.kind === 'house' || b.kind === 'hall' ? Math.round(rng.range(P.arch.storeys[0], P.arch.storeys[1])) : Math.max(1, P.arch.storeys[0] - 1), orientation: ori,
      }));
    }
  }
}

const unitT = (pl: Plot): Vec2 => { const [a, b] = pl.front; const l = dist(a, b) || 1; return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; };
