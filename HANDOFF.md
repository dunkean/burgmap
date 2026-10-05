# Burgmap — handoff

Updated 2026-10-05. This file describes the current implementation; completed
bugs and their evidence are recorded in [ROADMAP.md](ROADMAP.md).

## Current status

- Underdark cavern redesign (2026-10-05): the cavern variant
  generates the normal Underdark layout first, then adds an irregular dark rock
  mask around occupied towns, paths and waterways. It preserves the open variant,
  normal camp/macro behavior and original floor palette. Late settlement and
  quarter details refresh the display mask. Shared SVG/Canvas rock texture uses
  deterministic multiscale noise and fractures. See [CAVERNS_2026-10-05.md](CAVERNS_2026-10-05.md).
  The preceding published checkpoint is tagged `pre-caverns-2026-10-05` (`1879b03`).
  The rejected radial-room candidate was not published. The replacement passes
  the coherent source review, 62 distinct focused tests, typecheck and build.
  Seven native cases pass across both backends, including classic SVG byte parity,
  a fortified town and a placed secondary village. Actual PNGs were inspected.
  This does not certify a green full suite. Publication provenance follows below.
- Underdark and small-screen information panels (2026-10-05): seventh biome,
  independent drow-enclave/duergar-hold/myconid-colony cultures, rock and fungal
  land use with shared SVG/Canvas motifs. Surface atlas assets are unchanged;
  underground painted mode uses its vector fallback. Compact interactive maps
  move title/legend into Map info and keep a physical scale; exports retain
  their normal panels. See [UNDERDARK_MOBILE_2026-10-05.md](UNDERDARK_MOBILE_2026-10-05.md).
  Reviewed source passes 60 distinct focused tests, typecheck and build. Six
  old surface Worlds/preset registries retain exact parity with `daba01b`.
  Five native cases pass, including both rendering backends, rotation and
  byte-identical classic SVG exports. This does not certify a green full suite.
  The previous release is tagged `pre-underdark-2026-10-05`.
  Runtime source `79d5f0f` is pushed/tagged `underdark-2026-10-05`, Pages
  `7ffc673`; the actual served HTML matches the tested final build SHA256
  `5c48b790d8d6a5f627ac3ef35e58d73eb501ecc4f1d9f8994f6dfa996d84fa60`.
  The temporary publishing worktree is removed; only the main worktree remains.
- Local cleanup (2026-10-05, requested by user): all seven satellite worktrees
  are removed and Git worktree metadata is pruned; only this main worktree
  remains. Uncommitted roof experiments are preserved as a binary patch and
  five source files in ignored `web/out/optimization-implementation-2026-10-05/cleanup-archive/`.
  Python/pytest caches are removed. Direct removal of `.vite` and `.vite-temp`
  was rejected by automatic tool policy (`blocked by policy`); they remain.
  Main dependencies, published build, assets, evidence and presentation images
  are retained. No application changes or new testing accompany this cleanup.
- Biome ground/administrative border fixes (2026-10-05): integrated source
  `ad6e32a`, render-worker input repair `f842f9b`. See
  [BUGFIXES_VISUAL_2026-10-05.md](BUGFIXES_VISUAL_2026-10-05.md).
  The visual block passes 104 focused tests; the projection repair passes 31
  tests, including the existing eleven landscape/occupied-shanty controls.
  Typecheck and single-file build pass. Sahel desert and temperate native maps
  pass all eight HTTP/offscreen/main/offline/refused-Worker checks with identical
  SVG/JSON exports. Five Worlds have 300 DPR 1/2 comparison PNGs; their model
  hashes stay unchanged during rendering. A current 60k native diagnostic also
  completes all 103 quarters/42,802 buildings with the original World hash.
  Its timings are excluded because extended tests run concurrently.
  The original user's BUGS paragraph remains with a partial status: eight fresh
  walled seed42 roofs are still cut; the local roof experiments have zero
  current-generation gain and are excluded. The Japanese Boolean-loop repair
  is integrated at `0db97c8`, with a mechanical vendor proof, full World parity
  against baseline + the same guard, and 40 integrated focused tests. See
  [POLYGON_TRAVERSAL_FIX_2026-10-05.md](POLYGON_TRAVERSAL_FIX_2026-10-05.md).
  Two Japanese layout assertions and two inherited zero-area roof hairpins remain
  open; this does not certify a green full suite. Final native Sahel/temperate
  maps pass all eight modes on the rebuilt guarded HTML.
  Optimization tag `optimization-2026-10-05` is published at `01e162f`, Pages
  `3a4836d`; the served HTML hash matches the checked build and native four-mode
  verification passes on the actual site. The subsequent classic checkpoint is
  protected by `pre-brushes-2026-10-05` at `fe9ffa2`, published on Pages `9505299`.
  Its served SHA256 is `a5038ae6bc93109b1f59d6c55d316213ea4f2a679d88fb4066dee417a5fcd0c9`;
  both native fixtures pass all eight modes on the actual publication.
