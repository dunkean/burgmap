/** Heightmap import in the browser: file -> FileReader -> <img> -> canvas pixels (center-cropped square, <= 768 px). */
import type { ImportedHeight } from '../gen/terrain/import';

export const MAX_IMPORT_PX = 768;

export async function readHeightmap(file: File): Promise<ImportedHeight> {
  const url = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error ?? new Error('read failed'));
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('not an image'));
    im.src = url;
  });
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) throw new Error('empty image');
  const side = Math.min(w, h);
  const out = Math.min(MAX_IMPORT_PX, side);
  const c = document.createElement('canvas');
  c.width = out; c.height = out;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no canvas');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, out, out);
  const data = ctx.getImageData(0, 0, out, out);
  return { w: out, h: out, rgba: data.data, name: file.name };
}
