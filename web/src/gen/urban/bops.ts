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
import { primitiveHouse } from './primitive';
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
function usable(pl: Plot, f: { fa: Vec2; t: Vec2; n: Vec2; W: number; D: number }, connected = false): { u0: number; u1: number; D: number } | null {
  // A notched hutong lot can intersect a depth line in several separate intervals. Its global lateral
  // envelope spans an alley/outside land and yields no halls. Follow only the interval reached from its front.
  const section = (d: number, lo: number, hi: number): [number, number] | null => {
    if (!connected) return lateral(pl.poly, f, d);
    const hits: number[] = [];
    const nc = (p: Vec2) => (p.x - f.fa.x) * f.n.x + (p.y - f.fa.y) * f.n.y;
    for (let i = 0; i < pl.poly.length; i++) {
      const a = pl.poly[i], b = pl.poly[(i + 1) % pl.poly.length], da = nc(a) - d, db = nc(b) - d;
      if ((da <= 0 && db > 0) || (db <= 0 && da > 0)) {
        const k = da / (da - db), x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k;
        hits.push((x - f.fa.x) * f.t.x + (y - f.fa.y) * f.t.y);
      }
    }
    hits.sort((a, b) => a - b);
    let best: [number, number] | null = null;
    for (let i = 0; i + 1 < hits.length; i += 2) {
      const a = Math.max(lo, hits[i]), b = Math.min(hi, hits[i + 1]);
      if (b > a && (!best || b - a > best[1] - best[0])) best = [a, b];
    }
    return best;
  };
  const L0 = section(Math.min(1, f.D / 2), 0, f.W);
  if (!L0) return null;
  let u0 = L0[0], u1 = L0[1], D = Math.min(1, f.D / 2);
  for (let d = 2; d <= f.D - 0.5; d += 1) {
    const L = section(d, u0, u1);
    if (!L) break;
    const a = Math.max(u0, L[0]), b = Math.min(u1, L[1]);
    const minimum = connected ? Math.min(0.8 * (L0[1] - L0[0]), Math.max(9, 0.5 * (L0[1] - L0[0]))) : 0.8 * (L0[1] - L0[0]);
    if (b - a < minimum) break;
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
function courtyardHouse(pl: Plot, P: MorphologyParams, rng: Rng, cov = 0.93, sub = false): ArchBldg[] {
  const f = frame(pl);
  const A = area(pl.poly);
  // an oversized lot (a block that could not be cut into houses: one street side only, along water or a wall):
  // courtyard houses along its street front, the land behind them stays a garden (never one solid block)
  const amax = P.houseArea[pl.zone]?.[1] ?? 600;
  const big = Math.max(2.6 * amax, 2500);
  if (!sub && !f && A > big) return [{ poly: pl.poly, kind: 'garden' }];
  if (!sub && f && A > big) {
    const conv = isConvex(pl.poly, 1e-3);
    const dBand = Math.min(f.D, Math.max(14, Math.sqrt(amax) * 1.15));
    const n = Math.max(1, Math.round(f.W / Math.max(10, Math.sqrt(amax) * 1.1)));
    const out: ArchBldg[] = [];
    for (let i = 0; i < n; i++) {
      const s0 = (f.W * i) / n, s1 = (f.W * (i + 1)) / n;
      const p0 = { x: f.fa.x + f.t.x * s0, y: f.fa.y + f.t.y * s0 }, p1 = { x: f.fa.x + f.t.x * s1, y: f.fa.y + f.t.y * s1 };
      const hps: HalfPlane[] = [
        { p: { x: f.fa.x - f.n.x * 0.5, y: f.fa.y - f.n.y * 0.5 }, n: f.n },
        { p: { x: f.fa.x + f.n.x * dBand, y: f.fa.y + f.n.y * dBand }, n: { x: -f.n.x, y: -f.n.y } },
        ...(i > 0 ? [{ p: p0, n: f.t }] : []),
        ...(i < n - 1 ? [{ p: p1, n: { x: -f.t.x, y: -f.t.y } }] : []),
      ];
      let best: Polygon | null = null;
      for (const r of clipPlot(pl.poly, hps, conv)) { const c = cleanRing(r, 0.005, 0.5, 0.002, false); if (c.length >= 3 && (!best || area(c) > area(best))) best = c; }
      if (!best || area(best) < 60) continue;
      const fa = i > 0 ? p0 : pl.front[0], fb = i < n - 1 ? p1 : pl.front[1];
      const subPl: Plot = { ...pl, poly: orientPos(best), front: [fa, fb], sideA: { p: fa, d: pl.nrm }, sideB: { p: fb, d: pl.nrm } };
      out.push(...courtyardHouse(subPl, P, rng, cov, true).filter((b) => polyInside(pl.poly, b.poly)));
    }
    // the land behind the houses: a garden (orchard, vegetable plots)
    for (const r of clipPlot(pl.poly, [{ p: { x: f.fa.x + f.n.x * (dBand + 0.01), y: f.fa.y + f.n.y * (dBand + 0.01) }, n: f.n }], isConvex(pl.poly, 1e-3))) {
      const c = cleanRing(r, 0.005, 0.5, 0.002, false);
      if (c.length >= 3 && area(c) > 30) out.push({ poly: c, kind: 'garden' });
    }
    pl.gated = true;
    return out;
  }
  const okShape = (p: Polygon) => { const s = shapeOf(p); return s.w >= MIN_BW && s.asp <= MAX_ASPECT; };
  // (a lot too small or too thin for a patio is built whole; long ones are cut into rooms later)
  const solid = (): ArchBldg[] => (shapeOf(pl.poly).w >= MIN_BW ? [tag({ poly: pl.poly, kind: 'house' }, P.arch, rng)] : []);
  if (!f || A < 42) return solid();
  // the patio takes ~14–24 % of the lot (≥ 9 m²) at the medina's dense baseline, more on looser land (coverage
  // lowered by the sprawl): the deepest room ring that still leaves it. (Large enough to read on a town plan.)
  const courtShare = P.courtyardShare ? Math.min(0.5, rng.range(...P.courtyardShare) + 0.55 * Math.max(0, 0.85 - cov))
    : Math.max(0.12, Math.min(0.42, 0.155 + 0.55 * (0.95 - cov) + rng.range(-0.02, 0.06)));
  const want = Math.max(10, A * courtShare);
  const courts = new Map<number, Polygon>();
  const ringFor = (axis: Vec2): ReturnType<typeof courtyardRing> => {
    for (let rd = P.roomDepth[1] + 1.5; rd >= 2.3; rd *= 0.92) {
      const r = courtyardRing(pl.poly, rd, axis, { minCourt: want, memo: courts });
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
  const us = usable(pl, f, true);
  if (!us) return [];
  const D = us.D;
  const u0 = us.u0 + 0.05, u1 = us.u1 - 0.05;
  const Wi = u1 - u0;
  const out: ArchBldg[] = [];
  const hall = (poly: Polygon | null, typ: string, storeys = 1) => {
    if (poly) out.push({ poly, kind: 'house', arch: typ, roof: P.arch.roof, material: P.arch.material, storeys, orientation: -Math.PI / 2 });
  };
  const range = (a: number, b: number, c: number, d: number, typ: string) => {
    // Wide shallow lots and long side ranges are rows of rooms, not matchsticks to discard wholesale.
    const W = b - a, H = d - c, horizontal = W >= H;
    if (Math.min(W, H) < MIN_BW) return;
    const count = Math.max(1, Math.ceil(Math.max(W, H) / (3.5 * Math.min(W, H))));
    for (let i = 0; i < count; i++) {
      const step = (horizontal ? W : H) / count, gap = count > 1 ? 0.4 : 0;
      hall(rectIn(pl, f, horizontal ? a + i * step + gap : a, horizontal ? a + (i + 1) * step - gap : b,
        horizontal ? c : c + i * step + gap, horizontal ? d : c + (i + 1) * step - gap), typ);
    }
  };
  if (Wi < 9 || D < 20) {
    range(u0, u1, 0.3, Math.min(D - 0.6, 10), 'siheyuan-hall');
    return out;
  }
  const front0 = 0.3, back1 = D - 0.3;
  // gate range along the lane, the gate (2.6–3.2 m) in one corner
  const gs = rng.range(4.6, 5.4), gap = rng.range(2.6, 3.2);
  const gateLeft = rng.chance(0.5);
  range(gateLeft ? u0 + gap : u0, gateLeft ? u1 : u1 - gap, front0, front0 + gs, 'siheyuan-gate-range');
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
      if (both || eastSide) range(u1 - sw, u1, c0 + 0.6, c1 - 0.6, 'siheyuan-side-hall');
      if (both || !eastSide) range(u0, u0 + sw, c0 + 0.6, c1 - 0.6, 'siheyuan-side-hall');
    }
    // the cross hall: the main hall with its ear rooms on the last court, middle halls before it; a side passage
    // (1.8 m, beside the hall) leads on to the next court
    const pass = j < n - 1 || rear ? 1.8 : 0;
    const pl0 = (j % 2 === 0) === gateLeft;
    range(pl0 ? u0 + pass : u0, pl0 ? u1 : u1 - pass, c1, c1 + hd, j === n - 1 ? 'siheyuan-main-hall' : 'siheyuan-middle-hall');
    d += step;
  }
  if (rear) range(u0, u1, back1 - rear, back1, 'siheyuan-rear-range');
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
  if (W > 22) {
    // an over-wide lot (a long street front left in one piece): a row of machiya fronts 6–9 m wide
    const n = Math.max(2, Math.round(W / rng.range(6.5, 9)));
    const hd = Math.min(D - 0.5, rng.range(8, 11));
    for (let i = 0; i < n; i++) put(piece(0, hd, { k: 0, w: W / n, off: (i * W) / n }), 'machiya', 'house', 2);
    return out;
  }
  if (W > 12) {
    // a wide merchant lot (odana): a deep front range, then a storehouse range across a court
    const hd = Math.min(D - 0.5, rng.range(10, 13));
    put(piece(0, hd), 'machiya', 'house', 2);
    if (D - hd > 12) put(piece(hd + rng.range(4, 6), Math.min(D, hd + rng.range(10, 13)), { k: 0, w: W * rng.range(0.5, 0.8) }), 'kura', 'back', 2);
    return out;
  }
  // (the pieces keep to the no-matchstick rule: ≥ 4.5 m wide, within 1:3)
  const putM = (poly: Polygon | null, arch: string, kind: Bldg['kind'], storeys: number) => {
    if (poly && shapeOf(poly).w >= MIN_BW && shapeOf(poly).asp <= MAX_ASPECT) out.push({ poly, kind, arch, roof: 'gable', material: 'wood', storeys, orientation: ori });
  };
  // the narrow eel's-bed lot (machi of Kyoto, Edo): full-width ranges one behind the other down the lot — the shop
  // house, the back rooms across the tsuboniwa, the kura, the back tenements — each within 1:3 of the lot width
  if (W < 7.5 && cov > 0.4) {
    const lim = Math.max(MIN_BW, 2.9 * W);
    let d = 0;
    const seq: [string, Bldg['kind'], number, [number, number], number][] = [
      ['machiya', 'house', 2, [10, 13], rng.range(2.2, 3.2)],
      ['machiya-okuzashiki', 'rear', 2, [6, 9], rng.range(2.2, 3.4)],
      ['kura', 'back', 2, [5.5, 7], rng.range(1.8, 2.8)],
      ['nagaya', 'back', 1, [8, 14], rng.range(1.8, 2.6)],
      ['nagaya', 'back', 1, [8, 14], 2],
    ];
    for (const [arch, kind, st, [lo, hi], gap] of seq) {
      const depth = Math.min(lim, rng.range(lo, hi));
      if (d + Math.min(depth, MIN_BW) > D - 0.6) break;
      const p2 = piece(d, Math.min(D - 0.6, d + depth));
      if (p2) putM(p2, arch, kind, st);
      d += depth + gap;
      if (cov < 0.6 && arch === 'kura') break;
    }
    pl.gated = true;
    return out;
  }
  const hd = Math.min(D, rng.range(9.5, 12.5));
  const front = piece(0, hd);
  if (!front) return out;
  // (the tori-niwa, an earthen-floored passage through the house, leads to the garden and the kura)
  pl.gated = true;
  const court = rng.range(2.4, 3.4);
  // (the C-shaped house stays within 1:3)
  const rd = Math.min(rng.range(6, 9), 2.9 * W - hd - court);
  let house: Polygon = front;
  let backEnd = hd;
  const k = rng.chance(0.5) ? 0 : 1;
  if (rd >= 4 && D - hd >= court + rd + 0.5 && cov > 0.4) {
    const corr = piece(hd, hd + court, { k, w: Math.min(1.8, W - 2.5) });
    const back = piece(hd + court, hd + court + rd);
    if (corr && back) {
      const j1 = stitchUnion(house, corr);
      const j2 = j1 ? stitchUnion(j1, back) : null;
      if (j2) house = j2; else putM(back, 'machiya-okuzashiki', 'rear', 2);
      backEnd = hd + court + rd;
    }
  }
  putM(house, 'machiya', 'house', rng.chance(0.3) ? 1 : 2);
  // the kura across the small back garden, against one side line
  const kd = rng.range(5.5, 7), kw = W < 6.2 ? W - 0.4 : Math.min(W - 0.6, rng.range(4.8, 5.6));
  const kEnd = Math.min(D - 0.8, backEnd + rng.range(2.5, 4.5) + kd);
  if (kEnd - kd > backEnd + 2 && kw >= MIN_BW) putM(piece(kEnd - kd, kEnd, { k: 0, w: kw, off: 0.3 }), 'kura', 'back', 2);
  // ura-nagaya: on a deep lot, a back tenement row along the other side line, reached by the lot's alley
  if (D - kEnd > 8 && W >= 4.9 && cov > 0.45) {
    const nw = Math.max(4.6, Math.min(W - 0.3, rng.range(4.6, 5.6)));
    putM(piece(kEnd + 2, Math.min(D - 0.8, kEnd + 2 + rng.range(10, 24)), { k: 1, w: nw, off: 0.2 }), 'nagaya', 'back', 1);
  }
  void P;
  return out;
}

// ---------------------------------------------------------------- Russian yard house (izba and dvor)
/**
 * A posad lot: the izba (log house) gable end to the street on one side of the frontage, the yard gate beside it,
 * the barn and sheds along the other side line, the bathhouse (banya) at the back of the yard, the kitchen garden
 * behind. Coverage only sets how many outbuildings there are: the yard and the garden always stay open.
 */
function yardHouse(pl: Plot, cov: number, P: MorphologyParams, rng: Rng): ArchBldg[] {
  const f = frame(pl);
  if (!f) return [];
  const { W, D } = f;
  const conv = isConvex(pl.poly, 1e-3);
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
    for (const r of clipPlot(pl.poly, hps, conv)) { const c = cleanRing(r, 0.005, 0.5, 0.002, false); if (c.length >= 3 && (!best || area(c) > area(best))) best = c; }
    return best && area(best) > 6 ? best : null;
  };
  const ori = Math.atan2(f.n.y, f.n.x);
  const out: ArchBldg[] = [];
  const put = (poly: Polygon | null, arch: string, kind: Bldg['kind'], storeys: number, roof: ArchSpec['roof'] = 'gable') => {
    if (poly && shapeOf(poly).w >= MIN_BW && shapeOf(poly).asp <= MAX_ASPECT) out.push({ poly, kind, arch, roof, material: P.arch.material, storeys, orientation: ori });
  };
  const k = rng.chance(0.5) ? 0 : 1;
  const wI = Math.min(W * 0.48, rng.range(6.5, 8.5));
  const dI = Math.min(D * 0.4, rng.range(9, 12.5));
  if (wI < MIN_BW || dI < MIN_BW) return out;
  // the izba, a little back from the street on one side (a two-storey house for the richer lots)
  const rich = (pl.wealth ?? 0.3) > 0.55;
  put(piece(0.8, 0.8 + dI, { k, w: wI, off: 0.6 }), 'izba', 'house', rich ? 2 : 1);
  // a second house or a shop on the street for wide lots
  if (W > 2 * wI + 6 && rng.chance(0.4 + 0.4 * cov)) put(piece(0.8, 0.8 + rng.range(7, 9), { k: 1 - k, w: rng.range(5.5, 7), off: 0.6 }), 'izba', 'house', 1);
  // outbuildings: barn and sheds along the other side line, the banya at the back of the yard
  const yEnd = Math.min(D - 4, dI + rng.range(16, 24));
  const nOut = cov > 0.3 ? 2 : 1;
  if (yEnd > dI + 8) put(piece(dI + 4, Math.min(yEnd, dI + 4 + rng.range(8, 14)), { k: 1 - k, w: Math.min(W * 0.35, rng.range(5, 6.5)), off: 0.5 }), 'barn', 'back', 1);
  if (nOut > 1 && yEnd > dI + 12) put(piece(yEnd - 4.6, yEnd, { k, w: 4.6, off: 1.2 }), 'banya', 'back', 1);
  // the kitchen garden behind the yard
  if (D - yEnd > 6) { const g = piece(yEnd + 1, D); if (g) out.push({ poly: g, kind: 'garden' }); }
  pl.gated = true;
  return out;
}

// ---------------------------------------------------------------- necropolis tombs
/**
 * A tomb lot: a mausoleum (square house-tomb with its inner cella), a round tholos, or an obelisk over the family
 * graves; set back from the street on its lot's axis, the rest of the lot graves (drawn as the burial ground).
 */
function tomb(pl: Plot, P: MorphologyParams, rng: Rng): ArchBldg[] {
  const f = frame(pl);
  if (!f) return [];
  const A = area(pl.poly);
  const ins = inscribed(pl.poly, [], 0.3);
  const ori = Math.atan2(f.n.y, f.n.x);
  const out: ArchBldg[] = [];
  const kind = A > 160 ? (rng.chance(0.7) ? 'mausoleum' : 'tholos') : A > 70 ? (rng.chance(0.5) ? 'tholos' : 'mausoleum') : 'obelisk';
  const s = kind === 'obelisk' ? 2.4 : Math.min(ins.r * 1.5, Math.sqrt(A) * rng.range(0.32, 0.45));
  if (s < 2.2 || ins.r < 1.6) return [{ poly: pl.poly, kind: 'garden' }];
  const c = ins.c;
  const ca = Math.cos(ori), sa = Math.sin(ori);
  const sq = (h: number): Polygon => orientPos([[-h, -h], [h, -h], [h, h], [-h, h]].map(([u, v]) => ({ x: c.x + u * ca - v * sa, y: c.y + u * sa + v * ca })));
  const poly = kind === 'tholos' ? orientPos(disk(c, s / 2, 16)) : sq(s / 2);
  if (!polyInside(pl.poly, poly) || pl.poly.some((q) => pointInRing(poly, q))) return [{ poly: pl.poly, kind: 'garden' }];
  out.push({ poly, kind: kind === 'obelisk' ? 'back' : 'house', arch: kind, roof: kind === 'tholos' ? 'dome' : kind === 'obelisk' ? 'pyramidal' : 'hip', material: 'stone', storeys: kind === 'obelisk' ? 4 : 1, orientation: ori, ring: true });
  // the graves: the whole lot is burial ground (the garden pass draws it, under the tomb)
  out.push({ poly: pl.poly, kind: 'garden' });
  void P;
  return out;
}

// ---------------------------------------------------------------- Venetian palazzo
/**
 * Palazzo on a canal (Ca' d'Oro, Ca' Foscari): the water front range over the whole frontage (the portego hall
 * running through it, the water gate), a wing along one side line, the cortile behind with its well-head and open
 * stair; the land side of the lot a garden or a back range. Ordinary lots: the row houses of the burgage cycle.
 */
function venetian(pl: Plot, cov: number, P: MorphologyParams, rng: Rng, hint?: CourtHint): ArchBldg[] {
  const f = frame(pl);
  const ori = Math.atan2(pl.nrm.y, pl.nrm.x);
  if (f && pl.rank <= 2 && f.W >= 12 && f.D >= 22 && (pl.wealth ?? 0.4) > 0.3 && rng.chance(0.7)) {
    const us = usable(pl, f);
    if (us) {
      const out: ArchBldg[] = [];
      const fd = Math.min(us.D - 6, rng.range(12, 16));
      const front = rectIn(pl, f, us.u0, us.u1, 0, fd, 40);
      if (front) {
        out.push({ poly: front, kind: 'house', arch: 'palazzo', roof: 'tiled-hip', material: 'brick', storeys: rng.int(3, 4), orientation: ori, courtyards: [] });
        const left = rng.chance(0.5);
        const ww = Math.min((us.u1 - us.u0) * 0.38, rng.range(5, 6.5));
        const wEnd = Math.min(us.D - 0.4, fd + rng.range(10, 18));
        const wing = rectIn(pl, f, left ? us.u0 : us.u1 - ww, left ? us.u0 + ww : us.u1, fd, wEnd, 20);
        if (wing) out.push({ poly: wing, kind: 'rear', arch: 'palazzo-wing', roof: 'tiled-hip', material: 'brick', storeys: 3, orientation: ori });
        if (us.D - wEnd > 9 && cov > 0.75) {
          const back = rectIn(pl, f, us.u0, us.u1, us.D - rng.range(6, 8), us.D - 0.3, 20);
          if (back) out.push({ poly: back, kind: 'back', arch: 'palazzo-back-range', roof: 'tiled-hip', material: 'brick', storeys: 2, orientation: ori });
        }
        pl.gated = true;
        return out;
      }
    }
  }
  return buildPlot(pl, cov, P, rng, hint).map((b) => (b.kind === 'garden' ? b : {
    ...b, arch: b.kind === 'hall' ? 'courtyard-hall' : b.kind === 'house' ? P.arch.typology : P.arch.typology + '-' + b.kind,
    roof: P.arch.roof, material: P.arch.material, storeys: b.kind === 'house' || b.kind === 'hall' ? Math.round(rng.range(P.arch.storeys[0], P.arch.storeys[1])) : Math.max(1, P.arch.storeys[0] - 1), orientation: ori,
  }));
}

// ---------------------------------------------------------------- Ottoman konak
/**
 * Ottoman wooden house (Safranbolu, Bursa): the house on the street front over most of the frontage (its upper
 * floor jettied over the street: the cikma, read as a small step of the front), the garden gate beside it, an L wing
 * along the side line on the wider lots, the kitchen or a shed at the back of the garden; the garden behind.
 */
function konak(pl: Plot, cov: number, P: MorphologyParams, rng: Rng): ArchBldg[] {
  const f = frame(pl);
  if (!f) return [];
  const us = usable(pl, f);
  if (!us) return [];
  const { u0, u1, D } = us;
  const W = u1 - u0;
  const ori = Math.atan2(f.n.y, f.n.x);
  const out: ArchBldg[] = [];
  const put = (poly: Polygon | null, arch: string, kind: Bldg['kind'], storeys: number) => {
    if (poly) out.push({ poly, kind, arch, roof: P.arch.roof, material: P.arch.material, storeys, orientation: ori });
  };
  const gate = W > 9 ? rng.range(2.4, 3.4) : 0;
  const left = rng.chance(0.5);
  const a0 = left ? u0 + 0.2 : u0 + gate, a1 = left ? u1 - gate : u1 - 0.2;
  const hd = Math.min(D - 1, rng.range(8, 11));
  // the jettied front: the upper storey over part of the front (one footprint with a stepped front)
  const ground = rectIn(pl, f, a0, a1, 0.6, hd, 25);
  if (!ground) return out;
  let house = ground;
  if (a1 - a0 > 8 && rng.chance(0.55)) {
    // The cikma is a shallow part of a usable house, never a standalone dwelling. The dwelling-width guard
    // of rectIn used to reject its 0.65 m depth unconditionally. Clip the component, then validate the whole.
    const parts = clipPlot(pl.poly, rectHP(f, a0 + (a1 - a0) * rng.range(0.25, 0.4), a1 - (a1 - a0) * rng.range(0.1, 0.25), 0.05, 0.7), isConvex(pl.poly, 1e-3));
    if (parts.length === 1 && area(parts[0]) > 1) {
      const u = union(ground, parts[0]);
      if (u.length === 1 && !u[0].holes.length) {
        const joined = cleanRing(u[0].outer, 0.005, 0.5, 0.002, false);
        const shape = shapeOf(joined);
        if (isSimple(joined) && polyInside(pl.poly, joined) && area(joined) >= area(ground) && shape.w >= MIN_BW && shape.asp <= 4.05) house = joined;
      }
    }
  }
  put(house, 'ottoman-wooden-house', 'house', (pl.wealth ?? 0.4) > 0.5 ? 3 : 2);
  // the L wing along the side away from the gate (the haremlik) on wide, deep lots
  if (W >= 13 && D > hd + 10 && cov > 0.45 && rng.chance(0.6)) {
    const ww = Math.min(W * 0.42, rng.range(5, 6.5));
    put(rectIn(pl, f, left ? u0 + 0.2 : u1 - 0.2 - ww, left ? u0 + 0.2 + ww : u1 - 0.2, hd, Math.min(D - 1, hd + rng.range(7, 11)), 20), 'ottoman-house-wing', 'rear', 2);
  }
  // the kitchen or a shed against the back of the garden
  if (D > hd + 16) {
    const sw = Math.min(W * 0.5, rng.range(4.6, 6)), sd = rng.range(4.6, 5.6);
    put(rectIn(pl, f, left ? u1 - 0.3 - sw : u0 + 0.3, left ? u1 - 0.3 : u0 + 0.3 + sw, D - 0.5 - sd, D - 0.5, 15), 'mutfak-kitchen', 'back', 1);
  }
  // the garden behind the house (drawn under the wing and the kitchen)
  const g = D > hd + 6 ? rectIn(pl, f, u0 + 0.3, u1 - 0.3, hd + 0.4, D - 0.3, 20) : null;
  if (g) out.push({ poly: g, kind: 'garden' });
  pl.gated = true;
  return out;
}

// ---------------------------------------------------------------- Sahelian compound house
/**
 * Sahelian compound (Djenne, Kano, Timbuktu): the lot walled in mud; the entrance hall (zaure) and the front range
 * on the street (two storeys in the town, its facade ribbed), rooms along a side wall and at the back of the court,
 * one to three round granaries standing in the court.
 */
function sahelCompound(pl: Plot, cov: number, P: MorphologyParams, rng: Rng): ArchBldg[] {
  const f = frame(pl);
  if (!f) return [];
  const us = usable(pl, f);
  if (!us) return [];
  const { u0, u1, D } = us;
  const W = u1 - u0;
  const ori = Math.atan2(f.n.y, f.n.x);
  const out: ArchBldg[] = [];
  const town = pl.zone === 'core' || pl.zone === 'middle';
  const put = (poly: Polygon | null, arch: string, kind: Bldg['kind'], storeys: number, roof: ArchSpec['roof'] = 'flat') => {
    if (poly && !out.some((b) => bboxHit(b.poly, poly) && polysOverlap(b.poly, poly))) out.push({ poly, kind, arch, roof, material: 'mud', storeys, orientation: ori });
  };
  const fd = Math.min(D - 2, rng.range(4.6, 6.5));
  const gate = Math.min(3, W * 0.25);
  const gl = rng.chance(0.5);
  // the front range either side of the gate in the middle of the street wall (the zaure beside it)
  const mid = (u0 + u1) / 2;
  put(rectIn(pl, f, u0 + 0.6, mid - gate / 2, 0.4, fd, 12), town ? 'sudano-sahelian-house' : 'compound-room', 'house', town && cov > 0.6 ? 2 : 1);
  put(rectIn(pl, f, mid + gate / 2, u1 - 0.6, 0.4, fd, 12), 'zaure', 'house', 1);
  // rooms along one side and across the back of the court
  const side = gl ? 1 : 0;
  const sw = Math.min(W * 0.35, rng.range(3.8, 4.8));
  const backD = rng.range(3.8, 4.8);
  if (D > fd + 9) put(rectIn(pl, f, side ? u1 - 0.6 - sw : u0 + 0.6, side ? u1 - 0.6 : u0 + 0.6 + sw, fd + 1.5, Math.min(D - backD - 2.5, fd + 1.5 + rng.range(7, 12)), 12), 'compound-room', 'rear', 1);
  if (D > fd + 12 && cov > 0.35) put(rectIn(pl, f, u0 + 0.6, u1 - 0.6, D - 0.6 - backD, D - 0.6, 12), 'compound-room', 'back', 1);
  // granaries in the court
  const nG = W > 12 && D > 16 ? rng.int(1, 3) : W > 8 && D > 12 ? 1 : 0;
  for (let k = 0; k < nG; k++) {
    for (let t = 0; t < 6; t++) {
      const u = u0 + 2.5 + rng.float() * (W - 5), d = fd + 2.5 + rng.float() * Math.max(0.1, D - fd - backD - 5);
      const c = { x: f.fa.x + f.t.x * u + f.n.x * d, y: f.fa.y + f.t.y * u + f.n.y * d };
      const g = orientPos(disk(c, rng.range(1.2, 1.7), 10));
      if (!polyInside(pl.poly, g) || out.some((b) => bboxHit(b.poly, g))) continue;
      out.push({ poly: g, kind: 'back', arch: 'granary', roof: 'conical', material: 'mud', storeys: 1, orientation: ori, ring: true });
      break;
    }
  }
  pl.gated = true;
  void P;
  return out;
}
const polysOverlap = (a: Polygon, b: Polygon): boolean => a.some((q) => pointInRing(b, q)) || b.some((q) => pointInRing(a, q));

// ---------------------------------------------------------------- Hanseatic gabled house (Dielenhaus) and Gang
/**
 * Hanseatic merchant house on a narrow deep lot: the gabled front house (the Diele, the tall hall of the ground
 * floor, and the lofts above) 14–20 m deep over the whole frontage, a rear wing (Flügel) along one side line, the
 * yard behind. Every fifth lot carries a Gang instead: a 1.3 m alley through the front house to a row of one-room
 * cottages (Buden) along it in the back yard. Wide lots hold two houses side by side.
 */
function giebelhaus(pl: Plot, cov: number, P: MorphologyParams, rng: Rng): ArchBldg[] {
  const f = frame(pl);
  if (!f) return [];
  const { W, D } = f;
  const ori = Math.atan2(f.n.y, f.n.x);
  const conv = isConvex(pl.poly, 1e-3);
  const sideHP = (k: number): HalfPlane => {
    const sd = k === 0 ? pl.sideA : pl.sideB;
    const tw = k === 0 ? f.t : { x: -f.t.x, y: -f.t.y };
    let m = { x: -sd.d.y, y: sd.d.x };
    if (m.x * tw.x + m.y * tw.y < 0) m = { x: -m.x, y: -m.y };
    return { p: sd.p, n: m };
  };
  const piece = (d0: number, d1: number, side?: { k: number; w: number; off?: number }): Polygon | null => {
    const hps: HalfPlane[] = [{ p: { x: f.fa.x + f.n.x * d0, y: f.fa.y + f.n.y * d0 }, n: f.n }, { p: { x: f.fa.x + f.n.x * d1, y: f.fa.y + f.n.y * d1 }, n: { x: -f.n.x, y: -f.n.y } }];
    if (side) {
      const h = sideHP(side.k), o = side.off ?? 0;
      hps.push({ p: { x: h.p.x + h.n.x * o, y: h.p.y + h.n.y * o }, n: h.n }, { p: { x: h.p.x + h.n.x * (o + side.w), y: h.p.y + h.n.y * (o + side.w) }, n: { x: -h.n.x, y: -h.n.y } });
    }
    let best: Polygon | null = null;
    for (const r of clipPlot(pl.poly, hps, conv)) { const c = cleanRing(r, 0.005, 0.5, 0.002, false); if (c.length >= 3 && (!best || area(c) > area(best))) best = c; }
    return best && area(best) > 6 ? best : null;
  };
  const out: ArchBldg[] = [];
  const put = (poly: Polygon | null, arch: string, kind: Bldg['kind'], storeys: number) => {
    if (poly && shapeOf(poly).w >= MIN_BW - 0.6) out.push({ poly, kind, arch, roof: 'gable', material: P.arch.material, storeys, orientation: ori });
  };
  const hd = Math.min(D - 0.5, rng.range(15, 21));
  const tall = (pl.wealth ?? 0.4) > 0.5 ? rng.int(4, 5) : rng.int(3, 4);
  // a Gang: the alley along side A through to the back, the Buden in a row along it
  const gang = (pl.order % 4 === 2 || rng.chance(Math.max(0, cov - 0.75))) && D > hd + 10 && W >= 5.4 && cov > 0.6;
  if (gang) {
    const gw = 1.3;
    put(piece(0, hd, { k: 0, w: W - gw, off: gw }), 'giebelhaus', 'house', tall);
    const bw = Math.min(W - gw - 0.2, rng.range(3.6, 4.4));
    for (let d = hd + 1.5; d + 4 <= D - 0.8; d += 4.4) {
      const b = piece(d, d + 4, { k: 0, w: bw, off: gw });
      if (b && shapeOf(b).w >= 3.2) out.push({ poly: b, kind: 'back', arch: 'gang-bude', roof: 'gable', material: P.arch.material, storeys: 1, orientation: ori, ring: true });
    }
    pl.gated = true;
    return out;
  }
  if (W > 13) {
    // two houses side by side
    // (both strips measured from the same side line: disjoint on a fanned lot too)
    put(piece(0, hd, { k: 0, w: W / 2 }), 'giebelhaus', 'house', tall);
    put(piece(0, hd * rng.range(0.85, 1), { k: 0, w: W, off: W / 2 }), 'giebelhaus', 'house', tall - 1);
  } else put(piece(0, hd), 'giebelhaus', 'house', tall);
  // the rear wing (Flügel) along one side, a passage (the Diele's back door) beside it to the yard
  const wEnd = Math.min(D - 1, hd + rng.range(10, 18) * (0.6 + cov * 0.6));
  if (cov > 0.5 && D > hd + 6 && W >= 6) {
    const k = rng.chance(0.5) ? 0 : 1;
    put(piece(hd, wEnd, { k, w: Math.max(3.9, Math.min(W - 1.6, rng.range(4.2, 5.2))) }), 'fluegel', 'rear', tall - 1);
  }
  // a back house (Hinterhaus) at the end of deep lots
  if (cov > 0.7 && D > wEnd + 8) put(piece(D - rng.range(6, 8), D - 0.5), 'hinterhaus', 'back', 2);
  pl.gated = true;
  return out;
}

// ---------------------------------------------------------------- Korean hanok
/**
 * Hanok in its walled lot, round the madang (the bare court): a commoner's house is a giwa- or thatch-roofed ㄱ (an
 * L of the main hall and one wing) at the back of the court; a yangban house is a ㅁ: the gate range (haengnang)
 * on the lane with the gate in it, the men's hall (sarangchae) and the women's hall (anchae) at the back, wings
 * between them; a ㄷ (no front range) between the two.
 */
function hanok(pl: Plot, cov: number, P: MorphologyParams, rng: Rng): ArchBldg[] {
  const f = frame(pl);
  if (!f) return [];
  const us = usable(pl, f);
  if (!us) return [];
  const { u0, u1, D } = us;
  const W = u1 - u0;
  const ori = Math.atan2(f.n.y, f.n.x);
  const rich = (pl.wealth ?? 0.4) > 0.5 && W >= 15 && D >= 18;
  const roof: ArchSpec['roof'] = rich || (pl.wealth ?? 0.4) > 0.35 ? 'tiled-hip' : 'thatch-round';
  const mat = roof === 'tiled-hip' ? 'wood' : 'thatch';
  const out: ArchBldg[] = [];
  const put = (poly: Polygon | null, arch: string, kind: Bldg['kind']) => {
    if (poly) out.push({ poly, kind, arch, roof, material: mat, storeys: 1, orientation: ori });
  };
  const m = 0.8; // eaves clear of the lot wall
  const bd = Math.min(rng.range(5, 6.5), D * 0.3);
  const back0 = Math.min(D - m - bd, Math.max(bd + 6, D * rng.range(0.55, 0.75)));
  // the main hall across the back of the court
  put(rectIn(pl, f, u0 + m, u1 - m, back0, back0 + bd, 20), rich ? 'anchae' : 'hanok', 'house');
  const left = rng.chance(0.5);
  const ww = Math.min(W * 0.32, rng.range(4.4, 5.2));
  const front0 = rich ? m + 4.8 + 0.01 : Math.max(m + 2.5, back0 - rng.range(7, 11));
  // the wing(s) down the side(s) of the court
  put(rectIn(pl, f, left ? u0 + m : u1 - m - ww, left ? u0 + m + ww : u1 - m, front0, back0 - 0.01, 12), rich ? 'sarangchae' : 'hanok-wing', 'rear');
  if (rich || (W > 16 && cov > 0.5 && rng.chance(0.5))) put(rectIn(pl, f, left ? u1 - m - ww : u0 + m, left ? u1 - m : u0 + m + ww, front0, back0 - 0.01, 12), 'hanok-wing', 'rear');
  // the gate range on the lane (ㅁ), the gate (3 m) in it
  if (rich) {
    const g = (u0 + u1) / 2;
    put(rectIn(pl, f, u0 + m, g - 1.5, m, m + 4.8, 10), 'haengnang', 'house');
    put(rectIn(pl, f, g + 1.5, u1 - m, m, m + 4.8, 10), 'haengnang', 'house');
  }
  pl.gated = true;
  void P;
  return out;
}

// ---------------------------------------------------------------- gnomish tall house
/**
 * Gnomish house: a very narrow, very tall house on the street front (5–7 storeys under a steep pyramidal roof),
 * the workshop behind it across a light well, a passage along one side line to the workshop door.
 */
function gnomeHouse(pl: Plot, cov: number, P: MorphologyParams, rng: Rng): ArchBldg[] {
  const f = frame(pl);
  if (!f) return [];
  const us = usable(pl, f);
  if (!us) return [];
  const { u0, u1, D } = us;
  const ori = Math.atan2(f.n.y, f.n.x);
  const out: ArchBldg[] = [];
  const hd = Math.min(D - 0.4, rng.range(8, 11));
  // (the front house takes the lot's whole street front: plot ∩ the depth band, wall to wall with its neighbours)
  let front: Polygon | null = null;
  for (const r of clipPlot(pl.poly, [{ p: f.fa, n: f.n }, { p: { x: f.fa.x + f.n.x * hd, y: f.fa.y + f.n.y * hd }, n: { x: -f.n.x, y: -f.n.y } }], isConvex(pl.poly, 1e-3))) {
    const c = cleanRing(r, 0.005, 0.5, 0.002, false);
    if (c.length >= 3 && (!front || area(c) > area(front))) front = c;
  }
  if (front && (shapeOf(front).w < MIN_BW || shapeOf(front).asp > MAX_ASPECT)) front = rectIn(pl, f, u0, u1, 0, hd, 15);
  if (front) out.push({ poly: front, kind: 'house', arch: 'gnome-tallhouse', roof: 'pyramidal', material: P.arch.material, storeys: rng.int(5, 7), orientation: ori });
  const w0 = hd + rng.range(1.6, 2.6), w1 = Math.min(D - 0.4, w0 + rng.range(6, 10) * (0.6 + cov * 0.5));
  const left = rng.chance(0.5);
  const pass = (u1 - u0) > 6.5 ? 1.2 : 0;
  if (w1 - w0 >= 4.5) {
    const ws = rectIn(pl, f, left ? u0 + pass : u0, left ? u1 : u1 - pass, w0, w1, 15);
    if (ws) out.push({ poly: ws, kind: 'rear', arch: 'gnome-workshop', roof: 'gable', material: P.arch.material, storeys: 2, orientation: ori });
  }
  pl.gated = true;
  return out;
}

// ---------------------------------------------------------------- Inca kancha
/**
 * Kancha: a walled rectangular compound of single-room houses set along the inside of its wall around a central
 * court, the corners left open; on the street side two shorter houses flank the single gate. (The enclosure wall
 * itself is drawn as a compound-wall plan line, open at the gate.)
 */
function kancha(pl: Plot, P: MorphologyParams, rng: Rng): ArchBldg[] {
  const f = frame(pl);
  if (!f) return [];
  const Q = orientPos(pl.poly);
  const out: ArchBldg[] = [];
  const fm = { x: (pl.front[0].x + pl.front[1].x) / 2, y: (pl.front[0].y + pl.front[1].y) / 2 };
  const dep = rng.range(P.roomDepth[0], P.roomDepth[1]);
  const gap = rng.range(2.6, 4.2);
  const room = (a: Vec2, b: Vec2, s0: number, s1: number): Polygon | null => {
    const L = dist(a, b);
    if (s1 - s0 < 6) return null;
    const t = { x: (b.x - a.x) / L, y: (b.y - a.y) / L }, n = { x: -t.y, y: t.x };
    const o = 0.7;
    const p = (s: number, d: number): Vec2 => ({ x: a.x + t.x * s + n.x * d, y: a.y + t.y * s + n.y * d });
    const r = orientPos([p(s0, o), p(s1, o), p(s1, o + dep), p(s0, o + dep)]);
    return polyInside(Q, r) ? r : null;
  };
  for (let i = 0; i < Q.length; i++) {
    const a = Q[i], b = Q[(i + 1) % Q.length];
    const L = dist(a, b);
    if (L < 10) continue;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const isFront = dist(m, fm) < 0.5 || distToSegPt(fm, a, b) < 0.3;
    // (the corners stay open: each range stops a gap short of the next range's depth)
    const g0 = 0.7 + dep + gap * 0.6, g1 = L - g0;
    const polys: (Polygon | null)[] = isFront
      // the gate in the middle of the street side, a short house either side of it
      ? [room(a, b, g0, L / 2 - 2.2), room(a, b, L / 2 + 2.2, g1)]
      : [L > 34 && rng.chance(0.5) ? room(a, b, g0, L / 2 - 1.5) : room(a, b, g0, g1), L > 34 ? room(a, b, L / 2 + 1.5, g1) : null];
    for (const r of polys) if (r && shapeOf(r).w >= MIN_BW) out.push(tag({ poly: r, kind: 'house' }, P.arch, rng, { orientation: Math.atan2(b.y - a.y, b.x - a.x), ring: true }));
  }
  pl.gated = true;
  return out;
}
function distToSegPt(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
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
    case 'primitive': return primitiveHouse(pl, cov, P, rng);
    case 'courtyardHouse': return courtyardHouse(pl, P, rng, cov);
    case 'shopRow': return shopRow(pl, P, rng);
    case 'pavilionCompound': return pavilionCompound(pl, P, rng).map((b) => ({ ...b, poly: rectify(b.poly, pl.front[0], unitT(pl), pl.nrm) ?? b.poly }));
    case 'yashiki': return yashiki(pl, P, rng);
    case 'machiya': return machiya(pl, cov, P, rng);
    case 'treeHouse': return treeHouse(pl, P, rng);
    case 'hall': return hall(pl, P, rng);
    case 'kancha': return kancha(pl, P, rng);
    case 'yardHouse': return yardHouse(pl, cov, P, rng);
    case 'tomb': return tomb(pl, P, rng);
    case 'venetian': return venetian(pl, cov, P, rng, hint);
    case 'konak': return konak(pl, cov, P, rng);
    case 'sahelCompound': return sahelCompound(pl, cov, P, rng);
    case 'giebelhaus': return giebelhaus(pl, cov, P, rng);
    case 'hanok': return hanok(pl, cov, P, rng);
    case 'gnome': return gnomeHouse(pl, cov, P, rng);
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
