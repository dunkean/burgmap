/**
 * Town bridges (coordinator request, M4): a river crossing a town gets a bridge every 250–500 m of its course
 * inside the enclosure (closer in the core), each perpendicular to the river, landing on dry ground on both banks
 * and joined to the street network on both sides (so the banks are linked in the street graph). In a large city
 * the bridge nearest the nucleus carries houses (Ponte Vecchio, Pont Notre-Dame): two rows of house lots over the
 * water on either side of the deck.
 */
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import { dist } from '../../core/geom';
import type { ReserveApi, ReservedLot } from '../primary';
import { rectAt, inMP, findConnectorX, segPolyDist, LineIndex } from './lots';
import { phaseAt, type M4State } from './reserve';

export const BR_DBG: Record<string, number> = {};
const why = (k: string) => { BR_DBG[k] = (BR_DBG[k] ?? 0) + 1; };
export interface BridgeOut { a: Vec2; b: Vec2; width: number }
export interface BridgeHousesData { kind: 'bridge-houses'; ang: number; side: number }

/** Plans the bridges; registers their streets; returns the bridge decks and the inhabited-bridge lots. */
export function reserveBridges(s: M4State, api: ReserveApi, avoid: Polygon[], existing: { a: Vec2; b: Vec2 }[]): { lots: ReservedLot[]; cuts: Polyline[]; bridges: BridgeOut[] } {
  const ctx = s.ctx;
  const out: { lots: ReservedLot[]; cuts: Polyline[]; bridges: BridgeOut[] } = { lots: [], cuts: [], bridges: [] };
  const core = api.phases[0].region;
  const enc = api.enclosure;
  // crossings that already exist: road bridges and streets running over the water
  const known: Vec2[] = existing.map((b) => ({ x: (b.a.x + b.b.x) / 2, y: (b.a.y + b.b.y) / 2 }));
  for (const st of api.streets.list) if (st.ribbon) for (let i = 1; i < st.path.length; i++) {
    const m = { x: (st.path[i - 1].x + st.path[i].x) / 2, y: (st.path[i - 1].y + st.path[i].y) / 2 };
    if (ctx.isWater(m)) known.push(m);
  }
  const avoidIdx = new LineIndex(avoid.map((p) => ({ path: p.concat([p[0]]), hw: 0 })));
  const w0 = s.P.widthByRank[2] * s.P.widthScale;
  let inhabited = s.pop < 18000;
  for (const rv of ctx.terrain.rivers) {
    // walk the course inside the enclosure
    const pts = rv.path;
    let acc = 0, lastAt = -1e9;
    for (let i = 1; i < pts.length - 1; i++) {
      acc += dist(pts[i - 1], pts[i]);
      const p = pts[i], w = rv.width[i];
      if (w < 5) continue;
      // the river runs between two banks of the town (the centre line itself is water, outside the enclosure)
      {
        const a1 = pts[Math.max(0, i - 1)], b1 = pts[Math.min(pts.length - 1, i + 1)], l1 = dist(a1, b1) || 1;
        const nx = -(b1.y - a1.y) / l1, ny = (b1.x - a1.x) / l1, off = w / 2 + 18;
        if (!inMP(enc, { x: p.x + nx * off, y: p.y + ny * off }) || !inMP(enc, { x: p.x - nx * off, y: p.y - ny * off })) { why('banks-out'); continue; }
      }
      const spacing = inMP(core, p) ? 240 : 380;
      if (acc - lastAt < spacing * 0.5) continue;
      if (known.some((q) => dist(q, p) < spacing * 0.75)) { why('known'); continue; }
      // perpendicular to the local course
      const a0 = pts[Math.max(0, i - 2)], b0 = pts[Math.min(pts.length - 1, i + 2)];
      const L = dist(a0, b0) || 1;
      const t = { x: (b0.x - a0.x) / L, y: (b0.y - a0.y) / L }, n = { x: -t.y, y: t.x };
      // banks: the first dry ground on either side
      const bank = (sg: number): Vec2 | null => {
        let dry = 0;
        for (let d = 1; d < 4 * w + 40; d += 1) {
          const q = { x: p.x + n.x * sg * d, y: p.y + n.y * sg * d };
          if (!ctx.isWater(q)) { if (++dry >= 3) return { x: q.x + n.x * sg * 3, y: q.y + n.y * sg * 3 }; } else dry = 0;
        }
        return null;
      };
      const A = bank(-1), B = bank(1);
      if (!A || !B || dist(A, B) > 6 * w + 60 || !inMP(enc, A) || !inMP(enc, B)) { why('land'); continue; }
      if (avoidIdx.dist(A, 25) < 20 || avoidIdx.dist(B, 25) < 20) { why('avoid'); continue; }
      // join both landings to the network (away from the river)
      // each landing joins the network: straight on, or after a short perpendicular approach street
      const join = (P0: Vec2, d: Vec2): { path: Polyline; met: number[] } | null => {
        const opts = { avoid, maxLen: 300, dirs: [d], noCross: enc.map((ph) => ph.outer), gates: api.gates };
        const r0 = findConnectorX(ctx, api.streets, P0, opts);
        if (r0) return r0;
        for (const k of [25, 45, 70]) {
          const P1 = { x: P0.x + d.x * k, y: P0.y + d.y * k };
          let wet = false;
          for (let t2 = 2; t2 <= k; t2 += 3) if (ctx.isWater({ x: P0.x + d.x * t2, y: P0.y + d.y * t2 })) wet = true;
          if (wet || !inMP(enc, P1)) break;
          const r1 = findConnectorX(ctx, api.streets, P1, { ...opts, dirs: [] });
          if (r1) return { path: [P0, ...r1.path], met: r1.met };
        }
        return null;
      };
      const ca = join(A, { x: -n.x, y: -n.y }), cb = join(B, n);
      if (!ca || !cb) { why(!ca && !cb ? 'conn2' : 'conn1'); continue; }
      const path: Polyline = [...ca.path.slice().reverse(), ...cb.path];
      if (avoid.some((o) => segPolyDist(A, B, o) < 4)) continue;
      const id = api.streets.add(path, w0, 2, 'street', 1);
      api.streets.connected.add(id);
      for (const m of [...ca.met, ...cb.met]) api.streets.connected.add(m);
      out.cuts.push(path);
      // the deck from bank to bank
      out.bridges.push({ a: A, b: B, width: w0 + (inhabited ? 0 : 1) });
      known.push(p);
      lastAt = acc;
      // an inhabited bridge in a large city: rows of houses either side of the deck, over the water
      if (!inhabited) {
        const ang = Math.atan2(B.y - A.y, B.x - A.x), c = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
        const half = dist(A, B) / 2 - 6;
        if (half > 8) {
          for (const sg of [1, -1]) {
            const poly = rectAt(c, ang, -half, half, sg > 0 ? w0 / 2 + 0.3 : -(w0 / 2 + 7.8), sg > 0 ? w0 / 2 + 7.8 : -(w0 / 2 + 0.3));
            const idl = `bridge-houses:${out.lots.length}`;
            s.lotData.set(idl, { kind: 'bridge-houses', ang, side: sg } as BridgeHousesData);
            const ph = phaseAt(api, c);
            out.lots.push({ id: idl, kind: 'm4-bridge-houses', poly, phase: ph.phase, zone: ph.zone, cuts: [], piece: 'place' });
          }
          s.sites.push({ id: 'inhabited-bridge', kind: 'inhabited-bridge', role: 'civic', lot: rectAt(c, ang, -half, half, -(w0 / 2 + 8), w0 / 2 + 8), entrance: A, anchor: c, culture: s.culture });
          inhabited = true;
        }
      }
    }
  }
  return out;
}

/** Houses on an inhabited bridge: a row of narrow deep houses on each side of the deck. */
export function bridgeHouses(poly: Polygon, d: BridgeHousesData): { poly: Polygon; arch: string }[] {
  const out: { poly: Polygon; arch: string }[] = [];
  const cx = poly.reduce((t, q) => t + q.x, 0) / poly.length, cy = poly.reduce((t, q) => t + q.y, 0) / poly.length;
  const ca = Math.cos(d.ang), sa = Math.sin(d.ang);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const q of poly) { const u = (q.x - cx) * ca + (q.y - cy) * sa, v = -(q.x - cx) * sa + (q.y - cy) * ca; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  const W = 5.6, n = Math.floor((u1 - u0 - 1) / W);
  for (let k = 0; k < n; k++) {
    const a = u0 + 0.5 + k * W;
    out.push({ poly: rectAt({ x: cx, y: cy }, d.ang, a + 0.05, a + W - 0.05, v0 + 0.2, v1 - 0.2), arch: 'bridge-house' });
  }
  return out;
}
