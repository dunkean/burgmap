/** The rail's one-click biome / relief / render-style pickers (tiny dots, always visible). */
import type { BiomeName } from '../gen/biomes';
import type { Options } from '../gen/options';
import { railIcon } from './railArt';
import { BIOME_LABELS } from '../gen/biomes';
import { PALETTES, STYLE_LIST, type MapStyle } from '../render/styles';

type Relief = Options['relief'];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};

/** A palette in three bands: the paper, the water and the building ink, so each style is recognisable at 22px. */
export function styleSwatch(id: MapStyle): string {
  const p = PALETTES[id];
  return `conic-gradient(from 200deg, ${p.paper} 0 34%, ${p.seaFill} 0 62%, ${p.urban.mass} 0 82%, ${p.ink} 0 100%)`;
}

const RELIEF_ART: [Relief, string][] = [
  ['flat', 'Flat'], ['hills', 'Rolling hills'], ['valley', 'Valley'], ['mountains', 'Mountains'],
];

type Coast = Options['coast'];
type River = Options['river'];
const COAST_ART: [Coast, string][] = [
  ['none', 'No coast'], ['random', 'Coast on a random side'],
  ['N', 'Coast to the north'], ['E', 'Coast to the east'],
  ['S', 'Coast to the south'], ['W', 'Coast to the west'],
];
const RIVER_ART: [River, string][] = [
  ['none', 'No river'], ['stream', 'Stream'], ['river', 'River'], ['major', 'Major river'],
];

export interface Dock {
  /** Show which biome / relief / coast / river / style the displayed map uses. */
  sync(o: { biome: BiomeName; relief: Relief; coast: Coast; river: River; style: MapStyle }): void;
}
export interface DockActions {
  biome(v: BiomeName): void; relief(v: Relief): void; coast(v: Coast): void; river(v: River): void; style(v: MapStyle): void;
}

/** One tooltip for the whole rail (the rail scrolls, so per-button pseudo-elements would be clipped). */
function tooltip(host: HTMLElement): void {
  const tip = el('div', { id: 'tip', role: 'presentation' });
  tip.hidden = true;
  document.body.append(tip);
  const show = (e: Event): void => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
    if (!b) return;
    const r = b.getBoundingClientRect();
    tip.textContent = b.dataset.tip!;
    tip.style.left = `${r.left - 8}px`; tip.style.top = `${r.top + r.height / 2}px`;
    tip.hidden = false;
  };
  const hide = (): void => { tip.hidden = true; };
  host.addEventListener('pointerover', show); host.addEventListener('focusin', show);
  host.addEventListener('pointerout', hide); host.addEventListener('focusout', hide);
  host.addEventListener('scroll', hide);
}

export function initDock(host: HTMLElement, on: DockActions): Dock {
  const section = (caption: string, label: string): HTMLElement => {
    host.append(el('div', { class: 'rail-cap', 'aria-hidden': 'true' }));
    host.lastElementChild!.textContent = caption;
    const row = el('div', { class: 'dock-row', role: 'group', 'aria-label': label });
    host.append(row);
    return row;
  };
  const biomes = section('Biome', 'Biome');
  const reliefs = section('Relief', 'Relief');
  const coasts = section('Coast', 'Coast');
  const rivers = section('Rivers', 'Rivers');
  const styles = section('Style', 'Map style');
  /** Illustrated pickers share the generated atlas; style discs retain their exact palettes. */
  const glyphs = <T extends string>(row: HTMLElement, kind: string, art: [T, string][], pick: (v: T) => void): Map<T, HTMLButtonElement> => {
    const out = new Map<T, HTMLButtonElement>();
    for (const [id, label] of art) {
      const b = el('button', { type: 'button', class: 'dot', ['data-' + kind]: id, 'data-tip': label, 'aria-label': label, 'aria-pressed': 'false' });
      b.innerHTML = railIcon(kind === 'relief' ? id : `${kind}-${id}`);
      b.addEventListener('click', () => pick(id));
      out.set(id, b); row.append(b);
    }
    return out;
  };
  const biomeButtons = new Map<BiomeName, HTMLButtonElement>();
  const styleButtons = new Map<MapStyle, HTMLButtonElement>();
  for (const [id, label] of BIOME_LABELS) {
    const b = el('button', { type: 'button', class: 'dot', 'data-biome': id, 'data-tip': label, 'aria-label': `Biome: ${label}`, 'aria-pressed': 'false' });
    b.innerHTML = railIcon(id);
    b.addEventListener('click', () => on.biome(id));
    biomeButtons.set(id, b); biomes.append(b);
  }
  const reliefButtons = glyphs(reliefs, 'relief', RELIEF_ART, on.relief);
  const coastButtons = glyphs(coasts, 'coast', COAST_ART, on.coast);
  const riverButtons = glyphs(rivers, 'river', RIVER_ART, on.river);
  for (const { id, label } of STYLE_LIST) {
    const b = el('button', { type: 'button', class: 'dot swatch', 'data-style': id, 'data-tip': label, 'aria-label': `Style: ${label}`, 'aria-pressed': 'false' });
    b.style.background = styleSwatch(id);
    b.addEventListener('click', () => on.style(id));
    styleButtons.set(id, b); styles.append(b);
  }
  tooltip(host.closest<HTMLElement>('#rail') ?? host);
  return {
    sync(o) {
      const mark = <T>(buttons: Map<T, HTMLButtonElement>, value: T): void => { for (const [id, b] of buttons) b.setAttribute('aria-pressed', String(id === value)); };
      mark(biomeButtons, o.biome); mark(reliefButtons, o.relief); mark(coastButtons, o.coast); mark(riverButtons, o.river); mark(styleButtons, o.style);
    },
  };
}
