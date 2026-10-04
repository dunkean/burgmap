import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinalFrame } from '../src/ui/finalFrame';
import { FrameHandoff } from '../src/ui/frameHandoff';
import { createViewer } from '../src/ui/viewer';
import { exportSnapshot } from '../src/ui/exportSnapshot';
import { makeOptions } from '../src/gen/options';
import type { PresentedFrame, FrameRequest } from '../src/ui/viewer';
import type { World } from '../src/gen/types';
import type { CanvasRenderer } from '../src/render/canvas';
import { worldMeta } from '../src/ui/worldMeta';

afterEach(() => vi.unstubAllGlobals());

describe('final bitmap readiness', () => {
  it('keeps generated content pending until its matching bitmap is presented', () => {
    const state = new FinalFrame(); state.begin(7); state.generated(7);
    state.content(7, 10, false); state.presented(7, 10); expect(state.ready).toBe(false);
    state.content(7, 11, true); expect(state.ready).toBe(false);
    state.presented(7, 10); expect(state.ready).toBe(false);
    state.presented(7, 11); expect(state.ready).toBe(true);
  });
  it('handles generation completion arriving after the final frame and excludes superseded runs', () => {
    const state = new FinalFrame(); state.begin(2); state.content(2, 8, true); state.presented(2, 8);
    expect(state.ready).toBe(false); state.generated(2); expect(state.ready).toBe(true);
    state.begin(3); state.generated(2); state.content(2, 99, true); state.presented(2, 99);
    state.generated(3); state.content(3, 9, true); expect(state.ready).toBe(false);
    state.presented(3, 9); expect(state.ready).toBe(true);
  });
  it('requires the latest announced scene when display or detail rebuilds before the answer', () => {
    const state = new FinalFrame(); state.begin(1); state.generated(1); state.content(1, 5, true); state.content(1, 6, true);
    state.presented(1, 5); expect(state.ready).toBe(false); state.presented(1, 6); expect(state.ready).toBe(true);
  });
});

function harness(bitmapContext = true, withMinimap = false, asyncMode = true) {
  const callbacks = new Map<number, FrameRequestCallback>(); let next = 0;
  vi.stubGlobal('window', { devicePixelRatio: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} });
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { callbacks.set(++next, f); return next; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  const transfer = vi.fn(), drawImage = vi.fn();
  const container = { getBoundingClientRect: () => ({ width: 900, height: 700 }), addEventListener: vi.fn() };
  const canvas = { width: 900, height: 700, style: {}, addEventListener: vi.fn(), getContext: (kind: string) => kind === 'bitmaprenderer' ? bitmapContext ? { transferFromImageBitmap: transfer } : null : { drawImage }, classList: { add: vi.fn(), remove: vi.fn() } };
  const miniDraw = vi.fn();
  const minimap = { width: 140, height: 140, clientWidth: 140, addEventListener: vi.fn(), getContext: () => ({ setTransform: vi.fn(), clearRect: vi.fn(), drawImage: miniDraw, strokeRect: vi.fn() }) };
  const requests: FrameRequest[] = [];
  const onFrame = vi.fn(), onError = vi.fn();
  const viewer = createViewer({ container: container as unknown as HTMLElement, canvas: canvas as unknown as HTMLCanvasElement, minimap: withMinimap ? minimap as unknown as HTMLCanvasElement : undefined, onFrame, onError });
  if (asyncMode) viewer.setSource({ request: (r) => requests.push(r) });
  const tick = () => { const pending = [...callbacks.values()]; callbacks.clear(); for (const f of pending) f(0); };
  const frame = (request: FrameRequest): PresentedFrame => {
    const { mini: _mini, ...rest } = request;
    return { ...rest, bitmap: { close: vi.fn() } as unknown as ImageBitmap, ms: 1, band: 2, scale: request.view.scale };
  };
  return { viewer, requests, transfer, drawImage, miniDraw, onFrame, onError, tick, frame };
}

