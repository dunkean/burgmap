# Burgmap — serverless medieval settlement generator

Goal: `(seed | heightmap image) + options → a medieval settlement in its landscape`, entirely in the browser (no server). Quality/realism target: better than watabou's Medieval Fantasy City Generator. The map must read like a plausible historical plan: land use follows terrain, water and access; buildings, streets, plots, fields, walls and landmarks are distinguishable.

The Python code in `../town_generator/` is a prototype/reference only (algorithms for roofs, populators, terrain_v2 rivers, etc. can be read for ideas). Do not import or port it wholesale.

## Tech

- TypeScript (strict), Vite, `vite-plugin-singlefile` → `web/dist/index.html` is one self-contained file that works from `file://` and as a static page.
- Allowed runtime deps (bundled): `d3-delaunay` (Voronoi/Delaunay), `polygon-clipping` (boolean ops), `fflate` (PNG encoding). Anything else: ask the orchestrator (write it in your final report).
- Dev deps: `vitest`, `@resvg/resvg-js` (rasterize SVG → PNG in Node for visual checks), `tsx`.
- Generation code (`src/gen/**`) is pure TS with NO DOM access, so it runs in Node (tests, preview script) and in a Web Worker.

## Commands (in `web/`)

```
npm run dev        # vite dev server
npm run build      # single-file build → dist/index.html
npm test           # vitest
npm run preview:png -- --seed 42 --size town [--opt k=v ...] --out out/x.png   # Node: generate + render SVG + rasterize
npm run typecheck
```
`scripts/preview.ts` is the main tool for visual verification: agents MUST look at the PNGs they produce (Read tool on the .png) before claiming a stage works.

## Layout

```
web/
  src/gen/            pure generation (no DOM)
    core/             rng.ts, noise.ts, geom.ts (Vec2, polygon utils), grid.ts (Float32 grids + sampling), pq.ts (binary heap), graph.ts (planar graph)
    terrain/          heightfield.ts, hydrology.ts, coast.ts, import.ts (heightmap from RGBA pixels)
    site/             site.ts (settlement center + site analysis)
    roads/            regional.ts (A* on cost grid, bridges/fords)
    landuse/          rural.ts (fields, pasture, forest, orchards, meadows)
    urban/            streets.ts, blocks.ts, parcels.ts, buildings.ts, walls.ts, landmarks.ts
    pipeline.ts       generate(options) → World  (runs all stages in order)
    options.ts        Options type, defaults, size presets, (de)serialization to URL
    types.ts          World and layer types (the contract below)
  src/render/         svg.ts (World → SVG string, works in Node + browser), styles.ts (palettes), raster.ts (hillshade/terrain → PNG data URL via fflate)
  src/ui/             main.ts, panel.ts, viewer.ts (zoom/pan), worker.ts
  scripts/preview.ts
  tests/
```

## Coordinates & units

- World units are **meters**. Map is a square `[0, mapSize]²` with origin top-left, y down (SVG convention).
- Size presets (options.size): `hamlet` (~50–150 inhabitants, map 1200 m), `village` (~300–800, 1600 m), `town` (~2k–5k, 2400 m), `city` (~10k–25k, 3600 m), `capital` (~40k+, 5000 m). Terrain grid resolution: ~ mapSize / 4 m… choose so the grid is ≤ 512² (e.g. 256–512 cells per side).
- Realistic dimensions (medieval): main street 6–10 m, secondary 4–6 m, alleys 2–3 m; burgage plots 5–10 m frontage × 20–60 m depth; houses 5–9 m wide × 8–14 m deep; parish church 30–60 m long; cathedral 80–140 m; market square 1500–6000 m²; town wall 2–3 m thick with towers every 40–80 m; strip fields 10–25 m × 150–250 m.

## Determinism

- `core/rng.ts`: `Rng` = sfc32 seeded from a string/number hash. `rng.fork(label)` returns an independent child stream (hash of parent seed + label). Every stage gets `root.fork('<stage>')`, and sub-features fork further (`fork('river')`, `fork('block:12')`), so toggling one option does not reshuffle unrelated stages.
- Never use `Math.random()` in `src/gen`. Same seed + options ⇒ byte-identical SVG (tested).

## Pipeline (each stage = pure function `(world, opts, rng) → adds its layer`)

