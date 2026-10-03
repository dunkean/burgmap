# Burgmap — handoff

State of the project at the pause (2026-10-04, updated after the final merges), how it is organised, how to work on it, and what is left.

- **Live site:** https://dunkean.github.io/burgmap/
- **Repository:** https://github.com/dunkean/burgmap. Local `master` is pushed to remote `main`. The built site lives on the `gh-pages` branch.
- **Licence:** GPL-3.0, because the old Python prototype derives from watabou's TownGeneratorOS.

## 1. What it is

Burgmap is a serverless generator of pre-modern settlements in their landscape. You give it a seed (or an imported heightmap) plus options. It produces terrain, rivers, a site, roads, fields, and one or more settlements down to individual building footprints. Everything runs in the browser, and the build is a single self-contained `index.html` that also works from `file://`.

The `town_generator/` folder (Python) is the earlier prototype. It is reference only and is not used by the web app.

## 2. Commands (in `web/`)

```bash
npm install
npm run dev                  # Vite dev server (http://localhost:5173)
npm run build                # dist/index.html, single file
npm test                     # vitest, about 20 min for the full suite (~620 tests)
npx vitest run tests/<file>.test.ts                 # one file
BURGMAP_PERF=1 npx vitest run tests/urban.town.test.ts   # timing assertions (quiet machine only)
npm run preview:png -- --seed 4 --size city --opt culture=medina --crop x,y,w --out out/x.png  # Node render, then Read the PNG
node scripts/ui_check.mjs http://localhost:5173/ out/chk --set "seed=4&size=city&culture=medina" --name x --scales fit,0.6   # Playwright screenshots of the real UI
GITHUB_TOKEN_FILE=/d/Workspace/dunk_token bash scripts/deploy_pages.sh   # build HEAD in a clean worktree and publish to gh-pages (run from repo root as web/scripts/...)
```

- `web/out/` and `web/scratch/` are gitignored scratch output.
- `web/scratch/perf/` holds whole-world hash and benchmark scripts. Use them to prove that an optimisation leaves the output unchanged.

## 3. Design documents (read before changing anything)

| file | content |
|---|---|
| `web/ARCHITECTURE.md` | pipeline, World data contract, units (meters), determinism, quality bar |
| `web/URBAN_GEOMETRY.md` | **core principle: partition, never place**. The hierarchy goes phase regions → quarters → blocks → plots → built parts, and streets are the cuts. It also covers density targets (§4.1) and fortifications (§3.9, straight curtains). |
| `web/URBAN_MORPHOLOGY.md` | culture system: phases, morphologies, operators, mixing, scale ladder 10 → 5 M, megacity LOD (§3d) |
| `web/URBAN_LANDMARKS.md` | landmark lot claiming, catalogue, port, suburbs, shanty towns |
| `web/REGION_SETTLEMENTS.md` | multiple settlements per map, settlement planner, road network |
| `BUGS.md` (repo root) | **the user's bug list, written by the user.** Read it first at every session. Fix the listed bugs and mark each one as fixed with the commit hash. Never delete the user's entries. |
| `web/POLISH.md` | user feedback backlog, with open and done items |

## 4. Code map (`web/src`)

- `gen/`: pure generation code. It has no DOM access and runs in Node, Web Workers and tests.
  - `core/`: rng (sfc32 + `fork(label)`), noise, grid, heap, geometry helpers, flood.
  - `terrain/`: heightfield, erosion, hydrology (priority flood, edge-fed rivers by contributing area, max 1–2 in-map springs), contours, heightmap import.
  - `site/site.ts`: site selection by **archetype first** (bridge, confluence, meander, harbor, estuary, valley, hilltop, plain), then optimisation.
  - `roads/`: regional A* roads, junction and bridge audit.
  - `settlements/`: multi-settlement planner, road network, per-settlement urban views, merge for rendering.
  - `urban/`: the town engine.
    - Core files: `index.ts` (orchestration), `level1.ts`/`phases.ts`/`primary.ts` (phases and arterials), `streets.ts`/`streetops.ts`/`field.ts` (guided splitting), `blocks.ts`, `plots.ts`, `houses.ts`/`buildings.ts` (footprints from plot, zone and wealth), `access.ts` (every building reachable), `walls.ts`/`fortify.ts`.
    - Culture data and logic: `culture.ts` (types and registry), `cultures*.ts` (presets as data), plus per-culture modules (`venice.ts`, `persian.ts`, `inca.ts`, …).
    - `camps/`: streetless cultures (kraal, tipi, longhouses, pueblo, stilts, ringfort, war camp, Khmer).
    - `m4/`: landmarks, castle, churches, port, bridges, activities, suburbs, shanty towns.
    - `mega/`: megacity macro plan, lazy quarter detail and stand-in fabric.
  - `landuse/`: rural land use and open-field systems (`fields.ts`: furlongs bounded by tracks and headlands, strips).
  - `names/`: toponym grammars. Optional; the user has their own name generator.
  - `pipeline.ts`: `generate(options, onStage)`. `options.ts` holds all options with URL round-trip; `types.ts` holds the World contract.
