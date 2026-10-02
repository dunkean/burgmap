import { describe, it, expect } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { makeOptions, toQuery, fromQuery, Options } from '../src/gen/options';
import { checkWorld } from './urbanCheck';
import { checkM4 } from './m4Check';
import { renderSvg } from '../src/render/svg';

// M4 invariants (URBAN_LANDMARKS.md §4) on cases that exercise every landmark: a walled city on a river (castle,
// cathedral close, palace, monasteries, river port, mills, trades, shanty towns), a harbour town, a city with many
// suburbs and shanty towns, a medina (kasbah, madrasas, mellah), a Roman-core town with its arena, a village motte.
interface Case { name: string; o: Partial<Options>; expect: string[] }
const CASES: Case[] = [
  { name: 'city on a river', o: { seed: '2', size: 'city' }, expect: ['castle', 'cathedral-close', 'palace', 'monastery', 'river-port', 'watermill', 'windmill', 'tannery', 'shanty'] },
  { name: 'harbour town', o: { seed: '3', size: 'town', coast: 'S', siteType: 'harbor' }, expect: ['castle'] },
  { name: 'coastal city', o: { seed: '5', size: 'city', coast: 'E', siteType: 'harbor' }, expect: ['castle', 'harbour', 'shipyard', 'cathedral-close'] },
  { name: 'city with suburbs and shanty towns', o: { seed: '1', size: 'city', suburbs: 'many', shantytowns: 'many' }, expect: ['absorbed-village', 'shanty'] },
  { name: 'medina', o: { seed: '2', size: 'city', culture: 'medina' }, expect: ['kasbah', 'madrasa', 'mellah'] },
  { name: 'roman-core town with arena', o: { seed: '4', size: 'town', culture: 'roman-core', arena: 'yes' }, expect: ['arena'] },
  { name: 'village motte', o: { seed: '3', size: 'village', castle: 'yes' }, expect: ['motte'] },
];

