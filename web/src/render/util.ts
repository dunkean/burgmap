import type { Vec2 } from '../gen/core/geom';

export const f1 = (v: number): string => {
  const r = Math.round(v * 10) / 10;
  return Object.is(r, -0) ? '0' : String(r);
};

export function pathD(pts: Vec2[], closed: boolean): string {
  if (pts.length < 2) return '';
  let d = 'M' + f1(pts[0].x) + ' ' + f1(pts[0].y);
  for (let i = 1; i < pts.length; i++) d += 'L' + f1(pts[i].x) + ' ' + f1(pts[i].y);
  return closed ? d + 'Z' : d;
}

function ringContains(p: Vec2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[i], b = p[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function ringArea(p: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j].x + p[i].x) * (p[j].y - p[i].y);
  return Math.abs(a) / 2;
}

/**
 * Sea polygons with their islands. Islands are the terrain's `islands` plus any coastline loop nested
 * an odd number of levels inside other loops (the terrain stage does not always separate them by orientation).
 * Fill each sea polygon together with its islands using evenodd.
 */
export function seaWithIslands(coastline: Vec2[][], islands: Vec2[][] | undefined): { sea: Vec2[][]; holes: Vec2[][][] } {
  const isHole = coastline.map((p, i) => {
    let depth = 0;
    for (let j = 0; j < coastline.length; j++) if (j !== i && p.length && ringContains(coastline[j], p[0].x, p[0].y)) depth++;
    return depth % 2 === 1;
  });
  const sea = coastline.filter((_, i) => !isHole[i]);
  const isl = [...(islands ?? []), ...coastline.filter((_, i) => isHole[i])];
  const areas = sea.map(ringArea);
  const holes: Vec2[][][] = sea.map(() => []);
  for (const h of isl) {
    if (h.length < 3) continue;
    let best = -1;
    for (let i = 0; i < sea.length; i++) {
      if (ringContains(sea[i], h[0].x, h[0].y) && (best < 0 || areas[i] < areas[best])) best = i;
    }
    if (best >= 0) holes[best].push(h);
  }
  return { sea, holes };
}
