/**
 * Small bridges in town (HANDOFF §7.8, gen/urban/streambridges.ts): secondary streets and lanes cross the streams
 * and small rivers of a town. On towns with streams (seeds 1–6 × relief):
 * - at least 2 crossings per km of stream running through the town (both banks built);
 * - every small bridge joins street pieces on both banks;
 * - every deck is within ±30° of square to the stream;
 * - no street runs in the water except over a bridge.
 */
import { describe, it, expect } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import type { World, Vec2 } from '../src/gen/types';
import { pointInRing, distToSeg } from '../src/gen/geo/poly';
import { GridIndex } from '../src/gen/geo/spatial';
import { waterViolations } from './waterCheck';
import { checkWorld } from './urbanCheck';

type KB = NonNullable<World['bridges']>[number] & { kind?: string; arch?: string };
const SMALL = 11;

/** Length of small-river course with built blocks on both banks, and the bridges (any kind) over it. */
function streamStats(w: World): { L: number; bridges: number } {
  const blocks = w.urban!.blocks;
  const bi = new GridIndex<number>(40);
  blocks.forEach((b, i) => { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const q of b) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); } bi.insertBox(x0, y0, x1, y1, i); });
  const built = (p: Vec2) => bi.query(p.x - 1, p.y - 1, p.x + 1, p.y + 1).some((i) => pointInRing(blocks[i], p));
  let L = 0;
  const segs: { a: Vec2; b: Vec2; hw: number }[] = [];
  for (const r of w.terrain.rivers) for (let i = 1; i < r.path.length; i++) {
    const a = r.path[i - 1], b = r.path[i], ww = r.width[i];
    if (ww >= SMALL) continue;
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1, n = { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const side = (sg: number) => [8, 16, 24, 32].some((o) => built({ x: m.x + n.x * sg * (ww / 2 + o), y: m.y + n.y * sg * (ww / 2 + o) }));
    if (side(1) && side(-1)) { L += l; segs.push({ a, b, hw: ww / 2 }); }
  }
  let nb = 0;
  for (const b of w.bridges ?? []) {
    const m = { x: (b.a.x + b.b.x) / 2, y: (b.a.y + b.b.y) / 2 };
    if (segs.some((s) => distToSeg(m, s.a, s.b) < s.hw + 4)) nb++;
  }
  return { L, bridges: nb };
}

/** Tangent of the nearest river centre line. */
function riverTangent(w: World, p: Vec2): Vec2 {
  let bd = Infinity, t = { x: 1, y: 0 };
  for (const r of w.terrain.rivers) for (let i = 1; i < r.path.length; i++) {
    const d = distToSeg(p, r.path[i - 1], r.path[i]);
    if (d < bd) { bd = d; const dx = r.path[i].x - r.path[i - 1].x, dy = r.path[i].y - r.path[i - 1].y, l = Math.hypot(dx, dy) || 1; t = { x: dx / l, y: dy / l }; }
  }
  return t;
}

const CASES: [string, string][] = [];
for (const relief of ['flat', 'hills', 'valley', 'mountains']) for (const seed of ['1', '2', '3', '4', '5', '6']) CASES.push([seed, relief]);

describe('small bridges in town', () => {
  const worlds = new Map<string, World>();
  const get = (seed: string, relief: string): World => {
    const k = seed + relief;
    if (!worlds.has(k)) worlds.set(k, generate(makeOptions({ seed, size: 'town', relief: relief as never })));
    return worlds.get(k)!;
  };

  it('crossings: ≥ 2 per km of stream through the town; decks square to the stream; both banks joined to streets', () => {
    let totL = 0, totB = 0, small = 0;
    const rows: string[] = [];
    for (const [seed, relief] of CASES) {
      const w = get(seed, relief);
      const { L, bridges } = streamStats(w);
      totL += L; totB += bridges;
      if (L >= 250) {
        rows.push(`${seed} ${relief}: ${Math.round(L)} m, ${bridges} bridges`);
        expect(bridges / (L / 1000), `${seed} ${relief}`).toBeGreaterThanOrEqual(2);
      }
      const streets = w.urban!.streets;
      for (const b of (w.bridges ?? []) as KB[]) {
        if (!b.kind) continue;
        small++;
        expect(['footbridge', 'arch', 'timber-arch', 'ford']).toContain(b.kind);
        expect(typeof b.arch).toBe('string');
        // square to the stream within ±30°
        const L2 = Math.hypot(b.b.x - b.a.x, b.b.y - b.a.y);
        const u = { x: (b.b.x - b.a.x) / L2, y: (b.b.y - b.a.y) / L2 };
        const t = riverTangent(w, { x: (b.a.x + b.b.x) / 2, y: (b.a.y + b.b.y) / 2 });
        expect(Math.abs(u.x * t.x + u.y * t.y), `${seed} ${relief} deck tilt`).toBeLessThanOrEqual(Math.sin(Math.PI / 6) + 1e-6);
        // the deck is a street, and both of its ends meet another street (the network on each bank)
        const own = streets.findIndex((s) => s.path.length === 2 && Math.hypot(s.path[0].x - b.a.x, s.path[0].y - b.a.y) < 1e-6 && Math.hypot(s.path[1].x - b.b.x, s.path[1].y - b.b.y) < 1e-6);
        expect(own, `${seed} ${relief} deck street`).toBeGreaterThanOrEqual(0);
        for (const e of [b.a, b.b]) {
          const met = streets.some((s, si) => si !== own && s.path.some((q, i) => i > 0 && distToSeg(e, s.path[i - 1], q) < 0.05));
          expect(met, `${seed} ${relief} bank ${Math.round(e.x)},${Math.round(e.y)}`).toBe(true);
        }
      }
    }
    expect(small).toBeGreaterThan(15);
    expect(totB / (totL / 1000)).toBeGreaterThanOrEqual(2);
    void rows;
  }, 600_000);

  it('no street in the water except over a bridge; the street network stays one piece', () => {
    for (const [seed, relief] of CASES) {
      const w = get(seed, relief);
      const v = waterViolations(w);
      const bad = Object.entries(v.summary).filter(([k]) => k.startsWith('street-') && k.includes(':'));
      expect(bad, `${seed} ${relief} ${JSON.stringify(v.samples.slice(0, 3))}`).toEqual([]);
      if (Number(w.stats['urban.streamBridges'] ?? 0) > 0) {
        const r = checkWorld(w);
        expect(r.orphanMain, `${seed} ${relief}`).toBe(0);
        expect(r.overlapsBlocks + r.overlapsPlots, `${seed} ${relief}`).toBe(0);
        expect(r.noFrontage, `${seed} ${relief}`).toBe(0);
      }
    }
  }, 600_000);
});
