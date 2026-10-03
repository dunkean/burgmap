/**
 * Maya city (Tikal, Copán; Mayapán's walled houselots): a ceremonial core of paved plazas on a common axis (about 15°
 * east of north) — the Great Plaza between its two facing temple-pyramids, the North Acropolis crowded with temples,
 * the palace courts of the Central Acropolis, the ballcourt, stelae rows — raised white causeways (sacbeob) out to
 * outlying temple groups (twin-pyramid complexes in a city), reservoirs (aguadas) by the core; round it a garden city
 * of houselots (solares): each a patio group of two to four apsidal houses on low platforms round their patio, the
 * kitchen, the house garden and fruit trees, inside its dry-stone wall (albarrada), the lots thinning out into the
 * milpa with distance. Footpaths link the houselots to the causeways.
 *
 * Scale: a hamlet is a few houselots round a shrine platform; a village a small temple plaza; a town a minor centre
 * (two or three plazas, an acropolis, a ballcourt, causeways to outlying groups); a city the full Tikal plan.
 *
 * Partition: every plaza is a quarter with one block and one parcel (use 'plaza' or a compound); every houselot is a
 * quarter of its own (a Voronoi cell of the houselot seeds bounded to its plot size), its block the cell less its
 * frontage path (a lane along one side of the cell: a half-plane clip, no boolean), one plot.
 */
import { Delaunay } from 'd3-delaunay';
import type { Vec2, Polygon } from '../../core/geom';
import { dist } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { UrbanStreet } from '../../types';
import { area, orientPos, pointInRing, inscribed, bboxOf } from '../../geo/poly';
import { clipHalfPlaneConvex } from '../../geo/split';
import { intersectionS, mpArea } from '../../geo/bool';
import type { CampCtx } from './index';
import { CampOut, emptyCamp, street, rect, fitIn, hut, at, openRing } from './kit';
import { roundedRect } from './farms';

type Out = CampOut & { disjoint?: boolean };

/** A Maya temple-pyramid: stepped terraces, the stair on the front face, the temple and its roof comb on the top. */
function mayaPyramid(out: Out, pi: number, c: Vec2, ang: number, half: number, face: number, arch: string, levels = 4): Polygon {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const P = (u: number, v: number): Vec2 => ({ x: c.x + u * ca - v * sa, y: c.y + u * sa + v * ca });
  // the face direction in local coordinates (one of ±u, ±v)
  const fu = Math.round(Math.cos(face - ang)), fv = Math.round(Math.sin(face - ang));
  const h = half, sw = h * 0.36, sl = h * 0.22;
  // the base square with the stair projecting on the front
  const sq: [number, number][] = [[-h, -h], [h, -h], [h, h], [-h, h]];
  const pts: Vec2[] = [];
  for (let i = 0; i < 4; i++) {
    const [u0, v0] = sq[i], [u1, v1] = sq[(i + 1) % 4];
    pts.push(P(u0, v0));
    // the edge of the front face: the stair juts out of its middle
    const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2;
    if (Math.abs(mu - fu * h) < 1e-6 && Math.abs(mv - fv * h) < 1e-6) {
      const tu = (u1 - u0) / (2 * h), tv = (v1 - v0) / (2 * h);
      pts.push(P(mu - tu * sw, mv - tv * sw), P(mu - tu * sw + fu * sl, mv - tv * sw + fv * sl), P(mu + tu * sw + fu * sl, mv + tv * sw + fv * sl), P(mu + tu * sw, mv + tv * sw));
    }
  }
  const poly = orientPos(pts);
  out.buildings.push({ poly, kind: 'landmark', parcel: pi, arch, roof: 'flat', material: 'stone', storeys: levels, orientation: face });
  // terraces
  for (let k = 1; k < levels; k++) {
    const r = h * (1 - (k / levels) * 0.62);
    out.lines.push({ kind: 'pyramid-step', path: [P(-r, -r), P(r, -r), P(r, r), P(-r, r), P(-r, -r)], width: 0.4 });
  }
  // the stair: two lines from the foot of the stair to the top platform
  const top = h * (1 - ((levels - 1) / levels) * 0.62);
  for (const s of [-1, 1]) {
    const a = P(fu * (h + sl) - fv * s * sw * 0.8, fv * (h + sl) + fu * s * sw * 0.8);
    const b = P(fu * top - fv * s * sw * 0.55, fv * top + fu * s * sw * 0.55);
    out.lines.push({ kind: 'pyramid-step', path: [a, b], width: 0.45 });
  }
  // the temple on top (to the back of the summit) and its roof comb
  const tw = top * 0.75, td = top * 0.55;
  const tc = { u: -fu * top * 0.3, v: -fv * top * 0.3 };
  // (a point at `al` along the face direction and `ac` across it, from the temple's centre)
  const T = (al: number, ac: number): Vec2 => P(tc.u + fu * al - fv * ac, tc.v + fv * al + fu * ac);
  out.lines.push({ kind: 'pyramid-step', path: [T(-td, -tw), T(td, -tw), T(td, tw), T(-td, tw), T(-td, -tw)], width: 0.6 });
  out.lines.push({ kind: 'pyramid-step', path: [T(-td * 1.15, -tw * 0.75), T(-td * 1.15, tw * 0.75)], width: 1 });
  return poly;
}