- Optional painted biome brushes (2026-10-05): reviewed candidate `65187de`, integrated at `b232251`,
  classic remains the default. See [BIOME_BRUSHES_2026-10-05.md](BIOME_BRUSHES_2026-10-05.md).
  ImageGen RGBA assets are selected unchanged; six biome mixes, fruit orchards,
  dunes/rocks/grass/reeds/gardens/crops are deterministic per map. Display-only
  `brushes=painted` survives links/bug reports and reload. Candidate checks pass
  20 tests/typecheck/build, 72 classic exact/World unchanged cases and 216 PNGs
  across DPR1/2. Two actual native fixtures pass four backends and four decode
  failure/delay cases each, with exact classic restoration and SVG/PNG/JSON.
  The offline HTML adds 4.68MB; originals decode only on activation, motifs have
  a 16MiB cache, monochrome tint memory is additional. No new timing claim.
  Integration passes 61 tests in ten files, typecheck and build; its HTML is
  byte-identical to the tested candidate. Published source `ea6223a` is tagged
  `biome-brushes-2026-10-05`, Pages `734770c`; served SHA256 matches the checked
  HTML and both native fixtures pass all sixteen backend/decode scenarios.
  Five presentation boards of eight real maps are complete from this build:
  temperate, forest, desert, steppe/tundra and tropical; six biomes and 32
  cultures. PNGs are 6400×3040 in ignored
  `web/out/optimization-implementation-2026-10-05/presentation-boards/final/`.
  Each capture retains its World, SVG, reproducible URL and water/camera metadata.
  The user requested direct delivery without further visual review; none was run.
- Roof/render optimization (2026-10-05): integrated source checkpoint `12d8c225`,
  reviewed before execution. See
  [OPTIMIZATION_IMPLEMENTATION_2026-10-05.md](OPTIMIZATION_IMPLEMENTATION_2026-10-05.md)
  for measurements, exact-output checks, native exports and validation results.
  The protected reference is `pre-optimization-2026-10-05` at `0da0a9d`;
  it was published as `gh-pages` `fa161ee` before implementation. Roof search
  keeps checked Boolean proofs and candidate ordering. Persistent scenes and
  bounded raster tiles accelerate warm views; SVG export remains vectorial.
  The complete 60k World hash is unchanged (103 quarters, 42,802 buildings).
  Browser complete presentation improves from 48.169s to median 20.017s with
  four workers; warm pans take 46–98ms, while a cold zoom still takes ~2.38s.
  GPU diagnostics are SwiftShader software; no hardware GPU gain is claimed.
  The exhaustive run was stopped after 133 minutes: 56/88 files reported,
  with 40 assertion failures reproduced on the protected baseline. Both workers
  were stuck on the same Japanese `p4uefz` Boolean operation; captured arguments
  also time out in a supervised baseline replay. The full suite is incomplete,
  not green. The thirty remaining files have finished in a frozen `ee202a3`
  checkout: 29 reported fully, 446 passes/5 inherited failures; water was stopped
  after another confirmed old-kernel loop. Combined: 85/88 files, 1212 passes,
  45 inherited failures and four skips. Six pending water assertions plus a
  Worker error keep the run incomplete. The current guard also unblocks the
  captured rural call; `cdd1bd3` adds regression tests, full seed2 World parity
  against baseline+only guard, and existing water controls (5 pass/1 inherited fail).
  A bounded traversal repair and the visual/roof BUGS fixes are separate stages.
  All 211 production source files match the reviewed checkpoint, and both user
  reproduction scripts are unchanged. The user's local `BUGS.md` feedback is
  preserved and excluded from the optimization commits. Temporary baseline,
  roof, renderer and Pages worktrees remain registered for reproducibility.
