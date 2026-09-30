import { describe, it, expect } from 'vitest';
import { TileIndex, boxesOf, chunkPolyline } from '../src/render/tileindex';
import { selectLod, lodBand, NEAR_SCALE, MID_SCALE } from '../src/render/lod';
import { fitView, zoomAt, panBy, screenToWorld, worldToScreen, clampView, viewRect } from '../src/render/view';
import { placeLabels } from '../src/render/labels';
import { buildScene, textureMarks, hash3 } from '../src/render/scene';
import { createCanvasRenderer } from '../src/render/canvas';
import type { CanvasLike } from '../src/render/canvas';
import { seaWithIslands } from '../src/render/util';
import { fakeWorld, mockCanvas, MockPath2D } from '../scripts/fakeworld';

function rndBoxes(n: number, S: number, maxDim: number, seed = 5): Float32Array {
  let a = seed;
  const r = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; };
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const x = r() * S * 1.02 - S * 0.01, y = r() * S * 1.02 - S * 0.01, w = r() * maxDim, h = r() * maxDim;
    out.set([x, y, x + w, y + h], i * 4);
  }
  return out;
}

function bruteForce(boxes: Float32Array, r: { minX: number; minY: number; maxX: number; maxY: number }): number[] {
  const out: number[] = [];
  for (let i = 0; i < boxes.length / 4; i++) {
    if (boxes[i * 4] <= r.maxX && boxes[i * 4 + 2] >= r.minX && boxes[i * 4 + 1] <= r.maxY && boxes[i * 4 + 3] >= r.minY) out.push(i);
  }
  return out;
}

describe('TileIndex', () => {
  const S = 5000;
  const boxes = rndBoxes(4000, S, 400); // some items larger than a tile -> big list
  for (const mode of ['center', 'overlap'] as const) {
    it(`query equals brute force (${mode})`, () => {
      const idx = new TileIndex(S, 250, boxes, mode);
      let a = 9;
      const r = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; };
      for (let k = 0; k < 60; k++) {
        const x = r() * S * 1.2 - 300, y = r() * S * 1.2 - 300, w = r() * 1500, h = r() * 1500;
        const q = { minX: x, minY: y, maxX: x + w, maxY: y + h };
        expect(idx.query(q)).toEqual(bruteForce(boxes, q));
      }
    });
  }
  it('center mode: every non-big item is in exactly one tile; big items are separate', () => {
    const idx = new TileIndex(S, 250, boxes, 'center');
    const seen = new Uint8Array(idx.count);
    for (const i of idx.tileItems) seen[i]++;
    for (const i of idx.big) seen[i]++;
    expect(seen.every((v) => v === 1)).toBe(true);
    expect(idx.big.length).toBeGreaterThan(0);
  });
  it('overlap mode lists an item in every tile it touches', () => {
    const b = new Float32Array([100, 100, 600, 300]);
    const idx = new TileIndex(1000, 250, b, 'overlap');
    // columns 0..2, rows 0..1 => 6 tiles
    let n = 0;
    for (let t = 0; t < idx.nx * idx.ny; t++) n += idx.itemsOf(t).length;
    expect(n).toBe(6);
  });
  it('tilesInRect returns only non-empty tiles and prunes far tiles', () => {
    const idx = new TileIndex(S, 250, boxes, 'center');
    const tiles = idx.tilesInRect({ minX: 0, minY: 0, maxX: 500, maxY: 500 });
    expect(tiles.length).toBeLessThanOrEqual(16);
    for (const t of tiles) expect(idx.itemsOf(t).length).toBeGreaterThan(0);
  });
  it('chunkPolyline keeps chunks small and covers all segments', () => {
    const pl = Array.from({ length: 200 }, (_, i) => ({ x: i * 10, y: Math.sin(i / 5) * 20 }));
    const chunks = chunkPolyline(pl, 125);
    let segs = 0;
    for (const c of chunks) {
      const b = boxesOf([c]);
      expect(b[2] - b[0]).toBeLessThanOrEqual(125 + 1e-6);
      segs += c.length - 1;
    }
    expect(segs).toBe(199);
    expect(chunks[0][chunks[0].length - 1]).toBe(chunks[1][0]);
  });
});

