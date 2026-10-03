/**
 * Pins (waypoints with a short note) as a DOM overlay on the map: numbered dark markers of constant size (readable at
 * every zoom), an inline popover to edit the note or delete the pin, and a list in the panel (click = focus).
 * UI state only: nothing here touches the generator.
 */
import type { View } from '../render/view';
import { worldToScreen } from '../render/view';
import { Pin, MAX_NOTE } from './share';

export interface PinsOptions {
  map: HTMLElement;
  layer: HTMLElement;
  pop: HTMLElement;
  list: HTMLElement;
  /** Pins changed (added, edited, deleted): update the URL. */
  onChange(pins: Pin[]): void;
  /** Click on a pin (marker or list): move the view onto it. */
  onFocus(p: Pin): void;
}
export interface PinsUI {
  readonly pins: Pin[];
  set(pins: Pin[]): void;
  add(x: number, y: number): void;
  /** Re-place the markers for the current view (called every frame). */
  update(v: View, w: number, h: number): void;
}

export function createPins(o: PinsOptions): PinsUI {
  let pins: Pin[] = [];
  let markers: HTMLElement[] = [];
  let open = -1;
  let view: { v: View; w: number; h: number } | null = null;

  const input = document.createElement('input');
  input.type = 'text'; input.maxLength = MAX_NOTE; input.placeholder = 'note'; input.spellcheck = false;
  const del = document.createElement('button');
  del.className = 'secondary small'; del.textContent = 'Delete'; del.title = 'Delete this pin';
  const title = document.createElement('span');
  const coords = document.createElement('div');
  coords.className = 'pc';
  o.pop.append(title, input, del, coords);
  o.pop.hidden = true;
  o.pop.addEventListener('pointerdown', (e) => e.stopPropagation());
  o.pop.addEventListener('pointerup', (e) => e.stopPropagation());

  const label = (p: Pin): string => `${p.x.toFixed(1)}, ${p.y.toFixed(1)}`;
  const closePop = (): void => { open = -1; o.pop.hidden = true; };
  function openPop(i: number, focus = true): void {
    open = i; o.pop.hidden = false;
    title.textContent = `Pin ${i + 1}`;
    coords.textContent = `${label(pins[i])} m`;
    input.value = pins[i].note;
    place();
    if (focus) input.focus();
  }
  function place(): void {
    if (open < 0 || !view) return;
    const p = pins[open];
    const [sx, sy] = worldToScreen(view.v, view.w, view.h, p.x, p.y);
    const pw = o.pop.offsetWidth || 190, ph = o.pop.offsetHeight || 80;
    const x = Math.max(6, Math.min(view.w - pw - 6, sx - pw / 2));
    const below = sy - ph - 22 < 6;
    o.pop.style.left = x + 'px';
    o.pop.style.top = Math.max(6, Math.min(view.h - ph - 6, below ? sy + 18 : sy - ph - 18)) + 'px';
  }
  function rebuild(): void {
    o.layer.textContent = '';
    markers = pins.map((p, i) => {
      const m = document.createElement('button');
      m.className = 'pin'; m.textContent = String(i + 1);
      m.title = `${i + 1}: ${label(p)}${p.note ? ' - ' + p.note : ''}`;
      m.addEventListener('pointerdown', (e) => e.stopPropagation());
      m.addEventListener('pointerup', (e) => e.stopPropagation());
      m.addEventListener('click', (e) => { e.stopPropagation(); open === i ? closePop() : openPop(i); });
      o.layer.appendChild(m);
      return m;
    });
    // panel list
    o.list.textContent = '';
    if (!pins.length) { const h = document.createElement('div'); h.className = 'hint'; h.textContent = 'No pins. Use Pin mode or Alt-click on the map.'; o.list.appendChild(h); }
    pins.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'pinrow';
      const go = document.createElement('button');
      go.className = 'secondary pinbtn';
      go.title = 'Focus on this pin';
      const n = document.createElement('b'); n.textContent = String(i + 1);
      const t = document.createElement('span'); t.textContent = p.note || '(no note)'; if (!p.note) t.className = 'dim';
      const c = document.createElement('small'); c.textContent = label(p);
      go.append(n, t, c);
      go.addEventListener('click', () => { o.onFocus(p); openPop(i, false); });
      const x = document.createElement('button');
      x.className = 'secondary small'; x.textContent = '×'; x.title = 'Delete this pin';
      x.addEventListener('click', () => remove(i));
      row.append(go, x);
      o.list.appendChild(row);
    });
    if (view) layout();
  }
  function layout(): void {
    if (!view) return;
    markers.forEach((m, k) => {
      const [sx, sy] = worldToScreen(view!.v, view!.w, view!.h, pins[k].x, pins[k].y);
      const vis = sx > -20 && sy > -20 && sx < view!.w + 20 && sy < view!.h + 20;
      m.style.display = vis ? '' : 'none';
      m.style.transform = `translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px)`;
    });
    place();
  }
  function remove(i: number): void {
    pins.splice(i, 1); closePop(); rebuild(); o.onChange(pins);
  }
  del.addEventListener('click', () => { if (open >= 0) remove(open); });
  input.addEventListener('input', () => {
    if (open < 0) return;
    pins[open].note = input.value.slice(0, MAX_NOTE);
    const row = o.list.children[open]?.querySelector('span');
    if (row) { row.textContent = pins[open].note || '(no note)'; row.className = pins[open].note ? '' : 'dim'; }
    markers[open].title = `${open + 1}: ${label(pins[open])}${pins[open].note ? ' - ' + pins[open].note : ''}`;
    o.onChange(pins);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); closePop(); input.blur(); } });
  rebuild();

  return {
    get pins() { return pins; },
    set(next) { pins = next.map((p) => ({ ...p })); closePop(); rebuild(); },
    add(x, y) { pins.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, note: '' }); rebuild(); openPop(pins.length - 1); o.onChange(pins); },
    update(v, w, h) { view = { v, w, h }; layout(); },
  };
}
