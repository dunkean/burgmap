# Preliminary Performance Study

Measured 2026-10-04. Bug fixes take priority; this study does not introduce a renderer rewrite or Rust dependency.

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
