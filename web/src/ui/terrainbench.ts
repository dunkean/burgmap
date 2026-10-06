import './terrainbench.css';
import TerrainWorker from './terrainWorker?worker&inline';
import { sampleRustTerrain, RELIEFS, GEOLOGICAL_RELIEFS, ENVIRONMENT_RELIEFS, COMPUTE_MODES, type TerrainEnvironment, type TerrainCompute, type TerrainData, type TerrainSettings, type TerrainRequest, type TerrainResponse, type TerrainRelief, type TerrainRegion } from '../../../rust/bridge/terrain';
import { renderRustTerrain, terrainContourWidths, type TerrainStyle, type TerrainScene } from '../../../rust/bridge/terrainRender';
import { createPins } from './pins';
import { pinsFromString, pinsToString, viewFromString, viewToString } from './share';
import { clampView, fitView, panBy, screenToWorld, zoomAt, type View } from '../render/view';
import { COAST_DIRECTIONS, ISLAND_MODES, type IslandMode } from '../../../rust/bridge/terrain';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const input = (id: string): HTMLInputElement => el<HTMLInputElement>(id);
const map = document.getElementById('map') as unknown as SVGSVGElement;
const viewport = el('viewport');
const query = new URLSearchParams(location.search);
const finite = (value: string | null, fallback: number): number => value !== null && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback;
const bounded = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const initialRelief = query.get('relief') as TerrainRelief;
const geological = (relief: string): boolean => (GEOLOGICAL_RELIEFS as readonly string[]).includes(relief);
const initialEnvironment = query.get('environment') as TerrainEnvironment;
let settings: TerrainSettings = {
  seed: query.get('seed')?.slice(0, 120) || '42',
  width: bounded(finite(query.get('width'), 2400), 500, 100000),
  // Version 1 links had no independent physical motif scale.
  motifSize: bounded(finite(query.get('motif'), 3000), 250, 50000),
  relief: RELIEFS.includes(initialRelief) ? initialRelief : 'flat',
  environment: ENVIRONMENT_RELIEFS.includes(initialEnvironment) ? initialEnvironment : 'mixed',
  coastMask: (query.get('coasts') ?? '').split(',').reduce((mask, direction) => {
    const index = (COAST_DIRECTIONS as readonly string[]).indexOf(direction);
    return index < 0 ? mask : mask | (1 << index);
  }, 0),
  islandMode: ISLAND_MODES.includes(query.get('islands') as IslandMode) ? query.get('islands') as IslandMode : 'island',
  mountainMix: bounded(finite(query.get('mix'), 0.5), 0, 1),
  erosion: bounded(finite(query.get('erosion'), 1), 0, 2), resolution: 512,
  compute: COMPUTE_MODES.includes(query.get('compute') as TerrainCompute) ? query.get('compute') as TerrainCompute : 'gpu-f32',
  generationCompute: query.get('generation') === 'cpu' ? 'cpu' : query.get('generation') === 'gpu-all' ? 'gpu-all' : query.get('generation') === 'gpu' ? 'gpu' : 'gpu-erosion',
};
let style: TerrainStyle = ['parchment', 'atlas', 'topographic', 'copernicus'].includes(query.get('style') || '') ? query.get('style') as TerrainStyle : 'parchment';
let view: View = viewFromString(query.get('view')) || fitView(settings.width, viewport.clientWidth, viewport.clientHeight);
let terrain: TerrainData | undefined;
let pinMode = false, generation = 0, requestId = 0, terrainGeneration = 0;
let overviewRequest: TerrainRequest | undefined, detailRequest: TerrainRequest | undefined;
let generationTimer: ReturnType<typeof setTimeout> | undefined, detailTimer: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let renderingMs = 0, contourStep = 0, detailSamplingMs = 0;
interface DetailTile {
  terrain: Pick<TerrainData, 'x' | 'y' | 'width' | 'resolution' | 'generationMs' | 'backend' | 'backendReason' | 'prepareMs' | 'samplingMs' | 'gpuSetupMs'>;
  style: TerrainStyle; scene: TerrainScene; key: string;
  image: HTMLImageElement; ready: Promise<void>;
}
const detailCache = new Map<string, DetailTile>();
let displayedDetail: DetailTile | undefined;

