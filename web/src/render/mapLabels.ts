/**
 * Map label engine (M5a): labels come from `world.names`; point, area and curved path labels,
 * greedy collision avoidance with priority by kind/rank and zoom. Pure: text widths come from
 * an injected `measure`, so it runs in Node (SVG export) and in the browser (canvas).
 */
import type { World, Vec2 } from '../gen/types';
import type { StyleName } from '../gen/options';
import type { Palette } from './styles';
import { KindStyle, kindStyles, streetRankStyle } from './labelStyles';
import { View, worldToScreen } from './view';

export interface MapLabel {
  id: string; kind: string; text: string; st: KindStyle;
  x: number; y: number; path?: Vec2[]; span?: number;
  /** Street rank when kind === 'street'. */
  rank?: number;
}
/** Text width in px of `text` at `size` px for the given style (italic/bold matter). */
export type Measure = (text: string, size: number, st: KindStyle) => number;

export function buildMapLabels(world: World, style: StyleName, pal: Palette): MapLabel[] {
  const names = world.names;
  if (!names) return [];
  const styles = kindStyles(style, pal);
  const out: MapLabel[] = [];
  for (const e of names.entries) {
    let st = styles[e.kind];
    if (!st) continue;
    if (e.kind === 'street') st = streetRankStyle(st, e.rank);
    out.push({ id: e.id, kind: e.kind, text: e.text, st, x: e.anchor.x, y: e.anchor.y, path: e.path, span: e.span, rank: e.rank });
  }
  return out;
}

export interface GlyphPos { ch: string; x: number; y: number; a: number; size: number; w: number }
export interface PlacedMapLabel {
  label: MapLabel; size: number; spacing: number;
  /** Glyph centres (screen px), angle in radians, size (small caps use smaller glyphs). */
  glyphs: GlyphPos[];
  /** Straight labels: centre and width. */
  cx: number; cy: number; width: number;
  /** Curved labels: the smoothed screen-space window the text follows (reading direction). */
  path?: [number, number][];
  symbol?: { x: number; y: number; r: number };
}
interface Box { x0: number; y0: number; x1: number; y1: number }
interface LGlyph { ch: string; size: number; w: number }

const SMALL_CAP = 0.78;

/** Split text into glyphs (case rules applied) with their advance widths (letter spacing included). */
export function layoutGlyphs(text: string, st: KindStyle, size: number, spacingPx: number, measure: Measure): { glyphs: LGlyph[]; total: number } {
  const glyphs: LGlyph[] = [];
  let newWord = true;
  for (const raw of text) {
    let ch = raw, s = size;
    if (st.caps === 'upper') ch = raw.toUpperCase();
    else if (st.caps === 'small') {
      ch = raw.toUpperCase();
      if (!newWord && raw !== ' ') s = size * SMALL_CAP;
    }
    newWord = raw === ' ' || raw === '-' || raw === "'";
    glyphs.push({ ch, size: s, w: ch === ' ' ? size * 0.3 + spacingPx : measure(ch, s, st) + spacingPx });
  }
  let total = 0;
  for (const g of glyphs) total += g.w;
  return { glyphs, total: total - (glyphs.length ? spacingPx : 0) };
}

const overlaps = (a: Box, b: Box): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

export interface PlaceOptions {
  maxLabels?: number; pad?: number; margin?: number;
  /** Scale used for the minScale / maxScale visibility tests (default: view.scale). The SVG export runs at a notional scale. */
  visScale?: number;
  /** Screen rectangles kept free of labels (cartouche, legend). */
  reserved?: { x0: number; y0: number; x1: number; y1: number }[];
}

function straight(l: MapLabel, glyphs: LGlyph[], total: number, x0: number, y: number, size: number, spacing: number): PlacedMapLabel {
  const out: GlyphPos[] = [];
  let x = x0;
  for (const g of glyphs) {
    const adv = g.w - spacing;
    out.push({ ch: g.ch, x: x + adv / 2, y, a: 0, size: g.size, w: adv });
    x += g.w;
  }
  return { label: l, size, spacing, glyphs: out, cx: x0 + total / 2, cy: y, width: total };
}

/**
 * Place labels for a view. `view.scale` is px/m; w,h in px. Order: priority (desc) then input order.
 * A label is accepted when it fits on screen, is legible and does not overlap an accepted label.
 */
