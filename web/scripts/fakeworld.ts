/** Synthetic World generator and mock Canvas 2D context for stress/smoke tests (Node only). */
import type { World, Polygon, Polyline, UrbanStreet, UrbanParcel, UrbanBlockInfo } from '../src/gen/types';
import { makeOptions } from '../src/gen/options';
import { createGrid } from '../src/gen/core/grid';

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export interface FakeOpts { mapSize?: number; buildings?: number; streets?: number; clusters?: number; seed?: number; landAreas?: number }

/** Clustered "cities" over a big map: rotated rectangular houses, street polylines, blocks, land use. */
export function fakeWorld(o: FakeOpts = {}): World {
  const S = o.mapSize ?? 30000, nb = o.buildings ?? 200_000, ns = o.streets ?? 50_000, nc = o.clusters ?? 40;
  const rnd = mulberry(o.seed ?? 1);
  const gauss = (): number => { let s = 0; for (let i = 0; i < 4; i++) s += rnd(); return (s - 2) * 1.7; };
  const centers = Array.from({ length: nc }, () => ({ x: S * (0.08 + 0.84 * rnd()), y: S * (0.08 + 0.84 * rnd()), r: 500 + rnd() * 1800 }));
  const near = (): { x: number; y: number } => {
    const c = centers[Math.floor(rnd() * nc)];
    return { x: Math.max(5, Math.min(S - 5, c.x + gauss() * c.r)), y: Math.max(5, Math.min(S - 5, c.y + gauss() * c.r)) };
  };
  const buildings: { poly: Polygon; kind: string }[] = [];
  for (let i = 0; i < nb; i++) {
    const c = near(), a = rnd() * Math.PI, w = 5 + rnd() * 5, h = 7 + rnd() * 6;
    const ca = Math.cos(a), sa = Math.sin(a);
    const P = (dx: number, dy: number) => ({ x: c.x + dx * ca - dy * sa, y: c.y + dx * sa + dy * ca });
    buildings.push({ poly: [P(-w / 2, -h / 2), P(w / 2, -h / 2), P(w / 2, h / 2), P(-w / 2, h / 2)], kind: rnd() < 0.97 ? 'house' : 'church' });
  }
  const streets: UrbanStreet[] = [];
  for (let i = 0; i < ns; i++) {
    const c = near();
    let a = rnd() * Math.PI * 2;
    const path: Polyline = [c];
    const n = 3 + Math.floor(rnd() * 6);
    for (let k = 0; k < n; k++) {
      a += (rnd() - 0.5) * 0.6;
      const l = 25 + rnd() * 60;
      const p = path[path.length - 1];
      path.push({ x: p.x + Math.cos(a) * l, y: p.y + Math.sin(a) * l });
    }
    const r = rnd();
    streets.push({ path, width: r < 0.05 ? 8 : r < 0.5 ? 5 : 2.5, kind: r < 0.05 ? 'main' : r < 0.5 ? 'street' : 'alley', rank: r < 0.05 ? 0 : r < 0.5 ? 2 : 3, role: r < 0.05 ? 'radial' : r < 0.5 ? 'street' : 'lane', phase: 1 });
  }
  const blocks: Polygon[] = [], parcels: UrbanParcel[] = [], blockInfo: UrbanBlockInfo[] = [];
  for (let i = 0; i < Math.floor(nb / 12); i++) {
    const c = near(), w = 30 + rnd() * 40, h = 30 + rnd() * 40;
    const poly = [{ x: c.x - w / 2, y: c.y - h / 2 }, { x: c.x + w / 2, y: c.y - h / 2 }, { x: c.x + w / 2, y: c.y + h / 2 }, { x: c.x - w / 2, y: c.y + h / 2 }];
    blocks.push(poly);
    blockInfo.push({ quarter: 0, phase: 1, zone: 'core', kind: 'block' });
    if (i % 3 === 0) parcels.push({ poly, use: 'plot', block: i });
  }
  const ring = (c: { x: number; y: number }, r: number, n: number): Polygon => Array.from({ length: n }, (_, i) => ({ x: c.x + Math.cos((i / n) * 6.283) * r, y: c.y + Math.sin((i / n) * 6.283) * r }));
  const footprint: Polygon[] = centers.map((c) => ring(c, c.r * 1.8, 24));
  const kinds = ['field', 'meadow', 'pasture', 'forest', 'orchard', 'marsh'] as const;
  const areas = Array.from({ length: o.landAreas ?? 4000 }, () => {
    const c = { x: rnd() * S, y: rnd() * S }, r = 60 + rnd() * 300;
    return { kind: kinds[Math.floor(rnd() * kinds.length)], poly: ring(c, r, 10) };
  });
  const cells = 128;
  return {
    seed: 'fake', options: makeOptions({}), mapSize: S,
    terrain: {
      height: createGrid(cells, cells, S / cells, 50), slope: createGrid(cells, cells, S / cells), water: new Uint8Array(cells * cells), flow: createGrid(cells, cells, S / cells),
      seaLevel: 0, seaFraction: 0, coastline: [], lakes: [], rivers: [{ path: [{ x: 0, y: S / 2 }, { x: S / 2, y: S / 2 + 500 }, { x: S, y: S / 2 }], width: [30, 40, 60], main: true }],
      receiver: new Int32Array(0), filled: new Float32Array(0), downSide: 'S', seaSide: null,
    },
    roads: Array.from({ length: 300 }, () => ({ path: [near(), near(), near()], kind: 'minor' as const, width: 5 })),
    urban: {
      footprint, streets, blocks, parcels, buildings, landmarks: [], squares: [],
      archetype: 'town', population: 1000, morphology: 'fake', phases: [], blockInfo, backLand: [],
      quarters: blocks.slice(0, Math.floor(blocks.length / 4)).map((poly) => ({ poly: { outer: poly, holes: [] }, phase: 1, zone: 'core' as const, streetSpace: [] })),
      masses: buildings.map((b) => ({ outer: b.poly, holes: [] })),
      footprintH: footprint.map((outer) => ({ outer, holes: [] })),
      walls: centers.slice(0, 5).map((c) => ({ path: ring(c, c.r * 0.6, 40), closed: true, towers: [], gates: [], thickness: 3 })),
    },
    landuse: { areas, farmsteads: [], reserve: [] },
    stats: {},
  };
}

