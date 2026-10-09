import { Options, SIZE_PRESETS, mapSizeOf, DEFAULT_ROADS, fromQuery, toQuery, wantsCustomHeight, DEFAULTS, withCulture, generationUid, SITE_ARCHETYPES, mapId } from '../gen/options';
import { expandMapQuery } from '../gen/mapId';
import { generate } from '../gen/pipeline';
import { BRUSH_SOURCES } from '../render/assets/brushAssets';
import { decodeBrushes, type BrushImages } from '../render/brushes';
import { paintedFromQuery, appearanceQuery } from './renderAppearance';
import { renderSvg } from '../render/svg';
// CANVAS-VIEWER (begin imports)
import { createCanvasRenderer, CanvasRenderer } from '../render/canvas';
import { createViewer } from './viewer';
import { createRuler } from './ruler';
import type { World } from '../gen/types';
// CANVAS-VIEWER (end imports)
import GenWorker from './worker?worker&inline';
import type { WorkerResponse } from './worker';
import { ControlRegistry, fillSelect, selectControl, checkControl, numberControl, chipify } from './controls';
import { readHeightmap } from './heightmap';
import { NAME_FAMILIES } from '../gen/names/types';
import { BIOME_LABELS, biomeName } from '../gen/biomes';
import { refreshCavernMask } from '../gen/terrain/caverns';
import { FONT_STACKS, fontString } from '../render/labelStyles';
import { STYLE_LIST, isMapStyle, MapStyle } from '../render/styles';
import type { Scene } from '../render/scene';
import { buildScene } from '../render/scene';
import { QuarterQueue } from './megaQueue';
import { createQuarterExecutor } from './quarterPool';
import { saveFile } from './download';
import { worldToJson } from './exportWorld';
import type { ImportedHeight } from '../gen/terrain/import';
import { CULTURE_LIST } from '../gen/urban/cultures';
import { scaleMaxPop } from '../gen/urban/culture';
import { POP_RANGE } from '../gen/urban/phases';
import { perf, rec, now as pnow } from './perf';
import { OffscreenBackend, BackendEvents } from './backend';
import type { DisplayOpts, GDone, GResponse, SettlementMeta } from './protocol';
import { FrameHandoff } from './frameHandoff';
import { canWorkerExport, legacyGenerationResponse } from './generationMessages';
import { exportPng } from './pngExport';
import { exportSnapshot, type ExportSnapshot } from './exportSnapshot';
import { initSettlementsUI, showSettlementWarnings } from './settlementsPanel';
import { initPlanEditor } from './planEditor';
import { initConfiguration } from './configuration';
import { initLayoutFlyout } from './layoutFlyout';
import { freshMapOptions, initialMapOptions } from './workflowDraft';
import { screenToWorld } from '../render/view';
import { Pin, ViewState, fullQuery, uiStateFromQuery, bugReport } from './share';
import { createPins } from './pins';
import { generateSettlementDetail, EAGER_MAIN_POP, createGenerationCache } from '../gen/pipeline';
const mainCache = createGenerationCache();
import type { MapInformation } from '../render/legend';
import { mapInformationHtml } from './mapInformation';
import { initDock } from './dock';
import { createMarks } from './marks';
import { surprisePatch } from './randomMap';
import { DebugGeneration, debugConfigurationKey, type DebugStage } from '../gen/debugPipeline';
import { initDeveloper, type DeveloperControls } from './developer';
let developer: DeveloperControls | null = null;
let debugRunStage: DebugStage | undefined;
let mainDebug: DebugGeneration | null = null;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const mapInfoButton = $<HTMLButtonElement>('mapInfoButton');
const mapInfoDialog = $<HTMLDialogElement>('mapInfoDialog');
let displayedMapInfo: MapInformation | null = null;
function showMapInformation(info?: MapInformation): void {
  if (!info || info === displayedMapInfo || (displayedMapInfo && info.cartouche === displayedMapInfo.cartouche
    && info.legend === displayedMapInfo.legend && info.fontFamily === displayedMapInfo.fontFamily)) return;
  displayedMapInfo = info;
  $('mapInfoContent').innerHTML = mapInformationHtml(info);
  mapInfoButton.disabled = false;
}
mapInfoButton.addEventListener('click', () => {
  if (mapInfoDialog.open) return;
  mapInfoDialog.showModal();
  mapInfoButton.setAttribute('aria-expanded', 'true');
});
$('closeMapInfo').addEventListener('click', () => mapInfoDialog.close());
mapInfoDialog.addEventListener('close', () => mapInfoButton.setAttribute('aria-expanded', 'false'));

/** The URL style can be any MapStyle; gen/options.ts only whitelists the first two, so read it here. */
function parseOptions(q: string): Options {
  const o = fromQuery(q);
  const v = expandMapQuery(q).get('style');
  return isMapStyle(v) ? { ...o, style: v as Options['style'] } : o;
}
const mapStyle = (): MapStyle => opts.style as MapStyle;

let opts: Options = location.search ? parseOptions(location.search) : initialMapOptions();
let paintedTextures = paintedFromQuery(location.search);
let brushStatus: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
let brushImages: BrushImages | null = null;
let draft: Options = structuredClone(opts);
let pendingSettings = false;
/** The imported image of this session (kept out of the URL; the link only carries a `hm=custom` marker). */
let importedMem: ImportedHeight | null = null;
/** Set when the page was opened from a link that used a custom heightmap we do not have. */
let missingCustom = wantsCustomHeight(location.search);
let heightId = 0;
let heightDraftId = 0;
/** UI-only state of the link (pins, view): never part of the options, so never of the generation. */
const initUi = uiStateFromQuery(location.search);
/** A view from the link, applied once the first map content has arrived (the map size is known then). */
let pendingView: ViewState | null = initUi.view;
let viewReady = false;

const statusEl = $('status');
const busyEl = $('busy');
const progressEl = $('progress');
const genTimeEl = $('gentime');
const feedbackEl = $('settingsFeedback');
/** Settlement markers: visible while the Settlements tab of Customize is open (or while placing one). */
const marks = createMarks($('marks'), { select: (t) => settlUI.select(t), move: (t, p) => settlUI.move(t, p) });
function refreshMarks(): void {
  const editing = configuration.isOpen && configuration.tab === 'settlementsPane';
  marks.set(debugRunStage !== undefined && debugRunStage < 4 ? null : editing || settlUI.picking !== null ? settlUI.markers(draft) : null);
}
const menuBtn = $<HTMLButtonElement>('menuBtn');
// the rail's one-click pickers: biome and relief regenerate (the terrain is reused across biomes), a style only redraws
const dock = initDock($('dock'), {
  biome: (biome) => { if (biomeName(opts.biome) !== biome) quickApply({ biome }); },
  relief: (relief) => { if (opts.relief !== relief) quickApply({ relief }); },
  coast: (coast) => { if (opts.coast !== coast) quickApply({ coast }); },
  river: (river) => { if (opts.river !== river) quickApply({ river }); },
  style: (style) => { styleEl.value = style; styleEl.dispatchEvent(new Event('change')); },
});
const syncDock = (): void => dock.sync({ biome: biomeName(opts.biome), relief: opts.relief, coast: opts.coast, river: opts.river, style: mapStyle() });
syncDock();
for (const hud of Array.from(document.querySelectorAll<HTMLElement>('.hud'))) {
  hud.addEventListener('pointerdown', (e) => e.stopPropagation());
  hud.addEventListener('pointerup', (e) => e.stopPropagation());
}

