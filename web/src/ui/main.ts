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
import { CULTURE_LIST } from '../gen/urban/cultures';
import { scaleMaxPop } from '../gen/urban/culture';
import { POP_RANGE } from '../gen/urban/phases';
import { perf, rec, now as pnow } from './perf';
import { OffscreenBackend, BackendEvents } from './backend';
import type { DisplayOpts, GDone } from './protocol';

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
// (village-only cultures note their cap: above it they become a large village or a cluster of villages)
fillSelect(cultureEl, CULTURE_LIST.map((c) => [c.id, `${c.label}${c.scale && c.scale.max !== 'megacity' ? ` (up to ${c.scale.max})` : ''}${c.fantasy ? ' (fantasy)' : ''}`] as [string, string]), opts.culture);
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
// ---------- Plan section: landmarks, activities, suburbs (M4), in the #planExtra slot
{
  const slot = $('planExtra');
  slot.textContent = '';
  const tri: [string, string][] = [['auto', 'Auto'], ['yes', 'On'], ['no', 'Off']];
  const rows: [keyof Options, string, [string, string][]][] = [
    ['walls', 'Town wall', [['auto', 'Auto'], ['none', 'None (open town)'], ['single', 'Single curtain'], ['double', 'Double enceinte']]],
    ['castles', 'Castles', [['auto', 'Auto'], ['0', 'None'], ['1', '1'], ['2', '2'], ['3', '3']]],
    ['cathedral', 'Cathedral close', tri],
    ['palace', 'Palace', tri],
    ['monasteries', 'Monasteries', tri],
    ['port', 'Port (quays, piers, shipyard)', tri],
    ['arena', 'Arena (fossil oval)', tri],
    ['activities', 'Mills, trades, inns, gallows', tri],
    ['suburbs', 'Suburbs', [['auto', 'Auto'], ['none', 'None'], ['some', 'Some'], ['many', 'Many']]],
    ['shantytowns', 'Shanty towns', [['auto', 'Auto'], ['none', 'None'], ['some', 'Some'], ['many', 'Many']]],
  ];
  for (const [key, label, items] of rows) {
    const id = 'm4-' + String(key);
    const lab = document.createElement('label');
    lab.htmlFor = id; lab.textContent = label;
    const sel = document.createElement('select');
    sel.id = id;
    fillSelect(sel, items, String(opts[key] ?? 'auto'));
    slot.append(lab, sel);
    registry.add(selectControl(sel, key, (v) => v as never));
  }
  // sprawl: the same population on more or less land (0.5 compact … 2 loose), relative to the plan's baseline
  const lab = document.createElement('label');
  lab.htmlFor = 'sprawl';
  const inp = document.createElement('input');
  inp.type = 'range'; inp.id = 'sprawl'; inp.min = '0.5'; inp.max = '2'; inp.step = '0.05';
  const show = (): void => { lab.textContent = `Sprawl ${Number(inp.value).toFixed(2)} (0.5 dense … 2 loose)`; };
  inp.addEventListener('input', show);
  slot.append(lab, inp);
  const sc = numberControl(inp, 'sprawl', 1);
  registry.add({ ...sc, live: false, write: (o) => { sc.write(o); show(); } });
}
registry.writeAll(opts);
// ---------- Plan section: the scale note of the chosen culture (cap of village-only cultures)
{
  const note = document.createElement('div');
  note.className = 'note';
  note.style.cssText = 'font-size:11px;opacity:0.75;margin:-2px 0 6px';
  cultureEl.insertAdjacentElement('afterend', note);
  const update = (): void => {
    const c = CULTURE_LIST.find((x) => x.id === cultureEl.value);
    const pop = Number(($<HTMLInputElement>('population')).value) || POP_RANGE[sizeEl.value as Options['size']]?.[0] || 0;
    const max = c?.scale?.max;
    note.textContent = max && max !== 'megacity' && pop > scaleMaxPop(max) * 1.5
      ? `Above ${max} size this plan becomes a cluster of ${max}s (or one large ${max}).`
      : max && max !== 'megacity' ? `Settlements up to ${max} size.` : '';
  };
  for (const el of [cultureEl, sizeEl, $<HTMLInputElement>('population')]) { el.addEventListener('change', update); el.addEventListener('input', update); }
  update();
}

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

