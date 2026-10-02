/**
 * Cultures and plans (URBAN_MORPHOLOGY.md §1, §3, §4). A culture is plain data (JSON-serializable): a nucleus, a
 * phase recipe (core + ring templates, count by population), morphologies per phase, the faubourg morphology, a
 * landmark catalogue, the forms of its hamlets and villages, wall style and render hints. A plan is a nucleus plus
 * resolved phases; it comes from the culture, optionally mixed with a second culture (by phases, sectors or a
 * continuous blend of the numeric dials) or replaced by an explicit `plan` override object.
 */
import type { MorphologyParams, MorphRef, Range, Zone } from './morphology';
import { resolveMorph, blendParams } from './morphology';
import { CULTURE_LIST } from './cultures';
import type { SitePrefs } from '../options';
import type { M4Catalogue } from './m4/index';

export type EnclosureShape = 'organic' | 'rect' | 'rounded-rect' | 'square' | 'oval' | 'circle' | 'terraces';
export interface EnclosureSpec {
  shape: EnclosureShape;
  /** 'auto' = walled by the town-size rule (and the `walls` option). */
  wall: 'auto' | 'wall' | 'palisade' | 'hedge' | 'none';
  /** What an older line becomes once a later phase surpasses it. */
  fossil: 'street' | 'wall' | 'none';
  towers?: 'round' | 'square';
  moat?: boolean;
  /** Gates where the roads cross the line, or centred on the four sides (roads are led to them). */
  gates?: 'roads' | 'cardinal';
  orientation?: 'road' | 'cardinal' | 'terrain';
  aspect?: Range;
}
export interface SectorSpec { morphology: MorphRef; share: number; culture?: string }
export interface PhaseSpec { morphology: MorphRef; enclosure: EnclosureSpec; share?: number; sectors?: SectorSpec[]; culture?: string }
export type NucleusKind = 'market' | 'forum' | 'mosque' | 'drum-tower' | 'castle' | 'temple' | 'grove' | 'none';
export interface NucleusSpec {
  kind: NucleusKind;
  shape: 'hull' | 'rect' | 'square' | 'circle';
  /** m², or the European market-size rule. */
  area: Range | 'market';
  /** A claimed compound lot (landmark builder) rather than an open place. */
  compound: boolean;
  /** Width of the street around it (m). */
  ring: number;
  orientation?: 'road' | 'cardinal' | 'qibla' | 'terrain';
}
export type LandmarkPlace = 'adjacent-nucleus' | 'near-nucleus' | 'edge' | 'axis-north' | 'east' | 'west' | 'any' | 'gate' | 'high' | 'spread';
export interface LandmarkSpec {
  role: 'worship' | 'power' | 'market' | 'civic' | 'extra';
  /** Footprint builder id (landmarks.ts). */
  kind: string;
  place: LandmarkPlace;
  /** Lot area range (m²). */
  area: Range;
  minPop: number;
  count?: number;
  /** One more per this many inhabitants (e.g. parish churches: one per ~2,200). */
  perPop?: number;
  /** Minimum distance between two landmarks of this kind (m). */
  sep?: number;
  /** Claimed at level 1 as a region of its own (large compounds at the edge: kasbah, castle). */
  level1?: boolean;
}
export interface RenderHints {
  towerShape: 'round' | 'square';
  /** Draw plot boundaries of compound lots as walls. */
  compoundWalls?: boolean;
  /** Ward walls along the ward streets (Chinese fang). */
  wardWalls?: boolean;
  /** Tree canopies over the town (elven). */
  canopy?: boolean;
  /** Hachured terrace retaining walls (dwarven). */
  terraces?: boolean;
  /** Moat outside the town wall. */
  moat?: boolean;
}
export interface SettlementForm {
  /** Village / hamlet layout: EO rule (street or nucleated village), a walled compact block, a grove, terraces. */
  form: 'auto' | 'walled' | 'grove' | 'terraces' | 'ring';
  morphology?: MorphRef;
  enclosure?: Partial<EnclosureSpec>;
  nucleus?: Partial<NucleusSpec>;
}
export interface Culture {
  id: string;
  label: string;
  fantasy?: boolean;
  nucleus: NucleusSpec;
  core: PhaseSpec;
  ring: PhaseSpec | null;
  /** [minimum population, number of enclosed phases] thresholds, ascending. */
  phaseCount: [number, number][];
  faubourg: MorphRef | null;
  /** Share of the population in faubourgs: [walled, unwalled]. */
  faubShare: [number, number];
  landmarks: LandmarkSpec[];
  village: SettlementForm;
  hamlet: SettlementForm;
  render: RenderHints;
  /** Site preferences (site/site.ts), used when the `sitePrefs` option is not set. */
  sitePrefs?: SitePrefs;
  /** M4 landmark catalogue (castle variant, cathedral, palace, monasteries, port, shanty flavour). */
  m4?: M4Catalogue;
}
export interface CultureMix { id: string; t: number; mode: 'phases' | 'sectors' | 'blend' }
export interface PlanOverride {
  nucleus?: Partial<NucleusSpec>;
  phases?: PhaseSpec[];
  faubourg?: MorphRef | null;
}

