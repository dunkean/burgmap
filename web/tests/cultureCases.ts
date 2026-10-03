/** Shared cases and assertions of the culture invariant suites (URBAN_GEOMETRY.md §6 on every preset and mix). */
import { expect } from 'vitest';
import type { World } from '../src/gen/types';
import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName, Options } from '../src/gen/options';
import { mixFromString } from '../src/gen/urban/culture';
import { checkWorld } from './urbanCheck';

export interface CultureCase { label: string; culture: string; mix?: string; relief?: Options['relief']; /** Seeds of this case (default SEEDS). */ seeds?: string[] }

/** Every preset (the fantasy ones on their preferred ground) and the two mixes required by M3b. */
export const CULTURE_CASES: CultureCase[] = [
  { label: 'european-organic', culture: 'european-organic' },
  { label: 'bastide', culture: 'bastide' },
  { label: 'roman-core', culture: 'roman-core' },
  { label: 'medina', culture: 'medina' },
  { label: 'chinese', culture: 'chinese' },
  { label: 'japanese-jokamachi', culture: 'japanese-jokamachi' },
  { label: 'indian-temple', culture: 'indian-temple' },
  { label: 'elven', culture: 'elven' },
  { label: 'dwarven', culture: 'dwarven', relief: 'mountains' },
  // (the cultures added by the second culture pass: two seeds each, the suite stays near its time budget)
  { label: 'inca', culture: 'inca', seeds: ['1', '2'] },
  { label: 'aztec', culture: 'aztec', seeds: ['1', '2'] },
  { label: 'russian-kremlin', culture: 'russian-kremlin', seeds: ['1', '2'] },
  { label: 'necropolis', culture: 'necropolis', seeds: ['1', '2'] },
  // (the third culture pass)
  { label: 'byzantine-greek', culture: 'byzantine-greek', seeds: ['1', '2'] },
  { label: 'venetian-lagoon', culture: 'venetian-lagoon', seeds: ['1', '2'] },
  { label: 'persian', culture: 'persian', seeds: ['1', '2'] },
  { label: 'ottoman', culture: 'ottoman', seeds: ['1', '2'] },
  { label: 'sahel', culture: 'sahel', seeds: ['1', '2'] },
  { label: 'hanseatic', culture: 'hanseatic', seeds: ['1', '2'] },
  { label: 'roman-core+european-organic', culture: 'roman-core', mix: 'european-organic:0.6:phases' },
  { label: 'medina+bastide', culture: 'medina', mix: 'bastide:0.45:phases' },
];

export const SEEDS = ['1', '2', '3', '4'];

export function generateCase(c: CultureCase, size: SizeName, seed: string): World {
  return generate(makeOptions({ seed, size, culture: c.culture, cultureMix: c.mix ? mixFromString(c.mix) : null, ...(c.relief ? { relief: c.relief } : {}) }));
}

/** The §6 invariants (same thresholds as the European suites). */
export function expectInvariants(w: World): void {
  const r = checkWorld(w);
  const msg = r.details.slice(0, 8).join('\n');
  expect(r.blocks, 'has blocks').toBeGreaterThan(0);
  expect(r.blockAreaErr, 'blocks = plots + back land (±0.5 %)\n' + msg).toBeLessThanOrEqual(0.005);
  expect(r.blockOutside, 'blocks inside their quarter\n' + msg).toBeLessThan(1);
  expect(r.overlapsBlocks, 'no block overlaps').toBe(0);
  expect(r.overlapsPlots, 'no parcel overlaps\n' + msg).toBe(0);
  expect(r.overlapsBuildings, 'building overlaps\n' + msg).toBeLessThanOrEqual(Math.ceil(r.buildings * 0.0005));
  expect(r.noFrontage, 'every plot has ≥ 3 m of street frontage\n' + msg).toBe(0);
  expect(r.bldgOutside, 'buildings inside their plot\n' + msg).toBe(0);
  expect(r.acute + r.thin, 'acute (<12°) or thin (<2 m) shapes\n' + msg).toBeLessThanOrEqual(Math.max(2, Math.ceil(0.01 * (r.plots + r.buildings))));
  expect(r.orphanMain, 'main streets connect to the radials').toBe(0);
}

