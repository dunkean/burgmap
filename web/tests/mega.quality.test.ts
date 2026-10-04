import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { generate, generationMapSize } from '../src/gen/pipeline';
import { makeOptions, mapSizeOf, CULTURES } from '../src/gen/options';
import type { Polygon, Vec2 } from '../src/gen/core/geom';
import type { MacroQuarter } from '../src/gen/urban/mega/types';
import { standIn, STAND_IN_BUDGET, fabricBudget, type FabricBudget } from '../src/gen/urban/mega/standin';
import { renderView } from '../src/gen/settlements/merge';
import { containMegaRings } from '../src/gen/urban/mega/extent';
import { villageGreen } from '../src/gen/urban/m4/suburbs';
import { reserveVillages } from '../src/gen/urban/m4/suburbs';
import { Streets } from '../src/gen/urban/streets';
import { Rng } from '../src/gen/core/rng';
import { area, bboxOf, distToRing, isSimple, obb, perimeter, pointInRing, SNAP } from '../src/gen/geo/poly';
import { BOOL_GRID, difference, intersection, mpArea } from '../src/gen/geo/bool';
import { checkWorld } from './urbanCheck';
import { bugReport } from '../src/ui/share';
import { Q13, Q13_NUCLEUS, Q13_QUARTER_COUNT } from './fixtures/mega-q13';

const rect = (x: number, y: number, w: number, h: number): Polygon => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
function quarter(p: Polygon, overrides: Partial<MacroQuarter> = {}): MacroQuarter {
  const b = bboxOf(p);
  return { id: 42, pts: p, inset: p, lab: p.map(() => 0), phase: 1, zone: 'core', age: 0.9, kind: 'quarter', morph: 0,
    culture: 'european', density: 350, pop: 2000, district: 'old-town', nucleus: 0, wants: [], area: area(p), bb: [b.x0, b.y0, b.x1, b.y1], ...overrides };
}
function checkFabric(q: MacroQuarter, grain: 'frontages' | 'courtyard' = 'frontages', nucleus: Vec2 = { x: -200, y: 50 }, budget?: FabricBudget): ReturnType<typeof standIn> {
  const f = standIn(q, nucleus, budget);
  expect(f.blocks.length).toBeGreaterThan(0);
  expect(f.blocks.length).toBeLessThanOrEqual(Math.min(64, budget?.blocks ?? 64, budget?.masses ?? 512));
  // A non-star-shaped block uses the exact courtyard difference instead of radial frontage bands.
  expect(f.masses.length).toBeGreaterThan(grain === 'frontages' ? f.blocks.length * 2 : 0);
  expect(f.masses.length).toBeLessThanOrEqual(Math.min(512, budget?.masses ?? 512));
  for (const b of f.blocks) {
    expect(isSimple(b)).toBe(true);
    expect(mpArea(difference(b, q.inset))).toBeLessThan(1e-5);
  }
  for (const m of f.masses) {
    expect(isSimple(m.outer)).toBe(true);
    expect(mpArea(difference(m, q.inset))).toBeLessThan(1e-5);
    expect(f.blocks.some((b) => mpArea(difference(m, b)) < 1e-5)).toBe(true);
  }
  let overlap = 0;
  const boxes = f.masses.map((m) => bboxOf(m.outer));
  for (let i = 0; i < f.masses.length; i++) for (let j = i + 1; j < f.masses.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.x0 >= b.x1 - 1e-7 || b.x0 >= a.x1 - 1e-7 || a.y0 >= b.y1 - 1e-7 || b.y0 >= a.y1 - 1e-7) continue;
    overlap += mpArea(intersection(f.masses[i], f.masses[j]));
  }
  expect(overlap).toBeLessThan(1e-5);
  return f;
}