export const CULTURES: Record<string, Culture> = Object.fromEntries(CULTURE_LIST.map((c) => [c.id, c]));
export const CULTURE_IDS = CULTURE_LIST.map((c) => c.id);
export const getCulture = (id: string | undefined): Culture => CULTURES[id ?? ''] ?? CULTURES['european-organic'];

export interface ResolvedSector { morph: MorphologyParams; share: number; culture: string }
export interface ResolvedPhase {
  morph: MorphologyParams;
  enc: EnclosureSpec;
  culture: string;
  /** Population share (sums to 1 over the enclosed phases). */
  share: number;
  sectors: ResolvedSector[];
}
export interface ResolvedPlan {
  culture: Culture;
  /** Cultures present (primary first). */
  cultures: Culture[];
  nucleus: NucleusSpec;
  phases: ResolvedPhase[];
  faubourg: MorphologyParams;
  faubShare: [number, number];
  landmarks: (LandmarkSpec & { culture: string })[];
  render: RenderHints;
  mix?: CultureMix;
}

const SHARES: Record<number, number[]> = { 1: [1], 2: [0.42, 0.58], 3: [0.24, 0.36, 0.4], 4: [0.13, 0.22, 0.3, 0.35], 5: [0.1, 0.16, 0.22, 0.25, 0.27] };

function countFor(c: Culture, pop: number): number {
  let n = 1;
  for (const [p, k] of c.phaseCount) if (pop >= p) n = k;
  return c.ring ? n : 1;
}

const phaseSpecs = (c: Culture, n: number): PhaseSpec[] => Array.from({ length: n }, (_, k) => ({ ...(k === 0 || !c.ring ? c.core : c.ring), culture: c.id }));