// ---------- generation: workers + OffscreenCanvas when possible, else the original main-thread path ----------
// 'offscreen' mode (default): a generation worker (G) streams World snapshots to a render worker (R) that owns the
// scene and draws on an OffscreenCanvas; the page only moves bitmaps (see backend.ts, viewer.ts). The World never
// reaches the main thread. 'main' mode (fallback, or `?render=main`): generate in a worker (or inline) and draw here.
let backend: OffscreenBackend | null = null;
let backendSettled = false;
const forceMain = new URLSearchParams(location.search).get('render') === 'main';
let worker: Worker | null = null;
let legacyWorkerRefused = false;
let workerBusy = false;
let reqId = 0;
let timer: number | undefined;
let genStart = 0;
let lastGenKey = '';
// CANVAS-VIEWER (begin show)
let currentWorld: World | null = null;
let currentRenderer: CanvasRenderer | null = null;
let sceneCache: { world: World; contours: boolean; scene: Scene } | null = null;
/** Offscreen mode: tiny summary of the world (center, name anchors) and the labels of the last frame, for the debug hooks. */
let meta: GDone['meta'] | null = null;
let lastLabels: { kind: string; text: string; size: number }[] = [];
let doneFor = 0, finalFor = 0;

const display = (): DisplayOpts => ({ style: mapStyle(), contours: opts.contours, landuse: opts.landuse, labels: opts.labels, legend: opts.legend });
const measureCtx = document.createElement('canvas').getContext('2d');
const svgMeasure = (t: string, s: number, st: Parameters<typeof fontString>[0]): number => {
  if (!measureCtx) return t.length * s * 0.5;
  measureCtx.font = fontString(st, s, FONT_STACKS[opts.style]);
  return measureCtx.measureText(t).width;
};
const currentSvg = (): string => (currentWorld
  ? renderSvg(currentWorld, { style: mapStyle(), contours: opts.contours, landuse: opts.landuse, labels: opts.labels !== false, legend: !!opts.legend, measure: svgMeasure })
  : '');

/** (Re)build the renderer from the current world and the display options. */
function rerender(keepView = true): void {
  if (backend) { backend.setDisplay(display()); return; }
  if (!currentWorld) return;
  const w: World = { ...currentWorld, options: { ...currentWorld.options, style: opts.style, contours: opts.contours, landuse: opts.landuse, labels: opts.labels, legend: opts.legend } };
  // a style switch only re-renders: the scene (flattened world) is reused unless the contour layer changes
  if (!sceneCache || sceneCache.world !== currentWorld || sceneCache.contours !== !!opts.contours) {
    const t = pnow();
    sceneCache = { world: currentWorld, contours: !!opts.contours, scene: buildScene(w) };
    rec('buildScene', pnow() - t);
  }
  const t1 = pnow();
  currentRenderer = createCanvasRenderer(canvasEl, w, mapStyle(), { scene: sceneCache.scene });
  rec('createRenderer', pnow() - t1);
  viewer.setRenderer(currentRenderer, w.mapSize, keepView);
}

/** Main-thread mode: the finished World arrived (structured clone) - draw it. */
function show(world: World, stats: Record<string, number | string>, ms: number): void {
  rec('genWorker', ms); rec('roundTrip', pnow() - genStart); rec('transfer', pnow() - genStart - ms);
  const tShow = pnow();
  currentWorld = world;
  rerender(true);
  rec('showSync', pnow() - tShow);
  perf.extra.stats = stats;
  requestAnimationFrame(() => requestAnimationFrame(() => { rec('startToFrame', pnow() - genStart); perf.extra.doneAt = pnow(); }));
// CANVAS-VIEWER (end show)
  setBusy(false);
  showStats(stats, ms);
}

