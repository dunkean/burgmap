import { Options, SIZE_PRESETS, DEFAULT_ROADS, fromQuery, toQuery, wantsCustomHeight, DEFAULTS } from '../gen/options';
import { generate } from '../gen/pipeline';
import { renderSvg } from '../render/svg';
// CANVAS-VIEWER (begin imports)
import { createCanvasRenderer, CanvasRenderer } from '../render/canvas';
import { createViewer } from './viewer';
import type { World } from '../gen/types';
// CANVAS-VIEWER (end imports)
import GenWorker from './worker?worker&inline';
import type { WorkerResponse } from './worker';
import { ControlRegistry, fillSelect, selectControl, checkControl, numberControl } from './controls';
import { readHeightmap } from './heightmap';
import { NAME_FAMILIES } from '../gen/names/types';
import { FONT_STACKS, fontString } from '../render/labelStyles';
import { STYLE_LIST, isMapStyle, MapStyle } from '../render/styles';
import type { Scene } from '../render/scene';
import { buildScene } from '../render/scene';
import { saveFile } from './download';
import { worldToJson } from './exportWorld';
import type { ImportedHeight } from '../gen/terrain/import';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** The URL style can be any MapStyle; gen/options.ts only whitelists the first two, so read it here. */
function parseOptions(q: string): Options {
  const o = fromQuery(q);
  const v = new URLSearchParams(q.startsWith('?') ? q.slice(1) : q).get('style');
  return isMapStyle(v) ? { ...o, style: v as Options['style'] } : o;
}
const mapStyle = (): MapStyle => opts.style as MapStyle;

let opts: Options = parseOptions(location.search);
/** The imported image of this session (kept out of the URL; the link only carries a `hm=custom` marker). */
let importedMem: ImportedHeight | null = null;
/** Set when the page was opened from a link that used a custom heightmap we do not have. */
let missingCustom = wantsCustomHeight(location.search);
let heightId = 0;

const statusEl = $('status');
const busyEl = $('busy');
const progressEl = $('progress');
const genTimeEl = $('gentime');

// ---------- controls (registry: new panel sections only have to add their controls here) ----------
const registry = new ControlRegistry();
const reliefEl = $<HTMLSelectElement>('relief');
const coastEl = $<HTMLSelectElement>('coast');
const riverEl = $<HTMLSelectElement>('river');
const sizeEl = $<HTMLSelectElement>('size');
const roadsEl = $<HTMLSelectElement>('roads');
const cultureEl = $<HTMLSelectElement>('culture');
const languageEl = $<HTMLSelectElement>('language');
const styleEl = $<HTMLSelectElement>('style');
const seedEl = $<HTMLInputElement>('seed');

fillSelect(sizeEl, Object.entries(SIZE_PRESETS).map(([k, v]) => [k, `${v.label} (${v.mapSize} m)`]), opts.size);
fillSelect(reliefEl, [['flat', 'Flat'], ['hills', 'Rolling hills'], ['valley', 'Valley'], ['mountains', 'Mountains']], opts.relief);
fillSelect(coastEl, [['none', 'None'], ['random', 'Random side'], ['N', 'North'], ['E', 'East'], ['S', 'South'], ['W', 'West']], opts.coast);
fillSelect(riverEl, [['none', 'None'], ['stream', 'Stream'], ['river', 'River'], ['major', 'Major river']], opts.river);
fillSelect(roadsEl, [['0', `Auto (${DEFAULT_ROADS[opts.size]})`], ...[1, 2, 3, 4, 5, 6, 7, 8].map((k) => [String(k), String(k)] as [string, string])], String(opts.roads));
fillSelect(styleEl, STYLE_LIST.map((s) => [s.id, s.label] as [string, string]), opts.style);
fillSelect(cultureEl, [['european-organic', 'Medieval organic'], ['bastide', 'Bastide (planned grid)']], opts.culture);
fillSelect(languageEl, [['auto', 'Automatic (from the plan)'], ...NAME_FAMILIES.map((f) => [f, f[0].toUpperCase() + f.slice(1)] as [string, string])], opts.language ?? 'auto');

