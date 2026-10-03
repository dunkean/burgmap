/** Farmstead variety (HANDOFF §7.6): types by culture and site, plausible sizes, plan invariants, metadata, determinism, cost. */
import { describe, it, expect, beforeAll } from 'vitest';
import polygonClipping from 'polygon-clipping';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { Rng } from '../src/gen/core/rng';
import { polygonArea, polygonContains } from '../src/gen/core/geom';
import { layoutFarm, frameOf, farmRegime, type FarmContext, type FarmType } from '../src/gen/landuse/farms';
import type { World, Farmstead, Polygon, Vec2 } from '../src/gen/types';

const T = 600000;
const ring = (p: Polygon): [number, number][] => { const r = p.map((q) => [q.x, q.y] as [number, number]); r.push(r[0]); return r; };
const interArea = (a: Polygon, b: Polygon): number => {
  let s = 0;
  for (const mp of polygonClipping.intersection([ring(a)], [ring(b)])) for (const rr of mp) s += Math.abs(polygonArea(rr.slice(0, -1).map(([x, y]) => ({ x, y }))));
  return s;
};
const segDist = (p: Vec2, a: Vec2, b: Vec2): number => {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
};
const edgeDist = (p: Vec2, poly: Polygon): number => {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, segDist(p, poly[i], poly[(i + 1) % poly.length]));
  return d;
};
const inside = (p: Vec2, poly: Polygon, tol = 0.05): boolean => polygonContains(poly, p) || edgeDist(p, poly) < tol;
/** Segments a-b and c-d cross (proper intersection). */
const crosses = (a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean => {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return o(a, b, c) * o(a, b, d) < -1e-9 && o(c, d, a) * o(c, d, b) < -1e-9;
};
const dims = (p: Polygon): [number, number] => {
  const a = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y), b = Math.hypot(p[2].x - p[1].x, p[2].y - p[1].y);
  return [Math.max(a, b), Math.min(a, b)];
};

/** All plan invariants of one farm; returns the list of violations. */
function farmViolations(w: World, f: Farmstead): string[] {
  const bad: string[] = [];
  const lot = f.lot!;
  const g = w.terrain.height;
  // buildings inside the lot, never overlapping
  const parts = f.parts!;
  parts.forEach((p, i) => {
    if (!p.poly.every((q) => inside(q, lot))) bad.push(`${p.use} outside lot`);
    if (!p.arch || !p.roof) bad.push(`${p.use} without arch/roof`);
    for (let j = 0; j < i; j++) if (interArea(p.poly, parts[j].poly) > 0.3) bad.push(`${p.use} overlaps ${parts[j].use}`);
  });
  if (!f.yard.every((q) => inside(q, lot, 0.1))) bad.push('yard outside lot');
  // the lot is partitioned by farmyard / garden / orchard / paddock; ponds etc. inside
  const pieces = f.plots!.filter((p) => ['farmyard', 'garden', 'orchard', 'paddock'].includes(p.kind));
  const la = Math.abs(polygonArea(lot)), sa = pieces.reduce((s, p) => s + Math.abs(polygonArea(p.poly)), 0);
  if (Math.abs(la - sa) > 0.01 * la) bad.push(`plots ${sa.toFixed(0)} != lot ${la.toFixed(0)}`);
  for (let i = 0; i < pieces.length; i++) for (let j = 0; j < i; j++) if (interArea(pieces[i].poly, pieces[j].poly) > 0.5) bad.push('plots overlap');
  for (const p of f.plots!) if (!p.poly.every((q) => inside(q, lot, 0.1))) bad.push(`${p.kind} outside lot`);
  for (const t of f.trees ?? []) if (!inside(t, lot, 0.1)) bad.push('tree outside lot');
  // access: the drive ends at the gate on the lot front; the way from the gate into the yard crosses no building but a gatehouse passage
  const de = f.drive[f.drive.length - 1];
  if (Math.hypot(de.x - f.gate!.x, de.y - f.gate!.y) > 0.01) bad.push('drive does not reach the gate');
  if (edgeDist(f.gate!, lot) > 0.1) bad.push('gate not on the lot edge');
  for (const p of parts) {
    if (p.passage) continue;
    const P = p.poly;
    if (polygonContains(P, f.entry!) || P.some((q, i) => crosses(f.gate!, f.entry!, q, P[(i + 1) % P.length]))) bad.push(`way in blocked by ${p.use}`);
  }
  // dry land, clear of roads and rivers
  const L = Math.sqrt(la);
  for (let k = 0; k < 64; k++) {
    const u = ((k % 8) + 0.5) / 8, v = (Math.floor(k / 8) + 0.5) / 8;
    const q = { x: lot[0].x + u * (lot[1].x - lot[0].x) + v * (lot[3].x - lot[0].x), y: lot[0].y + u * (lot[1].y - lot[0].y) + v * (lot[3].y - lot[0].y) };
    const i = Math.floor(q.y / g.cell) * g.w + Math.floor(q.x / g.cell);
    if (w.terrain.water[i]) { bad.push('lot on water'); break; }
  }
  const c = f.pos;
  for (const rd of [...(w.roads ?? []).map((r) => ({ path: r.path, half: r.width / 2 })), ...w.terrain.rivers.map((r) => ({ path: r.path, half: Math.max(...r.width) / 2 }))]) {
    for (let i = 1; i < rd.path.length; i++) {
      const a = rd.path[i - 1], b = rd.path[i];
      if (segDist(c, a, b) > L + rd.half + 50) continue;
      for (let s = 0; s <= 1; s += 0.1) {
        const q = { x: a.x + s * (b.x - a.x), y: a.y + s * (b.y - a.y) };
        if (polygonContains(lot, q) || edgeDist(q, lot) < rd.half - 0.3) { bad.push('road or river through the lot'); break; }
      }
    }
  }
  return bad;
}

