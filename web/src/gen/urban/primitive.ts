/** Culture-specific freestanding dwellings in the street engine's exact, served lots. */
import type { Rng } from '../core/rng';
import type { Plot } from './plots';
import type { MorphologyParams } from './morphology';
import type { ArchBldg } from './bops';
import type { Polygon, Vec2 } from '../core/geom';
import { dist } from '../core/geom';
import { area, obb, inscribed } from '../geo/poly';
import { isConvex, polyInside } from '../geo/split';
import { clipPlot } from './buildings';
import { fitIn, fits, hut, rect, apsidal, bowSided } from './camps/kit';
import { shapeOkObb } from './access';

export function primitiveHouse(pl: Plot, cov: number, P: MorphologyParams, rng: Rng): ArchBldg[] {
  const typology = P.arch.typology;
  const round = ['roundhouse', 'beehive-hut', 'tipi', 'ger', 'orc-hut', 'smial'].includes(typology);
  const long = typology === 'longhouse' || typology === 'byre-house';
  let angle = Math.atan2(pl.front[1].y - pl.front[0].y, pl.front[1].x - pl.front[0].x) + (long && !rng.chance(0.22) ? Math.PI / 2 : 0);
  const iroquoian = long && P.arch.material === 'bark';
  const preferredAngle = angle;
  let householdLot = pl.poly;
  const maxSize = ({ tipi: 30, ger: 45, 'beehive-hut': 35, roundhouse: 125, 'orc-hut': 95, smial: 105 } as Record<string, number>)[typology] ?? (long ? 240 : 150);
  const size = Math.min(maxSize, area(pl.poly) * Math.max(0.16, Math.min(0.7, cov))) * rng.range(0.75, 1.05);
  const ratio = long ? rng.range(1.8, 2.7) : rng.range(1, 1.6);
  // Keep the fitted width above the common postprocessing minimum: thin huts would disappear there.
  const width = long ? rng.range(5.2, 7.2) : Math.sqrt(size / ratio);
  const length = long ? Math.max(width * 1.4, Math.min(width * ratio, size / width)) : width * ratio;
  const bow = rng.fork('bow').range(0.14, 0.28);
  const shape = (L: number) => (c: { x: number; y: number }, s: number) => round ? hut(c, Math.sqrt(size / Math.PI) * s, typology === 'tipi' ? 12 : 16, angle)
    : typology === 'longhouse' && P.arch.material !== 'bark' ? bowSided(c, angle, L * s, width * s, bow)
      // An Iroquoian longhouse shelters several families. Shrinking it into a 9 m cottage loses that programme.
      // The sampled rounded end reduces the OBB length slightly, so retain a 12.5 m nominal length when fitting.
      : iroquoian ? apsidal(c, angle, Math.max(12.5, L * s), width * s)
        : rect(c, angle, L * s, width * s);
  const minScale = long ? Math.max(0.6, 4.7 / width) : 0.6;
  // Reserve the complete shared 1.6 m passage at the outset. Later access trimming must not shorten a clan
  // longhouse into detached fragments; the other primitive cultures retain their established fitting/RNG.
  const margin = iroquoian ? 1.7 : 0.8;
  let house = fitIn(pl.poly, shape(length), [], { margin, gap: 0, minScale, nc: 8 });
  if ((!house || !shapeOkObb(house)) && long) house = fitIn(pl.poly, shape(width * 1.4), [], { margin, gap: 0, minScale, nc: 8 });
  if ((!house || !shapeOkObb(house)) && iroquoian) {
    angle += Math.PI / 2;
    house = fitIn(pl.poly, shape(12.5), [], { margin, gap: 0, minScale, nc: 24 });
  }
  if ((!house || !shapeOkObb(house)) && iroquoian) {
    const clan = fitClanLonghouse(pl, preferredAngle);
    if (clan) {
      house = clan.house; angle = clan.angle; householdLot = clan.lot;
      // A real full-width side passage was reserved before fitting, including the granary below.
      pl.gated = true;
    }
  }
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
    const shed = fitIn(householdLot, (c, s) => rect(c, angle, 6.3 * s, 5.8 * s), out.map((b) => b.poly), { margin, gap: iroquoian ? 1.7 : 1.2, minScale: 0.8, nc: 24 });
    if (shed && shapeOkObb(shed)) out.push({ poly: shed, kind: 'shed', arch: P.id === 'barbarian-town' ? 'granary-on-posts' : 'granary', roof: 'gable', material: P.id === 'barbarian-town' ? 'timber' : P.arch.material, storeys: 1, orientation: angle });
  }
  return out;
}