input('width').value = String(settings.width); input('motifSize').value = String(settings.motifSize);
input('mountainMix').value = String(settings.mountainMix);
input('seed').value = settings.seed; input('erosion').value = String(settings.erosion);
el<HTMLSelectElement>('relief').value = settings.relief; el<HTMLSelectElement>('style').value = style;
el<HTMLSelectElement>('environment').value = settings.environment!;
el<HTMLSelectElement>('compute').value = settings.compute!;
el<HTMLSelectElement>('generationCompute').value = settings.generationCompute!;
input('auto').checked = query.get('auto') !== '0'; input('showPins').checked = query.get('showPins') !== '0';
input('showContours').checked = query.get('contours') !== '0';
function updateContourControl(): void {
  input('showContours').disabled = style === 'copernicus' || settings.relief === 'cavern';
  map.dataset.contours = String(input('showContours').checked && !input('showContours').disabled);
}
updateContourControl();
let draftCoastMask = settings.coastMask ?? 0;
const coastButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-coast]'));
el<HTMLSelectElement>('islandMode').value = settings.islandMode!;
function updateCoastControl(): void {
  const cavern = el<HTMLSelectElement>('relief').value === 'cavern';
  coastButtons.forEach(button => {
    const index = (COAST_DIRECTIONS as readonly string[]).indexOf(button.dataset.coast!);
    button.setAttribute('aria-pressed', String((draftCoastMask & (1 << index)) !== 0));
    button.disabled = cavern;
  });
  el<HTMLButtonElement>('coastAll').disabled = cavern;
  el('coastAll').setAttribute('aria-pressed', String(draftCoastMask === 255));
  el('coastControl').title = cavern ? 'Sans côtes en caverne' : 'Choisir les directions couvertes par la mer';
  el('islandControl').hidden = cavern || draftCoastMask !== 255;
}
function updateErosionControl(): void {
  updateCoastControl();
  el('environmentControl').hidden = !geological(el<HTMLSelectElement>('relief').value);
  el('mountainMixControl').hidden = el<HTMLSelectElement>('relief').value !== 'mixed';
  el('mountainMixValue').textContent = `${Math.round(Number(input('mountainMix').value) * 100)} %`;
  const cavern = el<HTMLSelectElement>('relief').value === 'cavern';
  input('erosion').disabled = cavern;
  input('erosion').title = cavern ? 'Sans érosion en caverne' : 'Intensité de l’érosion';
  el('erosionValue').textContent = cavern ? '—' : `${Math.round(Number(input('erosion').value) * 100)} %`;
}
updateErosionControl();

function status(message: string, error = false): void {
  el('status').textContent = message; el('status').dataset.error = String(error);
}
function shareQuery(): string {
  const params = new URLSearchParams({ engine: 'rust', v: '2', seed: settings.seed, width: String(settings.width), motif: String(settings.motifSize), relief: settings.relief, erosion: String(settings.erosion), style, auto: input('auto').checked ? '1' : '0' });
  params.set('contours', input('showContours').checked ? '1' : '0');
  if (settings.relief === 'mixed') params.set('mix', String(settings.mountainMix));
  if (geological(settings.relief)) params.set('environment', settings.environment ?? 'mixed');
  if (settings.relief !== 'cavern' && settings.coastMask) {
    params.set('coasts', COAST_DIRECTIONS.filter((_, i) => settings.coastMask! & (1 << i)).join(','));
    params.set('islands', settings.islandMode ?? 'island');
  }
  params.set('compute', settings.compute ?? 'gpu-f32');
  params.set('generation', settings.generationCompute ?? 'gpu-erosion');
  if (pins.pins.length) params.set('pins', pinsToString(pins.pins));
  if (!input('showPins').checked) params.set('showPins', '0');
  params.set('view', viewToString(view)); return params.toString();
}
function save(): void {
  clearTimeout(saveTimer);
  try { history.replaceState(null, '', `${location.pathname}?${shareQuery()}`); } catch { /* file:// may reject replaceState; copied links still carry all inputs. */ }
}
function deferSave(): void { clearTimeout(saveTimer); saveTimer = setTimeout(save, 150); }
const pins = createPins({
  map: viewport, layer: el('pinLayer'), pop: el('pinPopover'), list: el('pins'),
  onChange: deferSave,
  onFocus: pin => setView({ ...view, cx: pin.x, cy: pin.y }),
});
pins.set(pinsFromString(query.get('pins')));
const pinInput = el('pinPopover').querySelector('input')!; pinInput.placeholder = 'Note du pin'; pinInput.setAttribute('aria-label', 'Note du pin');
const pinDelete = el('pinPopover').querySelector('button')!; pinDelete.textContent = 'Supprimer'; pinDelete.title = 'Supprimer ce pin';

