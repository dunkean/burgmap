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
  writeAll(o: Options): void { for (const c of this.controls) c.write(o); }
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