/** Last resort for a real clan dwelling; the existing successful fits and their draws stay unchanged. */
function fitClanLonghouse(pl: Plot, preferredAngle: number): { house: Polygon; lot: Polygon; angle: number } | null {
  const box = obb(pl.poly), axis = Math.atan2(box.u.y, box.u.x);
  const angles = [preferredAngle, preferredAngle + Math.PI / 2, axis];
  const [fa, fb] = pl.front, frontLength = dist(fa, fb);
  if (frontLength < 1e-6) return null;
  const tangent = { x: (fb.x - fa.x) / frontLength, y: (fb.y - fa.y) / frontLength };
  const margin = 0.5, length = 12, width = 4.7;
  for (const [which, side] of [pl.sideA, pl.sideB].entries()) {
    let inward = { x: -side.d.y, y: side.d.x };
    if ((inward.x * tangent.x + inward.y * tangent.y) * (which ? -1 : 1) < 0) inward = { x: -inward.x, y: -inward.y };
    const keep = { p: { x: side.p.x + inward.x * 1.6, y: side.p.y + inward.y * 1.6 }, n: inward };
    // Four largest connected pieces per side, three axes and <=50 centres each: <=1200 fixed-size
    // candidate checks. The clipping cost depends only on the input polygon, not a raster/map extent.
    const lots = clipPlot(pl.poly, [keep], isConvex(pl.poly, 1e-3)).filter((lot) => lot.length >= 3 && area(lot) >= 16)
      .sort((a, b) => area(b) - area(a)).slice(0, 4);
    for (const lot of lots) {
      const pole = inscribed(lot, [], 0.5).c;
      for (const angle of angles) {
        // A long footprint needs centres distributed over its feasible rectangle, rather than only the
        // deepest circular poles. Exactly one pole plus a fixed 7 by 7 grid, independent of lot/map extent.
        const u = { x: Math.cos(angle), y: Math.sin(angle) }, v = { x: -u.y, y: u.x };
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of lot) {
          const x = p.x * u.x + p.y * u.y, y = p.x * v.x + p.y * v.y;
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        x0 += length / 2 + margin; x1 -= length / 2 + margin;
        y0 += width / 2 + margin; y1 -= width / 2 + margin;
        const cands: Vec2[] = [pole];
        if (x1 >= x0 && y1 >= y0) for (let ix = 0; ix < 7; ix++) for (let iy = 0; iy < 7; iy++) {
          const x = x0 + (x1 - x0) * ix / 6, y = y0 + (y1 - y0) * iy / 6;
          cands.push({ x: u.x * x + v.x * y, y: u.y * x + v.y * y });
        }
        // Fit a 12 m nominal clan dwelling; the sampled apsidal ends give ~11.77 m at this width.
        // Keep both this length and the habitable width when fitting short lots.
        const house = fitIn(lot, (c) => apsidal(c, angle, length, width), [], { margin, gap: 0, minScale: 1, cands });
        if (house && shapeOkObb(house) && 2 * obb(house).hu > 11.5 && polyInside(pl.poly, house) && fits(pl.poly, house, [], margin, 0)) return { house, lot, angle };
      }
    }
  }
  return null;
}