function updateView(): void {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  view = clampView(view, terrain?.width ?? settings.width, w, h);
  const contourWidths = terrainContourWidths(style, view.scale);
  map.style.setProperty('--terrain-contour-width', `${contourWidths.thin}px`);
  map.style.setProperty('--terrain-contour-index-width', `${contourWidths.index}px`);
  map.setAttribute('viewBox', `${view.cx - w / (2 * view.scale)} ${view.cy - h / (2 * view.scale)} ${w / view.scale} ${h / view.scale}`);
  pins.update(view, w, h);
  const sampling = displayedDetail ? `${(displayedDetail.terrain.width / displayedDetail.terrain.resolution).toFixed(2)} m / échantillon` : 'aperçu';
  el('scale').textContent = `${(1 / view.scale).toFixed(1)} m / px · ${sampling}`;
  scheduleDetail();
}
function setView(next: View): void { view = next; updateView(); deferSave(); }
function fit(): void { setView(fitView(terrain?.width ?? settings.width, viewport.clientWidth, viewport.clientHeight)); }
function local(event: MouseEvent | PointerEvent | WheelEvent): [number, number] {
  const bounds = viewport.getBoundingClientRect(); return [event.clientX - bounds.left, event.clientY - bounds.top];
}
function point(event: MouseEvent): [number, number] { const [x, y] = local(event); return screenToWorld(view, viewport.clientWidth, viewport.clientHeight, x, y); }
function zoom(factor: number, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2): void {
  const limited = bounded(view.scale * factor, Math.min(viewport.clientWidth, viewport.clientHeight) / (terrain?.width ?? settings.width) * 0.5, 8) / view.scale;
  setView(zoomAt(view, limited, x, y, viewport.clientWidth, viewport.clientHeight));
}
function showPins(): void {
  el('pinLayer').hidden = !input('showPins').checked;
  if (!input('showPins').checked) el('pinPopover').hidden = true;
}
showPins();