describe('preserving the previous displayed map', () => {
  it.each([{ when: 'before', early: true, failed: false }, { when: 'after', early: false, failed: false }, { when: 'after', early: false, failed: true }])('promotes an intermediate map announced $when begin3 (failed3=$failed), keeping its real metadata', ({ early, failed }) => {
    const state = new FrameHandoff(), h = harness(true, true);
    const data = (id: number) => worldMeta({ mapSize: 1600, site: { center: { x: id * 100, y: 800 } }, names: { entries: [{ kind: 'town', anchor: { x: id * 100, y: 800 } }] } } as unknown as World);
    const deliver = (gen: number, ver: number) => {
      const f = { ...h.frame(h.requests.at(-1)!), mini: { close: vi.fn() } as unknown as ImageBitmap };
      const shown = h.viewer.present(f, state.acceptsFrame(gen, ver));
      if (shown) state.presented(gen, ver);
      h.tick(); return { f, shown };
    };
    state.begin(1); state.content(1, 4, true, data(1)); state.final.generated(1);
    h.viewer.contentChanged(1600, false); h.tick(); deliver(1, 4);
    state.begin(2);
    if (early) state.content(2, 7, true, data(2));
    state.begin(3);
    if (!early) {
      expect(state.acceptsFrame(2, 7)).toBe(false); // no known content/version for this intermediate generation yet
      state.content(2, 7, true, data(2));
    }
    h.viewer.contentChanged(1600, true); h.tick();
    expect(deliver(2, 7).shown).toBe(true); expect(state.displayedGen).toBe(2);
    expect(state.displayedMeta!.center.x).toBe(200); expect(state.displayedMeta!.anchors.town[0].x).toBe(200);
    expect(state.final.gen).toBe(3); expect(state.final.finalVer).toBe(0); expect(state.final.presentedVer).toBe(0); expect(state.final.ready).toBe(false);
    state.final.generated(3);
    h.viewer.setView({ cx: 800, cy: 800, scale: 2 }); h.tick();
    state.content(2, 8, true, data(2)); h.viewer.contentChanged(1600, true, '#369'); h.tick();
    const stale = deliver(2, 7); expect(stale.shown).toBe(false); expect(stale.f.bitmap!.close).toHaveBeenCalledOnce(); expect(stale.f.mini!.close).toHaveBeenCalledOnce();
    const styled = deliver(2, 8); expect(styled.shown).toBe(true); expect(h.miniDraw).toHaveBeenLastCalledWith(styled.f.mini, 0, 0, 140, 140);
    // Pending or failed gen3 has no final bitmap. Gen2 remains drawn; export3 is refused even if busy has cleared.
    expect(state.final.ready).toBe(false); expect(state.displayedMeta!.center.x).toBe(200);
    expect(() => exportSnapshot(makeOptions({ seed: 'gen3' }), null, 3, state.displayedGen)).toThrow('not been presented');
    h.viewer.setView({ cx: 750, cy: 800, scale: 2 }); h.tick(); expect(deliver(2, 8).shown).toBe(true);
    if (failed) { h.viewer.destroy(); return; } // the actual gen3 build-failure/rollback is exercised in ui.render-worker.test.ts
    state.content(3, 9, true, data(3)); h.viewer.contentChanged(1600, true); h.tick();
    expect(state.final.ready).toBe(false); expect(state.displayedMeta!.center.x).toBe(200);
    expect(deliver(3, 9).shown).toBe(true); expect(state.final.ready).toBe(true); expect(state.displayedMeta!.center.x).toBe(300);
    expect(state.acceptsContent(2)).toBe(false); expect(state.acceptsFrame(2, 99)).toBe(false); h.viewer.destroy();
  });
  it('redraws and restyles the displayed generation, including its minimap, while the next map is busy', () => {
    const state = new FrameHandoff(), h = harness(true, true);
    const present = (gen: number, ver: number, mini = false) => {
      const f = { ...h.frame(h.requests.at(-1)!), mini: mini ? { close: vi.fn() } as unknown as ImageBitmap : undefined };
      const shown = h.viewer.present(f, state.acceptsFrame(gen, ver));
      if (shown) state.presented(gen, ver);
      h.tick(); return f;
    };
    state.begin(1); state.final.generated(1); state.content(1, 4, true);
    h.viewer.contentChanged(1600, false); h.tick(); present(1, 4, true);
    state.begin(2);
    h.viewer.setView({ cx: 800, cy: 800, scale: 2 }); h.tick(); present(1, 4);
    expect(state.final.ready).toBe(false); expect(state.final.presentedVer).toBe(0); expect(h.transfer).toHaveBeenCalledTimes(2);
    expect(state.acceptsContent(1)).toBe(true); state.content(1, 5, true);
    expect(state.acceptsFrame(1, 4)).toBe(false);
    h.viewer.contentChanged(1600, true, '#369'); h.tick(); const styled = present(1, 5, true);
    expect(h.transfer).toHaveBeenCalledTimes(3); expect(h.miniDraw).toHaveBeenLastCalledWith(styled.mini, 0, 0, 140, 140);
    expect(state.final.finalVer).toBe(0); expect(state.final.ready).toBe(false);
    state.final.generated(2); state.content(2, 6, true); h.viewer.contentChanged(1600, true); h.tick(); present(2, 6, true);
    expect(state.final.ready).toBe(true); expect(state.displayedGen).toBe(2);
    expect(state.acceptsFrame(1, 99)).toBe(false); expect(state.acceptsContent(1)).toBe(false);
    h.viewer.destroy();
  });
  it('drops an obsolete bitmap without blanking the old image or blocking the final request', () => {
    const h = harness(); h.viewer.contentChanged(1600, false); h.tick();
    expect(h.viewer.present(h.frame(h.requests[0]))).toBe(true); h.tick();
    h.viewer.setView({ cx: 800, cy: 800, scale: 1 }); h.tick();
    const stale = h.frame(h.requests[1]);
    h.viewer.contentChanged(2400, true); h.tick();
    expect(h.viewer.present(stale, false)).toBe(false); expect(stale.bitmap!.close).toHaveBeenCalledOnce();
    expect(h.transfer).toHaveBeenCalledTimes(1); h.tick();
    expect(h.requests).toHaveLength(3); expect(h.viewer.present(h.frame(h.requests[2]))).toBe(true);
    expect(h.transfer).toHaveBeenCalledTimes(2); h.viewer.destroy();
  });
  it('presents through 2d when bitmaprenderer is unavailable and never counts an empty response', () => {
    const h = harness(false); h.viewer.contentChanged(1600, false); h.tick();
    const f = h.frame(h.requests[0]);
    expect(h.viewer.present({ ...f, bitmap: undefined })).toBe(false);
    expect(h.viewer.present(f)).toBe(true); expect(h.drawImage).toHaveBeenCalledOnce(); expect(f.bitmap!.close).toHaveBeenCalledOnce(); h.viewer.destroy();
  });
  it('reports a failed synchronous final draw without claiming a frame, and can recover on a later redraw', () => {
    const h = harness(true, false, false), draw = vi.fn((): { ms: number; band: 2; scale: number } => { throw new Error('draw failed'); });
    const renderer = { draw, dispose: vi.fn() } as unknown as CanvasRenderer;
    h.viewer.setRenderer(renderer, 1600, false); h.tick();
    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'draw failed' })); expect(h.onFrame).not.toHaveBeenCalled();
    draw.mockImplementation(() => ({ ms: 1, band: 2, scale: 1 }));
    h.viewer.invalidate(); h.tick(); expect(h.onFrame).toHaveBeenCalledOnce(); h.viewer.destroy();
  });
  it('captures export identity and style before reroll and control edits', () => {
    const options = makeOptions({ seed: 'old', size: 'village', style: 'parchment', labels: true });
    const saved = exportSnapshot(options, null, 4, 4);
    options.seed = 'new'; options.style = 'atlas'; options.labels = false;
    expect(saved.name).toBe('burgmap-old-village'); expect(saved.gen).toBe(4);
    expect(saved.display.style).toBe('parchment'); expect(saved.display.labels).toBe(true);
  });
  it('refuses a failed generation B instead of renaming the still-presented World A', () => {
    const a = makeOptions({ seed: 'A', size: 'village' }), b = makeOptions({ seed: 'B', size: 'village' });
    const worldA = { options: a } as World;
    // The same capture used by main receives only generations recorded by its successful draw callback.
    expect(exportSnapshot(a, worldA, 1, 1).name).toBe('burgmap-A-village');
    expect(() => exportSnapshot(b, worldA, 2, 1)).toThrow('not been presented');
    expect(() => exportSnapshot(b, worldA, 2, 2)).toThrow('not been presented');
  });
});
