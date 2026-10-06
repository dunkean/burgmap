# Burgmap — handoff

Updated 2026-10-06. This file describes the current implementation; completed
bugs and their evidence are recorded in [ROADMAP.md](ROADMAP.md).

## Current status

- Published house rollback / parcel bench (2026-10-06): source `3cd49a2` is
  integrated on master, pushed to remote main and released as
  `house-programme-rollback-2026-10-06`. GitHub Pages `bc2755e` built successfully;
  live version.json identifies `3cd49a2a5c26a13f423591ad73f5b327aa88c310`.
  Application, testbench and guide match the validated files byte for byte.
  Live/offline desktop/mobile bench workflows pass; switching the live bench
  default → experiment → default retains every parcel and restores identical
  original roofs. Release assets include offline app, bench, guide, revision
  and SHA256SUMS. The 76 focused regressions/typecheck/build evidence stands;
  the exhaustive full suite remains deferred.
  Cleanup removed five secondary worktrees and 33 obsolete local branches after
  verified ZIP backups and an all-ref Git bundle. Only the primary worktree
  remains. Three branches with unique unintegrated commits remain:
  fix/building-fabric-20261006, fix/estuary-water, fix/secondary-triangles-20261006.
  Backup/manifest: E:/CodexArtifacts/city-generator-2026-10-06/archive/
  house-rollback-release-20261006/. The separate Rust preparation remains local.
  Release evidence: web/out/house-rollback-release/.


- House programme rollback (2026-10-06, latest user request): production
  `buildPlot` and `burgageHouse` again use HEAD e34f667's pre-experiment programme.
  The new cutPlots/cutCourtyards geometry and parcel metadata remain unchanged.
  The complete local house implementation is preserved as
  `burgageHouseExperimental` in `housesExperimental.ts`; reversing only its name
  reproduces original blob 5d9db73be7b4d7db88b924c6a19e8982e4906b96 exactly.
  `buildPlotExperimental` preserves axis-aware normalization, farm rectification
  and the disabled-variation guard. The bench offers this explicit method via
  `streetFrontRowExperimental`; existing buildPlot/default links use the old
  programme, including street-normal roof orientation and side-line access.
  Experimental regressions now explicitly select that method. Perimeter building
  construction remains a separate opt-in. Earlier house-frame/access entries
  below describe the preserved experiment, not the current default.
  Baseline replay compares all buildings and the next RNG draw on 339 newly cut
  parcels (150 burgage, 189 courtyard); all match the committed old programme.
  The user's clarification keeps only the parcel-axis/cutting work in the default
  path; later building adaptations stay opt-in. Preserved changes include:
  parcel-frame room axes and projected width; bowed frontage depth; private-wall
  frame repairs; unconditional rectangle preference; dimension variation forks;
  independent/central entrances; wider courts; rear gateways and joined L wings;
  axis-aware roof normalization; village rectangle preference; variation guard;
  frame-derived roof orientation and bench access adapters. Default building
  conformity/corner-fill draws, paired courts, frontage frames, OBB normalization
  and farm programme are restored. No changes to the new parcel cut algorithms.
  Validation: 76 focused tests pass (rollback, experimental house/frame/access,
  parcel diversity, bench, perimeter and eager/lazy dense fabric), plus strict
  typecheck and both offline builds. Town seed42 PNG inspected at
  `web/out/buildPlot-rollback/town42.png`. Full suite not run; no publication.


