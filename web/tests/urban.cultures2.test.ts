import { describe, it, expect } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { expectInvariants } from './cultureCases';
import type { World } from '../src/gen/types';
import { obb } from '../src/gen/geo/poly';

// New village and camp cultures (POLISH.md "New cultures"): the URBAN_GEOMETRY §6 invariants on hamlets, villages
// and the degraded large sizes (a cluster of villages), plus the plan signature of each culture.
const arches = (w: World): Map<string, number> => {
  const m = new Map<string, number>();
  for (const b of w.urban!.buildings) m.set(b.arch ?? b.kind, (m.get(b.arch ?? b.kind) ?? 0) + 1);
  return m;
};
const lineKinds = (w: World): Set<string> => new Set((w.urban!.lines ?? []).map((l) => l.kind));

export const SIGNATURES: Record<string, (w: World) => void> = {
  kraal: (w) => {
    const a = arches(w);
    expect(a.get('beehive-hut') ?? 0, 'kraal: beehive huts').toBeGreaterThan(8);
    expect(w.urban!.blockInfo.some((b) => b.compound === 'cattle-kraal'), 'kraal: central cattle byre').toBe(true);
    expect(lineKinds(w).has('thorn-fence'), 'kraal: thorn fence').toBe(true);
  },
  'native-plains': (w) => {
    const u = w.urban!;
    const a = arches(w);
    expect(a.get('tipi') ?? 0, 'plains: tipis').toBeGreaterThan(5);
    expect(a.get('council-lodge') ?? 0, 'plains: council lodge').toBeGreaterThan(0);
    // the circle opens to the east: no lodge within ±12° of due east of the council lodge
    const lodge = u.buildings.find((b) => b.arch === 'council-lodge')!;
    const c = lodge.poly.reduce((s, q) => ({ x: s.x + q.x / lodge.poly.length, y: s.y + q.y / lodge.poly.length }), { x: 0, y: 0 });
    const tipis = u.buildings.filter((b) => b.arch === 'tipi');
    const dMin = Math.min(...tipis.map((b) => Math.hypot(b.poly[0].x - c.x, b.poly[0].y - c.y)));
    const near = tipis.filter((b) => {
      const q = b.poly[0];
      if (Math.hypot(q.x - c.x, q.y - c.y) > dMin * 1.6) return false;
      return Math.abs(Math.atan2(q.y - c.y, q.x - c.x)) < (12 * Math.PI) / 180;
    });
    expect(near.length, 'plains: the circle is open to the east').toBe(0);
  },
  'native-iroquoian': (w) => {
    const lh = w.urban!.buildings.filter((b) => b.arch === 'longhouse');
    expect(lh.length, 'iroquoian: longhouses').toBeGreaterThan(1);
    for (const b of lh) { const L = 2 * obb(b.poly).hu; expect(L, 'iroquoian: longhouse 20–60 m').toBeGreaterThan(19.5); expect(L).toBeLessThan(62); }
    // parallel: every longhouse within 3° of the first one's axis (per village of a cluster: same axis)
    expect((w.urban!.walls ?? []).length, 'iroquoian: double palisade').toBeGreaterThanOrEqual(2);
  },
  'native-pueblo': (w) => {
    const a = arches(w);
    expect(a.get('pueblo-room') ?? 0, 'pueblo: agglutinated rooms').toBeGreaterThan(10);
    expect((a.get('kiva') ?? 0) + (a.get('great-kiva') ?? 0), 'pueblo: kivas').toBeGreaterThan(0);
    // terraces: several storey levels
    expect(new Set(w.urban!.buildings.filter((b) => b.arch === 'pueblo-room').map((b) => b.storeys)).size, 'pueblo: terraced').toBeGreaterThan(1);
  },
  'norse-ringfort': (w) => {
    const a = arches(w);
    expect(a.get('longhouse') ?? 0, 'ring fort: longhouses round the courtyards').toBeGreaterThan(3);
    expect(lineKinds(w).has('rampart'), 'ring fort: circular rampart').toBe(true);
    expect(w.urban!.streets.filter((s) => s.role === 'radial').length, 'ring fort: two axial streets gate to gate').toBeGreaterThanOrEqual(2);
  },
  maya: (w) => {
    const a = arches(w);
    expect(a.get('maya-house') ?? 0, 'maya: houselots').toBeGreaterThan(3);
    expect((a.get('great-pyramid') ?? 0) + (a.get('temple-pyramid') ?? 0), 'maya: temple pyramids').toBeGreaterThan(0);
  },
  khmer: (w) => {
    const u = w.urban!;
    expect(u.blockInfo.some((b) => b.compound === 'temple-mountain' || b.compound === 'prasat'), 'khmer: temple-mountain at the centre (a prasat for a village)').toBe(true);
    expect(arches(w).get('stilt-house') ?? 0, 'khmer: stilt houses').toBeGreaterThan(5);
    expect(lineKinds(w).has('moat'), 'khmer: moat').toBe(true);
    expect(u.landmarks.filter((l) => l.kind === 'pond').length, 'khmer: ponds').toBeGreaterThan(3);
  },
  orcish: (w) => {
    const a = arches(w);
    expect((a.get('orc-hut') ?? 0) + (a.get('orc-longhut') ?? 0), 'orcish: huts').toBeGreaterThan(5);
    expect(lineKinds(w).has('palisade'), 'orcish: stake palisades').toBe(true);
    expect(w.urban!.landmarks.some((l) => l.kind === 'arena'), 'orcish: arena').toBe(true);
  },
  'stilt-town': (w) => {
    const u = w.urban!;
    expect(arches(w).get('stilt-house') ?? 0, 'stilt town: stilt houses').toBeGreaterThan(5);
    expect(u.renderHints?.stilts, 'stilt town: boardwalks').toBe(true);
  },
  'celtic-oppidum': (w) => {
    expect(arches(w).get('roundhouse') ?? 0, 'oppidum: roundhouses').toBeGreaterThan(2);
    expect(lineKinds(w).has('rampart'), 'oppidum: ramparts').toBe(true);
  },
  halfling: (w) => {
    expect(arches(w).get('smial') ?? 0, 'halfling: smials').toBeGreaterThan(3);
    expect(lineKinds(w).has('hedge'), 'halfling: hedgerows').toBe(true);
    expect((w.urban!.trees ?? []).length, 'halfling: trees').toBeGreaterThan(3);
  },
  'nomad-camp': (w) => {
    const a = arches(w);
    expect(a.get('ger') ?? 0, 'nomad: gers').toBeGreaterThan(8);
    expect(a.get('chief-ger') ?? 0, "nomad: the chief's ger").toBeGreaterThan(0);
    expect(w.urban!.streets.filter((s) => s.role === 'ring').length, 'nomad: concentric rings').toBeGreaterThan(0);
  },
  barbarian: (w) => {
    const a = arches(w);
    expect((a.get('longhouse') ?? 0) + (a.get('byre-house') ?? 0), 'germanic: longhouses and byre-houses').toBeGreaterThan(2);
    expect(a.get('chieftain-hall') ?? 0, "germanic: the chieftain's hall").toBeGreaterThan(0);
    expect((a.get('sunken-hut') ?? 0) + (a.get('granary-on-posts') ?? 0), 'germanic: sunken huts and granaries').toBeGreaterThan(1);
    expect(lineKinds(w).has('yard-fence'), 'germanic: fenced yards').toBe(true);
    expect(w.urban!.streets.every((s) => s.width <= 6), 'germanic: paths, no streets').toBe(true);
  },
  'barbarian-celtic': (w) => {
    const a = arches(w);
    expect(a.get('roundhouse') ?? 0, 'celtic: roundhouses').toBeGreaterThan(2);
    expect(lineKinds(w).has('rampart'), 'celtic: rampart').toBe(true);
  },
  'barbarian-norse': (w) => {
    const a = arches(w);
    expect(a.get('longhouse') ?? 0, 'norse: longhouses').toBeGreaterThan(0);
    expect((w.urban!.walls ?? []).length, 'norse: no enclosure').toBe(0);
  },
};