export function placeMapLabels(labels: MapLabel[], view: View, w: number, h: number, measure: Measure, o: PlaceOptions = {}): PlacedMapLabel[] {
  const sc = view.scale, vis = o.visScale ?? view.scale, pad = o.pad ?? 2.5, margin = o.margin ?? 4, maxLabels = o.maxLabels ?? 320;
  const cands: { l: MapLabel; i: number }[] = [];
  labels.forEach((l, i) => {
    if (vis < l.st.minScale || vis > l.st.maxScale) return;
    cands.push({ l, i });
  });
  cands.sort((a, b) => b.l.st.priority - a.l.st.priority || a.i - b.i);
  const placed: PlacedMapLabel[] = [];
  const boxes: Box[] = [...(o.reserved ?? [])];
  const free = (bs: Box[]): boolean => {
    for (const b of bs) for (const p of boxes) if (overlaps(b, p)) return false;
    return true;
  };
  const onScreen = (b: Box): boolean => b.x0 >= margin && b.y0 >= margin && b.x1 <= w - margin && b.y1 <= h - margin;
  const padBox = (b: Box): Box => ({ x0: b.x0 - pad, y0: b.y0 - pad * 0.6, x1: b.x1 + pad, y1: b.y1 + pad * 0.6 });

  for (const { l } of cands) {
    if (placed.length >= maxLabels) break;
    const st = l.st;
    const size0 = Math.max(st.minPx, Math.min(st.maxPx, st.sizeM * sc));
    const [sx, sy] = worldToScreen(view, w, h, l.x, l.y);
    let res: PlacedMapLabel | null = null;
    let resBoxes: Box[] = [];

    if (st.shape === 'path' && l.path && l.path.length >= 2) {
      const r = placePath(l, view, w, h, size0, measure, free, padBox, margin);
      if (r) { res = r.p; resBoxes = r.boxes; }
    } else if (st.shape === 'area') {
      if (sx < -w * 0.2 || sx > w * 1.2 || sy < -h * 0.2 || sy > h * 1.2) continue;
      const maxW = l.span ? l.span * sc * 1.02 : Infinity;
      let size = size0;
      let lay = layoutGlyphs(l.text, st, size, size * st.spacing, measure);
      while (lay.total > maxW && size > st.minPx) {
        size = Math.max(st.minPx, size * 0.9);
        lay = layoutGlyphs(l.text, st, size, size * st.spacing, measure);
      }
      const tolerance = l.kind === 'quarter' ? 1.0 : l.kind === 'town' ? 9 : 1.3;
      if (lay.total > maxW * tolerance) continue;
      let spacing = size * st.spacing;
      if (st.stretch > 0 && Number.isFinite(maxW) && lay.total < maxW * 0.8 && l.text.length > 2) {
        const extra = Math.min(size * st.stretch, (maxW * 0.85 - lay.total) / (l.text.length - 1));
        if (extra > 0) { spacing += extra; lay = layoutGlyphs(l.text, st, size, spacing, measure); }
      }
      const b: Box = { x0: sx - lay.total / 2, y0: sy - size * 0.62, x1: sx + lay.total / 2, y1: sy + size * 0.62 };
      if (!onScreen(b)) continue;
      const pb = padBox(b);
      if (!free([pb])) continue;
      res = straight(l, lay.glyphs, lay.total, sx - lay.total / 2, sy, size, spacing);
      resBoxes = [pb];
    } else {
      // point label: with a symbol try right / left / above / below of it, otherwise centred
      const size = size0;
      const lay = layoutGlyphs(l.text, st, size, size * st.spacing, measure);
      const r = st.symbol ? Math.max(2.2, size * 0.26) : 0;
      const tries: { x0: number; y: number }[] = st.symbol
        ? [{ x0: sx + r + 3, y: sy }, { x0: sx - r - 3 - lay.total, y: sy }, { x0: sx - lay.total / 2, y: sy - r - size * 0.75 }, { x0: sx - lay.total / 2, y: sy + r + size * 0.8 }]
        : [{ x0: sx - lay.total / 2, y: sy }];
      const sym = st.symbol ? { x: sx, y: sy, r } : undefined;
      const symBox: Box | null = sym ? { x0: sx - r - 1, y0: sy - r - 1, x1: sx + r + 1, y1: sy + r + 1 } : null;
      if (symBox && (!onScreen(symBox) || !free([symBox]))) continue;
      for (const t of tries) {
        const b: Box = { x0: t.x0, y0: t.y - size * 0.62, x1: t.x0 + lay.total, y1: t.y + size * 0.62 };
        if (!onScreen(b)) continue;
        const pb = padBox(b);
        if (!free([pb])) continue;
        res = straight(l, lay.glyphs, lay.total, t.x0, t.y, size, size * st.spacing);
        if (sym) res.symbol = sym;
        resBoxes = symBox ? [pb, symBox] : [pb];
        break;
      }
    }
    if (res) { placed.push(res); for (const b of resBoxes) boxes.push(b); }
  }
  return placed;
}

