import type { HydrologyData } from './hydrology';

interface SurfaceData {
  x: number; y: number; width: number; resolution: number; height: Float32Array;
  normalX: Float32Array; normalY: Float32Array; normalZ: Float32Array;
  minHeight: number; maxHeight: number;
}
interface Segment { a: number; b: number; estuary: number }
interface Notch { a: number; b: number }
interface PreparedSurface {
  delta: Float32Array; hasDelta: boolean; hasSea: boolean;
  buckets: Map<number, number[]>; segments: Segment[]; bucketSize: number; side: number;
  notchBuckets: Map<number, number[]>; notches: Notch[];
}
const surfaces = new WeakMap<HydrologyData, PreparedSurface>();

function prepare(hydro: HydrologyData): PreparedSurface {
  const cached = surfaces.get(hydro);
  if (cached) return cached;
  const delta = new Float32Array(hydro.baseHeight.length);
  const notchCells: number[] = [];
  const isNotch = (i: number): boolean => hydro.drainageHeight[i] < hydro.rawDrainageHeight[i] && hydro.surfaceHeight[i] < hydro.baseHeight[i];
  let hasDelta = false;
  for (let i = 0; i < delta.length; i++) {
    // Smooth broad fills and lake shaping. Narrow spill cuts have a separate,
    // interpolating corridor below: a B-spline would partially close their spill.
    const notch = isNotch(i);
    if (notch) notchCells.push(i);
    delta[i] = notch ? 0 : hydro.surfaceHeight[i] - hydro.baseHeight[i];
    hasDelta ||= delta[i] !== 0;
  }
  const side = 256, bucketSize = hydro.width / side;
  const buckets = new Map<number, number[]>(), segments: Segment[] = [], p = hydro.riverPoints;
  const notchBuckets = new Map<number, number[]>(), notches: Notch[] = [];
  const hn = hydro.resolution, hc = hydro.width / hn;
  for (const a of notchCells) {
    const x = a % hn, y = Math.floor(a / hn);
    const ax = (x + 0.5) * hc, ay = (y + 0.5) * hc;
    const neighbors: number[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy, b = yy * hn + xx;
      if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= hn || yy >= hn) continue;
      const cut = isNotch(b);
      // Connect cut centres in D8, including their already-low land exits.
      if ((cut && b > a) || (!cut && hydro.basins[b] && hydro.surfaceHeight[b] <= hydro.surfaceHeight[a])) neighbors.push(b);
    }
    if (!neighbors.length) neighbors.push(a);
    for (const b of neighbors) {
      const bx = (b % hn + 0.5) * hc, by = (Math.floor(b / hn) + 0.5) * hc, id = notches.length;
      notches.push({ a, b });
      const x0 = bucket(Math.min(ax, bx) - hc * 0.5, bucketSize, side), x1 = bucket(Math.max(ax, bx) + hc * 0.5, bucketSize, side);
      const y0 = bucket(Math.min(ay, by) - hc * 0.5, bucketSize, side), y1 = bucket(Math.max(ay, by) + hc * 0.5, bucketSize, side);
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
        const key = yy * side + xx, entries = notchBuckets.get(key);
        if (entries) entries.push(id); else notchBuckets.set(key, [id]);
      }
    }
  }
  if (hydro.incision > 0) for (let r = 0; r < hydro.riverCount; r++) {
    for (let a = hydro.riverOffsets[r]; a + 1 < hydro.riverOffsets[r + 1]; a++) {
      const b = a + 1, radius = Math.max(p[a * 4 + 2], p[b * 4 + 2]) * 0.65 + 0.5;
      const id = segments.length;
      segments.push({ a, b, estuary: hydro.riverMeta[r * 6 + 5] });
      const x0 = bucket(Math.min(p[a * 4], p[b * 4]) - radius, bucketSize, side);
      const x1 = bucket(Math.max(p[a * 4], p[b * 4]) + radius, bucketSize, side);
      const y0 = bucket(Math.min(p[a * 4 + 1], p[b * 4 + 1]) - radius, bucketSize, side);
      const y1 = bucket(Math.max(p[a * 4 + 1], p[b * 4 + 1]) + radius, bucketSize, side);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const key = y * side + x, entries = buckets.get(key);
        if (entries) entries.push(id); else buckets.set(key, [id]);
      }
    }
  }
  const result = { delta, hasDelta, hasSea: hydro.basins.includes(0), buckets, segments, bucketSize, side, notchBuckets, notches };
  surfaces.set(hydro, result);
  return result;
}
const bucket = (v: number, size: number, side: number): number => Math.max(0, Math.min(side - 1, Math.floor(v / size)));

