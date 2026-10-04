import type { Vec2 } from '../../core/geom';
import { dist } from '../../core/geom';
import type { UrbanCtx } from '../context';
import { portWaterKind } from '../m4/port';
import { LAB_WATER } from '../streets';
import type { MacroQuarter, MacroStreet } from './types';

/** A port district needs a land approach and frontage on physical, navigable natural water. */
export function macroPortFrontage(ctx: UrbanCtx, q: MacroQuarter, streets: MacroStreet[], onNaturalBank?: ((p: Vec2) => boolean) | null) {
  const served = q.lab.some((label) => label >= 0 && streets[label]?.widths.some((width) => width > 0));
  let coastal = false, length = 0;
  const wetEdge = q.pts.map((a, i) => {
    const b = q.pts[(i + 1) % q.pts.length], span = dist(a, b);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (q.lab[i] !== LAB_WATER || !span || (onNaturalBank && !onNaturalBank(mid))) return false;
    const kinds = [-1, 1].map((side) => portWaterKind(ctx, { x: mid.x - (b.y - a.y) / span * side * 6, y: mid.y + (b.x - a.x) / span * side * 6 }));
    if (!kinds.some(Boolean)) return false;
    if (kinds.includes('coast')) coastal = true;
    length += span;
    return true;
  });
  return { served, coastal, length, wetEdge };
}
