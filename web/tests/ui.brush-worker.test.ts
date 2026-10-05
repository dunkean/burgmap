import { afterEach, describe, expect, it, vi } from 'vitest';
import type { World } from '../src/gen/types';
import type { BrushImages } from '../src/render/brushes';
import type { RRequest, RResponse, PortMsg } from '../src/ui/protocol';

const state = vi.hoisted(() => ({ resolve: null as null | ((images: BrushImages | null) => void), builds: [] as { seed: string; painted: boolean }[] }));
vi.mock('../src/render/brushes', () => ({ decodeBrushes: () => new Promise(resolve => { state.resolve = resolve; }) }));
vi.mock('../src/render/sceneCache', () => ({ SceneBuilder: class { update(): object { return {}; } } }));
vi.mock('../src/render/canvas', () => ({ createCanvasRenderer: (_c: unknown, world: World, _style: unknown, deps: { brushes?: BrushImages }) => {
  state.builds.push({ seed: world.seed, painted: !!deps.brushes });
  return { dispose: vi.fn(), setOverlays: vi.fn(), getMapInfo: () => ({ cartouche: { w: 10, h: 10, prims: [{ t: 'text', x: 0, y: 0, size: 10, s: world.seed, anchor: 'start', fill: '#000' }] }, legend: { w: 1, h: 1, prims: [] }, fontFamily: 'serif' }), lastPlaced: () => [], draw: () => ({ ms: 0, band: 2, scale: 1 }) };
} }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); state.resolve = null; state.builds.length = 0; });

async function worker() {
  const messages: RResponse[] = [], scope = { onmessage: null as ((e: MessageEvent<RRequest>) => void) | null, postMessage: (r: RResponse) => messages.push(r) };
  vi.stubGlobal('self', scope); vi.stubGlobal('Path2D', class {});
  vi.stubGlobal('OffscreenCanvas', class { constructor(public width: number, public height: number) {} getContext(): object { return {}; } transferToImageBitmap(): object { return {}; } });
  await import('../src/ui/renderWorker');
  const send = (data: RRequest): void => scope.onmessage!({ data } as MessageEvent<RRequest>);
  const attach = (gen: number, seed: string): void => {
    const port = { onmessage: null as ((e: MessageEvent<PortMsg>) => void) | null, close: vi.fn() };
    send({ type: 'attach', gen, port: port as unknown as MessagePort });
    port.onmessage!({ data: { type: 'world', gen, final: true, stage: 'done', world: { seed, options: { seed, biome: 'temperate' }, mapSize: 1600 } as World } } as MessageEvent<PortMsg>);
  };
  send({ type: 'init', dpr: 1 }); return { send, attach, messages };
}
const sources = { version: 'test', vegetation: 'data:x', terrain: 'data:y' };
describe('asynchronous painted appearance handoff', () => {
  it('applies a completed decode only to the current display and current generation', async () => {
    const w = await worker();
    w.send({ type: 'brushes', sources }); w.send({ type: 'display', display: { style: 'parchment', painted: true } });
    w.attach(1, 'previous'); w.attach(2, 'current');
    w.send({ type: 'display', display: { style: 'night' } });
    const images = { sources, vegetation: {}, terrain: {} } as BrushImages;
    state.resolve!(images); await Promise.resolve(); await Promise.resolve();
    expect(state.builds.at(-1)).toEqual({ seed: 'current', painted: false });
    w.send({ type: 'display', display: { style: 'night', painted: true } });
    expect(state.builds.at(-1)).toEqual({ seed: 'current', painted: true });
    const content = w.messages.filter(m => m.type === 'content').at(-1)!; expect(content.gen).toBe(2);
    expect(content.meta.mapInfo?.cartouche.prims).toContainEqual(expect.objectContaining({ s: 'current' }));
    w.send({ type: 'view', seq: 1, view: { cx: 800, cy: 800, scale: 1.5 }, w: 900, h: 700, dpr: 2, mini: 0 });
    expect(w.messages.filter(m => m.type === 'frame').at(-1)).toMatchObject({ gen: 2, ver: content.ver, dpr: 2 });
  });
  it('releases a decode completing after disposal and keeps failed decoding classic', async () => {
    const w = await worker(), close = vi.fn(); w.send({ type: 'brushes', sources }); w.send({ type: 'dispose' });
    state.resolve!({ sources, vegetation: { close }, terrain: { close } } as unknown as BrushImages); await Promise.resolve(); await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(2); expect(w.messages.some(m => m.type === 'brushStatus')).toBe(false);
  });
  it('reports failed decoding without a render error or painted renderer', async () => {
    const w = await worker(); w.send({ type: 'brushes', sources }); w.send({ type: 'display', display: { style: 'parchment', painted: true } }); w.attach(1, 'classic-fallback');
    state.resolve!(null); await Promise.resolve(); await Promise.resolve();
    expect(w.messages).toContainEqual({ type: 'brushStatus', ready: false });
    expect(w.messages.some(m => m.type === 'error')).toBe(false); expect(state.builds.every(b => !b.painted)).toBe(true);
  });
});