describe('provisional megacity fabric', () => {
  it('adapts to a shared world budget and includes that budget in its cache identity', () => {
    const q = quarter(rect(0, 0, 300, 180));
    const fine = JSON.stringify(standIn(q));
    const coarse = standIn(q, undefined, { blocks: 2, masses: 8 });
    expect(coarse.blocks.length).toBeLessThanOrEqual(2);
    expect(coarse.masses.length).toBeLessThanOrEqual(8);
    expect(coarse.masses.length).toBeGreaterThan(0);
    expect(JSON.stringify(standIn(q))).toBe(fine);
    expect(standIn(q, undefined, fabricBudget(STAND_IN_BUDGET.blocks + 1)).blocks).toHaveLength(0);
    for (const n of [1, 20, 1200, 7000, 40000]) {
      const b = fabricBudget(n);
      expect(n * b.blocks).toBeLessThanOrEqual(STAND_IN_BUDGET.blocks);
      expect(n * b.masses).toBeLessThanOrEqual(STAND_IN_BUDGET.masses);
    }
  });
  it('partitions dense built bands into frontages while retaining courtyards and built share', () => {
    const q = quarter(rect(0, 0, 300, 180));
    const f = checkFabric(q);
    const coverage = mpArea(f.masses) / f.blocks.reduce((s, b) => s + area(b), 0);
    expect(coverage).toBeGreaterThan(0.75);
    expect(coverage).toBeLessThan(0.93);
    const original = JSON.stringify(f);
    expect(JSON.stringify(standIn(structuredClone(q), { x: -200, y: 50 }))).toBe(original);
    // A differently oriented request must not reuse a stale nucleus-dependent cache entry.
    const other = standIn(q, { x: 150, y: -200 });
    expect(JSON.stringify(other)).not.toBe(original);
    expect(JSON.stringify(standIn(q, { x: -200, y: 50 }))).toBe(original);
  });
  it('leaves the gardens and separate houses of the younger outskirts', () => {
    const q = quarter(rect(0, 0, 400, 220), { phase: 6, zone: 'faubourg', district: 'suburb', density: 60 });
    const f = checkFabric(q);
    const coverage = mpArea(f.masses) / f.blocks.reduce((s, b) => s + area(b), 0);
    expect(coverage).toBeGreaterThan(0.1);
    expect(coverage).toBeLessThan(0.4);
  });
  it('preserves both approved convex fabrics byte for byte', () => {
    const dense = quarter(rect(0, 0, 300, 180));
    const young = quarter(rect(0, 0, 400, 220), { phase: 6, zone: 'faubourg', district: 'suburb', density: 60 });
    const hashes = [dense, young].map((q) => createHash('sha256').update(JSON.stringify(standIn(q, { x: -200, y: 50 }))).digest('hex'));
    expect(hashes).toEqual([
      'fbcbb4fdb0f60e794ad79356489a15af239ac871470974ebd2a7986cc6c06e0b',
      'd551befe6d0eb6542545acb6e31716186935eb40e38119e0b38424b5074f883e',
    ]);
  });
  it('keeps real clipped ensembles in the formerly blank 54 ha q13 within its shared world budget', () => {
    const original = JSON.stringify(Q13), budget = fabricBudget(Q13_QUARTER_COUNT);
    const f = checkFabric(Q13, 'courtyard', Q13_NUCLEUS, budget);
    expect(f.blocks.length).toBeGreaterThanOrEqual(12);
    expect(f.masses.length).toBeGreaterThan(f.blocks.length);
    const blockArea = f.blocks.reduce((s, b) => s + area(b), 0), builtArea = mpArea(f.masses);
    // Most of this inhabited suburb must remain represented, with lanes, courts and young open gardens.
    expect(blockArea / area(Q13.inset)).toBeGreaterThan(0.75);
    expect(builtArea / blockArea).toBeGreaterThan(0.1);
    expect(builtArea / blockArea).toBeLessThan(0.4);
    for (let i = 0; i < f.blocks.length; i++) for (let j = i + 1; j < f.blocks.length; j++) {
      expect(mpArea(intersection(f.blocks[i], f.blocks[j]))).toBeLessThan(1e-5);
    }
    expect(JSON.stringify(Q13)).toBe(original);
    expect(JSON.stringify(standIn(structuredClone(Q13), Q13_NUCLEUS, budget))).toBe(JSON.stringify(f));
    expect(Q13_QUARTER_COUNT * f.blocks.length).toBeLessThanOrEqual(STAND_IN_BUDGET.blocks);
    expect(Q13_QUARTER_COUNT * f.masses.length).toBeLessThanOrEqual(STAND_IN_BUDGET.masses);
    const coarse = checkFabric(Q13, 'courtyard', Q13_NUCLEUS, { blocks: 2, masses: 8 });
    expect(coarse.blocks.length).toBeLessThanOrEqual(2);
    expect(mpArea(coarse.masses)).toBeLessThan(coarse.blocks.reduce((s, b) => s + area(b), 0));
  });
  it('keeps the entire edges of masses inside a deeply concave quarter', () => {
    const f = checkFabric(quarter([{ x: 0, y: 0 }, { x: 220, y: 0 }, { x: 220, y: 180 }, { x: 150, y: 180 },
      { x: 150, y: 70 }, { x: 70, y: 70 }, { x: 70, y: 180 }, { x: 0, y: 180 }]), 'courtyard');
    const blockArea = f.blocks.reduce((s, b) => s + area(b), 0), builtArea = mpArea(f.masses);
    expect(builtArea / blockArea).toBeGreaterThan(0.75);
    expect(blockArea - builtArea).toBeGreaterThan(1); // The fallback must still retain a real open court.
  });
  it('does not fill a reserved open place', () => {
    const q = quarter(rect(0, 0, 60, 40), { kind: 'place' });
    expect(standIn(q)).toEqual({ blocks: [q.inset], masses: [] });
  });
});

