# Multiple settlements per map (M3c)

A map holds a **settlement system**, not a single town. Larger maps get a main town plus the villages, hamlets and farmsteads a real territory would have. The user can drive everything with custom values or leave it on automatic.

## Options

- `mapSize`: custom map extent in meters (600 m – 40 km). The size presets keep working as shortcuts that fill `mapSize` and `population`.
- `population`: population of the main settlement (10 – 5,000,000). Its class (hamlet → megacity) is derived continuously (URBAN_MORPHOLOGY §3d).
- `settlements`:
  - `auto`: derived from the map area and the main population;
  - or explicit counts per class: `{ city, town, village, hamlet, farmstead }`;
  - or an explicit list `[{ population, culture?, siteType?, position? }]`, settlements added one by one in the UI (optional fixed position by clicking the map).
- Each secondary settlement may have its own `culture` (mix of peoples, e.g. a dwarven hold in the mountains near a human town). Default: the main culture.

## Automatic settlement system (central-place logic)

- **Densities** (pre-industrial Europe, tunable): rural density 20–40 inh/km² outside towns. Villages of 150–600 inh spaced 2–4 km apart, hamlets of 15–80 inh in between, isolated farmsteads. Market towns of 1–5 k spaced 15–25 km apart, so they appear only on large maps.
- **Spacing (Christaller-like)**:
  - the main settlement first;
  - then secondary ones by decreasing size, each placed by site archetype scoring (water, flat dry land, crossings) with a minimum distance growing with both populations;
  - no settlement on another one's fields core.
- **Exclusion**: secondary sites must not overlap the main town's projected extent plus its gardens ring. They avoid water, steep slopes and dense forest; dense forest is allowed for elven settlements and mountains for dwarven ones.

## Pipeline changes

1. terrain (unchanged, uses `mapSize`).
2. **settlement planner**: chooses the sites and populations of all settlements (archetype per site).
3. **roads**: a network connecting all settlements to each other and to the map edges. This is a minimum-spanning / Delaunay-pruned graph weighted by importance, routed with the existing A*, with merging and bridges. Every settlement is connected.
4. **urban**: generate each settlement with the existing urban engine in its own region (the Voronoi cell of its site, clipped). Each settlement uses its own `rng.fork('settlement:k')`, so adding a settlement does not reshuffle the others.
5. **landuse**: the rural rings (von Thünen) are computed from all settlements. Each village gets its open fields, commons and woods, and farmsteads sit in their fields.

## Performance

- Hamlets and villages are cheap.
- Secondary towns are generated eagerly when the total population is < ~50 k. Beyond that, a settlement is generated lazily as a "quarter" when the viewport zooms in (see the megacity LOD in URBAN_MORPHOLOGY §3d).

## UI

- Map size: preset or custom meters.
- Population: preset or a log slider plus a number field.
- "Settlements: auto / counts / list". In list mode, an editable list (population, culture, optional click-to-place). Everything serializes to the URL.
- On the map, each settlement is labeled. Clicking a settlement focuses it.

## Invariants and tests

- Every settlement is reachable by road.
- No settlement extents overlap.
- Minimum spacing is respected.
- Explicit counts and lists are honored when land allows; a warning is shown otherwise.
- Determinism, and stability when a settlement is added (the others are unchanged).