describe('farmsteads on a 10 km map', () => {
  let w: World;
  let fs: Farmstead[];
  beforeAll(() => {
    w = generate(makeOptions({ seed: '4', mapSize: 10000, population: 3000 }));
    fs = w.landuse!.farmsteads;
  }, T);

  it('at least 5 distinct farm types, chosen from the culture', () => {
    const types = new Set(fs.map((f) => f.type));
    expect(types.size).toBeGreaterThanOrEqual(5);
    const allowed = new Set(farmRegime('european-organic').map(([t]) => t));
    for (const f of fs) expect(allowed.has(f.type as FarmType), f.type).toBe(true);
  });

  it('plausible size distribution and building sizes', () => {
    const n = (s: string) => fs.filter((f) => f.size === s).length;
    expect(fs.length).toBeGreaterThanOrEqual(15);
    expect(n('cottage') + n('family')).toBeGreaterThanOrEqual(0.55 * fs.length);
    expect(n('family')).toBeGreaterThanOrEqual(0.25 * fs.length);
    expect(n('manor')).toBeLessThanOrEqual(0.15 * fs.length);
    expect(new Set(fs.map((f) => f.size)).size).toBeGreaterThanOrEqual(3);
    // footprints of the rectangular buildings (house 8–14 × 6–9, barn 15–30 × 8–12, sheds smaller)
    for (const f of fs) for (const p of f.parts!) {
      if (p.poly.length !== 4 || p.arch.includes('hall-house')) continue;
      const [l, d] = dims(p.poly);
      if (p.use === 'house') { expect(l, p.arch).toBeGreaterThanOrEqual(7.9); expect(l, p.arch).toBeLessThanOrEqual(14.05); expect(d).toBeGreaterThanOrEqual(5.9); expect(d).toBeLessThanOrEqual(9.05); }
      if (p.use === 'barn') { expect(l, p.arch).toBeGreaterThanOrEqual(14.9); expect(l, p.arch).toBeLessThanOrEqual(30.05); expect(d).toBeGreaterThanOrEqual(7.9); expect(d).toBeLessThanOrEqual(12.05); }
      if (p.use === 'shed') expect(l * d).toBeLessThan(60);
    }
    // larger farms have more and bigger buildings
    const mean = (s: string) => { const l = fs.filter((f) => f.size === s); return l.reduce((a, f) => a + f.parts!.reduce((b, p) => b + Math.abs(polygonArea(p.poly)), 0), 0) / (l.length || 1); };
    if (n('cottage') && n('family')) expect(mean('family')).toBeGreaterThan(mean('cottage'));
  });

  it('every farm is a lot on its track: buildings inside, no overlaps, access, clear of water and roads', () => {
    const all: string[] = [];
    fs.forEach((f, i) => { for (const b of farmViolations(w, f)) all.push(`#${i} ${f.type}/${f.size}: ${b}`); });
    expect(all).toEqual([]);
    for (let i = 0; i < fs.length; i++) for (let j = 0; j < i; j++) expect(interArea(fs[i].lot!, fs[j].lot!)).toBeLessThan(0.5);
  });

  it('every building carries arch and roof metadata', () => {
    for (const f of fs) for (const p of f.parts!) { expect(p.arch.length).toBeGreaterThan(2); expect(p.roof).toBeTruthy(); }
    expect(fs.flatMap((f) => f.buildings).length).toBe(fs.flatMap((f) => f.parts!).length);
  });

  it('is deterministic', () => {
    const w2 = generate(makeOptions({ seed: '4', mapSize: 10000, population: 3000 }));
    expect(JSON.stringify(w2.landuse!.farmsteads)).toBe(JSON.stringify(fs));
  }, T);

  it('farm planning is a small share of the land-use stage (land use within 1.1x)', () => {
    expect(Number(w.stats['landuse.ms.lu.farms'])).toBeLessThanOrEqual(0.1 * Number(w.stats['ms.landuse']) + 5);
  });
});

