/**
 * Toponyms: names every feature of a generated World (town, quarters, streets, squares, churches,
 * gates, rivers, lakes, sea, forests, hills, neighbouring villages at road exits, farmsteads).
 * Pure and deterministic (forks of the pipeline rng), no DOM. Degrades gracefully on missing layers.
 */
import type { Rng } from '../core/rng';
import type { Vec2, Polygon, Polyline } from '../core/geom';
import { polygonArea, polygonCentroid, polygonContains, distToPolyline, polylineLength, bbox, dist } from '../core/geom';
import type { World } from '../types';
import { VOCAB } from './grammar';
import { NameEntry, NameFamily, NameKind, NamesLayer, NAME_FAMILIES } from './types';

export { NAME_FAMILIES };
export type { NameEntry, NameFamily, NameKind, NamesLayer };

/** Culture id (URBAN_MORPHOLOGY.md §3) -> language family. Unknown ids fall back to the European default. */
const CULTURE_FAMILY: Record<string, NameFamily | 'european'> = {
  'european-organic': 'european', bastide: 'french', 'roman-core': 'italian', 'byzantine-greek': 'italian', 'venetian-lagoon': 'italian',
  medina: 'arabic', persian: 'arabic', ottoman: 'arabic', sahel: 'arabic', 'swahili-stone-town': 'arabic',
  chinese: 'chinese', korean: 'chinese', 'japanese-jokamachi': 'japanese', 'indian-temple': 'sanskrit', khmer: 'sanskrit',
  norse: 'norse', 'russian-kremlin': 'norse', hanseatic: 'german', 'celtic-oppidum': 'english',
  elven: 'elven', 'wizard-city': 'elven', dwarven: 'dwarven', gnomish: 'dwarven', orcish: 'orcish', necropolis: 'orcish',
  halfling: 'halfling', 'stilt-town': 'halfling',
};

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Resolve the language family from the culture and the `language` option ('auto' or a family id). */
export function familyFor(culture: string, language: string | undefined, seed: string): NameFamily {
  if (language && (NAME_FAMILIES as string[]).includes(language)) return language as NameFamily;
  const f = CULTURE_FAMILY[culture] ?? 'european';
  if (f !== 'european') return f;
  return hashStr('lang:' + seed) & 1 ? 'english' : 'french';
}

/* ---------------------------------------------------------------- geometry */
function ringDist(p: Vec2, ring: Polygon): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}
/** Approximate pole of inaccessibility (point deepest inside the polygon) by coarse grid + refinement. */
export function poleOf(poly: Polygon, holes: Polygon[] = []): { p: Vec2; r: number } {
  const b = bbox(poly);
  let best = polygonCentroid(poly), bestR = -1;
  const inside = (p: Vec2): boolean => polygonContains(poly, p) && !holes.some((h) => polygonContains(h, p));
  const depth = (p: Vec2): number => (inside(p) ? Math.min(ringDist(p, poly), ...holes.map((h) => ringDist(p, h))) : -1);
  let cx0 = b.minX, cy0 = b.minY, w = b.maxX - b.minX, h = b.maxY - b.minY;
  for (let pass = 0; pass < 3; pass++) {
    const N = 12;
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const p = { x: cx0 + (w * i) / N, y: cy0 + (h * j) / N };
      const d = depth(p);
      if (d > bestR) { bestR = d; best = p; }
    }
    w /= 5; h /= 5; cx0 = best.x - w / 2; cy0 = best.y - h / 2;
  }
  if (bestR < 0) return { p: polygonCentroid(poly), r: 0 };
  return { p: best, r: bestR };
}
/** Width of the polygon along the horizontal line through (x, y), for the interval containing x. */
export function horizontalSpan(poly: Polygon, x: number, y: number): number {
  const xs: number[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
  }
  xs.sort((p, q) => p - q);
  for (let i = 0; i + 1 < xs.length; i += 2) if (x >= xs[i] && x <= xs[i + 1]) return xs[i + 1] - xs[i];
  return 0;
}
const pathMid = (pl: Polyline): Vec2 => {
  const L = polylineLength(pl);
  let acc = 0;
  for (let i = 1; i < pl.length; i++) {
    const d = dist(pl[i - 1], pl[i]);
    if (acc + d >= L / 2) { const t = (L / 2 - acc) / (d || 1); return { x: pl[i - 1].x + (pl[i].x - pl[i - 1].x) * t, y: pl[i - 1].y + (pl[i].y - pl[i - 1].y) * t }; }
    acc += d;
  }
  return pl[Math.floor(pl.length / 2)];
};
const minDistToPts = (pl: Polyline, pts: Vec2[]): number => {
  let m = Infinity;
  for (const p of pl) for (const q of pts) m = Math.min(m, Math.hypot(p.x - q.x, p.y - q.y));
  return m;
};
const areaOf = (p: Polygon): number => Math.abs(polygonArea(p));

