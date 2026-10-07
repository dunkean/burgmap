import { screenToWorld, worldToScreen, type View } from '../render/view';
import './ruler.css';

/** Display-only measurement in map meters, shared by Canvas and SVG viewers. */
export function createRuler(o: {
  container: HTMLElement;
  surface: Element;
  controlsHost?: HTMLElement;
  getView: () => View;
  onEnable?: () => void;
}): { update(): void; setEnabled(on: boolean): void } {
  const ns = 'http://www.w3.org/2000/svg';
  const layer = document.createElementNS(ns, 'svg');
  layer.classList.add('ruler-layer');
  layer.setAttribute('aria-hidden', 'true');
  const halo = document.createElementNS(ns, 'line');
  const line = document.createElementNS(ns, 'line');
  const ends = [document.createElementNS(ns, 'circle'), document.createElementNS(ns, 'circle')];
  halo.classList.add('ruler-halo');
  ends.forEach(end => end.setAttribute('r', '4'));
  layer.append(halo, line, ...ends);
  o.container.append(layer);

  const controls = document.createElement('div');
  controls.className = 'ruler-controls';
  const result = document.createElement('output');
  result.className = 'ruler-distance';
  result.setAttribute('aria-label', 'Distance mesurée');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Règle';
  button.title = 'Mesurer une distance : cliquer puis glisser entre deux points';
  button.setAttribute('aria-pressed', 'false');
  controls.append(result, button);
  (o.controlsHost ?? o.container).append(controls);
  for (const name of ['pointerdown', 'pointerup', 'click']) controls.addEventListener(name, event => event.stopPropagation());

  let enabled = false, pointer: number | null = null;
  let start: [number, number] | null = null, end: [number, number] | null = null;
  const point = (event: PointerEvent): [number, number] => {
    const bounds = o.container.getBoundingClientRect();
    return screenToWorld(o.getView(), o.container.clientWidth, o.container.clientHeight, event.clientX - bounds.left, event.clientY - bounds.top);
  };
  function update(): void {
    const visible = enabled && start !== null && end !== null;
    for (const shape of [halo, line, ...ends]) shape.style.display = visible ? '' : 'none';
    result.hidden = !enabled;
    if (!visible) { result.textContent = 'Cliquer puis glisser'; return; }
    const a = worldToScreen(o.getView(), o.container.clientWidth, o.container.clientHeight, ...start!);
    const b = worldToScreen(o.getView(), o.container.clientWidth, o.container.clientHeight, ...end!);
    for (const stroke of [halo, line]) {
      stroke.setAttribute('x1', String(a[0])); stroke.setAttribute('y1', String(a[1]));
      stroke.setAttribute('x2', String(b[0])); stroke.setAttribute('y2', String(b[1]));
    }
    [a, b].forEach((p, i) => { ends[i].setAttribute('cx', String(p[0])); ends[i].setAttribute('cy', String(p[1])); });
    const meters = Math.hypot(end![0] - start![0], end![1] - start![1]);
    result.textContent = `Distance : ${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: meters >= 1000 ? 2 : 1 }).format(meters >= 1000 ? meters / 1000 : meters)} ${meters >= 1000 ? 'km' : 'm'}`;
  }
  function setEnabled(on: boolean): void {
    if (pointer !== null && layer.hasPointerCapture(pointer)) layer.releasePointerCapture(pointer);
    pointer = null;
    enabled = on;
    layer.classList.toggle('active', on);
    button.setAttribute('aria-pressed', String(on));
    if (on) o.onEnable?.();
    update();
  }
  button.onclick = () => setEnabled(!enabled);
  layer.addEventListener('pointerdown', event => {
    event.stopPropagation();
    if (event.button !== 0 || pointer !== null) return;
    event.preventDefault();
    pointer = event.pointerId;
    start = end = point(event);
    layer.setPointerCapture(pointer);
    update();
  });
  layer.addEventListener('pointermove', event => {
    event.stopPropagation();
    if (event.pointerId !== pointer) return;
    end = point(event); update();
  });
  layer.addEventListener('pointerup', event => {
    event.stopPropagation();
    if (event.pointerId !== pointer) return;
    end = point(event);
    layer.releasePointerCapture(pointer); pointer = null; update();
  });
  const cancel = (): void => { if (pointer !== null) { pointer = null; start = end = null; update(); } };
  layer.addEventListener('pointercancel', cancel);
  layer.addEventListener('lostpointercapture', cancel);
  for (const name of ['click', 'dblclick']) layer.addEventListener(name, event => event.stopPropagation());
  layer.addEventListener('wheel', event => {
    event.preventDefault(); event.stopPropagation();
    o.surface.dispatchEvent(new WheelEvent('wheel', {
      clientX: event.clientX, clientY: event.clientY, deltaX: event.deltaX, deltaY: event.deltaY,
      deltaMode: event.deltaMode, bubbles: true, cancelable: true,
    }));
  }, { passive: false });
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && enabled) setEnabled(false); });
  update();
  return { update, setEnabled };
}