/** A range structure (palace wing): a long narrow building, its rooms marked across. */
function rangeBuilding(out: Out, pi: number, c: Vec2, ang: number, L: number, W: number, arch: string): Polygon {
  const poly = rect(c, ang, L, W);
  out.buildings.push({ poly, kind: 'landmark', parcel: pi, arch, roof: 'flat', material: 'stone', storeys: 1, orientation: ang });
  const ux = Math.cos(ang), uy = Math.sin(ang), nx = -uy, ny = ux;
  const n = Math.max(2, Math.round(L / 4.2));
  for (let k = 1; k < n; k++) {
    const t = -L / 2 + (k * L) / n;
    out.lines.push({ kind: 'roof-line', path: [{ x: c.x + ux * t + nx * (W / 2 - 0.3), y: c.y + uy * t + ny * (W / 2 - 0.3) }, { x: c.x + ux * t - nx * (W / 2 - 0.3), y: c.y + uy * t - ny * (W / 2 - 0.3) }], width: 0.25 });
  }
  out.lines.push({ kind: 'roof-line', path: [{ x: c.x - ux * (L / 2 - 0.6), y: c.y - uy * (L / 2 - 0.6) }, { x: c.x + ux * (L / 2 - 0.6), y: c.y + uy * (L / 2 - 0.6) }], width: 0.2 });
  return poly;
}

interface Plaza { cu: number; cv: number; w: number; h: number; kind: 'great' | 'acropolis' | 'palace' | 'ballcourt' | 'west' | 'east' | 'lost-world' | 'group' | 'twin' | 'shrine' | 'small' }

