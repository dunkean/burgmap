import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { World, UrbanLayer } from '../src/gen/types';
import * as detail from '../src/gen/urban/mega/detail';
import { QuarterQueue, type QuarterExecutor, type QueueStats } from '../src/ui/megaQueue';
import { QuarterPool, worldForQuarters, type QuarterRequest, type QuarterResult, type QuarterWorkerHandle } from '../src/ui/quarterPoolCore';

const layer = (key: number): UrbanLayer => ({
  footprint: [], footprintH: [], streets: [], blocks: [], parcels: [], buildings: [], walls: [],
  landmarks: [], squares: [], blockInfo: [], masses: [], backLand: [], archetype: 'town', population: key, morphology: 'test', phases: [], quarters: [],
});
function fixture(n = 8): World {
  const grid = { w: 2, h: 2, cell: 10, data: new Float32Array(4) };
  const fields = { hab: new Float32Array(4) };
  return {
    seed: 'test', options: { seed: 'test' }, mapSize: 2000,
    terrain: { height: grid, slope: grid, water: new Uint8Array(4), flow: grid, receiver: new Int32Array(4), filled: new Float32Array(4), rivers: [], lakes: [], coastline: [] },
    site: { center: { x: 0, y: 0 }, cost: grid, fields }, roads: [], bridges: [],
    urban: { ...layer(0), macro: { center: { x: 0, y: 0 }, quarters: Array.from({ length: n }, (_, id) => ({
      id, bb: [id * 100, 0, id * 100 + 40, 40], phase: 1, nucleus: 0, kind: 'quarter', district: 'old-town',
    })) } }, stats: { 'ms.total': 1 }, debug: { giant: true }, landuse: { areas: [] }, names: {}, megaDetail: { 3: layer(3) },
  } as unknown as World;
}
const rect = (id: number) => ({ x0: id * 100, x1: id * 100 + 40, y0: 0, y1: 40 });
const wide = { x0: 0, x1: 740, y0: 0, y1: 40 };
class ControlledExecutor implements QuarterExecutor {
  concurrency = 2;
  jobs = new Map<number, { resolve: (l: UrbanLayer | null) => void; reject: (e: Error) => void }>();
  setWorld = vi.fn();
  stop = vi.fn(() => { for (const job of this.jobs.values()) job.reject(new Error('stopped')); this.jobs.clear(); });
  run = vi.fn((key: number) => new Promise<UrbanLayer | null>((resolve, reject) => { this.jobs.set(key, { resolve, reject }); }));
  finish(key: number): void { const job = this.jobs.get(key)!; this.jobs.delete(key); job.resolve(layer(key)); }
  fail(key: number): void { const job = this.jobs.get(key)!; this.jobs.delete(key); job.reject(new Error('worker unavailable')); }
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded view-prioritized quarter loading', () => {
  it('prioritizes nearest visible quarters, limits concurrency, and keeps a hard cache cap for a broad view', async () => {
    const executor = new ControlledExecutor(), emit = vi.fn();
    const q = new QuarterQueue(fixture(), emit, 3, 20, executor);
    q.request(wide);
    await vi.advanceTimersByTimeAsync(1);
    expect(executor.run.mock.calls.map(([k]) => k)).toEqual([3, 4]);
    expect(executor.jobs.size).toBe(2);
    executor.finish(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(executor.run.mock.calls.map(([k]) => k)).toEqual([3, 4, 2]);
    executor.finish(2); executor.finish(3);
    await vi.advanceTimersByTimeAsync(25);
    expect([...q.cache.keys()].sort()).toEqual([2, 3, 4]);
    expect(q.cache.size).toBe(3);
    expect(executor.run).toHaveBeenCalledTimes(3);
    expect(emit.mock.lastCall![2]).toMatchObject({ done: 3, queued: 0, total: 8, failed: 0 });
    q.stop();
  });

  it('discards abandoned view results and never duplicates an in-flight quarter', async () => {
    const executor = new ControlledExecutor(), emit = vi.fn();
    const q = new QuarterQueue(fixture(), emit, 2, 20, executor);
    q.request(rect(0)); await vi.advanceTimersByTimeAsync(1);
    q.request(rect(7)); q.request(rect(7)); await vi.advanceTimersByTimeAsync(1);
    expect(executor.run.mock.calls.map(([k]) => k)).toEqual([0, 7]);
    executor.finish(0); executor.finish(7);
    await vi.advanceTimersByTimeAsync(25);
    expect([...q.cache.keys()]).toEqual([7]);
    expect(emit.mock.calls.flatMap(([layers]) => Object.keys(layers))).toEqual(['7']);
    q.stop();
  });

  it('evicts old cached quarters and delivers matching renderer drops', async () => {
    const executor = new ControlledExecutor();
    const seen = new Map<number, UrbanLayer>();
    const emit = (layers: Record<number, UrbanLayer>, drops: number[], _st: QueueStats) => {
      for (const [id, l] of Object.entries(layers)) seen.set(Number(id), l);
      for (const id of drops) seen.delete(id);
    };
    const q = new QuarterQueue(fixture(), emit, 2, 20, executor);
    q.request({ x0: 0, x1: 140, y0: 0, y1: 40 }); await vi.advanceTimersByTimeAsync(1);
    executor.finish(0); executor.finish(1); await vi.advanceTimersByTimeAsync(25);
    q.request(rect(7)); await vi.advanceTimersByTimeAsync(1);
    executor.finish(7); await vi.advanceTimersByTimeAsync(25);
    expect(q.cache.size).toBe(2);
    expect([...seen.keys()]).toEqual([...q.cache.keys()]);
    expect(seen.has(7)).toBe(true);
    q.stop();
  });

  it('retries on the sliced generator when a worker is refused, without losing the visible request', async () => {
    const generate = vi.spyOn(detail, 'megaQuarterDetail').mockImplementation((_w, key) => layer(key));
    const executor = new ControlledExecutor(), emit = vi.fn();
    const q = new QuarterQueue(fixture(), emit, 3, 20, executor);
    q.request(wide); await vi.advanceTimersByTimeAsync(1);
    executor.fail(3); await vi.advanceTimersByTimeAsync(30);
    expect(executor.stop).toHaveBeenCalledOnce();
    expect(generate.mock.calls.map(([, key]) => key)).toEqual([3, 4, 2]);
    expect(q.cache.size).toBe(3);
    expect(emit.mock.lastCall![2]).toMatchObject({ queued: 0, failed: 0 });
    q.stop();
  });

  it('stops all work on reroll and accepts neither delayed callbacks nor new requests', async () => {
    const executor = new ControlledExecutor(), emit = vi.fn();
    const q = new QuarterQueue(fixture(), emit, 3, 20, executor);
    q.request(wide); await vi.advanceTimersByTimeAsync(1);
    q.stop(); q.request(rect(7)); q.prefetch();
    await vi.advanceTimersByTimeAsync(100);
    expect(q.cache.size).toBe(0);
    expect(executor.run).toHaveBeenCalledTimes(2);
    expect(emit).not.toHaveBeenCalled();
  });

  it('retains generated quarters when an additive secondary plan arrives and refreshes the executor world', async () => {
    const executor = new ControlledExecutor();
    const w = fixture(), q = new QuarterQueue(w, () => {}, 2, 20, executor);
    q.request(rect(0)); await vi.advanceTimersByTimeAsync(1);
    executor.finish(0); await vi.advanceTimersByTimeAsync(25);
    const next = { ...w, settlements: [{ index: 1, main: false, urban: w.urban }] } as World;
    q.setWorld(next);
    expect(executor.setWorld).toHaveBeenCalledWith(next);
    expect(q.cache.get(0)?.population).toBe(0);
    q.request({ x0: 0, x1: 40, y0: 0, y1: 40 }); await vi.advanceTimersByTimeAsync(1);
    expect(executor.run.mock.calls.map(([k]) => k)).toEqual([0, detail.megaKey(1, 0)]);
    q.stop();
  });

  it('reports actual unavailable quarters and does not spin on deterministic generator failures', async () => {
    const generate = vi.spyOn(detail, 'megaQuarterDetail').mockImplementation(() => { throw new Error('invalid geometry'); });
    const emit = vi.fn(), q = new QuarterQueue(fixture(), emit, 2, 20);
    q.request(rect(0)); await vi.advanceTimersByTimeAsync(30);
    q.request(rect(0)); await vi.advanceTimersByTimeAsync(30);
    expect(generate).toHaveBeenCalledOnce();
    expect(emit.mock.lastCall![2]).toMatchObject({ queued: 0, failed: 1 });
    q.stop();
  });

  it('retries a worker-local quarter failure once using the complete World', async () => {
    const generate = vi.spyOn(detail, 'megaQuarterDetail').mockImplementation((_w, key) => layer(key));
    const executor = new ControlledExecutor(), emit = vi.fn(), w = fixture();
    const q = new QuarterQueue(w, emit, 2, 20, executor);
    q.request(rect(0)); await vi.advanceTimersByTimeAsync(1);
    executor.jobs.get(0)!.resolve(null); executor.jobs.delete(0);
    await vi.advanceTimersByTimeAsync(30);
    expect(generate).toHaveBeenCalledOnce(); expect(generate).toHaveBeenCalledWith(w, 0);
    expect(q.cache.get(0)?.population).toBe(0);
    expect(emit.mock.lastCall![2]).toMatchObject({ queued: 0, failed: 0 });
    q.request(rect(0)); await vi.advanceTimersByTimeAsync(30);
    expect(executor.run).toHaveBeenCalledOnce(); expect(generate).toHaveBeenCalledOnce();
    q.stop();
  });

  it('keeps full-detail export independent of the interactive cap', () => {
    vi.spyOn(detail, 'megaQuarterDetail').mockImplementation((_w, key) => layer(key));
    const q = new QuarterQueue(fixture(), () => {}, 2), progress = vi.fn();
    expect(Object.keys(q.all(progress))).toHaveLength(8);
    expect(q.cache.size).toBe(0);
    expect(progress.mock.lastCall).toEqual([8, 8]);
    q.stop();
  });
});

