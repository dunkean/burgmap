/** Main-inclusive settlement editor; controls remain a draft until Generate is pressed. */
import type { Options, SettlementSpec, SettlementOverrides } from '../gen/options';
import { SETTLEMENT_OVERRIDE_KEYS, optionsForSettlement, mapSizeOf, MAP_SIZE_MIN, MAP_SIZE_MAX, POP_MIN, POP_MAX, classOfPop, sizeForPop } from '../gen/options';
import { CULTURE_LIST } from '../gen/urban/cultures';
import type { ControlRegistry } from './controls';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) e.setAttribute(key, value);
  if (text !== undefined) e.textContent = text;
  return e;
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const defaultValue = (key: string, value: unknown): unknown => value ?? (key === 'sprawl' ? 1 : key === 'cultureMix' || key === 'plan' ? null : key === 'sitePrefs' ? undefined : key === 'size' ? undefined : key === 'roads' ? 0 : 'auto');
const copy = <T>(value: T): T => structuredClone(value);
const mainSpec = (o: Options): SettlementSpec => ({ population: o.population || 20000, position: o.center });
const listOf = (o: Options): SettlementSpec[] => o.settlements && typeof o.settlements === 'object' && 'list' in o.settlements ? o.settlements.list : [];

export interface SettlementsUI {
  readonly picking: 'main' | number | null;
  readonly mode: 'automatic' | 'list';
  editorOptions(o: Options): Options;
  capture(input: Options, base: Options): Options;
  load(o: Options): void;
  composition(o: Options): Options;
  place(p: { x: number; y: number }): void;
  cancelPick(): void;
}