function renderedStatus(): void {
  if (!terrain || terrainGeneration !== generation) return;
  const name = el<HTMLSelectElement>('relief').querySelector<HTMLOptionElement>(`option[value="${settings.relief}"]`)!.textContent;
  const environment = geological(settings.relief) ? ` · alentours ${el<HTMLSelectElement>('environment').querySelector<HTMLOptionElement>(`option[value="${settings.environment ?? 'mixed'}"]`)!.textContent}` : '';
  const detail = displayedDetail ? ` · détail ${displayedDetail.terrain.resolution}² (${(displayedDetail.terrain.width / displayedDetail.terrain.resolution).toFixed(2)} m) · échantillonnage ${detailSamplingMs.toFixed(0)} ms` : '';
  const data = displayedDetail?.terrain ?? terrain;
  const backend = data.backend === 'wasm' ? `CPU Rust${data.backendReason ? ` (${data.backendReason})` : ''}` : 'GPU FP32';
  const generationBackend = terrain.generationBackend === 'gpu-erosion-f32' ? 'érosion GPU FP32' : terrain.generationBackend === 'gpu-noise-all-f32' ? 'tous bruits GPU FP32 + érosion CPU' : terrain.generationBackend === 'gpu-noise-f32' ? 'bruits fins GPU FP32 + érosion CPU' : 'génération CPU';
  const preparation = terrain.prepareMs === undefined ? '' : ` · préparation ${terrain.prepareMs.toFixed(0)} ms (${generationBackend}${terrain.gpuSimulationMs ? `, simulation GPU ${terrain.gpuSimulationMs.toFixed(0)} ms` : ''}${terrain.nativeEnvironmentMs ? `, alentours CPU ${terrain.nativeEnvironmentMs.toFixed(0)} ms` : ''}${terrain.noiseMs ? `, bruits ${terrain.noiseMs.toFixed(0)} ms, suite Rust ${terrain.erosionMs!.toFixed(0)} ms` : ''})${terrain.generationReason ? ` · ${terrain.generationReason}` : ''}`;
  const setup = terrain.gpuSetupMs ? ` · initialisation GPU ${terrain.gpuSetupMs.toFixed(0)} ms` : '';
  const coast = terrain.coastBackend ? ` · littoral + érosion ${terrain.coastBackend === 'gpu-f32' ? 'GPU FP32' : 'CPU Rust'}${terrain.coastMs ? ` ${terrain.coastMs.toFixed(0)} ms` : ''}${terrain.coastReason ? ` (${terrain.coastReason})` : ''}` : '';
  status(`${name}${environment} · ${backend} · carte ${settings.width.toLocaleString('fr-FR')} m · relief ${settings.motifSize.toLocaleString('fr-FR')} m · aperçu ${terrain.resolution}² · ${contourStep && map.dataset.contours === 'true' ? `courbes ${contourStep} m` : 'sans courbes'}${preparation}${coast}${setup} · génération + aperçu ${terrain.generationMs.toFixed(0)} ms${detail} · rendu ${renderingMs.toFixed(0)} ms`);
}
function render(): void {
  if (!terrain) return;
  updateContourControl();
  const start = performance.now(), scene = renderRustTerrain(terrain, style, true, settings);
  map.innerHTML = `<g id="terrainOverview">${scene.svg}</g><g id="terrainDetail"></g>`;
  contourStep = scene.contourStep; renderingMs = performance.now() - start;
  displayedDetail = undefined;
  viewport.style.background = style === 'parchment' ? '#f1f0e9' : '#e7e8e2';
  updateView(); renderedStatus();
}
function regionForView(): TerrainRegion {
  const width = settings.width;
  const desired = Math.max(viewport.clientWidth, viewport.clientHeight) / view.scale * 1.3;
  // A small scale/position lattice reuses sampled regions during gentle pans.
  const extent = Math.min(width, Math.max(1, 2 ** (Math.ceil(Math.log2(Math.max(1, desired)) * 4) / 4)));
  const step = extent / 32;
  const x = bounded(Math.round((view.cx - extent / 2) / step) * step, 0, width - extent);
  const y = bounded(Math.round((view.cy - extent / 2) / step) * step, 0, width - extent);
  return { x, y, extent, resolution: 768 };
}
function detailKey(region: TerrainRegion): string { return `${generation}:${region.x}:${region.y}:${region.extent}:${region.resolution}:${style}`; }
async function applyDetail(tile: DetailTile): Promise<void> {
  try { await tile.ready; }
  catch {
    if (tile.key === detailKey(regionForView())) status('Erreur du décodage de l’image détaillée.', true);
    return;
  }
  if (terrainGeneration !== generation || tile.key !== detailKey(regionForView()) || displayedDetail?.key === tile.key) return;
  const layer = document.getElementById('terrainDetail'); if (!layer) return;
  const previous = Array.from(layer.children);
  const next = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  next.setAttribute('transform', `translate(${tile.terrain.x},${tile.terrain.y})`);
  next.style.opacity = '0'; next.innerHTML = tile.scene.svg;
  const raster = next.querySelector('image')!;
  const loaded = new Promise<void>((resolve, reject) => {
    raster.addEventListener('load', () => resolve(), { once: true });
    raster.addEventListener('error', () => reject(new Error('Image SVG indisponible')), { once: true });
  });
  layer.append(next);
  try { await loaded; }
  catch { next.remove(); return; }
  // Keep the current tile while the SVG image enters the browser's paint tree.
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  if (!next.isConnected) return;
  if (tile.key !== detailKey(regionForView()) || terrainGeneration !== generation) { next.remove(); return; }
  next.style.opacity = '1';
  const fade = next.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
  const cleanup = (): void => { previous.forEach(node => node.remove()); };
  void fade.finished.then(cleanup, cleanup);
  displayedDetail = tile; detailSamplingMs = tile.terrain.generationMs;
  // Only replace the regional scene: no fit, new generation or camera callback.
  const sampling = (tile.terrain.width / tile.terrain.resolution).toFixed(2);
  el('scale').textContent = `${(1 / view.scale).toFixed(1)} m / px · ${sampling} m / échantillon`;
  renderedStatus();
}
function cacheDetail(tile: DetailTile): void {
  detailCache.delete(tile.key); detailCache.set(tile.key, tile);
  while (detailCache.size > 6) detailCache.delete(detailCache.keys().next().value!);
}
function scheduleDetail(): void {
  clearTimeout(detailTimer);
  if (!terrain || terrainGeneration !== generation) return;
  const region = regionForView(), key = detailKey(region);
  if (displayedDetail?.key === key || (detailRequest && detailKey(detailRequest.region) === key)) return;
  detailTimer = setTimeout(() => requestDetail(), 120);
}
function requestDetail(): void {
  if (!terrain || terrainGeneration !== generation) return;
  const region = regionForView(), key = detailKey(region), cached = detailCache.get(key);
  if (cached) { cacheDetail(cached); void applyDetail(cached); return; }
  if (detailRequest && detailKey(detailRequest.region) === key) return;
  detailRequest = { id: ++requestId, generation, kind: 'detail', settings, region };
  dispatch(detailRequest);
}
function receive(response: TerrainResponse): void {
  if (response.generation !== generation) return;
  if (response.kind === 'detail') {
    if (!detailRequest || response.id !== detailRequest.id) return;
    const request = detailRequest; detailRequest = undefined;
    if ('error' in response) { status(`Erreur du détail Rust : ${response.error}`, true); return; }
    // The camera can move again while Rust samples the previous region.
    if (detailKey(request.region) !== detailKey(regionForView())) { scheduleDetail(); return; }
    try {
      const start = performance.now();
      const data = response.terrain;
      const scene = renderRustTerrain(data, style, false, settings), image = new Image();
      image.src = scene.imageUrl;
      const tile: DetailTile = {
        terrain: { x: data.x, y: data.y, width: data.width, resolution: data.resolution, generationMs: data.generationMs, backend: data.backend, backendReason: data.backendReason, prepareMs: data.prepareMs, samplingMs: data.samplingMs, gpuSetupMs: data.gpuSetupMs },
        style, scene, image, ready: image.decode(), key: detailKey(request.region),
      };
      renderingMs = performance.now() - start; cacheDetail(tile); void applyDetail(tile);
    } catch (error) { status(`Erreur du rendu détaillé : ${error instanceof Error ? error.message : error}`, true); }
    return;
  }
  if (!overviewRequest || response.id !== overviewRequest.id) return;
  el('generate').removeAttribute('aria-busy');
  if ('error' in response) { status(`Erreur du moteur Rust : ${response.error}`, true); return; }
  const previousWidth = terrain?.width;
  terrain = response.terrain; settings = overviewRequest.settings; terrainGeneration = generation;
  if (previousWidth !== undefined && previousWidth !== terrain.width) view = fitView(terrain.width, viewport.clientWidth, viewport.clientHeight);
  try { render(); save(); } catch (error) { status(`Erreur du rendu : ${error instanceof Error ? error.message : error}`, true); }
}
let worker: Worker | undefined;
async function runOnMain(request: TerrainRequest): Promise<void> {
  const meta = { id: request.id, generation: request.generation, kind: request.kind };
  try { receive({ ...meta, terrain: await sampleRustTerrain(request) }); }
  catch (error) { receive({ ...meta, error: error instanceof Error ? error.message : String(error) }); }
}
function dispatch(request: TerrainRequest): void { if (worker) worker.postMessage(request); else void runOnMain(request); }
try {
  worker = new TerrainWorker(); worker.onmessage = (event: MessageEvent<TerrainResponse>) => receive(event.data);
  worker.onerror = event => {
    event.preventDefault(); worker?.terminate(); worker = undefined;
    const request = terrainGeneration === generation ? detailRequest : overviewRequest;
    if (request) void runOnMain(request);
  };
} catch { worker = undefined; }

