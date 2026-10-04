/** SVG labels may use the worker only when native text measurement really works there. */
export function exportMeasure(): OffscreenCanvasRenderingContext2D | null {
  try {
    const c = new OffscreenCanvas(1, 1).getContext('2d');
    if (!c || typeof c.measureText !== 'function') return null;
    c.font = '16px serif';
    const thin = c.measureText('iiii').width, wide = c.measureText('WWWW').width;
    return Number.isFinite(thin) && thin > 0 && Number.isFinite(wide) && wide > thin ? c : null;
  } catch { return null; }
}