function showStats(stats: Record<string, number | string>, ms: number): void {
  const town = stats['names.town'];
  document.title = town ? `${town} - Burgmap` : 'Burgmap';
  genTimeEl.textContent = `Generated in ${(ms / 1000).toFixed(2)} s`;
  const seaPct = Math.round(Number(stats.seaFraction ?? 0) * 100);
  statusEl.textContent = `terrain ${stats['ms.terrain']} ms, urban ${stats['ms.urban'] ?? 0} ms - ${stats.rivers} rivers, ${stats.lakes} lakes, sea ${seaPct}% - ${stats.roads ?? 0} roads, ${stats.bridges ?? 0} bridges - ${stats['urban.archetype'] ?? ''} pop ${stats['urban.pop'] ?? 0}: ${stats['urban.blocks'] ?? 0} blocks, ${stats['urban.buildings'] ?? 0} buildings`;
}

// Thin determinate bar at the top of the map: jumps to each pipeline stage and creeps inside the long ones.
// The current map stays visible and interactive underneath; nothing is blanked or blocked.
const loadEl = $('loadbar');
const loadFill = loadEl.firstElementChild as HTMLElement;
const STAGE_FRAC: Record<string, [number, number]> = {
  starting: [0.01, 0.03], terrain: [0.03, 0.09], 'site & roads': [0.09, 0.2], town: [0.2, 0.84],
  'fields & woods': [0.85, 0.94], names: [0.94, 0.97],
};
let loadPos = 0, loadCeil = 0, loadTick: number | undefined, loadHide: number | undefined;
function setLoad(on: boolean, stage = ''): void {
  window.clearTimeout(loadHide);
  if (!on) {
    window.clearInterval(loadTick); loadTick = undefined;
    loadFill.style.width = '100%';
    loadHide = window.setTimeout(() => { loadEl.classList.remove('on'); loadPos = 0; loadFill.style.transition = 'none'; loadFill.style.width = '0'; void loadFill.offsetWidth; loadFill.style.transition = ''; }, 350);
    return;
  }
  const [lo, hi] = STAGE_FRAC[stage] ?? [0.01, 0.03];
  if (stage === 'starting' || !loadEl.classList.contains('on')) loadPos = 0;
  loadEl.classList.add('on');
  loadPos = Math.max(loadPos, lo); loadCeil = hi;
  loadFill.style.width = (loadPos * 100).toFixed(1) + '%';
  loadTick ??= window.setInterval(() => {
    loadPos += (loadCeil - loadPos) * 0.08;
    loadFill.style.width = (loadPos * 100).toFixed(1) + '%';
  }, 250);
}

function setBusy(on: boolean, stage = ''): void {
  setLoad(on, stage);
  busyEl.classList.toggle('on', on);
  progressEl.classList.toggle('on', on);
  if (on) { busyEl.textContent = stage ? `generating: ${stage}...` : 'generating...'; genTimeEl.textContent = stage ? `Generating: ${stage}...` : 'Generating...'; }
}

// ---- offscreen mode events
let firstContentGen = 0, firstFrameGen = 0, awaitVer = 0;
const backendEvents: BackendEvents = {
  onStage(id, stage) { if (id === reqId) setBusy(true, stage); },
  onDone(d) {
    if (d.id !== reqId) return;
    meta = d.meta; doneFor = d.id;
    rec('genWorker', d.ms); perf.extra.stats = d.stats;
    showStats(d.stats, d.ms);
    if (finalFor === d.id) setBusy(false);
  },
  onError(id, error) {
    if (id !== reqId) return;
    setBusy(false); genTimeEl.textContent = 'Generation failed'; statusEl.textContent = 'Error: ' + error.split('\n')[0]; console.error(error);
  },
  onContent(c) {
    // new snapshot (terrain, then roads, then the town...) or a style change: redraw, keeping the view unless the map size changed
    viewer.contentChanged(c.mapSize, true, c.marker);
    map.style.background = c.paper;
    awaitVer = c.ver;
    if (c.gen !== reqId) return;
    if (firstContentGen !== c.gen) { firstContentGen = c.gen; rec('firstContent', pnow() - genStart); }
    rec(c.final ? 'sceneFinal' : 'scenePartial', c.sceneMs);
    if (c.final) { finalFor = c.gen; if (doneFor === c.gen) setBusy(false); }
  },
  onFrame(f) {
    lastLabels = f.labels; if (f.bitmap) perf.extra.lastFrameView = f.view;
    viewer.present(f);
    if (awaitVer && f.ver >= awaitVer && f.bitmap) {
      awaitVer = 0;
      if (firstFrameGen !== reqId) { firstFrameGen = reqId; rec('firstFrame', pnow() - genStart); }
      if (finalFor === reqId && doneFor === reqId) { rec('startToFrame', pnow() - genStart); perf.extra.doneAt = pnow(); }
    }
  },
  onFatal(msg) {
    setBusy(false); genTimeEl.textContent = 'Renderer stopped'; statusEl.textContent = 'A worker failed (' + msg + '): reload the page, or add ?render=main to the address.';
  },
};