/** Plan signatures that make each culture identifiable (checked on towns and cities). */
export function expectSignature(c: CultureCase, w: World): void {
  const u = w.urban!;
  const arch = new Map<string, number>();
  for (const b of u.buildings) arch.set(b.arch ?? b.kind, (arch.get(b.arch ?? b.kind) ?? 0) + 1);
  const has = (a: string) => (arch.get(a) ?? 0) > 0;
  const closes = u.streets.filter((s) => s.role === 'close').length;
  const compounds = new Set(u.blockInfo.map((b) => b.compound).filter(Boolean));
  expect(u.culture, 'culture recorded').toBe(c.culture);
  switch (c.label) {
    case 'medina':
      expect(closes, 'medina: a tree of dead-end derbs').toBeGreaterThan(15);
      expect(has('courtyard-house'), 'medina: courtyard houses').toBe(true);
      expect(compounds.has('great-mosque'), 'medina: great mosque compound').toBe(true);
      expect(has('minaret'), 'medina: minaret').toBe(true);
      break;
    case 'chinese':
      expect((u.walls ?? []).length, 'chinese: walled').toBeGreaterThan(0);
      expect(has('siheyuan-main-hall'), 'chinese: siheyuan').toBe(true);
      expect(has('drum-tower'), 'chinese: drum tower').toBe(true);
      expect((u.lines ?? []).some((l) => l.kind === 'ward-wall'), 'chinese: ward walls').toBe(true);
      break;
    case 'japanese-jokamachi':
      expect((u.walls ?? []).length, 'jokamachi: no town wall').toBe(0);
      expect(has('tenshu'), 'jokamachi: castle keep').toBe(true);
      expect(has('machiya'), 'jokamachi: machiya').toBe(true);
      expect(has('yashiki-main-house') || has('nagaya-mon'), 'jokamachi: samurai yashiki').toBe(true);
      break;
    case 'indian-temple':
      expect(has('gopuram'), 'indian: gopuram gates').toBe(true);
      expect(has('vimana-sanctum'), 'indian: sanctum').toBe(true);
      expect(u.streets.filter((s) => s.role === 'ring').length, 'indian: ring streets').toBeGreaterThan(2);
      break;
    case 'elven':
      expect(has('tree-house'), 'elven: tree houses').toBe(true);
      expect((u.trees ?? []).length, 'elven: canopy').toBeGreaterThan(50);
      expect(compounds.has('grove'), 'elven: sacred grove').toBe(true);
      break;
    case 'dwarven':
      expect(has('stone-hall') || has('octagonal-hall'), 'dwarven: stone halls').toBe(true);
      expect((u.lines ?? []).some((l) => l.kind === 'terrace'), 'dwarven: terraces').toBe(true);
      break;
    case 'inca':
      expect(has('kancha-house'), 'inca: kancha compounds').toBe(true);
      expect(has('ushnu'), 'inca: ushnu on the great plaza').toBe(true);
      expect(compounds.has('inca-temple'), 'inca: temple').toBe(true);
      expect((u.walls ?? []).filter((wl) => wl.role === 'town').length, 'inca: no town wall').toBe(0);
      break;
    case 'aztec':
      expect(compounds.has('aztec-precinct'), 'aztec: ceremonial precinct').toBe(true);
      expect(has('templo-mayor'), 'aztec: Templo Mayor').toBe(true);
      expect((u.lines ?? []).some((l) => l.kind === 'canal'), 'aztec: canals').toBe(true);
      break;
    case 'russian-kremlin':
      expect(has('izba'), 'russian: log houses in yards').toBe(true);
      expect(has('orthodox-church'), 'russian: domed parish churches').toBe(true);
      expect((u.sites ?? []).some((st) => st.kind === 'kremlin'), 'russian: kremlin').toBe(true);
      break;
    case 'necropolis':
      expect(has('mausoleum') || has('tholos'), 'necropolis: tombs').toBe(true);
      expect(has('great-mausoleum'), 'necropolis: mortuary temple').toBe(true);
      break;
    case 'byzantine-greek':
      expect(has('cross-in-square-church') || has('metropolis-church'), 'byzantine: domed cross-in-square churches').toBe(true);
      expect((u.lines ?? []).some((l) => l.kind === 'dome'), 'byzantine: domes').toBe(true);
      expect((u.sites ?? []).some((st) => st.kind === 'kastro'), 'byzantine: kastro').toBe(true);
      break;
    case 'venetian-lagoon': {
      const lk = new Set((u.lines ?? []).map((l) => l.kind));
      expect(lk.has('canal'), 'venetian: canals').toBe(true);
      expect(lk.has('footbridge'), 'venetian: footbridges').toBe(true);
      expect(compounds.has('campo'), 'venetian: island campi').toBe(true);
      expect(has('palazzo'), 'venetian: palazzi on the canals').toBe(true);
      break;
    }
    case 'persian':
      expect(u.landmarks.some((l) => l.kind === 'maidan'), 'persian: maidan').toBe(true);
      expect(has('maidan-arcade'), 'persian: arcades round the maidan').toBe(true);
      expect(has('qibla-iwan') && has('iwan'), 'persian: four-iwan Friday mosque').toBe(true);
      expect(has('caravanserai-cells'), 'persian: caravanserais').toBe(true);
      expect(has('persian-courtyard-house'), 'persian: courtyard houses').toBe(true);
      break;
    case 'ottoman':
      expect((arch.get('mescit') ?? 0), 'ottoman: a mescit per mahalle').toBeGreaterThan(2);
      expect(has('ottoman-wooden-house'), 'ottoman: wooden houses').toBe(true);
      expect(has('ulu-cami') || has('kulliye-mosque'), 'ottoman: Ulu Cami or kulliye').toBe(true);
      expect(has('dukkan-shop'), 'ottoman: carsi shops').toBe(true);
      break;
    case 'sahel':
      expect(has('mud-great-mosque'), 'sahel: the great mud mosque').toBe(true);
      expect(has('granary'), 'sahel: granaries in the compounds').toBe(true);
      expect(has('sudano-sahelian-house'), 'sahel: mud houses').toBe(true);
      break;
    case 'hanseatic':
      expect(has('giebelhaus'), 'hanseatic: gabled merchant houses').toBe(true);
      expect(has('gang-bude'), 'hanseatic: Gange with their Buden').toBe(true);
      expect(has('brick-hall-church'), 'hanseatic: brick hall church').toBe(true);
      break;
    case 'roman-core': case 'roman-core+european-organic':
      expect(u.landmarks.some((l) => l.kind === 'forum'), 'roman: forum').toBe(true);
      break;
    case 'medina+bastide':
      expect(new Set(u.blockInfo.map((b) => b.culture)).size, 'mix: two cultures built blocks').toBeGreaterThan(1);
      break;
    default: break;
  }
}
