import { Options, SIZE_PRESETS, DEFAULT_ROADS, fromQuery, toQuery } from '../gen/options';
import { generate } from '../gen/pipeline';
import { renderSvg } from '../render/svg';
// CANVAS-VIEWER (begin imports)
import { createCanvasRenderer } from '../render/canvas';
import { createViewer } from './viewer';
import type { World } from '../gen/types';
// CANVAS-VIEWER (end imports)
import GenWorker from './worker?worker&inline';
import type { WorkerResponse } from './worker';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let opts: Options = fromQuery(location.search);

// ---------- controls ----------
function fill(sel: HTMLSelectElement, items: [string, string][], value: string): void {
  sel.innerHTML = '';
  for (const [v, label] of items) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = value;
}
const seedEl = $<HTMLInputElement>('seed');
const sizeEl = $<HTMLSelectElement>('size');
const reliefEl = $<HTMLSelectElement>('relief');
const coastEl = $<HTMLSelectElement>('coast');
const riverEl = $<HTMLSelectElement>('river');
const styleEl = $<HTMLSelectElement>('style');
const contoursEl = $<HTMLInputElement>('contours');
const landuseEl = $<HTMLInputElement>('landuse');
const roadsEl = $<HTMLSelectElement>('roads');
const statusEl = $('status');
const busyEl = $('busy');

fill(sizeEl, Object.entries(SIZE_PRESETS).map(([k, v]) => [k, `${v.label} (${v.mapSize} m)`]), opts.size);
fill(reliefEl, [['flat', 'Flat'], ['hills', 'Rolling hills'], ['valley', 'Valley'], ['mountains', 'Mountains']], opts.relief);
fill(coastEl, [['none', 'None'], ['random', 'Random side'], ['N', 'North'], ['E', 'East'], ['S', 'South'], ['W', 'West']], opts.coast);
fill(riverEl, [['none', 'None'], ['stream', 'Stream'], ['river', 'River'], ['major', 'Major river']], opts.river);
fill(roadsEl, [['0', `Auto (${DEFAULT_ROADS[opts.size]})`], ...[1, 2, 3, 4, 5, 6, 7, 8].map((k) => [String(k), String(k)] as [string, string])], String(opts.roads));
fill(styleEl, [['parchment', 'Parchment'], ['atlas', 'Atlas']], opts.style);
seedEl.value = opts.seed;
contoursEl.checked = opts.contours;
landuseEl.checked = opts.landuse;

function readControls(): void {
  opts = {
    ...opts,
    seed: seedEl.value || '1',
    size: sizeEl.value as Options['size'],
    relief: reliefEl.value as Options['relief'],
    coast: coastEl.value as Options['coast'],
    river: riverEl.value as Options['river'],
    style: styleEl.value as Options['style'],
    contours: contoursEl.checked,
    landuse: landuseEl.checked,
    roads: Number(roadsEl.value),
  };
  roadsEl.options[0].textContent = `Auto (${DEFAULT_ROADS[opts.size]})`;
  history.replaceState(null, '', '?' + toQuery(opts));
  schedule();
}
for (const el of [seedEl, sizeEl, reliefEl, coastEl, riverEl, styleEl, contoursEl, landuseEl, roadsEl]) {
  el.addEventListener('input', readControls);
  el.addEventListener('change', readControls);
}
$('dice').addEventListener('click', () => {
  seedEl.value = Math.random().toString(36).slice(2, 8);
  readControls();
});

// ---------- generation (worker with main-thread fallback) ----------
let worker: Worker | null = null;
try { worker = new GenWorker(); } catch { worker = null; }
let reqId = 0;
let timer: number | undefined;
// CANVAS-VIEWER (begin show)
let currentWorld: World | null = null;
const currentSvg = (): string => (currentWorld ? renderSvg(currentWorld, { style: opts.style }) : '');

function show(world: World, stats: Record<string, number | string>, ms: number): void {
  currentWorld = world;
  viewer.setRenderer(createCanvasRenderer(canvasEl, world, opts.style), world.mapSize, true);
// CANVAS-VIEWER (end show)
  busyEl.classList.remove('on');
  const seaPct = Math.round(Number(stats.seaFraction ?? 0) * 100);
  statusEl.textContent = `${ms} ms total (terrain ${stats['ms.terrain']} ms) - ${stats.rivers} rivers, ${stats.lakes} lakes, sea ${seaPct}% - ${stats.roads ?? 0} roads, ${stats.bridges ?? 0} bridges, ${stats['landuse.furlongs'] ?? 0} furlongs`;
}

if (worker) {
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const r = e.data;
    if (r.id !== reqId) return;
    if (r.error) { busyEl.classList.remove('on'); statusEl.textContent = 'Error: ' + r.error.split('\n')[0]; console.error(r.error); return; }
    show(r.world!, r.stats!, r.ms!);
  };
  worker.onerror = (e) => { console.error(e); worker = null; run(); };
}

function run(): void {
  const id = ++reqId;
  busyEl.classList.add('on');
  if (worker) {
    worker.postMessage({ id, options: opts });
  } else {
    setTimeout(() => {
      if (id !== reqId) return;
      const t0 = performance.now();
      const world = generate(opts);
      show(world, world.stats, Math.round(performance.now() - t0));
    }, 10);
  }
}
function schedule(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(run, 180);
}

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
// CANVAS-VIEWER (end viewer)

// ---------- export ----------
function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const fname = () => `burgmap-${opts.seed}-${opts.size}`;
$('exportSvg').addEventListener('click', () => {
  if (currentWorld) download(new Blob([currentSvg()], { type: 'image/svg+xml' }), fname() + '.svg');
});
$('exportPng').addEventListener('click', () => {
  if (!currentWorld) return;
  const img = new Image();
  const url = URL.createObjectURL(new Blob([currentSvg()], { type: 'image/svg+xml' }));
  img.onload = () => {
    const S = 3000;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    c.getContext('2d')!.drawImage(img, 0, 0, S, S);
    URL.revokeObjectURL(url);
    c.toBlob((b) => { if (b) download(b, fname() + '.png'); }, 'image/png');
  };
  img.onerror = () => { statusEl.textContent = 'PNG export failed'; URL.revokeObjectURL(url); };
  img.src = url;
});

history.replaceState(null, '', '?' + toQuery(opts));
run();
