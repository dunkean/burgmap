/**
 * Pueblo (Pueblo Bonito, Chetro Ketl, Pueblo del Arroyo, Taos): terraced, agglutinated room blocks around plazas,
 * kivas (round sunken chambers) in the plazas, the great kiva; small unit pueblos (an L of rooms, a kiva, a midden)
 * round the great houses; straight roads between them. A hamlet is one unit pueblo; a village one great house; a
 * town several great houses on the canyon floor.
 *
 * Partition: each house is a compound block (D-shaped or a U of wings closed by a front row). Its plaza (with the
 * passage through the front row) is one parcel; the room block, compound \ plaza, is the other; the room block is
 * tiled exactly by rooms (annular sectors along the arc, grid cells in the wings), each room a building whose
 * storeys step down toward the plaza (terraces). Kivas are fitted inside the plaza. Paths (rank 1 from the road,
 * straight roads between houses) reach every house at its passage.
 */
import type { Vec2, Polygon } from '../../core/geom';
import { dist } from '../../core/geom';
import type { Rng } from '../../core/rng';
import { orientPos, pointInRing, area, distToSeg, inscribed } from '../../geo/poly';
import { MultiPoly, unionS, differenceS } from '../../geo/bool';
import type { CampCtx } from './index';
import { segCrossesRing } from '../../geo/split';
import { CampOut, emptyCamp, street, pathRibbons, hut, fitIn, pieces, carveBlocks } from './kit';

interface Frame { o: Vec2; ang: number }
/** Local frame: u along the front (east–west), v toward the plaza front (south); rooms lie at v < 0. */
const L = (f: Frame, u: number, v: number): Vec2 => {
  const ca = Math.cos(f.ang), sa = Math.sin(f.ang);
  return { x: f.o.x + u * ca - v * sa, y: f.o.y + u * sa + v * ca };
};

interface House {
  outline: Polygon;
  plaza: Polygon;
  rooms: { poly: Polygon; storeys: number }[];
  /** Entrance (the passage mouth on the front) and the outward direction. */
  door: Vec2;
  out: Vec2;
  great: boolean;
}

/** Angles of an arc from t0 to t1 on a global 1.5° grid plus its ends (rows of rooms share their arc vertices). */
const arcAngles = (t0: number, t1: number): number[] => {
  const st = (1.5 * Math.PI) / 180;
  const out = [t0];
  for (let k = Math.ceil(t0 / st + 1e-9); k * st < t1 - 1e-9; k++) if (k * st > t0 + 1e-9) out.push(k * st);
  out.push(t1);
  return out;
};
const sector = (f: Frame, r0: number, r1: number, t0: number, t1: number): Polygon => {
  const ts = arcAngles(t0, t1);
  const pts: Vec2[] = ts.map((t) => L(f, Math.cos(t) * r1, Math.sin(t) * r1));
  for (const t of ts.slice().reverse()) pts.push(L(f, Math.cos(t) * r0, Math.sin(t) * r0));
  return orientPos(pts);
};
const box = (f: Frame, u0: number, u1: number, v0: number, v1: number): Polygon => orientPos([L(f, u0, v0), L(f, u1, v0), L(f, u1, v1), L(f, u0, v1)]);

/** Rooms of a rectangle u0..u1 × v0..v1 cut into `rows` along v and rooms of ~w along u (storeys by row). */
function roomGrid(f: Frame, u0: number, u1: number, v0: number, v1: number, rows: number, w: number, storeys: (row: number) => number, skip?: (u: number) => boolean, skipped?: Polygon[]): { poly: Polygon; storeys: number }[] {
  const out: { poly: Polygon; storeys: number }[] = [];
  const n = Math.max(1, Math.round((u1 - u0) / w));
  const dv = (v1 - v0) / rows;
  for (let r = 0; r < rows; r++) for (let i = 0; i < n; i++) {
    const a = u0 + ((u1 - u0) * i) / n, b = u0 + ((u1 - u0) * (i + 1)) / n;
    if (skip && skip((a + b) / 2)) { skipped?.push(box(f, a, b, v0 + r * dv, v0 + (r + 1) * dv)); continue; }
    out.push({ poly: box(f, a, b, v0 + r * dv, v0 + (r + 1) * dv), storeys: storeys(r) });
  }
  return out;
}

