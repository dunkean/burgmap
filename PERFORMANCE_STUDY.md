# Preliminary Performance Study

Measured 2026-10-04. Bug fixes take priority; this study does not introduce a renderer rewrite or Rust dependency.

For the current combined source, see the
[2026-10-05 profiling tables](OPTIMIZATION_AUDIT_2026-10-05.md): 17 generation
scenarios and the CPU/display hotspots of the default Medieval organic capital.
The measurements below describe earlier checkpoints.

## Major slowdown investigation, 2026-10-05

The generation-only baseline at `ea100e5` confirms the regression. Weighted V8
CPU samples attribute approximately 88% of the seed1 valley/20k time to
`finishEdgeRoofs`, including repeated polygon Boolean proofs. Inclusive child
times overlap; they must not be added. This is a generation bottleneck, so a
renderer rewrite would leave the dominant work in place.

Reviewed urban V7 (`ad4e15bf`, now local) indexes repeated polygon queries and
uses conservative geometric bounds to reject impossible candidates before exact
Boolean proofs. It retains the original geometry, acceptance thresholds and RNG.
It also reuses exact roof-proof results and bounded access states. All six
complete World hashes excluding `stats` are identical to their baselines.

| Case | Baseline generation | V7 generation | Speedup |
| --- | ---: | ---: | ---: |
| Exact user open-town/20k/10km URL | 108.52 s | 31.78 s | 3.42× |
| Seed1 valley/city/20k | 159.80 s | 35.15 s | 4.55× |
| p4uefz region/10km | 53.21 s | 22.39 s | 2.38× |
| Seed1 region/40km/5000 | 53.11 s | 21.18 s | 2.51× |

These are single local Node samples with generation-only 1ms CPU profiling;
hashing, serialization, startup and rendering are excluded. Our other generation
and test jobs were paused, but unrelated machine activity was not controlled.
Terrain-quality changes deliberately alter output and are validated separately;
the table measures only exact-output urban optimization on the original terrain.
Sources, binary Worlds, options and CPU profiles remain in
`web/out/acceleration-2026-10-04/baseline/` and the archived worktree evidence.

V7 passes 18 focused regressions and strict typecheck. An additional paired
Russian seed42/town/6000/single-wall case falls from 329.30s on V4 to 219.23s
on V7 (1.50×), with an identical World; V6 measured 249.51s. It remains too slow:
weighted profiles attribute 208.70s to density repair, including 86.60s in access
and 75.37s in obstacle clearance. These inclusive costs overlap. V7 records
proven physical refusals but retries failed Boolean computations, and avoids
searches whose original caps leave no candidate. Successive Roman20k/Germanic
growth measures 15.98s on V4 and 15.77s on V7; this small difference does not
establish a material improvement. European V6/V7 differences are similarly
small and mixed. Do not present the table as the final combined terrain/UI
application timings, or infer cache-hit counts from a CPU profile.

Native V4 checks also separate generation from display: the three-castle town
took 27.29s to generate, 460ms to build its scene, and about 556ms for its first
frame. The open variant took 10.53s to generate and 370ms to build its scene.
These are browser functional samples, not the same runtime/fixture as the Node
baseline, and do not establish a cross-runtime speedup. The current evidence
supports reducing repeated geometry work before considering Rust/WASM kernels.

Terrain quality has a separate measured cost. Three alternating warm pairs per
fixture put forest valley terrain at 1.17→1.40s for 3.6km and 2.23→2.74s for
10km; tundra valley adds 17–18%. Desert plains measure 0.50→0.48s at 2.4km
(overlapping ranges) and 1.27→1.10s at 10km. The better erosion is therefore
not an overall terrain acceleration. These terrain-only calls exclude site,
urban generation, rendering and serialization. Within-source determinism and
raw imported-height byte equality pass; evidence is in the preserved
`erosion-quality/web/out/erosion-quality/quiet-bench-v4/` report.

Final assembled source `001c320c` additionally contains the functional roof
repairs, new terrain, names, workflow and title sizing. Its 52 focused plus 13
existing M5a checks, typecheck/build and local/offline native World parity pass.
Those functional checks do not remeasure the six quiet urban cases above;
the speed table remains evidence for exact-output V7 alone. Whole-generation
roof captures preserve the previous 85 accepted repairs and add three whole
roofs without introduced owner overlap. The inherited owner seam still fails
the absolute audit and the remaining 18 cuts stay open. Full-suite testing was
deferred for the user's manual trial. Verified worktree archives are retained in
`E:/CodexArtifacts/city-generator-2026-10-04/archive/acceleration-final-20261005/`.