- `render/`:
  - `svg.ts` + `urban.ts` + `landuse.ts`: SVG renderer, used for export.
  - `canvas.ts` + `scene.ts` + `lod.ts` + `tileindex.ts`: interactive Canvas renderer with tiled Path2D batches and LOD bands.
  - `styles.ts`: 9 map styles.
  - A test (`tests/canvas_urban_kinds.test.ts`) keeps the two renderers in sync.
- `ui/`:
  - `main.ts`: panel. `settlementsPanel.ts`: map size, population and settlements editor.
  - `worker.ts`: generation. `renderWorker.ts`: OffscreenCanvas renderer.
  - `megaQueue.ts`: lazy megacity quarters.
  - `backend.ts`/`protocol.ts`: worker messaging. On `file://` it falls back to main-thread generation and rendering.

## 5. Invariants (enforced by tests)

- **Exact partition at every level:** no overlaps, area conservation, every plot has street frontage, every building lies inside its plot and is reachable from a street.
- **Determinism:** never use `Math.random()` in `gen/`. Every stage or feature uses `rng.fork('label')`. Adding a settlement must not change the others.
- **Main-town output below the eager threshold** (`eagerPop`, default 40 000) is byte-identical across refactors. Check with the hash scripts.
- **Plan rules from the user:**
  - European towns are organic, grown in phases and radio-concentric, never North-American grids.
  - Dense cores are 80–95 % built, with rare courtyards and no "matchstick" buildings (aspect ratio ≤ 3).
  - Walls are straight curtains between towers.
  - Cultures must be recognisable **from the plan alone**.
  - Plan quality comes before rendering polish.

## 6. Current state

- **43 culture presets**, each with a scale range:
  - **European family:** European organic, bastide, Roman core, Byzantine, Venetian, Hanseatic, Russian kremlin.
  - **Islamic and Asian:** medina, Persian, Ottoman, Sahel; Chinese, Japanese jōkamachi, Korean, Indian temple, Khmer.
  - **Americas:** Inca, Aztec, Maya, pueblo, Iroquoian, Plains camp.
  - **Other village and camp cultures:** kraal, nomad ordu; Germanic, Celtic and Norse villages; Norse ring fort, Celtic oppidum.
  - **Fantasy:** elven, dwarven, halfling, orcish, gnomish, stilt town, wizard city, necropolis.
  - Mixing by phase, sector or blend.
- **Options:** custom map size (600 m – 40 km), population (10 – 5 M), settlements (auto / counts / list with click-to-place), sprawl factor (0.5–2), castles (0–3), walls (none, single, double), suburbs, shanty towns, site type.
- **Landmarks:** castle, cathedral close, palace, monasteries, parish churches, places, port with quays, shipyard, rope walk, bridges every 250–500 m, mills, nuisance trades, arena.
- **Last session before the pause:**
  - UI bug-report tooling: cursor coordinates, pins with notes, "Copy link" carrying pins and view, "Copy bug report";
  - farmstead variety: 23 types by culture and site, cottage to manor (`landuse/farms.ts`);
  - small bridges for minor streets over streams (`urban/streambridges.ts`), with bridge `kind`/`arch`;
  - weak cultures overhauled: Germanic, Norse, Celtic, Maya, Khmer, oppidum, shire, Native American, orc camp, shanties, Inca terraces;
  - population caps removed from every culture;
  - legend fixed.
- **Bug-fix pass at the pause:**
  - crash on large coastal maps (`boundedCost` mixed float32 and float64, fixed and fuzzed);
  - settlements sparser: 136 → 28 on a 20 km map;
  - streets, roads and tracks clipped to land;
  - subtle earth-toned rural tracks (`pal.rural` token);
  - no white settlement circles;
  - the plan override and culture mix no longer leak when switching culture.