// ---------- controls (registry: new panel sections only have to add their controls here) ----------
const registry = new ControlRegistry();
const reliefEl = $<HTMLSelectElement>('relief');
const biomeEl = $<HTMLSelectElement>('biome');
const coastEl = $<HTMLSelectElement>('coast');
const riverEl = $<HTMLSelectElement>('river');
const sizeEl = $<HTMLSelectElement>('size');
const roadsEl = $<HTMLSelectElement>('roads');
const cultureEl = $<HTMLSelectElement>('culture');
const languageEl = $<HTMLSelectElement>('language');
const styleEl = $<HTMLSelectElement>('style');
const paintedEl = $<HTMLInputElement>('paintedTextures');
paintedEl.checked = paintedTextures;
const seedEl = $<HTMLInputElement>('seed');

fillSelect(sizeEl, Object.entries(SIZE_PRESETS).map(([k, v]) => [k, v.label]), opts.size);
fillSelect(reliefEl, [['flat', 'Flat'], ['hills', 'Rolling hills'], ['valley', 'Valley'], ['mountains', 'Mountains']], opts.relief);
fillSelect(biomeEl, BIOME_LABELS, biomeName(opts.biome));
fillSelect(coastEl, [['none', 'None'], ['random', 'Random side'], ['N', 'North'], ['E', 'East'], ['S', 'South'], ['W', 'West']], opts.coast);
fillSelect(riverEl, [['none', 'None'], ['stream', 'Stream'], ['river', 'River'], ['major', 'Major river']], opts.river);
fillSelect(roadsEl, [['0', `Auto (${DEFAULT_ROADS[opts.size]})`], ...[1, 2, 3, 4, 5, 6, 7, 8].map((k) => [String(k), String(k)] as [string, string])], String(opts.roads));
fillSelect(styleEl, STYLE_LIST.map((s) => [s.id, s.label] as [string, string]), opts.style);
// Show caps only for cultures without population-driven urban growth.
fillSelect(cultureEl, CULTURE_LIST.map((c) => [c.id, `${c.label}${!c.urbanGrowth && c.scale && c.scale.max !== 'megacity' ? ` (up to ${c.scale.max})` : ''}${c.fantasy ? ' (fantasy)' : ''}`] as [string, string]), opts.culture);
fillSelect(languageEl, [['auto', 'Auto (from plan)'], ...NAME_FAMILIES.map((f) => [f, f[0].toUpperCase() + f.slice(1)] as [string, string])], opts.language ?? 'auto');

const seedControl = {
  el: seedEl, live: true,
  read: (o: Options): Options => ({ ...o, seed: seedEl.value || '1' }),
  write: (o: Options): void => { seedEl.value = o.seed; },
};
registry.add(seedControl);
// map extent (preset or custom), population slider and the settlement system (M3c)
const configuration = initConfiguration(() => settlUI.cancelPick());
/** Set at the end of start-up; before it the generation state (`backend`, `meta`...) is not declared yet. */
let pageReady = false;
const settlUI = initSettlementsUI(registry, () => draft, changeEditor, (active) => { configuration.picking(active); refreshMarks(); },
  // (the generated map is read only once the page is initialised: list links render the panel before that)
  { all: () => (pageReady ? settlementList().map((s) => ({ key: s.key, name: s.name, population: s.population, center: s.center, cls: s.cls })) : []) },
  // 'Generate places': the automatic region is applied and generated at once
  () => applyGeneration(false, true));