// ---------------- mock 2D context ----------------
export class MockPath2D {
  ops = 0;
  moveTo(): void { this.ops++; }
  lineTo(): void { this.ops++; }
  arc(): void { this.ops++; }
  closePath(): void { /* no-op */ }
}

export interface CallLog {
  calls: Record<string, number>;
  pathOps: number;
  fills: { path: MockPath2D | undefined; style: unknown; alpha: number }[];
}

/** A canvas whose 2D context records every call; fill/stroke tally the vertices of the Path2D drawn. */
export function mockCanvas(w: number, h: number): { canvas: { width: number; height: number; getContext(id: string): unknown }; log: CallLog; reset(): void } {
  const log: CallLog = { calls: {}, pathOps: 0, fills: [] };
  const state: Record<string, unknown> = { fillStyle: '', strokeStyle: '', globalAlpha: 1 };
  const ctx = new Proxy(state, {
    get(t, k: string) {
      if (k in t) return t[k];
      return (...args: unknown[]) => {
        log.calls[k] = (log.calls[k] ?? 0) + 1;
        if (k === 'fill' || k === 'stroke') {
          const p = args[0] instanceof MockPath2D ? args[0] : undefined;
          if (p) log.pathOps += p.ops;
          if (k === 'fill') log.fills.push({ path: p, style: t.fillStyle, alpha: Number(t.globalAlpha) });
        }
        if (k === 'measureText') return { width: String(args[0]).length * 6 };
        return undefined;
      };
    },
    set(t, k: string, v) { t[k] = v; return true; },
  });
  return { canvas: { width: w, height: h, getContext: () => ctx }, log, reset() { log.calls = {}; log.pathOps = 0; log.fills = []; } };
}