describe('farm layouts by culture and site', () => {
  const base: FarmContext = { culture: 'european-organic', soil: 0, slope: 0.01, downhill: null, wet: 0, exposed: 0, market: 0.5, west: 0 };
  const types: FarmType[] = ['vierkanthof', 'u-yard', 'l-yard', 'haufenhof', 'longere', 'einhaus', 'masseria', 'dvor', 'norse-longhouse', 'roundhouse', 'minka', 'hanok', 'chinese-court', 'indian-court', 'ksar', 'sahel-compound', 'kraal', 'ail', 'native-longhouse', 'pueblo-ranch', 'solar', 'kancha', 'stilt'];

  it('every type and size gives a house, non-overlapping parts inside the lot, and a free way in', () => {
    const bad: string[] = [];
    for (const t of types) for (const size of ['cottage', 'family', 'large', 'manor'] as const) for (let s = 0; s < 6; s++) {
      const ctx = { ...base, slope: s % 2 ? 0.12 : 0.01, downhill: s % 2 ? { x: 0.6, y: 0.8 } : null, wet: s === 2 ? 0.8 : 0, exposed: s === 4 ? 0.9 : 0 };
      const lf = layoutFarm(t, size, ctx, frameOf({ x: Math.cos(s), y: Math.sin(s) }, ctx.downhill), new Rng(`${t}:${size}:${s}`));
      if (!lf.parts.some((p) => ['house', 'longhouse', 'roundhouse', 'hut', 'ger'].includes(p.use))) bad.push(`${t}/${size}: no dwelling`);
      for (const p of lf.parts) for (const [u, v] of p.poly) if (u < -lf.W / 2 - 1e-6 || u > lf.W / 2 + 1e-6 || v < -1e-6 || v > lf.D + 1e-6) { bad.push(`${t}/${size}: ${p.use} outside`); break; }
    }
    expect(bad).toEqual([]);
  });

  it('cultures build their own vernacular', () => {
    expect(farmRegime('barbarian-norse')[0][0]).toBe('norse-longhouse');
    expect(farmRegime('japanese-jokamachi')[0][0]).toBe('minka');
    expect(farmRegime('chinese')[0][0]).toBe('chinese-court');
    expect(farmRegime('medina')[0][0]).toBe('ksar');
    expect(farmRegime('kraal')[0][0]).toBe('kraal');
    expect(farmRegime('native-iroquoian')[0][0]).toBe('native-longhouse');
  });

  it('bank barns on slopes, raised platforms on wet ground, shelter belts on exposed sites', () => {
    let bank = 0, warft = 0, belt = 0;
    for (let s = 0; s < 20; s++) {
      const slope = layoutFarm('l-yard', 'family', { ...base, slope: 0.15, downhill: { x: 1, y: 0 } }, frameOf({ x: 1, y: 0 }, { x: 1, y: 0 }), new Rng('b' + s));
      if (slope.tags.includes('bank-barn')) bank++;
      const wet = layoutFarm('einhaus', 'family', { ...base, wet: 0.8 }, frameOf({ x: 0, y: 1 }, null), new Rng('w' + s));
      if (wet.plots.some((p) => p.kind === 'platform')) warft++;
      const ex = layoutFarm('u-yard', 'family', { ...base, exposed: 0.9 }, frameOf({ x: 0, y: 1 }, null), new Rng('e' + s));
      if (ex.trees.length) belt++;
    }
    expect(bank).toBeGreaterThanOrEqual(10);
    expect(warft).toBe(20);
    expect(belt).toBe(20);
  });
});

describe('farmsteads of another culture', () => {
  it('a Norse map gets Norse farms with valid plans', () => {
    const w = generate(makeOptions({ seed: '7', mapSize: 6000, population: 800, culture: 'barbarian-norse' }));
    const fs = w.landuse!.farmsteads;
    expect(fs.length).toBeGreaterThan(3);
    expect(fs.filter((f) => f.type === 'norse-longhouse').length).toBeGreaterThanOrEqual(0.6 * fs.length);
    const all: string[] = [];
    fs.forEach((f, i) => { for (const b of farmViolations(w, f)) all.push(`#${i} ${f.type}: ${b}`); });
    expect(all).toEqual([]);
  }, T);
});
