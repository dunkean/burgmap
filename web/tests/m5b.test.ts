import { describe, it, expect } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { renderSvg } from '../src/render/svg';
import { PALETTES, STYLE_LIST, isMapStyle, MapStyle, Palette } from '../src/render/styles';
import { FONT_STACKS, streetRankStyle, kindStyles } from '../src/render/labelStyles';
import { legendModel, cartoucheModel } from '../src/render/legend';
import { litDots } from '../src/render/extras';
import { frameModel } from '../src/render/frame';
import { createCanvasRenderer } from '../src/render/canvas';
import type { CanvasLike } from '../src/render/canvas';
import { mockCanvas, MockPath2D } from '../scripts/fakeworld';
import { saveFile } from '../src/ui/download';
import { worldToJson } from '../src/ui/exportWorld';

const STYLES = Object.keys(PALETTES) as MapStyle[];
const HEX = /^#[0-9a-f]{6}$/i;

describe('style tokens', () => {
  it('has the nine styles, each with a label and font stack', () => {
    expect([...STYLES].sort()).toEqual(['atlas', 'blueprint', 'cadastre', 'engraving', 'illuminated', 'night', 'parchment', 'topographic', 'watabou']);
    expect(STYLE_LIST.length).toBe(9);
    for (const s of STYLES) {
      expect(isMapStyle(s)).toBe(true);
      expect(PALETTES[s].label.length).toBeGreaterThan(2);
      expect(FONT_STACKS[s]).toBe(PALETTES[s].fontFamily);
      // never the generic `cursive` family (falls back to unreadable faces on some systems)
      expect(FONT_STACKS[s]).not.toMatch(/cursive|fantasy/);
    }
    expect(isMapStyle('nope')).toBe(false);
  });
  it('every style defines every token (same key set as parchment) with valid colours', () => {
    const ref = PALETTES.parchment;
    const keysOf = (o: object): string[] => Object.keys(o).sort();
    for (const s of STYLES) {
      const p = PALETTES[s];
      expect(keysOf(p)).toEqual(keysOf(ref));
      for (const g of ['urban', 'lab', 'cart', 'land', 'tex'] as const) expect(keysOf(p[g])).toEqual(keysOf(ref[g]));
      for (const k of ['paper', 'ink', 'inkSoft', 'seaFill', 'waterEdge', 'roadFill', 'roadEdge', 'treeFill', 'treeInk'] as const) expect(p[k]).toMatch(HEX);
      for (const k of ['street', 'yard', 'mass', 'massEdge', 'wall', 'wallFill', 'landmark', 'landmarkEdge', 'place', 'garden'] as const) expect(p.urban[k]).toMatch(HEX);
      for (const [, c] of p.hypso) expect(c).toMatch(HEX);
      expect(p.urban.massEdgeW).toBeGreaterThan(0);
    }
  });
  it('the style identities asked for are there', () => {
    const P = PALETTES;
    expect(P.watabou.shade).toBeLessThan(0.15);
    expect(P.watabou.urban.wallScale).toBeGreaterThan(1.3);
    expect(P.engraving.hatch).toBeGreaterThan(0.5);
    expect(P.engraving.urban.shadow?.hatch).toBe(true);
    expect(P.engraving.treeShape).toBe('crown');
    expect(P.cadastre.urban.plotAlpha).toBeGreaterThan(0.7);
    expect(P.blueprint.paper.toLowerCase()).toMatch(/^#1[0-4]/);
    expect(P.illuminated.frameKind).toBe('illuminated');
    expect(P.topographic.contourOpacity).toBeGreaterThan(0.6);
    expect(P.night.urban.lit).not.toBeNull();
  });
});

describe('labels', () => {
  it('area labels are upright spaced caps, water is italic', () => {
    for (const s of STYLES) {
      const k = kindStyles(s, PALETTES[s]);
      expect(k.forest.italic).toBe(false);
      expect(['small', 'upper']).toContain(k.forest.caps);
      expect(k.forest.spacing).toBeGreaterThan(0.1);
      expect(k.forest.minPx).toBeGreaterThanOrEqual(12);
      expect(k.sea.italic).toBe(PALETTES[s].lab.waterItalic);
    }
  });
  it('mid zoom shows major streets only; lesser ranks need a closer view', () => {
    const base = kindStyles('parchment', PALETTES.parchment).street;
    const ms = [0, 1, 2, 3, 4].map((r) => streetRankStyle(base, r).minScale);
    for (let i = 1; i < 5; i++) expect(ms[i]).toBeGreaterThan(ms[i - 1]);
    expect(ms[0]).toBeLessThan(0.15); // arterials from mid zoom
    expect(ms[1]).toBeGreaterThanOrEqual(0.25); // primary streets only toward near zoom
    expect(ms[2]).toBeGreaterThanOrEqual(0.4);
    expect(ms[4]).toBeGreaterThanOrEqual(0.9);
  });
});

describe('render from one world', () => {
  const world = generate(makeOptions({ seed: '7', size: 'village', coast: 'W' }));
  const before = JSON.stringify([world.stats, world.urban?.buildings.length, world.terrain.coastline.length]);

  it('every style renders an SVG without touching the world (style switch = re-render)', () => {
    const svgs = new Map<string, string>();
    for (const s of STYLES) {
      const svg = renderSvg(world, { style: s, legend: true });
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
      expect(svg).toContain(`data-style="${s}"`);
      expect(svg).toContain('class="legend"');
      expect(svg).toContain('class="cartouche"');
      svgs.set(s, svg);
    }
    expect(new Set(svgs.values()).size).toBe(STYLES.length);
    expect(JSON.stringify([world.stats, world.urban?.buildings.length, world.terrain.coastline.length])).toBe(before);
    // deterministic
    expect(renderSvg(world, { style: 'night', legend: true })).toBe(svgs.get('night'));
  });
  it('style extras show up only in their styles', () => {
    expect(renderSvg(world, { style: 'night' })).toContain('class="u-lit"');
    expect(renderSvg(world, { style: 'parchment' })).not.toContain('class="u-lit"');
    expect(renderSvg(world, { style: 'engraving' })).toContain('class="u-shadow"');
    expect(renderSvg(world, { style: 'engraving' })).toContain('p-waterlines');
    expect(renderSvg(world, { style: 'blueprint' })).toContain('layer-grid');
    expect(renderSvg(world, { style: 'watabou' })).not.toContain('p-shadow');
  });
  it('legend and cartouche never overlap in the export layout', () => {
    for (const s of STYLES) {
      const pal: Palette = PALETTES[s];
      const c = cartoucheModel(world, pal, 1), l = legendModel(world, pal);
      // export layout: cartouche at the top, legend at the bottom of a 1600-unit map (panel units are 1/u of the map)
      const cBottom = 40 + c.h, lTop = 1600 - 40 - l.h;
      expect(lTop).toBeGreaterThan(cBottom + 100);
    }
  });
  it('lit windows are deterministic and only on some buildings', () => {
    const a = litDots(world, 0.5), b = litDots(world, 0.5);
    expect(Array.from(a)).toEqual(Array.from(b));
    const n = world.urban!.buildings.length;
    expect(a.length / 2).toBeGreaterThan(n * 0.2);
    expect(a.length / 2).toBeLessThan(n * 1.2);
  });
  it('frames exist for every kind', () => {
    for (const s of STYLES) {
      const prims = frameModel(1600, 1600, PALETTES[s], true);
      expect(prims.length).toBeGreaterThan(PALETTES[s].frameKind === 'none' ? 0 : 1);
    }
  });
  it('the canvas renderer draws every style at far, mid and near zoom', () => {
    for (const s of STYLES) {
      const m = mockCanvas(1100, 800);
      const r = createCanvasRenderer(m.canvas as unknown as CanvasLike, world, s, { Path2D: MockPath2D as never, dpr: 1, terrain: () => null });
      r.setOverlays({ legend: true });
      for (const scale of [0.05, 0.15, 0.6, 1.4]) {
        const st = r.draw({ cx: world.mapSize / 2, cy: world.mapSize / 2, scale });
        expect(st.ms).toBeGreaterThanOrEqual(0);
      }
      expect(m.log.calls.fill ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('downloads', () => {
  const blob = new Blob(['x'], { type: 'image/svg+xml' });
  const mk = (save: (o: unknown) => Promise<unknown>) => ({ use: async (n: string) => (n === 'downloads' ? { save } : null) });

  it('uses the host capability when present', async () => {
    const saved: unknown[] = [];
    let anchors = 0;
    const r = await saveFile('a.svg', blob, 'image/svg+xml', { claude: mk(async (o) => { saved.push(o); }), anchor: () => { anchors++; } });
    expect(r).toBe('saved');
    expect(saved.length).toBe(1);
    expect(anchors).toBe(0);
    expect((saved[0] as { filename: string }).filename).toBe('a.svg');
  });
  it('declined does nothing', async () => {
    let anchors = 0;
    const r = await saveFile('a.json', 'x', 'application/json', { claude: mk(async () => { throw { code: 'declined' }; }), anchor: () => { anchors++; } });
    expect(r).toBe('declined');
    expect(anchors).toBe(0);
  });
  it('unavailable / not_granted / no capability fall back to the anchor', async () => {
    for (const env of [
      { claude: mk(async () => { throw { code: 'unavailable' }; }) },
      { claude: mk(async () => { throw { code: 'not_granted' }; }) },
      { claude: { use: async () => null } },
      { claude: { use: async () => { throw new Error('boom'); } } },
      { claude: undefined },
    ]) {
      const got: { name: string; type: string }[] = [];
      const r = await saveFile('b.png', 'data', 'image/png', { ...env, anchor: (b, n) => { got.push({ name: n, type: b.type }); } });
      expect(r).toBe('fallback');
      expect(got).toEqual([{ name: 'b.png', type: 'image/png' }]);
    }
  });
});

describe('JSON export', () => {
  it('keeps options and vector layers, drops rasters', () => {
    const world = generate(makeOptions({ seed: '7', size: 'hamlet' }));
    const txt = worldToJson(world);
    const doc = JSON.parse(txt);
    expect(doc.format).toBe('magna-urbis-world');
    expect(doc.world.options.seed).toBe('7');
    expect(doc.world.mapSize).toBe(world.mapSize);
    expect(doc.world.urban.buildings.length).toBe(world.urban!.buildings.length);
    expect(doc.world.terrain.height.data.omitted).toBe('Float32Array');
    expect(doc.world.debug).toBeUndefined();
    expect(txt.length).toBeLessThan(2_500_000);
  });
});