/* ---- curved labels along a polyline ---- */
const NAN_PT: [number, number] = [NaN, NaN];

function placePath(
  l: MapLabel, view: View, w: number, h: number, size: number, measure: Measure,
  free: (b: Box[]) => boolean, padBox: (b: Box) => Box, margin: number,
): { p: PlacedMapLabel; boxes: Box[] } | null {
  const st = l.st;
  const src = l.path!;
  // screen-space polyline, quick reject when entirely outside the viewport
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const pts: [number, number][] = new Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const [x, y] = worldToScreen(view, w, h, src[i].x, src[i].y);
    pts[i] = [x, y];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < 0 || maxY < 0 || minX > w || minY > h) return null;
  const spacing0 = size * st.spacing;
  const lay = layoutGlyphs(l.text, st, size, spacing0, measure);
  const need = lay.total + size * 0.8;

  // resample at a fixed step (px), keeping the visible part only
  const step = 3;
  const inside = (x: number, y: number, m: number): boolean => x >= m && y >= m && x <= w - m && y <= h - m;
  const P: [number, number][] = [];
  const cut = (): void => { if (P.length && !Number.isNaN(P[P.length - 1][0])) P.push(NAN_PT); };
  let carry = 0;
  let prev = pts[0];
  if (inside(prev[0], prev[1], -40)) P.push(prev);
  for (let i = 1; i < pts.length; i++) {
    const cur = pts[i];
    const dx = cur[0] - prev[0], dy = cur[1] - prev[1];
    const sl = Math.hypot(dx, dy);
    const far = Math.max(prev[0], cur[0]) < -60 || Math.min(prev[0], cur[0]) > w + 60 || Math.max(prev[1], cur[1]) < -60 || Math.min(prev[1], cur[1]) > h + 60;
    if (far) { cut(); carry = 0; prev = cur; continue; }
    if (sl > 0) {
      let t = step - carry;
      while (t <= sl) {
        const x = prev[0] + (dx * t) / sl, y = prev[1] + (dy * t) / sl;
        if (inside(x, y, -40)) P.push([x, y]); else cut();
        t += step;
      }
      carry = sl - (t - step);
    }
    prev = cur;
  }
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  for (const p of P) {
    if (Number.isNaN(p[0])) { if (run.length) runs.push(run); run = []; } else run.push(p);
  }
  if (run.length) runs.push(run);

  let best: { score: number; glyphs: GlyphPos[]; path: [number, number][]; boxes: Box[] } | null = null;
  const win = Math.max(2, Math.round((size * 1.4) / step));
  for (const r0 of runs) {
    if (r0.length * step < need) continue;
    // smooth the polyline so jittery street geometry gives a calm baseline
    let S0 = r0;
    for (let it = 0; it < 2; it++) {
      const out: [number, number][] = new Array(S0.length);
      for (let i = 0; i < S0.length; i++) {
        let sx = 0, sy = 0, n = 0;
        for (let k = Math.max(0, i - win); k <= Math.min(S0.length - 1, i + win); k++) { sx += S0[k][0]; sy += S0[k][1]; n++; }
        out[i] = [sx / n, sy / n];
      }
      out[0] = S0[0]; out[S0.length - 1] = S0[S0.length - 1];
      S0 = out;
    }
    const n = S0.length;
    const cum = new Float32Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(S0[i][0] - S0[i - 1][0], S0[i][1] - S0[i - 1][1]);
    const L = cum[n - 1];
    if (L < need) continue;
    const ang = new Float32Array(n);
    const d = Math.max(1, Math.round(size / step / 1.5));
    for (let i = 0; i < n; i++) {
      const a = S0[Math.max(0, i - d)], b = S0[Math.min(n - 1, i + d)];
      ang[i] = Math.atan2(b[1] - a[1], b[0] - a[0]);
    }
    const wlen = lay.total + size * 0.4;
    const stepW = Math.max(step * 2, wlen / 5);
    for (let s0 = 0; s0 + wlen <= L; s0 += stepW) {
      let i0 = 0;
      while (i0 < n - 1 && cum[i0 + 1] < s0) i0++;
      let i1 = i0;
      while (i1 < n - 1 && cum[i1] < s0 + wlen) i1++;
      // curvature over the window (unwrapped angles)
      let total = 0, prevA = ang[i0], mn = 0, mx = 0, acc = 0, sharp = false;
      for (let i = i0 + 1; i <= i1; i++) {
        let da = ang[i] - prevA;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        total += Math.abs(da); acc += da; prevA = ang[i];
        mn = Math.min(mn, acc); mx = Math.max(mx, acc);
        if (Math.abs(da) > 0.16) sharp = true;
      }
      if (sharp || mx - mn > 1.25) continue;
      const score = total * 2 + Math.abs((s0 + wlen / 2) / L - 0.5) * 0.8;
      if (best && best.score <= score) continue;
      const flip = Math.cos(ang[Math.min(n - 1, Math.floor((i0 + i1) / 2))]) < 0;
      const at = (sPos: number): { x: number; y: number; a: number } => {
        let i = i0;
        while (i < n - 1 && cum[i + 1] < sPos) i++;
        const j = Math.min(n - 1, i + 1);
        const seg = cum[j] - cum[i] || 1;
        const t = Math.max(0, Math.min(1, (sPos - cum[i]) / seg));
        return { x: S0[i][0] + (S0[j][0] - S0[i][0]) * t, y: S0[i][1] + (S0[j][1] - S0[i][1]) * t, a: ang[i] + (ang[j] - ang[i]) * t };
      };
      const dir = flip ? -1 : 1;
      let x = flip ? s0 + wlen - size * 0.2 : s0 + size * 0.2;
      const glyphs: GlyphPos[] = [];
      let ok = true;
      for (const g of lay.glyphs) {
        const adv = g.w - spacing0;
        const c = at(x + (dir * adv) / 2);
        glyphs.push({ ch: g.ch, x: c.x, y: c.y, a: flip ? c.a + Math.PI : c.a, size: g.size, w: adv });
        if (!inside(c.x, c.y, margin)) { ok = false; break; }
        x += dir * g.w;
      }
      if (!ok) continue;
      const boxes: Box[] = [];
      for (let gi = 0; gi < glyphs.length; gi += 3) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let k = gi; k < Math.min(glyphs.length, gi + 3); k++) {
          const g = glyphs[k];
          const hw = Math.abs(Math.cos(g.a)) * g.w / 2 + Math.abs(Math.sin(g.a)) * size * 0.6;
          const hh = Math.abs(Math.sin(g.a)) * g.w / 2 + Math.abs(Math.cos(g.a)) * size * 0.6;
          x0 = Math.min(x0, g.x - hw); x1 = Math.max(x1, g.x + hw); y0 = Math.min(y0, g.y - hh); y1 = Math.max(y1, g.y + hh);
        }
        boxes.push(padBox({ x0, y0, x1, y1 }));
      }
      if (!free(boxes)) continue;
      const pathW: [number, number][] = [];
      for (let k = i0; k <= i1; k++) pathW.push(S0[k]);
      if (flip) pathW.reverse();
      best = { score, glyphs, path: pathW, boxes };
    }
  }
  if (!best) return null;
  const g0 = best.glyphs[0], gN = best.glyphs[best.glyphs.length - 1];
  return {
    p: { label: l, size, spacing: spacing0, glyphs: best.glyphs, cx: (g0.x + gN.x) / 2, cy: (g0.y + gN.y) / 2, width: lay.total, path: best.path },
    boxes: best.boxes,
  };
}

/** Rough text width estimator for environments without a canvas (Node SVG export). */
export function estimateWidth(text: string, size: number, st: Pick<KindStyle, 'italic' | 'bold'>): number {
  let w = 0;
  for (const ch of text) {
    let k = 0.5;
    if ('ilj.,;:\'!|'.includes(ch)) k = 0.27;
    else if ('ftr()[]- '.includes(ch)) k = 0.36;
    else if ('mwMW'.includes(ch)) k = 0.8;
    else if (ch >= 'A' && ch <= 'Z') k = 0.66;
    w += k * size;
  }
  return w * (st.bold ? 1.05 : 1) * (st.italic ? 0.95 : 1);
}
