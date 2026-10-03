/**
 * Small bridges in town (HANDOFF §7.8): secondary streets and lanes cross the streams and small rivers that run
 * through a town, so the fabric on both banks is one network (Colmar's Lauch, Annecy's Thiou, Strasbourg's
 * Petite France, the Bruges reien). Big rivers keep the M4 rule (m4/bridges.ts: a bridge every 250–500 m).
 *
 * Partition first (URBAN_GEOMETRY): a crossing is a street piece over the water only, from bank to bank, joined
 * at both ends to a street of the partition. It is placed where
 *  - two streets end on facing banks and continue each other (the bridge joins their ends), or
 *  - a street ends on the bank and the piece across can be cut by a lane in its prolongation (a chord of that
 *    piece, i.e. an ordinary level-2 cut ending on a connected street), or
 *  - a long stretch of stream has no crossing: a lane is cut through the bank pieces on both sides.
 * Each deck is within ±30° of square to the stream. Kinds: a plank footbridge for lanes (2–3 m), a small stone
 * arch for streets (4–7 m); Japanese towns build arched timber bridges, Chinese towns stone humpbacks, lagoon towns
 * (Venetian, gnomish) the stepped footbridges of their canals; villages ford the smallest brooks.
 */
import type { Vec2, Polyline } from '../core/geom';
import { dist } from '../core/geom';
import type { Rng } from '../core/rng';
import type { World } from '../types';
import type { UrbanCtx } from './context';
import type { Piece } from './blocks';
import { Streets, LAB_WATER } from './streets';
import { GridIndex } from '../geo/spatial';
import { segSegT, pointInRing, area, convexWidth, inscribed, interiorAngle, bboxOf } from '../geo/poly';
import { splitByChord, locate, isConvex } from '../geo/split';
import type { LPoly } from '../geo/split';

/** Kinds of crossing (rendering differs by kind and arch). */
export type BridgeKind = 'footbridge' | 'arch' | 'timber-arch' | 'ford';
/** A town bridge with its kind: World['bridges'] entries carry these optional fields (road bridges have none). */
export type KindedBridge = NonNullable<World['bridges']>[number] & { kind?: BridgeKind; arch?: string };

/** Rivers at least this wide (m) are big rivers: M4 bridges only. */
export const BIG_RIVER = 11;
/** Switches: `on` (A/B hash comparisons in scratch scripts), `dbg` (count the failure reasons in the stats). */
export const STREAM_BRIDGES = { on: true, dbg: false };
const MAX_TILT = (30 * Math.PI) / 180;
const TMP = -101;

export interface StreamBridgeOpts {
  archetype: string;
  /** Culture of a quarter (sectors and phases may differ from the town's). */
  cultureOf: (quarter: number) => string;
  lagoon: boolean;
  /** Landmark lots that are open ground a lane may cross (quay aprons). */
  cuttableLot: (lot: string) => boolean;
  /** Bridges already standing (road bridges, M4 town bridges). */
  existing: { a: Vec2; b: Vec2 }[];
  rng: Rng;
}

interface RiverSeg { a: Vec2; b: Vec2; w: number }
interface Live { pc: Piece; qi: number; alive: boolean }
interface End { st: number; k: 0 | 1; p: Vec2; d: Vec2; used: boolean }
interface Chord { live: Live; chord: Polyline; label: number }
interface Landing { p: Vec2; end?: End; chord?: Chord }

const unit = (x: number, y: number): Vec2 => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; };
const rot = (v: Vec2, a: number): Vec2 => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Adds the stream crossings: streets over the water (registered in `streets`, connected), lane cuts of the bank
 * pieces where needed (`pieces` updated in place: a cut piece is replaced by its two halves). Returns the decks.
 */
