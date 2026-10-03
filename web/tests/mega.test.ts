/**
 * Megacity scaling (URBAN_MORPHOLOGY §3d): eager threshold, lazy quarter detail equal to the eagerly generated
 * quarter whatever the order, quarters tiling the built-up land, determinism; macro timings with BURGMAP_PERF=1.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { generate, generateSettlementDetail, EAGER_MAIN_POP } from '../src/gen/pipeline';
import { makeOptions, toQuery, fromQuery } from '../src/gen/options';
import type { World, Polygon } from '../src/gen/types';
import { megaQuarterDetail, megaKey } from '../src/gen/urban/mega/detail';
import { QuarterQueue } from '../src/ui/megaQueue';
import { mpArea, intersectionS, differenceS } from '../src/gen/geo/bool';
import { area } from '../src/gen/geo/poly';
import { renderView } from '../src/gen/settlements/merge';

const T = 900000;
const j = (x: unknown): string => JSON.stringify(x);
/** The quarters nearest the plan's centre (a contiguous patch of the city). */
function central(w: World, n: number): number[] {
  const M = w.urban!.macro!;
  return M.quarters.map((q) => ({ id: q.id, d: Math.hypot((q.bb[0] + q.bb[2]) / 2 - M.center.x, (q.bb[1] + q.bb[3]) / 2 - M.center.y) }))
    .sort((a, b) => a.d - b.d).slice(0, n).map((x) => x.id);
}

describe('eager threshold', () => {
  it('is configurable and round-trips in the URL', () => {
    const o = makeOptions({ seed: '2', population: 70000, eagerPop: 100000 });
    expect(fromQuery(toQuery(o)).eagerPop).toBe(100000);
    expect(toQuery(makeOptions({}))).toBe('seed=1');
    expect(EAGER_MAIN_POP).toBe(40000);
  });
  it('keeps a town at or below the threshold eager, plans a larger one as macro + lazy quarters', () => {
    const base = { seed: '5', mapSize: 4000, population: 9000, settlements: 'none' as const };
    const eager = generate(makeOptions({ ...base, eagerPop: 9000 }));
    expect(eager.urban!.macro).toBeUndefined();
    expect(eager.urban!.buildings.length).toBeGreaterThan(500);
    const lazy = generate(makeOptions({ ...base, eagerPop: 8999 }));
    const M = lazy.urban!.macro!;
    expect(M).toBeDefined();
    expect(lazy.urban!.buildings.length).toBe(0);
    expect(M.quarters.length).toBeGreaterThan(10);
    expect(lazy.urban!.walls!.length).toBeGreaterThan(0);
  }, T);
});

describe('megacity near the threshold (60 000 inhabitants)', () => {
  const opts = makeOptions({ seed: '7', mapSize: 7000, population: 60000, settlements: 'none' });
  let w1: World, w2: World;
  let ids: number[];
  const lazy = new Map<number, string>();
  beforeAll(() => {
    w1 = generate(opts);
    w2 = generate(opts);
    ids = central(w1, 10);
    for (const id of ids) lazy.set(id, j(megaQuarterDetail(w1, id)));
  }, T);

  it('macro plan is deterministic', () => {
    expect(j(w1.urban!.macro)).toBe(j(w2.urban!.macro));
    expect(j(w1.urban!.streets)).toBe(j(w2.urban!.streets));
    expect(j(w1.urban!.walls)).toBe(j(w2.urban!.walls));
  });

  it('a lazy quarter equals the same quarter generated eagerly (all quarters, another World)', () => {
    const all = new QuarterQueue(w2, () => {}).all();
    expect(Object.keys(all).length).toBe(w2.urban!.macro!.quarters.length);
    for (const id of ids) expect(j(all[id])).toBe(lazy.get(id));
  }, T);

  it('does not depend on the generation order', () => {
    const w3 = structuredClone(w1);
    for (const id of ids.slice().reverse()) expect(j(megaQuarterDetail(w3, id))).toBe(lazy.get(id));
  }, T);

  it('quarters tile the built-up land without overlaps or gaps', () => {
    const M = w1.urban!.macro!;
    const qa = M.quarters.reduce((s, q) => s + area(q.pts), 0);
    const land = mpArea(w1.urban!.footprintH);
    // (cells under 150 m² left at the water's edge are the only allowed loss)
    expect(Math.abs(qa - land) / land).toBeLessThan(0.005);
    let overlap = 0;
    for (let a = 0; a < M.quarters.length; a++) for (let b = a + 1; b < M.quarters.length; b++) {
      const A = M.quarters[a], B = M.quarters[b];
      if (A.bb[0] > B.bb[2] || B.bb[0] > A.bb[2] || A.bb[1] > B.bb[3] || B.bb[1] > A.bb[3]) continue;
      overlap += mpArea(intersectionS(A.pts, B.pts));
    }
    expect(overlap).toBeLessThan(1);
    // every edge of a quarter lies on a street, a wall, the water or the open edge of the city
    for (const q of M.quarters) expect(q.lab.length).toBe(q.pts.length);
  });

  it('detail stays inside its quarter (tiles meet at the arterials)', () => {
    const M = w1.urban!.macro!;
    for (const id of ids) {
      const d = JSON.parse(lazy.get(id)!) as { blocks: Polygon[]; buildings: { poly: Polygon }[] };
      expect(d.blocks.length).toBeGreaterThan(0);
      for (const b of d.blocks) expect(mpArea(differenceS(b, M.quarters[id].pts))).toBeLessThan(0.5);
    }
  });

  it('walls are polygonal: long straight runs, towers at most ~85 m apart, consecutive growth lines never cross', () => {
    const M = w1.urban!.macro!;
    const walls = (w1.urban!.walls ?? []).filter((x) => x.role === 'town' || x.role === 'outer' || x.role === 'quarter');
    expect(walls.length).toBeGreaterThan(0);
    for (const wl of walls) {
      const p = wl.path;
      let L = 0;
      for (let i = 0; i < p.length; i++) L += Math.hypot(p[(i + 1) % p.length].x - p[i].x, p[(i + 1) % p.length].y - p[i].y);
      expect(L / p.length).toBeGreaterThan(80);
      for (const [a, b] of wl.curtains ?? []) expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(100);
    }
    const same = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x === b.x && a.y === b.y;
    for (let k = 1; k < M.rings.length; k++) {
      const A = M.rings[k], B = M.rings[k - 1];
      for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) {
        const a0 = A[i], a1 = A[(i + 1) % A.length], b0 = B[j], b1 = B[(j + 1) % B.length];
        if (same(a0, b0) || same(a0, b1) || same(a1, b0) || same(a1, b1)) continue;
        const d = (p: typeof a0, q: typeof a0, r: typeof a0) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
        const cross = d(a0, a1, b0) * d(a0, a1, b1) < 0 && d(b0, b1, a0) * d(b0, b1, a1) < 0;
        expect(cross).toBe(false);
      }
    }
  });

  it('streets continue across the arterials: quarters on both sides start streets at shared anchors', () => {
    const M = w1.urban!.macro!;
    const ends = new Map<number, { x: number; y: number }[]>();
    for (const id of ids) ends.set(id, (JSON.parse(lazy.get(id)!) as { streets: { path: { x: number; y: number }[] }[] }).streets.flatMap((s) => [s.path[0], s.path[s.path.length - 1]]));
    let both = 0, used = 0;
    M.streets.forEach((st, si) => {
      const qs = ids.filter((id) => M.quarters[id].lab.includes(si));
      if (qs.length < 2) return;
      for (const a of st.anchors ?? []) {
        const n = qs.filter((id) => ends.get(id)!.some((e) => Math.hypot(e.x - a.x, e.y - a.y) < 0.5)).length;
        if (n) used++;
        if (n >= 2) both++;
      }
    });
    expect(used).toBeGreaterThan(0);
    expect(both / used).toBeGreaterThan(0.25);
  });

  it('the render view merges the detailed quarters and stands in for the others', () => {
    const det: Record<number, NonNullable<World['urban']>> = {};
    for (const id of ids) det[id] = JSON.parse(lazy.get(id)!);
    const v = renderView({ ...w1, megaDetail: det }).urban!;
    expect(v.macro).toBeUndefined();
    expect(v.buildings.length).toBe(ids.reduce((s, id) => s + det[id].buildings.length, 0));
    expect(renderView({ ...w1, urban: v }).urban).toBe(v); // merging is idempotent
  });
});

