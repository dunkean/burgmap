/** Hydrology and road-junction invariants (shared by tests/hydro.test.ts and scripts/hydro_audit.ts). */
import type { Vec2, Polyline } from '../src/gen/core/geom';
import { dist, polylineLength, polygonContains } from '../src/gen/core/geom';
import { nearestOn, segHit, pointAt, tangentAt, lengths } from '../src/gen/core/pline';
import { widthOfArea, classOfWidth, scaleFor } from '../src/gen/terrain/rivernet';
import type { TerrainLayer, SiteLayer, World } from '../src/gen/types';

const DEG = 180 / Math.PI;
const angBetween = (a: Vec2, b: Vec2): number => {
  const l = Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y) || 1;
  return Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y) / l))) * DEG;
};
const vec = (a: Vec2, b: Vec2): Vec2 => ({ x: b.x - a.x, y: b.y - a.y });

export interface HydroOpts { mapSize: number; river: string; widthK: number }

export function checkRivers(t: TerrainLayer, o: HydroOpts): string[] {
  const v: string[] = [];
  const S = o.mapSize;
  const sc = scaleFor(Math.max(0.6, Math.min(6, Math.pow(S / 2400, 0.55))));
  const byId = new Map(t.rivers.map((r) => [r.id!, r]));
  const onEdge = (p: Vec2, tol = 1.5): boolean => p.x < tol || p.y < tol || p.x > S - tol || p.y > S - tol;
  const feeds = (r: typeof t.rivers[number], guard = 0): boolean => r.edgeFed === true || (guard < 20 && t.rivers.some((q) => q.host === r.id && feeds(q, guard + 1)));
  const main = t.rivers.find((r) => r.main);
  if (o.river !== 'none' && !main) v.push('main river missing');
  for (const r of t.rivers) {
    const tag = `river#${r.id}`;
    const n = r.path.length;
    if (n < 2 || r.width.length !== n || (r.area?.length ?? n) !== n) { v.push(`${tag}: array sizes`); continue; }
    // monotone width
    for (let i = 1; i < n; i++) if (r.width[i] + 1e-6 < r.width[i - 1]) { v.push(`${tag}: width not monotone at ${i} (${r.width[i - 1].toFixed(2)} -> ${r.width[i].toFixed(2)})`); break; }
    // width vs contributing area, class vs width, class vs feed
    for (let i = 0; i < n; i++) {
      const f = widthOfArea(r.area![i]);
      if (r.width[i] > f * 1.0001 + 1e-6) { v.push(`${tag}: width ${r.width[i].toFixed(2)} > f(area) ${f.toFixed(2)} at ${i}`); break; }
    }
    if (r.cls !== classOfWidth(Math.max(...r.width) / (r.main && t.seaSide ? 1 : 1), sc) && !(r.main && t.seaSide)) v.push(`${tag}: class ${r.cls} vs width ${Math.max(...r.width).toFixed(1)}`);
    for (let i = 0; i < n; i++) {
      if (r.width[i] > sc.brook * 1.05 && !(r.ext![i] > 0)) { v.push(`${tag}: wide (${r.width[i].toFixed(1)}) without external catchment at ${i}`); break; }
    }
    if (r.cls !== 'brook' && !feeds(r)) v.push(`${tag}: class ${r.cls} does not trace to a map edge`);
    if ((r.source === 'spring' || r.source === 'lake') && r.cls !== 'brook' && !feeds(r)) v.push(`${tag}: inland source but ${r.cls}`);
    if (r.source === 'spring' && polylineLength(r.path) < 85) v.push(`${tag}: spring brook too short (${polylineLength(r.path).toFixed(0)} m)`);
    if ((r.main || r.edgeFed) && !onEdge(r.path[0], 2.5)) v.push(`${tag}: edge-fed river starts inside the map at ${r.path[0].x.toFixed(0)},${r.path[0].y.toFixed(0)}`);
    // mouth
    const last = r.path[n - 1];
    if (r.mouth === 'river') {
      const h = byId.get(r.host!);
      if (!h) { v.push(`${tag}: host ${r.host} missing`); continue; }
      const nn = nearestOn(h.path, last);
      if (nn.d > 0.8) v.push(`${tag}: end is ${nn.d.toFixed(1)} m off its host`);
      const sJ = lengths(h.path);
      const arc = sJ[nn.i] + nn.t * dist(h.path[nn.i], h.path[nn.i + 1]);
      const th = tangentAt(h.path, arc, 14);
      const Lr = polylineLength(r.path);
      const q = pointAt(r.path, Math.max(0, Lr - 16)).pt;
      const ap = vec(q, last);
      const ang = angBetween(ap, th);
      if (ang < 25 || ang > 80) v.push(`${tag}: confluence angle ${ang.toFixed(0)} deg`);
      // wider below the confluence
      const below = h.width[Math.min(h.path.length - 1, nn.i + 1 + 1)], above = h.width[Math.max(0, nn.i - 1)];
      if (below + 1e-6 < above) v.push(`${tag}: host narrower below the confluence`);
      if (r.width[n - 1] > h.width[Math.min(h.path.length - 1, nn.i + 1)] * 1.02 + 0.05) v.push(`${tag}: wider than its host at the confluence`);
    } else if (r.mouth === 'edge') {
      if (!onEdge(last, 2.5)) v.push(`${tag}: ends nowhere at ${last.x.toFixed(0)},${last.y.toFixed(0)}`);
    } else if (r.mouth === 'sea' || r.mouth === 'lake') {
      const polys = r.mouth === 'sea' ? t.coastline : t.lakes;
      let ok = false;
      for (const pg of polys) {
        if (polygonContains(pg, last)) { ok = true; break; }
        for (let i = 0; i < pg.length; i++) if (nearestOn([pg[i], pg[(i + 1) % pg.length]], last).d < 6) { ok = true; break; }
        if (ok) break;
      }
      if (!ok && !onEdge(last, 6)) v.push(`${tag}: mouth (${r.mouth}) not at the water`);
    }
  }
  // crossings and parallel runs
  for (let a = 0; a < t.rivers.length; a++) {
    for (let b = a + 1; b < t.rivers.length; b++) {
      const A = t.rivers[a], B = t.rivers[b];
      const aHostB = A.host === B.id, bHostA = B.host === A.id;
      let cross = false;
      for (let i = 0; i + 1 < A.path.length && !cross; i++) {
        if (aHostB && i + 2 >= A.path.length) continue;
        for (let j = 0; j + 1 < B.path.length; j++) {
          if (bHostA && j + 2 >= B.path.length) continue;
          const h = segHit(A.path[i], A.path[i + 1], B.path[j], B.path[j + 1]);
          if (h) {
            // tolerate a touch at the shared end
            const p = { x: A.path[i].x + (A.path[i + 1].x - A.path[i].x) * h.t, y: A.path[i].y + (A.path[i + 1].y - A.path[i].y) * h.t };
            if ((aHostB && dist(p, A.path[A.path.length - 1]) < 2) || (bHostA && dist(p, B.path[B.path.length - 1]) < 2)) continue;
            cross = true; break;
          }
        }
      }
      if (cross) v.push(`river#${A.id} crosses river#${B.id}`);
      // near-touching parallel runs away from their junction
      const jn = aHostB ? A.path[A.path.length - 1] : bHostA ? B.path[B.path.length - 1] : null;
      let run = 0, worst = 0;
      const LA = polylineLength(A.path);
      for (let s = 0; s <= LA; s += 6) {
        const p = pointAt(A.path, s).pt;
        const d = nearestOn(B.path, p).d;
        const need = (A.width[Math.min(A.width.length - 1, Math.round((s / LA) * (A.width.length - 1)))] + B.width[0]) / 2 + 3;
        const nearJ = jn ? dist(p, jn) < 80 : false;
        if (d < need && !nearJ) { run++; worst = Math.max(worst, run); } else run = 0;
      }
      if (worst >= 4) v.push(`river#${A.id} runs parallel and touching river#${B.id} (${worst * 6} m)`);
    }
  }
  // lakes: exactly one outlet
  t.lakes.forEach((pg, li) => {
    let outs = 0;
    for (const r of t.rivers) {
      if (r.source !== 'lake') continue;
      const p = r.path[0];
      let d = polygonContains(pg, p) ? 0 : Infinity;
      for (let i = 0; i < pg.length && d > 0; i++) d = Math.min(d, nearestOn([pg[i], pg[(i + 1) % pg.length]], p).d);
      if (d < 8) outs++;
    }
    if (outs !== 1) v.push(`lake ${li}: ${outs} outlets`);
  });
  return v;
}

