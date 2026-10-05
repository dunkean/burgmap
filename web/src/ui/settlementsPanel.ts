/**
 * The Settlements tab. Controls remain a draft until "Apply & generate".
 *
 * - "General": the theme culture, the place-name language and the default layout every place inherits.
 * - "Generate automatically": a target population; the region's places (town, villages, hamlets, farms) are
 *   generated and listed. Touching one takes the region over as an editable list (same keys, so the same map).
 * - "Places": one card per place (name, population, culture or a mix / growth plan, position by site or by click).
 *   Places are added one by one, renamed, placed or dragged on the map, and deleted. The first one is the main town.
 * The single shared editor is moved into the selected card, so what it edits is always visible.
 */
import type { Options, SettlementSpec, SettlementOverrides } from '../gen/options';
import { SETTLEMENT_OVERRIDE_KEYS, optionsForSettlement, mapSizeOf, MAP_SIZE_MIN, MAP_SIZE_MAX, POP_MIN, POP_MAX, classOfPop, sizeForPop, cleanSettlementName } from '../gen/options';
import { CULTURE_LIST } from '../gen/urban/cultures';
import type { ControlRegistry } from './controls';
import { appendSettlementDraft, regionAsList, settlementComposition, type GeneratedPlace } from './workflowDraft';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) e.setAttribute(key, value);
  if (text !== undefined) e.textContent = text;
  return e;
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const defaultValue = (key: string, value: unknown): unknown => value ?? (key === 'sprawl' ? 1 : key === 'cultureMix' || key === 'plan' ? null : key === 'sitePrefs' ? undefined : key === 'size' ? undefined : key === 'roads' ? 0 : 'auto');
const copy = <T>(value: T): T => structuredClone(value);
const listOf = (o: Options): SettlementSpec[] => o.settlements && typeof o.settlements === 'object' && 'list' in o.settlements ? o.settlements.list : [];
const cultureLabel = (id: string): string => CULTURE_LIST.find((c) => c.id === id)?.label ?? id;
const ICON_PIN = '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';
const ICON_DEL = '<svg class="ico" viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>';

/** -1: the general theme; 0+: a place (0 is the main town). */
export type SettlementTarget = number;
export interface SettlementMarker { target: SettlementTarget; badge: string; name: string; explicit: boolean; pos?: { x: number; y: number }; selected: boolean }

export interface SettlementsUI {
  readonly picking: number | null;
  readonly mode: 'automatic' | 'list';
  editorOptions(o: Options): Options;
  capture(input: Options, base: Options): Options;
  load(o: Options): void;
  composition(o: Options): Options;
  place(p: { x: number; y: number }): void;
  cancelPick(): void;
  /** Select a place in the panel (marker click). */
  select(target: SettlementTarget): void;
  /** Set a place's position in the draft (marker drag). */
  move(target: SettlementTarget, p: { x: number; y: number }): void;
  /** The places as map markers: their chosen position, or where the displayed map put them. */
  markers(o: Options): SettlementMarker[];
  /** The displayed map changed: refresh the generated places, names and positions. */
  refresh(): void;
}

export interface Generated {
  /** The places of the displayed map, main town first ('main', then 'village:0', ...). */
  all(): (GeneratedPlace & { cls: string })[];
}

