# Repository Guidelines

## Project Structure & Module Organization

Burgmap is a serverless TypeScript settlement generator. Active development lives in `web/`: `src/gen/` contains pure generation algorithms, `src/render/` contains SVG and Canvas rendering, and `src/ui/` contains controls and workers. Tests live in `web/tests/`; preview and UI verification tools live in `web/scripts/`. Generated images belong in ignored `web/out/`, and builds in `web/dist/`.

`town_generator/` and root `tests/` hold the earlier Python prototype and its tests; use them as references. Read `HANDOFF.md`, `BUGS.md`, and the relevant design documents in `web/` before changing generation behavior.

The new Rust prototype lives independently in `rust/`. Read `rust/AGENTS.md` and `rust/README.md` before working there. `web/` stays the working application and reference testbench; its dev/build commands must not require Rust. The user will design the new engine: preparation does not authorize implementing algorithms or choosing its domain model. In the final architecture only the current UI is retained; the current renderer is a temporary integration aid.

## Build, Test, and Development Commands

Run these from `web/`:

- `npm install`: install dependencies.
- `npm run dev`: start Vite at `http://localhost:5173`.
- `npm run typecheck`: check strict TypeScript without emitting files.
- `npm test`: run the full Vitest suite; allow roughly 20 minutes.
- `npx vitest run tests/urban.determinism.test.ts`: run a focused suite.
- `npm run build`: produce self-contained `dist/index.html`, usable offline.
- `npm run preview:png -- --seed 42 --size town --out out/check.png`: render a visual verification image.

For legacy Python changes, run `python -m pytest tests/ -q` from the repository root.

## Coding Style & Naming Conventions

Match existing TypeScript: two-space indentation, single quotes, semicolons, camelCase functions and variables, and PascalCase types/classes. Python uses four spaces and snake_case. TypeScript is strict; no ESLint or Prettier configuration is present. Ruff is listed in Python's development extras.

Keep `src/gen/` independent of DOM and Node globals. Use `rng.fork(label)` for deterministic randomness, never `Math.random()`. World coordinates are meters. Preserve exact urban partitions, street frontage, building containment, and access.

## Testing Guidelines

Name Vitest suites `web/tests/<feature>.test.ts` and Python tests `tests/test_<feature>.py`. Add seeded regression cases for geometry or generation fixes. No numeric coverage threshold is configured. Run relevant suites, typecheck, and build; visually inspect rendered PNGs for visual changes. Keep SVG and Canvas behavior consistent.

## Commit & Pull Request Guidelines

History uses descriptive subjects such as `Small bridges in town: ...`; no enforced Conventional Commits scheme is evident. Keep commits focused. PRs should explain behavior, reproduction seed/options, validation commands, and related bug entries; include before/after images for visual changes.

Fix `BUGS.md` entries in order. Append `→ fixed in <hash>` after committing, preserving the user's original text. Never commit tokens or generated scratch output.
