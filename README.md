# Burgmap

Procedural generator of pre-modern settlements in their landscape. From a seed (or an imported heightmap) plus options, it builds a farmstead, a village, a town or a city. Everything runs in the browser: there is no server.

**Live demo:** https://dunkean.github.io/burgmap/ · **Handoff / project state:** [HANDOFF.md](HANDOFF.md)

## House debug bench

Run `npm run dev` from `web/` and open http://localhost:5173/testbench.html.
The bench generates 3–8 quarters per ring/band with the native operators, in
three independent steps: streets/blocks, parcels, then buildings. Parcels can
be generated and inspected without houses. Changing the building preset or
seed keeps the exact parcel polygons and frontage frames; **Effacer les maisons**
also keeps parcels, seeds and pins. Visibility checkboxes hide either overlay
or the buildings without regenerating geometry.

Culture and recipe/phase initialize all three stage presets from the actual
cultural configuration, including extensions, sectors, villages, hamlets and
urban-growth recipes. Each stage can select a different cultural recipe or
registered morphology. Operator menus expose organic/grid splitting, all five
access variants, and the registered plot and building operators.
**Paramètres fins par étape** exposes applicable numeric/architecture parameters
as validated JSON overrides, with effective values for reference. Some IDs
share a constructor (e.g. streetFrontRow/detached/longhouse); their preset
dimensions and architecture still differ.

For collective **pâtés de maisons**, select **buildPerimeterBlock** in the
construction menu, keeping **cutPlots** for the cadastral parcels. Building
selection does not change the parcel operator. Each street facade gets a row
perpendicular to that street, with varied widths and depths. Corner returns
are cropped and merged within their original parcels. The irregular shared
court emerges from the space these buildings leave unbuilt; no court polygon
is prescribed and no per-house corridor is carved. `blockCourtShare` is a
depth preference (not an exact area target), `blockSolidChance` requests full
depth and `blockInfillChance` allows deeper ranges. All plots of one block
share that programme, subject to viable geometry and access. The
**perimeter-block** preset is available to native phase recipes too.

The default **buildPlot** method retains the original house programme on the
new parcel cuts and axes. The complete later house work is preserved under
**buildPlotExperimental** in the construction menu for future development.

Experimental `houseVariation` perturbations are retained in source but
temporarily disabled, including saved URL overrides; the control shows zero
and is disabled. Perimeter building sizes vary independently of that experiment.

Choose central sectors, **Rectangle** (the previous lateral patch), an oblique
polygon or a concave notched polygon, with one or two rings/bands. Analytical
**curved valley** and **hill** constraints restrict the land footprint and provide slope
samples to native contour-following street fields, without generating a full
landscape. Grids retain their selected orientation. A straight central river
(vertical/horizontal/diagonal, adjustable width) cuts real dry quarters before
blocks and parcels; bank edges are non-frontage. Road crossings are represented
as simple bridges. Shape, zone, relief, river and monument reservation apply
at the street/layout step.

**Apply** uses the entered seed; **↻ Graine** changes only the relevant stage's
seed. Applying an upstream stage clears its downstream results. Pins, notes,
all three seeds, each applied stage's configuration, visibility and view are
included in **Copier l’URL**. Reopening a shared URL restores the independently
applied stages exactly. Prototype URLs remain readable, but their output is
recomputed with the separated stages. New layout generations clear pins. Each
pin has a visible **Supprimer** button at the top of the side panel; deletion
also updates the shared URL, without changing the generated geometry.
The full settlement planner, global primary-road operators (axes, walls,
canals…), regional terrain/camp generation and final settlement-wide roof
repairs remain outside this isolated geometry fixture.
`npm run build` also produces a self-contained `web/dist/testbench.html`.
Check the offline UI with `node scripts/testbench_check.mjs`; screenshots and
check results go to ignored `web/out/testbench/`.

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
