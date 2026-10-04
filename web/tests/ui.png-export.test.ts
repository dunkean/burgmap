import { describe, expect, it, vi } from 'vitest';
import { encodeBitmap, type PngResponse } from '../src/ui/pngRaster';
import { exportPng } from '../src/ui/pngExport';

vi.mock('../src/ui/pngWorker?worker&inline', () => ({ default: class {} }));

const bitmap = () => ({ close: vi.fn() }) as unknown as ImageBitmap;
const image = { width: 3000, height: 3000 } as HTMLImageElement;
class FakeWorker {
  onmessage: ((e: MessageEvent<PngResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminate = vi.fn();
  sent: unknown[] = [];
  constructor(private fail = false, private refuseTransfer = false) { queueMicrotask(() => this.emit({ type: 'ready', ok: true })); }
  emit(data: PngResponse): void { this.onmessage?.({ data } as MessageEvent<PngResponse>); }
  postMessage(m: unknown, transfer: unknown[]): void {
    if (this.refuseTransfer) throw new Error('transfer refused');
    this.sent = [m, transfer];
    queueMicrotask(() => {
      this.emit({ type: 'progress', phase: 'raster' }); this.emit({ type: 'progress', phase: 'encode' });
      this.emit(this.fail ? { type: 'done', error: 'encoding failed' } : { type: 'done', blob: new Blob(['worker png'], { type: 'image/png' }) });
    });
  }
}

function nativeCanvas(encodeFail = false) {
  const drawImage = vi.fn(), yieldPage = vi.fn(async () => {});
  const toBlob = vi.fn((f: (b: Blob | null) => void) => f(encodeFail ? null : new Blob(['fallback png'], { type: 'image/png' })));
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob };
  return { canvas: vi.fn(() => canvas as unknown as HTMLCanvasElement), yield: yieldPage, drawImage, toBlob, value: canvas };
}

describe('native SVG raster with PNG encoding off the interactive thread', () => {
  it('snapshots the whole native canvas, yielding before draw and snapshot, then transfers these exact pixels', async () => {
    const worker = new FakeWorker(), b = bitmap(), f = nativeCanvas(), flow: string[] = [];
    f.drawImage.mockImplementation(() => { flow.push('draw'); });
    f.yield.mockImplementation(async () => { flow.push('yield'); });
    const snapshot = vi.fn(async (source: HTMLCanvasElement) => {
      expect(source).toBe(f.value); expect(source.width).toBe(3000); expect(source.height).toBe(3000);
      flow.push('bitmap'); return b;
    });
    const result = await exportPng(new Blob(['svg']), 3000, (p) => flow.push(p), { ...f, worker: () => worker as unknown as Worker, decode: async () => image, bitmap: snapshot });
    expect(await result.text()).toBe('worker png'); expect(worker.sent).toEqual([{ bitmap: b, width: 3000 }, [b]]);
    expect(flow).toEqual(['decode', 'raster', 'yield', 'draw', 'snapshot', 'yield', 'bitmap', 'encode']);
    expect(f.drawImage).toHaveBeenCalledOnce(); expect(f.drawImage).toHaveBeenCalledWith(image, 0, 0, 3000, 3000);
    expect(f.canvas).toHaveBeenCalledOnce(); expect(snapshot).toHaveBeenCalledOnce(); expect(f.toBlob).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(f.value.width).toBe(0); expect(f.value.height).toBe(0);
  });
  it('keeps offline export available on the same whole native raster when workers are refused', async () => {
    const f = nativeCanvas(), phases: string[] = [], snapshot = vi.fn();
    const result = await exportPng(new Blob(['svg']), 3000, (p) => phases.push(p), { ...f, worker: () => { throw new Error('blocked'); }, decode: async () => image, bitmap: snapshot });
    expect(await result.text()).toBe('fallback png'); expect(phases).toEqual(['decode', 'raster', 'encode']);
    expect(f.drawImage).toHaveBeenCalledOnce(); expect(f.drawImage).toHaveBeenCalledWith(image, 0, 0, 3000, 3000); expect(f.yield).toHaveBeenCalledOnce();
    expect(f.toBlob).toHaveBeenCalledOnce(); expect(f.canvas).toHaveBeenCalledOnce(); expect(snapshot).not.toHaveBeenCalled();
    expect(f.value.width).toBe(0); expect(f.value.height).toBe(0);
  });
  it.each([false, true])('reuses the raster rather than redrawing after worker failure (transfer refused: %s)', async (transferRefused) => {
    const worker = new FakeWorker(!transferRefused, transferRefused), b = bitmap(), f = nativeCanvas();
    const result = await exportPng(new Blob(['svg']), 3000, () => {}, { ...f, worker: () => worker as unknown as Worker, decode: async () => image, bitmap: async (source) => { expect(source).toBe(f.value); return b; } });
    expect(await result.text()).toBe('fallback png');
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(b.close).toHaveBeenCalledOnce(); expect(f.yield).toHaveBeenCalledTimes(2);
    expect(f.canvas).toHaveBeenCalledOnce(); expect(f.drawImage).toHaveBeenCalledOnce(); expect(f.toBlob).toHaveBeenCalledOnce();
    expect(f.value.width).toBe(0); expect(f.value.height).toBe(0);
  });
  it('uses the existing raster when bitmap creation is unsupported', async () => {
    const worker = new FakeWorker(), f = nativeCanvas();
    const result = await exportPng(new Blob(['svg']), 3000, () => {}, { ...f, worker: () => worker as unknown as Worker, decode: async () => image, bitmap: async () => { throw new Error('no bitmap'); } });
    expect(await result.text()).toBe('fallback png'); expect(f.drawImage).toHaveBeenCalledOnce(); expect(f.canvas).toHaveBeenCalledOnce();
    expect(f.toBlob).toHaveBeenCalledOnce(); expect(worker.terminate).toHaveBeenCalledOnce(); expect(f.value.width).toBe(0);
  });
  it('cleans up decode, native raster and fallback encoder failures', async () => {
    const bad = new FakeWorker();
    const unused = nativeCanvas();
    await expect(exportPng(new Blob(['svg']), 3000, () => {}, { ...unused, worker: () => bad as unknown as Worker, decode: async () => { throw new Error('bad SVG'); } })).rejects.toThrow('bad SVG');
    expect(bad.terminate).toHaveBeenCalledOnce(); expect(unused.canvas).not.toHaveBeenCalled();
    const drawWorker = new FakeWorker(), draw = nativeCanvas(); draw.drawImage.mockImplementation(() => { throw new Error('raster'); });
    await expect(exportPng(new Blob(['svg']), 3000, () => {}, { ...draw, worker: () => drawWorker as unknown as Worker, decode: async () => image })).rejects.toThrow('raster');
    expect(drawWorker.terminate).toHaveBeenCalledOnce(); expect(draw.value.width).toBe(0); expect(draw.value.height).toBe(0); expect(draw.toBlob).not.toHaveBeenCalled();
    const encode = nativeCanvas(true);
    await expect(exportPng(new Blob(['svg']), 3000, () => {}, { ...encode, worker: () => { throw new Error('blocked'); }, decode: async () => image })).rejects.toThrow('PNG encoding failed');
    expect(encode.value.width).toBe(0); expect(encode.value.height).toBe(0);
  });
  it('closes transferred pixels and frees the worker canvas on success and error', async () => {
    for (const fail of [false, true]) {
      const b = bitmap(), phases: string[] = [];
      const c = { width: 3000, height: 3000, getContext: () => ({ drawImage: vi.fn() }), convertToBlob: async () => { if (fail) throw new Error('encode'); return new Blob(['png']); } };
      const result = encodeBitmap({ bitmap: b, width: 3000 }, (p) => phases.push(p), () => c as unknown as OffscreenCanvas);
      if (fail) await expect(result).rejects.toThrow('encode'); else await expect(result).resolves.toBeInstanceOf(Blob);
      expect(phases).toEqual(['raster', 'encode']); expect(b.close).toHaveBeenCalledOnce(); expect(c.width).toBe(0); expect(c.height).toBe(0);
    }
  });
});
