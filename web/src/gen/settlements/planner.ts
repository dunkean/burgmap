/**
 * Settlement planner (M3c, REGION_SETTLEMENTS.md): the main settlement first (already sited by site/site.ts and
 * built by the urban stage), then the secondary settlements by decreasing class, each on the best remaining site:
 *  - site scoring with historical archetypes (spring line, river bank / bridge point, harbor, hilltop, valley,
 *    road side), shaped by the settlement's culture (dwarves take mountain faces, elves secluded slopes);
 *  - central-place spacing that grows with both populations (Christaller-like);
 *  - exclusion of every placed extent plus a gardens ring (the main town's actual footprint).
 * Every settlement draws from its own `fork('settlement:' + key)`, and candidates are ranked by a field that does not
 * depend on the other settlements, so adding a settlement at the end of the list (or of the last class) leaves the
 * others where they were.
 */
import { Delaunay } from 'd3-delaunay';
import type { Rng } from '../core/rng';
import { Noise2D } from '../core/noise';
import { blurGrid } from '../core/grid';
import { Vec2, Polygon, dist, polygonArea } from '../core/geom';
import { distanceField, forCellsNearPolyline, smoothstep } from '../core/field';
import { rasterizePolys } from '../geo/raster';
import type { World, Settlement, SiteArchetype } from '../types';
import {
  Options, SettlementClass, CountClass, COUNT_CLASSES, SettlementSpec, classOfPop, mapSizeOf, SettlementCounts,
} from '../options';
import { getCulture } from '../urban/culture';
import { BIG_RIVER_W } from '../site/site';

/** Population ranges used for counted / automatic settlements (log-uniform). */
export const CLASS_POP: Record<CountClass, [number, number]> = {
  farmstead: [5, 12], hamlet: [20, 80], village: [150, 600], town: [1000, 5000], city: [20000, 60000],
};

/** Projected radius (m) of the built extent of a settlement of `pop` inhabitants. */
export function extentRadius(pop: number): number {
  if (pop < 15) return 45;
  if (pop < 1000) return 20 + 9 * Math.sqrt(pop);
  return 20 + 9 * Math.sqrt(1000) * Math.pow(pop / 1000, 0.4);
}

/** Central-place spacing of a class (m), log-interpolated: villages 2.3 km, market towns 9 km, cities 15 km. */
const SPACING: [number, number][] = [[5, 450], [40, 1000], [300, 2300], [1000, 3800], [3000, 9000], [20000, 15000], [100000, 24000], [1e6, 40000]];
export function classSpacing(pop: number): number {
  if (pop <= SPACING[0][0]) return SPACING[0][1];
  for (let i = 1; i < SPACING.length; i++) {
    const [p1, d1] = SPACING[i];
    if (pop <= p1) {
      const [p0, d0] = SPACING[i - 1];
      const t = Math.log(pop / p0) / Math.log(p1 / p0);
      return d0 * Math.pow(d1 / d0, t);
    }
  }
  return SPACING[SPACING.length - 1][1];
}
/** Minimum center distance between two settlements: spacing of the smaller one, growing with the size ratio. */
export function pairSpacing(pa: number, pb: number): number {
  const lo = Math.min(pa, pb), hi = Math.max(pa, pb);
  return classSpacing(lo) * Math.pow(hi / Math.max(1, lo), 0.1);
}
/** Extents (plus a gardens ring) never overlap, whatever the relaxation. */
export function extentGap(pa: number, pb: number): number {
  return extentRadius(pa) + extentRadius(pb) + 60 + 0.25 * Math.max(extentRadius(pa), extentRadius(pb));
}

export interface PlanRequest { key: string; cls: CountClass | SettlementClass; pop: number; culture: string; siteType?: SiteArchetype; position?: Vec2; explicit: boolean }
export interface PlanResult { settlements: Settlement[]; warnings: string[]; requested: number }

