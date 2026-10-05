/**
 * UI-only share state: pins (waypoints with a note) and the viewer's view, carried in the link as
 * `pins=x,y,note;x,y,note` and `view=cx,cy,scale`. They never reach the generator: `fromQuery` ignores these
 * keys, so the options (and therefore the world) are exactly the same with or without them.
 * Also builds the bug-report snippet (link, options, pins, view and the `preview:png` command to reproduce it).
 */
import { Options, toQuery } from '../gen/options';
import { generationMapSize } from '../gen/pipeline';

export interface Pin { x: number; y: number; note: string }
export interface ViewState { cx: number; cy: number; scale: number }

const r1 = (n: number): number => Math.round(n * 10) / 10;
const sig = (n: number): number => Number(n.toPrecision(4));
export const MAX_NOTE = 120;

/** `x,y,note;x,y,note` (notes are URL-encoded so `,` and `;` are safe). */
export function pinsToString(pins: Pin[]): string {
  return pins.map((p) => `${r1(p.x)},${r1(p.y)},${encodeURIComponent(p.note)}`).join(';');
}
export function pinsFromString(s: string | null): Pin[] {
  if (!s) return [];
  const out: Pin[] = [];
  for (const part of s.split(';')) {
    const i1 = part.indexOf(','), i2 = part.indexOf(',', i1 + 1);
    if (i1 < 0) continue;
    const x = Number(part.slice(0, i1)), y = Number(part.slice(i1 + 1, i2 < 0 ? undefined : i2));
    if (!Number.isFinite(x) || !Number.isFinite(y) || part.slice(0, i1).trim() === '') continue;
    let note = i2 < 0 ? '' : part.slice(i2 + 1);
    try { note = decodeURIComponent(note); } catch { /* keep raw */ }
    out.push({ x, y, note: note.slice(0, MAX_NOTE) });
  }
  return out;
}
export const viewToString = (v: ViewState): string => `${r1(v.cx)},${r1(v.cy)},${sig(v.scale)}`;
export function viewFromString(s: string | null): ViewState | null {
  if (!s) return null;
  const [cx, cy, scale] = s.split(',').map(Number);
  return [cx, cy, scale].every((n) => Number.isFinite(n)) && scale > 0 ? { cx, cy, scale } : null;
}

/** The query of a link: the generation options, then the UI state (pins, view) when present. */
export function fullQuery(o: Options, pins: Pin[], view?: ViewState | null): string {
  const p = new URLSearchParams(toQuery(o));
  if (pins.length) p.set('pins', pinsToString(pins));
  if (view) p.set('view', viewToString(view));
  return p.toString();
}
export function uiStateFromQuery(q: string): { pins: Pin[]; view: ViewState | null } {
  const p = new URLSearchParams(q.startsWith('?') ? q.slice(1) : q);
  return { pins: pinsFromString(p.get('pins')), view: viewFromString(p.get('view')) };
}

/** URL key -> `applyOverride` key where they differ (scripts/preview.ts `--opt key=value`). */
const OPT_KEY: Record<string, string> = { shanty: 'shantytowns', lang: 'language', site: 'siteType', eager: 'eagerPop', map: 'mapSize' };
const SIMPLE = /^[A-Za-z0-9_.,:+\-/=]+$/;
const sh = (s: string): string => (SIMPLE.test(s) ? s : `'${s.replace(/'/g, `'\''`)}'`);

/** `--seed S --size Z --style T --opt k=v ...` reproducing `o` in scripts/preview.ts (a custom imported heightmap cannot be). */
export function previewFlags(o: Options): string {
  const p = new URLSearchParams(toQuery(o));
  const f = [`--seed ${sh(o.seed)}`, `--size ${o.size}`, `--style ${o.style}`];
  for (const [k, v] of p) {
    if (k === 'seed' || k === 'size' || k === 'style' || k === 'hm' || k === 'hscale' || k === 'hsea') continue;
    f.push(`--opt ${sh(`${OPT_KEY[k] ?? k}=${v}`)}`);
  }
  return f.join(' ');
}

/** `--crop x,y,w` (top-left corner and width, in meters, kept inside the map) centred on a point. */
export function cropAround(x: number, y: number, w: number, mapSize: number): string {
  const ww = Math.max(20, Math.min(mapSize, Math.round(w)));
  const cl = (c: number): number => Math.round(Math.max(0, Math.min(mapSize - ww, c - ww / 2)));
  return `${cl(x)},${cl(y)},${ww}`;
}

export function bugReport(o: Options, pins: Pin[], view: ViewState, linkBase: string, viewW: number, displayQuery?: string): string {
  const ms = generationMapSize(o);
  const link = linkBase + '?' + (displayQuery ?? fullQuery(o, pins, view));
  const q = new URLSearchParams(toQuery(o));
  const key = ['seed', 'size', 'culture', 'style', ...[...q.keys()].filter((k) => !['seed', 'size', 'culture', 'style', 'hm', 'hscale', 'hsea'].includes(k))]
    .map((k) => `${k}=${k === 'seed' ? o.seed : q.get(k) ?? (o as unknown as Record<string, unknown>)[k]}`).join(', ');
  const L = ['### Bug report', '', `Link: ${link}`, '', `Seed and options: ${key}`, `Map: ${ms} m`, `View: centre ${r1(view.cx)}, ${r1(view.cy)} m, ${sig(view.scale)} px/m (about ${Math.round(viewW / view.scale)} m wide)`, ''];
  if (pins.length) { L.push('Pins (x, y in meters from the map top-left):'); pins.forEach((p, i) => L.push(`${i + 1}. ${r1(p.x)}, ${r1(p.y)} - ${p.note || '(no note)'}`)); }
  else L.push('Pins: none');
  if (o.importedHeight) L.push('', 'Note: a custom imported heightmap was used and is not in the link.');
  L.push('', 'Agent: reproduce each location with:');
  const flags = previewFlags(o);
  const w = Math.max(60, Math.min(400, Math.round(viewW / view.scale)));
  if (pins.length) pins.forEach((p, i) => L.push('`npm run preview:png -- ' + flags + ' --crop ' + cropAround(p.x, p.y, w, ms) + ' --out out/bug' + (pins.length > 1 ? `-${i + 1}` : '') + '.png`'));
  else L.push('`npm run preview:png -- ' + flags + ' --crop ' + cropAround(view.cx, view.cy, w, ms) + ' --out out/bug.png`');
  return L.join('\n');
}