/** A D-shaped great house (Pueblo Bonito): arc rows to the north, one front row closing the plaza. */
function dHouse(f: Frame, R: number, k: number, d: number, w: number): House {
  const Rin = R - k * d;
  const rooms: { poly: Polygon; storeys: number }[] = [];
  for (let j = 0; j < k; j++) {
    const r1 = R - j * d, r0 = r1 - d;
    const n = Math.max(3, Math.round((Math.PI * (r0 + r1)) / 2 / w));
    for (let i = 0; i < n; i++) {
      const t0 = Math.PI + (Math.PI * i) / n, t1 = Math.PI + (Math.PI * (i + 1)) / n;
      rooms.push({ poly: sector(f, r0, r1, t0, t1), storeys: k - j });
    }
  }
  // the front row across the plaza, with the passage in the middle
  const pw = 1.6;
  const passage: Polygon[] = [];
  // (its end rooms follow the inner circle of the arc rows, on the same vertices)
  const ue = Math.sqrt(Rin * Rin - d * d), al = Math.asin(d / Rin);
  const nF = Math.max(2, Math.round((2 * Rin) / w));
  for (let i = 0; i < nF; i++) {
    const a = -Rin + (2 * Rin * i) / nF, b = -Rin + (2 * Rin * (i + 1)) / nF;
    const poly = i === 0
      ? orientPos([L(f, -Rin, 0), L(f, b, 0), L(f, b, -d), L(f, -ue, -d), ...arcAngles(Math.PI, Math.PI + al).slice(1, -1).reverse().map((t) => L(f, Math.cos(t) * Rin, Math.sin(t) * Rin))])
      : i === nF - 1
        ? orientPos([L(f, a, 0), L(f, Rin, 0), ...arcAngles(2 * Math.PI - al, 2 * Math.PI).slice(1, -1).reverse().map((t) => L(f, Math.cos(t) * Rin, Math.sin(t) * Rin)), L(f, ue, -d), L(f, a, -d)])
        : box(f, a, b, -d, 0);
    if (Math.abs((a + b) / 2) < pw + w / 2) { passage.push(poly); continue; }
    rooms.push({ poly, storeys: 1 });
  }
  const arc: Vec2[] = arcAngles(Math.PI, 2 * Math.PI).map((t) => L(f, Math.cos(t) * R, Math.sin(t) * R));
  // the plaza: the inner half disc behind the front row (its arc on the same angular grid as the rooms)
  const t0 = Math.PI + Math.asin(d / Rin), t1 = 2 * Math.PI - Math.asin(d / Rin);
  const pl: Vec2[] = [L(f, -ue, -d), ...arcAngles(Math.PI, 2 * Math.PI).filter((t) => t > t0 + 1e-9 && t < t1 - 1e-9).map((t) => L(f, Math.cos(t) * Rin, Math.sin(t) * Rin)), L(f, ue, -d)];
  return { outline: orientPos(arc), plaza: withPassage(orientPos(pl), passage), rooms, door: L(f, 0, 0), out: L(f, 0, 10), great: true };
}

