# Burgmap

Procedural generator of pre-modern settlements in their landscape. From a seed (or an imported heightmap) plus options, it builds a farmstead, a village, a town or a city. Everything runs in the browser: there is no server.

**Live demo:** https://dunkean.github.io/burgmap/ · **Handoff / project state:** [HANDOFF.md](HANDOFF.md)

## What it generates

- **Landscape**
  - selectable biomes: temperate countryside, woodland, desert/oases, steppe, tropical forest and tundra;
  - relief: plain, hills, valley or mountains;
  - coast with bays and islands;
  - rivers fed from outside the map, with confluences;
  - lakes.
- **Site**: the town is placed where a real one would be: bridge point, confluence, meander, harbour, estuary, valley terrace or hilltop.
- **Regional roads** merging toward the town, bridges and fords. Rural land use around it: open-field strips, meadows, pasture, woodland, orchards and gardens.
- **Urban fabric**, built as an exact hierarchical partition: phase regions → quarters → blocks → plots → buildings.
  - The streets are the cuts.
  - Plots are burgage strips.
  - Built density follows the burgage cycle.
  - Walls are polygonal, with towers and gates.
  - Wet moats are optional (Auto / On / Off), follow the real enclosure on suitable low ground, and leave dry gate crossings.
  - Faubourgs grow along the roads.
  - Each town has parish churches and places.
- **Planning cultures**, recognisable from the plan alone:
  - 38 presets: European, Mediterranean, Asian, American, African and fantasy;
  - Swahili stone towns with coral-stone courtyard houses, bazaars, mosques and waterfront quays;
  - native village architecture retained as settlements grow into towns.

  Cultures can be mixed by growth phase, by sector or by continuous blend.
- **Scale and placement**: 10 to 5 million inhabitants, regional settlements,
  chosen centres and lazily detailed large-city quarters. Implicit maps expand
  for large populations; explicit map limits retain capacity warnings.
- **Output**: nine map styles, labels, legend, bug pins and SVG / PNG / JSON
  export. Interactive Canvas uses offscreen rendering and bounded detail caches.

## Generation workflow

Start with **Environment**: choose map extent, biome, relief, coast and rivers,
then generate a landscape without settlements, roads or farms.

In **Settlements**, choose an automatic region (20,000 inhabitants in the main
settlement by default), or add individual instances including the main one.
Each instance can choose its properties, automatic placement, coordinates or
**Place on map**. The **General theme** supplies shared defaults; changing one
instance overrides only edited fields. **Use general theme** restores inheritance
while retaining its population and chosen position.

Generation controls edit a draft. Apply it with the appropriate **Generate**
button; display controls can still update the current map. **Copy link** shares
the generated state, including its stable generation UID, pins and view. Terrain
image pixels require importing again after a shared-link reload.

## Development

```bash
cd web
npm install
npm run dev        # local preview at http://localhost:5173/
npm run typecheck  # strict TypeScript checks
npm run test:fast  # development invariants, excluding the exhaustive city matrix
npm run test:slow  # every culture/mix at city size
npm test           # both projects: complete invariant suite
npm run build      # single self-contained dist/index.html (works from file://)
npm run preview:png -- --seed 42 --size town --out out/x.png
```

The full suite includes the long city matrix; allow roughly 40 minutes. Both
projects use the same assertions and run at most two worker processes. A focused
suite can still run with `npm test -- tests/urban.determinism.test.ts`.

Current fixes and measured performance: [ROADMAP.md](ROADMAP.md) and
[PERFORMANCE_STUDY.md](PERFORMANCE_STUDY.md).

Design documents:
- `web/ARCHITECTURE.md`
- `web/URBAN_GEOMETRY.md`
- `web/URBAN_MORPHOLOGY.md`
- `web/URBAN_LANDMARKS.md`

The `town_generator/` folder holds the earlier Python prototype (reference only).

## Thanks

Many thanks to **watabou** (Oleg Dolya). His [Medieval Fantasy City Generator](https://watabou.itch.io/medieval-fantasy-city-generator) and its open-source ancestor [TownGeneratorOS](https://github.com/watabou/TownGeneratorOS) are the inspiration for this project and the benchmark it tries to live up to. The Python prototype in `town_generator/` started as a port of TownGeneratorOS. The web generator is a new implementation.

## Licence

TownGeneratorOS is GPL-3.0, and the Python prototype derives from it. This repository is therefore distributed under the GNU GPL v3; see `LICENSE`.