$('panel').addEventListener('toggle', () => { $('app').classList.toggle('drawer-open', configuration.isOpen); refreshMarks(); });
registry.add(selectControl(reliefEl, 'relief', (v) => v as Options['relief']));
registry.add({ ...selectControl(biomeEl, 'biome', (v) => biomeName(v)), write: (o) => { biomeEl.value = biomeName(o.biome); } });
registry.add(selectControl(coastEl, 'coast', (v) => v as Options['coast']));
registry.add(selectControl(riverEl, 'river', (v) => v as Options['river']));
registry.add({ ...numberControl($<HTMLInputElement>('seaLevel'), 'seaLevel', 0), live: false });
registry.add(selectControl(roadsEl, 'roads', (v) => Number(v)));
chipify(roadsEl);
const siteEl = $<HTMLSelectElement>('siteType');
fillSelect(siteEl, [['auto', 'Automatic'], ...SITE_ARCHETYPES.map((site): [string, string] => [site, site])], opts.siteType ?? 'auto');
registry.add({ ...selectControl(siteEl, 'siteType', (v) => v as Options['siteType']), write: (o) => { siteEl.value = o.siteType ?? 'auto'; } });
{
  // an automatic population (0) shows as an empty field with an 'auto' placeholder
  const pc = numberControl($<HTMLInputElement>('population'), 'population', 0);
  registry.add({ ...pc, write: (o) => { pc.el.setAttribute('value', ''); ($<HTMLInputElement>('population')).value = o.population > 0 ? String(o.population) : ''; } });
}
// (a culture switch drops the previous culture's plan override / mix: see withCulture)
registry.add({ ...selectControl(cultureEl, 'culture', (v) => v as Options['culture']), read: (o) => withCulture(o, cultureEl.value as Options['culture']) });
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
    ['moat', 'Wet moat', tri],
    ['castles', 'Castles', [['auto', 'Auto'], ['0', 'None'], ['1', '1'], ['2', '2'], ['3', '3']]],
    ['cathedral', 'Cathedral close', tri],
    ['palace', 'Palace', tri],
    ['monasteries', 'Monasteries', tri],
    ['port', 'Port (quays, shipyard)', tri],
    ['arena', 'Arena (fossil oval)', tri],
    ['activities', 'Mills, trades, inns', tri],
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
    const cell = document.createElement('div'); cell.className = 'cell full';
    cell.append(lab, sel); slot.append(cell);
    chipify(sel);
    registry.add({ ...selectControl(sel, key, (v) => v as never), write: (o) => { sel.value = String(o[key] ?? 'auto'); } });
  }
  // sprawl: the same population on more or less land (0.5 compact … 2 loose), relative to the plan's baseline
  const lab = document.createElement('label');
  lab.htmlFor = 'sprawl';
  const inp = document.createElement('input');
  inp.type = 'range'; inp.id = 'sprawl'; inp.min = '0.5'; inp.max = '2'; inp.step = '0.05';
  const show = (): void => { lab.textContent = `Sprawl ${Number(inp.value).toFixed(2)} (0.5 dense … 2 loose)`; };
  inp.addEventListener('input', show);
  const sprawlCell = document.createElement('div'); sprawlCell.className = 'cell full';
  sprawlCell.append(lab, inp); slot.append(sprawlCell);
  const sc = numberControl(inp, 'sprawl', 1);
  registry.add({ ...sc, live: false, write: (o) => { sc.write(o); show(); } });
}
initPlanEditor(registry);
const layoutFlyout = initLayoutFlyout();
registry.writeAll(settlUI.editorOptions(draft));
// ---------- Plan section: population-driven growth or the culture's scale cap
{
  const note = document.createElement('div');
  note.className = 'note';
  note.style.cssText = 'font-size:11px;opacity:0.75;margin:-2px 0 6px';
  cultureEl.insertAdjacentElement('afterend', note);
  const update = (): void => {
    const c = CULTURE_LIST.find((x) => x.id === cultureEl.value);
    const pop = Number(($<HTMLInputElement>('population')).value) || POP_RANGE[sizeEl.value as Options['size']]?.[0] || 0;
    const max = c?.scale?.max;
    note.textContent = c?.urbanGrowth
      ? `Village layout below ${c.urbanGrowth.minPop.toLocaleString('en-US')} inhabitants; larger populations form a connected town.`
      : max && max !== 'megacity' && pop > scaleMaxPop(max) * 1.5
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
    heightDraftId++;
    draft = { ...settlUI.capture(registry.readAll(settlUI.editorOptions(draft)), draft), importedHeight: importedMem };
    updateHeightmapUI(); markDraft();
  } catch (e) {
    statusEl.textContent = 'Could not read the image: ' + (e as Error).message;
  }
  hmFile.value = '';
});
hmClear.addEventListener('click', () => {
  importedMem = null; heightDraftId++;
  draft = { ...settlUI.capture(registry.readAll(settlUI.editorOptions(draft)), draft), importedHeight: undefined };
  updateHeightmapUI(); markDraft();
});
function updateHeightmapUI(): void {
  const custom = !!draft.importedHeight;
  hmParams.hidden = !custom;
  hmClear.hidden = !custom;
  reliefEl.disabled = custom; coastEl.disabled = custom;
  hmInfo.textContent = custom ? `${draft.importedHeight!.name ?? 'image'} (${draft.importedHeight!.w} x ${draft.importedHeight!.h} px)` : '';
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
const handoff = new FrameHandoff();
const finalFrame = handoff.final;
let mainPresentedGen = 0;
let presentedWorld: World | null = null;
let renderFailedGen = 0;
let workerTextMeasure = false;
let pendingDone: GDone | null = null;
let pendingMain: { id: number; stats: Record<string, number | string>; ms: number } | null = null;
let exportId = 0;
const legacyExports = new Map<number, { resolve(blob: Blob): void; reject(error: Error): void }>();

const display = (): DisplayOpts => ({ ...(paintedTextures && brushStatus !== 'failed' ? { painted: true } : {}), style: mapStyle(), contours: opts.contours, landuse: opts.landuse, labels: opts.labels, legend: opts.legend });
const measureCtx = document.createElement('canvas').getContext('2d');

/** (Re)build the renderer from the current world and the display options. */
function rerender(keepView = true): void {
  if (!backendSettled) return;
  if (paintedTextures && brushStatus === 'idle') {
    brushStatus = 'loading';
    if (backend) backend.setBrushSources(BRUSH_SOURCES);
    else void decodeBrushes(BRUSH_SOURCES).then(images => {
      brushImages = images; brushStatus = images ? 'ready' : 'failed';
      if (paintedTextures && currentWorld) rerender(true);
    });
  }
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
  currentRenderer = createCanvasRenderer(canvasEl, w, mapStyle(), { scene: sceneCache.scene, brushes: paintedTextures ? brushImages ?? undefined : undefined });
  rec('createRenderer', pnow() - t1);
  viewer.setRenderer(currentRenderer, w.mapSize, keepView);
  applyPendingView();
}

/** Main-thread mode: the finished World arrived (structured clone) - draw it. */
function show(world: World, stats: Record<string, number | string>, ms: number): void {
  rec('genWorker', ms); rec('roundTrip', pnow() - genStart); rec('transfer', pnow() - genStart - ms);
  const tShow = pnow();
  const previous = { world: currentWorld, scene: sceneCache };
  currentWorld = world;
  pendingMain = { id: reqId, stats, ms };
  try { rerender(true); }
  catch (error) {
    currentWorld = previous.world; sceneCache = previous.scene; pendingMain = null;
    backendEvents.onRenderError?.(reqId, String((error as Error)?.message ?? error));
    return;
  }
  rec('showSync', pnow() - tShow);
  perf.extra.stats = stats;
// CANVAS-VIEWER (end show)
  setBusy(true, 'drawing');
}

function showStats(stats: Record<string, number | string>, ms: number): void {
  const town = stats['names.town'];
  document.title = town ? `${town} - Magna Urbis` : 'Magna Urbis';
  genTimeEl.textContent = `Generated in ${(ms / 1000).toFixed(2)} s`;
  const seaPct = Math.round(Number(stats.seaFraction ?? 0) * 100);
  statusEl.textContent = `terrain ${stats['ms.terrain']} ms, urban ${stats['ms.urban'] ?? 0} ms - ${stats.rivers} rivers, ${stats.lakes} lakes, sea ${seaPct}% - ${stats.roads ?? 0} roads, ${stats.bridges ?? 0} bridges - ${stats['urban.archetype'] ?? ''} pop ${stats['urban.pop'] ?? 0}: ${stats['urban.blocks'] ?? 0} blocks, ${stats['urban.buildings'] ?? 0} buildings`
    + (Number(stats['settlements'] ?? 0) > 1 ? ` - ${stats['settlements']} settlements (${stats['ms.settlements'] ?? 0} ms)` : '')
    + (stats['urban.mega'] ? ` - megacity plan: ${stats['urban.quarters']} quarters in ${stats['urban.rings']} rings, ${stats['urban.nuclei']} nuclei (zoom in to detail the quarters)` : '');
  if (typeof stats['developer.stage'] === 'number') genTimeEl.textContent = `Developer · stage ${stats['developer.stage']}/4 · ${(ms / 1000).toFixed(2)} s`;
  ($('exportSvgFull') as HTMLButtonElement).hidden = !stats['urban.mega'];
  showSettlementWarnings(stats);
  // generated names and positions are now known: placeholders and markers follow the displayed map
  settlUI.refresh(); refreshMarks();
  developer?.complete(stats, settlementList());
}

// Thin determinate bar at the top of the map: jumps to each pipeline stage and creeps inside the long ones.
// The current map stays visible and interactive underneath; nothing is blanked or blocked.
const loadEl = $('loadbar');
const loadFill = loadEl.firstElementChild as HTMLElement;
const STAGE_FRAC: Record<string, [number, number]> = {
  starting: [0.01, 0.03], terrain: [0.03, 0.09], 'site & roads': [0.09, 0.2], town: [0.2, 0.6], settlements: [0.6, 0.68], villages: [0.68, 0.84],
  'fields & woods': [0.85, 0.94], names: [0.94, 0.97], drawing: [0.97, 0.99],
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
  developer?.busy(on);
  setLoad(on, stage);
  busyEl.classList.toggle('on', on);
  progressEl.classList.toggle('on', on || exporting);
  if (on) { busyEl.textContent = stage ? `generating: ${stage}...` : 'generating...'; genTimeEl.textContent = stage ? `Generating: ${stage}...` : 'Generating...'; }
}

/** The view of an opened link: set after the first content (the map size is then known); later changes are the user's. */
function applyPendingView(): void {
  if (viewReady) return;
  viewReady = true;
  if (pendingView) { viewer.setView(pendingView); pendingView = null; }
}

// ---- offscreen mode events
let firstContentGen = 0, firstFrameGen = 0, awaitVer = 0;
function finishOffscreen(): void {
  if (!finalFrame.ready || !pendingDone || pendingDone.id !== reqId || renderFailedGen === reqId) return;
  const d = pendingDone; pendingDone = null;
  meta = handoff.displayedMeta ?? d.meta;
  showStats(d.stats, d.ms); setBusy(false);
  rec('startToFrame', pnow() - genStart); perf.extra.doneAt = pnow();
}
const backendEvents: BackendEvents = {
  onBrushStatus(ready) { brushStatus = ready ? 'ready' : 'failed'; },
  onStage(id, stage) { if (id === reqId && renderFailedGen !== id) setBusy(true, stage); },
  onDone(d) {
    if (d.id !== reqId) return;
    pendingDone = d; finalFrame.generated(d.id); detailAsked.clear();
    rec('genWorker', d.ms); perf.extra.stats = d.stats;
    if (renderFailedGen === d.id) { setBusy(false); return; }
    if (!finalFrame.ready) setBusy(true, 'drawing');
    finishOffscreen();
  },
  onError(id, error) {
    if (id !== reqId) return;
    setBusy(false); developer?.failed(); genTimeEl.textContent = 'Generation failed'; statusEl.textContent = 'Error: ' + error.split('\n')[0]; console.error(error);
  },
  onRenderError(id, error) {
    if (id !== reqId) return;
    renderFailedGen = id;
    setBusy(false); developer?.failed(); genTimeEl.textContent = 'Rendering failed'; statusEl.textContent = 'Error: ' + error.split('\n')[0];
  },
  onContent(c) {
    if (!handoff.acceptsContent(c.gen)) return;
    // Final world or a display/detail rebuild: redraw, keeping the view unless the map size changed.
    viewer.contentChanged(c.mapSize, true, c.marker);
    if (c.gen === reqId) applyPendingView();
    map.style.background = c.paper;
    handoff.content(c.gen, c.ver, c.final, c.meta);
    if (c.gen !== reqId) return;
    awaitVer = c.ver;
    if (firstContentGen !== c.gen) { firstContentGen = c.gen; rec('firstContent', pnow() - genStart); }
    rec(c.final ? 'sceneFinal' : 'scenePartial', c.sceneMs);
  },
  onDetail(d) {
    if (d.id !== reqId) return;
    const s = meta?.settlements?.[d.index];
    if (s) s.hasUrban = !d.error;
    rec('settlementDetail', d.ms);
    if (d.error) console.error('settlement detail:', d.error);
    // (a big secondary settlement is planned as a megacity: its quarters can be detailed now)
    else if (s && s.population > megaPop()) { megaRect = null; maybeQuarters(viewer.getView()); }
  },
  onQuarters(d) {
    if (d.id !== reqId) return;
    megaProgress(d.done, d.queued, d.total, d.failed);
    rec('quarterSlice', d.ms);
  },
  onFrame(f) {
    const presented = viewer.present(f, handoff.acceptsFrame(f.gen, f.ver));
    if (!presented) return;
    lastLabels = f.labels; perf.extra.lastFrameView = f.view;
    handoff.presented(f.gen, f.ver);
    meta = handoff.displayedMeta;
    showMapInformation(meta?.mapInfo);
    if (f.gen === reqId) renderFailedGen = 0;
    if (f.gen === reqId && awaitVer && f.ver >= awaitVer && f.bitmap) {
      awaitVer = 0;
      if (firstFrameGen !== reqId) { firstFrameGen = reqId; rec('firstFrame', pnow() - genStart); }
    }
    finishOffscreen();
    maybeDetail(f.view);
  },
  onFatal(msg) {
    setBusy(false); genTimeEl.textContent = 'Renderer stopped'; statusEl.textContent = 'A worker failed (' + msg + '): reload the page, or add ?render=main to the address.';
  },
};

function spawnWorker(): void {
  workerTextMeasure = false;
  try { worker = new GenWorker(); } catch { worker = null; legacyWorkerRefused = true; return; }
  worker.onmessage = (e: MessageEvent<WorkerResponse | GResponse>) => {
    const r = legacyGenerationResponse(e.data, {
      exported(m) {
        const p = legacyExports.get(m.id); legacyExports.delete(m.id);
        if (m.blob) p?.resolve(m.blob); else p?.reject(new Error(m.error ?? 'export failed'));
      },
      quarters(m) { if (m.id === reqId) megaProgress(m.done, m.queued, m.total, m.failed); },
      capabilities(ok) { workerTextMeasure = ok; },
    });
    if (!r) return;
    if (r.id !== reqId) return;
    if (r.stage) { setBusy(true, r.stage); return; }
    if (r.detail) { applyDetail(r.detail.index, r.detail.urban, r.detail.bridges); return; }
    if (r.quarters) { applyQuarters(r.quarters.layers, r.quarters.drop); megaProgress(r.quarters.done, r.quarters.queued, r.quarters.total, r.quarters.failed); return; }
    workerBusy = false;
    if (r.error) { setBusy(false); developer?.failed(); genTimeEl.textContent = 'Generation failed'; statusEl.textContent = 'Error: ' + r.error.split('\n')[0]; console.error(r.error); return; }
    show(r.world!, r.stats!, r.ms!);
  };
  // e.g. blob workers are refused on file:// - fall back to generating on the main thread
  worker.onerror = () => {
    for (const p of legacyExports.values()) p.reject(new Error('generation worker unavailable'));
    legacyExports.clear();
    console.info('Generation worker unavailable (file:// ?), generating on the main thread'); worker?.terminate(); worker = null; legacyWorkerRefused = true; workerBusy = false; run();
  };
}

function genKey(): string {
  return toQuery({ ...opts, style: DEFAULTS.style, contours: DEFAULTS.contours, landuse: DEFAULTS.landuse, labels: true, legend: false }) + '|' + heightId;
}

function run(debugStage?: DebugStage): void {
  if (!backendSettled) return; // the first run starts when the backend probe has answered
  debugRunStage = debugStage;
  developer?.started(debugStage);
  if (debugStage === undefined) mainDebug = null;
  const id = ++reqId;
  handoff.begin(id); pendingDone = null; pendingMain = null; awaitVer = 0; renderFailedGen = 0;
  for (const p of legacyExports.values()) p.reject(new Error('superseded'));
  legacyExports.clear();
  detailAsked.clear();
  megaLocal?.stop(); megaLocal = null; megaRect = null;
  lastGenKey = genKey() + (debugStage === undefined ? '' : '|developer:' + debugStage);
  genStart = performance.now();
  setBusy(true, 'starting');
  if (backend) { backend.run(id, opts, debugStage); return; }
  if (!worker && !legacyWorkerRefused) spawnWorker();
  if (worker) {
    // a newer request supersedes a running one: restart the worker instead of queueing behind it
    if (workerBusy) { worker.terminate(); worker = null; spawnWorker(); }
  }
  if (worker) {
    workerBusy = true;
    worker.postMessage({ id, options: opts, debugStage });
  } else {
    setTimeout(() => {
      if (id !== reqId) return;
      try {
        if (debugStage !== undefined && (debugStage === 0 || !mainDebug || debugConfigurationKey(mainDebug.options) !== debugConfigurationKey(opts))) mainDebug = new DebugGeneration(opts);
        const world = debugStage === undefined ? generate(opts, undefined, { cache: mainCache }) : mainDebug!.advance(debugStage, undefined, opts);
        show(world, world.stats, Math.round(performance.now() - genStart));
      } catch (err) {
        setBusy(false); developer?.failed(); statusEl.textContent = 'Error: ' + String((err as Error).message);
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
  if (!displayOnly) {
    pendingSettings = false; menuBtn.classList.remove('dirty');
    feedbackEl.textContent = 'Changes apply when you generate.'; feedbackEl.classList.remove('dirty');
    draft = structuredClone(opts);
    settlUI.load(draft);
    registry.writeAll(settlUI.editorOptions(draft));
  }
  roadsEl.options[0].textContent = `Auto (${DEFAULT_ROADS[settlUI.editorOptions(draft).size]})`;
  updateHeightmapUI();
  if (mode !== 'none') {
    const q = '?' + curQuery();
    if (q !== location.search) (mode === 'push' ? history.pushState : history.replaceState).call(history, null, '', q);
  }
  if (!displayOnly && genKey() !== lastGenKey) schedule();
  else if (displayOnly && (currentWorld || backend)) rerender(true);
  syncDock();
  $('draftState').textContent = '';
  showMapId();
  refreshMarks();
}

function markDraft(): void {
  developer?.invalidate();
  pendingSettings = true; menuBtn.classList.add('dirty');
  feedbackEl.textContent = 'Unapplied changes'; feedbackEl.classList.add('dirty');
  $('draftState').textContent = 'Unapplied changes in Customize';
  refreshMarks();
}
function changeEditor(change: (o: Options) => Options): void {
  const before = toQuery(draft);
  draft = settlUI.capture(registry.readAll(settlUI.editorOptions(draft)), draft);
  draft = change(draft);
  registry.writeAll(settlUI.editorOptions(draft));
  roadsEl.options[0].textContent = `Auto (${DEFAULT_ROADS[settlUI.editorOptions(draft).size]})`;
  if (toQuery(draft) !== before) markDraft();
}
registry.onChange((control) => {
  draft = settlUI.capture(registry.readAll(settlUI.editorOptions(draft)), draft);
  if (control.display) {
    opts = { ...opts, style: draft.style, contours: draft.contours, landuse: draft.landuse, labels: draft.labels, legend: draft.legend };
    syncDock();
    const q = '?' + curQuery();
    if (q !== location.search) history.pushState(null, '', q);
    if (currentWorld || backend) rerender(true);
  } else markDraft();
});
function applyGeneration(environment: boolean, keepOpen = false): boolean {
  if (!registry.controls.every((control) => Array.from(control.el.matches('input') ? [control.el] : control.el.querySelectorAll('input')).every((input) => !(input instanceof HTMLInputElement) || input.checkValidity()))) {
    $('draftState').textContent = 'Check the highlighted values before generating.';
    for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('#panel input, #layoutFlyout input'))) if (!input.checkValidity()) {
      configuration.open(input.closest('[role=tabpanel]')?.id);
      if (input.closest('#layoutFlyout')) layoutFlyout.open();
      input.reportValidity(); break;
    }
    return false;
  }
  const x = $<HTMLInputElement>('centerX'), y = $<HTMLInputElement>('centerY');
  if (!!x.value !== !!y.value) {
    $('draftState').textContent = 'Enter both position coordinates, or clear both for automatic placement.';
    configuration.open('settlementsPane'); (x.value ? y : x).focus(); return false;
  }
  draft = settlUI.capture(registry.readAll(settlUI.editorOptions(draft)), draft);
  heightId = heightDraftId;
  opts = environment ? { ...draft, workflow: 'environment', settlementMode: settlUI.mode } : settlUI.composition(draft);
  settlUI.cancelPick();
  commit('push');
  if (!keepOpen) configuration.close();
  return true;
}
$('generateEnvironment').addEventListener('click', () => applyGeneration(true));
$('generateSettlements').addEventListener('click', () => applyGeneration(false));

paintedEl.addEventListener('change', () => {
  paintedTextures = paintedEl.checked;
  const q = '?' + curQuery(); if (q !== location.search) history.pushState(null, '', q);
  rerender(true);
});

window.addEventListener('popstate', () => {
  paintedTextures = paintedFromQuery(location.search); paintedEl.checked = paintedTextures;
  const parsed = parseOptions(location.search);
  missingCustom = wantsCustomHeight(location.search) && !importedMem;
  opts = { ...parsed, importedHeight: wantsCustomHeight(location.search) ? importedMem ?? undefined : undefined };
  heightId = opts.importedHeight ? heightDraftId : 0;
  commit('none');
  rerender(true);
});

function randomSeed(): string { return Math.random().toString(36).slice(2, 8); }
/**
 * Apply `patch` to the applied map right away (one click on the map: new seed, biome, surprise) and regenerate.
 * Unfinished Customize edits survive: they stay a draft on top of the new map.
 */
function quickApply(patch: Partial<Options>): void {
  const pending = pendingSettings ? settlUI.capture(registry.readAll(settlUI.editorOptions(draft)), draft) : null;
  opts = { ...freshMapOptions(opts, opts.seed), ...patch };
  settlUI.cancelPick();
  commit('push');
  if (pending) {
    draft = { ...pending, ...patch };
    settlUI.load(draft); registry.writeAll(settlUI.editorOptions(draft));
    updateHeightmapUI(); markDraft();
  }
}
$('newMap').addEventListener('click', () => quickApply({ seed: randomSeed() }));
const knownCultures = new Set(CULTURE_LIST.map((c) => c.id));
$('surprise').addEventListener('click', () => {
  const patch = surprisePatch(Math.random, knownCultures);
  // a bigger settlement needs at least its preset's room; a larger extent chosen by the user is kept
  quickApply({ ...patch, seed: randomSeed(), mapSize: Math.max(mapSizeOf(opts), SIZE_PRESETS[patch.size].mapSize) });
});
function reroll(): void {
  draft = settlUI.capture(registry.readAll(settlUI.editorOptions(draft)), draft);
  draft = { ...draft, seed: randomSeed() };
  seedEl.value = draft.seed; markDraft();
}
$('dice').addEventListener('click', reroll);
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'r' || e.key === 'R') { e.preventDefault(); reroll(); }
});

