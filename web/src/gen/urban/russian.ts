/**
 * Russian town (Moscow, Novgorod, Pskov, Rostov): the kremlin (a brick or timber fortress, triangular on the
 * river confluence, its cathedral square of domed churches, the bell tower, the palace) with the market square
 * (torg, later Red Square) outside its gate, the posad (the trade town) of log houses in large fenced yards behind a
 * timber wall on an earthen rampart, the slobodas along the roads, and many small domed parish churches.
 */
import type { Vec2, Polygon } from '../core/geom';
import { dist } from '../core/geom';
import type { CompoundCtx, CompoundOut } from './compounds';
import { registerBuilders } from './compounds';
import { area, orientPos, pointInRing, inscribed } from '../geo/poly';
import { unionS } from '../geo/bool';
import { disk } from '../geo/offset';
import { fits } from './m4/kit';
import { rectAt } from './m4/lots';

/**
 * Footprint of a cross-in-square church oriented east: the naos (square), one or three apses on the east, the
 * narthex (and a tented bell tower for a parish church) on the west; the domes drawn as circles over the naos.
 */
export function orthodoxChurch(c: Vec2, s: number, cathedral: boolean): { parts: Polygon[]; domes: Polygon[] } {
  const naos = rectAt(c, 0, -s / 2, s / 2, -s / 2, s / 2);
  const parts: Polygon[] = [naos];
  const apse = (y: number, r: number): Polygon => orientPos([...Array.from({ length: 9 }, (_, i) => { const t = -Math.PI / 2 + (i / 8) * Math.PI; return { x: c.x + s / 2 - 0.2 + Math.cos(t) * r, y: c.y + y + Math.sin(t) * r }; })]);
  if (cathedral) for (const y of [-s * 0.3, 0, s * 0.3]) parts.push(apse(y, s * (y ? 0.12 : 0.17)));
  else parts.push(apse(0, s * 0.22));
  parts.push(rectAt({ x: c.x - s / 2 - s * 0.17, y: c.y }, 0, -s * 0.17, s * 0.17 + 0.2, -s * 0.36, s * 0.36));
  if (!cathedral) parts.push(rectAt({ x: c.x - s / 2 - s * 0.34 - s * 0.14, y: c.y }, 0, -s * 0.14, s * 0.14 + 0.2, -s * 0.14, s * 0.14));
  const domes: Polygon[] = [orientPos(disk(c, s * (cathedral ? 0.17 : 0.2), 14))];
  if (cathedral) for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) domes.push(orientPos(disk({ x: c.x + dx * s * 0.27, y: c.y + dy * s * 0.27 }, s * 0.1, 12)));
  const u = unionS([{ outer: parts[0], holes: [] }], ...parts.slice(1).map((p) => [{ outer: p, holes: [] }]));
  return { parts: u.map((ph) => ph.outer), domes };
}

/** A parish church in its lot: the church on the street side, its graveyard round it. */
function parishChurch(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'church' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const ins = inscribed(P, [], 0.5);
  for (let s = Math.min(16, ins.r * 0.75); s >= 6; s *= 0.85) {
    const ch = orthodoxChurch(ins.c, s, false);
    if (ch.parts.every((p) => fits(P, p, 1.2))) {
      for (const p of ch.parts) out.buildings.push({ poly: p, kind: 'landmark', parcel: 0, arch: 'orthodox-church', roof: 'dome', material: cx.pop > 8000 ? 'brick' : 'wood', storeys: 1 });
      for (const d of ch.domes) out.lines.push({ kind: 'dome', path: d.concat([d[0]]), width: 0.5 });
      out.landmarks.push({ kind: 'orthodox-church', poly: ch.parts[0] });
      break;
    }
  }
  return out;
}

/** Inside the kremlin: the cathedral square (two or three cathedrals, the bell tower), the palace, boyar yards. */
export function kremlinInterior(Cin: Polygon, out: CompoundOut, parcel: number, gate: Vec2, rng: CompoundCtx['rng']): void {
  const P = orientPos(Cin);
  const ins = inscribed(P, [], 1);
  const placed: Polygon[] = out.buildings.map((b) => b.poly);
  const clear = (q: Polygon) => !placed.some((o) => o.some((x) => pointInRing(q, x)) || q.some((x) => pointInRing(o, x)));
  const add = (poly: Polygon, arch: string, roof: CompoundOut['buildings'][number]['roof'], storeys: number) => { placed.push(poly); out.buildings.push({ poly, kind: 'landmark', parcel, arch, roof, material: 'brick', storeys }); };
  // the cathedral square at the inscribed centre: cathedrals on its north, east and south sides
  const s0 = Math.max(10, Math.min(26, ins.r * 0.2));
  const sqH = s0 * 1.6;
  const spots: Vec2[] = [{ x: ins.c.x, y: ins.c.y - sqH }, { x: ins.c.x + sqH * 1.1, y: ins.c.y + s0 * 0.2 }, { x: ins.c.x, y: ins.c.y + sqH }];
  let n = 0;
  for (const sp of spots) {
    for (let s = s0 * (n === 0 ? 1.15 : 1); s >= 7; s *= 0.85) {
      const ch = orthodoxChurch(sp, s, true);
      if (ch.parts.every((p) => fits(P, p, 2) && clear(p))) {
        for (const p of ch.parts) add(p, 'cathedral', 'dome', 2);
        for (const d of ch.domes) out.lines.push({ kind: 'dome', path: d.concat([d[0]]), width: 0.6 });
        out.landmarks.push({ kind: 'kremlin-cathedral', poly: ch.parts[0] });
        n++;
        break;
      }
    }
  }
  // the bell tower (Ivan the Great): a round tower on the square
  const bt = orientPos(disk({ x: ins.c.x + s0 * 0.4, y: ins.c.y - s0 * 0.2 }, Math.max(3.5, s0 * 0.3), 14));
  if (fits(P, bt, 2) && clear(bt)) add(bt, 'bell-tower', 'dome', 6);
  out.landmarks.push({ kind: 'cathedral-square', poly: rectAt(ins.c, 0, -sqH * 0.6, sqH * 0.6, -sqH * 0.6, sqH * 0.6) });
  // the palace (terem) and the boyar yards along the curtains away from the gate
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    const L = dist(a, b);
    if (L < 40) continue;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (dist(m, gate) < L * 0.3) continue;
    const t = { x: (b.x - a.x) / L, y: (b.y - a.y) / L }, nn = { x: -t.y, y: t.x };
    const ang = Math.atan2(t.y, t.x);
    const k = Math.max(1, Math.floor(L / 34));
    for (let j = 0; j < k; j++) {
      const sAt = (j + 0.5) / k;
      const w = rng.range(14, 24), d = rng.range(9, 13);
      const cc = { x: a.x + t.x * L * sAt + nn.x * (d / 2 + 4), y: a.y + t.y * L * sAt + nn.y * (d / 2 + 4) };
      const r = rectAt(cc, ang, -w / 2, w / 2, -d / 2, d / 2);
      if (fits(P, r, 1.5) && clear(r)) add(r, j === 0 && i === 0 ? 'terem-palace' : 'boyar-house', 'hip', 2);
    }
  }
  void area;
}

let registered = false;
export function registerRussian(): void {
  if (registered) return;
  registered = true;
  registerBuilders({ 'orthodox-church': parishChurch });
}