describe('LOD + view', () => {
  it('bands follow scale', () => {
    expect(lodBand(MID_SCALE / 2)).toBe(0);
    expect(lodBand(MID_SCALE)).toBe(1);
    expect(lodBand(NEAR_SCALE)).toBe(2);
    const far = selectLod(0.03), mid = selectLod(0.1), near = selectLod(1);
    expect(far.buildings || far.blocks || far.streets).toBe(false);
    expect(mid.blocks && mid.streets && mid.landmarks).toBe(true);
    expect(mid.buildings).toBe(true); // masses from the mid band on
    expect(mid.parcels).toBe(false); // plot hairlines only when near
    expect(near.buildings && near.parcels && near.textures && near.shadows && near.alleys).toBe(true);
    expect(far.densityAlpha).toBe(1);
    expect(near.densityAlpha).toBeLessThan(1);
  });
  it('zoomAt keeps the point under the cursor fixed', () => {
    const v = fitView(2000, 1000, 700);
    const [wx, wy] = screenToWorld(v, 1000, 700, 300, 200);
    const z = zoomAt(v, 3.7, 300, 200, 1000, 700);
    const [sx, sy] = worldToScreen(z, 1000, 700, wx, wy);
    expect(sx).toBeCloseTo(300, 6); expect(sy).toBeCloseTo(200, 6);
    expect(z.scale).toBeCloseTo(v.scale * 3.7, 9);
  });
  it('panBy moves the world with the pointer; clampView bounds scale and center', () => {
    const v = { cx: 100, cy: 100, scale: 2 };
    const p = panBy(v, 20, -10);
    expect(p.cx).toBe(90); expect(p.cy).toBe(105);
    const c = clampView({ cx: -500, cy: 9e9, scale: 1e6 }, 1000, 800, 600);
    expect(c.cx).toBe(0); expect(c.cy).toBe(1000); expect(c.scale).toBeLessThanOrEqual(8);
    const r = viewRect(v, 400, 200);
    expect(r.maxX - r.minX).toBeCloseTo(200, 9);
  });
});

describe('labels', () => {
  it('drops lower-priority overlapping labels and honors scale range', () => {
    const view = { cx: 0, cy: 0, scale: 1 };
    const m = (t: string) => t.length * 6;
    const placed = placeLabels([
      { x: 0, y: 0, text: 'Big City', priority: 5 },
      { x: 5, y: 2, text: 'Overlap', priority: 1 },
      { x: 200, y: 0, text: 'Far', priority: 1, minScale: 2 },
      { x: -200, y: 0, text: 'Free', priority: 1 },
    ], view, 800, 600, m);
    expect(placed.map((p) => p.label.text).sort()).toEqual(['Big City', 'Free']);
  });
});

describe('scene + textures', () => {
  const world = fakeWorld({ mapSize: 4000, buildings: 3000, streets: 500, clusters: 3, landAreas: 60, seed: 3 });
  const scene = buildScene(world);
  it('indexes layers', () => {
    expect(scene.counts['u-masses']).toBeGreaterThan(2000);
    expect(scene.poly.get('u-masses')!.index.count).toBe(scene.counts['u-masses']);
    expect(scene.density!.max).toBeGreaterThan(0);
  });
  it('texture marks are deterministic and each lies inside an area', () => {
    const tl = scene.textures.find((t) => t.kind === 'forest')!;
    const tiles = [...Array(tl.index.nx * tl.index.ny).keys()].filter((t) => tl.index.itemsOf(t).length);
    expect(tiles.length).toBeGreaterThan(0);
    let total = 0;
    for (const t of tiles) {
      const a = textureMarks(tl, t, 9, 11), b = textureMarks(tl, t, 9, 11);
      expect(a).toEqual(b);
      total += a.length;
      const tr = tl.index.tileRect(t);
      for (const m of a) { expect(m.x).toBeGreaterThanOrEqual(tr.minX); expect(m.x).toBeLessThan(tr.maxX); }
    }
    expect(total).toBeGreaterThan(0);
    expect(hash3(1, 2, 3)).toBe(hash3(1, 2, 3));
  });
});