function readSettings(): TerrainSettings | undefined {
  const width = Number(input('width').value), motifSize = Number(input('motifSize').value), seed = input('seed').value.trim();
  if (!Number.isFinite(width) || width < 500 || width > 100000 || !seed) {
    status('Saisissez une largeur entre 500 et 100 000 m et une graine.', true); return;
  }
  if (!Number.isFinite(motifSize) || motifSize < 250 || motifSize > 50000) {
    status('Saisissez une échelle du relief entre 250 et 50 000 m.', true); return;
  }
  const relief = el<HTMLSelectElement>('relief').value as TerrainRelief;
  if (!RELIEFS.includes(relief)) { status('Choisissez un relief dans le menu.', true); return; }
  const environment = el<HTMLSelectElement>('environment').value as TerrainEnvironment;
  if (!ENVIRONMENT_RELIEFS.includes(environment)) { status('Choisissez un relief environnant dans le menu.', true); return; }
  return { seed, width, motifSize, relief, environment, coastMask: relief === 'cavern' ? 0 : draftCoastMask, islandMode: el<HTMLSelectElement>('islandMode').value as IslandMode, erosion: Number(input('erosion').value), mountainMix: Number(input('mountainMix').value), resolution: 512, compute: el<HTMLSelectElement>('compute').value as TerrainCompute, generationCompute: el<HTMLSelectElement>('generationCompute').value as TerrainSettings['generationCompute'] };
}
function generate(): void {
  clearTimeout(generationTimer);
  const next = readSettings(); if (!next) return;
  generation++; clearTimeout(detailTimer); detailRequest = undefined; detailCache.clear();
  overviewRequest = { id: ++requestId, generation, kind: 'overview', settings: next, region: { x: 0, y: 0, extent: next.width, resolution: 512 } };
  el('generate').setAttribute('aria-busy', 'true'); status('Génération du terrain en Rust…'); dispatch(overviewRequest);
}
function parameterChanged(): void {
  updateErosionControl(); clearTimeout(generationTimer);
  if (input('auto').checked) generationTimer = setTimeout(generate, 220);
  else status('Paramètres modifiés · cliquez sur Générer pour les appliquer.');
}
for (const id of ['width', 'motifSize', 'relief', 'environment', 'mountainMix', 'erosion', 'seed', 'islandMode']) el(id).addEventListener('input', parameterChanged);
coastButtons.forEach(button => { button.onclick = () => {
  draftCoastMask ^= 1 << (COAST_DIRECTIONS as readonly string[]).indexOf(button.dataset.coast!);
  parameterChanged();
}; });
el('coastAll').onclick = () => { draftCoastMask = draftCoastMask === 255 ? 0 : 255; parameterChanged(); };
el('generate').onclick = generate;
el<HTMLSelectElement>('compute').onchange = generate;
el<HTMLSelectElement>('generationCompute').onchange = generate;
input('auto').onchange = () => { clearTimeout(generationTimer); save(); if (input('auto').checked) generate(); };
el('randomSeed').onclick = () => { input('seed').value = crypto.getRandomValues(new Uint32Array(1))[0].toString(36); generate(); };
el<HTMLSelectElement>('style').onchange = () => {
  style = el<HTMLSelectElement>('style').value as TerrainStyle;
  detailRequest = undefined; render(); save();
};
el('fit').onclick = fit; el('zoomIn').onclick = () => zoom(1.4); el('zoomOut').onclick = () => zoom(1 / 1.4);
el('pinMode').onclick = () => { pinMode = !pinMode; el('pinMode').setAttribute('aria-pressed', String(pinMode)); viewport.classList.toggle('pin-mode', pinMode); };
input('showPins').onchange = () => { showPins(); save(); };
input('showContours').onchange = () => { updateContourControl(); renderedStatus(); save(); };

