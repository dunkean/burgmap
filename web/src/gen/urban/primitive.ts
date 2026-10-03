/** Culture-specific freestanding dwellings in the street engine's exact, served lots. */
import type { Rng } from '../core/rng';
import type { Plot } from './plots';
import type { MorphologyParams } from './morphology';
import type { ArchBldg } from './bops';
import { area } from '../geo/poly';
import { fitIn, hut, rect, apsidal, bowSided } from './camps/kit';
import { shapeOkObb } from './access';

export function primitiveHouse(pl: Plot, cov: number, P: MorphologyParams, rng: Rng): ArchBldg[] {
  const typology = P.arch.typology;
  const round = ['roundhouse', 'beehive-hut', 'tipi', 'ger', 'orc-hut', 'smial'].includes(typology);
  const long = typology === 'longhouse' || typology === 'byre-house';
  const angle = Math.atan2(pl.front[1].y - pl.front[0].y, pl.front[1].x - pl.front[0].x) + (long && !rng.chance(0.22) ? Math.PI / 2 : 0);
  const maxSize = ({ tipi: 30, ger: 45, 'beehive-hut': 35, roundhouse: 125, 'orc-hut': 95, smial: 105 } as Record<string, number>)[typology] ?? (long ? 240 : 150);
  const size = Math.min(maxSize, area(pl.poly) * Math.max(0.16, Math.min(0.7, cov))) * rng.range(0.75, 1.05);
  const ratio = long ? rng.range(1.8, 2.7) : rng.range(1, 1.6);
  // Keep the fitted width above the common postprocessing minimum: thin huts would disappear there.
  const width = long ? rng.range(5.2, 7.2) : Math.sqrt(size / ratio);
  const length = long ? Math.max(width * 1.4, Math.min(width * ratio, size / width)) : width * ratio;
  const bow = rng.fork('bow').range(0.14, 0.28);
  const shape = (L: number) => (c: { x: number; y: number }, s: number) => round ? hut(c, Math.sqrt(size / Math.PI) * s, typology === 'tipi' ? 12 : 16, angle)
    : typology === 'longhouse' && P.arch.material !== 'bark' ? bowSided(c, angle, L * s, width * s, bow)
      : long && P.arch.material === 'bark' ? apsidal(c, angle, L * s, width * s)
        : rect(c, angle, L * s, width * s);
  const minScale = long ? Math.max(0.6, 4.7 / width) : 0.6;
  let house = fitIn(pl.poly, shape(length), [], { margin: 0.8, gap: 0, minScale, nc: 8 });
  if ((!house || !shapeOkObb(house)) && long) house = fitIn(pl.poly, shape(width * 1.4), [], { margin: 0.8, gap: 0, minScale, nc: 8 });
  if (!house || area(house) < 16 || !shapeOkObb(house)) return [];
  const out: ArchBldg[] = [{ poly: house, kind: 'house', arch: typology, roof: P.arch.roof, material: P.arch.material, storeys: Math.round(rng.range(P.arch.storeys[0], P.arch.storeys[1])), orientation: angle }];
  if (round && maxSize <= 45 && area(pl.poly) > 200) {
    for (let i = 0; i < 2; i++) {
      const hr = rng.fork('hut:' + i);
      if (!hr.chance(0.6)) continue;
      const radius = Math.sqrt(size / Math.PI) * hr.range(0.85, 1.05);
      const fp = fitIn(pl.poly, (c, s) => hut(c, radius * s, typology === 'tipi' ? 12 : 16, angle), out.map((b) => b.poly), { margin: 0.8, gap: 1.2, minScale: 0.8, nc: 24 });
      if (fp && area(fp) >= 16 && shapeOkObb(fp)) out.push({ ...out[0], poly: fp });
    }
  }
  if (typology !== 'tipi' && typology !== 'ger' && area(pl.poly) > 220 && rng.fork('granary').chance(0.36)) {
    const shed = fitIn(pl.poly, (c, s) => rect(c, angle, 6.3 * s, 5.8 * s), out.map((b) => b.poly), { margin: 0.8, gap: 1.2, minScale: 0.8, nc: 24 });
    if (shed && shapeOkObb(shed)) out.push({ poly: shed, kind: 'shed', arch: 'granary', roof: 'gable', material: P.arch.material, storeys: 1, orientation: angle });
  }
  return out;
}
