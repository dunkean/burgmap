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