describe('absorbed village places in cities', () => {
  it('retains a clipped place on a rotated, translated core without centimetre snapping it outside', () => {
    const angle = 0.37, c = { x: 1234.567, y: 987.654 };
    const rotate = ({ x, y }: { x: number; y: number }) => ({ x: c.x + Math.cos(angle) * x - Math.sin(angle) * y, y: c.y + Math.sin(angle) * x + Math.cos(angle) * y });
    // Clipping at both end boundaries is essential: a wholly internal candidate cannot catch this regression.
    const core = rect(-32, -70, 64, 100).map(rotate);
    const road = [{ x: -150, y: 0 }, { x: 150, y: 0 }].map(rotate);
    const green = villageGreen(core, road, c, 30, 1);
    expect(green).not.toBeNull();
    expect(Math.abs(area(green!) - 1920)).toBeLessThan(0.3); // 188 m perimeter times the 1 mm boolean grid.
    expect(mpArea(difference(green!, core))).toBeLessThan(1e-6);
  });
  it('uses a real length of road independently of its vertex sampling', () => {
    const core = rect(-70, -70, 140, 140);
    const sparse = [{ x: -150, y: 0 }, { x: 150, y: 0 }];
    const dense = Array.from({ length: 61 }, (_, i) => ({ x: -150 + i * 5, y: 0 }));
    const a = villageGreen(core, sparse, { x: 0, y: 0 }, 30, 1)!;
    const b = villageGreen(core, dense, { x: 0, y: 0 }, 30, 1)!;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(area(a)).toBeCloseTo(1920, 5);
    expect(mpArea(difference(a, b)) + mpArea(difference(b, a))).toBeLessThan(1e-5);
    expect(2 * obb(a).hv).toBeGreaterThanOrEqual(18);
    expect(mpArea(difference(a, core))).toBeLessThan(1e-5);
  });
  it('rejects a clipped triangular tip while preserving its village core for the partition', () => {
    const core = [{ x: -35, y: 0 }, { x: 35, y: 0 }, { x: 0, y: 15 }];
    const saved = JSON.stringify(core);
    expect(villageGreen(core, [{ x: -150, y: 0 }, { x: 150, y: 0 }], { x: 0, y: 0 }, 30, 1)).toBeNull();
    expect(JSON.stringify(core)).toBe(saved);
  });
  it('reserves the usable opposite roadside instead of a shore-clipped triangle', () => {
    // Approved baseline reserveVillages accepted the +y sweep based on its centroid; its downstream dry cut
    // produced only (-32,0),(32,0),(0,30), 960 m². The -y side has a complete 64 × 30 m place.
    const core = [{ x: -70, y: -70 }, { x: 70, y: -70 }, { x: 70, y: 0 }, { x: 32, y: 0 },
      { x: 0, y: 30 }, { x: -32, y: 0 }, { x: -70, y: 0 }];
    const road = [{ x: -32, y: 0 }, { x: 0, y: 0 }, { x: 32, y: 0 }];
    const streets = new Streets();
    streets.add(road, 8, 1, 'radial', 1); streets.connected.add(0);
    const rng = new Rng('shore-regression');
    rng.fork = () => { const r = new Rng('depth'); r.range = () => 30; return r; };
    const water = difference(rect(-100, -100, 200, 200), core);
    const state = { rng, sites: [], culture: 'european', ctx: { water } } as unknown as Parameters<typeof reserveVillages>[0];
    const api = { streets, phases: [{ id: 1, zone: 'faubourg', region: [{ outer: core, holes: [] }] }] } as unknown as Parameters<typeof reserveVillages>[1];
    const lots = reserveVillages(state, api, [{ c: { x: 0, y: 0 }, core, road }], [], true);
    const green = lots.find((l) => l.kind === 'm4-green')!;
    expect(green).toBeDefined();
    expect(green.poly.length).toBe(4);
    expect(area(green.poly)).toBeCloseTo(1920, 5);
    expect(mpArea(intersection(green.poly, water))).toBeLessThan(1e-6);
    expect(mpArea(difference(green.poly, core))).toBeLessThan(1e-6);
    expect(lots[1].poly).toBe(core);
    expect(streets.connected.has(0)).toBe(true);
  });
  it('creates usable places in the real eager suburban village partition with connected roads', () => {
    const w = generate(makeOptions({ seed: '1', size: 'city', suburbs: 'many', shantytowns: 'many', settlements: 'none' }));
    const u = w.urban!;
    const villageBlocks = u.blocks.filter((_, i) => u.blockInfo?.[i]?.zone === 'village' && u.blockInfo[i].kind === 'place');
    expect(villageBlocks.length).toBeGreaterThan(0);
    for (const p of villageBlocks) {
      expect(p.length).toBeGreaterThanOrEqual(4);
      expect(area(p)).toBeGreaterThan(600);
      expect(2 * obb(p).hv).toBeGreaterThan(15);
    }
    const report = checkWorld(w);
    expect(report.overlapsBlocks + report.overlapsPlots + report.orphanMain + report.noFrontage).toBe(0);
  }, 900000);
});

