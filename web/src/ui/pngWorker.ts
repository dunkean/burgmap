import { encodeBitmap, type PngRequest, type PngResponse } from './pngRaster';
const ctx = self as unknown as Worker;
const post = (m: PngResponse): void => ctx.postMessage(m);
try {
  const c = new OffscreenCanvas(1, 1);
  post({ type: 'ready', ok: !!c.getContext('2d') && typeof c.convertToBlob === 'function' });
} catch { post({ type: 'ready', ok: false }); }
ctx.onmessage = async (e: MessageEvent<PngRequest>): Promise<void> => {
  try { post({ type: 'done', blob: await encodeBitmap(e.data, (phase) => post({ type: 'progress', phase })) }); }
  catch (error) { post({ type: 'done', error: String((error as Error).message ?? error) }); }
};