type Dir4 = 0 | 1 | 2 | 3; // N E S W
const dirOf = (from: Vec2, to: Vec2): Dir4 => {
  const dx = to.x - from.x, dy = to.y - from.y;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0;
};

/* ---------------------------------------------------------------- generator */
export function generateNames(world: World, root: Rng): NamesLayer {
  const rng = root.fork('names');
  const opts = world.options;
  const family = familyFor(opts.culture, opts.language, world.seed);
  const V = VOCAB[family];
  const S = world.mapSize;
  const t = world.terrain;
  const u = world.urban;
  const entries: NameEntry[] = [];
  const usedPlaces = new Set<string>();
  let idn = 0;
  const add = (e: Omit<NameEntry, 'id'>): NameEntry => { const x = { ...e, id: `n${idn++}` }; entries.push(x); return x; };

  const unique = (label: string, tier: 0 | 1 | 2 = 1): string => {
    for (let a = 0; a < 16; a++) {
      const s = V.place(rng.fork(`${label}:${a}`), tier);
      if (!usedPlaces.has(s)) { usedPlaces.add(s); return s; }
    }
    const s = V.place(rng.fork(`${label}:x`), tier) + ' II';
    usedPlaces.add(s);
    return s;
  };
  const center: Vec2 = world.site?.center ?? { x: S / 2, y: S / 2 };
  const pop = u?.population ?? 0;

  // ---- rivers (named first: the town may take its name)
  const riverBase: string[] = [];
  let mainRiverBase = '';
  t.rivers.forEach((rv, i) => {
    const len = polylineLength(rv.path);
    if (rv.path.length < 2 || len < (rv.main ? 120 : 350)) return;
    let base = V.water(rng.fork('river:' + i));
    for (let a = 1; a < 10 && riverBase.includes(base); a++) base = V.water(rng.fork('river:' + i + ':' + a));
    riverBase[i] = base;
    usedPlaces.add(base);
    if (rv.main || !mainRiverBase) { if (rv.main) mainRiverBase = base; }
    const text = V.river(base);
    rv.name = text;
    add({ kind: 'river', text, rank: rv.main ? 1 : 3, anchor: pathMid(rv.path), path: rv.path });
  });

  // ---- town
  let townBase = unique('town', 0);
  const mainRiver = t.rivers.find((r) => r.main);
  if (V.town && mainRiverBase && mainRiver && distToPolyline(center, mainRiver.path) < 500) {
    const dec = V.town(townBase, mainRiverBase, rng.fork('town:river'));
    if (dec !== townBase) { usedPlaces.add(dec); townBase = dec; }
  }
  const town = townBase;
  {
    // anchored above the built-up core (not the faubourg ribbons along the roads)
    let anchor = center, span = 300;
    const coreQ = (u?.quarters ?? []).filter((q) => q.zone !== 'faubourg');
    const pts = coreQ.length ? coreQ.flatMap((q) => q.poly.outer) : u?.footprint.flat() ?? [];
    if (pts.length) {
      const bb = bbox(pts);
      span = bb.maxX - bb.minX;
      if (span > 50) anchor = { x: (bb.minX + bb.maxX) / 2, y: bb.minY - 0.05 * span };
    }
    add({ kind: 'town', text: town, rank: 0, anchor, span });
  }

  // ---- roads: neighbouring villages at the exits
  interface RoadInfo { path: Polyline; exit: Vec2; dest: string; kind: string }
  const roadInfos: RoadInfo[] = [];
  (world.roads ?? []).forEach((r, i) => {
    if (r.kind === 'track' || r.path.length < 2) return;
    const a = r.path[0], b = r.path[r.path.length - 1];
    const exit = dist(a, center) > dist(b, center) ? a : b;
    const dest = unique('dest:' + i, 1);
    roadInfos.push({ path: r.path, exit, dest, kind: r.kind });
    const inward = { x: center.x - exit.x, y: center.y - exit.y };
    const l = Math.hypot(inward.x, inward.y) || 1;
    const k = Math.min(0.035 * S, 90);
    add({ kind: 'village', text: dest, rank: 2, anchor: { x: exit.x + (inward.x / l) * k, y: exit.y + (inward.y / l) * k }, sub: 'exit' });
  });
  const nearestRoad = (p: Vec2, within = Infinity): RoadInfo | null => {
    let best: RoadInfo | null = null, bd = within;
    for (const r of roadInfos) { const d = distToPolyline(p, r.path); if (d < bd) { bd = d; best = r; } }
    return best;
  };
  // regional road labels outside the footprint
  if (u) {
    for (const r of roadInfos) {
      if (r.kind !== 'major' || polylineLength(r.path) < 300) continue;
      let bestRun: Polyline = [], run: Polyline = [];
      for (const p of r.path) {
        if (u.footprint.some((f) => polygonContains(f, p))) { if (run.length > bestRun.length) bestRun = run; run = []; } else run.push(p);
      }
      if (run.length > bestRun.length) bestRun = run;
      if (bestRun.length >= 3 && polylineLength(bestRun) > 250) add({ kind: 'road', text: V.st.road(r.dest), rank: 4, anchor: pathMid(bestRun), path: bestRun });
    }
  }

  // ---- hills (local maxima of the height field)
  {
    const hg = t.height;
    const R = Math.max(2, Math.round(160 / hg.cell));
    const picks: { p: Vec2; h: number }[] = [];
    const reserve = world.site?.reserveRadius ?? 300;
    for (let y = R; y < hg.h - R; y += 2) for (let x = R; x < hg.w - R; x += 2) {
      const h0 = hg.data[y * hg.w + x];
      if (h0 <= 0) continue;
      let isMax = true, sum = 0, cnt = 0;
      for (let dy = -R; dy <= R && isMax; dy += Math.max(1, R >> 1)) for (let dx = -R; dx <= R; dx += Math.max(1, R >> 1)) {
        const v = hg.data[(y + dy) * hg.w + x + dx];
        if (v > h0) { isMax = false; break; }
        if (Math.max(Math.abs(dx), Math.abs(dy)) >= R) { sum += v; cnt++; }
      }
      if (!isMax || cnt === 0) continue;
      const prom = h0 - sum / cnt;
      if (prom < Math.max(10, 0.0025 * S)) continue;
      const p = { x: (x + 0.5) * hg.cell, y: (y + 0.5) * hg.cell };
      if (dist(p, center) < reserve * 1.1 || p.x < S * 0.06 || p.y < S * 0.06 || p.x > S * 0.94 || p.y > S * 0.94) continue;
      picks.push({ p, h: h0 + prom });
    }
    picks.sort((a, b) => b.h - a.h);
    const chosen: typeof picks = [];
    for (const c of picks) { if (chosen.every((o) => dist(o.p, c.p) > S * 0.18) && chosen.length < 3) chosen.push(c); }
    chosen.forEach((c, i) => add({ kind: 'hill', text: V.hill(unique('hill:' + i, 2)), rank: 4, anchor: c.p }));
  }

  // ---- water bodies, forests
  t.lakes.forEach((lk, i) => {
    if (lk.length < 3 || areaOf(lk) < 9000 || i >= 5) return;
    const pole = poleOf(lk);
    add({ kind: 'lake', text: V.lake(unique('lake:' + i, 2)), rank: 2, anchor: pole.p, span: horizontalSpan(lk, pole.p.x, pole.p.y) });
  });
  if (t.seaFraction > 0.02) {
    const hg = t.height;
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < hg.h; y += 3) for (let x = 0; x < hg.w; x += 3) if (t.water[y * hg.w + x] === 1) { sx += x; sy += y; n++; }
    if (n > 20) {
      const mx = sx / n, my = sy / n;
      let best: Vec2 | null = null, bd = Infinity;
      for (let y = 0; y < hg.h; y += 3) for (let x = 0; x < hg.w; x += 3) if (t.water[y * hg.w + x] === 1) {
        const d = (x - mx) ** 2 + (y - my) ** 2;
        if (d < bd) { bd = d; best = { x: (x + 0.5) * hg.cell, y: (y + 0.5) * hg.cell }; }
      }
      if (best) add({ kind: 'sea', text: V.sea(unique('sea', 2)), rank: 1, anchor: best, span: Math.sqrt(n * 9) * hg.cell * 0.8 });
    }
  }
  if (world.landuse) {
    const forests = world.landuse.areas.filter((a) => a.kind === 'forest' && a.poly.length >= 3)
      .map((a) => ({ a, ar: areaOf(a.poly) })).filter((x) => x.ar > 30000).sort((p, q) => q.ar - p.ar);
    const taken: Vec2[] = [];
    for (const f of forests) {
      if (taken.length >= 6) break;
      const pole = poleOf(f.a.poly, f.a.holes);
      if (pole.r < 25 || taken.some((p) => dist(p, pole.p) < 350)) continue;
      taken.push(pole.p);
      add({ kind: 'forest', text: V.forest(unique('forest:' + taken.length, 2)), rank: 3, anchor: pole.p, span: Math.min(horizontalSpan(f.a.poly, pole.p.x, pole.p.y), pole.r * 2.6) });
    }
    world.landuse.farmsteads.slice(0, 10).forEach((f, i) => add({ kind: 'farm', text: V.farm(unique('farm:' + i, 2)), rank: 6, anchor: f.pos }));
  }

  // ---- urban names
  if (u) {
    const used = new Set<string>();
    const pickFrom = (list: string[], r: Rng): string | null => { const l = list.filter((s) => !used.has(s)); return l.length ? r.pick(l) : null; };
    const use = (s: string | null): string | null => { if (s && !used.has(s)) { used.add(s); return s; } return null; };
    const saintOf = (label: string): string => V.saint(rng.fork('saint:' + label));

    // churches & other landmarks
    const churchPts: Vec2[] = [];
    const worship: { c: Vec2; big: boolean }[] = [];
    for (const l of u.landmarks) {
      const k = l.kind;
      if (k.endsWith('-yard') || k === 'market' || k === 'green' || !l.poly.length) continue;
      const c = polygonCentroid(l.poly);
      if (/church|cathedral|mosque|temple|shrine|minster|abbey|monastery/.test(k)) {
        const ex = worship.find((w0) => dist(w0.c, c) < 70);
        if (ex) { ex.big = ex.big || /cathedral/.test(k); continue; }
        worship.push({ c, big: /cathedral/.test(k) });
      } else if (/castle|keep|citadel|palace|kasbah|fort/.test(k)) {
        if (!entries.some((e) => e.kind === 'castle' && dist(e.anchor, c) < 150)) add({ kind: 'castle', text: V.castle(town), rank: 2, anchor: c });
      }
    }
    worship.forEach((w0, i) => {
      const sname = saintOf('church:' + i);
      churchPts.push(w0.c);
      add({ kind: 'church', text: V.worship(sname, w0.big), rank: w0.big ? 1 : 2, anchor: w0.c, sub: sname });
    });

    // squares
    const squareCenters: Vec2[] = [];
    u.squares.forEach((sq, i) => {
      if (sq.length < 3) return;
      const c = polygonCentroid(sq);
      squareCenters.push(c);
      const isMarket = i === 0;
      const nm = isMarket ? (u.landmarks.some((l) => l.kind === 'green') ? pickFrom(V.sq.green, rng.fork('sq:g')) : pickFrom(V.sq.market, rng.fork('sq:m'))) : V.sq.plain(rng.fork('sq:' + i), saintOf('sq:' + i));
      if (nm) { use(nm); add({ kind: 'square', text: nm, rank: 2, anchor: c }); }
    });
    // a landmark market/green without a registered square
    if (!squareCenters.length) {
      const mk = u.landmarks.find((l) => l.kind === 'market' || l.kind === 'green');
      if (mk) { const c = polygonCentroid(mk.poly); squareCenters.push(c); const nm = use(pickFrom(mk.kind === 'green' ? V.sq.green : V.sq.market, rng.fork('sq:0'))); if (nm) add({ kind: 'square', text: nm, rank: 2, anchor: c }); }
    }

    // gates: each regional road names at most one gate (the closest); the others get a compass name
    const gatePts: { p: Vec2; dest: string | null }[] = [];
    {
      const gs: { p: Vec2; i: number }[] = [];
      for (const wl of u.walls ?? []) {
        (wl.gateInfo?.map((g) => g.p) ?? wl.gates).forEach((g) => { if (!gs.some((o) => dist(o.p, g) < 25)) gs.push({ p: g, i: gs.length }); });
      }
      const pairs: { g: number; r: number; d: number }[] = [];
      gs.forEach((g, gi) => roadInfos.forEach((r, ri) => { const d = distToPolyline(g.p, r.path); if (d < 160) pairs.push({ g: gi, r: ri, d }); }));
      pairs.sort((a, b) => a.d - b.d);
      const gDest = new Map<number, RoadInfo>(), rUsed = new Set<number>();
      for (const pr of pairs) if (!gDest.has(pr.g) && !rUsed.has(pr.r)) { gDest.set(pr.g, roadInfos[pr.r]); rUsed.add(pr.r); }
      gs.forEach((g, gi) => {
        const road = gDest.get(gi);
        let text = road ? (V.gateOf ? V.gateOf(road.dest) : `${road.dest} Gate`) : V.gateDir(V.dirs[dirOf(center, g.p)]);
        if (used.has(text)) text += ' II';
        used.add(text);
        gatePts.push({ p: g.p, dest: road?.dest ?? null });
        add({ kind: 'gate', text, rank: 3, anchor: g.p, sub: String(g.i) });
      });
    }

    // streets
    const maxNamed = pop < 1500 ? 14 : pop < 8000 ? 40 : 70;
    const cands = u.streets.map((s, i) => ({ s, i, len: polylineLength(s.path) }))
      .filter((x) => x.s.role !== 'close' && x.s.role !== 'track' && x.s.role !== 'boundary' && x.s.path.length >= 2 && x.len >= (x.s.rank <= 2 ? 40 : 80))
      .sort((a, b) => a.s.rank - b.s.rank || b.len - a.len);
    const mainRivers = t.rivers.filter((r) => r.path.length > 4);
    const bridgePts = (world.bridges ?? []).map((b) => ({ x: (b.a.x + b.b.x) / 2, y: (b.a.y + b.b.y) / 2 }));
    const crafts = Object.keys(V.crafts);
    const flags = { main: false, market: false, bridge: false, riverside: 0, wall: 0, ring: 0, quay: 0 };
    const nearSet = (pl: Polyline, pts: Vec2[], d: number): boolean => pts.length > 0 && minDistToPts(pl, pts) < d;
    let named = 0;
    const longestRank0 = cands.filter((c) => c.s.rank === 0).map((c) => ({ c, d: minDistToPts(c.s.path, squareCenters.length ? squareCenters : [center]) })).sort((a, b) => a.d - b.d)[0]?.c;
    for (const { s, i, len } of cands) {
      if (named >= maxNamed) break;
      const r = rng.fork('street:' + i);
      const mid = pathMid(s.path);
      let text: string | null = null;
      if (s.role === 'quay' && flags.quay < 2) { text = use(pickFrom(V.st.quay, r)); if (text) flags.quay++; }
      if (!text && s.rank === 0) {
        if (!flags.main && (longestRank0 === undefined || longestRank0.i === i)) { text = use(pickFrom(V.st.main, r)); if (text) flags.main = true; }
        if (!text) {
          const road = nearestRoad(mid, 400) ?? nearestRoad(s.path[s.path.length - 1]);
          if (road) text = use(V.st.dest(road.dest));
        }
        if (!text) text = use(pickFrom(V.st.main, r));
      }
      if (!text && s.role === 'ring' && flags.ring < 3) { text = use(pickFrom(V.st.ring, r)); if (text) flags.ring++; }
      if (!text && s.role === 'wall-lane' && flags.wall < 2) { text = use(pickFrom(V.st.wall, r)); if (text) flags.wall++; }
      if (!text && !flags.market && nearSet(s.path, squareCenters, 35)) { text = use(pickFrom(V.st.market, r)); if (text) flags.market = true; }
      if (!text && nearSet(s.path, churchPts, 35)) { const ch = entries.find((e) => e.kind === 'church' && dist(e.anchor, mid) < 120); if (ch?.sub) text = use(V.st.church(ch.sub)); }
      if (!text && !flags.bridge && nearSet(s.path, bridgePts, 40)) { text = use(pickFrom(V.st.bridge, r)); if (text) flags.bridge = true; }
      if (!text && s.rank >= 1 && flags.riverside < 3 && mainRivers.some((rv) => s.path.some((p) => distToPolyline(p, rv.path) < 30))) {
        if (s.rank >= 2 && r.chance(0.6)) text = use(V.st.craft(V.crafts[r.chance(0.5) ? 'tanner' : 'dyer']));
        if (!text) text = use(pickFrom(V.st.riverside, r));
        if (text) flags.riverside++;
      }
      if (!text && s.rank >= 1 && gatePts.some((g) => minDistToPts([s.path[0], s.path[s.path.length - 1]], [g.p]) < 50)) {
        const g = gatePts.find((gg) => minDistToPts([s.path[0], s.path[s.path.length - 1]], [gg.p]) < 50)!;
        text = use(g.dest ? V.st.gate(g.dest) : V.st.craft(V.crafts.smith));
      }
      for (let a = 0; !text && a < 8; a++) {
        const rr = r.fork('fb' + a);
        const roll = rr.float();
        const cand = roll < 0.45 ? V.st.craft(V.crafts[rr.pick(crafts)]) : roll < 0.55 ? V.st.church(saintOf('st:' + i + ':' + a)) : V.st.minor(rr);
        text = use(cand);
      }
      if (!text) { text = use(V.st.minor(r) + ' ' + (i % 9 + 2)); }
      if (!text) continue;
      named++;
      add({ kind: 'street', text, rank: s.rank, anchor: mid, path: s.path, sub: String(len | 0) });
    }

    // quarters: the core gets one "old town" name (anchored on the union of its sectors), every other sector its own name
    if (u.quarters.length >= 2) {
      const core = u.quarters.filter((q) => q.zone === 'core');
      const groupCore = core.length >= 3;
      if (core.length) {
        const pts = core.flatMap((q) => q.poly.outer);
        const bb = bbox(pts);
        const oldName = use(pickFrom(V.old, rng.fork('old')));
        if (oldName) add({ kind: 'quarter', text: oldName, rank: 1, anchor: { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 }, span: (bb.maxX - bb.minX) * 0.75, sub: 'old' });
      }
      const order = u.quarters.map((q, i) => ({ q, i, ar: areaOf(q.poly.outer) })).sort((a, b) => b.ar - a.ar);
      for (const { q, i, ar } of order) {
        if (ar < 2500 || (groupCore && q.zone === 'core')) continue;
        const r = rng.fork('quarter:' + i);
        const pole = poleOf(q.poly.outer, q.poly.holes);
        const c = polygonCentroid(q.poly.outer);
        const kind = q.zone === 'faubourg' ? 'faubourg' : q.zone === 'village' ? 'village' : q.zone === 'edge' ? 'edge' : 'ring';
        let text: string | null = null;
        for (let a = 0; !text && a < 6; a++) {
          const rr = r.fork('q' + a);
          text = use(V.ward(rr, kind, saintOf(`q${i}:${a}`), V.dirs[dirOf(center, c)], V.crafts[rr.pick(crafts)]));
        }
        if (text) add({ kind: 'quarter', text, rank: 2, anchor: pole.p, span: horizontalSpan(q.poly.outer, pole.p.x, pole.p.y) || pole.r * 2 });
      }
    }
  }

  return { family, town, entries };
}

export const SETTLEMENT_CLASS = (family: NameFamily, pop: number): string => {
  const c = VOCAB[family].class;
  return pop < 100 ? c[0] : pop < 1000 ? c[1] : pop < 5000 ? c[2] : pop < 30000 ? c[3] : c[4];
};
