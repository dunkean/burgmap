import { describe, it, expect } from 'vitest';
import { Rng } from '../src/gen/core/rng';
import { Streets } from '../src/gen/urban/streets';
import { connectedWaterways } from '../src/gen/urban/waterways';
import { lagoonWaterways } from '../src/gen/urban/venice';
import { ribbon } from '../src/gen/geo/offset';
import { unionMany, differenceS, intersectionS, mpArea } from '../src/gen/geo/bool';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { makeCtx } from '../src/gen/urban/context';
import { MORPHOLOGIES } from '../src/gen/urban/morphology';
import { distToSeg, pointInRing } from '../src/gen/geo/poly';
import '../src/gen/urban/cultures';
import { checkWorld } from './urbanCheck';

function fixture() {
  const streets = new Streets();
  streets.add([{ x: 50, y: -30 }, { x: 50, y: 50 }, { x: 60, y: 60 }, { x: 60, y: 130 }], 10, 0, 'radial', 0);
  const a = streets.add([{ x: 0, y: 30 }, { x: 50, y: 30 }], 12, 2, 'street', 0);
  const b = streets.add([{ x: 60, y: 80 }, { x: 100, y: 80 }], 9, 2, 'street', 0);
  const dry = streets.add([{ x: 200, y: 30 }, { x: 250, y: 30 }], 12, 2, 'street', 0);
  return { streets, candidates: [a, b, dry].map((id) => streets.list[id]), isWater: (p: { x: number; y: number }) => p.y > 110 };
}

