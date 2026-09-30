import type { Vec2, Polyline } from '../core/geom';

/** Language families the toponym grammars cover. */
export type NameFamily =
  | 'french' | 'english' | 'german' | 'italian' | 'arabic' | 'chinese' | 'japanese'
  | 'sanskrit' | 'norse' | 'elven' | 'dwarven' | 'orcish' | 'halfling';

export const NAME_FAMILIES: NameFamily[] = [
  'french', 'english', 'german', 'italian', 'arabic', 'chinese', 'japanese',
  'sanskrit', 'norse', 'elven', 'dwarven', 'orcish', 'halfling',
];

export type NameKind =
  | 'town' | 'quarter' | 'street' | 'road' | 'square' | 'church' | 'castle' | 'gate'
  | 'river' | 'lake' | 'sea' | 'forest' | 'hill' | 'village' | 'farm' | 'bridge';

export interface NameEntry {
  id: string;
  kind: NameKind;
  text: string;
  /** 0 = most important; used with the kind for collision priority. */
  rank: number;
  /** World anchor: point features, area label center, or the middle of a linear feature. */
  anchor: Vec2;
  /** Linear features (rivers, streets, roads): the text runs along this polyline. */
  path?: Polyline;
  /** Area features: approximate free width (m) around the anchor. */
  span?: number;
  /** Free-form tag, e.g. 'exit' for a village named at a regional road exit. */
  sub?: string;
}

export interface NamesLayer {
  family: NameFamily;
  /** The town's own name (cartouche title). */
  town: string;
  entries: NameEntry[];
}