/** The query of the current state: options + pins + view (the latter two only in the link, see share.ts). */
const urlView = (): ViewState | null => (viewReady ? viewer.getView() : pendingView);
const curQuery = (): string => appearanceQuery(fullQuery(opts, pinsUI.pins, urlView()), paintedTextures);
let urlTimer: number | undefined;
/** Keep the address bar in step with the pins and the view (debounced, replaceState: no history entries). */
function syncUrl(): void {
  window.clearTimeout(urlTimer);
  urlTimer = window.setTimeout(() => {
    const q = '?' + curQuery();
    if (q !== location.search) history.replaceState(null, '', q);
  }, 300);
}
async function copyText(text: string): Promise<boolean> {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  (window as unknown as Record<string, unknown>).__lastCopied = text;
  return ok;
}
function wireCopy(btn: HTMLButtonElement, text: () => string, done: string): void {
  const label = btn.textContent;
  btn.addEventListener('click', async () => {
    const ok = await copyText(text());
    btn.textContent = ok ? done : 'Copy failed';
    window.setTimeout(() => { btn.textContent = label; }, 1600);
  });
}
wireCopy($<HTMLButtonElement>('copyLink'), () => location.origin + location.pathname + '?' + curQuery(), 'Link copied');
wireCopy($<HTMLButtonElement>('copyId'), () => mapId(opts), 'ID copied');
/** The one reusable identifier of the applied map (settings + seed), shown in the corner and the share menu. */
function showMapId(): void {
  const id = mapId(opts);
  $('generationIdentity').textContent = 'ID ' + id;
  $('mapIdBox').textContent = id;
}
$('generationIdentity').addEventListener('click', async () => {
  const el = $('generationIdentity');
  const ok = await copyText(mapId(opts));
  el.textContent = ok ? 'ID copied' : 'Copy failed';
  window.setTimeout(showMapId, 1200);
});
/** Open a pasted ID (or a whole link, or a legacy query): the page reloads on it, exactly like a shared link. */
$('openIdForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = $<HTMLInputElement>('openIdInput').value.trim();
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?')) : /^[a-z]+=/.test(raw) ? '?' + raw : '?id=' + encodeURIComponent(raw);
  const options = raw ? fromQuery(query) : null;
  if (!options || !expandMapQuery(query).get('seed')) { $('openIdState').textContent = 'This is not a Magna Urbis ID or link.'; return; }
  location.search = query;
});
wireCopy($<HTMLButtonElement>('copyBug'), () => bugReport(opts, pinsUI.pins, viewer.getView(), location.origin + location.pathname, map.clientWidth, paintedTextures ? appearanceQuery(fullQuery(opts, pinsUI.pins, viewer.getView()), true) : undefined), 'Report copied');