describe('M4 landmarks, port, suburbs, shanty towns', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const w = generate(makeOptions(c.o));
      // the partition invariants (URBAN_GEOMETRY §6) hold with the landmark lots claimed
      const r = checkWorld(w);
      const msg = r.details.slice(0, 8).join('\n');
      expect(r.blockAreaErr, 'blocks = parcels (exact area accounting)\n' + msg).toBeLessThanOrEqual(0.005);
      expect(r.blockOutside, 'blocks inside their quarter\n' + msg).toBeLessThan(1);
      expect(r.overlapsBlocks, 'no block overlaps').toBe(0);
      expect(r.overlapsPlots, 'no parcel overlaps\n' + msg).toBe(0);
      expect(r.overlapsBuildings, 'building overlaps\n' + msg).toBeLessThanOrEqual(Math.ceil(r.buildings * 0.0005));
      expect(r.noFrontage, 'plots front a street\n' + msg).toBe(0);
      expect(r.bldgOutside, 'buildings inside their parcel\n' + msg).toBe(0);
      expect(r.acute + r.thin, 'acute or thin shapes\n' + msg).toBeLessThanOrEqual(Math.max(2, Math.ceil(0.01 * (r.plots + r.buildings))));
      expect(r.orphanMain, 'main streets connect').toBe(0);
      const m = checkM4(w);
      const kinds = new Set(m.sites.map((s) => s.kind));
      for (const k of c.expect) expect(kinds.has(k), `${c.name}: has a ${k} (sites: ${[...kinds].join(', ')})`).toBe(true);
      // landmark lots are pieces of the partition: they never overlap
      expect(m.lotOverlap, 'landmark lots do not overlap').toBeLessThan(0.5);
      // every landmark has street access at its entrance (a street, or a track to the road outside the walls)
      expect(m.noAccess, 'landmarks without access').toEqual([]);
      // over the water: only piers, slipways, mills (and the reclaimed quay edge)
      expect(m.wetBuildings, 'buildings over water').toEqual([]);
      expect(m.wetBlocks, 'blocks over water').toEqual([]);
      // quays lie on the shoreline
      expect(m.quayOff, 'quay edge within 10 m of the shore').toBeLessThanOrEqual(10);
      // quays are straight stone edges: long straight segments, not a traced shoreline
      for (const q of w.urban!.quays ?? []) for (let i = 1; i < q.length; i++) expect(Math.hypot(q[i].x - q[i - 1].x, q[i].y - q[i - 1].y), 'quay segment ≥ 12 m').toBeGreaterThanOrEqual(12);
      // separation rules
      expect(m.sepFail, 'separation between landmarks of a kind').toEqual([]);
      // castle walls are straight polygons: 4–8 curtains, convex, no stub, touching the town edge
      if (m.castle) {
        expect(m.castle.verts, 'castle: 4–8 straight curtains').toBeGreaterThanOrEqual(4);
        expect(m.castle.verts).toBeLessThanOrEqual(8);
        expect(m.castle.convex, 'castle enceinte convex').toBe(true);
        expect(m.castle.minEdge, 'castle curtains ≥ 12 m').toBeGreaterThanOrEqual(12);
        expect(m.castle.gapToWall, 'castle at the edge of the town').toBeLessThan(5);
      }
      if (m.cathedral) {
        expect(m.cathedral.len, 'cathedral 80–140 m').toBeGreaterThanOrEqual(80);
        expect(m.cathedral.len).toBeLessThanOrEqual(140);
        expect(Math.abs(m.cathedral.angle), 'cathedral oriented east (±25°)').toBeLessThanOrEqual(0.45);
      }
      // shanty towns: their own partition (no plots), huts of 15–40 m², 50–70 % built, on low-value land outside
      for (const s of m.shanty) {
        expect(s.plots, 'no plots in a shanty town').toBe(0);
        expect(s.cov, 'shanty coverage ≥ 50 %').toBeGreaterThanOrEqual(0.5);
        expect(s.cov, 'shanty coverage ≤ 70 %').toBeLessThanOrEqual(0.7);
        expect(s.hutMin, 'huts ≥ 15 m²').toBeGreaterThanOrEqual(15);
        expect(s.hutMax, 'huts ≤ 40 m²').toBeLessThanOrEqual(40.5);
        expect(s.inside, 'outside the walls').toBeLessThanOrEqual(0.05);
        expect(s.lowValue, 'on low-value land (glacis, floodplain, slope, roadside, nuisance)').toBeGreaterThanOrEqual(0.6);
      }
    });
  }
  it('determinism with every M4 feature', () => {
    const o = makeOptions({ seed: '6', size: 'town', coast: 'W', suburbs: 'many', shantytowns: 'some', arena: 'yes', castle: 'yes' });
    const a = generate(o), b = generate(makeOptions({ ...o }));
    expect(JSON.stringify(a.urban)).toBe(JSON.stringify(b.urban));
    expect(renderSvg(a)).toBe(renderSvg(b));
  });
  it('toggles switch the landmarks off', () => {
    const w = generate(makeOptions({ seed: '2', size: 'city', castle: 'no', cathedral: 'no', palace: 'no', monasteries: 'no', port: 'no', activities: 'no', shantytowns: 'none', suburbs: 'none' }));
    const kinds = new Set((w.urban!.sites ?? []).map((s) => s.kind));
    for (const k of ['castle', 'cathedral-close', 'palace', 'monastery', 'river-port', 'harbour', 'watermill', 'shanty']) expect(kinds.has(k), k).toBe(false);
    expect(w.urban!.phases.some((p) => p.zone === 'faubourg'), 'no suburbs').toBe(false);
  });
  it('options round-trip through the URL', () => {
    const o = makeOptions({ seed: 'm4', castle: 'no', cathedral: 'yes', palace: 'no', monasteries: 'yes', port: 'no', arena: 'yes', activities: 'no', suburbs: 'many', shantytowns: 'some' });
    expect(fromQuery(toQuery(o))).toEqual({ ...o, roads: 0 });
  });
});