const seedControl = {
  el: seedEl, live: true,
  read: (o: Options): Options => ({ ...o, seed: seedEl.value || '1' }),
  write: (o: Options): void => { seedEl.value = o.seed; },
};
registry.add(seedControl);
registry.add(selectControl(sizeEl, 'size', (v) => v as Options['size']));
registry.add(selectControl(reliefEl, 'relief', (v) => v as Options['relief']));
registry.add(selectControl(coastEl, 'coast', (v) => v as Options['coast']));
registry.add(selectControl(riverEl, 'river', (v) => v as Options['river']));
registry.add(selectControl(roadsEl, 'roads', (v) => Number(v)));
registry.add(numberControl($<HTMLInputElement>('population'), 'population', 0));
registry.add(selectControl(cultureEl, 'culture', (v) => v as Options['culture']));
registry.add(selectControl(languageEl, 'language', (v) => v as Options['language']));
registry.add(numberControl($<HTMLInputElement>('hmScale'), 'heightScale', DEFAULTS.heightScale ?? 120));
registry.add(numberControl($<HTMLInputElement>('hmSea'), 'importSea', 0));
// display-only controls: no new generation, the renderer is rebuilt from the current world
registry.add(selectControl(styleEl, 'style', (v) => v as Options['style'], true));
registry.add(checkControl($<HTMLInputElement>('contours'), 'contours', true));
registry.add(checkControl($<HTMLInputElement>('landuse'), 'landuse', true));
registry.add(checkControl($<HTMLInputElement>('labels'), 'labels', true));
registry.add(checkControl($<HTMLInputElement>('legend'), 'legend', true));
registry.writeAll(opts);

// ---------- heightmap import ----------
const hmFile = $<HTMLInputElement>('hmFile');
const hmInfo = $('hmInfo');
const hmParams = $('hmParams');
const hmClear = $<HTMLButtonElement>('hmClear');
$('hmImport').addEventListener('click', () => hmFile.click());
hmFile.addEventListener('change', async () => {
  const f = hmFile.files?.[0];
  if (!f) return;
  try {
    statusEl.textContent = 'Reading heightmap...';
    importedMem = await readHeightmap(f);
    missingCustom = false;
    heightId++;
    opts = { ...registry.readAll(opts), importedHeight: importedMem };
    commit('push');
  } catch (e) {
    statusEl.textContent = 'Could not read the image: ' + (e as Error).message;
  }
  hmFile.value = '';
});
hmClear.addEventListener('click', () => {
  importedMem = null; heightId++;
  opts = { ...registry.readAll(opts), importedHeight: undefined };
  commit('push');
});
function updateHeightmapUI(): void {
  const custom = !!opts.importedHeight;
  hmParams.hidden = !custom;
  hmClear.hidden = !custom;
  reliefEl.disabled = custom; coastEl.disabled = custom;
  hmInfo.textContent = custom ? `${opts.importedHeight!.name ?? 'image'} (${opts.importedHeight!.w} x ${opts.importedHeight!.h} px)` : '';
  $('shareState').innerHTML = custom
    ? '<span class="chip" id="customChip">custom heightmap (not included in the link)</span>'
    : missingCustom ? '<span class="chip warn" id="customChip">this link used a custom heightmap: import it again to reproduce the map</span>' : '';
}

// ---------- generation (worker with main-thread fallback) ----------
let worker: Worker | null = null;
let workerBusy = false;
let reqId = 0;
let timer: number | undefined;
let genStart = 0;
let lastGenKey = '';
// CANVAS-VIEWER (begin show)
let currentWorld: World | null = null;
let currentRenderer: CanvasRenderer | null = null;
let sceneCache: { world: World; contours: boolean; scene: Scene } | null = null;

const measureCtx = document.createElement('canvas').getContext('2d');
const svgMeasure = (t: string, s: number, st: Parameters<typeof fontString>[0]): number => {
  if (!measureCtx) return t.length * s * 0.5;
  measureCtx.font = fontString(st, s, FONT_STACKS[opts.style]);
  return measureCtx.measureText(t).width;
};
const currentSvg = (): string => (currentWorld
  ? renderSvg(currentWorld, { style: mapStyle(), contours: opts.contours, landuse: opts.landuse, labels: opts.labels !== false, legend: !!opts.legend, measure: svgMeasure })
  : '');

/** (Re)build the canvas renderer from the current world and the display options. */
function rerender(keepView = true): void {
  if (!currentWorld) return;
  const w: World = { ...currentWorld, options: { ...currentWorld.options, style: opts.style, contours: opts.contours, landuse: opts.landuse, labels: opts.labels, legend: opts.legend } };
  // a style switch only re-renders: the scene (flattened world) is reused unless the contour layer changes
  if (!sceneCache || sceneCache.world !== currentWorld || sceneCache.contours !== !!opts.contours) {
    sceneCache = { world: currentWorld, contours: !!opts.contours, scene: buildScene(w) };
  }
  currentRenderer = createCanvasRenderer(canvasEl, w, mapStyle(), { scene: sceneCache.scene });
  viewer.setRenderer(currentRenderer, w.mapSize, keepView);
}

