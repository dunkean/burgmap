/** The rail's one-click biome / relief / render-style pickers (tiny dots, always visible). */
import type { BiomeName } from '../gen/biomes';
import type { Options } from '../gen/options';
import { BIOME_LABELS } from '../gen/biomes';
import { PALETTES, STYLE_LIST, type MapStyle } from '../render/styles';

/** Disc colour and 16x16 glyph (stroked in the disc's ink) per biome. */
const BIOME_ART: Record<BiomeName, { bg: string; glyph: string }> = {
  temperate: { bg: '#6f9a4a', glyph: '<circle cx="8" cy="6.2" r="3.6"/><path d="M8 9.8V14"/>' },
  forest: { bg: '#2f6a46', glyph: '<path d="M8 2 4.6 7h2L4 11h8L9.4 7h2z"/><path d="M8 11v3"/>' },
  desert: { bg: '#d2a653', glyph: '<circle cx="11.2" cy="4.6" r="1.8"/><path d="M1.5 13c2-4 4.2-4 6.2-1.2 1.4 2 3.2 1.4 6.8-2.3"/>' },
  steppe: { bg: '#a9a35a', glyph: '<path d="M3 13c.2-3 .6-5 1.2-7M7 13c0-3.4.4-6 1-9M11.5 13c-.1-2.6.2-4.4.9-6.2M8 13h6M2 13h2"/>' },
  tropical: { bg: '#2d8a6b', glyph: '<path d="M8.4 14c-.3-3-.3-5 .6-7.6"/><path d="M9 6.4C6.6 4.6 4.2 5.2 2.8 7.2M9 6.4c2-2 4.4-2 5.4-.4M9 6.4C8.6 4 9.4 2.6 11 2M9 6.4C7.6 4.2 6.6 3 4.6 2.6"/>' },
  tundra: { bg: '#8fb0c3', glyph: '<path d="M8 1.8v12.4M2.6 4.9l10.8 6.2M2.6 11.1l10.8-6.2M6.4 2.9 8 4.3l1.6-1.4M6.4 13.1 8 11.7l1.6 1.4"/>' },
  underdark: { bg: '#5b4a86', glyph: '<path d="M2.6 8.6C2.8 5 5 3 8 3s5.2 2 5.4 5.6z"/><path d="M6.6 8.8c0 2.6-.3 3.6-.9 4.6M9.4 8.8c0 2.6.3 3.6.9 4.6"/>' },
  'underdark-caverns': { bg: '#3a3550', glyph: '<path d="M2 3h12M3.6 3c.4 2.4.9 4 1.6 5.4M7 3c.2 3 .5 5 1 6.6M11 3c-.3 2.2-.7 3.6-1.4 4.8M2 14c2-3.4 4-4.8 6-4.8s4 1.4 6 4.8"/>' },
};

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

const RELIEF_ART: [Relief, string, string][] = [
  ['flat', 'Flat', '<path d="M2 10.5h12M2 13h12"/>'],
  ['hills', 'Rolling hills', '<path d="M1.5 12.5c1.8-3.6 4.2-3.6 6 0 1.6-2.6 4.4-2.6 7 0"/>'],
  ['valley', 'Valley', '<path d="M1.5 4c2.6 1 3.6 8.5 6.5 8.5S11.9 5 14.5 4"/><path d="M6.3 12.8h3.4"/>'],
  ['mountains', 'Mountains', '<path d="M1.5 13 6 4.5l3 5 1.8-3L14.5 13z"/><path d="M4.6 7.2 6 8.4l1.3-1.2"/>'],
];

type Coast = Options['coast'];
type River = Options['river'];
const COAST_ART: [Coast, string, string][] = [
  ['none', 'No coast', '<path d="M2 8h12" stroke-dasharray="1.5 2.2"/>'],
  ['random', 'Coast on a random side', '<path d="M2 11c2-2 4 2 6 0s4 2 6 0"/><path d="M6.4 4.6a1.8 1.8 0 113 1.3c-.8.6-1.4 1-1.4 2"/>'],
  ['N', 'Coast to the north', '<path d="M2 6c2-2 4 2 6 0s4 2 6 0"/><path d="M8 14V9"/>'],
  ['E', 'Coast to the east', '<path d="M10 2c2 2-2 4 0 6s-2 4 0 6"/><path d="M2 8h5"/>'],
  ['S', 'Coast to the south', '<path d="M2 10c2-2 4 2 6 0s4 2 6 0"/><path d="M8 2v5"/>'],
  ['W', 'Coast to the west', '<path d="M6 2c-2 2 2 4 0 6s2 4 0 6"/><path d="M14 8H9"/>'],
];
const RIVER_ART: [River, string, string][] = [
  ['none', 'No river', '<path d="M2 8h12" stroke-dasharray="1.5 2.2"/>'],
  ['stream', 'Stream', '<path d="M3 2c4 3-2 6 2 8s1 4 3 4" />'],
  ['river', 'River', '<path d="M3 2c4 3-2 6 2 8s1 4 3 4" stroke-width="2.4"/>'],
  ['major', 'Major river', '<path d="M3 2c4 3-2 6 2 8s1 4 3 4" stroke-width="4"/>'],
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
  /** Plain-disc pickers sharing one look (relief, coast, river). */
  const glyphs = <T extends string>(row: HTMLElement, kind: string, art: [T, string, string][], pick: (v: T) => void): Map<T, HTMLButtonElement> => {
    const out = new Map<T, HTMLButtonElement>();
    for (const [id, label, glyph] of art) {
      const b = el('button', { type: 'button', class: 'dot', ['data-' + kind]: id, 'data-tip': label, 'aria-label': label, 'aria-pressed': 'false' });
      b.style.background = kind === 'relief' ? '#7b6a52' : '#3f6f8f';
      b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${glyph}</svg>`;
      b.addEventListener('click', () => pick(id));
      out.set(id, b); row.append(b);
    }
    return out;
  };
  const biomeButtons = new Map<BiomeName, HTMLButtonElement>();
  const styleButtons = new Map<MapStyle, HTMLButtonElement>();
  for (const [id, label] of BIOME_LABELS) {
    const art = BIOME_ART[id];
    const b = el('button', { type: 'button', class: 'dot', 'data-biome': id, 'data-tip': label, 'aria-label': `Biome: ${label}`, 'aria-pressed': 'false' });
    b.style.background = art.bg;
    b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${art.glyph}</svg>`;
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
