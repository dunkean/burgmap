import { describe, it, expect } from 'vitest';
import { Rng } from '../src/gen/core/rng';
import { dist } from '../src/gen/core/geom';
import { area } from '../src/gen/geo/poly';
import { differenceS, mpArea } from '../src/gen/geo/bool';
import { ribbon } from '../src/gen/geo/offset';
import { MORPHOLOGIES } from '../src/gen/urban/morphology';
import '../src/gen/urban/cultures';
import { Streets, LAB_OPEN } from '../src/gen/urban/streets';
import type { Piece } from '../src/gen/urban/blocks';
import { culDeSacTree } from '../src/gen/urban/culdesac';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { checkWorld } from './urbanCheck';

function tiltedWard() {
  const angle = 0.63, c = Math.cos(angle), s = Math.sin(angle);
  const rotate = (p: { x: number; y: number }) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c });
  const streets = new Streets();
  const id = streets.add([{ x: 0, y: 0 }, { x: 180, y: 0 }].map(rotate), 8, 2, 'street', 0);
  streets.connected.add(id);
  const pc: Piece = { lp: { pts: [{ x: 0, y: 0 }, { x: 180, y: 0 }, { x: 180, y: 160 }, { x: 0, y: 160 }].map(rotate),
    lab: [id, LAB_OPEN, LAB_OPEN, LAB_OPEN] }, phase: 0, zone: 'middle', age: 1, quarter: 0, kind: 'block', level: 2, morph: MORPHOLOGIES['jp-merchant'] };
  const entry = [{ x: -5, y: -5 }, { x: 185, y: -5 }, { x: 185, y: 0 }, { x: -5, y: 0 }].map(rotate);
  return { streets, pc, entry, c, s };
}

describe('Japanese merchant roji', () => {
  it('serves tilted districts along their actual street axes, with contained connected ribbons', () => {
    const a = tiltedWard(), b = tiltedWard(), ra = new Rng('roji');
    expect(culDeSacTree([a.pc], a.streets, ra)).toBeGreaterThan(2);
    culDeSacTree([b.pc], b.streets, new Rng('roji'));
    expect(a.streets.list).toEqual(b.streets.list);
    expect(ra.next()).toBe(new Rng('roji').next());
    for (const st of a.streets.list.slice(1)) {
      expect(a.streets.connected.has(st.id)).toBe(true);
      expect(mpArea(differenceS(ribbon(st.path, st.widths), a.pc.lp.pts, a.entry))).toBeLessThan(0.05);
      for (let i = 1; i < st.path.length; i++) {
        const dx = st.path[i].x - st.path[i - 1].x, dy = st.path[i].y - st.path[i - 1].y;
        expect(Math.min(Math.abs(dx * a.c + dy * a.s), Math.abs(-dx * a.s + dy * a.c))).toBeLessThan(1e-6);
      }
    }
  });

  it('preserves temples and samurai domains', () => {
    const a = tiltedWard(); a.pc.compound = 'jp-temple';
    expect(culDeSacTree([a.pc], a.streets, new Rng('temple'))).toBe(0);
    const b = tiltedWard(); b.pc.morph = MORPHOLOGIES['jp-samurai'];
    expect(culDeSacTree([b.pc], b.streets, new Rng('samurai'))).toBe(0);
  });

  it('opens the p4uefz merchant crescent and western ward without merging giant back plots', () => {
    const w = generate(makeOptions({ seed: 'p4uefz', size: 'city', culture: 'japanese-jokamachi', settlements: 'none' }));
    const u = w.urban!, plots = u.parcels.filter((p) => p.use === 'plot' && p.zone === 'middle');
    expect(plots.length).toBeGreaterThan(10);
    // Before roji, the two reported wards held 114,614 and 20,374 m² plots with 15 and 7.5 m fronts.
    expect(Math.max(...plots.map((p) => area(p.poly)))).toBeLessThan(15000);
    expect(u.streets.filter((s) => s.role === 'close').length).toBeGreaterThan(15);
    const r = checkWorld(w), msg = r.details.slice(0, 8).join('\n');
    expect(r.blockAreaErr, msg).toBeLessThanOrEqual(0.005);
    expect(r.overlapsPlots, msg).toBe(0);
    expect(r.noFrontage, msg).toBe(0);
    expect(r.bldgOutside, msg).toBe(0);
    for (const p of plots) expect(dist(p.front![0], p.front![1])).toBeGreaterThanOrEqual(3);
  }, 120000);
});