describe('population-aware megacity extent', () => {
  it('preserves automatic-population links in every size and culture, and the scale of imported heightmaps', () => {
    for (const size of ['hamlet', 'village', 'town', 'city', 'capital'] as const) for (const culture of CULTURES) for (const seed of ['1', '4', '7']) {
      const o = makeOptions({ seed, size, culture, population: 0 });
      expect(generationMapSize(o), `${size}/${culture}/${seed}`).toBe(mapSizeOf(o));
    }
    const imported = makeOptions({ population: 5000000, importedHeight: { w: 2, h: 2, rgba: new Uint8Array(16) } });
    expect(generationMapSize(imported)).toBe(mapSizeOf(imported));
  });
  it('keeps implicit megacity bug crops at their real coordinates beyond the old preset edge', () => {
    const opts = makeOptions({ population: 5000000 });
    const extent = generationMapSize(opts);
    const report = bugReport(opts, [{ x: 20000, y: 21000, note: 'quarter' }], { cx: 20000, cy: 21000, scale: 2 }, 'http://local/', 1000);
    expect(report).toContain(`Map: ${extent} m`);
    expect(report).toContain('--crop 19800,20800,400');
  });
  it('regenerates an implicit expanded map identically from its realized exported options', () => {
    const w = generate(makeOptions({ seed: '5', size: 'town', population: 80000, settlements: 'none' }));
    expect(w.options.mapSize).toBe(w.mapSize);
    const again = generate(w.options);
    const withoutStats = (world: unknown) => JSON.stringify(world, (key, value) => key === 'stats' ? undefined : value);
    expect(withoutStats(again)).toBe(withoutStats(w));
  }, 900000);
  it('keeps small implicit presets and every explicit extent authoritative', () => {
    for (const size of ['hamlet', 'village', 'town'] as const) {
      const o = makeOptions({ size, seed: '7' });
      expect(generationMapSize(o)).toBe(mapSizeOf(o));
    }
    expect(generationMapSize(makeOptions({ population: 5000000, mapSize: 20000, sprawl: 2 }))).toBe(20000);
    expect(generationMapSize(makeOptions({ population: 5000000 }))).toBeGreaterThanOrEqual(30000);
    expect(generationMapSize(makeOptions({ population: 5000000, sprawl: 2 }))).toBe(40000);
  });
  it('bounds every ring with one common transform, preserving shared chains and nested geometry', () => {
    const a = rect(100, 100, 400, 400), b = [{ x: 100, y: 100 }, { x: 500, y: 100 }, { x: 1200, y: 700 }, { x: 100, y: 900 }];
    const result = containMegaRings([a, b], { x: 300, y: 300 }, 1000);
    expect(result.scale).toBeLessThan(1);
    expect(result.rings[0][0]).toEqual(result.rings[1][0]);
    expect(result.rings[0][1]).toEqual(result.rings[1][1]);
    expect(area(result.rings[0]) / area(a)).toBeCloseTo(result.scale ** 2, 12);
    for (const p of result.rings.flat()) { expect(p.x).toBeGreaterThanOrEqual(50 - 1e-8); expect(p.y).toBeGreaterThanOrEqual(50 - 1e-8); expect(p.x).toBeLessThanOrEqual(950 + 1e-8); expect(p.y).toBeLessThanOrEqual(950 + 1e-8); }
  });
  it('reports the real five-million / 20 km sprawl shortfall without drawing rings outside the map', () => {
    const w = generate(makeOptions({ seed: '1', population: 5000000, mapSize: 20000, sprawl: 2, settlements: 'none' }));
    const m = w.urban!.macro!;
    expect(w.mapSize).toBe(20000);
    expect(m.population).toBe(5000000);
    expect(m.extent!.constrained).toBe(true);
    expect(m.extent!.plannedPopulation).toBeGreaterThan(2000000);
    expect(m.extent!.plannedPopulation).toBeLessThan(5000000);
    expect(String(w.stats['settlements.warning'])).toContain('bounded plan estimates');
    for (const p of m.rings.flat()) { expect(p.x).toBeGreaterThanOrEqual(150 - 1e-7); expect(p.y).toBeGreaterThanOrEqual(150 - 1e-7); expect(p.x).toBeLessThanOrEqual(19850 + 1e-7); expect(p.y).toBeLessThanOrEqual(19850 + 1e-7); }
    const land = mpArea(w.urban!.footprintH);
    expect(Math.abs(m.quarters.reduce((s, q) => s + q.area, 0) - land) / land).toBeLessThan(0.005);
    // The graph snaps to centimetres; boolean intersections can add a half-millimetre per axis.
    // Bound both the distance and total sliver area instead of letting one interior vertex waive containment.
    const outer = m.rings.at(-1)!;
    const boundaryTolerance = Math.SQRT2 * (0.5 / SNAP + 0.5 / BOOL_GRID) + 1e-8;
    for (const q of m.quarters) {
      for (const p of q.pts) if (!pointInRing(outer, p)) expect(distToRing(outer, p), `quarter ${q.id} boundary distance`).toBeLessThanOrEqual(boundaryTolerance);
      expect(mpArea(difference(q.pts, outer)), `quarter ${q.id} exterior sliver area`).toBeLessThanOrEqual(perimeter(q.pts) * boundaryTolerance);
    }
  }, 900000);
  it('gives an implicit five-million city a sufficient geographic extent and honest capacity', () => {
    const w = generate(makeOptions({ seed: '3', population: 5000000, settlements: 'none' }));
    expect(w.mapSize).toBeGreaterThanOrEqual(30000);
    expect(w.options.mapSize).toBe(w.mapSize);
    const m = w.urban!.macro!;
    expect(m.extent!.plannedPopulation).toBeGreaterThanOrEqual(4750000);
    expect(m.extent!.constrained).toBe(false);
    const view = renderView(w).urban!;
    expect(view.masses.length).toBeGreaterThan(0);
    expect(view.masses.length).toBeLessThanOrEqual(STAND_IN_BUDGET.masses);
    for (const p of m.rings.flat()) { expect(p.x).toBeGreaterThanOrEqual(150 - 1e-7); expect(p.y).toBeGreaterThanOrEqual(150 - 1e-7); expect(p.x).toBeLessThanOrEqual(w.mapSize - 150 + 1e-7); expect(p.y).toBeLessThanOrEqual(w.mapSize - 150 + 1e-7); }
  }, 900000);
});
