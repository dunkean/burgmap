/**
 * Settlement-system controls (M3c): map extent (preset or custom meters), population (log slider + number) and the
 * secondary settlements (auto / none / counts per class / an editable list with click-on-map placement).
 * Everything goes through the control registry, so the URL, history and regeneration follow like any other option.
 */
import type { Options, SettlementsOpt, SettlementSpec, CountClass, SiteArchetype } from '../gen/options';
import { COUNT_CLASSES, SITE_ARCHETYPES, mapSizeOf, MAP_SIZE_MIN, MAP_SIZE_MAX, POP_MIN, POP_MAX, settlementsToString, classOfPop } from '../gen/options';
import { CULTURE_LIST } from '../gen/urban/cultures';
import type { ControlRegistry } from './controls';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
};
const fire = (target: HTMLElement): void => { target.dispatchEvent(new Event('change', { bubbles: true })); };

const LOG_LO = Math.log10(POP_MIN), LOG_HI = Math.log10(POP_MAX);
const sliderToPop = (t: number): number => {
  const p = Math.pow(10, LOG_LO + (t / 1000) * (LOG_HI - LOG_LO));
  const mag = Math.pow(10, Math.max(0, Math.floor(Math.log10(p)) - 1));
  return Math.round(p / mag) * mag;
};
const popToSlider = (p: number): number => Math.round(((Math.log10(Math.max(POP_MIN, p)) - LOG_LO) / (LOG_HI - LOG_LO)) * 1000);

const CLASS_LABEL: Record<CountClass, string> = { city: 'Cities', town: 'Towns', village: 'Villages', hamlet: 'Hamlets', farmstead: 'Farmsteads' };

export interface SettlementsUI {
  /** Row index waiting for a map click (list mode), or null. */
  readonly picking: number | null;
  /** A map click while picking: sets that row's position (meters). */
  place(p: { x: number; y: number }): void;
  cancelPick(): void;
}