class FakeWorker implements QuarterWorkerHandle {
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  onmessageerror: Worker['onmessageerror'] = null;
  messages: QuarterRequest[] = [];
  terminate = vi.fn();
  postMessage(message: unknown): void { this.messages.push(message as QuarterRequest); }
  reply(layer: UrbanLayer | null, patch: Partial<QuarterResult> = {}): void {
    const req = this.messages.at(-1)!;
    if (req.type !== 'quarter') throw new Error('no job');
    this.onmessage?.call(this as unknown as Worker, { data: { ...req, layer, ...patch } } as MessageEvent<QuarterResult>);
  }
}

describe('quarter worker lifetime and snapshots', () => {
  it('copies only needed inputs, keeping analysis cost/fields and stable secondary indices', () => {
    const w = fixture(), eager = layer(23);
    w.settlements = [{ index: 0, main: true }, { index: 1, urban: eager }, { index: 2, urban: w.urban }] as World['settlements'];
    const snapshot = worldForQuarters(w);
    expect(snapshot.site?.cost).toBe(w.site?.cost);
    expect(snapshot.site?.fields).toBe(w.site?.fields);
    expect(snapshot.terrain.height).toBe(w.terrain.height);
    expect(snapshot.terrain.water).toBe(w.terrain.water);
    expect(snapshot.settlements?.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(snapshot.settlements?.[1].urban).toBeUndefined();
    expect(snapshot.settlements?.[2].urban).toBe(w.urban);
    expect(snapshot.terrain.flow).toBeUndefined();
    expect(snapshot.landuse).toBeUndefined(); expect(snapshot.names).toBeUndefined();
    expect(snapshot.debug).toBeUndefined(); expect(snapshot.megaDetail).toBeUndefined();
    expect(w.terrain.flow).toBeDefined(); expect(w.megaDetail).toBeDefined();
  });

  it('initializes at most two workers and reuses their world for subsequent jobs', async () => {
    const workers: FakeWorker[] = [];
    const pool = new QuarterPool(fixture(), () => { const w = new FakeWorker(); workers.push(w); return w; }, 20);
    const p0 = pool.run(0), p1 = pool.run(1);
    expect(workers).toHaveLength(2); expect(pool.concurrency).toBe(2);
    workers[1].reply(layer(1)); workers[0].reply(layer(0));
    expect((await p0)?.population).toBe(0); expect((await p1)?.population).toBe(1);
    const p2 = pool.run(2); workers[0].reply(layer(2)); await p2;
    expect(workers[0].messages.filter((m) => m.type === 'world')).toHaveLength(1);
    pool.stop(); expect(workers.every((w) => w.terminate.mock.calls.length === 1)).toBe(true);
  });

  it('ignores wrong job/revision results and updates idle workers for additive plans', async () => {
    const worker = new FakeWorker(), pool = new QuarterPool(fixture(), () => worker, 1);
    const p = pool.run(0), resolved = vi.fn(); void p.then(resolved);
    worker.reply(layer(999), { revision: -1 }); worker.reply(layer(999), { job: -1 });
    await Promise.resolve(); expect(resolved).not.toHaveBeenCalled();
    pool.setWorld(fixture(10)); worker.reply(layer(0)); await p;
    const p1 = pool.run(1);
    expect(worker.messages.filter((m) => m.type === 'world').map((m) => m.revision)).toEqual([1, 2]);
    worker.reply(layer(1)); await p1; pool.stop();
  });

  it('does not reclone the World for unchanged hosts or ordinary settlement details', async () => {
    const w = fixture(), worker = new FakeWorker(), pool = new QuarterPool(w, () => worker, 1);
    const first = pool.run(0); worker.reply(layer(0)); await first;
    pool.setWorld(w);
    w.settlements = [{ index: 1, main: false, urban: layer(1) }] as World['settlements'];
    pool.setWorld(w);
    const second = pool.run(1); worker.reply(layer(1)); await second;
    expect(worker.messages.filter((m) => m.type === 'world')).toHaveLength(1);
    w.settlements!.push({ index: 2, main: false, urban: { ...layer(2), macro: fixture(3).urban!.macro } } as NonNullable<World['settlements']>[number]);
    pool.setWorld(w);
    const third = pool.run(detail.megaKey(2, 0)); worker.reply(layer(2)); await third;
    expect(worker.messages.filter((m) => m.type === 'world').map((m) => m.revision)).toEqual([1, 2]);
    pool.stop();
  });

  it('rejects all pending jobs and terminates workers after a transport failure', async () => {
    const workers: FakeWorker[] = [];
    const pool = new QuarterPool(fixture(), () => { const w = new FakeWorker(); workers.push(w); return w; });
    const results = Promise.allSettled([pool.run(0), pool.run(1)]);
    workers[0].onerror?.call(workers[0] as unknown as Worker, new Event('error') as ErrorEvent);
    expect((await results).map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(workers.every((w) => w.terminate.mock.calls.length === 1)).toBe(true);
    await expect(pool.run(2)).rejects.toThrow('stopped');
  });

  it('keeps parallel loading alive after a per-quarter geometry error', async () => {
    const generate = vi.spyOn(detail, 'megaQuarterDetail').mockImplementation(() => { throw new Error('invalid quarter geometry'); });
    const workers: FakeWorker[] = [];
    const pool = new QuarterPool(fixture(), () => { const w = new FakeWorker(); workers.push(w); return w; });
    const emit = vi.fn(), q = new QuarterQueue(fixture(), emit, 3, 20, pool);
    q.request(wide); await vi.advanceTimersByTimeAsync(1);
    workers[0].reply(null, { error: 'invalid quarter geometry' });
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0].messages.at(-1)).toMatchObject({ type: 'quarter', key: 2 });
    workers[0].reply(layer(2)); workers[1].reply(layer(4));
    await vi.advanceTimersByTimeAsync(25);
    expect([...q.cache.keys()].sort()).toEqual([2, 4]);
    expect(emit.mock.lastCall![2]).toMatchObject({ queued: 0, failed: 1 });
    expect(generate).toHaveBeenCalledOnce();
    expect(workers.every((w) => w.terminate.mock.calls.length === 0)).toBe(true);
    q.stop();
  });

  it('treats a missing worker World as a transport failure', async () => {
    const worker = new FakeWorker(), pool = new QuarterPool(fixture(), () => worker, 1);
    const result = Promise.allSettled([pool.run(0)]);
    worker.reply(null, { error: 'quarter world not ready', fatal: true });
    expect((await result)[0].status).toBe('rejected');
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('times out a silent worker and rejects a refused constructor without hanging', async () => {
    const worker = new FakeWorker(), pool = new QuarterPool(fixture(), () => worker, 1, 30);
    const result = Promise.allSettled([pool.run(0)]);
    await vi.advanceTimersByTimeAsync(31);
    expect((await result)[0].status).toBe('rejected'); expect(worker.terminate).toHaveBeenCalledOnce();
    const refused = new QuarterPool(fixture(), () => { throw new Error('refused'); });
    await expect(refused.run(0)).rejects.toThrow('refused');
  });
});