- Profiling audit (2026-10-05): see
  [OPTIMIZATION_AUDIT_2026-10-05.md](OPTIMIZATION_AUDIT_2026-10-05.md) for measured
  generation phases, CPU hotspots and progressive display costs. The source at
  `a7974a1` is pushed to `main` and published on Pages (`gh-pages` `49a0213`).
  Only the primary worktree remains registered; the remaining integration cache
  directory was moved to `E:/CodexArtifacts/city-generator-2026-10-05/obsolete-worktree-cache`.
  This audit changes no generation/rendering behavior. The Russian profiling
  rerun was stopped when the user requested a quick conclusion; its partial run
  is excluded. The report contains 17 complete generation scenarios and six
  complete browser loads. The user's new garden/background feedback stays open
  in `BUGS.md`.
- Local acceleration/quality checkpoint (2026-10-05): assembled source tree
  `001c320c`, 24 reviewed paths. It integrates urban V7 `ad4e15bf`, terrain V4
  `01dab2ec`, distinct castle names, UI V2, adaptive titles and the final roof
  repair `f78699c`. These changes were subsequently published at `a7974a1`.
  Grouped Sol xhigh source
  gates preceded execution. Final integration passes 52 focused regressions,
  all 13 existing M5a controls, strict typecheck and the offline single-file build.
  All 207 source files and the three preserved user files match their closing
  hashes. Local/offline native maps match excluding stats: 1222 roofs, three
  rivers, no page errors; the final image was inspected. The full suite was not run.
  The manual preview remains at http://localhost:5173/.
  Exact-output V7 alone preserves six complete World hashes and gives 2.38–4.55×
  gains on the original four measured cases. Russian repair still takes 219.23s.
  Terrain quality intentionally changes output and costs more in valleys; exposed
  plains images no longer show the original straight drainage trenches. Main and
  offscreen export parity also passes on the actual 20k/10km valley URL with
  the new terrain: 8790 main roofs, six rivers, zero town walls. These earlier
  browser checks precede the final roof-only repair and are not quiet benchmarks.
  UI first visit, draft/applied state, mobile, themes, manual placement, individual
  cultures and the actual Roman20k plus two Germanic500 settlements pass. French/
  Italian titles fit in desktop/mobile views. Matching resolved BUGS rows are removed.
  Final actual open42 generation retains all 85 prior repaired roofs and repairs
  426/798/823; neighbour790 moves rigidly 0.5mm. Counts, metadata, raw planning
  unions, physical clearance and all 65 checked accesses are retained. There is
  no new ownership overlap; inherited 428/427 remains an absolute audit FAIL.
  The four-case cut inventory falls from 21 to 18; the original house report stays open.
  Evidence is retained in `web/out/acceleration-2026-10-04/`, including reviewed
  manifests, final captures and opening/closing integration certificates.
  All four temporary worktrees were archived, byte-verified and removed from Git.
  ZIPs and their manifest are at
  `E:/CodexArtifacts/city-generator-2026-10-04/archive/acceleration-final-20261005/`.
  Older worktree-relative paths below describe files preserved inside these archives.
  Root dependencies, manual preview, AGENTS.md and both user reproduction scripts remain.
- Native main/offscreen checks confirm the user's exact `walls=none` URL has
  zero town walls and retains its castle enclosure. Changing single to none,
  applying and reloading also passes. Three actual generated castles have
  distinct site/label names after reload. Two initial harness failures (closed
  controls and assuming main-render data after an offscreen reload) are retained
  alongside the final passing proof; they were test-script errors.