- Perimeter construction revision (2026-10-06, latest user corrections):
  `buildPerimeterPlot` constructs street-front volumes on the actual cutPlots
  parcels; `buildPerimeterBlock` remains the dispatcher/legacy adapter.
  The custom Voronoi ring and court-first offset construction were removed.
  Courts emerge from varied building depths and widths. Each row uses the
  perpendicular of its own street facade, including secondary corner facades;
  cropped/deformed corner ranges and thin fragments merge into viable attached
  buildings. Final exact parent/parcel crops preserve containment. Normal
  minimum width/aspect rules apply, and isolated rear fragments get no repeated
  carved paths. Current served-border metadata is retained after cadastral
  corner merges, without recutting the parcel polygons.
  The perimeter-block preset now uses burgage/cutPlots. Choosing the builder
  no longer switches parcel methods; retainBlock was removed from the UI.
  Saved wholeBlock bench links replay through cutPlots; the source adapter
  stays compatible. Block programme decisions share the root seed and parent
  geometry; blockCourtShare is a depth preference, not an exact area target.
  Solid requests full depth; conditional infill permits deeper ranges. Widths
  and depths still vary independently within the shared block programme.
  Final validation: 46 focused regressions, typecheck and app/bench builds pass.
  Scale-2.5 fixture retains all 242 roofs, with no access-stage cuts/drops.
  Eager seed1/pop3000: 865 roofs/565 native parcels; lazy seed1/pop9000 central
  detail: 161 roofs/94 parcels; both pass containment, overlap and access,
  with deterministic lazy regeneration. Live/offline stage isolation, preserved
  cutPlots selection, case reload, depth controls and disabled perturbations
  pass; the full bench/mobile workflow passes too. Native PNGs were inspected
  in web/out/perimeter-block/. The large ten-block browser fixture builds in
  about 150–180 ms. No full-suite claim, commit or publication.

- House perturbations temporarily disabled (2026-10-06, user request): keep
  the experimental implementation and its direct geometry regressions, but
  production buildPlot forces houseVariation=0, including previously saved
  nonzero overrides. The UI shows a disabled zero-valued control. Default is
  zero. Architectural size distribution in perimeter construction is separate.

- Court interpretation / partial rollback (2026-10-06, user correction): the
  requested courtyards are open block interiors surrounded by perimeter
  buildings, as in Paris, not small cutouts in individual houses. The later
  `interiorCourtChance` house programme, its bench control and the added court
  dependencies have been removed at the user's request. Earlier house-frame
  and access fixes remain. The intended block-scale mix is predominantly
  perimeter buildings around an open core, with fewer penetrating alleys and
  some irregular fabric; avoid a repeating visible pattern at city scale.
  The partial rollback did not implement that redesign; the dedicated
  collective builder above now provides it as a separate opt-in method.

- Scaled house courts / access variety (2026-10-06, local follow-up): the
  reported micro scale 2.5/perimeter cases use layout `gja3b8`, houses
  `186rtb7`, courtyard plots `1tup5tm` or burgage plots `uvz24c`.
  Their original bench output had 72/368 and 92/421 unreachable roofs.
  Native framed street-front houses now vary the wing/entrance side and width,
  use a central entrance between two viable front houses on some wide lots,
  retain room-depth courts, and join useful rear wings into L footprints.
  Intermediate ranges carry access onward; the final back house closes its
  court. Changes of entrance side occur across open courts, never through a
  sealed party wall. The bench now checks whole-block building access, prefers
  short gateways, proves shared side lines before splitting passage width
  between narrow neighbours, and rejects cuts that destroy a served house.
  Its final guard removes remaining unserved roofs, as in the native pipeline;
  this is a bounded repair, not a claim that every original roof survives.
  Streets, blocks and parcel partitions remain unchanged. New seeded tests
  cover both reported fixtures and side/central entrance variety in a deep
  single-front parcel. Final fixtures have 364/391 roofs, all served, and
  retain 92%/84% of the original occupied area (courts and passages need real
  space). Twenty-nine focused bench/frame/parcel/access tests and both eager/
  lazy fabric checks pass, with typecheck and both builds. Native live/offline
  replay of both URLs and the offline bench UI workflow pass; PNGs inspected.
  Two existing failures remain outside this fix: dense-house seed-5 turret
  area (already recorded below) and the native Iroquoian parcel-824 assertion
  (also reproduced with the pre-change house programme). No full-suite claim;
  nothing committed or published. Evidence is in `web/out/large-houses/`.

