# Burgmap

Procedural generator of pre-modern settlements in their landscape. From a seed (or an imported heightmap) plus options, it builds a farmstead, a village, a town or a city. Everything runs in the browser: there is no server.

**Live demo:** https://dunkean.github.io/burgmap/

## What it generates

- **Landscape**
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
npm run dev        # dev server
npm test           # vitest invariant suites
npm run build      # single self-contained dist/index.html (works from file://)
npm run preview:png -- --seed 42 --size town --out out/x.png
```

Design documents:
- `web/ARCHITECTURE.md`
- `web/URBAN_GEOMETRY.md`
- `web/URBAN_MORPHOLOGY.md`
- `web/URBAN_LANDMARKS.md`

The `town_generator/` folder holds the earlier Python prototype: a port of watabou's TownGeneratorOS, used as reference.

## Credits and licence

The Python prototype is derived from [TownGeneratorOS](https://github.com/watabou/TownGeneratorOS) by watabou (GPL-3.0), included as a submodule. This repository is distributed under the GNU GPL v3; see `LICENSE`.