1. **terrain** — heightfield from fBm/ridged simplex noise shaped by the `relief` option (`flat | hills | valley | mountains`); optional sea (`coast: none | N | E | S | W | random`), shaped so land rises from the coast; optional imported heightmap. Hydrology: priority-flood depression filling (Barnes 2014) → D8/D∞ flow directions → flow accumulation. Rivers = cells above an accumulation threshold, plus `river: none | stream | river | major` forcing an inflow at a map edge so a main river crosses the map (carve its valley). Output: `terrain.height` (grid, meters), `terrain.slope`, `terrain.water` (grid mask: sea/lake/river), river centerlines as smoothed polylines with width per vertex (widening downstream), lakes and coastline as polygons.
2. **site** — choose the settlement core: score cells by flatness, dryness (not floodplain), proximity to river (ford/bridge point = narrow river) or natural harbor (coast concavity), defensibility (hill/spur/meander) and centrality. Output: `site.center`, `site.harbor?`, `site.crossing?`, `site.citadelSpot?`, plus a travel-cost field (Dijkstra from center over slope/water cost) used downstream.
3. **roads** — regional roads from 2–6 map-edge exits (count scales with size, option `roads`) to the center: A* on the cost grid (slope penalty, water impassable except at bridge/ford cells with high but finite cost, preference for existing roads so routes merge). Bridges where roads cross rivers. Output: road polylines (smoothed), bridges.
4. **urban** (most important for realism):
   - **streets**: the urban footprint = cells within a travel-cost radius from center scaled to population. Main streets = regional roads inside the footprint. Secondary streets grow from main streets (branching roughly perpendicular every 60–150 m, following contours on slopes, snapping to nearby streets to form loops); alleys subdivide deep blocks. Build a planar graph.
   - **blocks**: faces of the street graph (minus street widths) clipped to land.
   - **parcels**: burgage plots — split each block along its street-facing edges into narrow deep strips (frontage 5–10 m), OBB/skeleton-style subdivision for irregular blocks (Vanegas et al. 2012). Larger plots near the edge, narrower in the core near the market.
   - **buildings**: on each plot, a house at the street front (continuous frontage in the core, detached towards the edge), occasional rear outbuildings; back of plot = yard/garden. Density decreases with distance from the center.
   - **walls** (option): curtain wall around the dense core, following high ground where possible, with towers and gates where main streets cross. Suburbs (faubourgs) may grow along roads outside the gates.
   - **landmarks & activities** (placed by rules, each can be toggled): market square at the main crossing near the center (widened street/funnel shape); parish church(es) with churchyard, cathedral for city+; castle/keep on the most defensible spot (hill, river bend) with its own enclosure; monastery/priory with cloister at the edge; guildhall/town hall on the market; docks/quays + shipyard + warehouses on the coast or navigable river; watermills on rivers (with mill race), windmills on exposed hills; tanneries/dyers downstream at the river; smithies and inns at gates; gallows outside; cemetery.
5. **landuse** (rural): von Thünen-like rings on travel cost: gardens & orchards next to town, open-field strip farming (strips grouped in furlongs oriented perpendicular to roads/contours), meadows on floodplains, pasture/commons on slopes, woodland on steep/far land, marsh near sluggish water. Hamlets/farmsteads scattered along roads for larger sizes.
6. **render** — SVG layers in order: terrain (raster hillshade + optional contours) → water → land-use areas (fields with strip hatching, forest texture, orchards dots) → roads → parcels/yards → buildings → landmarks → walls/towers/gates → bridges → labels/legend/scale bar/compass. Styles: `parchment` (ink on paper, watabou-like but richer), `atlas` (colored), `blueprint`/`mono`. Every layer has a CSS class so it can be toggled.

## World contract (`src/gen/types.ts`) — extend, don't break

```ts
type Vec2 = { x: number; y: number };
type Polygon = Vec2[];              // closed implicitly, CCW not guaranteed
type Polyline = Vec2[];
interface Grid { w: number; h: number; cell: number /* m per cell */; data: Float32Array }
interface World {
  seed: string; options: Options; mapSize: number;
  terrain: { height: Grid; slope: Grid; water: Uint8Array /* 0 land,1 sea,2 lake,3 river */; flow: Grid;
             seaLevel: number; coastline: Polygon[]; lakes: Polygon[];
             rivers: { path: Polyline; width: number[]; name?: string }[] };
  site?: { center: Vec2; crossing?: Vec2; harbor?: Vec2; citadelSpot?: Vec2; cost: Grid };
  roads?: { path: Polyline; kind: 'major'|'minor'|'track'; width: number }[];
  bridges?: { a: Vec2; b: Vec2; width: number }[];
  urban?: { footprint: Polygon[]; streets: { path: Polyline; width: number; kind: 'main'|'street'|'alley' }[];
            blocks: Polygon[]; parcels: { poly: Polygon; use: string }[];
            buildings: { poly: Polygon; kind: string; height?: number }[];
            walls?: { path: Polyline; closed: boolean; towers: Vec2[]; gates: Vec2[]; thickness: number }[];
            landmarks: { kind: string; poly: Polygon; name?: string }[];
            squares: Polygon[] };
  landuse?: { areas: { kind: 'field'|'meadow'|'pasture'|'forest'|'orchard'|'garden'|'marsh'|'commons'; poly: Polygon; stripAngle?: number }[] };
  stats: Record<string, number | string>;   // population estimate, counts, timings
}
```

## Quality bar (checked at each milestone, on seeds 1..10 × sizes)

- No buildings/parcels/roads in water (except bridges, quays), none overlapping each other or streets.
- Streets are connected; every parcel touches a street.
- Land use coherent (no fields on cliffs, meadows by rivers, forest on steep/remote land).
- Generation time: town < 1.5 s, capital < 6 s in Node.
- Deterministic.