- Parcel diversity / scaled micro access (2026-10-06, local follow-up): native
  burgage/courtyard cuts retain a coherent cadastral frame but organic fabrics
  again use `plotTilt` to vary it by parcel seed. Grids and explicit zero tilt
  retain the block axes. Courtyard cut positions prefer a seeded 42–58% fraction;
  concave cuts try every interior chord instead of rejecting a line whose OBB
  centre lies in a notch. The micro bench now offers one-edge vs perimeter road
  frontage, retaining one-edge semantics for existing URLs. With layout `gja3b8`,
  parcels `1tup5tm`, houses `186rtb7`, courtyard + streetFrontRow, scale 3, one-edge
  access was stopping subdivision at lots of 1800–4000 m²; perimeter access yields
  244 lots, all below 800 m². The concave-curve max lot drops from 2214 to 680 m²
  with the interior-chord fix. Large single-front blocks still need access lanes
  before their rear land can become independent compact parcels; this is an
  access constraint, and the bench does not fabricate rear access at the plot stage.
  Thirty-two focused tests and both eager/lazy fabric access checks pass, with
  typecheck, app/bench builds, native scale-three browser replay, and live/offline
  bench checks. PNG evidence is in `web/out/scaled-bench/` and `web/out/testbench/`.
  No full-suite claim; nothing committed or published.

- Building parcel frames (2026-10-06, local follow-up): `streetFrontRow` keeps
  the axes retained by burgage/courtyard subdivision for its rooms and later roof
  splits. Exterior facades can follow angled or curved block borders; the front
  depth includes a convex bow outside the frontage chord. Private skew crops may
  shorten/shift a whole room, and narrow front houses survive a lateral gateway
  that would otherwise leave them below minimum width. Farm programmes retain
  their existing street frame. Street, block and parcel geometry is unchanged.
  Reproductions use layout `1cl51ek`, plots `1f3hikq`, houses `43nbs4`, European
  organic/core/hill, plus the user's micro burgage and courtyard variants.
  Twenty-eight focused tests, both eager/lazy fabric access checks, typecheck,
  app/bench builds and live/offline bench checks pass; native browser pin-case
  replay and PNGs in `web/out/pin-orientation/` were inspected. Eighteen ordinary
  house/RNG controls retain their original digest; nine aligned controls also
  match with explicit axes. The dense-house seed-5 forced-turret test still
  fails its >200 m² assertion (183.36328 m²), identically with the session's
  original house source. No full-suite claim; nothing committed or published.

- Micro parcel bench mode (2026-10-06, local follow-up): `testbench.html`
  offers "Micro parcelle only", with ten isolated small shapes (thin rectangle,
  acute corners, parallelogram, trapezoid, L/notch and sampled curved edges).
  The diversity preset retains all families when Random shapes varies their
  dimensions and angles. Native parcel/house stages and seed isolation remain;
  quarter/terrain controls are hidden in this mode. URL replay retains the mode,
  stage settings and geometry. Fourteen focused tests, typecheck, both offline
  builds and the extended offline browser checks pass. The micro screenshot in
  `web/out/testbench/micro-shapes.png` was inspected. Nothing published.

- Parcel debugging bench (2026-10-06, local follow-up): the native fixture now
  separates streets/blocks, parcels and houses, retaining parcel frontage frames
  across building variants. Culture recipes include phases/sectors and independent
  stage presets, operator menus and validated JSON overrides. Rectangle, oblique
  and concave fixtures supplement central sectors. Analytical valley/hill land
  constraints and straight rivers clip actual dry quarters before subdivision.
  URL v2 preserves each applied stage independently; prototype links migrate.
  Thirteen focused bench tests plus urban determinism pass, with typecheck and
  both offline builds. `web/scripts/testbench_check.mjs` verifies stage isolation,
  recipe resets, overrides, URL replay, pin deletion, constraints and mobile
  in development and offline modes; inspected PNGs
  are in `web/out/testbench/`. The full settlement planner and its final roof
  repairs remain outside the bench. Nothing published.