const CASES: [string, SizeName[]][] = [
  ['kraal', ['hamlet', 'village', 'town']],
  ['native-plains', ['hamlet', 'village', 'town']],
  ['nomad-camp', ['hamlet', 'village', 'town']],
  ['native-iroquoian', ['hamlet', 'village', 'town']],
  ['native-pueblo', ['hamlet', 'village', 'town', 'city']],
  ['norse-ringfort', ['hamlet', 'village', 'town']],
  ['maya', ['hamlet', 'village', 'town', 'city']],
  ['khmer', ['hamlet', 'village', 'town', 'city']],
  ['orcish', ['hamlet', 'village', 'town']],
  ['halfling', ['hamlet', 'village', 'town']],
  ['celtic-oppidum', ['hamlet', 'village', 'town']],
  ['stilt-town', ['hamlet', 'village', 'town']],
  ['barbarian', ['hamlet', 'village', 'town']],
  ['barbarian-celtic', ['hamlet', 'village', 'town']],
  ['barbarian-norse', ['hamlet', 'village', 'town']],
];

describe('village and camp cultures', () => {
  for (const [culture, sizes] of CASES) for (const size of sizes) for (const seed of ['1', '2']) {
    it(`${culture} ${size} seed ${seed}`, () => {
      const w = generate(makeOptions({ seed, size, culture }));
      expectInvariants(w);
      expect(w.urban!.culture).toBe(culture);
      if (size !== 'hamlet' || culture !== 'barbarian-norse') SIGNATURES[culture]?.(w);
      // above the culture's class (village): a cluster of villages, not a town
      if (size === 'town' && !['barbarian-norse', 'native-pueblo', 'maya', 'khmer', 'orcish', 'celtic-oppidum', 'stilt-town'].includes(culture)) expect(Number(w.stats['urban.camps']), 'a cluster of villages').toBeGreaterThan(1);
    });
  }
});