function show(world: World, stats: Record<string, number | string>, ms: number): void {
  currentWorld = world;
  rerender(true);
// CANVAS-VIEWER (end show)
  setBusy(false);
  document.title = world.names ? `${world.names.town} - Burgmap` : 'Burgmap';
  genTimeEl.textContent = `Generated in ${(ms / 1000).toFixed(2)} s`;
  const seaPct = Math.round(Number(stats.seaFraction ?? 0) * 100);
  statusEl.textContent = `terrain ${stats['ms.terrain']} ms, urban ${stats['ms.urban'] ?? 0} ms - ${stats.rivers} rivers, ${stats.lakes} lakes, sea ${seaPct}% - ${stats.roads ?? 0} roads, ${stats.bridges ?? 0} bridges - ${stats['urban.archetype'] ?? ''} pop ${stats['urban.pop'] ?? 0}: ${stats['urban.blocks'] ?? 0} blocks, ${stats['urban.buildings'] ?? 0} buildings`;
}

function setBusy(on: boolean, stage = ''): void {
  busyEl.classList.toggle('on', on);
  progressEl.classList.toggle('on', on);
  if (on) { busyEl.textContent = stage ? `generating: ${stage}...` : 'generating...'; genTimeEl.textContent = stage ? `Generating: ${stage}...` : 'Generating...'; }
}

function spawnWorker(): void {
  try { worker = new GenWorker(); } catch { worker = null; return; }
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const r = e.data;
    if (r.id !== reqId) return;
    if (r.stage) { setBusy(true, r.stage); return; }
    workerBusy = false;
    if (r.error) { setBusy(false); genTimeEl.textContent = 'Generation failed'; statusEl.textContent = 'Error: ' + r.error.split('\n')[0]; console.error(r.error); return; }
    show(r.world!, r.stats!, r.ms!);
  };
  // e.g. blob workers are refused on file:// - fall back to generating on the main thread
  worker.onerror = () => { console.info('Generation worker unavailable (file:// ?), generating on the main thread'); worker = null; workerBusy = false; run(); };
}
spawnWorker();

function genKey(): string {
  return toQuery({ ...opts, style: DEFAULTS.style, contours: DEFAULTS.contours, landuse: DEFAULTS.landuse, labels: true, legend: false }) + '|' + heightId;
}

function run(): void {
  const id = ++reqId;
  lastGenKey = genKey();
  genStart = performance.now();
  setBusy(true, 'starting');
  if (worker) {
    // a newer request supersedes a running one: restart the worker instead of queueing behind it
    if (workerBusy) { worker.terminate(); worker = null; spawnWorker(); }
  }
  if (worker) {
    workerBusy = true;
    worker.postMessage({ id, options: opts });
  } else {
    setTimeout(() => {
      if (id !== reqId) return;
      try {
        const world = generate(opts);
        show(world, world.stats, Math.round(performance.now() - genStart));
      } catch (err) {
        setBusy(false); statusEl.textContent = 'Error: ' + String((err as Error).message);
      }
    }, 10);
  }
}
function schedule(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(run, 180);
}

// ---------- state: URL, history, regeneration ----------
/** Bring everything in line with `opts`: panel, URL (push / replace / none) and the map (regenerate or just redraw). */
function commit(mode: 'push' | 'replace' | 'none', displayOnly = false): void {
  registry.writeAll(opts);
  roadsEl.options[0].textContent = `Auto (${DEFAULT_ROADS[opts.size]})`;
  updateHeightmapUI();
  if (mode !== 'none') {
    const q = '?' + toQuery(opts);
    if (q !== location.search) (mode === 'push' ? history.pushState : history.replaceState).call(history, null, '', q);
  }
  if (!displayOnly && genKey() !== lastGenKey) schedule();
  else if (currentWorld && displayOnly) rerender(true);
}

registry.onChange((c, kind) => {
  opts = registry.readAll(opts);
  const display = !!c.display;
  roadsEl.options[0].textContent = `Auto (${DEFAULT_ROADS[opts.size]})`;
  if (kind === 'input') {
    // typing: regenerate (debounced) without touching history
    if (!display && genKey() !== lastGenKey) schedule();
    return;
  }
  commit('push', display);
});

window.addEventListener('popstate', () => {
  const parsed = parseOptions(location.search);
  missingCustom = wantsCustomHeight(location.search) && !importedMem;
  opts = { ...parsed, importedHeight: wantsCustomHeight(location.search) ? importedMem ?? undefined : undefined };
  registry.writeAll(opts);
  commit('none');
});

