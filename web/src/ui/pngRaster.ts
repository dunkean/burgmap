export type PngPhase = 'decode' | 'raster' | 'snapshot' | 'encode';
export type PngResponse = { type: 'ready'; ok: boolean } | { type: 'progress'; phase: PngPhase } | { type: 'done'; blob?: Blob; error?: string };
export interface PngRequest { bitmap: ImageBitmap; width: number }

/** Copy the page's prepared native Canvas snapshot and encode PNG in the dedicated worker. */
export async function encodeBitmap(m: PngRequest, progress: (phase: PngPhase) => void, makeCanvas = (n: number): OffscreenCanvas => new OffscreenCanvas(n, n)): Promise<Blob> {
  let canvas: OffscreenCanvas | undefined;
  try {
    canvas = makeCanvas(m.width);
    const c = canvas.getContext('2d');
    if (!c) throw new Error('no PNG canvas context');
    progress('raster'); c.drawImage(m.bitmap, 0, 0, m.width, m.width);
    progress('encode');
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally { m.bitmap.close(); if (canvas) { canvas.width = 0; canvas.height = 0; } }
}