export function mayaCity(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  const out: Out = emptyCamp();
  const ctx = cc.ctx;
  const sk = Math.sqrt(cc.sprawl);
  const tier = pop < 200 ? 0 : pop < 1200 ? 1 : pop < 15000 ? 2 : 3;
  // the axis: about 15° east of north (the plan's v axis points south)
  const ang = rng.range(-0.32, -0.18);
  const U = { x: Math.cos(ang), y: Math.sin(ang) }, V = { x: -Math.sin(ang), y: Math.cos(ang) };
  const P = (u: number, v: number): Vec2 => ({ x: c.x + U.x * u + V.x * v, y: c.y + U.y * u + V.y * v });
  const box = (cu: number, cv: number, w: number, h: number): Polygon => orientPos([P(cu - w / 2, cv - h / 2), P(cu + w / 2, cv - h / 2), P(cu + w / 2, cv + h / 2), P(cu - w / 2, cv + h / 2)]);
  const k = tier === 3 ? Math.min(1.35, 1 + (pop - 15000) / 120000) : 1;
  // ---- the core plazas
  const plazas: Plaza[] = [];
  if (tier === 0) plazas.push({ cu: 0, cv: 0, w: 30, h: 26, kind: 'shrine' });
  else if (tier === 1) {
    plazas.push({ cu: 0, cv: 0, w: 56, h: 44, kind: 'small' });
    if (pop > 600) plazas.push({ cu: 0, cv: 22 + 13, w: 40, h: 26, kind: 'ballcourt' });
  } else {
    const W0 = (tier === 3 ? 112 : 84) * k, H0 = (tier === 3 ? 82 : 64) * k;
    plazas.push({ cu: 0, cv: 0, w: W0, h: H0, kind: 'great' });
    plazas.push({ cu: -W0 * 0.05, cv: -(H0 / 2 + (tier === 3 ? 34 : 26) * k), w: W0 * 0.9, h: (tier === 3 ? 68 : 52) * k, kind: 'acropolis' });
    plazas.push({ cu: W0 * 0.22, cv: H0 / 2 + (tier === 3 ? 40 : 30) * k + 8, w: W0 * 1.15, h: (tier === 3 ? 80 : 60) * k, kind: 'palace' });
    plazas.push({ cu: -W0 * 0.32, cv: H0 / 2 + 15, w: 30, h: 30, kind: 'ballcourt' });
    plazas.push({ cu: -(W0 / 2 + 36 * k), cv: -4, w: 72 * k, h: 66 * k, kind: 'west' });
    if (tier === 3) {
      plazas.push({ cu: W0 / 2 + 58 * k, cv: -6, w: 116 * k, h: 104 * k, kind: 'east' });
      plazas.push({ cu: -(W0 / 2 + 110 * k), cv: H0 / 2 + 120 * k, w: 130 * k, h: 120 * k, kind: 'lost-world' });
    }
  }
  // ---- outlying groups along the causeways (town and city)
  const groups: { a: number; d: number; kind: 'group' | 'twin' }[] = [];
  if (tier >= 2) {
    const gr = rng.fork('groups');
    const nG = tier === 3 ? 4 + (pop > 50000 ? 1 : 0) : 2 + (pop > 5000 ? 1 : 0);
    const dryish = (p: Vec2, r: number) => [0, 1, 2, 3, 4, 5, 6, 7].every((i) => !ctx.isWater(at(p, (i / 8) * 2 * Math.PI, r))) && !ctx.isWater(p);
    const used: number[] = [];
    for (let i = 0; i < nG * 4 && groups.length < nG; i++) {
      const a = gr.range(0, 2 * Math.PI);
      if (used.some((b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 0.9)) continue;
      const d = (tier === 3 ? gr.range(420, 900) : gr.range(220, 420)) * sk;
      const p = at(c, a, d);
      if (p.x < 120 || p.y < 120 || p.x > ctx.mapSize - 120 || p.y > ctx.mapSize - 120 || !dryish(p, 60)) continue;
      // (the causeway stays on dry ground)
      let wet = false;
      for (let t = 0.1; t < 1; t += 0.05) if (ctx.isWater(at(c, a, d * t))) wet = true;
      if (wet) continue;
      used.push(a);
      groups.push({ a, d, kind: tier === 3 && groups.length % 2 === 0 ? 'twin' : 'group' });
    }
  }
  // the plazas of the outlying groups, in plan coordinates
  for (const g of groups) {
    const p = at(c, g.a, g.d);
    const du = (p.x - c.x) * U.x + (p.y - c.y) * U.y, dv = (p.x - c.x) * V.x + (p.y - c.y) * V.y;
    plazas.push(g.kind === 'twin' ? { cu: du, cv: dv, w: 92, h: 92, kind: 'twin' } : { cu: du, cv: dv, w: 64, h: 52, kind: 'group' });
  }
  // ---- plaza quarters, blocks, parcels and their buildings
  const pr = rng.fork('plazas');
  const plazaPolys: Polygon[] = [];
  for (const pz of plazas) {
    const poly = box(pz.cu, pz.cv, pz.w - 4, pz.h - 4);
    if (poly.some((q) => ctx.isWater(q)) || plazaPolys.some((o) => mpArea(intersectionS(o, poly)) > 1)) continue;
    plazaPolys.push(poly);
    const qi = out.quarters.length;
    out.quarters.push(poly); out.outline.push(poly);
    const bi = out.blocks.length;
    const compound = pz.kind === 'acropolis' ? 'acropolis' : pz.kind === 'palace' ? 'royal-palace' : pz.kind === 'ballcourt' ? 'ballcourt' : undefined;
    out.blocks.push({ poly, kind: compound ? 'compound' : 'block', compound, quarter: qi });
    const pi = out.parcels.length;
    out.parcels.push({ poly, use: compound ? 'compound:' + compound : 'plaza', block: bi });
    const L = (du: number, dv: number) => P(pz.cu + du, pz.cv + dv);
    const W = pz.w, H = pz.h;
    if (pz.kind === 'great') {
      // Temple I on the east side facing west, Temple II on the west side facing east; stelae along the north side
      const h1 = Math.min(H * 0.24, 22 * k);
      mayaPyramid(out, pi, L(W / 2 - h1 - 4, 0), ang, h1, ang + Math.PI, 'great-pyramid', 6);
      mayaPyramid(out, pi, L(-W / 2 + h1 * 0.85 + 4, 0), ang, h1 * 0.85, ang, 'temple-pyramid', 5);
      for (let i = 0; i < 9; i++) out.lines.push({ kind: 'stela', path: [L(-W * 0.3 + i * W * 0.075, -H / 2 + 5), L(-W * 0.3 + i * W * 0.075 + 1.1, -H / 2 + 5)], width: 1.1 });
      out.squares.push(poly);
      out.landmarks.push({ kind: 'great-plaza', poly });
      out.sites.push({ id: 'great-plaza', kind: 'great-plaza', role: 'worship', lot: poly, anchor: P(pz.cu, pz.cv) });
    } else if (pz.kind === 'acropolis') {
      // the raised acropolis: its terrace edge, a row of temples on it facing the plaza, smaller ones behind
      out.lines.push({ kind: 'platform', path: [...box(pz.cu, pz.cv, W - 4, H - 4), box(pz.cu, pz.cv, W - 4, H - 4)[0]], width: 0.8 });
      const n = Math.max(3, Math.round(W / 22));
      for (let i = 0; i < n; i++) mayaPyramid(out, pi, L(-W / 2 + (i + 0.5) * (W / n), H * 0.12), ang, Math.min(W / n * 0.36, 9 * k), ang + Math.PI / 2, 'temple-pyramid', 4);
      for (let i = 0; i < n - 1; i++) mayaPyramid(out, pi, L(-W / 2 + (i + 1) * (W / n), -H * 0.28), ang, Math.min(W / n * 0.26, 6.5 * k), ang + Math.PI / 2, 'temple-pyramid', 3);
      out.landmarks.push({ kind: 'acropolis', poly });
    } else if (pz.kind === 'palace') {
      // courts surrounded by range buildings (multi-room palaces)
      out.lines.push({ kind: 'platform', path: [...box(pz.cu, pz.cv, W - 3, H - 3), box(pz.cu, pz.cv, W - 3, H - 3)[0]], width: 0.8 });
      const nc = W > 110 ? 3 : 2;
      for (let i = 0; i < nc; i++) {
        const cu = -W / 2 + (i + 0.5) * (W / nc), cw = W / nc - 6, ch = H - 10;
        const d = 5.2;
        rangeBuilding(out, pi, L(cu, -ch / 2 + d / 2), ang, cw - 2, d, 'palace-range');
        rangeBuilding(out, pi, L(cu, ch / 2 - d / 2), ang, cw - 2 - (i % 2 ? 8 : 0), d, 'palace-range');
        rangeBuilding(out, pi, L(cu - cw / 2 + d / 2, 0), ang + Math.PI / 2, ch - 2 * d - 3, d, 'palace-range');
        if (i === nc - 1) rangeBuilding(out, pi, L(cu + cw / 2 - d / 2, 0), ang + Math.PI / 2, ch - 2 * d - 3, d, 'palace-range');
      }
      out.sites.push({ id: 'palace', kind: 'royal-palace', role: 'power', lot: poly, anchor: P(pz.cu, pz.cv) });
    } else if (pz.kind === 'ballcourt') {
      // the I-shaped court: two parallel mounds with their sloping benches, the end zones
      const lw2 = Math.min(W, H) * 0.42, len = Math.max(W, H) * 0.7;
      const along = H > W ? ang + Math.PI / 2 : ang;
      const ux = Math.cos(along), uy = Math.sin(along), nx = -uy, ny = ux;
      const cc0 = P(pz.cu, pz.cv);
      for (const s of [-1, 1]) {
        const mc = { x: cc0.x + nx * s * (lw2 * 0.55), y: cc0.y + ny * s * (lw2 * 0.55) };
        const m = rect(mc, along, len * 0.62, lw2 * 0.5);
        out.buildings.push({ poly: m, kind: 'landmark', parcel: pi, arch: 'ballcourt-range', roof: 'flat', material: 'stone', storeys: 1 });
        out.lines.push({ kind: 'pyramid-step', path: [{ x: mc.x - ux * len * 0.29 - nx * s * lw2 * 0.12, y: mc.y - uy * len * 0.29 - ny * s * lw2 * 0.12 }, { x: mc.x + ux * len * 0.29 - nx * s * lw2 * 0.12, y: mc.y + uy * len * 0.29 - ny * s * lw2 * 0.12 }], width: 0.4 });
      }
      const ez = (t: number, w: number): Vec2[] => { const e = { x: cc0.x + ux * t, y: cc0.y + uy * t }; return [{ x: e.x - nx * w, y: e.y - ny * w }, { x: e.x + nx * w, y: e.y + ny * w }]; };
      out.lines.push({ kind: 'platform', path: [...ez(-len / 2, lw2 * 0.9), ...ez(len / 2, lw2 * 0.9).reverse(), ez(-len / 2, lw2 * 0.9)[0]], width: 0.5 });
      out.landmarks.push({ kind: 'ballcourt', poly });
    } else if (pz.kind === 'west' || pz.kind === 'group' || pz.kind === 'small' || pz.kind === 'shrine') {
      // a temple on the side away from the centre, facing the plaza; a range building opposite
      const away = Math.atan2(pz.cv, pz.cu);
      const big = pz.kind === 'west' ? 16 * k : pz.kind === 'group' ? 13 : pz.kind === 'small' ? 11 : 6.5;
      const side = pz.kind === 'shrine' ? 0 : pz.cu !== 0 || pz.cv !== 0 ? (Math.abs(Math.cos(away)) > Math.abs(Math.sin(away)) ? (Math.cos(away) > 0 ? 0 : 2) : Math.sin(away) > 0 ? 1 : 3) : 0;
      const off = [[W / 2 - big - 3, 0], [0, H / 2 - big - 3], [-W / 2 + big + 3, 0], [0, -H / 2 + big + 3]][side];
      const face = ang + [Math.PI, -Math.PI / 2, 0, Math.PI / 2][side];
      mayaPyramid(out, pi, L(off[0], off[1]), ang, big, face, 'temple-pyramid', pz.kind === 'shrine' ? 3 : 4);
      const opp = [[-W / 2 + 5, 0], [0, -H / 2 + 5], [W / 2 - 5, 0], [0, H / 2 - 5]][side];
      const ra = side % 2 === 0 ? ang + Math.PI / 2 : ang;
      if (pz.kind !== 'shrine') rangeBuilding(out, pi, L(opp[0], opp[1]), ra, (side % 2 === 0 ? H : W) * 0.6, 5, 'palace-range');
      for (let i = 0; i < (pz.kind === 'shrine' ? 1 : 3); i++) out.lines.push({ kind: 'stela', path: [L(off[0] * 0.25 + (i - 1) * 4, off[1] * 0.25 + 4), L(off[0] * 0.25 + (i - 1) * 4 + 1.1, off[1] * 0.25 + 4)], width: 1.1 });
      if (pz.kind === 'small' || pz.kind === 'shrine') { out.squares.push(poly); out.sites.push({ id: 'plaza', kind: 'temple-plaza', role: 'worship', lot: poly, anchor: P(pz.cu, pz.cv) }); }
    } else if (pz.kind === 'east') {
      // the market plaza: rows of low stall platforms
      for (let i = -3; i <= 3; i++) out.lines.push({ kind: 'stall-row', path: [L(-W * 0.38, i * (H / 8)), L(W * 0.38, i * (H / 8))], width: 2.2 });
      out.landmarks.push({ kind: 'market', poly });
      out.sites.push({ id: 'market', kind: 'market', role: 'market', lot: poly, anchor: P(pz.cu, pz.cv) });
    } else if (pz.kind === 'lost-world') {
      // the great radial pyramid with stairs on all four sides, small temples round it
      const big = Math.min(W, H) * 0.24;
      mayaPyramid(out, pi, L(0, 0), ang, big, ang + Math.PI / 2, 'great-pyramid', 5);
      for (const [du, dv] of [[-W * 0.36, -H * 0.36], [W * 0.36, -H * 0.36], [W * 0.36, H * 0.36]]) mayaPyramid(out, pi, L(du, dv), ang, 7, ang + Math.PI, 'temple-pyramid', 3);
    } else if (pz.kind === 'twin') {
      // twin-pyramid complex: flat-topped pyramids east and west, nine stelae before the east one, the stela
      // enclosure north, the nine-doorway range south
      const h = Math.min(W, H) * 0.15;
      mayaPyramid(out, pi, L(W / 2 - h - 3, 0), ang, h, ang + Math.PI, 'twin-pyramid', 3);
      mayaPyramid(out, pi, L(-W / 2 + h + 3, 0), ang, h, ang, 'twin-pyramid', 3);
      for (let i = 0; i < 9; i++) out.lines.push({ kind: 'stela', path: [L(W / 2 - 2 * h - 8, -H * 0.3 + i * H * 0.075), L(W / 2 - 2 * h - 8, -H * 0.3 + i * H * 0.075 + 1.1)], width: 1.1 });
      const en = box(pz.cu, pz.cv - H / 2 + 12, 22, 18);
      out.lines.push({ kind: 'stone-wall', path: [en[0], en[1], en[2], en[3], en[0]], width: 1.4 });
      rangeBuilding(out, pi, L(0, H / 2 - 5), ang, W * 0.55, 5.5, 'nine-door-range');
    }
  }
  // ---- causeways (sacbeob) from the core to the outlying groups
  const core = plazaPolys[0];
  const coreC = P(0, 0);
  const sacbe: UrbanStreet[] = [];
  for (const g of groups) {
    const end = at(c, g.a, g.d);
    // from the edge of the core to the edge of the group's plaza
    const a0 = Math.atan2(end.y - coreC.y, end.x - coreC.x);
    let lo = 0, hi = 400;
    const inAny = (q: Vec2) => plazaPolys.slice(0, plazas.length - groups.length).some((pp) => pointInRing(pp, q));
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (inAny(at(coreC, a0, m))) lo = m; else hi = m; }
    const s0 = at(coreC, a0, hi - 2);
    let lo2 = 0, hi2 = 120;
    const gp = plazaPolys.find((pp) => pointInRing(pp, end));
    if (!gp) continue;
    for (let i = 0; i < 30; i++) { const m = (lo2 + hi2) / 2; if (pointInRing(gp, at(end, a0 + Math.PI, m))) lo2 = m; else hi2 = m; }
    const s1 = at(end, a0 + Math.PI, lo2 - 2);
    sacbe.push(street([s0, s1], tier === 3 ? 10 : 7.5, 1, 'radial'));
  }
  if (!sacbe.length && core) {
    // (a centre without causeways: the way in from the road)
    const a0 = cc.main ? cc.roadAngle : Math.atan2(ctx.center.y - c.y, ctx.center.x - c.x);
    let lo = 0, hi = 300;
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (pointInRing(core, at(coreC, a0, m))) lo = m; else hi = m; }
    sacbe.push(street([at(coreC, a0, lo - 2), at(coreC, a0, lo + 40)], tier >= 1 ? 6.5 : 4, 1, 'radial'));
  }
  out.streets.push(...sacbe);
  for (const s of sacbe) {
    // the causeway's low parapets
    const [a, b] = s.path;
    const L = dist(a, b) || 1, nx = -(b.y - a.y) / L, ny = (b.x - a.x) / L, hw = s.width / 2;
    for (const sg of [-1, 1]) out.lines.push({ kind: 'sacbe-edge', path: [{ x: a.x + nx * hw * sg, y: a.y + ny * hw * sg }, { x: b.x + nx * hw * sg, y: b.y + ny * hw * sg }], width: 0.5 });
  }
  // ---- reservoirs (aguadas) by the core (town and city)
  const resv: Polygon[] = [];
  if (tier >= 2) {
    const rr = rng.fork('aguadas');
    for (let i = 0; i < (tier === 3 ? 4 : 2) * 3 && resv.length < (tier === 3 ? 4 : 2); i++) {
      const a = rr.range(0, 2 * Math.PI), d = rr.range(130, 260) * k;
      const p = at(c, a, d);
      const r0 = rr.range(18, 32) * k;
      const pond = orientPos(Array.from({ length: 16 }, (_, j) => at(p, (j / 16) * 2 * Math.PI, r0 * (1 + 0.15 * Math.sin(j * 1.7 + i)))));
      if (pond.some((q) => ctx.isWater(q) || plazaPolys.some((pp) => pointInRing(pp, q))) || resv.some((o) => dist(o[0], pond[0]) < r0 * 3)) continue;
      if (sacbe.some((s) => pond.some((q) => distToSegment(q, s.path[0], s.path[1]) < s.width + 4))) continue;
      resv.push(pond);
      out.landmarks.push({ kind: 'pond', poly: pond });
    }
  }
  // ---- houselots
  houselots(out, cc, c, pop, tier, ang, plazaPolys, sacbe, resv, rng.fork('lots'));
  out.disjoint = true;
  out.sites.push({ id: 'maya-centre', kind: tier >= 2 ? 'ceremonial-centre' : 'shrine', role: 'worship', lot: plazaPolys[0] ?? box(0, 0, 20, 20), anchor: c });
  return out;
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
}