function randomSeed(): string { return Math.random().toString(36).slice(2, 8); }
function reroll(): void {
  opts = { ...opts, seed: randomSeed() };
  commit('push');
}
$('dice').addEventListener('click', reroll);
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'r' || e.key === 'R') { e.preventDefault(); reroll(); }
});

const copyBtn = $<HTMLButtonElement>('copyLink');
copyBtn.addEventListener('click', async () => {
  const url = location.origin + location.pathname + '?' + toQuery(opts);
  let ok = false;
  try { await navigator.clipboard.writeText(url); ok = true; } catch {
    const ta = document.createElement('textarea');
    ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  copyBtn.textContent = ok ? 'Link copied' : 'Copy failed';
  (window as unknown as Record<string, unknown>).__lastCopied = url;
  window.setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 1600);
});

// ---------- viewer (canvas, LOD) ----------
// CANVAS-VIEWER (begin viewer)
const map = $('map');
const canvasEl = $<HTMLCanvasElement>('view');
const hudEl = $('hud');
const viewer = createViewer({
  container: map, canvas: canvasEl, minimap: $<HTMLCanvasElement>('minimap'),
  onFrame: (ms, band, scale) => { hudEl.textContent = `${['far', 'mid', 'near'][band]} - ${scale.toFixed(3)} px/m - ${ms.toFixed(1)} ms`; },
});
$('fit').addEventListener('click', () => viewer.fit());
$('menuBtn').addEventListener('click', () => $('app').classList.toggle('open'));
map.addEventListener('pointerdown', () => $('app').classList.remove('open'));
// debug hook for scripted screenshots (scripts/ui_check.mjs)
(window as unknown as Record<string, unknown>).__burgmap = {
  setView: (v: { cx: number; cy: number; scale: number }) => viewer.setView(v),
  getView: () => viewer.getView(),
  fit: () => viewer.fit(),
  world: () => currentWorld,
  options: () => opts,
  /** Labels placed in the last frame (kind, text, size). */
  labels: () => (currentRenderer?.lastPlaced() ?? []).map((p) => ({ kind: p.label.kind, text: p.label.text, size: p.size })),
  /** Center of the settlement (site center / urban footprint centroid). */
  center: () => currentWorld?.site?.center ?? { x: (currentWorld?.mapSize ?? 0) / 2, y: (currentWorld?.mapSize ?? 0) / 2 },
  /** Anchor of a named feature (for scripted zooms). */
  find: (kind: string, n = 0) => currentWorld?.names?.entries.filter((e) => e.kind === kind)[n]?.anchor ?? null,
};
// CANVAS-VIEWER (end viewer)

// ---------- export ----------
const fname = () => `burgmap-${opts.seed}-${opts.size}`;
/** Save through the Artifact viewer's downloads capability when present, else a plain download. */
async function exportFile(name: string, data: Blob | string, mime: string): Promise<void> {
  try {
    const r = await saveFile(name, data, mime);
    if (r === 'saved' || r === 'fallback') statusEl.textContent = `Exported ${name}`;
  } catch (e) {
    statusEl.textContent = 'Export failed: ' + (e as Error).message;
  }
}
$('exportSvg').addEventListener('click', () => {
  if (currentWorld) void exportFile(fname() + '.svg', new Blob([currentSvg()], { type: 'image/svg+xml' }), 'image/svg+xml');
});
$('exportJson').addEventListener('click', () => {
  if (currentWorld) void exportFile(fname() + '.json', new Blob([worldToJson(currentWorld)], { type: 'application/json' }), 'application/json');
});
$('exportPng').addEventListener('click', () => {
  if (!currentWorld) return;
  const svg = currentSvg();
  const load = (src: string, revoke?: () => void): void => {
    const img = new Image();
    img.onload = () => {
      const S = 3000;
      const c = document.createElement('canvas');
      c.width = S; c.height = S;
      c.getContext('2d')!.drawImage(img, 0, 0, S, S);
      revoke?.();
      c.toBlob((b) => { if (b) void exportFile(fname() + '.png', b, 'image/png'); else statusEl.textContent = 'PNG export failed'; }, 'image/png');
    };
    img.onerror = () => {
      revoke?.();
      // some hosts refuse blob: images: retry once with a data: URL
      if (src.startsWith('blob:')) load('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
      else statusEl.textContent = 'PNG export failed';
    };
    img.src = src;
  };
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  load(url, () => URL.revokeObjectURL(url));
});

history.replaceState(null, '', '?' + toQuery(opts));
updateHeightmapUI();
run();