/** A U-shaped house (Pueblo del Arroyo / unit pueblo when small): back block, two wings, a front row. */
function uHouse(f: Frame, A: number, B: number, kBack: number, kWing: number, d: number, w: number, front: boolean, oneWing = false): House {
  const rooms: { poly: Polygon; storeys: number }[] = [];
  const vBack = -B + kBack * d;
  rooms.push(...roomGrid(f, -A, A, -B, vBack, kBack, w, (r) => kBack - r + 1));
  const uw = kWing * d;
  // wings: rooms along v, kWing rows across u
  const wing = (u0: number, u1: number): void => {
    const n = Math.max(1, Math.round(-vBack / w));
    for (let c = 0; c < kWing; c++) for (let i = 0; i < n; i++) {
      const a = u0 + ((u1 - u0) * c) / kWing, b = u0 + ((u1 - u0) * (c + 1)) / kWing;
      rooms.push({ poly: box(f, a, b, vBack + (-vBack * i) / n, vBack + (-vBack * (i + 1)) / n), storeys: kWing - c > 1 && i < n / 2 ? 2 : 1 });
    }
  };
  wing(-A, -A + uw);
  if (!oneWing) wing(A, A - uw);
  const pw = 1.6;
  const pu0 = -A + uw, pu1 = oneWing ? A : A - uw;
  const passage: Polygon[] = [];
  if (front) rooms.push(...roomGrid(f, pu0, pu1, -d, 0, 1, w, () => 1, (u) => Math.abs(u - (pu0 + pu1) / 2) < pw + w / 2, passage));
  const outline = box(f, -A, A, -B, 0);
  const pv1 = front ? -d : 0;
  const plaza = withPassage(box(f, pu0, pu1, vBack, pv1), passage);
  return { outline, plaza, rooms, door: L(f, (pu0 + pu1) / 2, 0), out: L(f, (pu0 + pu1) / 2, 10), great: front && A > 30 };
}