export function streamBridges(ctx: UrbanCtx, pieces: Piece[][], streets: Streets, o: StreamBridgeOpts): { bridges: KindedBridge[]; stats: Record<string, number> } {
  const stats: Record<string, number> = { ends: 0, pair: 0, extend: 0, gap: 0 };
  const out: KindedBridge[] = [];
  // (failure reasons, counted when debugging)
  const why = (k: string) => { if (STREAM_BRIDGES.dbg) stats['w.' + k] = (stats['w.' + k] ?? 0) + 1; };
  const W = ctx.win;
  // ---- the small rivers inside the window (centre lines with their widths)
  const rivIdx = new GridIndex<RiverSeg>(30);
  let anySmall = false;
  for (const rv of ctx.terrain.rivers) {
    for (let i = 1; i < rv.path.length; i++) {
      const a = rv.path[i - 1], b = rv.path[i];
      if (Math.max(a.x, b.x) < W.x0 - 50 || Math.min(a.x, b.x) > W.x1 + 50 || Math.max(a.y, b.y) < W.y0 - 50 || Math.min(a.y, b.y) > W.y1 + 50) continue;
      const w = (rv.width[i - 1] + rv.width[i]) / 2;
      if (w < BIG_RIVER) anySmall = true;
      rivIdx.insertSeg(a, b, { a, b, w });
    }
  }
  if (!anySmall || !ctx.water.length) return { bridges: out, stats };
  /** River at p: the nearest centre-line segment within the water ribbon (+ margin), its width and tangent. */
  const riverAt = (p: Vec2, r: number): { w: number; t: Vec2; d: number } | null => {
    let best: { w: number; t: Vec2; d: number } | null = null;
    for (const s of rivIdx.query(p.x - r, p.y - r, p.x + r, p.y + r)) {
      const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, l2 = dx * dx + dy * dy;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / l2));
      const d = Math.hypot(p.x - s.a.x - t * dx, p.y - s.a.y - t * dy);
      if (d < (Math.max(2.5, s.w) + 2) / 2 + 2.5 && (!best || d < best.d)) best = { w: s.w, t: unit(dx, dy), d };
    }
    return best;
  };
  // ---- the water edges (the partition's water boundary) for ray casts and bank tests
  const wIdx = new GridIndex<{ a: Vec2; b: Vec2 }>(20);
  const wBB = ctx.water.map((ph) => bboxOf(ph.outer));
  for (const ph of ctx.water) for (const r of [ph.outer, ...ph.holes]) {
    const bb = bboxOf(r);
    if (bb.x1 < W.x0 - 50 || bb.x0 > W.x1 + 50 || bb.y1 < W.y0 - 50 || bb.y0 > W.y1 + 50) continue;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      if (Math.max(a.x, b.x) < W.x0 - 50 || Math.min(a.x, b.x) > W.x1 + 50 || Math.max(a.y, b.y) < W.y0 - 50 || Math.min(a.y, b.y) > W.y1 + 50) continue;
      wIdx.insertSeg(a, b, { a, b });
    }
  }
  const segD = (p: Vec2, a: Vec2, b: Vec2): number => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  };
  const onBank = (p: Vec2, tol: number): boolean => { for (const s of wIdx.query(p.x - tol, p.y - tol, p.x + tol, p.y + tol)) if (segD(p, s.a, s.b) < tol) return true; return false; };
  const inWater = (p: Vec2): boolean => ctx.water.some((ph, i) => p.x >= wBB[i].x0 && p.x <= wBB[i].x1 && p.y >= wBB[i].y0 && p.y <= wBB[i].y1 && pointInRing(ph.outer, p) && !ph.holes.some((h) => pointInRing(h, p)));
  /** First crossing of the water boundary along the ray from p (beyond minT). */
  const cast = (p: Vec2, u: Vec2, len: number, minT: number): Vec2 | null => {
    const q = { x: p.x + u.x * len, y: p.y + u.y * len };
    let bt = Infinity;
    for (const s of wIdx.query(Math.min(p.x, q.x), Math.min(p.y, q.y), Math.max(p.x, q.x), Math.max(p.y, q.y))) {
      const r = segSegT(p, q, s.a, s.b);
      if (r && r.t * len > minT && r.t < bt) bt = r.t;
    }
    return bt === Infinity ? null : { x: p.x + u.x * len * bt, y: p.y + u.y * len * bt };
  };
  const maxSpan = (w: number) => Math.min(30, (Math.max(2.5, w) + 2) * 2.4 + 6);
  /** A deck a→b over a small river: square to it within ±30°, over water between its ends. */
  const deckOk = (a: Vec2, b: Vec2): { w: number } | null => {
    const L = dist(a, b);
    if (L < 1.5) return null;
    const m = mid(a, b), rv = riverAt(m, 20);
    if (!rv || rv.w >= BIG_RIVER || L > maxSpan(rv.w)) return null;
    const u = unit(b.x - a.x, b.y - a.y);
    if (Math.abs(u.x * rv.t.x + u.y * rv.t.y) > Math.sin(MAX_TILT)) return null;
    for (const t of [0.3, 0.5, 0.7]) if (!inWater({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) return null;
    // no other street (or deck) crossed on the way
    let hit = false;
    streets.forEachSeg(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), (st, i) => {
      if (hit || !st.ribbon) return;
      const r = segSegT(a, b, st.path[i], st.path[i + 1]);
      if (r && r.t > 0.02 && r.t < 0.98) hit = true;
    });
    return hit ? null : { w: rv.w };
  };

  // ---- live pieces in a box index (a cut piece is replaced by its halves)
  const pIdx = new GridIndex<Live>(60);
  const addLive = (pc: Piece, qi: number): Live => { const l = { pc, qi, alive: true }; const b = bboxOf(pc.lp.pts); pIdx.insertBox(b.x0, b.y0, b.x1, b.y1, l); return l; };
  pieces.forEach((list, qi) => { for (const pc of list) addLive(pc, qi); });
  /**
   * Where a deck from `from` (on the near bank or mid-stream), leaving the water at p heading u, meets the town:
   * the first piece boundary on the way, at most 3 m past the water (the bank may be a strip of open ground, or
   * a quay apron built out over the water). Edge on a street: the deck lands on it.
   */
  const landAt = (from: Vec2, p: Vec2, u: Vec2): { live: Live; q: Vec2; edge: number } | null => {
    const o0 = { x: from.x + u.x * 0.5, y: from.y + u.y * 0.5 }, q1 = { x: p.x + u.x * 3, y: p.y + u.y * 3 };
    let best: { live: Live; q: Vec2; edge: number } | null = null, bt = Infinity;
    for (const l of pIdx.query(Math.min(o0.x, q1.x), Math.min(o0.y, q1.y), Math.max(o0.x, q1.x), Math.max(o0.y, q1.y))) {
      if (!l.alive) continue;
      const pts = l.pc.lp.pts;
      for (let i = 0; i < pts.length; i++) {
        const r = segSegT(o0, q1, pts[i], pts[(i + 1) % pts.length]);
        if (r && r.t < bt) { bt = r.t; best = { live: l, q: { x: o0.x + (q1.x - o0.x) * r.t, y: o0.y + (q1.y - o0.y) * r.t }, edge: i }; }
      }
    }
    // (entering the piece, not leaving one the ray started in)
    if (best && !pointInRing(best.live.pc.lp.pts, { x: best.q.x + u.x * 0.05, y: best.q.y + u.y * 0.05 })) return null;
    return best;
  };
  const connectedSt = (lab: number) => lab >= 0 && streets.list[lab].ribbon && streets.connected.has(lab);
  /** A lane cut of the bank piece from its edge point p inward, about along u, to a connected street. */
  const chordFrom = (at: { live: Live; q: Vec2; edge: number }, u: Vec2): Chord | null => {
    const p = at.q;
    const kind = at.live.pc.kind;
    // blocks, and the open places that are not landmark lots (a quay apron or a precinct is not cut)
    if (kind !== 'block' && !(kind === 'place' && (!at.live.pc.lot || o.cuttableLot(at.live.pc.lot)))) { why('c.kind.' + kind); return null; }
    const lp = at.live.pc.lp, P = at.live.pc.morph ?? ctx.params;
    const minA = kind === 'place' ? 60 : P.minBlock;
    if (area(lp.pts) < 2 * minA) { why('c.small'); return null; }
    for (const da of [0, 0.2, -0.2, 0.4, -0.4, 0.6, -0.6, 0.8, -0.8]) {
      const v = rot(u, da), q = { x: p.x + v.x * 140, y: p.y + v.y * 140 };
      let bt = Infinity, be = -1;
      for (let i = 0; i < lp.pts.length; i++) {
        const r = segSegT(p, q, lp.pts[i], lp.pts[(i + 1) % lp.pts.length]);
        if (r && r.t * 140 > 0.3 && r.t < bt) { bt = r.t; be = i; }
      }
      if (be < 0 || bt * 140 < (kind === 'place' ? 3 : 8) || bt * 140 > 120 || !connectedSt(lp.lab[be])) continue;
      const H = { x: p.x + v.x * 140 * bt, y: p.y + v.y * 140 * bt };
      const res = splitByChord(lp, [p, H], TMP);
      if (!res || !halvesOk(res, [p, H], P, minA, kind === 'place' ? 4 : P.minWidth)) continue;
      return { live: at.live, chord: [p, H], label: lp.lab[be] };
    }
    why('c.ray');
    return null;
  };
  const halvesOk = (res: [LPoly, LPoly], ch: Polyline, P: NonNullable<Piece['morph']>, minA: number, minW: number): boolean => {
    for (const X of res) {
      if (area(X.pts) < minA) return false;
      for (let i = 0; i < X.pts.length; i++) {
        const q = X.pts[i];
        if ((q.x === ch[0].x && q.y === ch[0].y) || (q.x === ch[1].x && q.y === ch[1].y)) if (interiorAngle(X.pts, i) < (35 * Math.PI) / 180) return false;
      }
      const w = isConvex(X.pts, 1e-3) ? convexWidth(X.pts) : inscribed(X.pts, [], 1, minW / 2).r * 2;
      if (w < minW) return false;
    }
    return true;
  };

  // ---- street ends on the banks of a small river
  const ends: End[] = [];
  for (const st of streets.list) {
    if (!st.ribbon || st.rank < 2 || st.path.length < 2 || !streets.connected.has(st.id) || (st.role !== 'street' && st.role !== 'lane')) continue;
    for (const k of [0, 1] as const) {
      const p = k ? st.path[st.path.length - 1] : st.path[0];
      if (p.x < W.x0 || p.x > W.x1 || p.y < W.y0 || p.y > W.y1 || !onBank(p, 0.5)) continue;
      const rv = riverAt(p, 20);
      if (!rv || rv.w >= BIG_RIVER) continue;
      // outward direction of the street at its end (over the last 4 m)
      let q = p;
      for (let j = 1; j < st.path.length && dist(q, p) < 4; j++) q = k ? st.path[st.path.length - 1 - j] : st.path[j];
      ends.push({ st: st.id, k, p, d: unit(p.x - q.x, p.y - q.y), used: false });
    }
  }
  stats.ends = ends.length;
  const endIdx = new GridIndex<End>(20);
  for (const e of ends) endIdx.insertBox(e.p.x, e.p.y, e.p.x, e.p.y, e);

  // ---- spacing: the decks already standing and the new ones
  const taken: Vec2[] = o.existing.map((b) => mid(b.a, b.b));
  const nNew = { v: 0 };
  const spaced = (m: Vec2, r: number, rExisting: number) => taken.every((t, i) => dist(t, m) >= (i < o.existing.length ? rExisting : r));

  /** The far side of a deck leaving the water at B: a connected street on the bank, or a lane cut of the bank piece. */
  const bankSide = (from: Vec2, B: Vec2, u: Vec2): { p: Vec2; chord?: Chord } | null => {
    const at = landAt(from, B, u);
    if (!at) { why('c.land'); return null; }
    const lab = at.live.pc.lp.lab[at.edge];
    if (lab >= 0) return connectedSt(lab) ? { p: at.q } : null;
    const ch = chordFrom(at, u);
    return ch ? { p: at.q, chord: ch } : null;
  };
  /** Where a deck from a bank point, heading u, lands across: a facing street end, else a street or a lane cut. */
  const across = (from: Vec2, u: Vec2, self: End | null): Landing | null => {
    const B = cast(from, u, 34, 0.5);
    if (!B) { why('e.cast'); return null; }
    // facing ends near the landing (a street that continues this one)
    let best: End | null = null, bd = 9;
    for (const e of endIdx.query(B.x - 9, B.y - 9, B.x + 9, B.y + 9)) {
      if (e.used || e === self || (self && e.st === self.st)) continue;
      const d = dist(e.p, B);
      if (d < bd && deckOk(from, e.p)) { bd = d; best = e; }
    }
    if (best) return { p: best.p, end: best };
    const side = bankSide(from, B, u);
    if (!side) return null;
    if (!deckOk(from, side.p)) { why('e.deck'); return null; }
    return side;
  };
  const applyChord = (c: Chord, rank: number, phase: number): number => {
    const lp = c.live.pc.lp, P = c.live.pc.morph ?? ctx.params;
    const res = splitByChord(lp, c.chord, TMP)!;
    const id = streets.add(c.chord, P.widthByRank[rank] * P.widthScale, rank, rank <= 2 ? 'street' : 'lane', phase);
    streets.connected.add(id);
    for (const X of res) X.lab = X.lab.map((l) => (l === TMP ? id : l));
    const list = pieces[c.live.qi], k = list.indexOf(c.live.pc);
    const A: Piece = { ...c.live.pc, lp: res[0], level: c.live.pc.level + 1 }, B: Piece = { ...c.live.pc, lp: res[1], level: c.live.pc.level + 1 };
    list.splice(k, 1, A, B);
    c.live.alive = false;
    addLive(A, c.live.qi); addLive(B, c.live.qi);
    return id;
  };
  const meanW = (id: number) => { const w = streets.list[id].widths; return w.reduce((s, x) => s + x, 0) / w.length; };
  const style = (rank: number, sw: number, w: number, culture: string, rng: Rng): { kind: BridgeKind; arch: string; width: number } => {
    const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
    if (o.archetype !== 'town' && w < 4 && rng.chance(0.7)) return { kind: 'ford', arch: 'stones', width: clamp(sw, 2.5, 4.5) };
    if (o.lagoon || culture === 'venetian-lagoon' || culture === 'gnomish') return { kind: 'footbridge', arch: 'stepped', width: clamp(sw - 0.4, 2.2, 4) };
    if (culture === 'japanese-jokamachi') return { kind: 'timber-arch', arch: 'timber', width: rank <= 2 ? clamp(sw, 3.5, 6) : clamp(sw, 2, 3) };
    if (culture === 'chinese') return { kind: 'arch', arch: 'hump', width: rank <= 2 ? clamp(sw, 4, 7) : clamp(sw, 2.5, 3.5) };
    return rank <= 2 ? { kind: 'arch', arch: 'stone', width: clamp(sw, 4, 7) } : { kind: 'footbridge', arch: 'plank', width: clamp(sw, 2, 3) };
  };
  const addDeck = (a: Vec2, b: Vec2, rank: number, phase: number, quarter: number, sw: number, rng: Rng): void => {
    const rv = riverAt(mid(a, b), 20)!;
    const s = style(rank, sw, rv.w, o.cultureOf(quarter), rng);
    // (lagoon towns dig their rank-2 level-2 cuts into canals: the crossings there are lanes)
    const r = o.lagoon ? Math.max(3, rank) : rank;
    const id = streets.add([a, b], s.width, r, r <= 2 ? 'street' : 'lane', phase);
    streets.connected.add(id);
    out.push({ a, b, width: s.width, kind: s.kind, arch: s.arch });
    taken.push(mid(a, b));
    nNew.v++;
  };
  const quarterOfEnd = (e: End): number => {
    const at = pieceAtNear(e.p);
    return at ? at.qi : 0;
  };
  const pieceAtNear = (p: Vec2): Live | null => {
    for (const l of pIdx.query(p.x - 1, p.y - 1, p.x + 1, p.y + 1)) if (l.alive && locate(l.pc.lp.pts, p).d < 0.5) return l;
    return null;
  };

  // ---- 1. street ends: continuations first (both banks), then prolongations across; streets before lanes
  const rng = o.rng;
  const plans: { e: End; u: Vec2 }[] = [];
  for (const e of ends) {
    const rv = riverAt(e.p, 20)!;
    let n = { x: -rv.t.y, y: rv.t.x };
    if (n.x * e.d.x + n.y * e.d.y < 0) n = { x: -n.x, y: -n.y };
    const c = n.x * e.d.x + n.y * e.d.y;
    if (c < Math.cos((70 * Math.PI) / 180)) { why('e.along'); continue; } // the street runs along the bank, not to it
    // straight on when square enough, else turned square (within 25°)
    const tilt = Math.acos(Math.min(1, c));
    const sg = n.x * e.d.y - n.y * e.d.x > 0 ? 1 : -1;
    const u = tilt <= (25 * Math.PI) / 180 ? e.d : rot(n, sg * (20 * Math.PI) / 180);
    plans.push({ e, u });
  }
  const order = plans.map((pl, i) => ({ pl, i, pair: 0 }));
  // facing ends: does a deck straight across land within reach of another end?
  for (const x of order) {
    const B = cast(x.pl.e.p, x.pl.u, 34, 0.5);
    if (!B) continue;
    for (const e of endIdx.query(B.x - 9, B.y - 9, B.x + 9, B.y + 9)) if (e !== x.pl.e && e.st !== x.pl.e.st && dist(e.p, B) < 9) { x.pair = 1; break; }
  }
  order.sort((a, b) => b.pair - a.pair || streets.list[a.pl.e.st].rank - streets.list[b.pl.e.st].rank || a.i - b.i);
  for (const { pl } of order) {
    const e = pl.e;
    if (e.used) continue;
    const st = streets.list[e.st];
    const sp = st.rank <= 2 ? 45 : 55;
    const probe = cast(e.p, pl.u, 34, 0.5);
    if (!probe || !spaced(mid(e.p, probe), sp, 30)) { why('e.spaced'); continue; }
    const land = across(e.p, pl.u, e);
    if (!land || !spaced(mid(e.p, land.p), sp, 30)) continue;
    const q = quarterOfEnd(e);
    if (land.end) {
      const st2 = streets.list[land.end.st];
      land.end.used = true;
      addDeck(e.p, land.p, Math.min(st.rank, st2.rank), st.phase, q, Math.min(meanW(st.id), meanW(st2.id)), rng);
      stats.pair++;
    } else {
      const rank = o.lagoon ? 3 : Math.max(2, st.rank);
      if (land.chord) applyChord(land.chord, rank, st.phase);
      addDeck(e.p, land.p, rank, st.phase, q, meanW(st.id), rng);
      stats.extend++;
    }
    e.used = true;
  }

  // ---- 2. long stretches without a crossing: a lane cut through the bank pieces on both sides
  const GAP = 65;
  for (const rv of ctx.terrain.rivers) {
    let lastTry = -1e9, acc = 0;
    for (let i = 2; i < rv.path.length - 2; i++) {
      acc += dist(rv.path[i - 1], rv.path[i]);
      const p = rv.path[i], w = rv.width[i];
      if (w >= BIG_RIVER || p.x < W.x0 || p.x > W.x1 || p.y < W.y0 || p.y > W.y1) continue;
      if (acc - lastTry < 12) continue;
      if (!taken.every((t) => dist(t, p) >= GAP)) continue;
      lastTry = acc;
      const t = unit(rv.path[i + 2].x - rv.path[i - 2].x, rv.path[i + 2].y - rv.path[i - 2].y), n = { x: -t.y, y: t.x };
      if (!inWater(p)) continue;
      const A = cast(p, { x: -n.x, y: -n.y }, maxSpan(w), 0), B = cast(p, n, maxSpan(w), 0);
      if (!A || !B) { why('g.cast'); continue; }
      const sa = bankSide(p, A, { x: -n.x, y: -n.y });
      if (!sa) { why('g.sideA'); continue; }
      const sb = bankSide(p, B, n);
      if (!sb || (sa.chord && sb.chord && sa.chord.live === sb.chord.live)) { why('g.sideB'); continue; }
      if (!deckOk(sa.p, sb.p)) { why('g.deck'); continue; }
      const any = sa.chord ?? sb.chord;
      const ph = any ? any.live.pc.phase : 1, qi = any ? any.live.qi : 0;
      const P = any ? (any.live.pc.morph ?? ctx.params) : ctx.params;
      if (sa.chord) applyChord(sa.chord, 3, ph);
      if (sb.chord) applyChord(sb.chord, 3, ph);
      addDeck(sa.p, sb.p, 3, ph, qi, P.widthByRank[3] * P.widthScale, rng);
      stats.gap++;
    }
  }
  stats.bridges = nNew.v;
  return { bridges: out, stats };
}
