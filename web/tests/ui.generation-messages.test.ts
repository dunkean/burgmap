import { afterEach, describe, expect, it, vi } from 'vitest';
import { canWorkerExport, legacyGenerationResponse } from '../src/ui/generationMessages';
import { exportMeasure } from '../src/ui/exportMeasure';
import { makeOptions } from '../src/gen/options';
import type { World } from '../src/gen/types';
import type { GRequest, GResponse } from '../src/ui/protocol';
import type { WorkerRequest, WorkerResponse } from '../src/ui/worker';

const state = vi.hoisted(() => ({ world: null as World | null, measures: [] as number[] }));
vi.mock('../src/gen/pipeline', () => ({ generate: () => state.world, generateSettlementDetail: () => null }));
vi.mock('../src/render/svg', () => ({ renderSvg: (_world: World, options: { measure: (text: string, size: number, style: { italic: boolean; bold: boolean }) => number }) => {
  state.measures.push(options.measure('WWWW', 16, { italic: false, bold: false })); return '<svg/>';
} }));
vi.mock('../src/ui/megaQueue', () => ({ QuarterQueue: class {
  total = 2; cache = new Map(); stop(): void {} request(): void {}
  all(progress?: (done: number, total: number) => void) { progress?.(1, 2); progress?.(2, 2); return {}; }
} }));

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); state.world = null; state.measures.length = 0; });

describe('main-render generation worker export messages', () => {
  it('dispatches full-megacity export progress and completion before the legacy whole-World branch', async () => {
    const options = makeOptions({ seed: 'mega', size: 'city' });
    state.world = { options, mapSize: 1600, stats: {}, urban: { macro: { quarters: [{}, {}], cityR: 400 } } } as unknown as World;
    vi.stubGlobal('OffscreenCanvas', class {
      getContext() { return { font: '', measureText: (text: string) => ({ width: text === 'iiii' ? 12 : 60 }) }; }
    });
    const legacy: WorkerResponse[] = [], progress: number[] = [], exports: Blob[] = [], failures: string[] = [];
    let capability = false;
    const scope = { onmessage: null as ((event: MessageEvent<GRequest | WorkerRequest>) => void) | null, postMessage(message: WorkerResponse | GResponse): void {
      const r = legacyGenerationResponse(message, {
        capabilities: (ok) => { capability = ok; }, quarters: (m) => progress.push(m.done),
        exported: (m) => { if (m.blob) exports.push(m.blob); else failures.push(m.error ?? 'unknown'); },
      });
      if (r) legacy.push(r); // production's show() branch only sees untyped legacy messages
    } };
    vi.stubGlobal('self', scope); await import('../src/ui/worker');
    expect(capability).toBe(true); expect(canWorkerExport('svg', capability)).toBe(true);
    const send = (m: GRequest | WorkerRequest) => scope.onmessage!({ data: m } as MessageEvent<GRequest | WorkerRequest>);
    send({ id: 1, options }); expect(legacy).toHaveLength(1); expect(legacy[0].world).toBe(state.world);
    send({ type: 'export', id: 101, gen: 1, kind: 'svg', full: true, display: { style: 'parchment' } });
    expect(progress).toEqual([1, 2]); expect(exports).toHaveLength(1); expect(await exports[0].text()).toBe('<svg/>');
    expect(state.measures).toEqual([60]); expect(legacy).toHaveLength(1); expect(failures).toEqual([]);
    send({ type: 'export', id: 102, gen: 2, kind: 'svg', display: { style: 'parchment' } });
    expect(failures).toEqual(['the requested map is no longer available']); expect(legacy).toHaveLength(1);
  });

  it('uses page-native SVG measurement when the worker lacks usable text measurement, while JSON remains eligible', () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    expect(exportMeasure()).toBeNull(); expect(canWorkerExport('svg', false)).toBe(false); expect(canWorkerExport('json', false)).toBe(true);
    vi.stubGlobal('OffscreenCanvas', class { getContext(): object { return {}; } });
    expect(exportMeasure()).toBeNull();
    vi.stubGlobal('OffscreenCanvas', class { getContext() { return { measureText: () => ({ width: NaN }) }; } });
    expect(exportMeasure()).toBeNull();
  });

  it('consumes every typed message rather than passing it to show(undefined)', () => {
    const handlers = { exported: vi.fn(), quarters: vi.fn(), capabilities: vi.fn() };
    expect(legacyGenerationResponse({ type: 'stage', id: 1, stage: 'town' }, handlers)).toBeNull();
    expect(legacyGenerationResponse({ type: 'error', id: 1, error: 'failed' }, handlers)).toBeNull();
    const world = { id: 1, world: { options: makeOptions() } as World };
    expect(legacyGenerationResponse(world, handlers)).toBe(world);
  });
});
