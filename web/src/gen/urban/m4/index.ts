/**
 * M4 — landmarks, activities, port, suburbs and shanty towns (URBAN_LANDMARKS.md). This module decides which
 * features a settlement gets (options × size × culture catalogue) and registers the landmark plan builders.
 */
import type { Rng } from '../../core/rng';
import type { Options } from '../../options';
import type { Culture } from '../culture';
import { registerBuilders } from '../compounds';
import { buildCastle, type CastleVariant } from './castle';
import { buildCathedralClose, buildPalace, buildMonastery, buildMadrasa, buildHospital } from './plans';
import { buildShipyard, buildRopewalk } from './port';
import { buildShanty } from './shanty';
import { buildWatermill, buildWindmill, buildTannery, buildGallows, buildLazarHouse, buildCemetery, buildArena } from './activities';

/** Per-culture M4 catalogue (URBAN_MORPHOLOGY.md: each culture has its own landmarks). */
export interface M4Catalogue {
  castle?: CastleVariant | 'none';
  cathedral?: string | null;
  palace?: string | null;
  monastery?: string | null;
  marketHall?: boolean;
  /** Probability of an arena (fossil oval) in auto mode. */
  arena?: number;
  /** Shanty-town flavour: the zone outside the walls, bidonville edges, hillside gecekondu, river banks. */
  shanty?: 'zone' | 'bidonville' | 'gecekondu' | 'riverbank';
  port?: boolean;
  /** European activities (mills, windmills, nuisance trades, inns, gallows, lazar house) in auto mode. */
  activities?: boolean;
  /** A walled arsenal (basin and covered slips) reserved at level 1 in a large town (lagoon towns). */
  arsenal?: boolean;
}

export const DEFAULT_M4: Required<M4Catalogue> = {
  castle: 'castle', cathedral: 'cathedral-close', palace: 'palace-eu', monastery: 'monastery', marketHall: true, arena: 0.04, shanty: 'zone', port: true, activities: true, arsenal: false,
};

export interface M4Flags {
  castle: CastleVariant | null;
  /** Number of castles to site (each on a distinct defensible site). */
  castles: number;
  cathedral: string | null;
  palace: string | null;
  monasteries: number;
  monastery: string | null;
  marketHall: boolean;
  port: boolean;
  arena: boolean;
  activities: boolean;
  suburbs: 'none' | 'some' | 'many';
  shanty: 'none' | 'some' | 'many';
  shantyKind: Required<M4Catalogue>['shanty'];
}

/** Which M4 features this settlement gets. */
export function m4Flags(opts: Options, culture: Culture, pop: number, archetype: string, rng: Rng): M4Flags {
  const cat: Required<M4Catalogue> = { ...DEFAULT_M4, ...(culture.m4 ?? {}) } as Required<M4Catalogue>;
  const town = archetype === 'town';
  const tri = (v: string | undefined, auto: boolean): boolean => (v === 'yes' ? true : v === 'no' ? false : auto);
  let castle: CastleVariant | null = null;
  const cv = cat.castle === 'none' ? null : cat.castle;
  if (opts.castle === 'yes') castle = cv ?? (culture.id === 'japanese-jokamachi' ? null : 'castle');
  else if (opts.castle !== 'no' && cv) {
    if (town && pop >= 1800) castle = cv;
    else if (archetype === 'nucleated-village' && cv === 'castle' && pop >= 350 && rng.fork('motte').chance(0.3)) castle = 'motte';
  }
  if (castle === 'castle' && !town) castle = 'motte';
  // the castle count option: 0–3 castles (a citadel, a bridgehead castle, a palace-fortress...)
  let castles = castle ? 1 : 0;
  const co = opts.castles ?? 'auto';
  if (co !== 'auto') {
    castles = Number(co);
    if (castles > 0 && !castle) castle = cv ?? (culture.id === 'japanese-jokamachi' ? null : town ? 'castle' : 'motte');
    if (!castle) castles = 0;
    if (!town) castles = Math.min(castles, 1);
  }
  const city = town && pop >= 9000;
  const cathedral = cat.cathedral && tri(opts.cathedral, city) && town ? cat.cathedral : null;
  const palace = cat.palace && tri(opts.palace, town && pop >= 9000) && town ? cat.palace : null;
  const monAuto = !town ? 0 : pop < 2500 ? (rng.fork('mon').chance(0.5) ? 1 : 0) : pop < 9000 ? 1 + (rng.fork('mon').chance(0.4) ? 1 : 0) : Math.min(6, 2 + Math.floor(pop / 12000));
  const monasteries = cat.monastery ? (opts.monasteries === 'no' ? 0 : opts.monasteries === 'yes' ? Math.max(1, monAuto) : monAuto) : 0;
  const arena = tri(opts.arena, town && rng.fork('arena').chance(cat.arena)) && town;
  const sub = opts.suburbs ?? 'auto';
  const suburbs = sub === 'auto' ? (pop >= 40000 ? 'many' : 'some') : sub;
  const sh = opts.shantytowns ?? 'auto';
  const shanty = sh === 'auto' ? (town && pop >= 9000 ? 'some' : 'none') : town ? sh : 'none';
  return {
    castle: castles ? castle : null, castles, cathedral, palace, monasteries, monastery: cat.monastery, marketHall: cat.marketHall && town,
    // fantasy cultures keep their own plan: no gallows, lazar houses or shanty belts unless asked for
    port: cat.port && opts.port !== 'no', arena,
    activities: opts.activities === 'yes' || (opts.activities !== 'no' && !culture.fantasy && cat.activities), suburbs,
    shanty: culture.fantasy && sh === 'auto' ? 'none' : shanty, shantyKind: cat.shanty,
  };
}

let registered = false;
export function registerM4(): void {
  if (registered) return;
  registered = true;
  registerBuilders({
    'm4-castle': buildCastle, 'm4-cathedral-close': buildCathedralClose, 'm4-palace-eu': buildPalace, 'm4-palace': buildPalace,
    'm4-monastery': buildMonastery, 'm4-madrasa': buildMadrasa, 'm4-shipyard': buildShipyard, 'm4-ropewalk': buildRopewalk,
    'm4-watermill': buildWatermill, 'm4-windmill': buildWindmill, 'm4-tannery': buildTannery, 'm4-gallows': buildGallows,
    'm4-lazar-house': buildLazarHouse, 'm4-cemetery': buildCemetery, 'm4-arena': buildArena, hospital: buildHospital, 'm4-shanty': buildShanty,
  });
}
