# Burgmap — handoff

Updated 2026-10-04. This file describes the current implementation; completed
bugs and their evidence are recorded in [ROADMAP.md](ROADMAP.md).

## Current status

- Live site: https://dunkean.github.io/burgmap/.
- Repository: https://github.com/dunkean/burgmap. Local `master` publishes to
  remote `main`; the static build publishes to `gh-pages`.
- The original Claude Opus handoff is preserved by annotated tag
  `claude-opus-5.5-handoff-2026-10-03` at `06d7fa4`.
- `AGENTS.md` already existed and was preserved. The user's later instruction
  supersedes its older bug-retention sentence: remove resolved reports from
  `BUGS.md` only after reviews, tests and visual verification.
- Current integrated source: `5c104595f0a1e1d18f6d38c7aa44aee41be6c2cd`.
  Typecheck and build pass. The grouped integration remedy passed 174 targeted
  tests in eight files on `258339c`; the final boundary correction passed 65
  tests in the two affected files, including the real q13 and five-million cases.
- Native Chrome checks pass for Swahili commerce/nuclei, the barbarian civic
  centre, Persian roof corners and Venetian connectivity. Final q13 retains
  91 macro quarters, 112 blocks, 1,443 buildings and 1,037 parcels with actual
  current provisional/detail frames. Local manual preview: http://localhost:5173/.
- On 2026-10-04 the user requested manual testing before the full suite and
  stopped optimisation/performance passes. Do not start the full suite or further
  performance work until the user asks. The final full-suite rerun and release
  publication remain deferred; the current live site is the previous release.

The Persian native certificate compares the same Chrome before/after: 276
buildings and 250 parcels are preserved, with seven corrected roof tips and
unchanged access. Node's existing 277/250 regression also passes. The original
cross-runtime count failure remains recorded, alongside its baseline proof.

## Run and validate

Run from `web/`:

```bash
npm install
npm run dev                     # http://localhost:5173/
npm run typecheck
npm run test:fast                # all development suites
npm run test:slow                # exhaustive city/culture/mix matrix
npm test                        # both projects; allow about 40–60 minutes
npx vitest run tests/urban.determinism.test.ts
npm run build                   # web/dist/index.html, self-contained
npm run preview:png -- --seed 42 --size town --out out/check.png
node scripts/ui_check.mjs http://localhost:5173/ out/check --set "seed=4&size=city&culture=medina" --name medina --scales fit,0.6
```

Open the generated PNGs. Geometry tests alone cannot establish visual quality.
Performance assertions enabled with `BURGMAP_PERF=1` require a quiet machine.
`web/out/` and `web/scratch/` are ignored evidence and scratch space.

## Read before changing generation

1. `BUGS.md`: user reports take priority; keep outstanding text unchanged.
2. `AGENTS.md`: repository conventions, subject to the user's later instructions.
3. `web/ARCHITECTURE.md`: pipeline, World contract and worker/render architecture.
4. `web/URBAN_GEOMETRY.md`: partition hierarchy, access, density and walls.
5. `web/URBAN_MORPHOLOGY.md`, `web/URBAN_LANDMARKS.md` and
   `web/REGION_SETTLEMENTS.md`: culture programmes, landmarks and region planning.
6. `ROADMAP.md`, `web/POLISH.md` and `PERFORMANCE_STUDY.md`: validated work,
   remaining optional extensions and measured costs.

## Code map

Active development is TypeScript in `web/`. `town_generator/` and root `tests/`
contain the earlier Python prototype, used only as references.

- `src/gen/core/`, `terrain/`, `site/` and `roads/`: seeded randomness, grids,
  relief/hydrology, site selection and connected regional roads.
- `src/gen/urban/`: phases, streets, blocks, plots, houses, access, walls,
  culture data and compound builders. `camps/` handles native villages;
  `primitive_features.ts` retains their civic and boundary programmes in towns.
- `src/gen/urban/mega/`: macro rings, extents, reserved nuclei, stand-ins and
  independent lazy quarter detail.
- `src/gen/settlements/` and `landuse/`: regional settlement hierarchy, travel
  network, secondary detail, farms, cultivation and natural ground.
- `src/gen/pipeline.ts`, `options.ts`, `types.ts`: pipeline, URL options and
  structured-clonable World data.
- `src/render/`: SVG export, scene/tile indexes, Canvas LOD, palettes and shared
  physical stroke/bridge widths.