const logUniform = (r: Rng, [a, b]: [number, number]): number => Math.round(a * Math.pow(b / a, r.float()));

/** Automatic counts from the usable land (pre-industrial densities: ~25–40 rural inhabitants per km²). */
export function autoCounts(usableKm2: number, mainPop: number, relief: Options['relief']): SettlementCounts {
  const rf = relief === 'mountains' ? 0.55 : relief === 'flat' ? 1.15 : relief === 'valley' ? 0.9 : 1;
  const mainCls = classOfPop(mainPop);
  const city = Math.max(0, Math.floor(usableKm2 / 1300) - (mainCls === 'city' || mainCls === 'metropolis' || mainCls === 'megacity' ? 1 : 0));
  const town = Math.max(0, Math.round(usableKm2 / 320) - (mainCls === 'town' ? 1 : 0) - 2 * city);
  const village = Math.max(0, Math.round((usableKm2 / 9) * rf));
  return { city, town, village, hamlet: Math.round(village * 1.25), farmstead: Math.round(village * 1.6) };
}

/** Requests in placement order (stable keys). */
export function settlementRequests(opts: Options, usableKm2: number, mainPop: number, root: Rng): PlanRequest[] {
  const s = opts.settlements ?? 'auto';
  if (s === 'none') return [];
  const out: PlanRequest[] = [];
  if (typeof s === 'object' && 'list' in s) {
    s.list.forEach((it: SettlementSpec, k) => {
      out.push({ key: String(k), cls: classOfPop(it.population), pop: it.population, culture: it.culture ?? opts.culture, siteType: it.siteType, position: it.position, explicit: true });
    });
    return out;
  }
  const counts = s === 'auto' ? autoCounts(usableKm2, mainPop, opts.relief) : s.counts;
  for (const cls of COUNT_CLASSES) {
    const n = Math.max(0, Math.round(counts[cls] ?? 0));
    for (let j = 0; j < n; j++) {
      const key = cls + ':' + j;
      out.push({ key, cls, pop: logUniform(root.fork('settlement:' + key).fork('pop'), CLASS_POP[cls]), culture: opts.culture, explicit: s !== 'auto' });
    }
  }
  return out;
}

/** Convex polygon clip (Sutherland–Hodgman), `clip` convex. */
export function clipConvex(subject: Polygon, clip: Polygon): Polygon {
  let out = subject;
  const ccw = polygonArea(clip) > 0;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const inside = (p: Vec2): boolean => { const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x); return ccw ? c >= 0 : c <= 0; };
    const inp = out;
    out = [];
    for (let j = 0; j < inp.length; j++) {
      const P = inp[j], Q = inp[(j + 1) % inp.length];
      const pin = inside(P), qin = inside(Q);
      if (pin) out.push(P);
      if (pin !== qin) {
        const dx = Q.x - P.x, dy = Q.y - P.y;
        const den = (b.x - a.x) * dy - (b.y - a.y) * dx;
        if (Math.abs(den) > 1e-12) {
          const t = ((b.y - a.y) * (P.x - a.x) - (b.x - a.x) * (P.y - a.y)) / den;
          out.push({ x: P.x + dx * t, y: P.y + dy * t });
        }
      }
    }
  }
  return out;
}

export function circle(c: Vec2, r: number, n = 28): Polygon {
  const out: Polygon = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * 2 * Math.PI; out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }); }
  return out;
}

/** Voronoi cells of the settlement sites, clipped to the map. */
export function voronoiRegions(centers: Vec2[], S: number): Polygon[] {
  if (centers.length === 1) return [[{ x: 0, y: 0 }, { x: S, y: 0 }, { x: S, y: S }, { x: 0, y: S }]];
  const del = Delaunay.from(centers, (p) => p.x, (p) => p.y);
  const vor = del.voronoi([0, 0, S, S]);
  return centers.map((_, i) => {
    const cp = vor.cellPolygon(i);
    if (!cp) return circle(centers[i], 10, 8);
    const ring = cp.slice(0, -1).map(([x, y]) => ({ x, y }));
    return ring;
  });
}

