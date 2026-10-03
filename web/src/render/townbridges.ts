/**
 * Plan shapes of the small town bridges (gen/urban/streambridges.ts), shared by the SVG and Canvas renderers.
 * Drawn at true size (meters), unlike the road bridges whose decks are widened for legibility at map scale:
 * - footbridge: a plank deck between thin rails, the plank seams across it ('stepped': the steps of a canal bridge);
 * - arch: a stone deck between heavy parapets, the abutment wings splayed on the banks ('hump': bowed parapets);
 * - timber-arch: a timber deck whose rails bow outward (the drum bridge seen from above);
 * - ford: stepping stones across the brook.
 */
import type { Vec2 } from '../gen/core/geom';
import type { Palette } from './styles';
import { f1, pathD } from './util';

export interface BridgeShapes {
  /** Deck outline (filled with the deck colour, at `deckAlpha`: a ford's wet track is faint). */
  deck: Vec2[] | null;
  deckAlpha: number;
  /** Ink strokes: rails, parapets, wings. */
  lines: { pts: Vec2[]; w: number }[];
  /** Fine ink dashes across the deck (planks, steps): a stroke along the deck dashed into seams. */
  seams: { pts: Vec2[]; w: number; dash: [number, number] } | null;
  /** Stepping stones. */
  stones: { c: Vec2; r: number }[];
}

export type KindedBridgeLike = { a: Vec2; b: Vec2; width: number; kind?: string; arch?: string };

export const isKinded = (b: object): boolean => typeof (b as { kind?: unknown }).kind === 'string';

export function bridgeShapes(b: KindedBridgeLike): BridgeShapes {
  const dx = b.b.x - b.a.x, dy = b.b.y - b.a.y, L = Math.hypot(dx, dy) || 1;
  const t = { x: dx / L, y: dy / L }, n = { x: -t.y, y: t.x };
  const h = b.width / 2;
  const at = (s: number, o: number): Vec2 => ({ x: b.a.x + t.x * s + n.x * o, y: b.a.y + t.y * s + n.y * o });
  if (b.kind === 'ford') {
    const stones: { c: Vec2; r: number }[] = [];
    const k = Math.max(3, Math.round((L + 1) / 1.1));
    for (let i = 0; i <= k; i++) stones.push({ c: at(-0.5 + ((L + 1) * i) / k, (i % 2 ? 0.3 : -0.3) * Math.min(1, h)), r: 0.6 });
    const track = [at(-0.5, h), at(L + 0.5, h), at(L + 0.5, -h), at(-0.5, -h)];
    return { deck: track, deckAlpha: 0.5, lines: [], seams: null, stones };
  }
  const pad = b.kind === 'arch' ? 0.6 : 0.35;
  const s0 = -pad, s1 = L + pad;
  // rails: straight, or bowed outward (drum and humpback bridges)
  const bow = b.kind === 'timber-arch' ? Math.max(0.5, Math.min(1.6, 0.1 * L)) : b.arch === 'hump' ? Math.max(0.35, Math.min(1, 0.06 * L)) : 0;
  const N = bow > 0 ? 10 : 1;
  const rail = (sg: number): Vec2[] => {
    const pts: Vec2[] = [];
    for (let i = 0; i <= N; i++) {
      const f = i / N, s = s0 + (s1 - s0) * f;
      pts.push(at(s, sg * (h + bow * Math.sin(Math.PI * f))));
    }
    return pts;
  };
  const r1 = rail(1), r2 = rail(-1);
  const deck = [...r1, ...r2.slice().reverse()];
  const lines: { pts: Vec2[]; w: number }[] = [];
  const railW = b.kind === 'arch' ? 0.7 : b.kind === 'timber-arch' ? 0.45 : 0.35;
  lines.push({ pts: r1, w: railW }, { pts: r2, w: railW });
  if (b.kind === 'arch') {
    // abutment wings splayed on both banks
    for (const [s, dir] of [[s0, -1], [s1, 1]] as [number, number][]) for (const sg of [1, -1]) lines.push({ pts: [at(s, sg * h), at(s + dir * 1.4, sg * (h + 1.4))], w: railW });
  }
  let seams: BridgeShapes['seams'] = null;
  if (b.kind === 'footbridge' || b.kind === 'timber-arch') {
    const step = b.arch === 'stepped' ? 0.7 : 0.95;
    seams = { pts: [at(s0 + 0.2, 0), at(s1 - 0.2, 0)], w: Math.max(0.2, b.width - 0.5), dash: [0.12, step - 0.12] };
  }
  return { deck, deckAlpha: 1, lines, seams, stones: [] };
}

/** SVG of the small town bridges among `bridges` (the kinded ones), drawn over the street space. */
export function townBridgesSvg(bridges: readonly object[], pal: Palette): string {
  let o = '';
  for (const b of bridges) {
    if (!isKinded(b)) continue;
    const sh = bridgeShapes(b as KindedBridgeLike);
    if (sh.deck) o += `<path d="${pathD(sh.deck, true)}" fill="${pal.bridgeDeck}"${sh.deckAlpha < 1 ? ` fill-opacity="${sh.deckAlpha}"` : ''} stroke="none"/>`;
    if (sh.seams) o += `<path d="${pathD(sh.seams.pts, false)}" fill="none" stroke="${pal.bridgeInk}" stroke-opacity="0.45" stroke-width="${f1(sh.seams.w)}" stroke-dasharray="${sh.seams.dash.map((x) => x.toFixed(2)).join(' ')}" stroke-linecap="butt"/>`;
    for (const l of sh.lines) o += `<path d="${pathD(l.pts, false)}" fill="none" stroke="${pal.bridgeInk}" stroke-width="${l.w.toFixed(2)}" stroke-linecap="butt"/>`;
    for (const st of sh.stones) o += `<circle cx="${f1(st.c.x)}" cy="${f1(st.c.y)}" r="${st.r.toFixed(2)}" fill="${pal.bridgeDeck}" stroke="${pal.bridgeInk}" stroke-width="0.15"/>`;
  }
  return o ? `<g class="u-town-bridges">${o}</g>` : '';
}