/** The houselots: patio groups thinning out with distance from the core and the causeways. */
function houselots(out: Out, cc: CampCtx, c: Vec2, pop: number, tier: number, ang: number, plazas: Polygon[], sacbe: UrbanStreet[], resv: Polygon[], rng: Rng): void {
  const ctx = cc.ctx;
  const sk = Math.sqrt(cc.sprawl);
  // inhabitants per houselot (an extended family; larger compounds in a big city keep the lot count bounded)
  const perLot = tier === 3 ? Math.min(30, 14 + pop / 8000) : 13;
  const nLots = Math.max(3, Math.round(pop / perLot));
  // spacing at the centre and its growth outward; the residential radius from the lot count
  const s0 = (tier === 0 ? 34 : tier === 1 ? 32 : 30) * sk;
  const R = Math.min(ctx.mapSize * 0.47, Math.sqrt((nLots * s0 * s0 * 2.2) / Math.PI) + 90);
  const spacing = (d: number) => s0 * (1 + 1.1 * Math.pow(Math.min(1, d / R), 1.5));
  // seeds: dart throwing on a hash grid, the spacing growing with distance; never on water, plazas, causeways
  const occupied = (p: Vec2, r: number): boolean => {
    if (ctx.isWater(p) || p.x < 15 || p.y < 15 || p.x > ctx.mapSize - 15 || p.y > ctx.mapSize - 15) return true;
    for (const pz of plazas) if (pointInRing(pz, p) || pz.some((q) => dist(q, p) < r * 0.4)) return true;
    for (const s of sacbe) if (distToSegment(p, s.path[0], s.path[1]) < s.width / 2 + r * 0.5) return true;
    for (const w of resv) if (pointInRing(w, p) || dist(w[0], p) < r) return true;
    return ctx.slopeAt(p) > 0.3;
  };
  const seeds: Vec2[] = [];
  const cell = s0;
  const grid = new Map<number, Vec2[]>();
  const key = (x: number, y: number) => Math.floor(x / cell) * 100003 + Math.floor(y / cell);
  const near = (p: Vec2, r: number): boolean => {
    const ix = Math.floor(p.x / cell), iy = Math.floor(p.y / cell), k = Math.ceil(r / cell);
    for (let dx = -k; dx <= k; dx++) for (let dy = -k; dy <= k; dy++) for (const q of grid.get((ix + dx) * 100003 + iy + dy) ?? []) if (dist(q, p) < r) return true;
    return false;
  };
  // nearer the causeways the lots crowd closer (people lived along them)
  const sacbeK = (p: Vec2): number => { let d = Infinity; for (const s of sacbe) d = Math.min(d, distToSegment(p, s.path[0], s.path[1])); return d < 80 ? 0.8 : 1; };
  for (let tries = 0; tries < nLots * 40 && seeds.length < nLots; tries++) {
    const d = R * Math.sqrt(rng.float());
    const p = at(c, rng.range(0, 2 * Math.PI), d);
    const sp = spacing(dist(p, c)) * sacbeK(p);
    if (occupied(p, sp) || near(p, sp)) continue;
    seeds.push(p);
    const kk = key(p.x, p.y);
    if (!grid.has(kk)) grid.set(kk, []);
    grid.get(kk)!.push(p);
  }
  if (!seeds.length) return;
  // ---- cells: Voronoi of the seeds, each bounded by an octagon of its spacing (gaps = the milpa between lots)
  const bb = bboxOf(seeds);
  const vor = Delaunay.from(seeds.map((p) => [p.x, p.y] as [number, number])).voronoi([bb.x0 - 200, bb.y0 - 200, bb.x1 + 200, bb.y1 + 200]);
  const lr = rng.fork('lot');
  const fr = rng.fork('fill');
  const treesOut = (out.trees = out.trees ?? []);
  // the path network: the frontage of each lot faces the nearest causeway, plaza or the centre
  const targets: Vec2[] = [];
  for (const s of sacbe) { const L = dist(s.path[0], s.path[1]); for (let t = 0; t <= L; t += 25) targets.push({ x: s.path[0].x + ((s.path[1].x - s.path[0].x) * t) / L, y: s.path[0].y + ((s.path[1].y - s.path[0].y) * t) / L }); }
  for (const pz of plazas) for (const q of pz) targets.push(q);
  if (!targets.length) targets.push(c);
  const gates: Vec2[] = [];
  const mm = (v: number) => Math.round(v * 1000) / 1000;
  seeds.forEach((p, i) => {
    let cellP = (vor.cellPolygon(i) ?? []).slice(0, -1).map(([x, y]) => ({ x, y }));
    if (cellP.length < 3) return;
    cellP = orientPos(cellP);
    const sp = spacing(dist(p, c));
    // (bounded by an irregular polygon of its size: the lots tessellate where they crowd, stand apart in the milpa;
    // kept off the plazas, the causeways and the reservoirs)
    const rad = sp * lr.range(0.5, 0.68);
    const nb = lr.int(6, 9), a0 = lr.range(0, 2 * Math.PI);
    for (let k = 0; k < nb; k++) {
      const a = a0 + ((k + lr.range(-0.25, 0.25)) / nb) * 2 * Math.PI;
      const rr = rad * lr.range(0.82, 1.12);
      const n = { x: -Math.cos(a), y: -Math.sin(a) };
      cellP = clipHalfPlaneConvex(cellP, { x: p.x + Math.cos(a) * rr, y: p.y + Math.sin(a) * rr }, n);
      if (cellP.length < 3) return;
    }
    for (const s of sacbe) {
      const [a, b] = s.path;
      const L = dist(a, b) || 1, nx = -(b.y - a.y) / L, ny = (b.x - a.x) / L;
      const side = (p.x - a.x) * nx + (p.y - a.y) * ny >= 0 ? 1 : -1;
      if (distToSegment(p, a, b) < sp * 1.5) cellP = clipHalfPlaneConvex(cellP, { x: a.x + nx * side * (s.width / 2 + 2), y: a.y + ny * side * (s.width / 2 + 2) }, { x: nx * side, y: ny * side });
      if (cellP.length < 3) return;
    }
    // (off the plazas: clipped by the plaza edge the seed lies beyond — plazas are convex)
    for (const pz of plazas) {
      const bp = bboxOf(pz), bc = bboxOf(cellP);
      if (bp.x0 > bc.x1 || bp.x1 < bc.x0 || bp.y0 > bc.y1 || bp.y1 < bc.y0) continue;
      const pzc = orientPos(pz);
      let best = -Infinity, bn = { x: 0, y: 0 }, bq = pzc[0];
      for (let e = 0; e < pzc.length; e++) {
        const a = pzc[e], b = pzc[(e + 1) % pzc.length];
        const L = dist(a, b) || 1;
        // outward normal of a CCW ring: right of a→b
        const on = { x: (b.y - a.y) / L, y: -(b.x - a.x) / L };
        const sd = (p.x - a.x) * on.x + (p.y - a.y) * on.y;
        if (sd > best) { best = sd; bn = on; bq = a; }
      }
      cellP = clipHalfPlaneConvex(cellP, { x: bq.x + bn.x * 1.5, y: bq.y + bn.y * 1.5 }, bn);
      if (cellP.length < 3) return;
    }
    cellP = orientPos(cellP.map((q) => ({ x: mm(q.x), y: mm(q.y) })));
    if (area(cellP) < 260 || cellP.some((q) => ctx.isWater(q) || plazas.some((pz) => pointInRing(pz, q)) || resv.some((w) => pointInRing(w, q)))) return;
    // the frontage: the longest edge facing the nearest target
    let tgt = targets[0], td = Infinity;
    for (const t of targets) { const d = dist(t, p); if (d < td) { td = d; tgt = t; } }
    let be = -1, bs = -Infinity;
    for (let e = 0; e < cellP.length; e++) {
      const a = cellP[e], b = cellP[(e + 1) % cellP.length];
      const L = dist(a, b);
      if (L < 6) continue;
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = -dist(m, tgt) + L * 0.6;
      if (s > bs) { bs = s; be = e; }
    }
    if (be < 0) return;
    const a = cellP[be], b = cellP[(be + 1) % cellP.length];
    const L = dist(a, b);
    const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
    // inward normal of a CCW ring: left of a→b
    const n = { x: -uy, y: ux };
    const pw = 2.6;
    const blk = orientPos(clipHalfPlaneConvex(cellP, { x: a.x + n.x * pw / 2, y: a.y + n.y * pw / 2 }, n).map((q) => ({ x: mm(q.x), y: mm(q.y) })));
    if (blk.length < 3 || area(blk) < 200) return;
    const qi = out.quarters.length;
    out.quarters.push(cellP);
    const bi = out.blocks.length;
    out.blocks.push({ poly: blk, kind: 'block', quarter: qi });
    const pi = out.parcels.length;
    out.parcels.push({ poly: blk, use: 'plot', block: bi });
    out.streets.push(street([{ x: a.x + ux * 0.6, y: a.y + uy * 0.6 }, { x: b.x - ux * 0.6, y: b.y - uy * 0.6 }], pw, 3, 'lane'));
    const gate = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    gates.push(gate);
    patioGroup(out, pi, blk, gate, ang, dist(p, c) < 160 && tier >= 2, fr.fork('g' + i), treesOut);
    // the dry-stone wall round the lot, open at the gate (towns and cities)
    if (tier >= 2) for (const pl of openRing(blk, [{ p: { x: gate.x + n.x * pw / 2, y: gate.y + n.y * pw / 2 }, width: 3.2 }])) out.lines.push({ kind: 'albarrada', path: pl, width: 0.9 });
  });
  // footpaths between the lots and to the causeways: a minimum spanning tree over the gates (Delaunay edges)
  if (gates.length > 1) {
    const all = [...gates, ...targets];
    const del = Delaunay.from(all.map((p) => [p.x, p.y] as [number, number]));
    const edges: { a: number; b: number; d: number }[] = [];
    const { halfedges, triangles } = del;
    for (let e = 0; e < halfedges.length; e++) {
      const o = halfedges[e];
      if (o >= 0 && o < e) continue;
      const a = triangles[e], b = triangles[e % 3 === 2 ? e - 2 : e + 1];
      const d = dist(all[a], all[b]);
      if (d > 220) continue;
      const m = { x: (all[a].x + all[b].x) / 2, y: (all[a].y + all[b].y) / 2 };
      if (ctx.isWater(m)) continue;
      // (the causeway points are joined for free: the network roots on them)
      edges.push({ a, b, d: a >= gates.length && b >= gates.length ? 0 : d });
    }
    edges.sort((x, y) => x.d - y.d);
    const par = all.map((_, i) => i);
    const find = (i: number): number => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    for (const e of edges) {
      const ra = find(e.a), rb = find(e.b);
      if (ra === rb) continue;
      par[ra] = rb;
      if (e.d > 0) out.lines.push({ kind: 'footpath', path: [all[e.a], all[e.b]], width: 1.4 });
    }
  }
}

