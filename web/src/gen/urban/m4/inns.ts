/**
 * Inns, stables and smithies at the gates (URBAN_LANDMARKS.md §2): near each gate, 3–4 consecutive burgage plots
 * fronting the entrance road are merged into one lot (the union of adjacent plots along a run, URBAN_GEOMETRY
 * §3.4) and built as a courtyard inn: a front range pierced by a carriage gateway, a side range and a stable range
 * at the back round the yard. The plot next to it becomes the smithy.
 */
import type { Vec2, Polygon } from '../../core/geom';
import { dist } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { Plot } from '../plots';
import { clipPlot, shapeOf } from '../buildings';
import { area, cleanRing } from '../../geo/poly';
import { unionS } from '../../geo/bool';
import { isConvex } from '../../geo/split';

export interface InnPick { plots: Plot[]; poly: Polygon; front: [Vec2, Vec2]; smithy: Plot | null }

/** Picks runs of plots to merge near the gates (one inn per gate). */
export function pickInns(plots: Plot[], gates: { p: Vec2; street: number }[], streetOf: (pl: Plot) => number, rng: Rng): InnPick[] {
  const out: InnPick[] = [];
  const used = new Set<Plot>();
  const byRun = new Map<string, Plot[]>();
  for (const pl of plots) {
    const k = pl.block + ':' + pl.run;
    if (!byRun.has(k)) byRun.set(k, []);
    byRun.get(k)!.push(pl);
  }
  for (const list of byRun.values()) list.sort((a, b) => a.order - b.order);
  for (const g of gates) {
    let best: { run: Plot[]; i: number; k: number; d: number } | null = null;
    for (const list of byRun.values()) {
      if (!list.length || streetOf(list[0]) !== g.street) continue;
      for (let i = 0; i < list.length; i++) {
        let W = 0, k = 0;
        for (let j = i; j < list.length && W < 18; j++) { W += dist(list[j].front[0], list[j].front[1]); k++; }
        if (W < 16 || W > 34 || k < 2 || k > 5) continue;
        const run = list.slice(i, i + k);
        if (run.some((p) => used.has(p) || p.depth < 18 || p.wide)) continue;
        const m = { x: (run[0].front[0].x + run[k - 1].front[1].x) / 2, y: (run[0].front[0].y + run[k - 1].front[1].y) / 2 };
        const d = dist(m, g.p);
        if (d > 160) continue;
        if (!best || d < best.d) best = { run: list, i, k, d };
      }
    }
    if (!best) continue;
    const run = best.run.slice(best.i, best.i + best.k);
    const u = unionS(run[0].poly, ...run.slice(1).map((p) => [{ outer: p.poly, holes: [] }]));
    if (u.length !== 1 || u[0].holes.length) continue;
    const poly = cleanRing(u[0].outer, 0.02, 0.3, 0.002, false);
    if (poly.length < 3 || Math.abs(area(poly) - run.reduce((s, p) => s + area(p.poly), 0)) > 0.5) continue;
    run.forEach((p) => used.add(p));
    const nb = best.run[best.i + best.k] ?? best.run[best.i - 1] ?? null;
    const smithy = nb && !used.has(nb) ? nb : null;
    if (smithy) used.add(smithy);
    out.push({ plots: run, poly, front: [run[0].front[0], run[run.length - 1].front[1]], smithy });
  }
  void rng;
  return out;
}

/** Courtyard inn on the merged lot: front ranges either side of a carriage gateway, a side range, stables behind. */
export function innBuildings(poly: Polygon, front: [Vec2, Vec2], nrm: Vec2, rng: Rng): { poly: Polygon; arch: string }[] {
  const [fa, fb] = front;
  const L = dist(fa, fb);
  const t = { x: (fb.x - fa.x) / L, y: (fb.y - fa.y) / L };
  let n = { x: -t.y, y: t.x };
  if (n.x * nrm.x + n.y * nrm.y < 0) n = { x: -n.x, y: -n.y };
  let D = 0;
  for (const q of poly) D = Math.max(D, (q.x - fa.x) * n.x + (q.y - fa.y) * n.y);
  const at = (u: number, d: number): Vec2 => ({ x: fa.x + t.x * u + n.x * d, y: fa.y + t.y * u + n.y * d });
  const rect = (u0: number, u1: number, d0: number, d1: number) => [
    { p: at(u0, 0), n: t }, { p: at(u1, 0), n: { x: -t.x, y: -t.y } }, { p: at(0, d0), n }, { p: at(0, d1), n: { x: -n.x, y: -n.y } },
  ];
  const conv = isConvex(poly, 1e-3);
  const out: { poly: Polygon; arch: string }[] = [];
  const add = (u0: number, u1: number, d0: number, d1: number, arch: string) => {
    for (const r of clipPlot(poly, rect(u0, u1, d0, d1), conv)) {
      const c = cleanRing(r, 0.02, 0.5, 0.002, false);
      if (c.length < 3 || area(c) < 20) continue;
      const s = shapeOf(c);
      if (s.w < 4.6 || s.asp > 3) continue;
      out.push({ poly: c, arch });
    }
  };
  const fd = rng.range(8, 10);
  const gw = 3.4, gu = L * rng.range(0.35, 0.6);
  add(0.3, gu - gw / 2, 0.3, fd, 'courtyard-inn');
  add(gu + gw / 2, L - 0.3, 0.3, fd, 'courtyard-inn');
  const rear = Math.min(D - 0.5, rng.range(26, 34));
  if (rear - fd > 16) {
    add(0.3, 6.8, fd + 0.01, rear - 7.5, 'inn-range');
    // the stables across the back, in two halves when long (no matchsticks)
    const half = L / 2;
    if (L / 7 > 3) { add(0.3, half, rear - 7, rear, 'stables'); add(half + 0.01, L - 0.3, rear - 7, rear, 'stables'); } else add(0.3, L - 0.3, rear - 7, rear, 'stables');
  }
  return out;
}