## Method and limits

Two local Chromium headless passes, 1100 × 900 OffscreenCanvas, DPR 1, European organic culture, no secondary settlements. Imports came exclusively from the frozen, previously reviewed source at `6969dd5`, before the current primitive-city and parallel bug changes. Scratch probe and second-pass JSON: `web/scratch/perf_preliminary.mjs` and `.json` (ignored).

These are indicative samples, not a quiet-machine multi-seed benchmark. Frame measurements include `transferToImageBitmap`, but exclude presentation on the page. Headless rasterization can differ from hardware-accelerated interactive browsing. The 80,000-person case is the initial macro plan, before lazy house detail.

## Results

| Case | Generate | Build scene | First fit frame + bitmap | Warm frame + bitmap, median by zoom |
| --- | ---: | ---: | ---: | ---: |
| `p4`, town, 2.4 km, 4,020 people, 1,670 buildings | 3.65 s | 131 ms | 368 ms | 69–77 ms |
| `4`, city, 3.6 km, 14,594 people, 6,317 buildings | 5.79 s | 138 ms | 467 ms | 73–134 ms |
| `4`, 8 km, 80,000 people, 139 macro quarters | 5.61 s | 366 ms | 729 ms | 34–113 ms |

The city generation spends 3.31 s in urban generation, including 1.01 s in plots, 552 ms in primary streets and 354 ms in access; terrain/hydrology takes 1.22 s and site selection 547 ms. These nested timings must not be added to their parent stage.

SVG construction takes 334/526/954 ms respectively. Native resvg rasterization and PNG encoding at 1600 pixels takes 1.03/0.99/1.37 s. These export costs are separate from interactive rendering.

## Architectural assessment

The interactive path already retains vector geometry in a rendering worker, uses OffscreenCanvas, tile culling, LOD and cached Path2D batches. SVG is an export path. Every lazy-detail batch can rebuild the scene, at most every 400 ms; that is worth profiling with fully loaded dense quarters.

