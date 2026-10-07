# Rust prototype guidelines

## Scope

- Read `README.md` and `docs/INTEGRATION.md`. The user owns the engine design.
- The user authorized the terrain-only prototype: port the existing relief to Rust, add ten relief families including an open caldera, adjustable erosion, independent map/motif sizes, and regional sampling for zoom in a separate lightweight terrain bench. Other generation stages and a permanent renderer/domain model still await the user's design.
- The user also authorized eight independently selectable coast directions, with all directions forming an island or an archipelago, an optional seeded random choice, and CPU/GPU support. Sea shaping remains isolated from future hydrology and settlements.
- Coast refinements include rounded mainland support, variable multiplicative shore transitions with retained cliffs, coastal plain marine datum, varied islet shapes/relief, and a final physical erosion pass after cutting on CPU/GPU. Camera sampling retains that signed surface; it does not cut or erode again.
- The user authorized the next hydrology stage in the terrain bench: terrain-driven vector lakes and river networks, CPU Rust and WebGPU FP32 drainage, main river classes, constrained meanders, estuary adaptation and separate general/stage/display controls. Keep drainage, contributing areas, watershed labels and depressions available as display-only diagnostics. Manual source placement and animated filling remain deferred.
- Hydrology implementation uses parallel Sol agents (xhigh for complex engine/GPU code, high for other substantial code, medium for UI/simple code), as explicitly requested. Prefer compact code and compilation/startup checks; do not add a large validation framework or test matrix. The user primarily assesses visual quality.
- Keep `../web/` fully functional and independently buildable. Preserve existing local changes; do not move or rewrite the TypeScript engine.
- The existing menus/UI are retained long term. The existing renderer is transitional; keep its future replacement independent of engine integration.

## Boundaries

- `crates/core/`: native deterministic terrain engine. No browser, DOM, WASM bindings or renderer dependencies.
- `crates/wasm/`: browser bindings to the core, with coarse-grained calls. No duplicated generation rules.
- `crates/render/`: reserved for a future renderer. Its technology and API remain undecided; do not add GPU/Canvas dependencies preemptively.
- `bridge/`: future TypeScript adapters to the existing testbench/UI/renderer. Keep compatibility conversions outside the core.
- `fixtures/`: small versioned input/reference cases; `tests/`: cross-boundary checks; `benches/`: reproducible performance harnesses.
- Add Cargo members only when real crates are requested. Keep `Cargo.lock` tracked once dependencies exist. Generated packages belong in `pkg/`; reports/screenshots in ignored `out/`.

## Integration and verification

- This terrain prototype has its own `/terrainbench.html`; the original app and bench retain TypeScript. The user explicitly deferred test suites and screenshots: compile and verify browser startup/console errors, leaving visual assessment to the user. Do not add a test/CI matrix.
- Preserve replayable inputs, seeds and stage isolation. New engine output need not copy old geometry unless requested; measure invariants and compare visuals.
- Specify coordinate units, precision, ownership, versioning and error behavior when the user designs the boundary. Do not make the legacy `World` the permanent Rust model by default.
- Measure generation, adapters/transfers, scene preparation and frames separately. Never claim a speedup from different inputs or less generated detail.
- A Rust change should pass native checks and `wasm32-unknown-unknown` checks. Browser changes also require existing TypeScript typecheck/build and relevant testbench checks.
- Use `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, seeded regressions, and visual inspection when the corresponding crates exist. No full legacy suite for infrastructure-only changes.