// ---------- viewer (canvas, LOD) ----------
// CANVAS-VIEWER (begin viewer)
const map = $('map');
const canvasEl = $<HTMLCanvasElement>('view');
const hudEl = $('hud');
const viewer = createViewer({
  container: map, canvas: canvasEl, minimap: $<HTMLCanvasElement>('minimap'),
  onView: (v, w, h) => { pinsUI.update(v, w, h); marks.update(v, w, h); developer?.update(v, w, h); ruler.update(); renderCoords(); if (viewReady) syncUrl(); },
  onError: (error) => {
    if (pendingMain?.id === reqId) backendEvents.onRenderError?.(reqId, String(error.message));
    else console.error('canvas draw:', error);
  },
  onFrame: (ms, band, scale) => {
    if (!backend) showMapInformation(currentRenderer?.getMapInfo());
    if (!backend && pendingMain?.id === reqId) {
      const d = pendingMain; pendingMain = null;
      renderFailedGen = 0;
      mainPresentedGen = d.id;
      showStats(d.stats, d.ms); setBusy(false);
      rec('startToFrame', pnow() - genStart); perf.extra.doneAt = pnow();
    }
    if (!backend) presentedWorld = currentWorld;
    maybeDetail(viewer.getView()); perf.frames.push(ms); if (perf.frames.length > 5000) perf.frames.shift(); hudEl.textContent = `${['far', 'mid', 'near'][band]} - ${scale.toFixed(3)} px/m - ${ms.toFixed(1)} ms`;
  },
});
$('fit').addEventListener('click', () => viewer.fit());
developer = initDeveloper($('panel').querySelector<HTMLElement>('.settings-content')!, map, (stage) => {
  if (stage === 0 && !applyGeneration(false, true)) return;
  window.clearTimeout(timer);
  run(stage);
});
developer.update(viewer.getView(), map.clientWidth, map.clientHeight);