- Open edges and dense building fabric (2026-10-06, publication preparation):
  the two requested Sol xhigh analyses and single Opus 5.5 CLI review are in
  `ANALYSE_CONTOURS_2026-10-06.md`, `ANALYSE_MAISONS_2026-10-06.md` and
  `REVIEW_OPUS_GLOBAL_2026-10-06.md`. Sol medium implementations preserve whole
  roofs on vacant dry exterior land, classify and shorten unserved street tails,
  blend public outskirts into landscape, and repair ordinary roofs with atomic
  owner/peer/physical/access checks. Private passages share their full width
  with a real public edge; all area-reducing proposals share a cumulative reserve.
  Cultural programmes and plausible triangular roofs are protected. The first
  generation integration is `f5ecca0`: the Sol xhigh approval covers `3da0804`, with
  a subsequent principal-agent-checked frame fix restoring wide-street frontage
  and inward sides across fragmented front edges. Native Chinese and Iroquoian
  cases cover the restored whole buildings. Tests are integrated at `8d1df55`.
  Typecheck/build pass; SHA256 `04dc6a3aba9abc714d30036e58c0adbdf266da42e92b1352eba4d89ea0a8b6ad`.
  Actual browser/export checks pass for the user compact map and Wizard Town in
  Worker/main/offline/refused-worker modes. Native geometry audits pass for these
  and open `p4uefz`; 32 SVG/Canvas/style/DPR edge renders and 33 pin/detail images
  were inspected. Renderer `856cc1e` excludes forest from entire urban quarters,
  with explicit parks/gardens as exceptions and soil replay unchanged; 91 focused
  tests and 32 native SVG/Canvas texture/style comparisons pass. The user's new
  medieval reference with 43 pins is being corrected for long terminal tapers.
  The complete `f5ecca0` test run is still being compared with the original
  53-failure baseline; these changes have not yet been published. Mechanisms,
  measured housing ratios, conservative residuals and evidence paths are in
  [FIXES_GLOBAUX_2026-10-06.md](FIXES_GLOBAUX_2026-10-06.md).

- Published UI/developer/guide release (2026-10-06): source `3f61c90` is pushed
  to remote `main`, tagged `ui-developer-tools-2026-10-06`, with a public GitHub
  release containing offline app/guide/version artifacts. GitHub Pages build
  `40ebb68` is built successfully. Live `version.json` identifies the full
  source `3f61c9044f6412d6df831e352ee9eed0f8aed200`; downloaded app SHA256
  matches the validated `8707af6d…` build exactly. The English guide is live at
  https://dunkean.github.io/burgmap/docs/generation.html, with commit-specific
  source links. Live desktop/mobile checks pass: black transparent coordinates,
  matching card/editor labels, flyout, English diagrams and interactive stages;
  actual desktop developer stages 0–4 and a stage-3 JSON without urban geometry
  also pass. No browser errors; screenshots inspected. Evidence:
  `web/out/release/`. This later handoff-only record does not change the app.

- Publication preparation (2026-10-06): the staged-generation/controller bundle
  passes 16 focused debug/cache/workflow/Kraal tests, typecheck and the offline
  build. A release review found a late-completion race after settings edits;
  `developer.ts` now retains invalidation until an explicit restart. Actual HTTP
  worker runs verify edits during stages 0 and 1 cannot enable a later stage;
  isolated browser checks cover stage 3 and restart recovery as well.
  Sol xhigh release review passes with no remaining blockers; two Roman-core
  probes preserve settlement reachability after urban gate approach shaping.
  Evidence: `web/out/developer-ui/race-check.json` and controller-check scripts.
  `deploy_pages.sh` now publishes the English guide at `docs/generation.html`,
  rewriting source references to commit-specific GitHub URLs, plus `version.json`
  identifying the full source revision. Git credentials or GITHUB_TOKEN_FILE
  are supported. App build SHA256:
  `8707af6def81c53209f03fe96fa27d81b91f793aad000a42f3d9d9a8bace57b1`.

