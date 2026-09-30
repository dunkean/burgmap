# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Python port of watabou's TownGeneratorOS (Haxe/OpenFL), being extended into a multi-stage generator: terrain → region → city → districts → building detail/roofs. `Design.md` is the spec for that extension (modules M1–M6, the CityMap JSON contract, migration phases); `Onboarding.md` is a deep walkthrough of the city pipeline's algorithms and limitations. Read the relevant section before large changes. The original Haxe source is at `TownGeneratorOS/Source/com/watabou/` (read-only reference).

## Commands

```bash
# Webapp — the primary interface (also: dev.sh / dev.bat). Always use --reload in development.
python -m uvicorn town_generator.webapp.app:app --host 127.0.0.1 --port 9000 --reload

# CLI
python -m town_generator -s 42 -n 15 -p default -o city.svg

# Tests (pytest is in the `dev` extra; install with: pip install -e ".[dev,web]")
python -m pytest tests/ -x -q
python -m pytest tests/test_toggles.py -q                 # one file
python -m pytest tests/test_region.py -k "name_fragment"  # one test

# Lint (ruff is in the `dev` extra)
ruff check town_generator tests
```

Requires Python ≥3.10. Optional extras in `pyproject.toml`: `web` (fastapi/uvicorn/jinja2), `png` (cairosvg), `terrain` (numpy — `terrain/noise.py` falls back to pure Python without it), `dev`.

## Critical invariants

- **Identity semantics on `Point`**: code compares points with `is`, not `==` (shared vertices between patches are the same object). NEVER add `__eq__`/`__hash__` to `Point`.
- **`class Polygon(list)`**: a list subclass with direct index access, not a wrapper.
- **Determinism**: `utils/random.py` is a Park-Miller LCG with global class state. `Model.__init__` always consumes 3 `Random.bool()` calls regardless of toggle overrides, so seeds stay compatible — do not remove or reorder them, and don't add `Random` calls earlier in the pipeline without accepting that all seeds shift. Per-district seeds are derived in `Model._district_seed`; `detail/` uses its own local `random.Random(seed)` instances instead of the global PRNG.
- **Zero-dep core**: generation uses only the stdlib (SVG via `xml.etree.ElementTree`). Third-party packages are only for the webapp, PNG output, and optional numpy acceleration.

## Architecture

### City pipeline (`building/model.py`, `Model._build`)
```
_build_patches → _generate_water → _optimize_junctions → _build_walls → _build_streets
→ river.find_bridges → _clip_patches_to_water → _create_wards → _build_geometry
```
Generation retries up to 20 times on failure. Toggles are keyword-only `Model` args; `bool | None` where `None` means random/default (`plaza`, `citadel`, `walls`, `temple`, `river`, `coast`, `shanty_town`), plus `n_roads`, `road_style` ("organic" A* arteries or "medieval" with concentric ring roads), shape params (`elongation`, `river_curvature`, `coast_roughness`), `style`, and a family of `district_*` params.

Two building paths exist:
- **Legacy wards** (`wards/`): `Ward` base + subclasses, mostly port of the Haxe code. `ward.py` holds `create_alleys` (recursive bisection), `create_ortho_building`, `_add_complexity` (L-shaped notches), `_filter_water` (vertex-level water check).
- **District populators** (`district/`): newer M4 system. `registry.py` maps district type + cultural style → a `BasePopulator` (organic_alley, grid, courtyard, bazaar, monastic, palace, military, farm_plot, disk_packing). Selected when `district_populator` is passed; `Model._populate_district` falls back to serialized legacy buildings otherwise.

`Model.to_city_map()` produces the CityMap JSON dict described in `Design.md` — the contract between modules.

### Other modules
- `styles/style.py` — cultural style dataclasses (ward weights, street pattern, wall type, landmarks, render hints).
- `detail/` — M5 building detail: `roof.py` + `skeleton.py` (straight-skeleton roofs), `compound.py` (multi-wing shapes), `facade.py`, `processor.py` (`process_building` ties them together), `district_roofs.py` (roofscape for a whole district).
- `terrain/` — M1 v1: noise, elevation, hydrology, ground cover, world map.
- `terrain_v2/` — geology map: relief, coastline, rivers (meanders, variable width), lakes, contours, biotopes, size scales (hamlet → agglomeration).
- `region/` — M2: site scoring and regional road network.
- `rendering/` — SVG renderer (draw order: coast → river → roads → patches → walls → bridges; `<clipPath>` masks water from walls/roads), PNG renderer, palettes.

### Webapp (`webapp/app.py`)
FastAPI serving plain HTML templates (`templates/`) and vanilla JS (`static/`, one JS file per tool). Each module has a standalone editor page at `/tools/<name>/` backed by `/api/<name>`:
city, terrain, geology, region, district, district_roofs, building, roofs, gen-roofs. `/` + `/api/generate` is the original city map (returns SVG); `/api/city` returns the full CityMap JSON with district/roof params.

## Manual verification

`Notes.md` has a checklist for the geology tool (`/tools/geology/`): test each size with seed=42, all three views (elevation/topo/biomes), coast/rivers/lakes/relief variations, closed non-crossing contour lines, and same-seed determinism.
