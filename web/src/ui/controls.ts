/**
 * Tiny control registry (no framework): each panel control declares how it reads its value into the
 * Options and how it shows them. New sections (e.g. the culture / phases / blend panel) only have to
 * `registry.add(...)` their controls; URL state, history, regeneration and display-only updates follow.
 */
import type { Options } from '../gen/options';

export interface Control {
  el: HTMLElement;
  read(o: Options): Options;
  write(o: Options): void;
  /** True when a change only needs a re-render, not a new generation. */
  display?: boolean;
  /** Text / number inputs fire while typing (`input`) in addition to `change`. */
  live?: boolean;
}

export class ControlRegistry {
  readonly controls: Control[] = [];
  private cb: (c: Control, kind: 'input' | 'change') => void = () => undefined;
  add(c: Control): Control {
    this.controls.push(c);
    c.el.addEventListener('change', () => this.cb(c, 'change'));
    if (c.live) c.el.addEventListener('input', () => this.cb(c, 'input'));
    return c;
  }
  onChange(cb: (c: Control, kind: 'input' | 'change') => void): void { this.cb = cb; }
  readAll(o: Options): Options { let r = o; for (const c of this.controls) r = c.read(r); return r; }
  writeAll(o: Options): void { for (const c of this.controls) c.write(o); syncChips(); }
}

export function fillSelect(sel: HTMLSelectElement, items: [string, string][], value: string): void {
  sel.innerHTML = '';
  for (const [v, label] of items) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = value;
}

export function selectControl<K extends keyof Options>(
  el: HTMLSelectElement, key: K, conv: (v: string) => Options[K], display = false,
): Control {
  return {
    el, display,
    read: (o) => ({ ...o, [key]: conv(el.value) }),
    write: (o) => { el.value = String(o[key] ?? ''); },
  };
}
export function checkControl<K extends keyof Options>(el: HTMLInputElement, key: K, display = false): Control {
  return {
    el, display,
    read: (o) => ({ ...o, [key]: el.checked }),
    write: (o) => { el.checked = !!o[key]; },
  };
}
export function numberControl<K extends keyof Options>(el: HTMLInputElement, key: K, fallback: number, display = false): Control {
  return {
    el, display, live: true,
    read: (o) => { const n = Number(el.value); return { ...o, [key]: el.value !== '' && Number.isFinite(n) ? n : fallback }; },
    write: (o) => { el.value = String(o[key] ?? fallback); },
  };
}

const chipSyncs: (() => void)[] = [];
/** Show every chip group with its select's current value (selects are also set programmatically). */
export function syncChips(): void { for (const sync of chipSyncs) sync(); }
/**
 * One-click choices instead of a drop-down: the select stays the control's value (registry, scripts), visually
 * hidden; a row of buttons mirrors its options. Returns the sync function.
 */
export function chipify(sel: HTMLSelectElement): () => void {
  const row = document.createElement('div');
  row.className = 'chips'; row.setAttribute('role', 'group');
  const label = sel.id ? document.querySelector(`label[for="${sel.id}"]`) : null;
  if (label) { if (!label.id) label.id = sel.id + '-label'; row.setAttribute('aria-labelledby', label.id); }
  const build = (): void => {
    row.textContent = '';
    for (const option of Array.from(sel.options)) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = option.textContent; b.dataset.value = option.value;
      b.addEventListener('click', () => { if (sel.value === option.value) return; sel.value = option.value; sel.dispatchEvent(new Event('change', { bubbles: true })); sync(); });
      row.append(b);
    }
  };
  const sync = (): void => {
    if (row.childElementCount !== sel.options.length) build();
    Array.from(row.children).forEach((child, i) => {
      const b = child as HTMLButtonElement;
      b.textContent = sel.options[i].textContent; b.setAttribute('aria-pressed', String(b.dataset.value === sel.value)); b.disabled = sel.disabled;
    });
  };
  sel.classList.add('sr-only'); sel.tabIndex = -1;
  sel.insertAdjacentElement('afterend', row);
  sel.addEventListener('change', sync);
  build(); sync();
  chipSyncs.push(sync);
  return sync;
}