function spawnWorker(): void {
  try { worker = new GenWorker(); } catch { worker = null; legacyWorkerRefused = true; return; }
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const r = e.data;
    if (r.id !== reqId) return;
    if (r.stage) { setBusy(true, r.stage); return; }
    workerBusy = false;
    if (r.error) { setBusy(false); genTimeEl.textContent = 'Generation failed'; statusEl.textContent = 'Error: ' + r.error.split('\n')[0]; console.error(r.error); return; }
    show(r.world!, r.stats!, r.ms!);
  };
  // e.g. blob workers are refused on file:// - fall back to generating on the main thread
  worker.onerror = () => { console.info('Generation worker unavailable (file:// ?), generating on the main thread'); worker = null; legacyWorkerRefused = true; workerBusy = false; run(); };
}

function genKey(): string {
  return toQuery({ ...opts, style: DEFAULTS.style, contours: DEFAULTS.contours, landuse: DEFAULTS.landuse, labels: true, legend: false }) + '|' + heightId;
}

function run(): void {
  if (!backendSettled) return; // the first run starts when the backend probe has answered
  const id = ++reqId;
  lastGenKey = genKey();
  genStart = performance.now();
  setBusy(true, 'starting');
  if (backend) { backend.run(id, opts); return; }
  if (!worker && !legacyWorkerRefused) spawnWorker();
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
  onFrame: (ms, band, scale) => { perf.frames.push(ms); if (perf.frames.length > 5000) perf.frames.shift(); hudEl.textContent = `${['far', 'mid', 'near'][band]} - ${scale.toFixed(3)} px/m - ${ms.toFixed(1)} ms`; },
});
$('fit').addEventListener('click', () => viewer.fit());
$('menuBtn').addEventListener('click', () => $('app').classList.toggle('open'));
map.addEventListener('pointerdown', () => $('app').classList.remove('open'));
// debug hook for scripted screenshots (scripts/ui_check.mjs)
(window as unknown as Record<string, unknown>).__burgmap = {
  setView: (v: { cx: number; cy: number; scale: number }) => viewer.setView(v),
  getView: () => viewer.getView(),
  fit: () => viewer.fit(),
  /** The World (main-thread mode only: in offscreen mode it lives in the workers; open the page with ?render=main to inspect it). */
  world: () => currentWorld,
  options: () => opts,
  mode: () => (backend ? 'offscreen' : 'main'),
  /** Labels placed in the last frame (kind, text, size). */
  labels: () => (backend ? lastLabels : (currentRenderer?.lastPlaced() ?? []).map((p) => ({ kind: p.label.kind, text: p.label.text, size: p.size }))),
  /** Center of the settlement (site center / urban footprint centroid). */
  center: () => meta?.center ?? currentWorld?.site?.center ?? { x: (currentWorld?.mapSize ?? meta?.mapSize ?? 0) / 2, y: (currentWorld?.mapSize ?? meta?.mapSize ?? 0) / 2 },
  /** Anchor of a named feature (for scripted zooms). */
  find: (kind: string, n = 0) => meta?.anchors[kind]?.[n] ?? currentWorld?.names?.entries.filter((e) => e.kind === kind)[n]?.anchor ?? null,
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
/** SVG / JSON of the current world as a Blob: built in the generation worker (offscreen mode) so the page never blocks, or here. */
async function buildExport(kind: 'svg' | 'json'): Promise<Blob> {
  const t = pnow();
  let blob: Blob;
  if (backend) blob = await backend.export(kind, display());
  else {
    if (!currentWorld) throw new Error('nothing to export yet');
    await new Promise((r) => setTimeout(r, 30)); // let the progress message paint before the synchronous build
    blob = kind === 'svg'
      ? new Blob([currentSvg()], { type: 'image/svg+xml' })
      : new Blob([worldToJson(currentWorld)], { type: 'application/json' });
  }
  rec(kind === 'svg' ? 'exportSvg' : 'exportJson', pnow() - t);
  perf.extra.svgBytes = blob.size;
  return blob;
}
/** Run an export job with visible progress (button label, progress bar, status line) and report failures. */
async function withProgress(btn: HTMLButtonElement, label: string, job: () => Promise<void>): Promise<void> {
  const text = btn.textContent;
  btn.disabled = true; btn.textContent = label;
  progressEl.classList.add('on'); statusEl.textContent = label.replace(/\.\.\.$/, '') + ' in the background...';
  try { await job(); } catch (e) { statusEl.textContent = 'Export failed: ' + (e as Error).message; } finally {
    btn.disabled = false; btn.textContent = text;
    if (!busyEl.classList.contains('on')) progressEl.classList.remove('on');
  }
}
const exportSvgBtn = $<HTMLButtonElement>('exportSvg');
const exportPngBtn = $<HTMLButtonElement>('exportPng');
const exportJsonBtn = $<HTMLButtonElement>('exportJson');
exportSvgBtn.addEventListener('click', () => {
  void withProgress(exportSvgBtn, 'Building SVG...', async () => {
    await exportFile(fname() + '.svg', await buildExport('svg'), 'image/svg+xml');
  });
});
exportJsonBtn.addEventListener('click', () => {
  void withProgress(exportJsonBtn, 'Building JSON...', async () => {
    await exportFile(fname() + '.json', await buildExport('json'), 'application/json');
  });
});
exportPngBtn.addEventListener('click', () => {
  void withProgress(exportPngBtn, 'Rendering PNG...', async () => {
    const tP = pnow();
    const svgBlob = await buildExport('svg');
    rec('pngSvg', pnow() - tP);
    // rasterize through an <img> (the browser decodes the SVG off the UI path as far as it can)
    const png = await new Promise<Blob | null>((resolve) => {
      const load = (src: string, revoke?: () => void): void => {
        const img = new Image();
        img.onload = () => {
          const S = 3000;
          const c = document.createElement('canvas');
          c.width = S; c.height = S;
          c.getContext('2d')!.drawImage(img, 0, 0, S, S);
          revoke?.();
          c.toBlob((b) => resolve(b), 'image/png');
        };
        img.onerror = () => {
          revoke?.();
          // some hosts refuse blob: images: retry once with a data: URL
          if (src.startsWith('blob:')) void svgBlob.text().then((svg) => load('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)));
          else resolve(null);
        };
        img.src = src;
      };
      const url = URL.createObjectURL(svgBlob);
      load(url, () => URL.revokeObjectURL(url));
    });
    rec('exportPng', pnow() - tP);
    if (png) await exportFile(fname() + '.png', png, 'image/png'); else statusEl.textContent = 'PNG export failed';
  });
});

history.replaceState(null, '', '?' + toQuery(opts));
updateHeightmapUI();
// Probe the offscreen pipeline first (a few ms), then start the first run on whichever path works.
const backendReady: Promise<OffscreenBackend | null> = forceMain ? Promise.resolve(null) : OffscreenBackend.create(backendEvents, window.devicePixelRatio || 1);
void backendReady.then((b) => {
  backend = b;
  if (b) { viewer.setSource({ request: (r) => b.request(r) }); b.setDisplay(display()); }
  backendSettled = true;
  run();
});