- Generation guide translated to English (2026-10-06, user follow-up):
  `web/docs/generation.html` now has English prose, tables, diagram labels,
  accessibility labels and metadata (`lang=en`). All IDs, source links, CSS,
  JS and SVG geometry are preserved. Offline desktop/mobile checks verify
  all 12 sections, five diagrams, stages 0/2/4, no horizontal overflow and no
  browser errors; images inspected. Evidence: `web/out/doc-english/`.

- Settlement UI follow-ups (2026-10-06, local changes): Style mix, layout &
  landmarks now opens a separate glass panel to the left of Customize; below
  830 px it replaces the drawer while open. Existing controls/listeners retain
  their selected settlement, Back/Esc returns to Customize, and its Apply action
  captures and generates the same draft (verified desktop/mobile JSON exports).
  Closed settlement cards and opened Type fields now share generation presets,
  rather than mixing those presets with regional population-class thresholds.
  Main legacy/explicit overrides retain their actual generation type.
  Ten focused workflow/Kraal tests, typecheck and build pass. Offline Chromium
  checks compare five population boundaries, desktop/mobile layout and real
  Hamlet/Village/Town generation. Kraal 80/600/3000 populations are respected:
  round thatched huts at 600, connected `kraal-town` streets at 3000; no tipi,
  ger or store-tent buildings in these seeded cases. Generation behavior was
  not changed: hut architecture remains culture-specific as population grows.
  Inspected map and UI images: `web/out/layout-flyout/`. Final HTML SHA256:
  `6ec35c7fd0ec2fe334601edd2739779c9ec76a6b7b00bb27bd9d3ce2bab75a48`.
  No full-suite claim; nothing published.

- HUD, rail artwork and staged developer tools (2026-10-06, local changes):
  generation/render timings, zoom and map identity share a discreet bottom-left
  glass frame; x/y coordinates sit just above the minimap, in plain black text
  without a background, including on phones (user follow-up).
  Right-rail action/biome/relief/coast/river icons use the transparent ImageGen
  atlas in `web/src/ui/assets/rail-icons.png`; palette swatches stay exact.
  Customize ends with a collapsed Developer section: empty relief/coast, then
  rivers/lakes, settlement centroids, roads, and quarters/buildings/rural/names.
  `gen/debugPipeline.ts` retains actual intermediate state; lazy detail is blocked
  before stage 4. The production pipeline retains its ordering. Debug secondary
  placement uses projected reserves, so it can differ from production placement;
  a single-main regression preserves production geometry and names exactly.
  JSON exports identify the stage; shared IDs reopen normal generation. Display
  changes retain the debug session; generation edits require restarting it.
  Offline French guide: `web/docs/generation.html` (41 cultures, eight biomes,
  five inline diagrams, interactive steps). Six focused tests (debug + cache),
  typecheck and single-file build pass. Offline desktop/mobile checks verify
  the HUD, inline icons and all five developer frames; Worker-disabled fallback
  also passes, including actual stage-3 JSON downloads without urban geometry.
  Native images were inspected; no browser errors or external asset requests.
  Evidence: `web/out/ui-hud/`, `web/out/developer-ui/`, and
  `web/out/generation-doc/`. Final HTML SHA256:
  `daec3e93ec1646390689e04e6c80fe53a6accf2d517a0ca4ad35a687613a130d`
  after the coordinate placement follow-up. That CSS update also passes the
  build and inspected desktop/mobile offline checks (`web/out/coords-above/`).
  No full-suite claim. Nothing is published as part of this request.