export function puebloSettlement(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  const out = emptyCamp();
  const ctx = cc.ctx;
  const rooms = Math.max(8, Math.round(pop / 1.9));
  const sr = rng.fork('layout');
  // plazas open to the south (south-east), the sun side
  const face = (): number => sr.range(-0.35, 0.15);
  const houses: { h: House; f: Frame }[] = [];
  const d = 5.4, w = 4.4;
  const nGreat = pop < 200 ? 0 : Math.max(1, Math.round(rooms / 420));
  const placed: { c: Vec2; r: number }[] = [];
  const roadDist = (p: Vec2): number => {
    let m = Infinity;
    for (const pl of cc.roads) for (let i = 1; i < pl.length; i++) {
      const a = pl[i - 1], b = pl[i];
      if (Math.min(a.x, b.x) > p.x + m || Math.max(a.x, b.x) < p.x - m || Math.min(a.y, b.y) > p.y + m || Math.max(a.y, b.y) < p.y - m) continue;
      m = Math.min(m, distToSeg(p, a, b));
    }
    return m;
  };
  const ok = (p: Vec2, r: number): boolean => {
    if (placed.some((q) => dist(q.c, p) < q.r + r + 30 * cc.sprawl)) return false;
    if (roadDist(p) < r + 8) return false;
    for (let k = 0; k < 12; k++) { const a = (k / 12) * 2 * Math.PI; const q = { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r }; if (ctx.isWater(q) || ctx.slopeAt(q) > 0.25) return false; }
    return !ctx.isWater(p);
  };
  const site = (r: number, d0: number, d1: number, key: string): Vec2 | null => {
    const pr = rng.fork(key);
    for (let t = 0; t < 120; t++) {
      const a = pr.range(0, 2 * Math.PI), dd = pr.range(d0, d1) * cc.sprawl + t * 2;
      const p = t === 0 && d0 === 0 ? c : { x: c.x + Math.cos(a) * dd, y: c.y + Math.sin(a) * dd };
      if (p.x < r + 30 || p.y < r + 30 || p.x > ctx.mapSize - r - 30 || p.y > ctx.mapSize - r - 30) continue;
      if (ok(p, r)) return p;
    }
    return null;
  };
  const siteNear = (a: Vec2, r: number, d0: number, d1: number, key: string): Vec2 | null => {
    const pr = rng.fork(key);
    for (let t = 0; t < 80; t++) {
      const ang = pr.range(0, 2 * Math.PI), dd = pr.range(d0, d1) * cc.sprawl + t * 3;
      const p = { x: a.x + Math.cos(ang) * dd, y: a.y + Math.sin(ang) * dd };
      if (p.x < r + 30 || p.y < r + 30 || p.x > ctx.mapSize - r - 30 || p.y > ctx.mapSize - r - 30) continue;
      if (ok(p, r)) return p;
    }
    return null;
  };
  // ---- great houses (rooms shared among them), then unit pueblos round them
  const perGreat = nGreat ? Math.round((rooms * (nGreat > 1 ? 0.82 : 0.88)) / nGreat) : 0;
  for (let g = 0; g < nGreat; g++) {
    const gr = rng.fork('great:' + g);
    const n = Math.round(perGreat * gr.range(0.75, 1.25));
    const k = n > 250 ? 5 : n > 120 ? 4 : 3;
    const useD = gr.chance(g === 0 ? 0.65 : 0.45);
    let h: House, rad: number;
    const ang = face();
    if (useD) {
      // rooms ≈ Σ_j π (R − (j + ½) d) / w (arc rows) + front row
      let R = 28;
      for (let it = 0; it < 40; it++) {
        let cnt = 0;
        for (let j = 0; j < k; j++) cnt += Math.round((Math.PI * (R - (j + 0.5) * d)) / w);
        cnt += Math.round((2 * (R - k * d)) / w);
        if (cnt >= n) break;
        R += 3;
      }
      rad = R;
      const p = site(rad, g === 0 ? 0 : 160, g === 0 ? 120 : 520, 'gs:' + g);
      if (!p) continue;
      const f = { o: { x: p.x, y: p.y + R * 0.4 }, ang };
      h = dHouse(f, R, k, d, w);
      houses.push({ h, f });
    } else {
      // a U: back block k rows deep, wings 2 rows, a front row
      const kw = 2;
      let A = 24;
      for (let it = 0; it < 40; it++) {
        const B = A * 1.25;
        const cnt = k * Math.round((2 * A) / w) + 2 * kw * Math.round((B - k * d) / w) + Math.round((2 * (A - kw * d)) / w);
        if (cnt >= n) break;
        A += 3;
      }
      const B = A * 1.25;
      rad = Math.hypot(A, B / 2);
      const p = site(rad, g === 0 ? 0 : 160, g === 0 ? 120 : 520, 'gs:' + g);
      if (!p) continue;
      const f = { o: { x: p.x, y: p.y + B / 2 }, ang };
      h = uHouse(f, A, B, k, kw, d, w, true);
      houses.push({ h, f });
    }
    placed.push({ c: L(houses[houses.length - 1].f, 0, -rad * 0.4), r: rad });
  }
  // unit pueblos: an L or U of 6–30 rooms with a kiva in its court
  let left = rooms - houses.reduce((s, x) => s + x.h.rooms.length, 0);
  for (let u = 0; left > 4 && u < 40; u++) {
    const ur = rng.fork('unit:' + u);
    const n = Math.min(left, ur.int(12, 36));
    const kB = n > 16 ? 2 : 1;
    const A = Math.max(9, (n / (kB + 1.2)) * w * 0.5 + 4);
    const B = kB * d + 13;
    const rad = Math.hypot(A, B);
    // (near a great house: the unit pueblos cluster round the great houses)
    const anchor = houses.length ? houses[ur.int(0, Math.min(houses.length, Math.max(1, nGreat)) - 1)].h.door : c;
    const p = siteNear(anchor, rad, houses.length ? 60 : 0, houses.length ? 240 : 80, 'us:' + u);
    if (!p) break;
    const f = { o: { x: p.x, y: p.y + B / 2 }, ang: face() };
    const h = uHouse(f, A, B, kB, 1, d, w, false, ur.chance(0.5));
    h.great = false;
    houses.push({ h, f });
    placed.push({ c: p, r: rad });
    left -= h.rooms.length;
  }
  if (!houses.length) return out;
  // ---- paths: from the road's end to the first house; each other house joins the nearest point of the network
  // by a straight way (great houses: a wide Chaco road), never through another house
  const hub = houses[0].h.out;
  const streets = [] as ReturnType<typeof street>[];
  streets.push(street([houses[0].h.door, hub, { x: hub.x + (hub.x - houses[0].h.door.x) * 0.6, y: hub.y + (hub.y - houses[0].h.door.y) * 0.6 }], 4.2, 1, 'radial'));
  const outlines = houses.map((x) => x.h.outline);
  const netPts: Vec2[] = [hub];
  const order = houses.map((_, i) => i).slice(1).sort((a, b) => dist(houses[a].h.out, hub) - dist(houses[b].h.out, hub));
  for (const i of order) {
    const h = houses[i].h;
    const cands = netPts.slice().sort((a, b) => dist(a, h.out) - dist(b, h.out));
    const clear = (a: Vec2, b: Vec2) => !outlines.some((o) => segHits(o, a, b));
    let route: Vec2[] | null = null;
    const direct = cands.find((t) => clear(h.out, t));
    if (direct) route = [h.door, h.out, direct];
    else {
      // round the house: a waypoint beyond either end of its front
      const fx = h.out.x - h.door.x, fy = h.out.y - h.door.y, fl = Math.hypot(fx, fy) || 1;
      const tx = -fy / fl, ty = fx / fl;
      const half = Math.max(...h.outline.map((q) => Math.abs((q.x - h.door.x) * tx + (q.y - h.door.y) * ty))) + 12;
      for (const sgn of [1, -1]) {
        const wp = { x: h.out.x + tx * half * sgn, y: h.out.y + ty * half * sgn };
        if (!clear(h.out, wp)) continue;
        const t = cands.find((q) => clear(wp, q));
        if (t) { route = [h.door, h.out, wp, t]; break; }
      }
    }
    if (!route) continue;
    const target = route[route.length - 1];
    streets.push(street(route, h.great ? 3.6 : 2.6, h.great ? 2 : 3, h.great ? 'street' : 'lane'));
    // points of the new way join the network
    for (let l = 2; l < route.length; l++) {
      const a = route[l - 1], b = route[l];
      for (let k = 0; k < 4; k++) netPts.push({ x: a.x + ((b.x - a.x) * k) / 4, y: a.y + ((b.y - a.y) * k) / 4 });
    }
    void target;
  }
  out.streets.push(...streets);
  const rib = pathRibbons(streets);
  // ---- quarter: the houses and the paths (and a 6 m apron round each house)
  const aprons: MultiPoly = houses.map((x) => ({ outer: x.h.outline, holes: [] }));
  let q = unionS(aprons, rib);
  if (ctx.water.length) q = differenceS(q, ctx.water);
  // (land enclosed by the ways stays in the quarter: a green when large, open ground when small)
  const holes = q.flatMap((ph) => ph.holes).filter((h) => area(h) > 1500);
  const quarters = pieces(q.map((ph) => ({ outer: ph.outer, holes: [] })), 50);
  out.quarters.push(...quarters);
  out.outline.push(...quarters);
  for (const h of holes) {
    const qi = quarters.findIndex((Q) => pointInRing(Q, h[0]));
    if (qi < 0) continue;
    for (const g of carveBlocks(h, rib, ctx.water)) {
      out.blocks.push({ poly: g, kind: 'green', quarter: qi });
      out.parcels.push({ poly: g, use: 'green', block: out.blocks.length - 1 });
    }
  }
  // ---- blocks: each house is a compound block (clear of the path ribbons)
  houses.forEach(({ h }, hi) => {
    const blocks = carveBlocks(h.outline, rib, ctx.water);
    if (!blocks.length) return;
    // the block holding the plaza, in the quarter that holds it
    const blk = blocks.reduce((b0, b) => (area(b) > area(b0) ? b : b0), blocks[0]);
    const ic = inscribed(blk, [], 0.5).c;
    const qi = quarters.findIndex((Q) => pointInRing(Q, ic));
    const bi = out.blocks.length;
    out.blocks.push({ poly: blk, kind: 'compound', compound: h.great ? 'great-house' : 'unit-pueblo', quarter: Math.max(0, qi) });
    const plazaP = pieces(differenceS(h.plaza, differenceS(h.plaza, blk)), 4);
    const roomA = pieces(differenceS(blk, plazaP.length ? plazaP.map((p) => ({ outer: p, holes: [] })) : []), 4);
    const plazaIdx: number[] = [];
    for (const p of plazaP) { plazaIdx.push(out.parcels.length); out.parcels.push({ poly: p, use: 'place', block: bi }); }
    const roomIdx: number[] = [];
    for (const p of roomA) { roomIdx.push(out.parcels.length); out.parcels.push({ poly: p, use: 'compound:room-block', block: bi }); }
    // rooms: each in the room-block parcel that holds it
    for (const r of h.rooms) {
      const ri = roomIdx.find((pi) => r.poly.every((pt) => pointInRing(out.parcels[pi].poly, pt) || distOn(out.parcels[pi].poly, pt) < 0.02));
      if (ri === undefined) continue;
      out.buildings.push({ poly: r.poly, kind: 'house', parcel: ri, arch: 'pueblo-room', roof: 'terraced', storeys: r.storeys, material: 'adobe' });
    }
    // kivas in the plaza: the great kiva of a great house, small kivas
    const kr = rng.fork('kiva:' + hi);
    for (const pi of plazaIdx) {
      const pz = out.parcels[pi].poly;
      const placedK: Polygon[] = [];
      const A = area(pz);
      if (h.great) {
        const g = fitIn(pz, (p, s) => hut(p, Math.min(10, Math.sqrt(A) * 0.12) * s, 20), placedK, { margin: 3, gap: 3, minScale: 0.6 });
        if (g) { placedK.push(g); out.buildings.push({ poly: g, kind: 'landmark', parcel: pi, arch: 'great-kiva', roof: 'flat', storeys: 1, material: 'stone' }); out.landmarks.push({ kind: 'great-kiva', poly: g }); }
      }
      const nk = Math.max(1, Math.min(8, Math.round(A / 900)));
      for (let k = 0; k < nk; k++) {
        const g = fitIn(pz, (p, s) => hut(p, kr.range(3.2, 4.8) * s, 16), placedK, { margin: 2, gap: 2.5, minScale: 0.75 });
        if (g) { placedK.push(g); out.buildings.push({ poly: g, kind: 'landmark', parcel: pi, arch: 'kiva', roof: 'flat', storeys: 1, material: 'stone' }); }
      }
      if (h.great) out.squares.push(pz);
    }
    if (h.great) out.sites.push({ id: 'great-house:' + hi, kind: 'great-house', role: 'power', lot: blk, anchor: h.door, tags: { rooms: String(h.rooms.length) } });
  });
  return out;
}

/** The plaza with the passage through the front row (one simple polygon). */
function withPassage(plaza: Polygon, passage: Polygon[]): Polygon {
  if (!passage.length) return plaza;
  const u = unionS([{ outer: plaza, holes: [] }], ...passage.map((p) => [{ outer: p, holes: [] }] as MultiPoly));
  if (u.length !== 1) return plaza;
  return pieces(u, 1)[0] ?? plaza;
}

function distOn(P: Polygon, q: Vec2): number {
  let best = Infinity;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy));
  }
  return best;
}

/** The segment (with a 4 m clearance) crosses or enters the polygon. */
function segHits(P: Polygon, a: Vec2, b: Vec2): boolean {
  if (segCrossesRing(P, a, b) || pointInRing(P, a) || pointInRing(P, b)) return true;
  const L = dist(a, b) || 1, nx = -(b.y - a.y) / L, ny = (b.x - a.x) / L;
  for (const o of [-4, 4]) if (segCrossesRing(P, { x: a.x + nx * o, y: a.y + ny * o }, { x: b.x + nx * o, y: b.y + ny * o })) return true;
  return false;
}