- **Megacities:** above `eagerPop`, the macro plan is eager (~1 s for 1 M, ~2.4 s for 5 M) and quarters are detailed lazily on zoom.
- **Performance (Node):**

| case | time |
|---|---|
| town urban stage | ~0.9–1.1 s |
| city urban stage | ~3 s |
| 10 km map (auto settlements) | ~7 s |
| 20 km map | ~15 s |
| 40 km lazy, first display | ~7 s |

## 7. What is left (priority order)

0. **Bugs in `BUGS.md`** (repo root, maintained by the user) come first. Open entries at the pause:
   - overlapping or odd buildings where two zones meet without a street (medieval organic) → fixed in 0b8b5b9; see continuation notes below;
   - biomes (desert, forest…) → implemented in 1508eb4;
   - Chinese: moats cut through everything and should be a well-designed option; some quarters are empty and identical;
   - Japanese and Roman core (`seed=p4uefz&size=city`): empty areas stuck to the city;
   - Venetian: some rivers connect to nothing;
   - stilt town: builds over rivers; it should adapt to relief and water;
   - a green line between some fields is too visible;
   - terrace lines are still not pretty.
1. **Megacity leftovers.** Done at the pause:
   - polygonal eccentric walls and asymmetric successive enceintes;
   - fused towns with real presence;
   - a citadel, university and craft districts, elite parks, canals in flat river cities;
   - anchor points so streets continue across arterials (about half of them line up);
   - secondary cities ≥ 40 k on the lazy path.

   Left:
   - quarter detail costs about 0.2 s per quarter, so a mid-zoom view with hundreds of quarters takes minutes to fill (needs several workers, or changes to shared plot and access code that would break byte-identity for small towns);
   - village greens are triangular;
   - stand-in blocks look coarse when zoomed in;
   - a 5 M city can reach the map edge.
2. **Test-suite health.**
   - The full suite takes about 20 min. `tests/urban.cultures.city.test.ts` alone takes about 18 min: it is slow, not hung, with 70 tests passing. Consider splitting it into fast and slow vitest projects.
3. **Performance.**
   - The 10 km map is at 7.3 s against a 6 s target. About 2 s of that is terrain, which cannot be reordered without changing output.
   - Capital-size eager generation is slow (~15 s), which is why the capital preset now uses the lazy path.
   - Medina and Persian towns are close to the 1.5 s culture budget.
4. **Culture quality pass.** Cultures are uneven (see `POLISH.md`).
   - Weaker ones: Ottoman (loose fabric), Hanseatic (ribs too grid-like), Korean (walls do not follow ridges), stilt town (too regular), Celtic oppidum and Norse farmsteads (fair).
   - The Swahili stone town is not implemented.
5. **Rendering** (deliberately deferred by the user, plan first):
   - style polish;
   - furrow hatching in the Canvas fields;
   - PNG export still stalls the page 0.3–0.9 s;
   - optional WebGL for live views of over 100 k inhabitants;
   - optional Rust/WASM raster for huge exports. Measurements showed neither is needed for normal use.
6. **Farmstead variety** (done: `landuse/farms.ts`; farms on 10 km maps raised to about 26). Farmsteads scattered over the map all look the same. Vary them by:
   - culture and region: courtyard farm (Vierkanthof), longère, Einhaus/longhouse, L- or U-yard, scattered buildings around a yard;
   - size and wealth: cottage with a shed up to a large manor farm with barns, dovecote and walled yard;
   - terrain: bank barns on slopes, raised farms on wet ground;
   - orientation toward the track, south-facing yards, and an orchard or garden placed by context.
7. **Debug and feedback tooling in the UI** — DONE (cursor coordinates in meters, pins with notes, `pins=`/`view=` in the link, "Copy bug report"; see `BUGS.md` and `web/src/ui/share.ts`). Original brief:
   - Show the map coordinates (meters) under the cursor and of the last click.
   - Let the user drop waypoints or pins with a note.
   - "Copy link" includes the pins and the current view (e.g. `pins=x,y,note;…&view=cx,cy,scale`).
   - The bug reporter can then give the seed, options and an exact location. The agent reproduces it with `scripts/preview.ts --crop x,y,w` or `ui_check.mjs` at that view.