- `src/ui/worker.ts`, `renderWorker.ts`, `megaQueue.ts`, `quarterPool*.ts` and
  `quarterWorker.ts`: generation, offscreen rendering and bounded nested detail.
- `src/ui/frameHandoff.ts`, `pngExport.ts`, `pngRaster.ts`: displayed-frame
  ownership and native PNG capture/worker encoding.
- `web/tests/`, `web/scripts/`: seeded invariants, focused regressions, previews
  and real-browser verification.

## Product behaviour

The browser generates terrain, water, roads, rural land use and settlements from
a seed or imported heightmap. Builds are a single offline-capable `index.html`.
The app has 38 registered planning cultures, six biomes, nine map styles,
phase/sector/blend mixing, populations from 10 to 5 M, selected settlement
centres, bug pins and SVG/PNG/JSON export.

Swahili stone towns have coral-stone court houses, bazaars, distinct Juma/local
mosques, merchant mansions, a fort and actual waterfront quays. Native cultures
grow towns without replacing longhouses, kraals, kivas or chief halls with
European civic architecture.

Large cities use an eager macro plan and lazy exact quarters. Two nested workers
share reduced immutable inputs, with sliced fallback, stale-generation rejection
and a 420-quarter interactive cache. Stand-ins share a 12,000-block/32,000-mass
budget. Full exports intentionally detail every quarter through a separate cache.
Implicit map presets expand for explicit large populations; custom maps and
heightmaps retain their extents and show honest capacity warnings.

Canvas retains vector geometry offscreen and uses culling, LOD and cached paths.
Old maps remain visible and interactive while new generations load. Field furrows
retain real strips and holes with bounded texture caches. PNG encoding moves to
a dedicated worker after native SVG decoding and whole-canvas rasterization;
the page raster stages still have a measurable cost. Refused workers and
`file://` retain the fallback paths.

## Geometry and change discipline

- Partition rather than scatter: phases → quarters → blocks → plots → buildings.
  Preserve disjoint land, real frontage, contained footprints and street access.
- Coordinates are metres. Use `rng.fork(label)`; never `Math.random()` in `gen/`.
- Keep generation independent of DOM/Node globals and Worlds clonable.
- Preserve unchanged seeded output for pure refactors. When another approved
  subsystem changes inputs, prove attribution by replaying the old generator on
  those new inputs before updating snapshots; retain fixed-input regressions.
- Preserve real dimensions, courts, waterways and dry bridge landings. Raster
  wet cells can straddle vector banks; test the appropriate physical contract.
- Review **large coherent blocks** with Sol at xhigh reasoning before validating
  material changes. Keep reviews read-only and verdicts short; group related
  remedies instead of reviewing individual typing or fixture adjustments.
  The user's latest 2026-10-04 instruction replaces the earlier Astra gate;
  Opus 5.5 is optional support, with concise output. Existing completed
  Astra/Opus/Sonnet reviews remain evidence for their reviewed source.
- Use isolated worktrees for parallel edits; integrate the exact validated source.
  Inspect matched PNGs and actual browser views, including fallback/offline paths.
- Preserve the user's untracked `web/scripts/repro_culture.mjs` and
  `web/scripts/repro_race.mjs`. Do not commit ignored output or credentials.

## Performance scope and future work

The user requested a **preliminary study**, with bugs first and no commitment to
a Rust port. `PERFORMANCE_STUDY.md` separates generation, scene preparation,
native frames and exports. The 10 km reference currently takes about 10–12 s to
generate, then 1 s of cold scene preparation and 0.8 s for its first native fit
frame. The six-second generation target remains unmet.

At 5 M, rural generation and whole-map scene/cache work dominate the measured
initial view. Profile those and geometry kernels before choosing WASM or a GPU
backend. Capital loading and Medina/Persian main-stage budgets are measured in
the study; initial macro timing never includes exact houses.

Optional future work: a roof/3D view, JSON import/editing round trips, additional
art direction, and renderer experiments justified by measurements. These are
not silently implemented or represented as finished optimisation targets.

## Publish

Publish validated commits to remote `main`, then run from the repository root:

```bash
GITHUB_TOKEN_FILE=/path/to/local/token bash web/scripts/deploy_pages.sh
```

The script builds committed HEAD in a clean worktree and publishes `gh-pages`.
Keep the token local and never print it. Verify the served static build and
source revision after deployment. The licence is GPL-3.0 because the original
Python prototype derives from watabou's TownGeneratorOS.