function link(): string { save(); const url = new URL(location.href); url.search = shareQuery(); return url.href; }
async function copy(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); status('Copié : terrain, paramètres, pins et vue.'); }
  catch { window.prompt('Copier', text); }
}
el('copy').onclick = () => void copy(link());
el('copyReport').onclick = () => {
  const erosion = settings.relief === 'cavern' ? 'sans objet (caverne)' : `${Math.round(settings.erosion * 100)} %`;
  const lines = ['Burgmap · prototype terrain Rust/WASM v2', link(), '', `Graine : ${settings.seed}`, `Largeur carte : ${settings.width} m · échelle relief : ${settings.motifSize} m · relief : ${settings.relief} · érosion : ${erosion}`, `Rendu : ${style} · vue : ${viewToString(view)}`, '', ...pins.pins.map((pin, i) => `Pin ${i + 1} : ${pin.x.toFixed(1)}, ${pin.y.toFixed(1)} m — ${pin.note || '(sans note)'}`)];
  if (geological(settings.relief)) lines.splice(5, 0, `Relief environnant : ${settings.environment ?? 'mixed'}`);
  lines.push(`Courbes de niveau : ${map.dataset.contours === 'true' ? 'visibles' : 'masquées'}`);
  if (settings.coastMask) lines.push(`Côtes : ${COAST_DIRECTIONS.filter((_, i) => settings.coastMask! & (1 << i)).join(', ')} · îles : ${settings.islandMode}`);
  if (terrain) lines.push('', `Source physique : 1024² · aperçu : ${terrain.resolution}² · génération : ${terrain.generationMs.toFixed(1)} ms · rendu : ${renderingMs.toFixed(1)} ms`);
  if (displayedDetail) lines.push(`Région détaillée : ${displayedDetail.terrain.x}, ${displayedDetail.terrain.y}, ${displayedDetail.terrain.width} m · ${displayedDetail.terrain.resolution}² · échantillonnage : ${detailSamplingMs.toFixed(1)} ms`);
  void copy(lines.join('\n'));
};