describe('connected lagoon waterways', () => {
  it('routes inland canals to water through actual arterial junctions and leaves isolated dry cuts as streets', () => {
    const { streets, candidates, isWater } = fixture(), before = JSON.stringify(streets.list);
    const a = connectedWaterways(streets, candidates, isWater);
    expect(a.canals.map((c) => c.id)).toEqual([1, 2]);
    expect(a.connectors.length).toBeGreaterThan(0);
    expect(connectedWaterways(streets, candidates, isWater)).toEqual(a);
    expect(JSON.stringify(streets.list)).toBe(before);
    const corridor = ribbon(streets.list[0].path, streets.list[0].widths);
    for (const c of a.connectors) expect(mpArea(differenceS(ribbon(c.path, c.width!), corridor))).toBeLessThan(0.01);
  });

  it('does not invent canals or bridges on completely dry land', () => {
    const { streets } = fixture();
    expect(lagoonWaterways(streets, new Rng('dry'), () => false, 1)).toEqual([]);
  });

  it('preserves short shore outlets only when the extension is clear', () => {
    const streets = new Streets();
    streets.add([{ x: 0, y: 0 }, { x: 100, y: 0 }], 8, 2, 'street', 0);
    const isWater = (p: { x: number; y: number }) => p.x > 103;
    const wet = connectedWaterways(streets, streets.list, isWater, () => true);
    expect(wet.canals).toHaveLength(1);
    expect(wet.connectors.some((c) => c.outlet && c.path.some(isWater))).toBe(true);
    expect(connectedWaterways(streets, streets.list, isWater, () => false).canals).toHaveLength(0);
    const narrow = new Streets(); narrow.add([{ x: 0, y: 0 }, { x: 10, y: 0 }], 3, 2, 'street', 0);
    expect(connectedWaterways(narrow, narrow.list, () => true).canals).toHaveLength(0);
  });

  it('bridges a narrow calle midway along a new channel without adding bridges at plain bends', () => {
    const { streets, isWater } = fixture();
    streets.add([{ x: 20, y: 70 }, { x: 60, y: 70 }], 2.6, 3, 'lane', 0);
    const lines = lagoonWaterways(streets, new Rng('crossing'), isWater, 1);
    const bridges = lines.filter((l) => l.kind === 'footbridge');
    expect(bridges.some((b) => b.path.every((p) => Math.abs(p.y - 70) < 0.01))).toBe(true);
    expect(bridges.length).toBeGreaterThanOrEqual(3);
    const channels = lines.filter((l) => l.kind === 'canal');
    for (const bridge of bridges) for (const landing of bridge.path) {
      expect(isWater(landing)).toBe(false);
      for (const channel of channels) for (let i = 1; i < channel.path.length; i++) {
        expect(distToSeg(landing, channel.path[i - 1], channel.path[i])).toBeGreaterThan(channel.width! / 2);
      }
    }
    for (const bend of [{ x: 50, y: 50 }, { x: 60, y: 60 }]) {
      expect(bridges.every((b) => Math.hypot((b.path[0].x + b.path[1].x) / 2 - bend.x, (b.path[0].y + b.path[1].y) / 2 - bend.y) > 5)).toBe(true);
    }
    expect(Math.min(...lines.filter((l) => l.kind === 'canal').map((l) => l.width!))).toBeGreaterThanOrEqual(2.2);
  });

  it('draws a physically joined wet network with per-call canal classification', () => {
    const { streets, isWater } = fixture();
    const lines = lagoonWaterways(streets, new Rng('wet'), isWater, 1);
    const canals = lines.filter((l) => l.kind === 'canal');
    expect(lines.some((l) => l.kind === 'footbridge')).toBe(true);
    const network = unionMany(canals.map((c) => ribbon(c.path, c.width!)), 24, true);
    expect(network).toHaveLength(1);
    const water = [{ x: -100, y: 110 }, { x: 300, y: 110 }, { x: 300, y: 150 }, { x: -100, y: 150 }];
    expect(mpArea(intersectionS(network, water))).toBeGreaterThan(1);
    const other = new Streets(); other.add([{ x: 0, y: 0 }, { x: 50, y: 0 }], 8, 2, 'street', 0);
    lagoonWaterways(other, new Rng('other'), () => true, 0);
    expect(lagoonWaterways(streets, new Rng('wet'), isWater, 1)).toEqual(lines);
  });

  it('retains engineered inland gnomish canals and lock gates on dry ground', () => {
    const { streets } = fixture();
    const lines = lagoonWaterways(streets, new Rng('locks'), () => false, 1, true);
    expect(lines.some((l) => l.kind === 'canal')).toBe(true);
    expect(lines.some((l) => l.kind === 'lock-gate')).toBe(true);
    const other = new Streets(); other.add([{ x: 0, y: 0 }, { x: 50, y: 0 }], 8, 2, 'street', 0);
    lagoonWaterways(other, new Rng('other'), () => true, 0, true);
    expect(lagoonWaterways(streets, new Rng('locks'), () => false, 1, true)).toEqual(lines);
  });

  it('keeps every p4uefz Venetian canal component rooted in natural water and protects urban geometry', () => {
    const w = generate(makeOptions({ seed: 'p4uefz', size: 'city', culture: 'venetian-lagoon', settlements: 'none' }));
    const ctx = makeCtx(w, MORPHOLOGIES.venetian, 3000);
    const canals = w.urban!.lines!.filter((l) => l.kind === 'canal');
    expect(canals.length).toBeGreaterThan(20);
    expect(Math.min(...canals.map((c) => c.width!))).toBeGreaterThanOrEqual(2.2);
    const network = unionMany(canals.map((c) => ribbon(c.path, c.width!)), 24, true);
    // Previously 26 of 35 components had no connection to the river or sea.
    for (const part of network) expect(mpArea(intersectionS(part, ctx.water))).toBeGreaterThan(0.1);
    for (const bridge of w.urban!.lines!.filter((l) => l.kind === 'footbridge')) for (const landing of bridge.path) {
      expect(ctx.water.some((p) => pointInRing(p.outer, landing) && !p.holes.some((h) => pointInRing(h, landing)))).toBe(false);
      for (const channel of canals) for (let i = 1; i < channel.path.length; i++) {
        expect(distToSeg(landing, channel.path[i - 1], channel.path[i])).toBeGreaterThan(channel.width! / 2);
      }
    }
    const r = checkWorld(w), msg = r.details.slice(0, 8).join('\n');
    expect(r.blockAreaErr, msg).toBeLessThanOrEqual(0.005);
    expect(r.overlapsPlots, msg).toBe(0);
    expect(r.noFrontage, msg).toBe(0);
    expect(r.bldgOutside, msg).toBe(0);
    const roofs = unionMany(w.urban!.buildings.map((b) => b.poly), 24, true);
    expect(mpArea(intersectionS(network, roofs))).toBeLessThan(2);
  }, 120000);
});