// ---------- debug / feedback tools: coordinate readout, pins ----------
const coordText = $('coordText');
let hover: [number, number] | null = null;
let lastClick: [number, number] | null = null;
const mapPoint = (e: MouseEvent): [number, number] => {
  const r = map.getBoundingClientRect();
  return screenToWorld(viewer.getView(), r.width, r.height, e.clientX - r.left, e.clientY - r.top);
};
/** Two lines just above the minimap: the cursor, else the last click. */
function renderCoords(): void {
  const p = hover ?? lastClick;
  const f = (n: number): string => `${Math.round(n)} m`.padStart(8);
  coordText.textContent = p ? `x${f(p[0])}\ny${f(p[1])}` : 'x       –\ny       –';
}
map.addEventListener('pointermove', (e) => {
  if ((e.target as Element).closest('.hud, #pinpop')) return;
  hover = mapPoint(e); renderCoords();
});
map.addEventListener('pointerleave', () => { hover = null; renderCoords(); });
const minimapEl = $<HTMLCanvasElement>('minimap');
const miniPoint = (e: PointerEvent): [number, number] => {
  const r = minimapEl.getBoundingClientRect();
  const size = (backend ? meta?.mapSize : presentedWorld?.mapSize ?? currentWorld?.mapSize) ?? mapSizeOf(opts);
  const clamp = (n: number): number => Math.max(0, Math.min(size, n));
  return [clamp((e.clientX - r.left) / r.width * size), clamp((e.clientY - r.top) / r.height * size)];
};
minimapEl.addEventListener('pointermove', (e) => { hover = miniPoint(e); renderCoords(); });
minimapEl.addEventListener('pointerdown', (e) => { hover = lastClick = miniPoint(e); renderCoords(); });
minimapEl.addEventListener('pointerleave', () => { hover = null; renderCoords(); });
$('coordCopy').addEventListener('click', async (e) => {
  const p = lastClick ?? hover;
  if (!p) return;
  const b = e.currentTarget as HTMLButtonElement;
  const ok = await copyText(`${p[0].toFixed(1)},${p[1].toFixed(1)}`);
  b.textContent = ok ? 'Copied' : 'Failed';
  window.setTimeout(() => { b.textContent = 'Copy'; }, 1200);
});
$('coords').addEventListener('pointerdown', (e) => e.stopPropagation());
$('coords').addEventListener('pointerup', (e) => e.stopPropagation());
const pinsUI = createPins({
  map, layer: $('pins'), pop: $('pinpop'), list: $('pinList'),
  onChange: () => syncUrl(),
  onFocus: (p) => viewer.setView({ cx: p.x, cy: p.y, scale: Math.max(viewer.getView().scale, 0.3) }),
});
let pinMode = false;
const ruler = createRuler({ container: map, surface: canvasEl, controlsHost: $('corner'), getView: () => viewer.getView(), onEnable: () => setPinMode(false) });
function setPinMode(on: boolean): void {
  if (on) ruler.setEnabled(false);
  pinMode = on;
  map.classList.toggle('pinning', on);
  $('pinMode').classList.toggle('on', on);
  $('pinModeBtn').classList.toggle('on', on);
}
$('pinMode').addEventListener('click', () => setPinMode(!pinMode));
$('pinModeBtn').addEventListener('click', () => setPinMode(!pinMode));
$('pinsClear').addEventListener('click', () => { pinsUI.set([]); syncUrl(); });
function setPins(p: Pin[]): void { pinsUI.set(p); if (p.length) ($('sec-pins') as HTMLDetailsElement).open = true; }
setPins(initUi.pins);

