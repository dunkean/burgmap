/**
 * Messages between the main thread (M), the generation worker (G) and the render worker (R).
 *
 *   M -> G  run / export            G -> M  stage / done / error / exported
 *   G -> R  world snapshots (over a MessageChannel port that M hands to both)   R -> M  content / frame
 *   M -> R  init / attach / display / view
 *
 * The World never reaches the main thread in 'offscreen' mode: G generates, R builds the scene and draws.
 */
import type { Options } from '../gen/options';
import type { World, Vec2 } from '../gen/types';
import type { View } from '../render/view';
import type { MapStyle } from '../render/styles';
import type { BrushSources } from '../render/brushes';
import type { FrameStats } from '../render/canvas';
import type { MapInformation } from '../render/legend';

/** Display-only options (changing them never regenerates the world). */
export interface DisplayOpts { style: MapStyle; contours?: boolean; landuse?: boolean; labels?: boolean; legend?: boolean; painted?: boolean }

// ---- M -> G ----
export interface GRun { type: 'run'; id: number; options: Options; /** snapshot channel to the render worker */ port: MessagePort }
export interface GExport { type: 'export'; id: number; gen: number; kind: 'svg' | 'json'; display: DisplayOpts; brushes?: BrushSources; /** Actual SVG raster export width in pixels; omitted for intrinsic SVG. */ width?: number; /** megacity: generate the detail of every quarter first (slow) */ full?: boolean }
/** Lazy detail (M3c): generate the plan of secondary settlement `index` of run `id`. */
export interface GDetail { type: 'detail'; id: number; index: number }
/**
 * Megacity (URBAN_MORPHOLOGY §3d): generate the detail of the quarters meeting the view rectangle, nearest its
 * centre first. A new request replaces the queue of the previous one.
 */
export interface GQuarters { type: 'quarters'; id: number; rect: { x0: number; y0: number; x1: number; y1: number } }
export type GRequest = GRun | GExport | GDetail | GQuarters;

/** Settlement summary for the page (labels, click-to-focus, lazy detail requests). */
export interface SettlementMeta { index: number; key: string; name?: string; cls: string; population: number; center: Vec2; radius: number; detail: string; hasUrban: boolean }

// ---- G -> M ----
export interface GStage { type: 'stage'; id: number; stage: string }
export interface GDone {
  type: 'done'; id: number; ms: number; stats: Record<string, number | string>;
  /** Small summary for the page (title, debug hooks); the World itself stays in the workers. */
  meta: { center: Vec2; anchors: Record<string, Vec2[]>; mapSize: number; settlements?: SettlementMeta[]; /** Panels belonging to this rendered snapshot, for the compact viewer's dialog. */ mapInfo?: MapInformation; /** megacity: lazily detailed quarters */ mega?: { quarters: number; cityR: number } };
}
/** Megacity: progress of the quarter detail queue. */
export interface GQuartersDone { type: 'quartersDone'; id: number; done: number; queued: number; total: number; ms: number; failed?: number }
export interface GDetailDone { type: 'detailDone'; id: number; index: number; ms: number; error?: string }
export interface GError { type: 'error'; id: number; error: string }
export interface GExported { type: 'exported'; id: number; kind: 'svg' | 'json'; blob?: Blob; error?: string; ms: number }
export interface GCapabilities { type: 'capabilities'; textMeasure: boolean }
export type GResponse = GStage | GDone | GError | GExported | GDetailDone | GQuartersDone | GCapabilities;

// ---- G -> R (snapshot port) ----
export interface WorldMsg { type: 'world'; gen: number; world: World; final: boolean; stage: string }
/** A lazily generated settlement plan, merged into the render worker's World. */
export interface SettlementMsg { type: 'settlement'; gen: number; index: number; urban: NonNullable<World['urban']>; bridges: NonNullable<World['bridges']> }
/** Megacity: quarters whose detail was generated (merged into the World's `megaDetail`), and quarters evicted from the cache. */
export interface QuarterMsg { type: 'quarters'; gen: number; layers: Record<number, NonNullable<World['urban']>>; drop: number[] }
export type PortMsg = WorldMsg | SettlementMsg | QuarterMsg;

// ---- M -> R ----
export interface RInit { type: 'init'; dpr: number }
export interface RAttach { type: 'attach'; gen: number; port: MessagePort }
export interface RDisplay { type: 'display'; display: DisplayOpts }
export interface RView { type: 'view'; seq: number; view: View; w: number; h: number; dpr: number; mini: number }
export interface RPng { type: 'dispose' }
export interface RBrushes { type: 'brushes'; sources: BrushSources }
export type RRequest = RInit | RAttach | RDisplay | RView | RPng | RBrushes;

// ---- R -> M ----
export interface RReady { type: 'ready'; ok: boolean; reason?: string }
/** The drawn content changed (new snapshot / style): the viewer should re-request a frame (and fit if the map size changed). */
export interface RContent { type: 'content'; gen: number; ver: number; mapSize: number; final: boolean; sceneMs: number; marker: string; paper: string; meta: GDone['meta'] }
export interface RFrame {
  type: 'frame'; gen: number; seq: number; ver: number; view: View; w: number; h: number; dpr: number;
  bitmap?: ImageBitmap; mini?: ImageBitmap;
  ms: number; band: number; scale: number;
  labels: { kind: string; text: string; size: number }[];
  stats?: FrameStats;
}
export interface RBrushStatus { type: 'brushStatus'; ready: boolean }
export type RResponse = RBrushStatus | RReady | RContent | RFrame | { type: 'error'; gen: number; error: string };