8. **Small bridges in town** (done: `urban/streambridges.ts`; fords are hard to see). Today only main streets bridge rivers. In towns, secondary streets and lanes should also cross small rivers and streams with small bridges or footbridges:
   - several per stream inside the town, at street continuations;
   - a plank footbridge for lanes and a stone arch for streets;
   - the street network on both banks stays connected.
9. **Nice to have:** a 3D or roof view from the building `arch`/`roof` metadata (already stored per building), and a JSON import/export round trip for editing.

## 8. Working conventions used so far

- An orchestrator (Claude Opus) delegated coding to subagents. The urban morphology and culture work, which needs geometric rigour, was done by Opus; the rest was done by Sonnet. Parallel agents worked in git worktrees and were merged by the orchestrator.
- Every visual change was checked by rendering PNGs and reading them. Unit tests alone were never trusted for visuals.
- Commit at each step and push to `main`. Redeploy Pages with `web/scripts/deploy_pages.sh`. The GitHub token is read from a local file and must never be printed or committed.
- The progress journal (French) is a private claude.ai artifact; its source is `web/progress/index.html`.

## 9. Codex continuation

- The annotated local tag `claude-opus-5.5-handoff-2026-10-03` preserves the original handoff commit `06d7fa4`.
- `AGENTS.md` documents repository conventions (`a71d457`).
- First open bug fixed in `0b8b5b9`: `seed=p4uefz&size=city&culture=european-organic` produced 124 building overlaps. Filtering small fortified-region components removed older riverbank districts from the latest enclosure, so faubourgs claimed already-built land. Later phases now retain components containing earlier-phase land.
- Regression suite: `tests/urban.phaseboundaries.test.ts` checks phase nesting and disjoint quarters/buildings across blocks. It failed before the fix with 56,483 m² of older districts outside the last phase, and passes afterward.
- Validation: 50 tests passed across the regression, determinism, town/city invariants, and selected Chinese/Japanese/Roman/Medina town suites and mixes; typecheck and build passed. The full suite was not run. Town seeds 1, 4, and 6 retain byte-identical urban layers against the handoff. Before/after PNG crops were inspected in `web/out/seams/` (ignored).
- Biomes implemented in `1508eb4`: six climate presets, water-constrained desert farms/crops, wooded clearings and treeless tundra; default temperate output preserved. The biome control and share links work in the browser, the shared palette reaches both renderers, and all six previews in `web/out/biomes/` were inspected. Typecheck/build, biome/core/Canvas/fields/legend/share suites passed.
- `ROADMAP.md` tracks the full requested completion scope. Next open entry, in user priority order: Chinese moats and sparse/repetitive wards. The other open entries in `BUGS.md` remain pending.
- Wet moats implemented in `6f78c19`: real exterior ditch polygons instead of a convex-hull blue line, terrain/water constraints, dry roads/gates/barbicans, double-curtain alignment, separate rural defensive reserves and no berm houses/phantom bridges in macro plans. SVG/Canvas preserve water holes and wet overlaps. Optional controls show Temperate/Auto correctly on old links. Validation: 39 tests passed across moat/core/Canvas/phase suites (including actual mega regression), typecheck/build passed; double-wall PNG and browser views inspected; live Auto/On/Off and URL checks passed. Ignored previews/review outputs are in `web/out/moat/` and `web/scratch/`. The Chinese BUGS entry is NOT marked fully fixed: sparse/repetitive wards still need work.
- User now requires **Astra and Opus reviews before testing every substantial change block**. Use `gpt-6-astra` through collaboration and local `claude --model opus` (confirmed `claude-opus-5-5`). Reviews must be read-only, without edits or tests; resolve blockers and obtain readiness before typecheck/tests/build/visual checks. The moat block received both reviews and iterative follow-up reviews before tests. For a short follow-up, supply a frozen diff/source snapshot with `--safe-mode --tools '' --strict-mcp-config --permission-mode dontAsk --no-session-persistence`; this avoids re-reading the whole repository. Never expose credentials or commit raw local CLI logs.
- A new user-authored `BUGS.md` entry requests softer open-town edges and houses beyond the current strict frame. It is preserved verbatim and tracked in `ROADMAP.md`; it remains pending. Next work: Chinese ward lots, followed by Japanese/Roman gaps and the remaining ordered bugs.
- Chinese ward access implemented in `d0b5f99`: cardinal hutongs enter away from frontage corners, protect reserved compounds, and run before carving/parcels on eager and mega paths. Astra + Opus 5.5 reviewed it before tests; Opus's corner-root blocker was fixed and re-reviewed. Five new regressions and twelve Chinese/Medina town/city cases passed; typecheck/build passed and `web/out/chinese-hutong.png` was inspected. On `p4uefz`, the largest plot shrank from 40,274 to 10,625 m². The combined Chinese bug remains open: the next block addresses disconnected lateral sections in irregular siheyuan lots and genuine back gardens.
- Pre-existing untracked `web/scripts/repro_culture.mjs` and `web/scripts/repro_race.mjs` were preserved.
- Chinese wards completed in `5dd7025` after `d0b5f99`: real frontage subdivides oversized siheyuan lots; pavilion depth sections cannot jump across notches; long halls are divided into usable ranges; oblique street entries retain clearance. The combined Chinese bug is now fixed with the moat work in `6f78c19`. Astra and actual Opus 5.5 reviewed each substantial amendment and the final before/after PNGs before the final tests. Validation: 22 hutong/siheyuan/moat/determinism tests plus 24 Chinese/Medina cases across hamlet/village/town/city passed; typecheck/build passed; browser fit/near views had no console errors. Sparse residential area on the reported seed fell from 163,522 to 28,605 m²; regression guards empty lots, gardens and sparse coverage. The full suite remains pending. Next ordered bug: Japanese/Roman empty areas, then Venetian/stilt/rural/terrace/open-town edges.
- Ghost urban reserves corrected in `0340ace`: the late exported footprint releases large unserved regions while preserving complete kept quarters, real street miters and hollow wall strips. The reported Japanese seed regains 139,847 m² of rural cover; its 3,787 buildings, all parcels/streets/quarters and castle are byte-identical to the approved baseline. Roman's footprint and all urban geometry are unchanged: inspected open areas are riverbank gardens, with no equivalent large ghost region. Astra + actual Opus 5.5 reviewed before each test run; a bent-width regression caught a 1.58 m² road gap and the global-normal fix was re-reviewed. Final validation: 18 footprint/phase/moat/determinism tests and 24 Japanese/Roman town/city cases and mixes passed; typecheck/build and original-link browser fit/near checks passed. Both inspected PNGs; Opus still finds the large Japanese Bukeyashiki crescent and western merchant plot too empty. The user bug remains OPEN until those served but underbuilt plots are corrected.
- Japanese/Roman gap bug completed in `0340ace`, `01171fe`: unserved reserve is rural again; merchant-only roji follow actual local street axes, try bounded connected roots and short forward paths, and scale their capped iteration budget to ward area. Samurai lots and temple compounds are protected. On `p4uefz`, the crescent largest plot falls from 114,614 to 6,460 m² and roofs increase from 3,240 to 55,679 m²; the western ward is built too. Astra and actual Opus 5.5 reviewed every amendment before testing and accepted before/after PNGs. Validation: 89 regression/culture tests across four sizes plus 12 hutong/siheyuan/roji tests, typecheck/build and browser fit/near checks passed. Full suite remains pending. Opus notes Japanese district naming is randomly chosen and can call a merchant ward Bukeyashiki; improve semantic names/label readability during culture/style polish. Next ordered bug: isolated Venetian waterways (baseline p4uefz: 87 canals form 35 components, only 9 touch natural water).
- Venetian waterways fixed in `e2c4514`: deterministic street-junction graph routes channels to natural water through narrow existing public corridors, with bounded, whole-strip validated shore outlets. Canal/quay widths fit local street widths; bridge offsets seek full-width dry landings clear of carved blocks, including calli ending midway along new connectors. On `p4uefz`, all 12 resulting wet components reach natural water, versus 9 of 35 previously; buildings, parcels and all urban fields except decorative lines are unchanged. Engineered inland gnomish lock canals retain their original algorithm in `lockwater.ts` without global mutable thresholds; gnomish town seed 1 is byte-identical to the approved baseline. Astra and actual Opus 5.5 reviewed all amendments before testing and accepted fresh cropped PNGs after Opus required clearer zooms. Validation: 24 tests (7 focused, determinism, 16 Venetian/gnomish cases across four sizes), typecheck/build and browser fit/near checks passed. Previews are ignored in `web/out/gaps/`. Next ordered bug: stilt towns adapting to water/relief; baseline preview `web/out/stilts-before.png` uses p4uefz/town.