// ---------- settlements (M3c): click to focus / to place a listed settlement, lazy detail on zoom ----------
const detailAsked = new Set<number>();
/** Settlements of the current map (offscreen mode: the summary sent by the generation worker). */
function settlementList(): SettlementMeta[] {
  if (backend) return meta?.settlements ?? [];
  return (currentWorld?.settlements ?? []).map((s) => ({ index: s.index, key: s.key, name: s.name, cls: s.cls, population: s.population, center: s.center, radius: s.radius, detail: s.detail, hasUrban: !!s.urban || !!s.main }));
}
/** Main-thread mode: a settlement plan arrived; merge it and redraw. */
function applyDetail(index: number, urban: NonNullable<World['urban']>, bridges: NonNullable<World['bridges']>): void {
  if (!currentWorld?.settlements?.[index]) return;
  const list = currentWorld.settlements.slice();
  list[index] = { ...list[index], urban };
  currentWorld = { ...currentWorld, settlements: list, bridges: [...(currentWorld.bridges ?? []), ...bridges] };
  refreshCavernMask(currentWorld);
  if (urban.macro) { megaLocal?.setWorld(currentWorld); megaRect = null; maybeQuarters(viewer.getView()); }
  sceneCache = null;
  rerender(true);
}
/** Detail level: settlements generated lazily are built when the view comes close enough (in a worker). */
const DETAIL_SCALE = 0.12;
function maybeDetail(v: { cx: number; cy: number; scale: number }): void {
  if (debugRunStage !== undefined && debugRunStage < 4) return;
  if (busyEl.classList.contains('on') || renderFailedGen === reqId || (backend ? handoff.displayedGen !== reqId : mainPresentedGen !== reqId)) return;
  maybeQuarters(v);
  if (v.scale < DETAIL_SCALE) return;
  const r = map.getBoundingClientRect();
  const hw = r.width / (2 * v.scale), hh = r.height / (2 * v.scale);
  for (const s of settlementList()) {
    if (s.detail !== 'lazy' || s.hasUrban || detailAsked.has(s.index)) continue;
    if (Math.abs(s.center.x - v.cx) > hw + s.radius || Math.abs(s.center.y - v.cy) > hh + s.radius) continue;
    detailAsked.add(s.index);
    if (backend) backend.detail(reqId, s.index);
    else if (worker) worker.postMessage({ type: 'detail', id: reqId, index: s.index });
    else if (currentWorld) {
      const w = currentWorld, id = reqId;
      setTimeout(() => { if (id !== reqId) return; const res = generateSettlementDetail(w, s.index); if (res) applyDetail(s.index, res.urban, res.bridges); }, 0);
    }
  }
}
// ---------- megacity (URBAN_MORPHOLOGY §3d): quarters detailed lazily, in the worker, as the view comes close ----------
const MEGA_SCALE = 0.1;
let megaRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
let megaLocal: QuarterQueue | null = null;
let megaRedraw: number | undefined;
/** Settlements above this population are planned as megacities (macro plan + lazy quarters). */
const megaPop = (): number => opts.eagerPop ?? EAGER_MAIN_POP;
const isMega = (): boolean => (backend ? !!meta?.mega || settlementList().some((s) => s.index > 0 && s.population > megaPop()) : !!currentWorld?.urban?.macro || !!currentWorld?.settlements?.some((s) => s.urban?.macro));
function megaProgress(done: number, queued: number, total: number, failed = 0): void {
  statusEl.textContent = queued > 0 ? `Detailing quarters: ${done} ready, ${queued} queued (of ${total})` : `${done} of ${total} quarters detailed (zoom in elsewhere for more)`;
  if (failed) statusEl.textContent += `; ${failed} unavailable`;
}
/** Main-thread / legacy mode: detailed quarters merged into the World, redrawn at most every 400 ms. */
function applyQuarters(layers: Record<number, NonNullable<World['urban']>>, drop: number[]): void {
  if (!currentWorld || (!Object.keys(layers).length && !drop.length)) return;
  const det = { ...(currentWorld.megaDetail ?? {}), ...layers };
  for (const id of drop) delete det[id];
  currentWorld = { ...currentWorld, megaDetail: det };
  if (megaRedraw !== undefined) return;
  megaRedraw = window.setTimeout(() => {
    megaRedraw = undefined;
    if (currentWorld) refreshCavernMask(currentWorld);
    sceneCache = null; rerender(true);
  }, 400);
}
function maybeQuarters(v: { cx: number; cy: number; scale: number }): void {
  if (debugRunStage !== undefined && debugRunStage < 4) return;
  if (v.scale < MEGA_SCALE || !isMega()) return;
  const r = map.getBoundingClientRect();
  const hw = r.width / (2 * v.scale), hh = r.height / (2 * v.scale);
  const rect = { x0: v.cx - hw, y0: v.cy - hh, x1: v.cx + hw, y1: v.cy + hh };
  // (a new request only when the view moved or zoomed noticeably)
  if (megaRect && Math.abs(rect.x0 - megaRect.x0) + Math.abs(rect.x1 - megaRect.x1) + Math.abs(rect.y0 - megaRect.y0) + Math.abs(rect.y1 - megaRect.y1) < 0.08 * (rect.x1 - rect.x0)) return;
  megaRect = rect;
  if (backend) backend.quarters(reqId, rect);
  else if (worker) worker.postMessage({ type: 'quarters', id: reqId, rect });
  else if (currentWorld) {
    megaLocal ??= new QuarterQueue(currentWorld, (layers, drop, st) => { applyQuarters(layers, drop); megaProgress(st.done, st.queued, st.total, st.failed); }, 420, 150, createQuarterExecutor(currentWorld));
    megaLocal.request(rect);
  }
}
function focusSettlement(s: SettlementMeta): void {
  const r = map.getBoundingClientRect();
  const scale = Math.max(0.05, Math.min(4, Math.min(r.width, r.height) / (5 * Math.max(60, s.radius))));
  viewer.setView({ cx: s.center.x, cy: s.center.y, scale });
}
{
  let down: { x: number; y: number; t: number } | null = null;
  map.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  map.addEventListener('pointerup', (e) => {
    if (!down || (e.target as HTMLElement).closest('button, #pinpop, #coords, .hud')) { down = null; return; }
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t;
    down = null;
    // placing a settlement tolerates a slightly shaky or slow click; ordinary clicks stay strict (drags pan)
    if (settlUI.picking !== null ? moved > 12 : moved > 5 || dt > 500) return;
    const r = map.getBoundingClientRect();
    const v = viewer.getView();
    const [x, y] = screenToWorld(v, r.width, r.height, e.clientX - r.left, e.clientY - r.top);
    lastClick = [x, y]; renderCoords();
    if (settlUI.picking !== null) { settlUI.place({ x, y }); return; }
    if (pinMode || e.altKey) { pinsUI.add(x, y); ($('sec-pins') as HTMLDetailsElement).open = true; return; }
    let best: SettlementMeta | null = null, bd = Infinity;
    for (const s of settlementList()) {
      const d = Math.hypot(s.center.x - x, s.center.y - y);
      const reach = Math.max(s.radius * 1.1, 14 / v.scale);
      if (d < reach && d < bd) { bd = d; best = s; }
    }
    if (best) focusSettlement(best);
  });
}
// debug hook for scripted screenshots (scripts/ui_check.mjs)
(window as unknown as Record<string, unknown>).__magnaUrbis = {
  setView: (v: { cx: number; cy: number; scale: number }) => viewer.setView(v),
  getView: () => viewer.getView(),
  fit: () => viewer.fit(),
  /** The World (main-thread mode only: in offscreen mode it lives in the workers; open the page with ?render=main to inspect it). */
  world: () => currentWorld,
  options: () => opts,
  draft: () => draft,
  mode: () => (backend ? 'offscreen' : 'main'),
  rendering: () => ({ gen: reqId, displayedGen: backend ? handoff.displayedGen : mainPresentedGen, finalVer: finalFrame.finalVer, frameVer: finalFrame.presentedVer, ready: backend ? finalFrame.ready && renderFailedGen !== reqId : mainPresentedGen === reqId && !pendingMain && !busyEl.classList.contains('on') }),
  /** Labels placed in the last frame (kind, text, size). */
  labels: () => (backend ? lastLabels : (currentRenderer?.lastPlaced() ?? []).map((p) => ({ kind: p.label.kind, text: p.label.text, size: p.size }))),
  /** Center of the settlement (site center / urban footprint centroid). */
  center: () => meta?.center ?? currentWorld?.site?.center ?? { x: (currentWorld?.mapSize ?? meta?.mapSize ?? 0) / 2, y: (currentWorld?.mapSize ?? meta?.mapSize ?? 0) / 2 },
  /** Settlements of the map (M3c) and a scripted focus on one of them. */
  settlements: () => settlementList(),
  focus: (i: number) => { const s = settlementList()[i]; if (s) focusSettlement(s); },
  /** Anchor of a named feature (for scripted zooms). */
  find: (kind: string, n = 0) => meta?.anchors[kind]?.[n] ?? currentWorld?.names?.entries.filter((e) => e.kind === kind)[n]?.anchor ?? null,
};
// CANVAS-VIEWER (end viewer)