export function initSettlementsUI(registry: ControlRegistry, getOpts: () => Options, changeEditor: (change: (o: Options) => Options) => void): SettlementsUI {
  const modeEl = document.getElementById('settlMode') as HTMLSelectElement;
  const choices = document.getElementById('settlementChoices')!;
  const actions = document.getElementById('compositionActions')!;
  const heading = document.getElementById('settlementEditorHeading')!;
  const sizeEl = document.getElementById('size') as HTMLSelectElement;
  const popEl = document.getElementById('population') as HTMLInputElement;
  const msEl = document.getElementById('mapSize') as HTMLInputElement;
  const positionBox = document.getElementById('positionControls')!;
  const themeButton = el('button', { id: 'editTheme', type: 'button', class: 'secondary settlement-choice' }, 'General theme — default for every settlement');
  choices.insertAdjacentElement('beforebegin', themeButton);
  const themeHint = el('div', { class: 'hint', id: 'themeHint' });
  themeButton.insertAdjacentElement('afterend', themeHint);
  const resetButton = el('button', { id: 'inheritTheme', type: 'button', class: 'secondary small' }, 'Use general theme');
  heading.insertAdjacentElement('afterend', resetButton);
  let mode: 'automatic' | 'list' = 'automatic';
  // -1 edits the shared defaults; 0 and above edit an individual settlement.
  let selected = -1;
  let picking: 'main' | number | null = null;

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
  registry.add({ el: sizeEl, read: (o) => ({ ...o, size: sizeEl.value as Options['size'] }), write: (o) => { sizeEl.value = o.size; } });

  const coords = el('div', { class: 'row' });
  const xEl = el('input', { id: 'centerX', type: 'number', step: '1', placeholder: 'x (m)', 'aria-label': 'Selected settlement x (m)' });
  const yEl = el('input', { id: 'centerY', type: 'number', step: '1', placeholder: 'y (m)', 'aria-label': 'Selected settlement y (m)' });
  coords.append(xEl, yEl);
  const pick = el('button', { id: 'centerPick', type: 'button', class: 'secondary small' }, 'Place on map');
  const auto = el('button', { id: 'centerAuto', type: 'button', class: 'secondary small' }, 'Automatic position');
  const posHint = el('div', { id: 'centerHint', class: 'hint' });
  positionBox.append(el('label', {}, 'Position'), coords, pick, auto, posHint);
  registry.add({ el: positionBox,
    read: (o) => {
      if (!xEl.value && !yEl.value) return { ...o, center: undefined };
      return xEl.value && yEl.value && Number.isFinite(Number(xEl.value)) && Number.isFinite(Number(yEl.value)) ? { ...o, center: { x: Math.round(Number(xEl.value)), y: Math.round(Number(yEl.value)) } } : o;
    },
    write: (o) => { xEl.value = o.center ? String(o.center.x) : ''; yEl.value = o.center ? String(o.center.y) : ''; auto.disabled = !o.center; },
  });
  const updateReset = () => { auto.disabled = !xEl.value && !yEl.value; };
  positionBox.addEventListener('input', updateReset);
  positionBox.addEventListener('change', (e) => {
    updateReset();
    if (e.target !== xEl && e.target !== yEl) return;
    if (!!xEl.value !== !!yEl.value) { posHint.textContent = 'Enter both coordinates, or clear both for automatic placement.'; }
  });

  function setPicking(value: 'main' | number | null): void {
    picking = value;
    document.getElementById('map')!.classList.toggle('picking', value !== null);
    pick.textContent = value === null ? 'Place on map' : 'Click the map…';
    posHint.textContent = value === null ? 'Automatic unless you choose a position. Unsuitable sites move to nearby usable land.' : 'Click the landscape to place this settlement. Escape cancels.';
  }
  function render(o: Options): void {
    modeEl.value = mode;
    const specs = listOf(o);
    actions.hidden = mode !== 'list';
    choices.textContent = '';
    specs.forEach((spec, index) => {
      if (mode !== 'list') return;
      const settings = optionsForSettlement(o, spec);
      const label = CULTURE_LIST.find((c) => c.id === settings.culture)?.label ?? settings.culture;
      const button = el('button', { type: 'button', class: 'secondary settlement-choice', 'data-settlement': String(index), 'aria-pressed': String(selected === index) });
      button.append(el('span', {}, `${index === 0 ? 'Main' : '#' + (index + 1)} · ${classOfPop(spec.population)}`), el('small', {}, `${spec.population.toLocaleString('en')} · ${label}`));
      button.addEventListener('click', () => changeEditor((draft) => { selected = index; setPicking(null); render(draft); return draft; }));
      choices.append(button);
    });
    heading.textContent = selected < 0 ? 'General theme' : `Settlement ${selected + 1}${selected === 0 ? ' · main' : ''}`;
    themeButton.setAttribute('aria-pressed', String(selected < 0));
    themeHint.textContent = `${CULTURE_LIST.find((c) => c.id === o.culture)?.label ?? o.culture} · shared layout and landmarks. Individual changes override only the fields you edit.`;
    resetButton.hidden = selected < 0;
    positionBox.hidden = selected < 0 && mode === 'list';
    popEl.closest<HTMLElement>('.row')!.hidden = selected < 0 && mode === 'list';
    (document.getElementById('settlRemove') as HTMLButtonElement).disabled = selected < 0 || specs.length <= 1;
  }
  const editorOptions = (o: Options): Options => selected >= 0 && mode === 'list' && listOf(o)[selected] ? optionsForSettlement(o, listOf(o)[selected]) : o;
  function capture(input: Options, base: Options): Options {
    // Environment and display settings are shared, including while a secondary instance is selected.
    const town = new Set<string>([...SETTLEMENT_OVERRIDE_KEYS, 'culture', 'population', 'siteType', 'center']);
    const next: Options = { ...base };
    for (const key of Object.keys(input) as (keyof Options)[]) if (!town.has(key) && key !== 'settlements' && key !== 'workflow') Object.assign(next, { [key]: input[key] });
    if (mode !== 'list' || selected < 0) {
      for (const key of town) Object.assign(next, { [key]: (input as unknown as Record<string, unknown>)[key] });
    } else {
      const specs = copy(listOf(base));
      const previous = specs[selected];
      if (!previous) return next;
      const old = editorOptions(base);
      const options: SettlementOverrides = { ...previous.options };
      for (const key of SETTLEMENT_OVERRIDE_KEYS) if (!same(defaultValue(key, input[key]), defaultValue(key, old[key]))) Object.assign(options, { [key]: input[key] });
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
  modeEl.addEventListener('change', () => {
    const wanted = modeEl.value as 'automatic' | 'list';
    changeEditor((draft) => {
      if (wanted === 'list' && mode !== 'list') {
        const secondary = draft.settlements && typeof draft.settlements === 'object' && 'list' in draft.settlements ? draft.settlements.list : [];
        draft = { ...draft, settlements: { list: draft.workflow && secondary.length ? copy(secondary) : [mainSpec(draft), ...copy(secondary)] } };
      }
      draft = { ...draft, settlementMode: wanted };
      mode = wanted; selected = wanted === 'list' ? 0 : -1; setPicking(null); render(draft); return draft;
    });
  });
  themeButton.addEventListener('click', () => changeEditor((draft) => { selected = -1; setPicking(null); render(draft); return draft; }));
  document.getElementById('settlAdd')!.addEventListener('click', () => changeEditor((draft) => {
    const specs = [...copy(listOf(draft)), { population: 300 }];
    selected = specs.length - 1; setPicking(null); const next = { ...draft, settlements: { list: specs } }; render(next); return next;
  }));
  document.getElementById('settlRemove')!.addEventListener('click', () => changeEditor((draft) => {
    const specs = copy(listOf(draft));
    if (selected < 0 || specs.length <= 1) return draft;
    specs.splice(selected, 1); selected = Math.min(selected, specs.length - 1); setPicking(null);
    const next = { ...draft, settlements: { list: specs } }; render(next); return next;
  }));
  resetButton.addEventListener('click', () => changeEditor((draft) => {
    const specs = copy(listOf(draft)), previous = specs[selected];
    if (!previous) return draft;
    specs[selected] = { population: previous.population, position: previous.position };
    const next = { ...draft, settlements: { list: specs } }; render(next); return next;
  }));
  pick.addEventListener('click', () => setPicking(picking !== null ? null : mode === 'list' ? selected : 'main'));
  auto.addEventListener('click', () => { xEl.value = ''; yEl.value = ''; setPicking(null); positionBox.dispatchEvent(new Event('change')); });
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape') setPicking(null); });
  function load(o: Options): void {
    mode = o.workflow === 'list' || o.workflow === 'environment' && (o.settlementMode === 'list' || !o.settlementMode && listOf(o).length > 0) ? 'list' : 'automatic';
    selected = mode === 'list' ? Math.min(Math.max(0, selected), listOf(o).length - 1) : -1;
    setPicking(null); render(o);
  }
  load(getOpts());
  return { get picking() { return picking; }, get mode() { return mode; }, editorOptions, capture, load,
    composition(o) { return mode === 'list' ? { ...o, workflow: 'list', settlements: { list: listOf(o).length ? listOf(o) : [mainSpec(o)] } } : { ...o, workflow: 'automatic', population: o.population || 20000, size: o.population ? o.size : 'city', settlements: listOf(o).length ? o.settlements : 'auto' }; },
    place(point) {
      const extent = Number(msEl.value) || mapSizeOf(getOpts());
      if (picking === null || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > extent || point.y > extent) return;
      xEl.value = String(Math.round(point.x)); yEl.value = String(Math.round(point.y)); setPicking(null); positionBox.dispatchEvent(new Event('change'));
    },
    cancelPick() { setPicking(null); },
  };
}

export function showSettlementWarnings(stats: Record<string, number | string>): void {
  const warning = document.getElementById('settlWarn');
  if (!warning) return;
  const count = Number(stats['settlements'] ?? 0), text = String(stats['settlements.warning'] ?? '');
  warning.textContent = (count ? `${count} settlements · ${Number(stats['settlements.pop'] ?? 0).toLocaleString('en')} inhabitants. ` : '') + text;
}
