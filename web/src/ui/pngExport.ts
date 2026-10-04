import PngWorker from './pngWorker?worker&inline';
import type { PngPhase, PngResponse } from './pngRaster';

/** SVG decoding requires an Image on the page; it retains exactly the existing SVG export semantics. */
export function decodeSvg(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const load = (src: string, release = (): void => {}): void => {
      const img = new Image();
      img.onload = () => { release(); resolve(img); };
      img.onerror = () => {
        release();
        if (src.startsWith('blob:')) void blob.text().then((svg) => load('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)), reject);
        else reject(new Error('could not decode the SVG image'));
      };
      img.src = src;
    };
    const url = URL.createObjectURL(blob); load(url, () => URL.revokeObjectURL(url));
  });
}

export interface PngExportDeps {
  worker?: () => Worker;
  decode?: (blob: Blob) => Promise<HTMLImageElement>;
  bitmap?: (canvas: HTMLCanvasElement) => Promise<ImageBitmap>;
  canvas?: () => HTMLCanvasElement;
  yield?: () => Promise<void>;
}

/** Preserve native SVG rasterization on the page, then encode its Canvas snapshot in a fresh worker. */
export async function exportPng(blob: Blob, width: number, progress: (phase: PngPhase) => void, deps: PngExportDeps = {}): Promise<Blob> {
  if (!Number.isSafeInteger(width) || width <= 0) throw new Error('invalid PNG dimensions');
  let worker: Worker | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let workerFailed = false;
  try {
    worker = (deps.worker ?? (() => new PngWorker()))();
    const active = worker;
    const ready = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      active.onerror = () => { clearTimeout(timeout); resolve(false); };
      active.onmessage = (e: MessageEvent<PngResponse>) => { if (e.data.type === 'ready') { clearTimeout(timeout); resolve(e.data.ok); } };
    });
    if (!ready) { worker.terminate(); worker = undefined; }
    else active.onerror = () => { workerFailed = true; };
  } catch { worker?.terminate(); worker = undefined; }
  try {
    progress('decode');
    const image = await (deps.decode ?? decodeSvg)(blob);
    canvas = (deps.canvas ?? (() => document.createElement('canvas')))();
    canvas.width = width; canvas.height = width;
    const c = canvas.getContext('2d');
    if (!c) throw new Error('no PNG canvas context');
    const yieldPage = deps.yield ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    progress('raster');
    await yieldPage();
    // A whole native draw preserves historical text antialiasing; SVG Image bitmaps and clipped strips differ.
    // This native draw and its snapshot remain on the page, and very large SVGs can still pause it.
    c.drawImage(image, 0, 0, width, width);
    if (worker && !workerFailed) {
      let bitmap: ImageBitmap | undefined;
      try {
        progress('snapshot');
        await yieldPage();
        bitmap = await (deps.bitmap ?? ((source) => createImageBitmap(source)))(canvas);
        if (workerFailed) throw new Error('PNG worker stopped while preparing pixels');
        const active = worker;
        return await new Promise<Blob>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('PNG encoding timed out')), 120000);
          active.onerror = (e) => { clearTimeout(timeout); reject(new Error(e.message || 'PNG worker failed')); };
          active.onmessage = (e: MessageEvent<PngResponse>) => {
            // Native raster and snapshot were already announced; the worker's draw only copies these pixels.
            if (e.data.type === 'progress' && e.data.phase === 'encode') progress('encode');
            if (e.data.type === 'done') { clearTimeout(timeout); if (e.data.blob) resolve(e.data.blob); else reject(new Error(e.data.error ?? 'PNG encoding failed')); }
          };
          try { active.postMessage({ bitmap, width }, [bitmap!]); }
          catch (e) { clearTimeout(timeout); reject(e); }
        });
      } catch {
        // Refused transfers / worker failures retain this exact raster for the offline encoder; do not redraw.
        bitmap?.close(); worker.terminate(); worker = undefined;
      }
    }
    progress('encode');
    const nativeCanvas = canvas;
    return await new Promise<Blob>((resolve, reject) => nativeCanvas.toBlob((png) => png ? resolve(png) : reject(new Error('PNG encoding failed')), 'image/png'));
  } finally {
    // One page raster, one transferred snapshot, one worker canvas at most; no second fallback raster.
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    worker?.terminate();
  }
}
