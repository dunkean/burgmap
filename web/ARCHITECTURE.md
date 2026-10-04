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
npm run test:fast  # development suites, excluding the exhaustive city matrix
npm run test:slow  # exhaustive city/culture/mix matrix
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

## Biomes

`gen/biomes.ts` defines `temperate`, `forest`, `desert`, `steppe`, `tropical` and `tundra` climates. `Options.biome` is optional: existing links and the default temperate generator retain their output. The biome selector is a generation control and round-trips through `biome=` in links and exports.

Rural classification combines the selected biome with water distance, height above water, slope, soil variation and settlement access. Desert fields and oasis groves require nearby water; woodland/tropical clearings shrink around settlements; steppe keeps riverine groves; tundra is treeless. Farm lots in deserts require water access. `render/biomes.ts` supplies a shared, immutable palette to both renderers and their terrain/legend layers. `scripts/biome_previews.ts` renders the six landscapes for visual checks.

## Wet moats

`urban/moat.ts` reserves a wet ditch 8–19 m outside the actual curtain, including the external curtain of a double enceinte. `Options.moat` (`moat=auto|yes|no`) is a generation control; Auto enables suitable Chinese sites. Water distance, height above water and slope limit the ditch; rejected terrain cells, roads, gates, barbicans and prior landmark lots remain dry. A failed water clipping operation drops its result rather than flooding protected land.

`UrbanLayer.moats` distinguishes defensive water from tanks and mill races, which all share `water`. The optional `ruralReserve` keeps ditch/berm land out of rural lots without enlarging the built-up `footprintH`. Macro quarters exclude the defensive reserve; bridges and navigable banks still use natural water. SVG paints water pieces separately with holes, while Canvas uses opposite hole winding and nonzero fill so overlaps stay wet.

## Coordinates & units

- World units are **meters**. Map is a square `[0, mapSize]²` with origin top-left, y down (SVG convention).
- Size presets (options.size): `hamlet` (~50–150 inhabitants, map 1200 m), `village` (~300–800, 1600 m), `town` (~2k–5k, 2400 m), `city` (~10k–25k, 3600 m), `capital` (~40k+, 5000 m). Terrain grid resolution: ~ mapSize / 4 m… choose so the grid is ≤ 512² (e.g. 256–512 cells per side).
- Realistic dimensions (medieval): main street 6–10 m, secondary 4–6 m, alleys 2–3 m; burgage plots 5–10 m frontage × 20–60 m depth; houses 5–9 m wide × 8–14 m deep; parish church 30–60 m long; cathedral 80–140 m; market square 1500–6000 m²; town wall 2–3 m thick with towers every 40–80 m; strip fields 10–25 m × 150–250 m.

## Determinism

- `core/rng.ts`: `Rng` = sfc32 seeded from a string/number hash. `rng.fork(label)` returns an independent child stream (hash of parent seed + label). Every stage gets `root.fork('<stage>')`, and sub-features fork further (`fork('river')`, `fork('block:12')`), so toggling one option does not reshuffle unrelated stages.
- Never use `Math.random()` in `src/gen`. Same seed + options ⇒ byte-identical SVG (tested).

## Generation workflow and general theme

Optional `Options.workflow` selects environment-only, automatic or main-inclusive
list generation (URL `mode=e|a|l`). Legacy `settl=` remains the secondary-only
format; `set2=` carries ordered instances with sparse `SettlementOverrides`.
`compose=` remembers the selected composition while editing an environment.

`World.options` is the general theme. Resolve the main instance with
`optionsForMainSettlement`; secondary, eager and lazy views use
`optionsForSettlement`. An instance's custom culture must not alter siblings
or silently retain another culture's mixture. Per-instance positions remain
independent of inherited properties. Regional road connections follow the
shared network rather than promising an exact degree for every settlement.

Environment generation returns after terrain and `landuse/natural.ts`: natural
cover uses the shared vectorizer without human cultivation, site, urban, roads
or settlement-name stages. `generationUid` fingerprints normalized effective
generation options, independent of style, camera, pins and dormant composition.
Imported pixels have a separate fingerprint and are not embedded in URLs.

The UI keeps draft and applied options separate. Only explicit generation buttons
apply draft generation controls; links and exports describe the displayed map.

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
- **Suburbs** (`suburbs.ts`): `suburbs: auto|none|some|many`; Auto deterministically develops no, some or several actual road approaches. Connected extensions meet the parent ground; many = thicker, longer ribbons, an outer polygonal enclosure for walled cities (the old line fossilizes), absorbed villages with a green and suburb parishes (`place: 'suburb'`); medina mellah (ward wall), warehouse row, craft quarter.
- **Shanty towns** (`shanty.ts`): land-value field (glacis, floodplain, slope, roadside, nuisance; culture flavour) → regions; own partition: relaxed Voronoi hut cells, pruned footpath tree, huts 15–40 m², 50–70 % coverage; block kind `shanty`.
- **Output**: `UrbanLayer.sites` (id, kind, role, lot, entrance, anchor, `name` hook filled by `names/`), `quays`, wall `role`. Tests: `tests/urban.m4.test.ts` + `tests/m4Check.ts`. Previews: `scripts/m4_previews.ts` (→ `out/m4_*.png`, `out/m4_contact.png`), `scripts/m4_shot.ts --site <kind>`.

