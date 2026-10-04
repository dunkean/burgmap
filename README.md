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
  - European organic, bastide, Roman core;
  - Medina, Chinese walled city, Japanese castle town, Indian temple town;
  - Elven, dwarven.
  
  Cultures can be mixed by growth phase, by sector or by continuous blend.
- **Output**: several map styles, labels, legend, and SVG / PNG / JSON export.

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

The full suite includes the long city matrix; allow roughly 20 minutes. Both
projects use the same assertions and run at most two worker processes. A focused
suite can still run with `npm test -- tests/urban.determinism.test.ts`.

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