export function initSettlementsUI(registry: ControlRegistry, getOpts: () => Options, changeEditor: (change: (o: Options) => Options) => void,
  onPicking: (active: boolean) => void = () => undefined, generated: Generated = { all: () => [] }, onGenerate: () => void = () => undefined): SettlementsUI {
  const modeEl = document.getElementById('settlMode') as HTMLSelectElement;
  const choices = document.getElementById('settlementChoices')!;
  const actions = document.getElementById('compositionActions')!;
  const heading = document.getElementById('settlementEditorHeading')!;
  const editor = document.getElementById('settlementEditor')!;
  const themeCard = document.getElementById('themeCard')!;
  const themeSlot = document.getElementById('themeSlot')!;
  const themeSummary = document.getElementById('themeSummary')!;
  const themeHint = document.getElementById('themeHint')!;
  const placesTitle = document.getElementById('placesTitle')!;
  const themeButton = document.getElementById('editTheme') as HTMLButtonElement;
  const autoPop = document.getElementById('autoPop') as HTMLInputElement;
  const autoGenerate = document.getElementById('autoGenerate') as HTMLButtonElement;
  const nameRow = document.getElementById('nameRow')!;
  const nameEl = document.getElementById('settlName') as HTMLInputElement;
  const kindRow = document.getElementById('kindRow')!;
  const langRow = document.getElementById('langRow')!;
  const siteCell = document.getElementById('siteCell')!;
  const resetButton = document.getElementById('inheritTheme') as HTMLButtonElement;
  const removeButton = document.getElementById('settlRemove') as HTMLButtonElement;
  const clearButton = document.getElementById('settlClear') as HTMLButtonElement;
  const sizeEl = document.getElementById('size') as HTMLSelectElement;
  const popEl = document.getElementById('population') as HTMLInputElement;
  const msEl = document.getElementById('mapSize') as HTMLInputElement;
  const positionBox = document.getElementById('positionControls')!;
  const cultureLabelEl = document.querySelector<HTMLLabelElement>('label[for="culture"]')!;
  let mode: 'automatic' | 'list' = 'automatic';
  let selected: SettlementTarget = -1;
  let picking: number | null = null;
  let lastDraft: Options = getOpts();

  registry.add({ el: msEl, live: false,
    read: (o) => ({ ...o, mapSize: msEl.value && Number.isFinite(Number(msEl.value)) ? Math.max(MAP_SIZE_MIN, Math.min(MAP_SIZE_MAX, Math.round(Number(msEl.value)))) : mapSizeOf(o) }),
    write: (o) => { if (document.activeElement !== msEl) msEl.value = String(mapSizeOf(o)); },
  });
  // Type shortcuts adjust population; a custom extent does not silently override the visible type.
  const populations: Record<Options['size'], number> = { hamlet: 80, village: 300, town: 3000, city: 20000, capital: 60000 };
  sizeEl.addEventListener('change', () => {
    const value = Number(popEl.value);
    if (!(value > 0) || sizeForPop(value) !== sizeEl.value) popEl.value = String(populations[sizeEl.value as Options['size']]);
  });
  popEl.addEventListener('change', () => { if (Number(popEl.value) > 0) sizeEl.value = sizeForPop(Number(popEl.value)); });
  popEl.placeholder = 'auto';
  registry.add({ el: sizeEl, read: (o) => ({ ...o, size: sizeEl.value as Options['size'] }), write: (o) => { sizeEl.value = o.size; } });

  // position: automatic (by the chosen site) or a click on the map; coordinates stay editable
  const modeRow = el('div', { class: 'seg' });
  const auto = el('button', { id: 'centerAuto', type: 'button', title: 'Let the generator find the best spot for the chosen site' }, 'Automatic (by site)');
  const pick = el('button', { id: 'centerPick', type: 'button', title: 'Click the map where this place should be' }, 'Click on the map');
  modeRow.append(auto, pick);
  const coords = el('div', { class: 'row' });
  const xEl = el('input', { id: 'centerX', type: 'number', step: '1', placeholder: 'x auto', 'aria-label': 'Selected place x (m)' });
  const yEl = el('input', { id: 'centerY', type: 'number', step: '1', placeholder: 'y auto', 'aria-label': 'Selected place y (m)' });
  coords.append(xEl, yEl);
  const posHint = el('div', { id: 'centerHint', class: 'hint' });
  positionBox.append(el('label', {}, 'Position'), modeRow, siteCell, coords, posHint);
  // The fields show metres; a taken-over place keeps its exact position until its field is really edited.
  const exactOr = (input: HTMLInputElement): number => input.dataset.exact && String(Math.round(Number(input.dataset.exact))) === input.value ? Number(input.dataset.exact) : Number(input.value);
  registry.add({ el: positionBox,
    read: (o) => {
      if (!xEl.value && !yEl.value) return { ...o, center: undefined };
      const x = exactOr(xEl), y = exactOr(yEl);
      return xEl.value && yEl.value && Number.isFinite(x) && Number.isFinite(y) ? { ...o, center: { x, y } } : o;
    },
    write: (o) => {
      xEl.value = o.center ? String(Math.round(o.center.x)) : ''; yEl.value = o.center ? String(Math.round(o.center.y)) : '';
      xEl.dataset.exact = o.center ? String(o.center.x) : ''; yEl.dataset.exact = o.center ? String(o.center.y) : '';
      showPositionMode();
    },
  });
  function showPositionMode(): void {
    const fixed = !!xEl.value || !!yEl.value;
    auto.setAttribute('aria-pressed', String(!fixed && picking === null));
    pick.setAttribute('aria-pressed', String(fixed || picking !== null));
    siteCell.hidden = fixed || picking !== null;
  }
  positionBox.addEventListener('input', showPositionMode);
  positionBox.addEventListener('change', (e) => {
    showPositionMode();
    if (e.target !== xEl && e.target !== yEl) return;
    if (!!xEl.value !== !!yEl.value) { posHint.textContent = 'Enter both coordinates, or clear both for an automatic position.'; }
  });

  function setPicking(value: number | null): void {
    const wasPicking = picking !== null;
    picking = value;
    document.getElementById('map')!.classList.toggle('picking', value !== null);
    pick.textContent = value === null ? 'Click on the map' : 'Click the map… (Esc)';
    posHint.textContent = value === null ? 'Its marker can also be dragged on the map.' : 'Click the landscape where it should be. Esc cancels.';
    showPositionMode();
    if (wasPicking !== (value !== null)) onPicking(value !== null);
  }
  /** Key of a listed place in the generated map. */
  const keyOf = (o: Options, target: SettlementTarget): string => target <= 0 ? 'main' : listOf(o)[target]?.key ?? String(target);
  const generatedPlace = (key: string) => generated.all().find((p) => p.key === key);
  const displayName = (o: Options, target: SettlementTarget): string => {
    const spec = listOf(o)[target];
    return cleanSettlementName(spec?.name) ?? generatedPlace(keyOf(o, target))?.name ?? (target === 0 ? 'Main town' : `Place ${target + 1}`);
  };

  /** One place card; the editor goes inside the selected one. */
  function card(index: number, title: string, meta: string, onOpen: () => void, onPlace: () => void, onDelete: (() => void) | null): HTMLElement {
    const box = el('div', { class: 'card' + (selected === index ? ' sel' : ''), 'data-settlement': String(index) });
    const head = el('div', { class: 'card-head' });
    const main = el('button', { type: 'button', class: 'card-main settlement-choice', 'aria-pressed': String(selected === index), title: 'Edit this place' });
    const badge = el('span', { class: 'badge' }); badge.append(el('span', {}, index === 0 ? '★' : String(index + 1)));
    const txt = el('span', { class: 'txt' }); txt.append(el('b', {}, title), el('small', {}, meta));
    main.append(badge, txt);
    main.addEventListener('click', onOpen);
    const tools = el('span', { class: 'card-tools' });
    const placeBtn = el('button', { type: 'button', class: 'secondary icon', title: 'Place it on the map', 'aria-label': `Place ${title} on the map` });
    placeBtn.innerHTML = ICON_PIN; placeBtn.addEventListener('click', onPlace);
    const delBtn = el('button', { type: 'button', class: 'secondary icon', title: onDelete ? 'Delete' : 'The map keeps at least one place', 'aria-label': `Delete ${title}` });
    delBtn.innerHTML = ICON_DEL; delBtn.disabled = !onDelete;
    if (onDelete) delBtn.addEventListener('click', onDelete);
    tools.append(placeBtn, delBtn);
    head.append(main, tools); box.append(head);
    if (selected === index) { const body = el('div', { class: 'card-body' }); body.append(editor); box.append(body); }
    return box;
  }

  function render(o: Options): void {
    lastDraft = o;
    modeEl.value = mode;
    const specs = listOf(o);
    actions.hidden = false;
    choices.textContent = '';
    const places = generated.all();
    if (mode === 'list') {
      specs.forEach((spec, index) => {
        const settings = optionsForSettlement(o, spec);
        choices.append(card(index, displayName(o, index),
          `${classOfPop(spec.population)} · ${spec.population.toLocaleString('en')} · ${cultureLabel(settings.culture)}${settings.cultureMix ? ' + mix' : ''}${spec.position ? '' : ' · auto'}`,
          () => changeEditor((draft) => { selected = selected === index ? -1 : index; setPicking(null); render(draft); return draft; }),
          () => { changeEditor((draft) => { selected = index; render(draft); return draft; }); setPicking(index); },
          specs.length > 1 ? () => removeAt(index) : null));
      });
    } else {
      // the displayed region, read-only until one place is touched
      places.forEach((p, index) => {
        choices.append(card(index, p.name ?? (index === 0 ? 'Main town' : `Place ${index + 1}`), `${p.cls} · ${p.population.toLocaleString('en')} · ${cultureLabel(o.culture)}`,
          () => takeOver(index), () => { takeOver(index); setPicking(index); }, places.length > 1 ? () => { takeOver(-1); removeAt(index); } : null));
      });
    }
    const count = mode === 'list' ? specs.length : places.length;
    placesTitle.textContent = `Places${count ? ` (${count})` : ''}`;
    // the general card: theme culture, place names and the default layout
    const theme = selected < 0;
    themeCard.classList.toggle('sel', theme);
    themeSlot.hidden = !theme;
    if (theme) themeSlot.append(editor);
    themeSummary.textContent = `${cultureLabel(o.culture)} · names ${o.language && o.language !== 'auto' ? o.language : 'from the culture'}`;
    themeButton.setAttribute('aria-pressed', String(theme));
    themeHint.textContent = mode === 'list'
      ? 'Click a place to edit it, or drag its marker on the map.'
      : count ? 'Generated from the target population. Click a place to edit it: the list becomes yours.' : 'Generate the places automatically, or add them one by one.';
    autoGenerate.textContent = mode === 'list' ? 'Regenerate all' : 'Generate places';
    autoGenerate.title = mode === 'list' ? 'Replace the list by an automatic region around a town of this population' : 'Generate a town of this population with its villages, hamlets and farms';
    if (document.activeElement !== autoPop) autoPop.value = String(o.population > 0 ? o.population : mode === 'list' && specs[0] ? specs[0].population : 3000);
    clearButton.hidden = mode !== 'list' && !count;
    heading.textContent = theme ? 'General' : displayName(o, selected);
    cultureLabelEl.textContent = theme ? 'Theme culture' : 'Culture';
    nameRow.hidden = theme; kindRow.hidden = theme; positionBox.hidden = theme; langRow.hidden = !theme;
    nameEl.value = !theme ? cleanSettlementName(specs[selected]?.name) ?? '' : '';
    nameEl.placeholder = !theme ? generatedPlace(keyOf(o, selected))?.name ?? 'Generated name' : '';
    resetButton.hidden = theme;
    removeButton.disabled = theme || specs.length <= 1;
    showPositionMode();
  }
  const editorOptions = (o: Options): Options => selected >= 0 && mode === 'list' && listOf(o)[selected] ? optionsForSettlement(o, listOf(o)[selected]) : o;
  function capture(input: Options, base: Options): Options {
    // Environment and display settings are shared, including while a place is selected.
    const town = new Set<string>([...SETTLEMENT_OVERRIDE_KEYS, 'culture', 'population', 'siteType', 'center']);
    const next: Options = { ...base };
    for (const key of Object.keys(input) as (keyof Options)[]) if (!town.has(key) && key !== 'settlements' && key !== 'workflow') Object.assign(next, { [key]: input[key] });
    if (mode !== 'list' || selected < 0) {
      // the general card never edits a place's population, site or position (the target population has its own field)
      for (const key of town) if (key !== 'population' && key !== 'center' && key !== 'siteType' && key !== 'size') Object.assign(next, { [key]: (input as unknown as Record<string, unknown>)[key] });
    } else {
      const specs = copy(listOf(base));
      const previous = specs[selected];
      if (!previous) return next;
      const old = editorOptions(base);
      const options: SettlementOverrides = { ...previous.options };
      for (const key of SETTLEMENT_OVERRIDE_KEYS) if (key !== 'language' && !same(defaultValue(key, input[key]), defaultValue(key, old[key]))) Object.assign(options, { [key]: input[key] });
      const spec: SettlementSpec = { ...previous, options };
      if (!same(input.population, old.population)) spec.population = Math.max(POP_MIN, Math.min(POP_MAX, Math.round(input.population || previous.population)));
      if (input.culture !== old.culture) { spec.culture = input.culture; options.cultureMix = input.cultureMix ?? null; options.plan = input.plan ?? null; }
      if (input.siteType !== old.siteType) spec.siteType = input.siteType && input.siteType !== 'auto' ? input.siteType : undefined;
      if (!same(input.center, old.center)) spec.position = input.center;
      specs[selected] = spec;
      next.settlements = { list: specs };
    }
    next.settlementMode = mode;
    render(next);
    return next;
  }
  /** The displayed automatic region becomes the editable list (same keys and positions: the same map). */
  function takeOver(index: SettlementTarget): void {
    if (mode === 'list') { if (index >= 0) changeEditor((draft) => { selected = index; render(draft); return draft; }); return; }
    changeEditor((draft) => {
      const places = generated.all();
      const next = places.length ? regionAsList(draft, places) : settlementComposition(draft, true);
      mode = 'list'; selected = index; setPicking(null);
      render(next); return next;
    });
  }
  modeEl.addEventListener('change', () => { if (modeEl.value === 'list') takeOver(0); else generateAuto(); });
  themeButton.addEventListener('click', () => changeEditor((draft) => { selected = -1; setPicking(null); render(draft); return draft; }));

  /** Automatic region around a town of the target population, generated right away. */
  function generateAuto(): void {
    const target = Math.max(POP_MIN, Math.min(POP_MAX, Math.round(Number(autoPop.value) || 3000)));
    changeEditor((draft) => {
      mode = 'automatic'; selected = -1; setPicking(null);
      const next: Options = { ...draft, settlementMode: 'automatic', population: target, size: sizeForPop(target), center: undefined, siteType: 'auto', settlements: 'auto' };
      render(next); return next;
    });
    onGenerate();
  }
  autoGenerate.addEventListener('click', generateAuto);
  autoPop.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); generateAuto(); } });

  // one by one: a village of the theme culture, selected and ready to be named and placed
  const addButton = document.getElementById('settlAdd') as HTMLButtonElement;
  addButton.addEventListener('click', () => {
    if (mode !== 'list') takeOver(-1);
    changeEditor((draft) => {
      const next = appendSettlementDraft(draft, true, 300, '');
      selected = listOf(next).length - 1; setPicking(null);
      render(next); return next;
    });
    nameEl.focus();
  });
  clearButton.addEventListener('click', () => {
    changeEditor((draft) => {
      mode = 'list'; selected = 0; setPicking(null);
      const next: Options = { ...draft, settlementMode: 'list', settlements: { list: [{ population: 300 }] } };
      render(next); return next;
    });
    nameEl.focus();
  });
  nameEl.addEventListener('change', () => {
    // read before changeEditor: its capture re-renders the editor from the draft
    const name = cleanSettlementName(nameEl.value);
    changeEditor((draft) => {
      const specs = copy(listOf(draft));
      if (selected < 0 || !specs[selected]) return draft;
      if (name) specs[selected].name = name; else delete specs[selected].name;
      const next = { ...draft, settlements: { list: specs } }; render(next); return next;
    });
  });
  nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameEl.blur(); });
  function removeAt(index: number): void {
    changeEditor((draft) => {
      const specs = copy(listOf(draft));
      if (index < 0 || specs.length <= 1) return draft;
      specs.splice(index, 1);
      selected = selected === index ? -1 : selected > index ? selected - 1 : selected;
      setPicking(null);
      const next = { ...draft, settlements: { list: specs } }; render(next); return next;
    });
  }
  removeButton.addEventListener('click', () => removeAt(selected));
  resetButton.addEventListener('click', () => changeEditor((draft) => {
    const specs = copy(listOf(draft)), previous = specs[selected];
    if (!previous) return draft;
    const { population, position, name, key } = previous;
    specs[selected] = { population, position, ...(name ? { name } : {}), ...(key ? { key } : {}) };
    const next = { ...draft, settlements: { list: specs } }; render(next); return next;
  }));
  pick.addEventListener('click', () => setPicking(picking !== null ? null : selected));
  auto.addEventListener('click', () => { xEl.value = ''; yEl.value = ''; setPicking(null); positionBox.dispatchEvent(new Event('change')); });
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && picking !== null) { event.preventDefault(); setPicking(null); } });
  function load(o: Options): void {
    mode = o.settlementMode === 'list' || o.workflow === 'list' || o.workflow === 'environment' && !o.settlementMode && listOf(o).length > 0 ? 'list' : 'automatic';
    selected = mode === 'list' ? Math.min(selected, listOf(o).length - 1) : -1;
    setPicking(null); render(o);
  }
  const inExtent = (p: { x: number; y: number }): boolean => {
    const extent = Number(msEl.value) || mapSizeOf(getOpts());
    return Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x <= extent && p.y <= extent;
  };
  function move(target: SettlementTarget, p: { x: number; y: number }): void {
    if (!inExtent(p) || target < 0) return;
    if (mode !== 'list') takeOver(target);
    const position = { x: Math.round(p.x), y: Math.round(p.y) };
    setPicking(null);
    changeEditor((draft) => {
      const specs = copy(listOf(draft));
      if (!specs[target]) return draft;
      specs[target].position = position; selected = target;
      const next = { ...draft, settlements: { list: specs } };
      render(next); return next;
    });
  }
  load(getOpts());
  return { get picking() { return picking; }, get mode() { return mode; }, editorOptions, capture, load,
    composition(o) { return settlementComposition(o, mode === 'list'); },
    place(point) { if (picking !== null) move(picking, point); },
    cancelPick() { setPicking(null); },
    select(target) { takeOver(target); },
    move,
    markers(o) {
      if (mode !== 'list') {
        return generated.all().map((p, index) => ({ target: index, badge: index === 0 ? '★' : String(index + 1), name: p.name ?? '', explicit: false, pos: p.center, selected: false }));
      }
      return listOf(o).map((spec, index) => ({
        target: index, badge: index === 0 ? '★' : String(index + 1), name: displayName(o, index), explicit: !!spec.position,
        pos: spec.position ?? generatedPlace(keyOf(o, index))?.center, selected: selected === index,
      }));
    },
    refresh() { render(lastDraft); },
  };
}

export function showSettlementWarnings(stats: Record<string, number | string>): void {
  const warning = document.getElementById('settlWarn');
  if (!warning) return;
  const count = Number(stats['settlements'] ?? 0), text = String(stats['settlements.warning'] ?? '');
  warning.textContent = (count ? `${count} places · ${Number(stats['settlements.pop'] ?? 0).toLocaleString('en')} inhabitants. ` : '') + text;
}