describe('a big secondary settlement is planned as a megacity', () => {
  const opts = makeOptions({ seed: '4', mapSize: 9000, population: 9000, settlements: { list: [{ population: 70000 }] } });
  let w: World, w2: World, si: number;
  beforeAll(() => {
    w = generate(opts);
    w2 = generate(opts);
    si = w.settlements!.findIndex((s) => !s.main && s.population === 70000);
  }, T);

  it('gets a macro plan as its lazy detail, and its quarters detail lazily, deterministically', () => {
    expect(si).toBeGreaterThan(0);
    expect(w.settlements![si].detail).toBe('lazy');
    const r = generateSettlementDetail(w, si)!;
    expect(r.urban.macro).toBeDefined();
    expect(r.urban.buildings.length).toBe(0);
    w.settlements![si].urban = r.urban;
    w2.settlements![si].urban = generateSettlementDetail(w2, si)!.urban;
    const M = r.urban.macro!;
    expect(M.quarters.length).toBeGreaterThan(10);
    const ks = M.quarters.slice(0, 4).map((q) => megaKey(si, q.id));
    const det: Record<number, NonNullable<World['urban']>> = {};
    for (const k of ks) { det[k] = megaQuarterDetail(w, k)!; expect(j(det[k])).toBe(j(megaQuarterDetail(w2, k))); }
    expect(Object.values(det).some((d) => d.buildings.length > 0)).toBe(true);
    // the render view shows them with the main settlement
    const v = renderView({ ...w, megaDetail: det }).urban!;
    expect(v.buildings.length).toBeGreaterThanOrEqual(Object.values(det).reduce((s, d) => s + d.buildings.length, 0));
    // the queue serves the secondary plan too
    expect(new QuarterQueue(w, () => {}).total).toBe(M.quarters.length + (w.urban?.macro?.quarters.length ?? 0));
  }, T);
});

describe.runIf(!!process.env.BURGMAP_PERF)('megacity timings (BURGMAP_PERF=1)', () => {
  for (const [pop, map, budget] of [[1000000, 20000, 1500], [5000000, 40000, 3000]] as const) {
    it(`macro plan of ${pop} inhabitants under ${budget} ms, quarters under 300 ms`, () => {
      const w = generate(makeOptions({ seed: '3', population: pop, mapSize: map }));
      const ms = Number(w.stats['ms.urban']);
      const qs = central(w, 24);
      const t0 = performance.now();
      for (const id of qs) megaQuarterDetail(w, id);
      const qms = (performance.now() - t0) / qs.length;
      console.log(`[mega] ${pop}: macro ${ms} ms, ${w.urban!.macro!.quarters.length} quarters, detail ${Math.round(qms)} ms/quarter, world ${w.stats['ms.total']} ms`);
      expect(ms).toBeLessThan(budget);
      expect(qms).toBeLessThan(300);
    }, T);
  }
});
