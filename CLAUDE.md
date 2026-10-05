# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The active project is **Burgmap**, the serverless TypeScript generator in `web/`. Start with `HANDOFF.md` at the repository root. It covers the state of the project, the commands, the code map, the invariants and the remaining work. Then read **`BUGS.md`**, the user's bug list, which has priority: fix its entries in order and mark each with `→ fixed in <hash>`, without deleting the user's text. Then read `AGENTS.md` (style and commit conventions) and the design documents in `web/` (`ARCHITECTURE.md`, `URBAN_GEOMETRY.md`, `URBAN_MORPHOLOGY.md`, `URBAN_LANDMARKS.md`, `REGION_SETTLEMENTS.md`, `POLISH.md`).

## Commands (in `web/`)

```bash
npm install && npm run dev        # http://localhost:5173
npm run typecheck                 # strict tsc, no emit
npm run test:fast                 # all development suites
npm run test:slow                 # exhaustive city/culture/mix matrix (tests/urban.cultures.city.test.ts)
npm test                          # both projects; allow ~40–60 min
npx vitest run tests/<file>.test.ts   # one file
npm run build                     # single-file dist/index.html (works from file://)
npm run preview:png -- --seed 4 --size city [--opt k=v ...] --crop x,y,w --out out/x.png
node scripts/ui_check.mjs http://localhost:5173/ out/chk --set "seed=4&size=city" --name x --scales fit,0.6
```

`BURGMAP_PERF=1` enables performance assertions (needs a quiet machine). `web/out/` and `web/scratch/` are ignored evidence/scratch space. Most of `web/scripts/` are one-off debug/preview tools; `preview.ts` and `ui_check.mjs` are the main ones.

## Architecture (big picture)

- `(seed | heightmap) + options → World`, entirely in the browser. `src/gen/pipeline.ts` runs terrain → hydrology → site → regional roads → settlements/land use → urban plan. `options.ts` maps URL options; `types.ts` defines the World, which must stay structured-clonable (it crosses worker boundaries).
- `src/gen/` is pure TS with no DOM or Node globals, so it runs in Node (tests, preview script) and in Web Workers (`src/ui/worker.ts`, `quarterWorker.ts`, `renderWorker.ts`).
- Urban generation (`src/gen/urban/`) is a strict hierarchy: phases → quarters → blocks → plots → buildings, with streets as the cuts. Cultures are data-driven planning programmes (38 registered); `camps/` handles native villages.
- Large cities use an eager macro plan (`urban/mega/`) plus lazily generated exact quarters in nested workers with a bounded cache; full exports detail every quarter through a separate cache.
- Rendering (`src/render/`) has two backends, SVG export and Canvas with LOD/culling. Keep them visually consistent; shared helpers hold physical stroke and bridge widths.

## Non-negotiables

- **Partition, never place.** Urban space is an exact hierarchy, and streets are the cuts. No overlaps, every plot fronts a street, every building is reachable from a street.
- **Determinism.** Never use `Math.random()` in `src/gen`. Always derive randomness with `rng.fork(label)`. Pure refactors must leave seeded output unchanged; when inputs legitimately change, prove attribution before updating snapshots.
- **No Node globals** (such as `process`) in `src/gen`: it runs in browser workers. Coordinates are metres.
- **Check visuals visually.** Render a PNG and look at it; tests alone are not enough.
- **Plan quality over rendering polish.** European towns are organic and phased, never grids. Walls are straight curtains between towers. Each culture must be recognisable from its plan alone.
- Preserve the user's untracked `web/scripts/repro_culture.mjs` and `web/scripts/repro_race.mjs`.

## Publishing

Push validated commits to remote `main`, then from the repo root run `GITHUB_TOKEN_FILE=/path/to/token bash web/scripts/deploy_pages.sh` (builds committed HEAD in a clean worktree and publishes `gh-pages`). Never print the token. Only publish when the user asks.

## Legacy

`town_generator/` is the earlier Python prototype, a port of watabou's TownGeneratorOS. It is reference only; do not port it wholesale. Its commands are `python -m town_generator -s 42 -n 15 -o city.svg` and `python -m pytest tests/ -q`.
