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

0. **Bugs in `BUGS.md`** (repo root, maintained by the user) come first.

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
6. **Farmstead variety.** Farmsteads scattered over the map all look the same. Vary them by:
   - culture and region: courtyard farm (Vierkanthof), longère, Einhaus/longhouse, L- or U-yard, scattered buildings around a yard;
   - size and wealth: cottage with a shed up to a large manor farm with barns, dovecote and walled yard;
   - terrain: bank barns on slopes, raised farms on wet ground;
   - orientation toward the track, south-facing yards, and an orchard or garden placed by context.
7. **Debug and feedback tooling in the UI.** DONE (cursor coordinates in meters, pins with notes, `pins=`/`view=` in the link, "Copy bug report"; see `BUGS.md` and `web/src/ui/share.ts`). Original brief:
   - Show the map coordinates (meters) under the cursor and of the last click.
   - Let the user drop waypoints or pins with a note.
   - "Copy link" includes the pins and the current view (e.g. `pins=x,y,note;…&view=cx,cy,scale`).
   - The bug reporter can then give the seed, options and an exact location. The agent reproduces it with `scripts/preview.ts --crop x,y,w` or `ui_check.mjs` at that view.
8. **Small bridges in town** (the bug-fix agent did not get to it). Today only main streets bridge rivers. In towns, secondary streets and lanes should also cross small rivers and streams with small bridges or footbridges:
   - several per stream inside the town, at street continuations;
   - a plank footbridge for lanes and a stone arch for streets;
   - the street network on both banks stays connected.
9. **Nice to have:** a 3D or roof view from the building `arch`/`roof` metadata (already stored per building), and a JSON import/export round trip for editing.

## 8. Working conventions used so far

- An orchestrator (Claude Opus) delegated coding to subagents. The urban morphology and culture work, which needs geometric rigour, was done by Opus; the rest was done by Sonnet. Parallel agents worked in git worktrees and were merged by the orchestrator.
- Every visual change was checked by rendering PNGs and reading them. Unit tests alone were never trusted for visuals.
- Commit at each step and push to `main`. Redeploy Pages with `web/scripts/deploy_pages.sh`. The GitHub token is read from a local file and must never be printed or committed.
- The progress journal (French) is a private claude.ai artifact; its source is `web/progress/index.html`.
