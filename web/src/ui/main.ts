import { Options, SIZE_PRESETS, DEFAULT_ROADS, fromQuery, toQuery } from '../gen/options';
import { generate } from '../gen/pipeline';
import { renderSvg } from '../render/svg';
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
const cultureEl = $<HTMLSelectElement>('culture');
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
fill(cultureEl, [['european-organic', 'Medieval organic'], ['bastide', 'Bastide (planned grid)']], opts.culture);
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
    culture: cultureEl.value as Options['culture'],
    contours: contoursEl.checked,
    landuse: landuseEl.checked,
    roads: Number(roadsEl.value),
  };
  roadsEl.options[0].textContent = `Auto (${DEFAULT_ROADS[opts.size]})`;
  history.replaceState(null, '', '?' + toQuery(opts));
  schedule();
}
for (const el of [seedEl, sizeEl, reliefEl, coastEl, riverEl, styleEl, cultureEl, contoursEl, landuseEl, roadsEl]) {
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
let currentSvg = '';

function show(svg: string, stats: Record<string, number | string>, ms: number): void {
  currentSvg = svg;
  stage.innerHTML = svg;
  busyEl.classList.remove('on');
  const seaPct = Math.round(Number(stats.seaFraction ?? 0) * 100);
  statusEl.textContent = `${ms} ms total (terrain ${stats['ms.terrain']} ms) - ${stats.rivers} rivers, ${stats.lakes} lakes, sea ${seaPct}% - ${stats.roads ?? 0} roads, ${stats.bridges ?? 0} bridges, ${stats['landuse.furlongs'] ?? 0} furlongs - ${stats['urban.archetype'] ?? ''} pop ${stats['urban.pop'] ?? 0}: ${stats['urban.blocks'] ?? 0} blocks, ${stats['urban.plots'] ?? 0} plots, ${stats['urban.buildings'] ?? 0} buildings (urban ${stats['ms.urban'] ?? 0} ms)`;
}

if (worker) {
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const r = e.data;
    if (r.id !== reqId) return;
    if (r.error) { busyEl.classList.remove('on'); statusEl.textContent = 'Error: ' + r.error.split('\n')[0]; console.error(r.error); return; }
    show(r.svg!, r.stats!, r.ms!);
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
      const svg = renderSvg(world, { style: opts.style });
      show(svg, world.stats, Math.round(performance.now() - t0));
    }, 10);
  }
}
function schedule(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(run, 180);
}

// ---------- viewer: wheel zoom toward cursor + drag pan ----------
const map = $('map');
const stage = $('stage');
let scale = 1, tx = 0, ty = 0, base = 600;

function apply(): void { stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; }
function fit(): void {
  const r = map.getBoundingClientRect();
  base = Math.max(200, Math.min(r.width, r.height) - 24);
  stage.style.width = base + 'px'; stage.style.height = base + 'px';
  scale = 1; tx = (r.width - base) / 2; ty = (r.height - base) / 2;
  apply();
}
window.addEventListener('resize', fit);
fit();
map.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = map.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const k = Math.exp(-e.deltaY * 0.0015);
  const ns = Math.max(0.3, Math.min(30, scale * k));
  const f = ns / scale;
  tx = mx - (mx - tx) * f; ty = my - (my - ty) * f; scale = ns;
  apply();
}, { passive: false });
let drag: { x: number; y: number; tx: number; ty: number } | null = null;
map.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, tx, ty };
  map.setPointerCapture(e.pointerId);
  map.classList.add('drag');
});
map.addEventListener('pointermove', (e) => {
  if (!drag) return;
  tx = drag.tx + e.clientX - drag.x; ty = drag.ty + e.clientY - drag.y;
  apply();
});
const endDrag = () => { drag = null; map.classList.remove('drag'); };
map.addEventListener('pointerup', endDrag);
map.addEventListener('pointercancel', endDrag);
map.addEventListener('dblclick', fit);

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
  if (currentSvg) download(new Blob([currentSvg], { type: 'image/svg+xml' }), fname() + '.svg');
});
$('exportPng').addEventListener('click', () => {
  if (!currentSvg) return;
  const img = new Image();
  const url = URL.createObjectURL(new Blob([currentSvg], { type: 'image/svg+xml' }));
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
