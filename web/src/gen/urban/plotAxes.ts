import type { Polygon, Vec2 } from '../core/geom';
import { obb, type OBB } from '../geo/poly';
import type { Rng } from '../core/rng';

/** Detect orientation from the final dry block, after street and water cuts. */
export function detectPlotFrame(poly: Polygon): OBB {
  return obb(poly);
}

/** Vary the cadastral frame as a whole; adjacent cuts and their houses share it. */
export function varyPlotAxis(axis: Vec2, tiltDegrees: number, rng: Rng): Vec2 {
  if (!(tiltDegrees > 0)) return axis;
  const angle = rng.fork('parcel-frame').range(-Math.min(12, tiltDegrees), Math.min(12, tiltDegrees)) * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: axis.x * c - axis.y * s, y: axis.x * s + axis.y * c };
}

/** Bounds in the retained cadastral frame; descendants never redetect an OBB. */
export function plotBounds(poly: Polygon, axis: Vec2): OBB {
  const v = { x: -axis.y, y: axis.x };
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of poly) {
    const pu = p.x * axis.x + p.y * axis.y, pv = p.x * v.x + p.y * v.y;
    u0 = Math.min(u0, pu); u1 = Math.max(u1, pu);
    v0 = Math.min(v0, pv); v1 = Math.max(v1, pv);
  }
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  const c = { x: cu * axis.x + cv * v.x, y: cu * axis.y + cv * v.y };
  const hu = (u1 - u0) / 2, hv = (v1 - v0) / 2;
  return hu >= hv ? { c, u: axis, v, hu, hv }
    : { c, u: v, v: { x: -axis.x, y: -axis.y }, hu: hv, hv: hu };
}

/** Closest signed block axis to an inward street normal. */
export function plotDirection(normal: Vec2, axis: Vec2): Vec2 {
  const v = { x: -axis.y, y: axis.x };
  const du = normal.x * axis.x + normal.y * axis.y;
  const dv = normal.x * v.x + normal.y * v.y;
  const d = Math.abs(du) >= Math.abs(dv) ? axis : v;
  return normal.x * d.x + normal.y * d.y >= 0 ? d : { x: -d.x, y: -d.y };
}