## Urban ground and completed roofs

`landuse/landscapeGround.ts` supplies opaque ground from actual terrain and
natural-cover permissions. SVG and Canvas omit artificial outer settlement
outlines while retaining real walls, fences and lot boundaries. Macro
stand-ins and detailed quarters share the same ground contract.

`urban/edgeRoofs.ts` completes ordinary exposed roofs only after proving
owner, peer, physical-land and access clearance. Its local perpendicular
frame does not change the shared polygon OBB implementation. Parcels too
small for a whole 4.5 m roof require separate land reassignment; the
finisher does not delete dwellings to hide them.

`urban/densityRepair.ts` restores mature residential coverage by bounded
enlargement of existing ordinary roofs inside their own usable gardens.
It preserves planning partitions, building metadata and access, caps each
roof against its original area, and measures all added protected-land contact
from its original polygon across every proposal. Sparse cultural, young-edge,
faubourg and village programmes remain unchanged.

Where ordinary fitting fails, eligible neighbours in the same block and zone
can exchange unoccupied garden land. The transfer conserves their original
union, both real frontage arcs, donor roofs and prior block access. Its local
checked union preserves short inherited boundary vertices; failed physical
or garden proofs leave both owners untouched.

Natural cover beside regional roads is cut by vector strips at the real
half-width plus 6 m, rather than by the broad cultivation exclusion cells.
Fields and farm placement retain their coarse safety exclusion.

Automatic regional planning limits companion population to the main
settlement population; each companion is smaller than the main one.
Explicit counts and instance lists retain their requested programme. On
coarse terrain, an empty smoothed tiny phase may recover a small connected
dry region before the ordinary slope, water and access checks. Empty eager
settlements do not reserve or clear a false footprint; planned macro
quarters remain eligible for deferred detail.

## Settlement system (M3c)

Spec: `REGION_SETTLEMENTS.md`. Options `mapSize` (600 m–40 km, URL `map=`), `population` (10–5 M) and `settlements` (`auto | none | {counts} | {list}`, URL `settl=`); legacy links without `map=` keep their preset and reproduce exactly (`effectiveSize`).
- Pipeline: terrain → main site / roads / urban (unchanged) → `settlements/planner.ts` (archetype scoring per class band and culture, central-place spacing `pairSpacing`, extent gaps, main footprint exclusion; stable keys `fork('settlement:' + key)`) → `settlements/network.ts` (Delaunay + MST + detour shortcuts, regional A* via `roadContext`, junctions outside the main footprint, exits for secondary towns) → `settlements/urban.ts` (urban engine on a per-settlement World view, bounded cost field, clipped to the Voronoi cell) → land use from all settlements (`ringScale`, woodland between territories) → names (`settlementNames`).
- Above `EAGER_POP` (50 k total) secondary plans are lazy: `generateSettlementDetail(world, i)` runs in the generation worker when the view comes close (`detail` / `settlement` messages); renderers draw `renderView(world)` (all plans merged, lazy ones as their extent).
- Tests: `tests/settlements.test.ts` + `tests/settlementCheck.ts`. Previews: `scripts/m3c_previews.ts` (→ `out/m3c_*.png`), timings `scripts/m3c_time.ts`, UI `scripts/m3c_ui.mjs`.

## Megacity scaling (URBAN_MORPHOLOGY §3d)

