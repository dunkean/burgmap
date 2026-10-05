import { DEBUG_STAGES, type DebugStage } from '../gen/debugPipeline';
import type { SettlementMeta } from './protocol';
import { worldToScreen, type View } from '../render/view';
import './developer.css';

/** Small opt-in controls and read-only centroid overlay; generation stays in the worker. */
export function initDeveloper(content: HTMLElement, map: HTMLElement, action: (stage?: DebugStage) => void) {
  const details = document.createElement('details');
  details.className = 'developer'; details.id = 'developerOptions';
  details.innerHTML = `<summary>Developer</summary><div class="developer-body">
    <p class="hint">Run one stage at a time using the current settings.</p>
    <button type="button" data-stage="0" class="secondary">Create empty map</button>
    <ol>${DEBUG_STAGES.slice(1).map((label, i) => `<li><button type="button" class="secondary" data-stage="${i + 1}" disabled>${label}</button></li>`).join('')}</ol>
    <p class="developer-state" role="status">Start with an empty map.</p>
    <p class="hint developer-note">Centroids use projected reserves before roads and buildings; secondary locations can differ from normal generation. Stage 4 adds rural cover and names. Large settlements retain lazy detail. Export JSON to save a stage; a shared ID opens the normal map.</p>
    <button type="button" class="secondary small" data-normal>Normal generation</button>
  </div>`;
  content.append(details);
  const state = details.querySelector<HTMLElement>('.developer-state')!;
  const buttons = Array.from(details.querySelectorAll<HTMLButtonElement>('[data-stage]'));
  const normal = details.querySelector<HTMLButtonElement>('[data-normal]')!;
  let completed: DebugStage | null = null, target: DebugStage | null = null, busy = false, invalidated = false;
  const overlay = document.createElement('div'); overlay.className = 'developer-centroids'; overlay.id = 'developerCentroids'; map.append(overlay);
  let positions: SettlementMeta[] = [];
  let lastView: { v: View; w: number; h: number } | null = null;
  function draw(): void {
    if (!lastView) return;
    for (const [i, el] of Array.from(overlay.children).entries()) {
      const s = positions[i];
      const [x, y] = worldToScreen(lastView.v, lastView.w, lastView.h, s.center.x, s.center.y);
      (el as HTMLElement).style.transform = `translate(${x}px, ${y}px)`;
    }
  }
  function sync(): void {
    for (const button of buttons) {
      const stage = Number(button.dataset.stage);
      button.disabled = busy || (stage > 0 && (completed === null || stage !== completed + 1));
      button.classList.toggle('complete', completed !== null && stage <= completed);
    }
    normal.disabled = busy;
    details.setAttribute('aria-busy', String(busy));
  }
  for (const button of buttons) button.addEventListener('click', () => action(Number(button.dataset.stage) as DebugStage));
  normal.addEventListener('click', () => action());
  return {
    started(stage?: DebugStage) {
      invalidated = false;
      target = stage ?? null;
      if (stage === undefined || stage === 0) { completed = null; positions = []; overlay.textContent = ''; }
      state.textContent = stage === undefined ? 'Normal generation.' : `Generating: ${DEBUG_STAGES[stage]}…`;
      sync();
    },
    busy(value: boolean) { busy = value; sync(); },
    complete(stats: Record<string, number | string>, settlements: SettlementMeta[]) {
      if (invalidated) {
        completed = null; target = null; positions = []; overlay.textContent = ''; sync(); return;
      }
      const stage = stats['developer.stage'];
      if (typeof stage !== 'number') { completed = null; target = null; overlay.textContent = ''; sync(); return; }
      completed = stage as DebugStage; target = null;
      state.textContent = `${DEBUG_STAGES[completed]} ready${completed === 4 ? '.' : ' — choose the next stage.'}`;
      positions = completed === 2 || completed === 3 ? settlements : [];
      overlay.textContent = '';
      for (const s of positions) {
        const point = document.createElement('span'); point.className = 'developer-centroid';
        const label = document.createElement('b'); label.textContent = `${s.key === 'main' ? 'Main' : s.cls} · ${s.population}`;
        point.append(label); overlay.append(point);
      }
      draw(); sync();
    },
    failed() { if (target !== null) { state.textContent = 'Stage failed. Restart with an empty map.'; completed = null; target = null; sync(); } },
    invalidate() {
      if (completed !== null || target !== null) {
        invalidated = true; completed = null; positions = []; overlay.textContent = '';
        state.textContent = 'Settings changed. Restart with an empty map.'; sync();
      }
    },
    update(v: View, w: number, h: number) { lastView = { v, w, h }; draw(); },
  };
}
export type DeveloperControls = ReturnType<typeof initDeveloper>;