/** Resolves the enclosed phases of a town-sized settlement. */
export function resolvePlan(cultureId: string, pop: number, mix?: CultureMix | null, override?: PlanOverride | null): ResolvedPlan {
  const c = getCulture(cultureId);
  const m = mix && mix.id !== c.id && CULTURES[mix.id] ? CULTURES[mix.id] : null;
  let specs: PhaseSpec[];
  let shares: number[];
  const nucleus: NucleusSpec = { ...c.nucleus, ...(override?.nucleus ?? {}) };
  let faubRef: MorphRef | null = c.faubourg;
  let faubShare = c.faubShare;
  if (override?.phases?.length) {
    specs = override.phases.map((p) => ({ culture: c.id, ...p }));
    const given = specs.map((p) => p.share ?? 0);
    shares = given.every((x) => x > 0) ? given : SHARES[Math.min(5, specs.length)] ?? specs.map(() => 1 / specs.length);
  } else if (m && mix!.mode === 'phases') {
    // growth phases: the primary culture builds the old town (all its phases, weight 1 − t), the secondary builds
    // the extension rings around it (weight t) with its own morphology
    const t = Math.max(0.1, Math.min(0.9, mix!.t));
    const n1 = countFor(c, pop);
    const n2 = Math.max(1, Math.min(3, Math.round((n1 * t) / (1 - t))));
    const ext: PhaseSpec = m.ring ? { ...m.ring, culture: m.id }
      : { morphology: m.core.morphology, enclosure: { shape: 'organic', wall: m.core.enclosure.wall, fossil: 'street', towers: m.core.enclosure.towers }, culture: m.id };
    specs = [...phaseSpecs(c, n1), ...Array.from({ length: n2 }, () => ({ ...ext, share: undefined }))];
    const group = (list: PhaseSpec[], total: number): number[] => {
      const base = SHARES[Math.min(5, list.length)];
      const fixed = list.reduce((a, p) => a + (p.share ?? 0), 0);
      const free = base.reduce((a, x, k) => a + (list[k].share ? 0 : x), 0);
      return list.map((p, k) => total * (p.share ?? (free > 0 ? (base[k] / free) * Math.max(0.05, 1 - fixed) : 0)));
    };
    shares = [...group(specs.slice(0, n1), 1 - t), ...group(specs.slice(n1), t)];
    faubRef = m.faubourg ?? c.faubourg;
    faubShare = m.faubShare;
  } else {
    const n = countFor(c, pop);
    specs = phaseSpecs(c, n);
    shares = SHARES[Math.min(5, n)];
  }
  // phases with an explicit share keep it; the others share the rest in the default proportions
  if (!override?.phases?.length && !(m && mix!.mode === 'phases') && specs.some((p) => p.share)) {
    const fixed = specs.reduce((a, p) => a + (p.share ?? 0), 0);
    const free = shares.reduce((a, x, k) => a + (specs[k].share ? 0 : x), 0);
    shares = shares.map((x, k) => specs[k].share ?? (free > 0 ? (x / free) * Math.max(0.05, 1 - fixed) : 0));
  }
  if (override && override.faubourg !== undefined) faubRef = override.faubourg;
  const phases: ResolvedPhase[] = specs.map((sp, k) => {
    let morph = resolveMorph(sp.morphology);
    const pc = CULTURES[sp.culture ?? c.id] ?? c;
    let sectors: ResolvedSector[] = (sp.sectors ?? []).map((s) => ({ morph: resolveMorph(s.morphology), share: s.share, culture: s.culture ?? pc.id }));
    if (m && mix!.mode === 'blend') {
      const other = resolveMorph((k === 0 ? m.core : m.ring ?? m.core).morphology);
      morph = blendParams(morph, other, mix!.t);
    }
    if (m && mix!.mode === 'sectors' && (k > 0 || specs.length === 1)) {
      sectors = [...sectors, { morph: resolveMorph((m.ring ?? m.core).morphology), share: mix!.t, culture: m.id }];
    }
    return { morph, enc: sp.enclosure, culture: pc.id, share: shares[k] ?? 1 / specs.length, sectors };
  });
  let faubourg = resolveMorph(faubRef ?? phases[phases.length - 1].morph.id);
  if (m && mix!.mode === 'blend') faubourg = blendParams(faubourg, resolveMorph(m.faubourg ?? m.core.morphology), mix!.t);
  const cultures = [c, ...(m ? [m] : [])];
  // landmarks: one per role and culture present (deduplicated by role + kind)
  const landmarks: ResolvedPlan['landmarks'] = [];
  for (const cc of cultures) {
    if (!phases.some((p) => p.culture === cc.id || p.sectors.some((s) => s.culture === cc.id))) continue;
    for (const l of cc.landmarks) if (!landmarks.some((x) => x.role === l.role && x.kind === l.kind)) landmarks.push({ ...l, culture: cc.id });
  }
  return { culture: c, cultures, nucleus, phases, faubourg, faubShare, landmarks, render: c.render, mix: m ? mix! : undefined };
}

/** Serialized forms for the URL: `mix=id:t:mode`, `plan=<base64url JSON>`. */
export function mixToString(m: CultureMix | null | undefined): string {
  return m ? `${m.id}:${Math.round(m.t * 100) / 100}:${m.mode}` : '';
}
export function mixFromString(s: string | null | undefined): CultureMix | null {
  if (!s) return null;
  const [id, t, mode] = s.split(':');
  if (!CULTURES[id]) return null;
  const tt = Number(t);
  return { id, t: Number.isFinite(tt) ? Math.max(0, Math.min(1, tt)) : 0.5, mode: mode === 'sectors' || mode === 'blend' ? mode : 'phases' };
}
const b64e = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64d = (s: string): string => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
};
export function planToString(p: PlanOverride | null | undefined): string {
  return p ? b64e(JSON.stringify(p)) : '';
}
export function planFromString(s: string | null | undefined): PlanOverride | null {
  if (!s) return null;
  try {
    const o = JSON.parse(b64d(s));
    if (!o || typeof o !== 'object') return null;
    const out: PlanOverride = {};
    if (Array.isArray(o.phases)) out.phases = o.phases.filter((ph: unknown) => ph && typeof ph === 'object' && (ph as PhaseSpec).enclosure && (ph as PhaseSpec).morphology).slice(0, 6);
    if (o.nucleus && typeof o.nucleus === 'object') out.nucleus = o.nucleus;
    if (o.faubourg !== undefined) out.faubourg = o.faubourg;
    return out;
  } catch { return null; }
}

export type { Zone };