/** A patio group: two to four apsidal houses on low platforms round the patio, a kitchen, the garden, trees. */
function patioGroup(out: Out, pi: number, lot: Polygon, gate: Vec2, ang: number, elite: boolean, r: Rng, trees: { x: number; y: number; r: number }[]): void {
  const ins = inscribed(lot, [], 0.5);
  const placed: Polygon[] = [];
  const pc = { x: ins.c.x + (ins.c.x - gate.x) * 0.1, y: ins.c.y + (ins.c.y - gate.y) * 0.1 };
  const sp = Math.min(ins.r * 0.55, elite ? 10 : 8);
  const n = elite ? 4 : r.int(2, 4);
  const sides: [number, number, number][] = [[0, -1, 0], [1, 0, Math.PI / 2], [0, 1, 0], [-1, 0, Math.PI / 2]];
  const start = r.int(0, 3);
  for (let k = 0; k < n; k++) {
    const [du, dv, a0] = sides[(start + k) % 4];
    const a = ang + a0;
    const q = { x: pc.x + (Math.cos(ang) * du - Math.sin(ang) * dv) * sp, y: pc.y + (Math.sin(ang) * du + Math.cos(ang) * dv) * sp };
    const L = elite ? r.range(12, 16) : r.range(7.5, 10.5), W = elite ? 5.5 : r.range(4.2, 5);
    const g = fitIn(lot, (c2, s) => (elite ? rect(c2, a, L * s, W) : roundedRect(c2, a, L * s, W * Math.max(0.85, s), W * 0.5, 3)), placed, { margin: 1.4, gap: 1.6, minScale: 0.7, cands: [q] });
    if (!g) continue;
    placed.push(g);
    out.buildings.push({ poly: g, kind: 'house', parcel: pi, arch: elite ? 'palace-range' : 'maya-house', roof: elite ? 'flat' : 'thatch-round', material: elite ? 'stone' : 'wattle', storeys: 1, orientation: a });
  }
  if (!placed.length) return;
  // the patio platform
  const pf = rect(pc, ang, 2 * sp + 9, 2 * sp + 9);
  if (pf.every((q) => pointInRing(lot, q))) out.lines.push({ kind: 'platform', path: pf.concat([pf[0]]), width: 0.5 });
  // the kitchen hut, the garden, fruit trees
  const kt = fitIn(lot, (c2, s) => hut(c2, 2.2 * s, 10), placed, { margin: 1.2, gap: 2, minScale: 0.9, step: 3 });
  if (kt) { placed.push(kt); out.buildings.push({ poly: kt, kind: 'outbuilding', parcel: pi, arch: 'kitchen', roof: 'thatch-round', material: 'wattle', storeys: 1 }); }
  const gw = r.range(9, 15), gh = r.range(6, 10);
  const bed = fitIn(lot, (c2, s) => rect(c2, ang, gw * s, gh * s), placed.concat([pf]), { margin: 1.5, gap: 1.5, minScale: 0.6, step: 3 });
  if (bed) out.landmarks.push({ kind: 'garden-bed', poly: bed });
  // the forest garden: fruit trees (breadnut, cacao, avocado) round the patio group
  const nt = r.int(4, 9);
  const bbx = bboxOf(lot);
  let got = 0;
  for (let k = 0; k < nt * 3 && got < nt; k++) {
    const tq = { x: r.range(bbx.x0, bbx.x1), y: r.range(bbx.y0, bbx.y1) };
    const tr = r.range(2.4, 4.6);
    if (trees.length && trees.slice(-12).some((t) => dist(t, tq) < t.r + tr * 0.6)) continue;
    if (pointInRing(lot, tq) && !placed.some((p) => pointInRing(p, tq) || p.some((q) => dist(q, tq) < tr + 0.5)) && !(bed && pointInRing(bed, tq)) && !pointInRing(pf, tq)) { trees.push({ x: tq.x, y: tq.y, r: tr }); got++; }
  }
}