export function initSettlementsUI(registry: ControlRegistry, getOpts: () => Options): SettlementsUI {
  const sizeEl = document.getElementById('size') as HTMLSelectElement;
  const popEl = document.getElementById('population') as HTMLInputElement;
  popEl.max = String(POP_MAX);
  const roadsEl = document.getElementById('roads') as HTMLSelectElement;
  const body = sizeEl.parentElement!;

  // ---- map size: the presets + "custom" with a number of meters
  const custom = el('option', { value: 'custom' }, 'Custom extent...');
  sizeEl.appendChild(custom);
  const sizeWrap = el('div', { id: 'sizeWrap' });
  body.insertBefore(sizeWrap, sizeEl);
  sizeWrap.appendChild(sizeEl);
  const msRow = el('div', { id: 'mapSizeRow' });
  msRow.append(el('label', { for: 'mapSize' }, `Map extent (m, ${MAP_SIZE_MIN} - ${MAP_SIZE_MAX})`));
  const msEl = el('input', { id: 'mapSize', type: 'number', min: String(MAP_SIZE_MIN), max: String(MAP_SIZE_MAX), step: '100' });
  msRow.appendChild(msEl);
  sizeWrap.appendChild(msRow);
  registry.add({
    el: sizeWrap, live: false,
    read: (o) => {
      if (sizeEl.value === 'custom') {
        const v = Number(msEl.value);
        return { ...o, mapSize: Number.isFinite(v) && v > 0 ? Math.max(MAP_SIZE_MIN, Math.min(MAP_SIZE_MAX, Math.round(v))) : mapSizeOf(o) };
      }
      return { ...o, size: sizeEl.value as Options['size'], mapSize: undefined };
    },
    write: (o) => {
      const isCustom = o.mapSize !== undefined;
      sizeEl.value = isCustom ? 'custom' : o.size;
      msRow.hidden = !isCustom;
      if (document.activeElement !== msEl) msEl.value = String(mapSizeOf(o));
    },
  });

  // ---- population: log slider next to the number field (0 in the field = automatic)
  const slider = el('input', { id: 'popSlider', type: 'range', min: '0', max: '1000', step: '1', style: 'width:100%;margin-top:4px', title: 'Population (log scale)' });
  const popInfo = el('div', { class: 'hint', id: 'popInfo' });
  popEl.insertAdjacentElement('afterend', slider);
  slider.insertAdjacentElement('afterend', popInfo);
  const showPopInfo = (p: number): void => { popInfo.textContent = p > 0 ? `${p.toLocaleString('en')} inhabitants: ${classOfPop(p)}` : 'automatic (from the size preset)'; };
  slider.addEventListener('input', () => { const p = sliderToPop(Number(slider.value)); popEl.value = String(p); showPopInfo(p); });
  slider.addEventListener('change', () => fire(popEl));
  popEl.addEventListener('input', () => { const p = Number(popEl.value) || 0; if (p > 0) slider.value = String(popToSlider(p)); showPopInfo(p); });
  // keep the slider in sync when the options change from elsewhere (URL, history)
  const syncPop = (o: Options): void => { if (o.population > 0) slider.value = String(popToSlider(o.population)); showPopInfo(o.population); };

  // ---- settlements: auto / none / counts / list
  const box = el('div', { id: 'settlementsBox' });
  roadsEl.insertAdjacentElement('afterend', box);
  box.append(el('label', { for: 'settlMode' }, 'Other settlements'));
  const mode = el('select', { id: 'settlMode' });
  for (const [v, t] of [['auto', 'Automatic (from the map area)'], ['none', 'None (main settlement only)'], ['counts', 'Counts per class'], ['list', 'List (one by one)']]) mode.appendChild(el('option', { value: v }, t));
  box.appendChild(mode);
  const countsBox = el('div', { id: 'settlCounts', style: 'display:grid;grid-template-columns:1fr 70px;gap:4px 8px;align-items:center;margin-top:6px' });
  const countEls = {} as Record<CountClass, HTMLInputElement>;
  for (const c of COUNT_CLASSES) {
    const lab = el('span', { style: 'font-size:12px' }, CLASS_LABEL[c]);
    const inp = el('input', { type: 'number', min: '0', max: '2000', step: '1', id: 'count-' + c });
    inp.value = '0';
    countEls[c] = inp;
    countsBox.append(lab, inp);
  }
  box.appendChild(countsBox);
  const listBox = el('div', { id: 'settlList', style: 'margin-top:6px;display:flex;flex-direction:column;gap:6px' });
  const rowsEl = el('div', { style: 'display:flex;flex-direction:column;gap:6px' });
  const addBtn = el('button', { class: 'secondary small', id: 'settlAdd', type: 'button' }, '+ Add settlement');
  const pickHint = el('div', { class: 'hint', id: 'pickHint' });
  listBox.append(rowsEl, addBtn, pickHint);
  box.appendChild(listBox);
  const warnEl = el('div', { class: 'hint', id: 'settlWarn' });
  box.appendChild(warnEl);

  let rows: SettlementSpec[] = [];
  let picking: number | null = null;
  const setPicking = (k: number | null): void => {
    picking = k;
    pickHint.textContent = k === null ? '' : `Click on the map to place settlement ${k + 1} (Esc to cancel)`;
    document.getElementById('map')?.classList.toggle('picking', k !== null);
    renderRows();
  };
  const cultureItems: [string, string][] = [['', 'Main culture'], ...CULTURE_LIST.map((c) => [c.id, c.fantasy ? `${c.label} (fantasy)` : c.label] as [string, string])];
  const siteItems: [string, string][] = [['', 'Any site'], ...SITE_ARCHETYPES.map((a) => [a, a] as [string, string])];
  function renderRows(): void {
    rowsEl.textContent = '';
    rows.forEach((it, k) => {
      const r = el('div', { class: 'settl-row', style: 'border:1px solid var(--line);border-radius:4px;padding:5px;display:grid;grid-template-columns:1fr 1fr;gap:4px' });
      const pop = el('input', { type: 'number', min: String(POP_MIN), max: String(POP_MAX), step: '10', title: 'Population', 'data-k': String(k), 'data-f': 'population' });
      pop.value = String(it.population);
      const cu = el('select', { title: 'Culture', 'data-k': String(k), 'data-f': 'culture' });
      for (const [v, t] of cultureItems) cu.appendChild(el('option', { value: v }, t));
      cu.value = it.culture ?? '';
      const st = el('select', { title: 'Site type', 'data-k': String(k), 'data-f': 'siteType' });
      for (const [v, t] of siteItems) st.appendChild(el('option', { value: v }, t));
      st.value = it.siteType ?? '';
      const posB = el('button', { type: 'button', class: 'secondary small', title: 'Click, then click on the map to fix the position' }, picking === k ? 'Click the map...' : it.position ? `@ ${Math.round(it.position.x)}, ${Math.round(it.position.y)}` : 'Place on map');
      posB.addEventListener('click', () => setPicking(picking === k ? null : k));
      const clr = el('button', { type: 'button', class: 'secondary small', title: 'Automatic position' }, 'Auto pos.');
      clr.disabled = !it.position;
      clr.addEventListener('click', () => { rows[k] = { ...rows[k], position: undefined }; renderRows(); fire(box); });
      const rm = el('button', { type: 'button', class: 'secondary small', title: 'Remove' }, 'Remove');
      rm.addEventListener('click', () => { rows.splice(k, 1); if (picking !== null) picking = null; renderRows(); fire(box); });
      const head = el('div', { style: 'grid-column:1 / span 2;font-size:11px;color:var(--ink2)' }, `#${k + 1} - ${classOfPop(it.population)}`);
      r.append(head, pop, cu, st, posB, clr, rm);
      rowsEl.appendChild(r);
    });
  }
  // field edits inside the rows
  rowsEl.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const k = Number(t.dataset.k), f = t.dataset.f;
    if (!Number.isFinite(k) || !rows[k] || !f) return;
    if (f === 'population') { const v = Number(t.value); if (Number.isFinite(v) && v > 0) rows[k] = { ...rows[k], population: Math.max(POP_MIN, Math.min(POP_MAX, Math.round(v))) }; }
    else if (f === 'culture') rows[k] = { ...rows[k], culture: t.value || undefined };
    else if (f === 'siteType') rows[k] = { ...rows[k], siteType: (t.value || undefined) as SiteArchetype | undefined };
  });
  addBtn.addEventListener('click', () => { rows.push({ population: rows.length ? 120 : 300 }); renderRows(); fire(box); });
  const showMode = (): void => { countsBox.style.display = mode.value === 'counts' ? 'grid' : 'none'; listBox.style.display = mode.value === 'list' ? 'flex' : 'none'; };
  mode.addEventListener('change', () => {
    if (mode.value === 'list' && !rows.length) rows = [{ population: 300 }, { population: 80 }];
    if (mode.value === 'counts' && COUNT_CLASSES.every((c) => Number(countEls[c].value) === 0)) { countEls.village.value = '4'; countEls.hamlet.value = '4'; countEls.farmstead.value = '6'; }
    renderRows(); showMode();
  });
  const readSettl = (): SettlementsOpt => {
    if (mode.value === 'none') return 'none';
    if (mode.value === 'counts') {
      const counts = { city: 0, town: 0, village: 0, hamlet: 0, farmstead: 0 };
      for (const c of COUNT_CLASSES) counts[c] = Math.max(0, Math.min(2000, Math.round(Number(countEls[c].value) || 0)));
      return { counts };
    }
    if (mode.value === 'list') return { list: rows.map((r) => ({ ...r })) };
    return 'auto';
  };
  registry.add({
    el: box,
    read: (o) => ({ ...o, settlements: readSettl() }),
    write: (o) => {
      const s = o.settlements ?? 'auto';
      // do not rebuild the rows under the user's fingers when nothing changed
      if (settlementsToString(s) === settlementsToString(readSettl()) && mode.value === (typeof s === 'string' ? s : 'counts' in s ? 'counts' : 'list')) { showMode(); return; }
      if (typeof s === 'string') mode.value = s;
      else if ('counts' in s) { mode.value = 'counts'; for (const c of COUNT_CLASSES) countEls[c].value = String(s.counts[c] ?? 0); }
      else { mode.value = 'list'; rows = s.list.map((r) => ({ ...r })); }
      renderRows(); showMode();
    },
  });
  // the population slider follows the options too (a passive control)
  registry.add({ el: slider, read: (o) => o, write: (o) => syncPop(o) });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && picking !== null) setPicking(null); });
  showMode();
  void getOpts;

  return {
    get picking() { return picking; },
    place(p) {
      if (picking === null || !rows[picking]) return;
      rows[picking] = { ...rows[picking], position: { x: Math.round(p.x), y: Math.round(p.y) } };
      setPicking(null);
      fire(box);
    },
    cancelPick() { setPicking(null); },
  };
}

/** Show the planner's warnings (stats) under the settlement controls. */
export function showSettlementWarnings(stats: Record<string, number | string>): void {
  const w = document.getElementById('settlWarn');
  if (!w) return;
  const n = Number(stats['settlements'] ?? 0);
  const warn = String(stats['settlements.warning'] ?? '');
  const lazy = Number(stats['settlements.lazy'] ?? 0);
  w.textContent = (n > 1 ? `${n} settlements, ${Number(stats['settlements.pop'] ?? 0).toLocaleString('en')} inhabitants${lazy ? ` (${lazy} drawn in detail when you zoom in)` : ''}. ` : '') + (warn ? 'Warning: ' + warn : '');
  w.classList.toggle('warn', !!warn);
}