- Local code checkpoint: `a8c6f14`. All 19 secondary worktrees were archived,
  verified and removed from Git; only the primary checkout remains registered.
  Readable validation evidence and the remaining roof fixtures are retained at
  `E:/CodexArtifacts/city-generator-2026-10-04/manual-checkpoint-a8c6f14`;
  verified ZIP backups are in the sibling `archive` directory. Automatic policy
  refused deletion of two generated Vite cache files (169 bytes) under the old
  `D:/Workspace/Self/RPG/city_generator-integration/web/.vite/deps` directory;
  that unregistered residual directory was subsequently archived during the audit.
  Root dependencies, the manual
  preview, `AGENTS.md` and the user's two reproduction scripts are preserved.
- Live site: https://dunkean.github.io/burgmap/.
- Repository: https://github.com/dunkean/burgmap. Local `master` publishes to
  remote `main`; the static build publishes to `gh-pages`.
- The original Claude Opus handoff is preserved by annotated tag
  `claude-opus-5.5-handoff-2026-10-03` at `06d7fa4`.
- `AGENTS.md` already existed and was preserved. The user's later instruction
  supersedes its older bug-retention sentence: remove resolved reports from
  `BUGS.md` only after reviews, tests and visual verification.
- Published checkpoint: `54072c1`, containing the integrated source
  `5c104595f0a1e1d18f6d38c7aa44aee41be6c2cd`.
  Typecheck and build pass. The grouped integration remedy passed 174 targeted
  tests in eight files on `258339c`; the final boundary correction passed 65
  tests in the two affected files, including the real q13 and five-million cases.
- Native Chrome checks pass for Swahili commerce/nuclei, the barbarian civic
  centre, Persian roof corners and Venetian connectivity. Final q13 retains
  91 macro quarters, 112 blocks, 1,443 buildings and 1,037 parcels with actual
  current provisional/detail frames. Local manual preview: http://localhost:5173/.
- On 2026-10-04 the user requested manual testing before the full suite and
  stopped optimisation/performance passes. Do not start the full suite or further
  performance work until the user asks. The final full-suite rerun remains
  deferred. The user subsequently requested publication of this manual checkpoint:
  remote `main` is `54072c1`, and `gh-pages` is `de0d038` (2026-10-04).
  The live HTML matches the clean committed-source build byte for byte; native
  Chrome loads the published Persian village with 276 buildings, 250 parcels,
  Swahili registration and no page errors. This publication is not a full-suite
  certificate.
- Later on 2026-10-04, the user explicitly requested improved erosion and a
  major generation-acceleration pass, reporting an approximately sevenfold
  slowdown. Performance work is now authorized; the full-suite rerun remains
  deferred. Reproduce seed 1, valley, automatic city, 20,000 inhabitants, and
  the exact open-town 10 km URL in BUGS.md. Keep optimization equivalence
  evidence separate from intentional terrain/rivers changes.
- Local checkpoint: reviewed 40-path source tree `923a5cad` (geometry
  `18d1c47` plus the scoped hidden-control CSS correction). The new Environment /
  Settlements workflow has a general theme, independent instance overrides and
  positions, explicit Generate buttons and an applied-state URL/UID. Native
  main/offscreen and offline checks pass; final root panel visibility is verified.
- Final focused validation: 30 roof, 22 port and 11 M4 tests pass, alongside
  11 density-repair and two density-health tests, including the 53 historical
  huts. The preceding reviewed gate passed 64 workflow/render/road-fringe
  checks. Typecheck and the final root build pass. Original intermediate
  failures and their attribution remain archived; these are targeted results,
  not a full-suite certificate. Seven resolved reports were removed from
  BUGS.md after their relevant reviews, tests and actual views.
- Remaining user report: whole roofs near settlement limits and walls. The
  exact-union transfer fixes additional real cases, including standing-wall
  dwelling 683, but the four reference maps retain 21 exposed/wall cuts. Keep
  the original report unchanged; bounded candidate failure does not prove
  that safe land reassignment is impossible. New source is available locally
  at http://localhost:5173/ and has not been republished after `54072c1`.

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
