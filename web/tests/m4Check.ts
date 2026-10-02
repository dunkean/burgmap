/** M4 invariants (URBAN_LANDMARKS.md §4): landmark lots, access, water, quays, separation, castle, shanty towns. */
import type { World, UrbanSite } from '../src/gen/types';
import type { Vec2, Polygon } from '../src/gen/core/geom';
import { dist, polygonCentroid } from '../src/gen/core/geom';
import { area, pointInRing, distToRing, distToSeg, obb, bboxOf } from '../src/gen/geo/poly';
import { intersectionS, mpArea, MultiPoly } from '../src/gen/geo/bool';
import { makeCtx } from '../src/gen/urban/context';
import { resolveMorph } from '../src/gen/urban/morphology';
import { sampleGrid } from '../src/gen/core/grid';
import { LineIndex } from '../src/gen/urban/m4/lots';

export interface M4Report {
  sites: UrbanSite[];
  lotOverlap: number;
  noAccess: string[];
  wetBuildings: string[];
  wetBlocks: string[];
  quayOff: number;
  sepFail: string[];
  castle: { verts: number; convex: boolean; minEdge: number; gapToWall: number } | null;
  shanty: { cov: number; hutMin: number; hutMax: number; plots: number; lowValue: number; inside: number }[];
  cathedral: { len: number; angle: number } | null;
}

/** Level-1 lot sites (their lots are exact pieces of the partition). */
const LOT_KINDS = new Set(['castle', 'kasbah', 'motte', 'cathedral-close', 'palace', 'monastery', 'madrasa', 'shipyard', 'ropewalk', 'tannery', 'watermill', 'windmill', 'gallows', 'lazar-house', 'cemetery', 'arena', 'shanty']);
const WATER_OK = new Set(['pier', 'slipway', 'quay', 'mill', 'mill-race', 'bridge']);

const segDist = (p: Vec2, pl: Vec2[]) => { let d = Infinity; for (let i = 1; i < pl.length; i++) d = Math.min(d, distToSeg(p, pl[i - 1], pl[i])); return d; };

