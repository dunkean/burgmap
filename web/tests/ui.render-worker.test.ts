import { afterEach, describe, expect, it, vi } from 'vitest';
import type { World } from '../src/gen/types';
import type { PortMsg, RRequest, RResponse } from '../src/ui/protocol';

const recorded = vi.hoisted(() => ({ builds: [] as string[], draws: [] as string[], refreshed: [] as World[] }));
vi.mock('../src/gen/terrain/caverns', () => ({ refreshCavernMask: (world: World) => { recorded.refreshed.push(world); } }));
vi.mock('../src/render/sceneCache', () => ({ SceneBuilder: class { update(): object { return {}; } } }));
vi.mock('../src/render/canvas', () => ({ createCanvasRenderer: (_canvas: unknown, world: World) => {
  const seed = world.options.seed; recorded.builds.push(seed);
  if (seed === 'broken') throw new Error('scene construction failed');
  return {
    dispose: () => {}, setOverlays: () => {}, lastPlaced: () => [], drawMinimap: () => {},
    getMapInfo: () => ({ cartouche: { w: 10, h: 10, prims: [{ t: 'text', x: 0, y: 0, size: 10, s: seed, anchor: 'start', fill: '#000' }] }, legend: { w: 1, h: 1, prims: [] }, fontFamily: 'serif' }),
    draw: () => { recorded.draws.push(seed); return { ms: 1, band: 2, scale: 1 }; },
  };
} }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); recorded.builds.length = 0; recorded.draws.length = 0; recorded.refreshed.length = 0; });

describe('final-world-only render worker handoff', () => {
  it('refreshes the rock mask after lazy settlements and coalesced quarter arrivals before announcing the scene', async () => {
    vi.useFakeTimers();
    const responses: RResponse[] = [];
    const scope = { onmessage: null as ((event: MessageEvent<RRequest>) => void) | null, postMessage: (r: RResponse) => responses.push(r) };
    vi.stubGlobal('self', scope);
    await import('../src/ui/renderWorker');
    const port = { onmessage: null as ((e: MessageEvent<PortMsg>) => void) | null, close: vi.fn() };
    const send = (m: PortMsg) => port.onmessage!({ data: m } as MessageEvent<PortMsg>);
    scope.onmessage!({ data: { type: 'attach', gen: 1, port: port as unknown as MessagePort } } as MessageEvent<RRequest>);
    const world = { mapSize: 1600, options: { seed: 'cave', biome: 'underdark-caverns' }, site: { center: { x: 800, y: 800 } }, settlements: [{ index: 0 }] } as World;
    send({ type: 'world', gen: 1, world, final: true, stage: 'done' });
    const urban = { buildings: [] } as unknown as NonNullable<World['urban']>;
    send({ type: 'settlement', gen: 1, index: 0, urban, bridges: [] });
    expect(recorded.refreshed).toHaveLength(1);
    expect(recorded.refreshed[0].settlements![0].urban).toBe(urban);
    expect(responses.filter((r) => r.type === 'content')).toHaveLength(2);
    send({ type: 'quarters', gen: 1, layers: { 1: urban }, drop: [] });
    send({ type: 'quarters', gen: 1, layers: { 2: urban }, drop: [1] });
    expect(recorded.refreshed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(recorded.refreshed).toHaveLength(2);
    expect(recorded.refreshed[1].megaDetail).toEqual({ 2: urban });
    expect(responses.filter((r) => r.type === 'content')).toHaveLength(3);
    send({ type: 'quarters', gen: 0, layers: { 3: urban }, drop: [] });
    await vi.advanceTimersByTimeAsync(400);
    expect(recorded.refreshed).toHaveLength(2);
    scope.onmessage!({ data: { type: 'dispose' } } as MessageEvent<RRequest>);
  });

  it('retains the preceding renderer through stage snapshots and tags every bitmap with its actual generation', async () => {
    const responses: RResponse[] = [];
    const scope = { onmessage: null as ((event: MessageEvent<RRequest>) => void) | null, postMessage: (r: RResponse) => responses.push(r) };
    vi.stubGlobal('self', scope);
    vi.stubGlobal('Path2D', class {});
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(public width: number, public height: number) {}
      getContext(): object { return {}; }
      transferToImageBitmap(): ImageBitmap { return { close: vi.fn() } as unknown as ImageBitmap; }
    });
    await import('../src/ui/renderWorker');
    const send = (m: RRequest) => scope.onmessage!({ data: m } as MessageEvent<RRequest>);
    const port = () => {
      const p = { onmessage: null as ((e: MessageEvent<PortMsg>) => void) | null, close: vi.fn() };
      return { value: p as unknown as MessagePort, close: p.close, send: (m: PortMsg) => p.onmessage!({ data: m } as MessageEvent<PortMsg>) };
    };
    const world = (seed: string) => ({ mapSize: 1600, options: { seed, biome: 'temperate' }, site: { center: { x: seed === 'new' ? 1200 : 400, y: 800 } } }) as World;
    const view = (seq: number): RRequest => ({ type: 'view', seq, view: { cx: 800, cy: 800, scale: 1 }, w: 900, h: 700, dpr: 1, mini: 0 });
    send({ type: 'init', dpr: 1 });
    const old = port(); send({ type: 'attach', gen: 1, port: old.value });
    old.send({ type: 'world', gen: 1, world: world('old'), final: true, stage: 'done' }); send(view(1));
    const next = port(); send({ type: 'attach', gen: 2, port: next.value }); expect(old.close).toHaveBeenCalledOnce();
    next.send({ type: 'world', gen: 2, world: world('terrain-only'), final: false, stage: 'town' }); send(view(2));
    expect(recorded.builds).toEqual(['old']); expect(recorded.draws).toEqual(['old', 'old']);
    const frames = () => responses.filter((r) => r.type === 'frame');
    expect(frames().map((f) => f.gen)).toEqual([1, 1]);
    next.send({ type: 'world', gen: 1, world: world('obsolete'), final: true, stage: 'done' });
    next.send({ type: 'world', gen: 2, world: world('new'), final: true, stage: 'done' }); send(view(3));
    expect(recorded.builds).toEqual(['old', 'new']); expect(recorded.draws).toEqual(['old', 'old', 'new']);
    expect(frames().map((f) => f.gen)).toEqual([1, 1, 2]);
    const latest = responses.filter((r) => r.type === 'content').at(-1)!;
    expect(latest.gen).toBe(2); expect(latest.final).toBe(true); expect(frames().at(-1)!.ver).toBe(latest.ver);
    expect(latest.meta.center.x).toBe(1200);
    expect(latest.meta.mapInfo?.cartouche.prims).toContainEqual(expect.objectContaining({ s: 'new' }));
    expect(responses.filter((r) => r.type === 'content').map(r => r.meta.mapInfo?.cartouche.prims[0])).toEqual([
      expect.objectContaining({ s: 'old' }), expect.objectContaining({ s: 'new' }),
    ]);
    const failed = port(); send({ type: 'attach', gen: 3, port: failed.value });
    failed.send({ type: 'world', gen: 3, world: world('broken'), final: true, stage: 'done' }); send(view(4));
    expect(responses.filter((r) => r.type === 'error').at(-1)).toMatchObject({ gen: 3, error: expect.stringContaining('scene construction failed') });
    expect(frames().at(-1)!.gen).toBe(2); expect(recorded.draws.at(-1)).toBe('new');
    expect(next.close).toHaveBeenCalledOnce();
    send({ type: 'dispose' }); expect(failed.close).toHaveBeenCalledOnce();
  });
});