Main settlements above `eagerPop` (option, URL `eager=`, default `EAGER_MAIN_POP` = 40 000) take the megacity path; at or below it the eager town stage runs exactly as before (whole-world hashes unchanged). The capital preset (40–60 k) is therefore lazy: its eager plan took 14–18 s in the urban stage.
- **Macro plan, eager** (`urban/mega/plan.ts`): growth rings = cost isolines of the land each phase needs (2–5 rings by population, shares growing ×1.9, densities × 1–1.5 with size, low-frequency lobes; planned cultures use their figure), the old lines as boulevards and the last one or two standing as walls; radials = the regional roads (the main ones to the market) plus new ones out of every ring where the arc between two radials exceeds ~0.6–1.5 km; nuclei = fused market towns (own wall or boulevard, market, spokes) and absorbed villages (green + spokes). All lines go into one `StreetGraph`; its faces minus the water are split by chords along the radial/tangential field of the nearest nucleus (secondary arterials) into quarters of 4–15 ha. Each `MacroQuarter` has its polygon and edge labels (street ids / wall / water / open), phase, zone, age, morphology, culture, density, district (old town, town, suburb, village, satellite, port, palace, cathedral, craft, gardens) and the landmarks it should claim (cathedral close by the market, parish churches, abbeys). City-rank lots: the palace city (a quarter-sized lot), parks; port quarters turn their water edges into quays; bridges where arterials cross a river. The site keeps the city's radius off the map edge (`SitePrefs.margin`). Current timings are recorded in `../PERFORMANCE_STUDY.md`.
- **Quarter detail, lazy** (`urban/mega/detail.ts`, 100–250 ms): the level 2–4 engine (splitQuarter, closes / derbs, carveBlocks, compounds, cutPlots / cutCourtyards, buildOn, access, masses) on one quarter with the arterials around it (same ids as the macro labels) and its own stream. It never sees another quarter's streets, so it is independent of the generation order and equals the quarter of a "generate all" run.
- **Worker / UI**: `QuarterQueue` (`ui/megaQueue.ts`) lives in the generation worker. View requests prioritize central quarters, cap the visible request and LRU at 420, and prefetch at most 140. `quarterPool.ts` runs at most two nested quarter workers with an immutable reduced World snapshot (`quarterPoolCore.ts`): terrain, water, site/cost fields and macro plans remain; names, land use, hydrological analysis grids and eager detail are omitted. Per-quarter failures retry once in slices on the original World; transport failure switches the pool to sliced generation. Rerolls discard stale replies and terminate workers. Batches arrive within roughly 150 ms and rebuild the displayed scene at most every 400 ms. Secondary-plan identity controls snapshot refresh; ordinary detail batches do not reclone it.
- **Stand-ins and exports**: `renderView` → `megaView` merges exact quarters and uses `mega/standin.ts` elsewhere. Stand-in caches include nucleus and budget identity, with a shared 12,000-block/32,000-mass budget and local 64-block/512-mass caps. Frontage, usable courts and reserved open places survive coarse detail. Full SVG/export requests generate every quarter through a separate export cache; they deliberately exceed the interactive 420-quarter limit.
- **Extent**: `mega/extent.ts` expands only implicit map presets for explicit populations. Custom maps, automatic-region extents and imported heightmaps remain authoritative. All growth rings share one containment scale and retain a 150 m map margin. The realized extent is stored in options for reproducible URL/export reloads; capacity shortfalls carry planned-population/land/extent warnings.
- Tools: `scripts/mega_view.ts` (macro plan by district / density, `--detail N`), `tests/mega.test.ts` (threshold, lazy = eager quarter, order independence, tiling, render merge; `BURGMAP_PERF=1` for the 1 M / 5 M timings).

`mega/boundary.ts` restores the original outer supports after recursive graph
splits and before face extraction. Production uses `preserveValid`: an already
admissible graph stays byte-identical; a real exterior overflow beyond the
existing graph/Boolean rounding budget triggers complete restoration. It moves
shared coordinates together, keeps incidence and labels, and is terminal:
do not query the graph's spatial indices afterward. `mega/nucleus.ts` repairs
only road fans that exclude the real centre
and selects one verified dry reserved face, including legitimate water-bank
labels; unavailable native programmes produce an explicit warning.

## Native cultural programmes

`NucleusSpec.builder` names a registered compound builder independently of its
generic nucleus kind. Eager, macro and lazy detail paths use the same builder;
an explicit kind override clears an inherited builder. Every worker runtime
registers the required operators and compounds, including reduced-snapshot
quarter workers. Unknown builders fall back to an open parcel, and registry
lookups reject inherited object properties. Worlds remain structured-clonable.

`swahili.ts` supplies coral-stone courtyard houses, bazaars, Juma/local mosques,
merchant mansions, a fort and waterfront programmes. `primitive_features.ts`
retains cattle kraals, chief halls, kivas, native banks and garden boundaries
after village-to-town growth. House fittings preserve physical minimum sizes,
served passages and previously valid buildings.

Swahili angular commerce falls back to a real served core quarter only when no
buildable bazaar quarter exists; a mosque or place with that morphology does not
provide shops. `persianhouse.ts` removes tiny acute roof tips locally, accepting
only a simple contained footprint with preserved physical dimensions and an
analytically bounded area loss. Failed geometry proofs preserve the old house.

## Displayed frames and PNG export

`ui/frameHandoff.ts` distinguishes the requested generation from the displayed
bitmap. A map stays visible and interactive during generation; accepted frames
carry their own options, name, centre and content version. Ready means the final
version was actually displayed. A render-worker error restores the prior scene.
Typed replies are dispatched before legacy SVG/progress replies.

Canvas field furrows share SVG phase, spacing and hole/strip clipping. Tiny
fields and views with more than 350 eligible fields omit texture while retaining
field geometry and tones. Furrow paths have a separate bounded LRU.

PNG export captures the displayed World/options/name before yielding. The page
decodes native SVG and draws it to a full-size HTML canvas; `createImageBitmap`
of that canvas is sent to a fresh worker for PNG encoding. This retains native
SVG text pixels exactly. The page raster phases still cost time: fallback export
can pause it for roughly half a second on measured 3,000-pixel cases. Progress
reports build/decode/draw/snapshot/encode/save. Bitmaps, canvas dimensions and the
encoding worker are released on completion/error. Worker/measurement refusal and
`file://` retain generation, display and export fallback paths.