Rust/WASM may benefit compute-heavy geometry or a renderer that changes batching and caching. Calling the same Canvas APIs from Rust offers no established speedup: WASM accesses JavaScript objects through interoperability bindings ([Rust/WASM reference](https://rustwasm.github.io/docs/book/reference/js-ffi.html)). Development PNG export already uses [resvg, implemented in Rust](https://github.com/linebender/resvg).

After bugs: profile boolean cuts/plot construction, repeated scene/index work, cold texture creation and bitmap rasterization separately on the real browser. Preserve vector World/SVG data. Consider targeted WASM kernels or a GPU renderer only after those measurements establish a bottleneck and a useful gain.

## Ground-fix profiling supplement

The bug-fix agent measured the countryside fringe at `7831250` on a quiet machine,
using saved p4/city, town, 40 km regional and macro Worlds. These older snapshots
isolate fringe preparation and do not measure the new generation-time interior
permission mask or total current generation. The original general study above
remains the root agent's separate preliminary study.

| Saved case | Previous scene | Scene with fringe, cold | Warm scene | Cold fringe helper |
| --- | ---: | ---: | ---: | ---: |
| p4 open city | 240 ms | 1,772 ms | 148 ms | 1,705 ms |
| town | 104 ms | 720 ms | 77 ms | 588 ms |
| 40 km region | 1,687 ms | 2,667 ms | 1,557 ms | 1,013 ms |
| macro plan | 588 ms | 1,186 ms | 529 ms | 636 ms |

Coalesced water windows, conservative spatial filtering, bounded cosmetic
simplification and balanced four-input unions cut the worst helper from about
13.8 s to 1.7 s. Normalized masks retain their protections; final ground boundaries
differ by at most 3.2 mm from the prior 24-input grouping on these cases. Stress
tests no longer exhaust the heap. The p4 first scene still adds roughly 1.53 s;
this is a measured remaining optimisation target, not a subsecond result. Warm
measurements include cache reuse and must not be presented as cold costs.

## Current generation after the bug fixes

The root agent measured seven cases on frozen source `cf02820` (documentation
HEAD `e9a5df2`), with other agents' generation and tests paused. These are Node
`generate()` timings, excluding hashing, saved-world serialization and rendering.
Except for the repeated p4 case, each row is one preliminary sample. Options,
stage timings and whole-world hashes are saved in ignored
`web/out/current-generation-study/results.json`; binary Worlds are kept alongside
it for subsequent profiling. Timing statistics are excluded from the hashes.

| Case | Generate | Terrain | Main urban | Secondary detail | Rural land use |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10 km city, p4uefz | 11.65 s | 2.10 s | 4.54 s | 0.71 s | 2.48 s |
| 10 km city, 42 | 11.45 s | 2.23 s | 3.81 s | 1.03 s | 1.92 s |
| 10 km city, 4 | 11.32 s | 2.52 s | 3.79 s | 1.04 s | 2.09 s |
| 10 km town, 4 | 8.71 s | 2.67 s | 1.24 s | 1.20 s | 1.73 s |
| Capital preset, 4 | 4.70 s | 1.54 s | 0.18 s (macro) | 0 | 1.13 s |
| Medina town, 4 | 3.85 s | 0.98 s | 1.07 s | 0.17 s | 0.47 s |
| Persian town, 4 | 5.49 s | 0.95 s | 0.92 s | 2.14 s | 0.43 s |

All 10 km cases have twelve settlements. These samples are not directly
comparable with the original study's smaller, single-settlement Worlds. The p4
repeat took 11.46 s before artifact storage ran out of disk space and 11.65 s
after storage was restored; its non-statistical World hash stayed identical.

The six-second 10 km generation target remains unmet. The Medina and Persian
**main urban stages** are below their 1.5 s budget on this seed; their complete
maps take longer. The capital preset uses 99 lazy macro quarters, so its initial
generation does not include exact houses. Persian secondary detail deserves
separate profiling. For the p4 region, plot construction (0.99 s), access (0.67 s),
rural vectorization (0.80 s) and fields (0.83 s) are useful concrete targets.
These nested costs belong to the stages above and must not be added again.

Generation remains the largest measured cost on these cases. A renderer-only
Rust port cannot remove terrain, urban partition or rural-generation time;
targeted geometry optimizations should be assessed with output hashes before
choosing a new language or graphics backend.

## Integrated generation and rendering profile

The root agent repeated the study on source `d887575`, with other generation and
test jobs paused. Node `generate()` took **12.00 s** for `p4uefz`, city, 10 km,
twelve settlements: terrain 2.15 s, main urban 4.78 s, secondary detail 0.70 s,
and rural land use 2.47 s. Its non-statistical World hash exactly matches the
earlier `cf02820` case. This is an output-preservation check, not evidence of a
speed improvement.

A warmed V8 CPU sampling run took 10.57 s and retained that hash. Sampling was
restricted to generation, at a 1 ms interval. Polygon clipping accounts for
13.8% of sampled self time and geometry helpers for 11.9%; specific hot frames
include priority flood (6.2%), access (3.9%), noise (3.9%) and grid blur (3.4%).
Self time omits callees and must not be added to inclusive stage timings. The
sample suggests useful targets; it does not establish the gain of a rewrite.

The separate Chromium 153 native OffscreenCanvas pass used 1100 × 900 pixels,
DPR 1, terrain included, with no other generation/tests running. Frame timings
include bitmap transfer and exclude page presentation and preview PNG encoding.

| Case | Generate | Cold scene | First fit frame + bitmap | Warm median across sampled zooms |
| --- | ---: | ---: | ---: | ---: |
| `p4uefz`, city, 10 km, auto settlements | 10.21 s | 1.02 s | 802 ms | 88–134 ms |
| `3`, implicit map, 5 M, no secondaries | 16.61 s | 4.08 s | 952 ms | 31–314 ms |

The 5 M case realizes a 34 km map, 4,801 macro quarters, 9,480 stand-in blocks
and 19,894 masses. Exact houses are not generated in this initial view. Its
macro stage takes 1.32 s, but rural land use takes **11.13 s**. Whole-map scene
preparation and countryside detail deserve attention before extending the town
engine's performance work.

At fit zoom this case builds 46,904 paths against an 8,000-entry path cache;
6,904 remain afterward. Repeated cache eviction is a plausible cause of the
314 ms warm fit frame, requiring a controlled follow-up. Close views take
31–57 ms. Test far-view batching, LOD and cache working sets before simply
raising memory limits. Profile scene reconstruction as exact quarters arrive.

The current architecture already keeps vector objects offscreen. A faster
raster backend could improve first frames or exports, but cannot remove the
10–17 s spent generating these Worlds. Start with measured geometry kernels,
rural generation and scene/cache work; consider Rust/WASM or GPU rendering
only after a focused prototype demonstrates a useful gain. The six-second
10 km target remains future work under the user's preliminary-study scope.

Ignored evidence: `web/out/integration-performance/` contains the generation
benchmark, CPU profile and summary, native frame measurements and inspected
PNG views. Functional browser/export checks run separately under test load;
their timings are not substituted for these quiet profiling samples.