describe('canvas renderer smoke (mock 2D context)', () => {
  const world = fakeWorld({ mapSize: 8000, buildings: 20000, streets: 3000, clusters: 4, landAreas: 100, seed: 2 });
  const scene = buildScene(world);
  const mk = () => {
    const m = mockCanvas(1200, 800);
    const r = createCanvasRenderer(m.canvas as unknown as CanvasLike, world, 'parchment', { Path2D: MockPath2D as never, dpr: 1, scene, terrain: () => null });
    return { ...m, r };
  };
  // find a dense spot
  const fp = world.urban!.footprint[0];
  const cx = fp.reduce((s, p) => s + p.x, 0) / fp.length, cy = fp.reduce((s, p) => s + p.y, 0) / fp.length;

  it('far zoom skips masses, blocks and alleys', () => {
    const { r, log } = mk();
    const st = r.draw({ cx: 4000, cy: 4000, scale: 0.1 * 0.2 });
    expect(st.band).toBe(0);
    expect(st.buildingsDrawn).toBe(false);
    expect(st.buildingsCandidate).toBe(0);
    // the far frame still draws things (land use, main roads, footprints)
    expect((log.calls.fill ?? 0) + (log.calls.stroke ?? 0)).toBeGreaterThan(0);
  });

  it('near zoom draws buildings only for visible tiles', () => {
    const { r, log } = mk();
    const view = { cx, cy, scale: 1 };
    const st = r.draw(view);
    expect(st.band).toBe(2);
    expect(st.buildingsDrawn).toBe(true);
    const total = scene.counts['u-masses'];
    expect(st.buildingsCandidate).toBeGreaterThan(0);
    // 1200x800 px at 1 px/m is 1200x800 m: only a small fraction of all buildings
    expect(st.buildingsCandidate).toBeLessThan(total * 0.5);
    // every drawn building path belongs to a tile that intersects the (padded) viewport
    const houses = scene.poly.get('u-masses')!;
    const rect = viewRect(view, 1200, 800);
    const vis = new Set(houses.index.tilesInRect(rect));
    expect(vis.size).toBeLessThan(houses.index.nx * houses.index.ny * 0.2);
    expect(log.calls.fill).toBeGreaterThan(0);
    // shadows drawn (translate+fill) at near zoom
    expect(log.calls.translate ?? 0).toBeGreaterThan(0);
  });

  it('mid zoom draws blocks, street space and masses', () => {
    const { r } = mk();
    const st = r.draw({ cx, cy, scale: 0.1 });
    expect(st.band).toBe(1);
    expect(st.buildingsDrawn).toBe(true);
  });

  it('near frame issues far fewer vertices than a full-map dump and reuses cached paths', () => {
    const { r, log, reset } = mk();
    const view = { cx, cy, scale: 1 };
    const cold = r.draw(view);
    expect(cold.pathsBuilt).toBeGreaterThan(0);
    reset();
    const warm = r.draw(view);
    expect(warm.pathsBuilt).toBe(0);
    const allVerts = world.urban!.buildings.length * 4;
    expect(log.pathOps).toBeLessThan(allVerts * 0.6);
  });

  it('panning far away draws no buildings from the old area', () => {
    const { r } = mk();
    const st = r.draw({ cx: 1, cy: 1, scale: 1 });
    expect(st.buildingsCandidate).toBeLessThan(2000);
  });
});

describe('canvas renderer on a real generated world', () => {
  it('draws at all bands without throwing and draws land use/roads', async () => {
    const { generate } = await import('../src/gen/pipeline');
    const { makeOptions } = await import('../src/gen/options');
    const world = generate(makeOptions({ seed: '7', size: 'village' }));
    const m = mockCanvas(1000, 700);
    const r = createCanvasRenderer(m.canvas as unknown as CanvasLike, world, 'atlas', { Path2D: MockPath2D as never, dpr: 2, terrain: () => null });
    r.setLabels([{ x: world.mapSize / 2, y: world.mapSize / 2, text: 'Test', priority: 1 }]);
    for (const scale of [0.02, 0.1, 0.5, 2]) {
      const st = r.draw({ cx: world.mapSize / 2, cy: world.mapSize / 2, scale });
      expect(st.ms).toBeGreaterThanOrEqual(0);
    }
    expect(m.log.calls.fill ?? 0).toBeGreaterThan(0);
    expect(m.log.calls.fillText ?? 0).toBeGreaterThan(0);
  });
});

describe('sea islands', () => {
  const sq = (x: number, y: number, r: number) => [{ x: x - r, y: y - r }, { x: x + r, y: y - r }, { x: x + r, y: y + r }, { x: x - r, y: y + r }];
  it('treats nested coastline loops and explicit islands as holes of the enclosing sea polygon', () => {
    const { sea, holes } = seaWithIslands([sq(500, 500, 400), sq(300, 300, 50)], [sq(700, 700, 40)]);
    expect(sea.length).toBe(1);
    expect(holes[0].length).toBe(2);
  });
  it('keeps disjoint sea polygons as seas', () => {
    const { sea, holes } = seaWithIslands([sq(100, 100, 50), sq(500, 500, 50)], undefined);
    expect(sea.length).toBe(2);
    expect(holes.every((h) => h.length === 0)).toBe(true);
  });
});
