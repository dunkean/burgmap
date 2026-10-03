# Burgmap — serverless medieval settlement generator

Goal: `(seed | heightmap image) + options → a medieval settlement in its landscape`, entirely in the browser (no server). Quality/realism target: better than watabou's Medieval Fantasy City Generator. The map must read like a plausible historical plan: land use follows terrain, water and access; buildings, streets, plots, fields, walls and landmarks are distinguishable.

The Python code in `../town_generator/` is a prototype/reference only (algorithms for roofs, populators, terrain_v2 rivers, etc. can be read for ideas). Do not import or port it wholesale.

**Urban form rule (from the user, non-negotiable):** towns must look like *medieval European* towns — intricate, organic, grown in successive stages, often radio-concentric (older wall lines survive as curved ring streets), irregular blocks, Y-forks and small triangular places. Never modern North-American straight-line subdivisions; a regular (bastide) grid only as an explicit option or very sporadically.

**Scale & cultures:** population is continuous from 10 to 5 000 000 inhabitants, and plans come from mixable cultural morphologies (historical and fantasy). See `URBAN_MORPHOLOGY.md` (§3d: scale ladder, lazy per-district generation, Canvas LOD above ~50 k).

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

## Map styles (M5b)

`src/render/styles.ts` is the single style system: a `Palette` of tokens for every layer (paper, ink, hillshade strength and hatching, water incl. engraved water lines, land-use fills/textures/tree shape, roads, street space, building roof / outline / cast shadow / lit windows, landmarks, walls, labels and fonts, contour colour, drawing grid, frame kind, cartouche). Styles: `parchment`, `atlas`, `watabou` (plain classic), `engraving`, `cadastre`, `blueprint`, `illuminated`, `topographic`, `night`. `MapStyle` is the full union; `StyleName` in `gen/options.ts` still lists only the first two (gen is off limits to render work), so the UI reads/writes `style=` itself (`parseOptions` in `ui/main.ts`).

- SVG (`svg.ts`, `urban.ts`, `landuse.ts`, `extras.ts`, `frame.ts`) and Canvas (`canvas.ts`) read only the palette. `extras.ts` holds what is layered over the shared urban drawing (hatched shadows via mask, lit windows, water lines, grid); `frame.ts` describes frame + north arrow once as panel primitives (SVG scales them by u, canvas paints them around the map rectangle).
- A style switch only re-renders: `ui/main.ts` keeps the `Scene` per world and rebuilds just the renderer.
- Adding a style = one `derive(...)` call in `styles.ts`; `tests/m5b.test.ts` checks that every token is defined and that all styles render through both renderers.
- Exports go through `ui/download.ts`: the claude.ai Artifact `window.claude.use('downloads')` capability when present (`declined` = do nothing, `unavailable`/`not_granted` = fall back), else `<a download>` (works from `file://`). `ui/exportWorld.ts` writes the JSON export (options + vector layers, no rasters).
- Scripts: `scripts/m5b_shots.mjs` (all styles x cases x zooms through the UI select), `scripts/m5b_contact.mjs` (3x3 contact sheet), `scripts/export_check.mjs` (export paths incl. a mocked Artifact host).

## River network and road junctions (hydro pass)

