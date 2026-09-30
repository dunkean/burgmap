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
import { buildPlot, clipPlot, courtyardRing, rectify, shapeOf, MIN_BW, type Bldg, type HalfPlane, type CourtHint } from './buildings';
import { area, inscribed, distToRing, orientPos, cleanRing, pointInRing } from '../geo/poly';
import { isConvex } from '../geo/split';
import { disk } from '../geo/offset';

export interface ArchBldg extends Bldg {
  arch?: string; roof?: ArchSpec['roof']; storeys?: number; material?: string; courtyards?: Polygon[]; orientation?: number;
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
function courtyardHouse(pl: Plot, P: MorphologyParams, rng: Rng): ArchBldg[] {
  const f = frame(pl);
  const A = area(pl.poly);
  const solid = (): ArchBldg[] => (shapeOf(pl.poly).w >= MIN_BW ? [tag({ poly: pl.poly, kind: 'house' }, P.arch, rng)] : []);
  if (!f || A < 70) return solid();
  const rd = rng.range(P.roomDepth[0], P.roomDepth[1]);
  const ring = courtyardRing(pl.poly, rd, f.n);
  if (!ring || area(ring.court) < 9) return solid();
  const ori = Math.atan2(f.n.y, f.n.x);
  const out: ArchBldg[] = [];
  ring.pieces.forEach((pc, i) => {
    if (shapeOf(pc).w < 3) return;
    out.push(tag({ poly: pc, kind: 'house' }, P.arch, rng, { courtyards: i === 0 ? [ring.court] : undefined, orientation: ori }));
  });
  return out.length ? out : solid();
}

// ---------------------------------------------------------------- siheyuan (pavilion compound)
function pavilionCompound(pl: Plot, P: MorphologyParams, rng: Rng): ArchBldg[] {
  const f = frame(pl);
  if (!f) return [];
  const { W, D } = f;
  const L0 = lateral(pl.poly, f, 1), L1 = lateral(pl.poly, f, Math.max(1, D - 1));
  if (!L0 || !L1) return [];
  // lateral bounds valid over the whole depth (orthogonal halls)
  const u0 = Math.max(L0[0], L1[0]) + 0.8, u1 = Math.min(L0[1], L1[1]) - 0.8;
  const Wi = u1 - u0;
  const out: ArchBldg[] = [];
  const hall = (poly: Polygon | null, typ: string, storeys = 1) => {
    if (poly) out.push({ poly, kind: 'house', arch: typ, roof: P.arch.roof, material: P.arch.material, storeys, orientation: -Math.PI / 2 });
  };
  if (Wi < 9 || D < 14) {
    hall(rectIn(pl, f, u0, u1, 0.6, Math.min(D - 0.6, 10)), 'siheyuan-hall');
    return out;
  }
  // the principal hall faces south: it stands on the northern side of the court
  const northAtBack = f.n.y < 0; // n points north (y down): the lot extends north from the lane
  const gateD = 4.8, mainD = Math.min(9, D * 0.3), sideW = Math.min(5, Wi * 0.26);
  const front0 = 0.6, back1 = D - 0.8;
  // gate range (daozuo) along the lane, with the gate gap at one corner (SE in Beijing)
  const gap = 3.2;
  const gateLeft = rng.chance(0.5);
  hall(rectIn(pl, f, gateLeft ? u0 + gap : u0, gateLeft ? u1 : u1 - gap, front0, front0 + gateD), 'siheyuan-gate-range');
  const cMain0 = northAtBack ? back1 - mainD : front0 + gateD + 1.2;
  const cMain1 = northAtBack ? back1 : front0 + gateD + 1.2 + mainD;
  hall(rectIn(pl, f, u0 + 1.2, u1 - 1.2, cMain0, cMain1), 'siheyuan-main-hall');
  // side halls (xiangfang) between, detached from the corners
  const s0 = northAtBack ? front0 + gateD + 2.2 : cMain1 + 1.6;
  const s1 = northAtBack ? cMain0 - 1.6 : back1 - (D > 30 ? 5.5 : 0) - 0.8;
  if (s1 - s0 >= 6) {
    hall(rectIn(pl, f, u0, u0 + sideW, s0, s1), 'siheyuan-side-hall');
    hall(rectIn(pl, f, u1 - sideW, u1, s0, s1), 'siheyuan-side-hall');
  }
  // deep lots: a rear range (houzhaofang)
  if (D > 30 && !northAtBack) hall(rectIn(pl, f, u0, u1, back1 - 5, back1), 'siheyuan-rear-range');
  if (D > 34 && northAtBack) hall(rectIn(pl, f, u0 + 2, u1 - 2, front0 + gateD + 7, front0 + gateD + 12), 'siheyuan-middle-hall');
  return out;
}

// ---------------------------------------------------------------- samurai yashiki
function yashiki(pl: Plot, P: MorphologyParams, rng: Rng): ArchBldg[] {
  const f = frame(pl);
  if (!f) return [];
  const { D } = f;
  const L = lateral(pl.poly, f, Math.min(D - 1, 6));
  if (!L) return [];
  const out: ArchBldg[] = [];
  const W = L[1] - L[0];
  // nagaya-mon: long gatehouse range on the street front
  const gw = Math.min(W - 2, W * rng.range(0.55, 0.8));
  const g0 = L[0] + (W - gw) * rng.range(0.2, 0.8);
  const gate = rectIn(pl, f, g0, g0 + gw, 0.6, 0.6 + 4.8);
  if (gate) out.push({ poly: gate, kind: 'house', arch: 'nagaya-mon', roof: 'tiled-hip', material: 'wood', storeys: 1 });
  // main house: detached, set back behind a forecourt
  const md0 = Math.min(D * 0.35, 14), md1 = Math.min(D - 6, md0 + rng.range(12, 18));
  const Lm = lateral(pl.poly, f, (md0 + md1) / 2);
  if (Lm && md1 - md0 >= 8) {
    const mw = Math.min(Lm[1] - Lm[0] - 8, (Lm[1] - Lm[0]) * rng.range(0.4, 0.55));
    const m0 = Lm[0] + (Lm[1] - Lm[0] - mw) * rng.range(0.3, 0.7);
    const main = rectIn(pl, f, m0, m0 + mw, md0, md1);
    if (main) out.push({ poly: main, kind: 'house', arch: 'yashiki-main-house', roof: 'tiled-hip', material: 'wood', storeys: 1, orientation: Math.atan2(f.n.y, f.n.x) });
    // L-shaped wing (shoin) toward the garden
    const wing = rectIn(pl, f, m0 + mw * 0.55, m0 + mw, md1, Math.min(D - 4, md1 + rng.range(6, 10)));
    if (wing) out.push({ poly: wing, kind: 'rear', arch: 'yashiki-shoin', roof: 'tiled-hip', material: 'wood', storeys: 1 });
  }
  // storehouse (kura) in a rear corner
  const Lr = lateral(pl.poly, f, D - 5);
  if (Lr && D > 25) {
    const left = rng.chance(0.5);
    const k = left ? rectIn(pl, f, Lr[0] + 1.5, Lr[0] + 7.5, D - 9, D - 1.5) : rectIn(pl, f, Lr[1] - 7.5, Lr[1] - 1.5, D - 9, D - 1.5);
    if (k) out.push({ poly: k, kind: 'back', arch: 'kura', roof: 'gable', material: 'wood', storeys: 2 });
  }
  // the rest of the lot is garden
  void P;
  return out;
}

// ---------------------------------------------------------------- machiya
function machiya(pl: Plot, cov: number, P: MorphologyParams, rng: Rng, hint?: CourtHint): ArchBldg[] {
  // narrow deep house over most of the lot; a light court (tsuboniwa) behind the shop; storehouse at the rear
  const bl = buildPlot(pl, cov, P, rng, { court: true, f: rng.range(0.35, 0.5) });
  void hint;
  const ori = Math.atan2(pl.nrm.y, pl.nrm.x);
  return bl.map((b) => (b.kind === 'garden' ? b : {
    ...b, arch: b.kind === 'house' ? 'machiya' : b.kind === 'back' ? 'kura' : 'machiya-rear', roof: 'gable', material: 'wood',
    storeys: b.kind === 'back' ? 2 : rng.chance(0.3) ? 1 : 2, orientation: ori,
  }));
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
function hall(pl: Plot, P: MorphologyParams, rng: Rng): ArchBldg[] {
  const f = frame(pl);
  if (!f) return [];
  const { D } = f;
  const d0 = rng.range(0.5, 1.5), d1 = D - rng.range(1.5, 3);
  const Lmid = lateral(pl.poly, f, (d0 + d1) / 2), La = lateral(pl.poly, f, d0 + 0.5), Lb = lateral(pl.poly, f, d1 - 0.5);
  if (!Lmid || !La || !Lb) return [];
  const u0 = Math.max(La[0], Lb[0]) + rng.range(0.8, 1.8), u1 = Math.min(La[1], Lb[1]) - rng.range(0.8, 1.8);
  const r = rectIn(pl, f, u0, u1, d0, d1, 30);
  if (!r) return [];
  let poly = r;
  // octagonal halls: chamfer the corners
  if (rng.chance(0.4) && u1 - u0 > 12 && d1 - d0 > 12) {
    const c = Math.min(u1 - u0, d1 - d0) * 0.22;
    const at = (u: number, d: number): Vec2 => ({ x: f.fa.x + f.t.x * u + f.n.x * d, y: f.fa.y + f.t.y * u + f.n.y * d });
    const oct = orientPos([at(u0 + c, d0), at(u1 - c, d0), at(u1, d0 + c), at(u1, d1 - c), at(u1 - c, d1), at(u0 + c, d1), at(u0, d1 - c), at(u0, d0 + c)]);
    if (oct.every((q) => pointInRing(pl.poly, q) || distToRing(pl.poly, q) < 0.01)) poly = oct;
  }
  return [{ poly, kind: 'house', arch: poly.length === 8 ? 'octagonal-hall' : P.arch.typology, roof: P.arch.roof, material: P.arch.material, storeys: rng.int(1, 2), orientation: Math.atan2(f.n.y, f.n.x) }];
}

/** Buildings of a plot by the morphology's building operator (gardens have kind 'garden'). */
export function buildOn(pl: Plot, cov: number, P: MorphologyParams, rng: Rng, hint?: CourtHint): ArchBldg[] {
  switch (P.buildingOp) {
    case 'courtyardHouse': return courtyardHouse(pl, P, rng);
    case 'pavilionCompound': return pavilionCompound(pl, P, rng).map((b) => ({ ...b, poly: rectify(b.poly, pl.front[0], unitT(pl), pl.nrm) ?? b.poly }));
    case 'yashiki': return yashiki(pl, P, rng);
    case 'machiya': return machiya(pl, cov, P, rng, hint);
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