export function checkM4(w: World): M4Report {
  const u = w.urban!;
  const sites = u.sites ?? [];
  const lots = sites.filter((s) => LOT_KINDS.has(s.kind));
  // 1. landmark lots do not overlap
  let lotOverlap = 0;
  for (let i = 0; i < lots.length; i++) for (let j = i + 1; j < lots.length; j++) {
    const a = bboxOf(lots[i].lot), b = bboxOf(lots[j].lot);
    if (a.x0 > b.x1 || b.x0 > a.x1 || a.y0 > b.y1 || b.y0 > a.y1) continue;
    lotOverlap = Math.max(lotOverlap, mpArea(intersectionS(lots[i].lot, lots[j].lot)));
  }
  // 2. street access at the entrance (a street, a track to the road, or the road itself)
  const tracks = (u.lines ?? []).filter((l) => l.kind === 'track');
  const noAccess: string[] = [];
  for (const s of lots) {
    if (s.kind === 'shanty') continue;
    const e = s.entrance;
    if (!e) { noAccess.push(s.kind + ' (no entrance)'); continue; }
    const onStreet = u.streets.some((st) => segDist(e, st.path) <= st.width / 2 + 2);
    const onTrack = tracks.some((t) => dist(t.path[0], e) < 1.5 || dist(t.path[t.path.length - 1], e) < 1.5);
    const onRoad = (w.roads ?? []).some((r) => segDist(e, r.path) < 15);
    if (!onStreet && !onTrack && !onRoad) noAccess.push(s.kind);
  }
  // 3. nothing over the water but piers, slipways, mills (and the reclaimed quay edge)
  const ctx = makeCtx(w, resolveMorph('european-organic'), w.mapSize);
  const water: MultiPoly = ctx.water;
  // (fast path: a polygon farther from every water boundary than its own radius is wholly dry or wholly wet)
  const shore = new LineIndex(water.flatMap((ph) => [ph.outer, ...ph.holes]).map((r) => ({ path: r.concat([r[0]]), hw: 0 })));
  const inWater = (p: Vec2) => water.some((ph) => pointInRing(ph.outer, p) && !ph.holes.some((h) => pointInRing(h, p)));
  const wetOf = (p: Polygon) => {
    if (!water.length) return 0;
    const bb = bboxOf(p);
    const c = { x: (bb.x0 + bb.x1) / 2, y: (bb.y0 + bb.y1) / 2 }, rad = Math.hypot(bb.x1 - bb.x0, bb.y1 - bb.y0) / 2;
    if (shore.dist(c, rad + 1) > rad + 0.5) return inWater(c) ? area(p) : 0;
    return mpArea(intersectionS(p, water));
  };
  const wetBuildings: string[] = [], wetBlocks: string[] = [];
  for (const b of u.buildings) {
    const use = b.parcel !== undefined ? String(u.parcels[b.parcel].use) : '';
    if (WATER_OK.has(use)) continue;
    const a = wetOf(b.poly);
    if (a > 0.5) wetBuildings.push(`${b.arch ?? b.kind} on ${use}: ${a.toFixed(1)} m²`);
  }
  const usesByBlock = new Map<number, Set<string>>();
  u.parcels.forEach((p) => { if (!usesByBlock.has(p.block)) usesByBlock.set(p.block, new Set()); usesByBlock.get(p.block)!.add(String(p.use)); });
  u.blocks.forEach((poly, i) => {
    const uses = usesByBlock.get(i) ?? new Set<string>();
    if ([...uses].some((x) => WATER_OK.has(x))) return;
    const a = wetOf(poly);
    if (a > Math.max(2, 0.01 * area(poly))) wetBlocks.push(`${u.blockInfo[i].kind}/${u.blockInfo[i].compound ?? ''}: ${a.toFixed(1)} m²`);
  });
  // 4. quays lie on the shoreline
  let quayOff = 0;
  for (const q of u.quays ?? []) for (let i = 1; i < q.length; i++) {
    const L = dist(q[i - 1], q[i]);
    for (let s = 0; s <= L; s += 5) {
      const p = { x: q[i - 1].x + ((q[i].x - q[i - 1].x) * s) / L, y: q[i - 1].y + ((q[i].y - q[i - 1].y) * s) / L };
      const d = Math.min(...water.map((ph) => Math.min(distToRing(ph.outer, p), ...ph.holes.map((h) => distToRing(h, p)))));
      quayOff = Math.max(quayOff, d);
    }
  }
  // 5. separation rules
  const sepFail: string[] = [];
  const sep = (kind: string, d: number) => {
    const l = sites.filter((s) => s.kind === kind);
    for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) if (dist(l[i].anchor, l[j].anchor) < d) sepFail.push(`${kind} ${dist(l[i].anchor, l[j].anchor).toFixed(0)} m`);
  };
  sep('monastery', 200); sep('windmill', 130); sep('watermill', 240); sep('madrasa', 200);
  // 6. castle: a straight-sided convex polygon of 4–8 curtains at the edge of the town
  let castle: M4Report['castle'] = null;
  const cw = (u.walls ?? []).find((x) => x.role === 'castle');
  if (cw) {
    const P = cw.path;
    let sgn = 0, convex = true, minEdge = Infinity;
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length], c = P[(i + 2) % P.length];
      const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cr) > 1e-6) { if (!sgn) sgn = Math.sign(cr); else if (Math.sign(cr) !== sgn) convex = false; }
      minEdge = Math.min(minEdge, dist(a, b));
    }
    const town = (u.walls ?? []).filter((x) => x.role === 'town' || x.role === 'outer');
    const enc = u.phases.filter((p) => p.zone !== 'faubourg').flatMap((p) => p.region.map((r) => r.outer));
    // (the enclosure line it was built on: a later outer enclosure may have taken the castle in)
    const rings = [...town.map((t) => t.path), ...enc];
    const gapToWall = rings.length ? Math.min(...P.map((q) => Math.min(...rings.map((r) => distToRing(r, q))))) : 0;
    castle = { verts: P.length, convex, minEdge, gapToWall };
  }
  // 7. shanty towns: coverage, hut sizes, no plots, on low-value land, outside the walls
  const shanty: M4Report['shanty'] = [];
  const encPolys = u.phases.filter((p) => p.walled || p.zone !== 'faubourg').flatMap((p) => p.region.map((r) => r.outer));
  const wallRings = (u.walls ?? []).filter((x) => x.role !== 'castle' && x.role !== 'quarter').map((x) => x.path);
  const tanneries = sites.filter((s) => s.kind === 'tannery');
  const hab = w.site!.fields.hab, g = w.terrain.height;
  const habAt = (p: Vec2) => hab[Math.min(g.h - 1, Math.max(0, Math.floor(p.y / g.cell))) * g.w + Math.min(g.w - 1, Math.max(0, Math.floor(p.x / g.cell)))];
  u.blocks.forEach((poly, i) => {
    if (u.blockInfo[i].kind !== 'shanty') return;
    let built = 0, hutMin = Infinity, hutMax = 0, plots = 0;
    u.parcels.forEach((p) => { if (p.block === i && p.use === 'plot') plots++; });
    for (const b of u.buildings) if (b.kind === 'hut' && b.parcel !== undefined && u.parcels[b.parcel].block === i) { const a = area(b.poly); built += a; hutMin = Math.min(hutMin, a); hutMax = Math.max(hutMax, a); }
    const bb = bboxOf(poly);
    let n = 0, low = 0, inside = 0;
    for (let y = bb.y0 + 4; y < bb.y1; y += 8) for (let x = bb.x0 + 4; x < bb.x1; x += 8) {
      const p = { x, y };
      if (!pointInRing(poly, p)) continue;
      n++;
      if (encPolys.some((r) => pointInRing(r, p))) inside++;
      const glacis = wallRings.some((r) => distToRing(r, p) < 130);
      const flood = habAt(p) < 4;
      const steep = sampleGrid(w.terrain.slope, p.x, p.y) > 0.08;
      const road = (w.roads ?? []).some((r) => segDist(p, r.path) < 70);
      const nuis = tanneries.some((t) => distToRing(t.lot, p) < 160);
      if (glacis || flood || steep || road || nuis) low++;
    }
    shanty.push({ cov: built / area(poly), hutMin, hutMax, plots, lowValue: n ? low / n : 1, inside: n ? inside / n : 0 });
  });
  // the cathedral: cruciform, oriented east, 80–140 m
  let cathedral: M4Report['cathedral'] = null;
  const cb = u.buildings.find((b) => b.arch === 'gothic-cathedral' && b.parcel !== undefined && u.blockInfo[u.parcels[b.parcel].block]?.compound === 'm4-cathedral-close');
  if (cb) {
    // length along its axis (the choir points east)
    const a = cb.orientation ?? 0;
    const pr = cb.poly.map((q) => q.x * Math.cos(a) + q.y * Math.sin(a));
    cathedral = { len: Math.max(...pr) - Math.min(...pr), angle: a };
    void obb;
  }
  void polygonCentroid;
  return { sites, lotOverlap, noAccess, wetBuildings, wetBlocks, quayOff, sepFail, castle, shanty, cathedral };
}