- `terrain/rivernet.ts` owns the physics. Every river carries a **contributing area** per vertex (`area`, virtual m2 incl. the catchment outside the map; `ext` = its external part) and width follows `w = WIDTH_K * sqrt(area)`. Classes (`cls`): brook < 3.6 m, stream < 9.5 m, river < 26 m, major (scaled for big maps by `scaleFor`).
- Only **brooks** rise inside the map (`source: 'spring' | 'lake'`, width capped, min length ~90 m). Anything wider is **edge-fed**: the main river (`main`, `source: 'edge'`, head exactly on the map edge, full external discharge) and a few natural streams whose heads are near an edge (they get a tangent-continuous lead-in from the edge and an external catchment). External area of a tributary is added to its host from the confluence downward, so the host is always wider below a confluence.
- Confluences: `assembleChannels` (hosts processed before tributaries) truncates a channel at its first contact with a finished one (crossing or running alongside), inserts the junction as a vertex of the host and bends the last stretch to 40-60 deg pointing downstream (straight 18 m tail). `River.id/host/mouth` describe the tree (`mouth`: river | sea | lake | edge). Each lake gets exactly one outlet brook; estuary widening only applies where the main river meets the sea.
- `core/pline.ts` = shared polyline helpers (nearest, crossings, Bezier blend, vertex insertion).
- Roads (`roads/regional.ts` + `roads/junctions.ts`): a new road is cut where it comes within ~10 m of the network, then `attachEnd` makes a Y/T junction at a shared vertex (joiner 35-145 deg to the host's forward direction, else blended). Tracks keep 16 m from other roads except at their ends and join at both ends the same way. Stubs < 55 m are dropped. `bridgeRoad` rebuilds each river crossing as a bridge at 90 deg to the river with dry approaches and a straight 13 m lead-in on both sides; brooks narrower than 3 m are fords (only brooks). `SiteFields.wide` marks river cells that need a bridge.
- Invariants: `tests/hydroCheck.ts` (used by `tests/hydro.test.ts` and `scripts/hydro_audit.ts`); viewers: `scripts/hydro_view.ts` (terrain + rivers by class + roads + bridges, `--crop x,y,w`), `scripts/hydro_survey.ts`.

## Landmarks, activities, port, suburbs, shanty towns (M4)

`urban/m4/` implements URBAN_LANDMARKS.md. `index.ts` decides the features (`m4Flags`: options × size × the culture's `m4` catalogue) and registers the plan builders in `COMPOUND_BUILDERS`.

- **Level-1 lots.** `buildPrimary` takes `preLots` (the castle, sited before the faubourgs because it may extend the enclosure to E ∪ C) and a `reserve(api)` callback run after the radials, rings and market ring are registered and before the quarters are formed. Each `ReservedLot` is subtracted from every band and becomes its own band (`piece`: compound lot, open place such as the quay apron / piers / village green, or an ordinary quarter such as the harbour strip or an absorbed village core); later lots are cut by earlier ones, lots outside the footprint extend it. Its connector streets are partition cuts like the radials. `m4/lots.ts`: clearance tests, `findConnectorX` (straight cut to the first connected street, may cross unconnected ones, never the wall outside a gate); `m4/site.ts`: generic coarse-then-refined lot search on raster masks; `m4/reserve.ts`: `giveAccess` (front or ring street + connector).
- **Castle** (`castle.ts`): convex 4–8 curtains fitted to the hill brow, scored on prominence, flanks, water wrap, citadel spot; straddles the wall; lot = C + ditch + esplanade ∩ E'; builder: baileys, keep, gatehouse, hall, chapel, ditch or moat, causeway. The curtain is a `walls` entry with `role: 'castle'` (stretches on the town wall are skipped). Kasbah = rectangle variant; villages may get a motte.
- **Catalogue** (`catalogue.ts`, `plans.ts`): cathedral close (parvis, cruciform cathedral 80–140 m oriented east, cloister, bishop's palace, canons' houses, close wall), palace (forecourt, logis and wings, garden), monasteries (inside near the wall / outside by the gates; church, cloister, garden, orchard, precinct wall), madrasa (medina), hospital (level 2, by a gate), market hall / town hall with belfry on the grand-place (`market.ts`).
- **Port** (`port.ts`): shore run → RDP straight segments → stone edge shifted per segment to the water side of its shore points; apron (place), quay street, ribs, harbour strip (quarter), piers / moles with chain towers, shipyard (dry yard + slipways), rope walk; fish market and customs house on the apron; `UrbanLayer.quays` holds the stone edges.
- **Activities** (`activities.ts`, `inns.ts`): watermills (weir, race, mill astride it), windmills on knolls, tanneries downstream, gallows / lazar house / cemetery by the roads (tracks to the road), arena (Lucca-style oval of houses), gate inns from merged plots and smithies.
- **Suburbs** (`suburbs.ts`): `suburbs: none|some|many`; many = thicker, longer ribbons, an outer polygonal enclosure for walled cities (the old line fossilizes), absorbed villages with a green and suburb parishes (`place: 'suburb'`); medina mellah (ward wall), warehouse row, craft quarter.
- **Shanty towns** (`shanty.ts`): land-value field (glacis, floodplain, slope, roadside, nuisance; culture flavour) → regions; own partition: relaxed Voronoi hut cells, pruned footpath tree, huts 15–40 m², 50–70 % coverage; block kind `shanty`.
- **Output**: `UrbanLayer.sites` (id, kind, role, lot, entrance, anchor, `name` hook filled by `names/`), `quays`, wall `role`. Tests: `tests/urban.m4.test.ts` + `tests/m4Check.ts`. Previews: `scripts/m4_previews.ts` (→ `out/m4_*.png`, `out/m4_contact.png`), `scripts/m4_shot.ts --site <kind>`.

## Settlement system (M3c)

Spec: `REGION_SETTLEMENTS.md`. Options `mapSize` (600 m–40 km, URL `map=`), `population` (10–5 M) and `settlements` (`auto | none | {counts} | {list}`, URL `settl=`); legacy links without `map=` keep their preset and reproduce exactly (`effectiveSize`).
- Pipeline: terrain → main site / roads / urban (unchanged) → `settlements/planner.ts` (archetype scoring per class band and culture, central-place spacing `pairSpacing`, extent gaps, main footprint exclusion; stable keys `fork('settlement:' + key)`) → `settlements/network.ts` (Delaunay + MST + detour shortcuts, regional A* via `roadContext`, junctions outside the main footprint, exits for secondary towns) → `settlements/urban.ts` (urban engine on a per-settlement World view, bounded cost field, clipped to the Voronoi cell) → land use from all settlements (`ringScale`, woodland between territories) → names (`settlementNames`).
- Above `EAGER_POP` (50 k total) secondary plans are lazy: `generateSettlementDetail(world, i)` runs in the generation worker when the view comes close (`detail` / `settlement` messages); renderers draw `renderView(world)` (all plans merged, lazy ones as their extent).
- Tests: `tests/settlements.test.ts` + `tests/settlementCheck.ts`. Previews: `scripts/m3c_previews.ts` (→ `out/m3c_*.png`), timings `scripts/m3c_time.ts`, UI `scripts/m3c_ui.mjs`.

## Megacity scaling (URBAN_MORPHOLOGY §3d)

Main settlements above `eagerPop` (option, URL `eager=`, default `EAGER_MAIN_POP` = 40 000) take the megacity path; at or below it the eager town stage runs exactly as before (whole-world hashes unchanged). The capital preset (40–60 k) is therefore lazy: its eager plan took 14–18 s in the urban stage.
- **Macro plan, eager** (`urban/mega/plan.ts`, < 1 s at 1 M, ~2.5 s at 5 M): growth rings = cost isolines of the land each phase needs (2–5 rings by population, shares growing ×1.9, densities × 1–1.5 with size, low-frequency lobes; planned cultures use their figure), the old lines as boulevards and the last one or two standing as walls; radials = the regional roads (the main ones to the market) plus new ones out of every ring where the arc between two radials exceeds ~0.6–1.5 km; nuclei = fused market towns (own wall or boulevard, market, spokes) and absorbed villages (green + spokes). All lines go into one `StreetGraph`; its faces minus the water are split by chords along the radial/tangential field of the nearest nucleus (secondary arterials) into quarters of 4–15 ha. Each `MacroQuarter` has its polygon and edge labels (street ids / wall / water / open), phase, zone, age, morphology, culture, density, district (old town, town, suburb, village, satellite, port, palace, cathedral, craft, gardens) and the landmarks it should claim (cathedral close by the market, parish churches, abbeys). City-rank lots: the palace city (a quarter-sized lot), parks; port quarters turn their water edges into quays; bridges where arterials cross a river. The site keeps the city's radius off the map edge (`SitePrefs.margin`).
- **Quarter detail, lazy** (`urban/mega/detail.ts`, 100–250 ms): the level 2–4 engine (splitQuarter, closes / derbs, carveBlocks, compounds, cutPlots / cutCourtyards, buildOn, access, masses) on one quarter with the arterials around it (same ids as the macro labels) and its own stream. It never sees another quarter's streets, so it is independent of the generation order and equals the quarter of a "generate all" run.
- **Worker / UI**: `QuarterQueue` (`ui/megaQueue.ts`) in the generation worker: `quarters` requests carry the view rectangle (scale ≥ 0.1 px/m), quarters nearest its centre first, ~150 ms slices, LRU of 420 quarters; batches go to the render worker (`QuarterMsg`), merged into `World.megaDetail` and redrawn at most every 400 ms. `renderView` → `megaView` merges the detailed quarters and draws the others as stand-in fabric (`mega/standin.ts`); far zoom uses the macro density raster (`UrbanLayer.densityGrid`). Export "SVG, all quarters (slow)" details every quarter first.
- Tools: `scripts/mega_view.ts` (macro plan by district / density, `--detail N`), `tests/mega.test.ts` (threshold, lazy = eager quarter, order independence, tiling, render merge; `BURGMAP_PERF=1` for the 1 M / 5 M timings).

