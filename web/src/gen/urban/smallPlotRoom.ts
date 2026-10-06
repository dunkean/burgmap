/** A bounded, compact roof for a sharply bent small plot whose original roof is unusable. */
import type { Polygon, Vec2 } from '../core/geom';
import { polygonCentroid } from '../core/geom';
import { area, inscribed, isSimple, minAngle, minNeck, obb } from '../geo/poly';
import { isConvex } from '../geo/split';
import { mpArea, tryDifference, tryIntersection } from '../geo/bool';

const MIN_AREA = 12;
const MIN_WIDTH = 3.2;
const MAX_ASPECT = 2.2;
const MAX_TRIALS = 5_000;
const WINDOW_SIZES: [number, number][] = [
  [7, 8], [7, 7], [6, 8], [6, 7], [6, 6], [5, 7],
  [5, 6], [5, 5], [4, 6], [4, 5], [4, 4],
];

const unit = (v: Vec2): Vec2 | null => {
  const n = Math.hypot(v.x, v.y);
  return n > 1e-6 ? { x: v.x / n, y: v.y / n } : null;
};

/** `clear` includes the physical reserve; `validate` includes other owners and whole-block access. */
export function reconstructSmallPlotRoom(poly: Polygon, owner: Polygon, front: [Vec2, Vec2] | undefined,
  occupied: Polygon[], clear: (candidate: Polygon, original: Polygon) => boolean,
  validate: (candidate: Polygon) => boolean): Polygon | null {
  const oldArea = area(poly);
  if (poly.length < 3 || owner.length < 3 || !Number.isFinite(oldArea) || oldArea < MIN_AREA) return null;
  const axes: Vec2[] = [];
  const addAxis = (raw: Vec2) => {
    const u = unit(raw);
    if (!u || axes.some(a => Math.abs(a.x * u.x + a.y * u.y) > 0.999)) return;
    axes.push(u);
  };
  if (front) {
    const f = { x: front[1].x - front[0].x, y: front[1].y - front[0].y };
    addAxis({ x: -f.y, y: f.x });
    addAxis(f);
  }
  addAxis(obb(poly).u);
  addAxis(obb(owner).u);
  let longest = { x: 0, y: 0 }, length = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const d = { x: b.x - a.x, y: b.y - a.y }, n = Math.hypot(d.x, d.y);
    if (n > length) { longest = d; length = n; }
  }
  addAxis(longest);
  const directions = axes.flatMap(a => [-10, -5, 0, 5, 10].map(deg => {
    const t = deg * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
    return { x: a.x * cos - a.y * sin, y: a.x * sin + a.y * cos };
  }));
  const centres = [inscribed(owner, [], 0.05).c, inscribed(poly, [], 0.05).c, polygonCentroid(poly)];
  const offsets: [number, number][] = [];
  for (let y = -2; y <= 2; y += 0.5) for (let x = -2; x <= 2; x += 0.5) offsets.push([x, y]);
  offsets.sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - Math.abs(b[0]) - Math.abs(b[1]));
  let trials = 0;
  for (const centre of centres) for (const u of directions) {
    const v = { x: -u.y, y: u.x };
    for (const [dx, dy] of offsets) for (const [width, length] of WINDOW_SIZES) {
      if (++trials > MAX_TRIALS) return null;
      const x = centre.x + dx, y = centre.y + dy, hw = width / 2, hl = length / 2;
      const window: Polygon = [
        { x: x - u.x * hl - v.x * hw, y: y - u.y * hl - v.y * hw },
        { x: x + u.x * hl - v.x * hw, y: y + u.y * hl - v.y * hw },
        { x: x + u.x * hl + v.x * hw, y: y + u.y * hl + v.y * hw },
        { x: x - u.x * hl + v.x * hw, y: y - u.y * hl + v.y * hw },
      ];
      const clipped = tryIntersection(owner, window);
      if (clipped.failed || clipped.pieces.length !== 1 || clipped.pieces[0].holes.length) continue;
      const candidate = clipped.pieces[0].outer, a = area(candidate);
      if (candidate.length < 4 || candidate.length > 6 || a < MIN_AREA || a > 0.85 * oldArea
        || !isSimple(candidate) || !isConvex(candidate, 1e-3) || minAngle(candidate) < Math.PI / 3) continue;
      const box = obb(candidate), narrow = 2 * Math.min(box.hu, box.hv);
      if (narrow < MIN_WIDTH || Math.max(box.hu, box.hv) / Math.max(1e-6, Math.min(box.hu, box.hv)) > MAX_ASPECT
        || 2 * inscribed(candidate, [], 0.05).r < MIN_WIDTH
        || (minNeck(candidate)?.w ?? Infinity) < MIN_WIDTH) continue;
      const escaped = tryDifference(candidate, owner), peers = occupied.length ? tryIntersection(candidate, ...occupied) : { pieces: [], failed: false };
      if (escaped.failed || peers.failed || mpArea(escaped.pieces) > 1e-6 || mpArea(peers.pieces) > 1e-6) continue;
      if (clear(candidate, poly) && validate(candidate)) return candidate;
    }
  }
  return null;
}
