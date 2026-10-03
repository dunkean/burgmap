# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The active project is **Burgmap**, the serverless TypeScript generator in `web/`. Start with `HANDOFF.md` at the repository root. It covers the state of the project, the commands, the code map, the invariants and the remaining work. Then read the design documents in `web/` (`ARCHITECTURE.md`, `URBAN_GEOMETRY.md`, `URBAN_MORPHOLOGY.md`, `URBAN_LANDMARKS.md`, `REGION_SETTLEMENTS.md`, `POLISH.md`).

## Commands (in `web/`)

```bash
npm install && npm run dev        # http://localhost:5173
npm test                          # full suite (~20 min); one file: npx vitest run tests/<file>.test.ts
npm run build                     # single-file dist/index.html
npm run preview:png -- --seed 4 --size city --crop x,y,w --out out/x.png
node scripts/ui_check.mjs http://localhost:5173/ out/chk --set "seed=4&size=city" --name x --scales fit,0.6
```

## Non-negotiables

- **Partition, never place.** Urban space is an exact hierarchy, and streets are the cuts. No overlaps, every plot fronts a street, every building is reachable from a street.
- **Determinism.** Never use `Math.random()` in `src/gen`. Always derive randomness with `rng.fork(label)`.
- **No Node globals** (such as `process`) in `src/gen`: it runs in browser workers.
- **Check visuals visually.** Render a PNG and look at it; tests alone are not enough.
- **Plan quality over rendering polish.** European towns are organic and phased, never grids. Walls are straight curtains between towers. Each culture must be recognisable from its plan alone.

## Legacy

`town_generator/` is the earlier Python prototype, a port of watabou's TownGeneratorOS. It is reference only. Its commands are `python -m town_generator -s 42 -n 15 -o city.svg` and `python -m pytest tests/ -q`.