const pointers = new Map<number, [number, number]>();
let dragging = false, moved = false;
const gesture = (): { mid: [number, number]; distance: number } => { const [a, b] = [...pointers.values()]; return { mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], distance: Math.hypot(a[0] - b[0], a[1] - b[1]) }; };
map.addEventListener('pointerdown', event => {
  if (event.button !== 0 || pinMode || event.altKey) return;
  if (!pointers.size) moved = false;
  pointers.set(event.pointerId, local(event)); map.setPointerCapture(event.pointerId); dragging = true; map.classList.add('drag');
});
map.addEventListener('pointermove', event => {
  const [wx, wy] = point(event);
  el('coordinates').textContent = `x ${wx.toFixed(1)} · y ${wy.toFixed(1)} m`;
  const previous = pointers.get(event.pointerId); if (!previous) return;
  const current = local(event), oldGesture = pointers.size === 2 ? gesture() : undefined;
  const dx = current[0] - previous[0], dy = current[1] - previous[1];
  moved ||= Math.abs(dx) + Math.abs(dy) > 1;
  pointers.set(event.pointerId, current);
  if (oldGesture) {
    const next = gesture(); setView(panBy(view, next.mid[0] - oldGesture.mid[0], next.mid[1] - oldGesture.mid[1]));
    if (oldGesture.distance > 0 && next.distance > 0) zoom(next.distance / oldGesture.distance, next.mid[0], next.mid[1]);
  } else setView(panBy(view, dx, dy));
});
const stopDrag = (event: PointerEvent): void => { pointers.delete(event.pointerId); dragging = pointers.size > 0; if (!dragging) map.classList.remove('drag'); };
map.addEventListener('pointerup', stopDrag); map.addEventListener('pointercancel', stopDrag);
map.addEventListener('click', event => {
  if (moved) { moved = false; return; }
  if (!terrain || !(pinMode || event.altKey)) return;
  const [x, y] = point(event); if (x < 0 || y < 0 || x > terrain.width || y > terrain.width) return;
  input('showPins').checked = true; showPins(); pins.add(x, y);
});
map.addEventListener('wheel', event => {
  event.preventDefault(); const [x, y] = local(event);
  const dy = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
  zoom(Math.exp(-bounded(dy, -1000, 1000) * 0.0015), x, y);
}, { passive: false });
map.addEventListener('dblclick', event => { if (!pinMode && !event.altKey) { const [x, y] = local(event); zoom(event.shiftKey ? 0.5 : 2, x, y); } });
window.addEventListener('keydown', event => {
  if ((event.target as HTMLElement).closest('input,select,textarea,button')) return;
  if (event.key === '+' || event.key === '=') zoom(1.4);
  else if (event.key === '-' || event.key === '_') zoom(1 / 1.4);
  else if (event.key === '0') fit();
  else return;
  event.preventDefault();
});
new ResizeObserver(updateView).observe(viewport);
updateView(); generate();
