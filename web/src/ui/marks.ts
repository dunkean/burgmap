/**
 * Settlement markers shown while the Customize drawer edits settlements: one teardrop per settlement at its chosen
 * position (solid) or where the displayed map put it (dashed). Click selects it in the panel; drag moves it (the new
 * position is a draft until "Apply & generate"). UI state only.
 */
import type { View } from '../render/view';
import { worldToScreen, screenToWorld } from '../render/view';
import type { SettlementMarker, SettlementTarget } from './settlementsPanel';

export interface Marks {
  set(markers: SettlementMarker[] | null): void;
  update(v: View, w: number, h: number): void;
}

export function createMarks(layer: HTMLElement, o: { select(t: SettlementTarget): void; move(t: SettlementTarget, p: { x: number; y: number }): void }): Marks {
  let view: { v: View; w: number; h: number } | null = null;
  let items: { m: SettlementMarker; el: HTMLButtonElement }[] = [];
  let drag: { target: SettlementTarget; el: HTMLButtonElement; x0: number; y0: number; moved: boolean } | null = null;

  function position(el: HTMLElement, x: number, y: number): void {
    if (!view) return;
    const [sx, sy] = worldToScreen(view.v, view.w, view.h, x, y);
    el.style.left = `${sx}px`; el.style.top = `${sy}px`;
    el.hidden = sx < -40 || sy < -40 || sx > view.w + 40 || sy > view.h + 40;
  }
  function draw(): void { for (const { m, el } of items) if (m.pos && drag?.el !== el) position(el, m.pos.x, m.pos.y); }
  const local = (e: PointerEvent): [number, number] => {
    const r = layer.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  return {
    set(markers) {
      if (drag) return; // never rebuild under the pointer
      layer.textContent = ''; items = [];
      for (const m of markers ?? []) {
        if (!m.pos) continue;
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'mark' + (m.explicit ? '' : ' auto') + (m.selected ? ' sel' : '');
        el.title = `${m.name}: drag to move, click to edit`;
        el.setAttribute('aria-label', `${m.name} (drag to move)`);
        const pin = document.createElement('i'); const b = document.createElement('b'); b.textContent = m.badge; pin.append(b);
        const label = document.createElement('span'); label.textContent = m.name;
        el.append(pin, label);
        el.addEventListener('pointerdown', (e) => {
          e.stopPropagation(); e.preventDefault();
          el.setPointerCapture(e.pointerId);
          drag = { target: m.target, el, x0: e.clientX, y0: e.clientY, moved: false };
        });
        el.addEventListener('pointermove', (e) => {
          if (!drag || drag.el !== el) return;
          if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
          drag.moved = true; el.classList.add('dragging');
          const [sx, sy] = local(e);
          el.style.left = `${sx}px`; el.style.top = `${sy}px`;
        });
        el.addEventListener('pointerup', (e) => {
          e.stopPropagation();
          const d = drag; drag = null; el.classList.remove('dragging');
          if (!d || d.el !== el) return;
          if (!d.moved || !view) { o.select(m.target); return; }
          const [sx, sy] = local(e);
          const [x, y] = screenToWorld(view.v, view.w, view.h, sx, sy);
          o.move(m.target, { x, y });
        });
        el.addEventListener('pointercancel', () => { drag = null; el.classList.remove('dragging'); draw(); });
        layer.append(el);
        items.push({ m, el });
      }
      draw();
    },
    update(v, w, h) { view = { v, w, h }; draw(); },
  };
}