/**
 * Plan all settlements. `world` holds the terrain, the main site, the main roads and the main urban layer.
 */
export function planSettlements(world: World, opts: Options, root: Rng): PlanResult {
  const terrain = world.terrain, site = world.site!;
  const S = mapSizeOf(opts);
  const { w: n, cell } = terrain.height;
  const N = n * n;
  const H = terrain.height.data, water = terrain.water, slope = terrain.slope.data;
  const f = site.fields;
  const warnings: string[] = [];
  const r = root.fork('settlements');

  // ---- main settlement (index 0)
  const mainPop = world.urban?.population ?? 100;
  const foot = world.urban?.footprintH ?? [];
  let footArea = 0;
  for (const ph of foot) footArea += Math.abs(polygonArea(ph.outer));
  const mainR = Math.max(extentRadius(mainPop) * 0.6, Math.sqrt(footArea / Math.PI) * 1.15, site.reserveRadius);
  const main: Settlement = {
    key: 'main', index: 0, main: true, cls: classOfPop(mainPop), population: mainPop, culture: opts.culture, center: site.center,
    archetype: site.archetype, radius: mainR, extent: [], region: [], detail: 'main', urban: world.urban,
    crossing: site.crossing, harbor: site.harbor,
  };

  // ---- fields shared by all candidates
  const footMask = new Uint8Array(N);
  if (foot.length) rasterizePolys(foot.map((ph) => ph.outer), n, n, cell, footMask);
  else forCellsNearPolyline([site.center, site.center], n, n, cell, mainR, (i) => { footMask[i] = 1; });
  const dFoot = distanceField(footMask, n, n, cell).dist;
  const roadMask = new Uint8Array(N);
  for (const rd of world.roads ?? []) forCellsNearPolyline(rd.path, n, n, cell, cell * 0.75, (i) => { roadMask[i] = 1; });
  const dRoad = distanceField(roadMask, n, n, cell).dist;
  const bigMask = new Uint8Array(N);
  for (const rv of terrain.rivers) {
    for (let i = 1; i < rv.path.length; i++) {
      const wd = Math.max(rv.width[i - 1], rv.width[i]);
      if (wd < BIG_RIVER_W) continue;
      forCellsNearPolyline([rv.path[i - 1], rv.path[i]], n, n, cell, wd / 2 + cell * 0.8, (idx) => { if (water[idx] === 3) bigMask[idx] = 1; });
    }
  }
  const dBig = distanceField(bigMask, n, n, cell).dist;
  const confl: Vec2[] = terrain.rivers.filter((rv) => rv.mouth === 'river' && Math.max(...rv.width) >= 2.5).map((rv) => rv.path[rv.path.length - 1]);
  const hb = blurGrid(terrain.height, Math.max(2, Math.round(300 / cell)), 2).data;
  const slopeS = f.slopeS;
  // buildable land (summed-area table)
  const build = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (water[i] === 0 && slope[i] < 0.2 && f.hab[i] >= 1) build[i] = 1;
  const sat = new Int32Array((n + 1) * (n + 1));
  for (let y = 0; y < n; y++) { let row = 0; for (let x = 0; x < n; x++) { row += build[y * n + x]; sat[(y + 1) * (n + 1) + x + 1] = sat[y * (n + 1) + x + 1] + row; } }
  const frac = (x: number, y: number, rad: number): number => {
    const x0 = Math.max(0, Math.floor((x - rad) / cell)), x1 = Math.min(n - 1, Math.floor((x + rad) / cell));
    const y0 = Math.max(0, Math.floor((y - rad) / cell)), y1 = Math.min(n - 1, Math.floor((y + rad) / cell));
    const s = sat[(y1 + 1) * (n + 1) + x1 + 1] - sat[y0 * (n + 1) + x1 + 1] - sat[(y1 + 1) * (n + 1) + x0] + sat[y0 * (n + 1) + x0];
    const full = Math.max(1, Math.round((2 * rad) / cell) + 1) ** 2;
    return s / Math.max((x1 - x0 + 1) * (y1 - y0 + 1), full);
  };
  // usable land for the automatic counts
  let usable = 0;
  for (let i = 0; i < N; i += 2) if (water[i] === 0 && slope[i] < 0.3) usable++;
  const usableKm2 = (usable * 2 * cell * cell) / 1e6;

  const reqs = settlementRequests(opts, usableKm2, mainPop, root);
  const noise = new Noise2D(r.fork('noise'));

  // ---- candidate grid (~40–60 m stride)
  const stride = Math.max(1, Math.round(Math.max(40, cell * 1.5) / cell));
  const cand: number[] = [];
  for (let y = 0; y < n; y += stride) for (let x = 0; x < n; x += stride) if (water[y * n + x] === 0) cand.push(y * n + x);
  const pos = (i: number): Vec2 => ({ x: ((i % n) + 0.5) * cell, y: (((i / n) | 0) + 0.5) * cell });

  /** Archetype of a site from the features around it (for labels and the urban plan). */
  const archetypeAt = (i: number, ext: number, p: Vec2): SiteArchetype => {
    if (f.dSea[i] < ext + 70) return 'harbor';
    if (confl.some((c) => dist(c, p) < ext + 150)) return 'confluence';
    if (dBig[i] < ext + 60) return 'bridge';
    if (H[i] - hb[i] > 8 && slopeS[i] < 0.12) return 'hilltop';
    if ((opts.relief === 'valley' || opts.relief === 'mountains') && f.dMain[i] < 900) return 'valley';
    return 'plain';
  };
  const matches = (a: SiteArchetype, i: number, ext: number, p: Vec2): boolean => {
    switch (a) {
      case 'harbor': return f.dSea[i] < ext + 60;
      case 'estuary': return f.dSea[i] < 700 && dBig[i] < ext + 60;
      case 'bridge': case 'meander': return dBig[i] < ext + 60;
      case 'confluence': return confl.some((c) => dist(c, p) < ext + 150);
      case 'hilltop': return H[i] - hb[i] > 6;
      case 'valley': return f.dMain[i] < 900 && f.hab[i] > 2.5;
      case 'plain': return slopeS[i] < 0.05;
      default: return true;
    }
  };

  /** Static score of a candidate for a class / culture (independent of the other settlements). */
  const scoreOf = (i: number, pop: number, culture: string): number => {
    const p = pos(i);
    const ext = extentRadius(pop);
    const cu = getCulture(culture);
    const prefs = cu.sitePrefs ?? {};
    const mountain = prefs.mountainFace ?? 0, wood = prefs.woodland ?? 0;
    // hard constraints: dry land, map margin, not too steep (dwarves and elves tolerate more), buildable ground
    const edge = Math.min(p.x, p.y, S - p.x, S - p.y);
    // (the urban engine keeps a 3 % band along the map border unbuilt)
    if (edge < 0.03 * S + 0.8 * ext + 40) return -Infinity;
    const capS = 0.11 + 0.18 * mountain + 0.06 * wood + (pop < 100 ? 0.03 : 0);
    const capR = 0.16 + 0.25 * mountain + 0.08 * wood + (pop < 100 ? 0.04 : 0);
    if (slopeS[i] > capS || slope[i] > capR) return -Infinity;
    if (f.dWater[i] < Math.max(25, 0.35 * ext) || (f.dWater[i] < 200 && f.hab[i] < 1.5)) return -Infinity;
    const bf = frac(p.x, p.y, Math.max(cell, 0.8 * ext));
    const bfMin = (pop >= 1000 ? 0.45 : pop >= 150 ? 0.35 : 0.2) * (1 - 0.6 * mountain);
    if (bf < bfMin) return -Infinity;
    let s = 1.6 * (1 - smoothstep(slopeS[i], 0.015, capS)) + 1.4 * bf;
    // water: a spring line or brook a short walk away; river banks for villages and towns; harbors
    const dW = f.dWater[i];
    s += 0.8 * (dW > 30 && dW < 450 ? Math.exp(-Math.max(0, dW - 70) / 180) : 0);
    if (pop >= 150) {
      if (dBig[i] < ext + 120 && f.hab[i] > 2) s += pop >= 1000 ? 0.9 : 0.4;
      if (f.dSea[i] < ext + 80) s += pop >= 1000 ? 1.0 : 0.5;
    }
    // roads draw villages and towns (relay sites), hamlets less so
    s += (pop >= 150 ? 0.55 : 0.25) * Math.exp(-dRoad[i] / 500);
    // floodplains are avoided
    if (f.dWater[i] < 250) s -= 0.6 * (1 - smoothstep(f.hab[i], 1.5, 4));
    // culture: dwarves seek the foot of mountain faces, elves secluded wooded slopes
    if (mountain) s += 1.4 * mountain * smoothstep(slopeS[i], 0.04, 0.18) + 0.6 * mountain * smoothstep(H[i] - hb[i], 0, 30);
    if (wood) s += 0.8 * wood * smoothstep(dRoad[i], 300, 1400) + 0.4 * wood * smoothstep(slopeS[i], 0.03, 0.1);
    const hw = prefs.weights?.hilltop ?? 1;
    if (hw > 1) s += 0.3 * (hw - 1) * smoothstep(H[i] - hb[i], 3, 20);
    s += 0.35 * noise.fbm(p.x / 900, p.y / 900, 2);
    return s;
  };

  // ---- placement
  const placed: Settlement[] = [main];
  const sorted = new Map<string, { i: number; s: number }[]>();
  const sortedFor = (pop: number, culture: string): { i: number; s: number }[] => {
    // one ranking per (class band, culture): the score only depends on them
    const band = pop < 15 ? 0 : pop < 100 ? 1 : pop < 1000 ? 2 : pop < 20000 ? 3 : 4;
    const key = band + '|' + culture;
    let l = sorted.get(key);
    if (!l) {
      const rep = [8, 40, 300, 3000, 30000][band];
      l = [];
      for (const i of cand) { const s = scoreOf(i, rep, culture); if (s > -Infinity) l.push({ i, s }); }
      l.sort((a, b) => b.s - a.s || a.i - b.i);
      sorted.set(key, l);
    }
    return l;
  };
  const okAgainst = (p: Vec2, pop: number, relax: number): boolean => {
    const ext = extentRadius(pop);
    const ci = Math.min(n - 1, Math.floor(p.y / cell)) * n + Math.min(n - 1, Math.floor(p.x / cell));
    // the main town's real footprint plus a gardens ring
    if (dFoot[ci] < ext + 80 + 0.2 * mainR) return false;
    for (const o of placed) {
      const d = dist(o.center, p);
      const gap = o.main ? ext + mainR + 80 : extentGap(o.population, pop);
      if (d < gap) return false;
      if (d < relax * pairSpacing(o.population, pop)) return false;
    }
    return true;
  };
  let requested = 0;
  const failedBand = new Set<string>();
  for (const q of reqs) {
    requested++;
    const rq = root.fork('settlement:' + q.key);
    const ext = extentRadius(q.pop);
    let chosen: { i: number; p: Vec2; relax: number } | null = null;
    if (q.position) {
      // fixed position: snapped to the nearest dry cell
      let best = -1, bd = Infinity;
      const px = Math.min(S - 1, Math.max(1, q.position.x)), py = Math.min(S - 1, Math.max(1, q.position.y));
      const cx = Math.floor(px / cell), cy = Math.floor(py / cell);
      const R = Math.ceil(400 / cell);
      for (let y = Math.max(0, cy - R); y <= Math.min(n - 1, cy + R); y++) for (let x = Math.max(0, cx - R); x <= Math.min(n - 1, cx + R); x++) {
        const i = y * n + x;
        if (water[i]) continue;
        const d = Math.hypot(x - cx, y - cy);
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) {
        const p = pos(best);
        chosen = { i: best, p, relax: 1 };
        if (!okAgainst(p, q.pop, 0)) warnings.push(`settlement ${q.key} (fixed position) overlaps another settlement's extent`);
      } else warnings.push(`settlement ${q.key}: no dry land near the given position`);
    } else {
      const bandKey = (q.pop < 15 ? 0 : q.pop < 100 ? 1 : q.pop < 1000 ? 2 : q.pop < 20000 ? 3 : 4) + '|' + q.culture + '|' + (q.siteType ?? '');
      // automatic mode: once a class finds no room, the rest of that class is skipped
      if (!q.explicit && failedBand.has(bandKey)) continue;
      const list = sortedFor(q.pop, q.culture);
      const steps = q.explicit ? [1, 0.8, 0.62, 0.48] : [1];
      for (const relax of steps) {
        const tryList = (need: boolean): boolean => {
          for (const c of list) {
            const p = pos(c.i);
            if (need && q.siteType && !matches(q.siteType, c.i, ext, p)) continue;
            if (!okAgainst(p, q.pop, relax)) continue;
            chosen = { i: c.i, p, relax };
            return true;
          }
          return false;
        };
        if (tryList(true)) break;
        if (q.siteType && tryList(false)) { warnings.push(`settlement ${q.key}: no ${q.siteType} site available, placed on the best other site`); break; }
      }
      if (!chosen) {
        if (q.explicit) warnings.push(`settlement ${q.key} (${q.cls}, ${q.pop} inh.) could not be placed: not enough room`);
        else failedBand.add(bandKey);
        continue;
      }
      if ((chosen as { relax: number }).relax < 1) warnings.push(`settlement ${q.key}: spacing relaxed to ${Math.round((chosen as { relax: number }).relax * 100)} %`);
    }
    if (!chosen) continue;
    const c = chosen as { i: number; p: Vec2 };
    // sub-cell jitter (own stream)
    const jr = rq.fork('jitter');
    const p = { x: c.p.x + jr.range(-0.3, 0.3) * cell * stride, y: c.p.y + jr.range(-0.3, 0.3) * cell * stride };
    const pi = Math.min(n - 1, Math.max(0, Math.floor(p.y / cell))) * n + Math.min(n - 1, Math.max(0, Math.floor(p.x / cell)));
    const relaxed = (chosen as { relax: number }).relax;
    let center = water[pi] || (!q.position && !okAgainst(p, q.pop, relaxed)) ? c.p : p;
    if (q.position) {
      // a fixed position is kept exactly when it is on dry land
      const gp = { x: Math.min(S - 1, Math.max(1, q.position.x)), y: Math.min(S - 1, Math.max(1, q.position.y)) };
      const gi = Math.min(n - 1, Math.floor(gp.y / cell)) * n + Math.min(n - 1, Math.floor(gp.x / cell));
      center = water[gi] ? c.p : gp;
    }
    const archetype = q.siteType && matches(q.siteType, c.i, ext, center) ? q.siteType : archetypeAt(c.i, ext, center);
    const cls = classOfPop(q.pop);
    placed.push({
      key: q.key, index: placed.length, cls, population: q.pop, culture: q.culture, center, archetype, radius: ext,
      extent: [], region: [], fixed: !!q.position, detail: cls === 'farmstead' ? 'farmstead' : 'eager',
    });
  }

  // ---- regions (Voronoi cells) and extents (disc clipped to the cell)
  const regions = voronoiRegions(placed.map((s) => s.center), S);
  placed.forEach((s, k) => {
    s.region = regions[k];
    s.extent = clipConvex(circle(s.center, s.radius), regions[k]);
  });
  return { settlements: placed, warnings, requested };
}