// Positive cubic B-spline weights give a smooth broad fill field without overshoot.
function samplingAxis(origin: number, cell: number, count: number, hydroCell: number, hn: number): { indices: Int32Array; weights: Float64Array } {
  const indices = new Int32Array(count * 4), weights = new Float64Array(count * 4);
  for (let k = 0; k < count; k++) {
    const g = Math.max(0, Math.min(hn - 1, (origin + (k + 0.5) * cell) / hydroCell - 0.5));
    const i = Math.floor(g), t = g - i, u = 1 - t;
    for (let j = 0; j < 4; j++) indices[k * 4 + j] = Math.max(0, Math.min(hn - 1, i + j - 1));
    weights.set([u ** 3 / 6, (3 * t ** 3 - 6 * t * t + 4) / 6, (-3 * t ** 3 + 3 * t * t + 3 * t + 1) / 6, t ** 3 / 6], k * 4);
  }
  return { indices, weights };
}

/** Sample the retained depression field and continuous vector bed at camera precision.
 * The core keeps its coarse physical grid for diagnostics; zoom never enlarges its incision pixels. */
export function applyHydrologySurface(data: SurfaceData, hydro: HydrologyData): void {
  const n = data.resolution, cell = data.width / n, surface = prepare(hydro);
  if (!surface.hasDelta && !surface.segments.length && !surface.notches.length) return;
  const changes = new Float32Array(n * n);
  if (surface.hasDelta) {
    const hn = hydro.resolution, hc = hydro.width / hn;
    const xs = samplingAxis(data.x, cell, n, hc, hn), ys = samplingAxis(data.y, cell, n, hc, hn);
    // The cubic kernel is separable. Only source rows touched by this camera
    // region are filtered horizontally; the second pass combines four rows.
    const firstRow = ys.indices[0], lastRow = ys.indices[ys.indices.length - 1];
    const horizontal = new Float64Array((lastRow - firstRow + 1) * n);
    for (let y = firstRow; y <= lastRow; y++) {
      const sourceRow = y * hn, targetRow = (y - firstRow) * n;
      for (let x = 0; x < n; x++) {
        const k = x * 4;
        horizontal[targetRow + x] = surface.delta[sourceRow + xs.indices[k]] * xs.weights[k]
          + surface.delta[sourceRow + xs.indices[k + 1]] * xs.weights[k + 1]
          + surface.delta[sourceRow + xs.indices[k + 2]] * xs.weights[k + 2]
          + surface.delta[sourceRow + xs.indices[k + 3]] * xs.weights[k + 3];
      }
    }
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const k = y * 4;
      let change = horizontal[(ys.indices[k] - firstRow) * n + x] * ys.weights[k]
        + horizontal[(ys.indices[k + 1] - firstRow) * n + x] * ys.weights[k + 1]
        + horizontal[(ys.indices[k + 2] - firstRow) * n + x] * ys.weights[k + 2]
        + horizontal[(ys.indices[k + 3] - firstRow) * n + x] * ys.weights[k + 3];
      if (change > 0 && surface.hasSea && data.height[y * n + x] <= 0) {
        const hx = Math.max(0, Math.min(hn - 1, Math.floor((data.x + (x + 0.5) * cell) / hc)));
        const hy = Math.max(0, Math.min(hn - 1, Math.floor((data.y + (y + 0.5) * cell) / hc))), i = hy * hn + hx;
        // Keep marine pixels marine; enclosed below-datum land basins can still fill.
        if (!hydro.basins[i] || hydro.baseHeight[i] >= 0) change = 0;
      }
      changes[y * n + x] = change;
      data.height[y * n + x] += change;
    }
  }
  const visible = new Set<number>(), { bucketSize, side } = surface;
  for (let y = bucket(data.y, bucketSize, side); y <= bucket(data.y + data.width, bucketSize, side); y++) {
    for (let x = bucket(data.x, bucketSize, side); x <= bucket(data.x + data.width, bucketSize, side); x++) {
      for (const id of surface.buckets.get(y * side + x) ?? []) visible.add(id);
    }
  }
  const cuts = new Float32Array(n * n), p = hydro.riverPoints;
  const pixel = (world: number, origin: number): number => Math.max(0, Math.min(n - 1, Math.floor((world - origin) / cell)));
  const visibleNotches = new Set<number>();
  for (let y = bucket(data.y, bucketSize, side); y <= bucket(data.y + data.width, bucketSize, side); y++) {
    for (let x = bucket(data.x, bucketSize, side); x <= bucket(data.x + data.width, bucketSize, side); x++) {
      for (const id of surface.notchBuckets.get(y * side + x) ?? []) visibleNotches.add(id);
    }
  }
  const hn = hydro.resolution, hc = hydro.width / hn, notchRadius = hc * 0.5;
  for (const id of visibleNotches) {
    const { a, b } = surface.notches[id];
    const ax = (a % hn + 0.5) * hc, ay = (Math.floor(a / hn) + 0.5) * hc;
    const bx = (b % hn + 0.5) * hc, by = (Math.floor(b / hn) + 0.5) * hc;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const minX = Math.min(ax, bx) - notchRadius, maxX = Math.max(ax, bx) + notchRadius;
    const minY = Math.min(ay, by) - notchRadius, maxY = Math.max(ay, by) + notchRadius;
    if (maxX < data.x || minX > data.x + data.width || maxY < data.y || minY > data.y + data.width) continue;
    const diagonal = Math.abs(dy) > 1e-12;
    const halfBand = diagonal ? notchRadius * Math.sqrt(l2) / Math.abs(dy) : 0;
    for (let y = pixel(minY, data.y); y <= pixel(maxY, data.y); y++) {
      const py = data.y + (y + 0.5) * cell, centerX = diagonal ? ax + dx * (py - ay) / dy : 0;
      const rowMin = diagonal ? Math.max(minX, centerX - halfBand) : minX;
      const rowMax = diagonal ? Math.min(maxX, centerX + halfBand) : maxX;
      if (rowMin > rowMax || rowMax < data.x || rowMin > data.x + data.width) continue;
      for (let x = pixel(rowMin, data.x); x <= pixel(rowMax, data.x); x++) {
        const px = data.x + (x + 0.5) * cell;
        const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
        const distance = Math.hypot(px - ax - dx * t, py - ay - dy * t);
        if (distance >= notchRadius) continue;
        // The inner half retains the absolute opened-spill profile, even with
        // incision disabled or positive fill nearby. Smooth banks join the fine
        // retained terrain; zoom samples this corridor rather than coarse pixels.
        const u = Math.max(0, (distance / notchRadius - 0.5) * 2), blend = 1 - u * u * (3 - 2 * u);
        const target = hydro.surfaceHeight[a] + (hydro.surfaceHeight[b] - hydro.surfaceHeight[a]) * t;
        const i = y * n + x;
        cuts[i] = Math.max(cuts[i], Math.max(0, data.height[i] - target) * blend);
      }
    }
  }
  for (const id of visible) {
    const { a, b, estuary } = surface.segments[id], ax = p[a * 4], ay = p[a * 4 + 1], bx = p[b * 4], by = p[b * 4 + 1];
    const aw = p[a * 4 + 2], bw = p[b * 4 + 2], az = p[a * 4 + 3], bz = p[b * 4 + 3];
    const radius = Math.max(Math.max(aw, bw) * 0.65, 0.5), dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const minX = Math.min(ax, bx) - radius, maxX = Math.max(ax, bx) + radius;
    const minY = Math.min(ay, by) - radius, maxY = Math.max(ay, by) + radius;
    if (maxX < data.x || minX > data.x + data.width || maxY < data.y || minY > data.y + data.width) continue;
    const y0 = pixel(minY, data.y), y1 = pixel(maxY, data.y);
    const diagonal = Math.abs(dy) > 1e-12;
    const halfBand = diagonal ? radius * Math.hypot(dx, dy) / Math.abs(dy) : 0;
    for (let y = y0; y <= y1; y++) {
      const py = data.y + (y + 0.5) * cell;
      const centerX = diagonal ? ax + dx * (py - ay) / dy : 0;
      // The infinite strip intersected with the capsule's bounding box includes
      // both endpoint caps. Exact distance below retains the existing profile.
      const rowMin = diagonal ? Math.max(minX, centerX - halfBand) : minX;
      const rowMax = diagonal ? Math.min(maxX, centerX + halfBand) : maxX;
      if (rowMin > rowMax || rowMax < data.x || rowMin > data.x + data.width) continue;
      const x0 = pixel(rowMin, data.x), x1 = pixel(rowMax, data.x);
      for (let x = x0; x <= x1; x++) {
        const px = data.x + (x + 0.5) * cell;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / Math.max(l2, 0.001)));
        const width = aw + (bw - aw) * t, water = az + (bz - az) * t;
        const distance = Math.hypot(px - ax - dx * t, py - ay - dy * t);
        const blend = Math.max(0, 1 - distance / Math.max(width * 0.65, 0.5)) ** 2;
        if (!blend) continue;
        const depth = Math.max(0.35, Math.min(12, width * 0.11)) * hydro.incision, i = y * n + x;
        const cut = Math.max(0, Math.min(depth * 2 + 0.75, data.height[i] - (water - depth))) * blend * (estuary > 1 && water < depth ? 1.15 : 1);
        cuts[i] = Math.max(cuts[i], cut);
      }
    }
  }
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < n * n; i++) {
    data.height[i] -= cuts[i]; changes[i] -= cuts[i];
    min = Math.min(min, data.height[i]); max = Math.max(max, data.height[i]);
  }
  // Preserve the terrain's detailed normals, adding only this surface's gradient.
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x, xl = Math.max(0, x - 1), xr = Math.min(n - 1, x + 1);
    const yt = Math.max(0, y - 1), yb = Math.min(n - 1, y + 1);
    const changeX = changes[y * n + xr] - changes[y * n + xl], changeY = changes[yb * n + x] - changes[yt * n + x];
    if (changeX === 0 && changeY === 0) continue;
    const nz = Math.max(1e-6, data.normalZ[i]);
    const dx = -data.normalX[i] / nz + changeX / ((xr - xl) * cell || cell);
    const dy = -data.normalY[i] / nz + changeY / ((yb - yt) * cell || cell);
    const length = Math.hypot(dx, dy, 1);
    data.normalX[i] = -dx / length; data.normalY[i] = -dy / length; data.normalZ[i] = 1 / length;
  }
  data.minHeight = min; data.maxHeight = max;
}