- Compact share IDs (2026-10-05, local commit `d341f2e`): `?id=` now carries the seed and configuration
  in a versioned binary/base64url format, optionally DEFLATE-compressed against a
  frozen plan dictionary (`web/src/gen/mapId.ts`). Old links remain readable;
  internal generation hashes stay unchanged. Share & export adds Copy ID, while
  Copy link retains pins/view/brushes. The BUGS forest reproduction's configuration
  shrinks from 716 to 140 characters. Validation: 31 focused tests, typecheck/build,
  and offline Chromium copy/link/reload with the blueprint style; screenshot checked.
  Evidence is in ignored `web/out/compact-id/`. Clean committed release passes 27
  focused tests, typecheck/build and offline copy/link/reload. Integrated on local
  master with all other working files preserved. User will push; not published.
  No full-suite claim.

- Game-style control UI (2026-10-06): right rail with New map / Surprise / Customize and
  one-click biome, relief, coast, river and style dots; Pins / Share at the top right (Share
  shows the single Map ID, copy and "open an ID or link"); info, x/y frame and minimap (with
  Fit) in the bottom-right corner. Customize is a non-modal drawer: World / Settlements / Look.
  Settlements: a General card (theme culture, place names, default layout), "Generate places"
  from a target population, then the list of every place (main town included, no separate
  main card). Touching a generated place takes the region over as an editable list
  (`regionAsList`, workflowDraft.ts): each place keeps its generation `key` (new optional
  `SettlementSpec.key`, 8th `set2` element) and exact position, so the list reproduces the
  region (tests/settlements.region-list.test.ts). Places are added inline, renamed
  (`SettlementSpec.name`, 7th element, `applyNameOverrides`), placed by site or by click,
  dragged (`src/ui/marks.ts`) and deleted. Layout & landmarks use one-click chips (`chipify`,
  controls.ts) over hidden selects. Generation cache (`GenerateOptions.cache`, kept by the
  generation worker): terrain reused when only non-terrain options change, main town reused when
  only secondary places change; World-identical (tests/pipeline.cache.test.ts).
- Cavern tailoring (2026-10-05, source integrated; Pages queued): empty
  footprints and surface cultivation no longer force large cave rooms. Around
  75% of each river course has tight banks; seeded widening lengths, gaps and
  amplitudes vary without a periodic cycle. Road galleries follow physical
  width. Separate small fungal rooms replace fields, with shared SVG/Canvas pure
  display projection and subtle mineral tints. Ordinary World geometry and open
  Underdark stay unchanged. Coherent source review, 40 distinct focused tests,
  typecheck/build and eight native cases pass, including the reported myconid seed.
  See [CAVERNS_2026-10-05.md](CAVERNS_2026-10-05.md). Revised board:
  `web/out/optimization-implementation-2026-10-05/presentation-boards/final/06-underdark-cavernes-final.png`.
  Build SHA `7605043ea6e25e3e0d28f9c8b9ba8c960c26a0ac23dc373d5072a4ba8a60c9c0`.
  User explicitly authorized publication after preparation of this revised board.
  Runtime source `3aa7d93` is integrated on main and tagged
  `caverns-tailored-2026-10-05`. Pages `d3f372e` is pushed; temporary worktree
  removed. Run `37370914829` is queued; actual live SHA is still `5c48b790…`.
  GitHub reports hosted runner assignment/start delays in its active Actions
  incident `3q1yb5m7ltvb`; live deployment remains an external pending step.
  BUGS.md remains outside this work. No full-suite certification is claimed.
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
  This does not certify a green full suite. Source `1f210b0` is integrated on main
  and tagged `caverns-2026-10-05`; Pages `7601592` is pushed. The temporary
  publishing worktree is removed. GitHub Pages run `37365203761` built successfully,
  but its deployment was subsequently cancelled. The tailoring release above
  supersedes that attempt.
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