export function checkRoads(t: TerrainLayer, site: SiteLayer, roads: NonNullable<World['roads']>, bridges: NonNullable<World['bridges']>, mapSize: number): string[] {
  const v: string[] = [];
  const n = t.height.w, cell = t.height.cell;
  const wet = (p: Vec2): number => t.water[Math.min(n - 1, Math.max(0, Math.floor(p.y / cell))) * n + Math.min(n - 1, Math.max(0, Math.floor(p.x / cell)))];
  const nearVertex = (pl: Polyline, p: Vec2): { i: number; d: number } => {
    let bi = 0, bd = Infinity;
    pl.forEach((q, i) => { const d = dist(q, p); if (d < bd) { bd = d; bi = i; } });
    return { i: bi, d: bd };
  };
  const onEdge = (p: Vec2): boolean => p.x < 1.5 || p.y < 1.5 || p.x > mapSize - 1.5 || p.y > mapSize - 1.5;
  // junction bookkeeping: for each road end, where does it attach?
  interface Junc { at: Vec2; a: number; b: number }
  const juncs: Junc[] = [];
  roads.forEach((r, a) => {
    const L = polylineLength(r.path);
    if (L < 50) v.push(`road#${a}: stub of ${L.toFixed(0)} m`);
    for (const end of [0, r.path.length - 1]) {
      const p = r.path[end];
      if (onEdge(p) || dist(p, site.center) < 14) continue;
      let ok = false;
      roads.forEach((h, b) => {
        if (b === a || ok) return;
        const nn = nearestOn(h.path, p);
        if (nn.d > 0.6) return;
        ok = true;
        const vv = nearVertex(h.path, p);
        if (vv.d > 0.6) { v.push(`road#${a}: junction on road#${b} is not at a shared vertex (${vv.d.toFixed(1)} m)`); return; }
        juncs.push({ at: p, a, b });
        // angles at the junction
        const dirOut = (pl: Polyline, i: number, sgn: number): Vec2 | null => {
          let acc = 0; let k = i;
          while (k + sgn >= 0 && k + sgn < pl.length) {
            acc += dist(pl[k], pl[k + sgn]); k += sgn;
            if (acc >= 12) return vec(p, pl[k]);
          }
          return k !== i ? vec(p, pl[k]) : null;
        };
        const mine = end === 0 ? dirOut(r.path, 0, 1) : dirOut(r.path, r.path.length - 1, -1);
        const h1 = dirOut(h.path, vv.i, 1), h2 = dirOut(h.path, vv.i, -1);
        for (const hv of [h1, h2]) if (mine && hv) { const an = angBetween(mine, hv); if (an < 25) v.push(`road#${a}/road#${b}: junction angle ${an.toFixed(0)} deg at ${p.x.toFixed(0)},${p.y.toFixed(0)}`); }
      });
      if (!ok) v.push(`road#${a}: dangling end at ${p.x.toFixed(0)},${p.y.toFixed(0)}`);
    }
  });
  // degree
  const deg = new Map<string, number>();
  for (const j of juncs) { const k = `${Math.round(j.at.x / 3)},${Math.round(j.at.y / 3)}`; deg.set(k, (deg.get(k) ?? 0) + 1); }
  deg.forEach((c, k) => { if (c + 2 > 4) v.push(`junction ${k}: degree ${c + 2}`); });
  // duplicates: samples closer than 6 m to another road away from shared junctions
  for (let a = 0; a < roads.length; a++) {
    const A = roads[a].path, LA = polylineLength(A);
    for (let b = 0; b < roads.length; b++) {
      if (b === a) continue;
      const B = roads[b].path;
      const tie = juncs.filter((j) => (j.a === a && j.b === b) || (j.a === b && j.b === a)).map((j) => j.at);
      // ends at a shared junction with any third road also count as exempt
      const ends = [A[0], A[A.length - 1], B[0], B[B.length - 1]];
      let run = 0, worst = 0;
      for (let s = 0; s <= LA; s += 3) {
        const p = pointAt(A, s).pt;
        const d = nearestOn(B, p).d;
        const exempt = tie.some((q) => dist(p, q) < 40) || ends.some((q) => dist(p, q) < 40 && nearestOn(B, q).d < 1) ;
        if (d < 6 && !exempt) { run++; worst = Math.max(worst, run); } else run = 0;
      }
      if (worst >= 3 && a < b) v.push(`road#${a} doubles road#${b} for ${worst * 3} m`);
    }
  }
  // bridges
  const rivers = t.rivers;
  bridges.forEach((br, k) => {
    const mid = { x: (br.a.x + br.b.x) / 2, y: (br.a.y + br.b.y) / 2 };
    let best = Infinity, bi = 0;
    rivers.forEach((r, i) => { const d = nearestOn(r.path, mid).d; if (d < best) { best = d; bi = i; } });
    const r = rivers[bi];
    if (!r) { v.push(`bridge#${k}: no river`); return; }
    const nn = nearestOn(r.path, mid);
    const s = lengths(r.path);
    const th = tangentAt(r.path, s[nn.i] + nn.t * dist(r.path[nn.i], r.path[nn.i + 1]), 10);
    const bd = vec(br.a, br.b);
    let an = angBetween(bd, th); if (an > 90) an = 180 - an;
    if (Math.abs(an - 90) > 40) v.push(`bridge#${k}: ${an.toFixed(0)} deg to the river (want 65..90)`);
    if (wet(br.a) !== 0 || wet(br.b) !== 0) v.push(`bridge#${k}: approach not on dry land`);
    // aligned with the road on both sides
    let found = false;
    for (const rd of roads) {
      const ia = nearVertex(rd.path, br.a), ib = nearVertex(rd.path, br.b);
      if (ia.d > 0.6 || ib.d > 0.6) continue;
      found = true;
      const lo = Math.min(ia.i, ib.i), hi = Math.max(ia.i, ib.i);
      const pa = rd.path[lo], pb = rd.path[hi];
      const back = (from: number, sgn: number): Vec2 | null => { let acc = 0, kk = from; const p0 = rd.path[from]; while (kk + sgn >= 0 && kk + sgn < rd.path.length) { acc += dist(rd.path[kk], rd.path[kk + sgn]); kk += sgn; if (acc >= 14) return vec(p0, rd.path[kk]); } return null; };
      const bv = vec(pa, pb);
      const b1 = back(lo, -1), b2 = back(hi, 1);
      if (b1 && angBetween({ x: -b1.x, y: -b1.y }, bv) > 40) v.push(`bridge#${k}: road not aligned on side A (${angBetween({ x: -b1.x, y: -b1.y }, bv).toFixed(0)} deg)`);
      if (b2 && angBetween(b2, bv) > 40) v.push(`bridge#${k}: road not aligned on side B (${angBetween(b2, bv).toFixed(0)} deg)`);
      break;
    }
    if (!found) v.push(`bridge#${k}: ends are not road vertices`);
  });
  // roads inside river ribbons (other than on a bridge or a brook ford) and on the bank
  roads.forEach((rd, a) => {
    const L = polylineLength(rd.path);
    let bad = 0, bank = 0, at = '';
    for (let s = 0; s <= L; s += 3) {
      const p = pointAt(rd.path, s).pt;
      if (bridges.some((b) => nearestOn([b.a, b.b], p).d < 3)) continue;
      for (const r of rivers) {
        const nn = nearestOn(r.path, p);
        if (nn.d > 80) continue;
        const i = Math.min(r.path.length - 1, nn.i);
        const w = Math.max(r.width[i], r.width[Math.min(r.path.length - 1, nn.i + 1)]);
        if (nn.d < w / 2) { if (!(w < 3.7)) { bad++; at = `${p.x.toFixed(0)},${p.y.toFixed(0)} river#${r.id} w${w.toFixed(1)}`; } }
        else if (nn.d < w / 2 + 1.2 && !(r.cls === 'brook')) bank++;
      }
    }
    if (bad > 2) v.push(`road#${a}: ${bad} samples inside river ribbons outside bridges/fords (${at})`);
    if (bank > 3) v.push(`road#${a}: ${bank} samples on the river bank`);
  });
  return v;
}