// ---------- export ----------
/** Save through the Artifact viewer's downloads capability when present, else a plain download. */
async function exportFile(name: string, data: Blob | string, mime: string): Promise<void> {
  try {
    const r = await saveFile(name, data, mime);
    if (r === 'saved' || r === 'fallback') statusEl.textContent = `Exported ${name}`;
  } catch (e) {
    statusEl.textContent = 'Export failed: ' + (e as Error).message;
  }
}
function captureExport(): ExportSnapshot {
  const currentKey = genKey() + (debugRunStage === undefined ? '' : '|developer:' + debugRunStage);
  if (busyEl.classList.contains('on') || currentKey !== lastGenKey) throw new Error('the map is still being generated');
  if (renderFailedGen === reqId || (backend && !finalFrame.ready)) throw new Error('the requested map has not been presented');
  if (paintedTextures && brushStatus === 'loading') throw new Error('painted textures are still loading');
  const snapshot = exportSnapshot(opts, backend ? null : presentedWorld, reqId, backend ? handoff.displayedGen : mainPresentedGen);
  if (paintedTextures && brushStatus === 'ready') { snapshot.brushes = BRUSH_SOURCES; snapshot.display.painted = true; }
  return snapshot;
}
/** SVG / JSON in the retained generation worker, including the main-render fallback when its worker is available. */
async function buildExport(snapshot: ExportSnapshot, kind: 'svg' | 'json', full = false, width?: number): Promise<Blob> {
  const t = pnow();
  let blob: Blob;
  if (backend) blob = await backend.export(snapshot.gen, kind, snapshot.display, full, width, snapshot.brushes);
  else if (worker && canWorkerExport(kind, workerTextMeasure)) {
    blob = await new Promise<Blob>((resolve, reject) => {
      const id = ++exportId;
      legacyExports.set(id, { resolve, reject });
      try { worker!.postMessage({ type: 'export', id, gen: snapshot.gen, kind, display: snapshot.display, full, width, brushes: snapshot.brushes }); }
      catch (error) { legacyExports.delete(id); reject(error); }
    });
  }
  else {
    let world = snapshot.world;
    if (!world) throw new Error('nothing to export yet');
    if (full && world.urban?.macro) {
      // megacity: every quarter's detail first (tile by tile; slow)
      const q = megaLocal ?? new QuarterQueue(world, () => {});
      world = { ...world, megaDetail: q.all() };
      refreshCavernMask(world);
    }
    await new Promise((r) => setTimeout(r, 30)); // let the progress message paint before the synchronous build
    const d = snapshot.display;
    const measure = (text: string, size: number, style: Parameters<typeof fontString>[0]): number => {
      if (!measureCtx) return text.length * size * 0.5;
      measureCtx.font = fontString(style, size, FONT_STACKS[d.style]);
      return measureCtx.measureText(text).width;
    };
    blob = kind === 'svg'
      ? new Blob([renderSvg(world, { width, style: d.style, contours: d.contours, landuse: d.landuse, labels: d.labels !== false, legend: !!d.legend, measure, brushes: d.painted ? snapshot.brushes : undefined })], { type: 'image/svg+xml' })
      : new Blob([worldToJson(world)], { type: 'application/json' });
  }
  rec(kind === 'svg' ? 'exportSvg' : 'exportJson', pnow() - t);
  perf.extra.svgBytes = blob.size;
  return blob;
}
/** Run an export job with visible progress (button label, progress bar, status line) and report failures. */
let exporting = false;
async function withProgress(btn: HTMLButtonElement, label: string, job: (snapshot: ExportSnapshot, progress: (label: string) => void) => Promise<void>): Promise<void> {
  if (exporting) return;
  const text = btn.textContent;
  const buttons = [exportSvgBtn, exportPngBtn, exportJsonBtn, exportFullBtn];
  const disabled = buttons.map((b) => b.disabled);
  exporting = true; buttons.forEach((b) => { b.disabled = true; }); btn.textContent = label;
  progressEl.classList.add('on'); statusEl.textContent = label.replace(/\.\.\.$/, '') + ' in the background...';
  const progress = (message: string): void => { btn.textContent = message; if (!busyEl.classList.contains('on')) statusEl.textContent = message; };
  try { await job(captureExport(), progress); } catch (e) { statusEl.textContent = 'Export failed: ' + (e as Error).message; } finally {
    exporting = false; buttons.forEach((b, i) => { b.disabled = disabled[i]; }); btn.textContent = text;
    if (!busyEl.classList.contains('on')) progressEl.classList.remove('on');
  }
}
const exportSvgBtn = $<HTMLButtonElement>('exportSvg');
const exportPngBtn = $<HTMLButtonElement>('exportPng');
const exportJsonBtn = $<HTMLButtonElement>('exportJson');
const exportFullBtn = $<HTMLButtonElement>('exportSvgFull');
exportFullBtn.addEventListener('click', () => {
  void withProgress(exportFullBtn, 'Detailing all quarters...', async (snapshot) => {
    await exportFile(snapshot.name + '-full.svg', await buildExport(snapshot, 'svg', true), 'image/svg+xml');
  });
});
exportSvgBtn.addEventListener('click', () => {
  void withProgress(exportSvgBtn, 'Building SVG...', async (snapshot) => {
    await exportFile(snapshot.name + '.svg', await buildExport(snapshot, 'svg'), 'image/svg+xml');
  });
});
exportJsonBtn.addEventListener('click', () => {
  void withProgress(exportJsonBtn, 'Building JSON...', async (snapshot) => {
    await exportFile(snapshot.name + '.json', await buildExport(snapshot, 'json'), 'application/json');
  });
});
exportPngBtn.addEventListener('click', () => {
  void withProgress(exportPngBtn, 'Building SVG...', async (snapshot, progress) => {
    const tP = pnow();
    const svgBlob = await buildExport(snapshot, 'svg', false, 3000);
    rec('pngSvg', pnow() - tP);
    const png = await exportPng(svgBlob, 3000, (phase) => progress(phase === 'decode' ? 'Decoding SVG...' : phase === 'raster' ? 'Drawing SVG...' : phase === 'snapshot' ? 'Preparing PNG pixels...' : 'Encoding PNG...'));
    rec('exportPng', pnow() - tP);
    progress('Saving PNG...');
    await exportFile(snapshot.name + '.png', png, 'image/png');
  });
});

pageReady = true;
history.replaceState(null, '', '?' + curQuery());
showMapId();
updateHeightmapUI();
// Probe the offscreen pipeline first (a few ms), then start the first run on whichever path works.
const backendReady: Promise<OffscreenBackend | null> = forceMain ? Promise.resolve(null) : OffscreenBackend.create(backendEvents, window.devicePixelRatio || 1);
void backendReady.then((b) => {
  backend = b;
  if (b) { viewer.setSource({ request: (r) => b.request(r) }); if (paintedTextures) { brushStatus = 'loading'; b.setBrushSources(BRUSH_SOURCES); } b.setDisplay(display()); }
  backendSettled = true;
  run();
});
