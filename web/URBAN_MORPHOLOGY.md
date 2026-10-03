# Urban morphology system — configurable, mixable town-plan cultures

Goal: the same engine produces medieval European towns (default), bastides, Islamic medinas, Chinese walled cities, Japanese castle towns, Indian temple towns… and **mixes** them (a medina core with a colonial grid extension, a Chinese grid with organic suburbs, a European town around a Roman castrum core). A plan is not a monolithic "style": it is a **history of growth phases**, each phase built with its own morphology.

## 1. Core idea: a plan = a sequence of phases on one shared planar graph

```
Plan
 ├─ nucleus        what the town grew around (market+church, castle, mosque+souk, temple, palace, crossroads, harbor, abbey)
 ├─ phases[]       ordered growth stages; each has a region, a morphology, an enclosure
 └─ culture        default morphology + landmark catalogue + naming + render hints
```

Every phase writes into the **same** street graph (`core/graph.ts`: nodes, edges with `width`, `rank`, `phase`, `kind`), so later phases connect to earlier streets and old enclosure lines become streets. Blocks are always faces of the final graph; each block inherits the morphology of the phase that created most of its boundary (or of the phase region containing its centroid).

### Phase

```ts
interface Phase {
  id: number;
  region: Polygon;            // area this phase may build in (computed by the phase planner)
  morphology: MorphologyId | Partial<Morphology>;   // preset id, optionally overridden
  enclosure?: EnclosureSpec;  // wall/ditch/palisade/none, shape, gates rule
  fossilizeEnclosure: boolean;// when a later phase surpasses it: wall line → ring street (EU), kept as inner wall (CN), demolished (none)
}
```

The **phase planner** (`urban/phases.ts`) derives regions from the travel-cost field: phase k occupies the cost band `[r_{k-1}, r_k]` (plus ribbons along roads for faubourg phases), with `r_k` from the population target. Shape comes from `enclosure.shape`: `organic` (cost isoline, smoothed), `oval`, `rect` (oriented to `orientation`), `square-cardinal`, `polygon-bastioned`.

## 2. Morphology = composable operators + parameters

A morphology is a small program: which **street operators** run (in order, with weights), then which **plot operator** and **building operator** fill blocks. All numeric knobs are continuous so presets can be interpolated.

```ts
interface Morphology {
  streets: StreetOp[];          // applied in order inside the phase region
  plots: PlotOp;                // how blocks are divided
  buildings: BuildingOp;        // how plots are built
  squares: SquareRule[];        // open spaces: market square, forecourt, souk widening, none
  params: {
    curvature: number;          // 0 straight … 1 very sinuous (heading random-walk σ)
    forkAngle: [number, number];// Y-forks vs T-junctions
    deadEndRatio: number;       // 0 through-streets … 0.7 medina derbs
    hierarchyDepth: number;     // 2 (main+lane) … 4 (main, street, lane, cul-de-sac)
    spacing: [number, number];  // distance between parallel streets (m)
    widthScale: number;         // street widths multiplier
    widthJitter: number;        // bulges/narrowings along a street
    orientation: 'cardinal' | 'road' | 'terrain' | 'free';
    gridSkew: number;           // deviation of grids from perfect (0 = drafting-table)
    blockSize: [number, number];// target block area range (m²)
  };
}
```

### Street operators (`urban/ops/streets/*.ts`, each `(graph, region, params, rng) → void`)

| op | produces | used by |
|---|---|---|
| `radials` | curved main streets from nucleus to gates/exits (reuses regional roads) | EU, IN, JP |
| `rings` | streets along concentric isolines / fossilized enclosures | EU, IN (pradakshina paths) |
| `organicInfill` | lanes grown from existing edges with noisy heading, Y-forks, stop on hit | EU, faubourgs |
| `grid` | (skewed) orthogonal grid clipped to region, aligned per `orientation` | bastide, Roman, CN, JP merchant quarters, Laws of the Indies |
| `axis` | one dominant ceremonial axis (N–S) + cross axis | CN, IN, Roman cardo/decumanus |
| `gateToGate` | through-routes linking gates via the core (souk spine) | medina, EU |
| `culDeSacTree` | tree-like dead-end derbs branching into large blocks, no loops | medina, some IN mohallas |
| `hutong` (`closeOp`) | cardinal dead-end lanes serving deep, river- or wall-clipped ward interiors before parcel cutting | CN |
| `ribbon` | one street + back lanes along a road | street villages, faubourgs |
| `defensiveKinks` | T-junctions/dog-legs (masugata) near castle and gates | JP, some EU |
| `wardWalls` | walled sub-quarters with 1–4 gates | CN (fang), medina (hara), JP (machi gates) |

### Plot operators (`urban/ops/plots/*.ts`, per block)

| op | description | used by |
|---|---|---|
| `burgage` | narrow deep strips ⟂ frontage, fanned on curves | EU |
| `courtyard` | block packed with irregular inward-facing courtyard houses, access by dead-ends | medina, IN haveli |
| `siheyuan` | rectangular compounds on a lane grid (hutong), N–S oriented, courtyard(s) | CN |
| `machiya` | very narrow deep lots, small rear garden | JP, some CN |
| `compound` | large walled enclosures (temple, palace, samurai yashiki, monastery) | all |
| `garden` | whole block as garden/orchard/cemetery | all |

### Building operators

`streetFrontRow` (EU/JP: continuous or gapped rows, `rowContinuity`), `courtyardHouse` (built ring around 1–2 courts, blank street walls), `pavilionCompound` (CN/JP: separate halls on an axis within a walled court), `detached` (suburbs, farms). Parameters: `coverage`, `rowContinuity`, `courtyardRatio`, `depth`, `setback`.

## 3. Culture presets (data, `urban/cultures/*.ts`)

A culture = default nucleus + phase recipe + morphologies + landmark catalogue + walls + render hints. Presets are **plain data** so users can edit JSON and mix.

| culture | nucleus | phase recipe | streets | plots/buildings | walls | landmarks |
|---|---|---|---|---|---|---|
| `european-organic` (default) | market + parish church, or castle / abbey | 2–4 radio-concentric phases, old walls → ring streets, faubourgs | radials + rings + organicInfill | burgage + streetFrontRow | curtain wall, round towers, gates on roads | market square, church(es), cathedral (city+), castle, monastery, guildhall, mills, tanneries downstream |
| `bastide` | central arcaded square | 1 planned phase + organic faubourgs | grid (skew 0.05, orientation road) | burgage + rows | rectangular-ish wall | central square with hall, church one block off |
| `roman-core` (mix component) | forum at cardo×decumanus | castrum grid core, later EU phases around | axis + grid | courtyard → burgage later | rectangular with rounded corners | forum, basilica→cathedral |
| `medina` | Friday mosque + souk | organic core, quarters (harat) | gateToGate + culDeSacTree (deadEnd 0.5–0.7) | courtyard + courtyardHouse, high coverage (0.8+) | mud wall with square towers, kasbah at edge | great mosque, souk lanes, hammams, funduqs near gates, kasbah, cemeteries outside gates, no large squares |
| `chinese` | yamen / drum & bell towers | square-cardinal walled city, walled wards | axis + grid + wardWalls (+ organic outside walls) | siheyuan + pavilionCompound | rectangular, cardinal gates, moat, corner towers | drum/bell tower at center, yamen, temples, city god temple, east/west markets |
| `japanese-jokamachi` | castle | castle compound → samurai ring → merchant grid along roads → temple belt | grid (merchant) + defensiveKinks + rings | machiya (merchants), compound (samurai, temples) | castle walls & moats only; town unwalled | castle, temple row at edge, shrines, merchant streets |
| `indian-temple` | temple complex | concentric square rings around temple, bazaar radials | axis + rings(square) + grid | courtyard / compound (haveli) | optional fort | temple with gopurams, tank (sacred pond), bazaar streets, palace |

### 3b. More historical cultures (same engine, new presets + a few new operators)

| culture | signature features | new operators needed |
|---|---|---|
| `norse` | Trelleborg ring fortress (perfect circle, 4 gates, cross streets, longhouses in squares); emporium strip along a beach (Hedeby, Birka) with jetties | `ringFort`, `longhouse` building, `jetties` |
| `celtic-oppidum` | hilltop enclosure following contours, multiple ramparts (murus gallicus), dispersed roundhouses in enclosures | `contourRamparts`, `roundhouse`, `enclosureCluster` |
| `byzantine-greek` | hillside town, acropolis/kastro on the summit, streets along contours + stepped lanes up-slope, domed churches | `contourStreets`, `stairLanes` |
| `russian-kremlin` | kremlin (triangular fort on river confluence) + posad (trade suburb) + sloboda suburbs, earthen ring ramparts, wooden houses in large yards | `confluenceFort`, `yardHouse` |
| `hanseatic` | planned-ish ribs of streets down to the harbor, gabled narrow houses, market + town hall + brick hall church, warehouses on quays | `ribsToWater`, `quay` |
| `venetian-lagoon` | islands separated by canals, campo + church per island, bridges, fondamenta, palazzi on the Grand Canal | `canals`, `islandParishes` |
| `persian` | maidan (huge square), chahar-bagh gardens, covered bazaar spine, qanats, caravanserais | `bazaarSpine`, `charBagh` |
| `ottoman` | mahalle neighborhoods around small mosques, külliye complexes, wooden houses, çarşı markets | `neighborhoodCells`, `complex` |
| `sahel` | mud mosques (Djenné, Timbuktu), compound houses, sand lanes, wide irregular squares | `compoundCluster` |
| `swahili-stone-town` | coral stone houses, narrow lanes, waterfront, carved doors (render hint) | reuse medina ops + `quay` |
| `aztec` | island city, causeways, canals grid, chinampas (field strips in water), ceremonial precinct with pyramids | `causeways`, `chinampas`, `ceremonialPrecinct` |
| `maya` | dispersed farmsteads around a ceremonial core, sacbe raised roads, plazas | `dispersedHouselots`, `sacbe` |
| `inca` | kancha rectangular walled compounds on a grid, terraces on slopes, central plaza | `terraces`, `kancha` |
| `khmer` | moated square enclosures, barays (huge reservoirs), temple-mountains, dispersed houses on stilts | `moatedSquare`, `baray` |
| `korean` | CN-like but terrain-adapted (pungsu: mountain behind, water in front), hanok courtyards | reuse CN ops, `terrainAxis` |
| `nomad-camp` | yurts/tents in concentric circles around the ruler's tent, livestock pens | `campRings`, `tent` |

### 3c. Imaginary cultures (fantasy)

| culture | plan logic | distinctive operators / render |
|---|---|---|
| `elven` | settlement woven into forest: no clearing, spiral/curvilinear paths following tree crowns, very low footprint, gardens, sacred grove at center, living hedge instead of wall, bridges across streams | `forestWeave` (build only where tree density high, keep trees), `spiralPaths`, `treeHouse` (circular footprints), render trees above paths |
| `dwarven` | hold in a mountain flank: fortified gatehouse at the mountain face, rectilinear terraces cut into slope, switchback ramps, forges & mine mouths, stone halls; strict geometry (orthogonal, octagonal); optional underground layer (halls, radial tunnels) as a second map | `mountainGate`, `cutTerraces`, `switchbacks`, `mineMouths`, `underLayer` |
| `halfling` | burrows dug into gentle hills (round doors facing south/sun), meandering lanes, hedgerows, big gardens, inn at the crossroads, party field | `burrowHill` (houses on slopes along contours), `hedgerows`, very low density |
| `orcish` | war camp → town: palisade rings of sharpened stakes, chaotic sprawl, pits and arenas, warlord's hall on a mound, shanty belts | `palisadeRings`, `sprawl` (random packing), `arena` |
| `gnomish` | canals and locks, dense tall narrow houses, workshops, clock-tower plaza, radial-geometric districts | `canals`, `locks`, very high `rowContinuity` |
| `stilt-town` (lizardfolk / marsh folk) | houses on stilts over marsh or lagoon, boardwalks instead of streets, docks | `boardwalks`, `stilts` (buildings allowed on water) |
| `wizard-city` | concentric geometric rings (circles/polygons) around a central tower, radial avenues aligned on stars, ley-line axes, arcane gardens | `geometricRings`, `leyAxes` |
| `necropolis` | city of the dead: grid of tombs & mausolea, processional avenue, charnel houses | `tombGrid` |

Fantasy presets obey the same invariants (walkable, no overlaps), but they may lift some rules through explicit flags. Examples: `stilt-town` allows buildings over water; `elven` keeps forest cover under the town instead of clearing it.

## 3d. Scale ladder: 10 inhabitants → 5 million

Settlement **form changes with scale**. It is not the same plan zoomed.

| class | population | map extent | form |
|---|---|---|---|
| farmstead / hamlet | 10–100 | 0.6–1.2 km | 2–15 farmsteads (house + barn + yard), clustered around a green/well/chapel or strung along a track; no streets, only tracks; culture sets the cluster type (EU: *Weiler*; nomad: camp; elves: grove; dwarves: outpost gate) |
| village | 100–1 000 | 1.2–2 km | village archetypes chosen by culture/terrain: nucleated, street village (*Strassendorf*), green village (*Angerdorf*), round village (*Rundling*), hilltop *circulade/borgo*, dispersed |
| market town / bourg | 1 k–5 k | 2–3 km | first enclosure, market place, 1–2 phases |
| town | 5 k–20 k | 3–4 km | 2–3 phases, walls, faubourgs, several parishes |
| city | 20 k–100 k | 4–8 km | 3–4 phases, several nuclei (cathedral close, castle, abbey burgs merged), quarters |
| metropolis | 100 k–1 M | 8–20 km | polycentric: absorbed villages become district centers, several wall rings, satellite towns, suburbs along every road, specialized districts (port, industry, palace city) |
| megacity | 1 M–5 M | 20–40 km | Edo/Chang'an/Baghdad and fantasy capitals: multiple cities fused, canals/rings, districts each a full town plan |

Population is a continuous option (log slider). The class is derived from it, and the parameters interpolate between classes.

### Multi-scale generation & level of detail (required above ~50 k inhabitants)

- **Macro level** (always, whole map): terrain, site, regional roads, phase/district planner, arterial street graph, walls, district polygons with their morphology and density, landmarks of city rank. Cheap: < 3 s even for the megacity.
- **Detail level** (per district, lazy): streets, blocks, parcels and buildings of a district are generated **on demand** when the viewport zooms in, in a Web Worker. The seed is deterministic (`fork('district:id')`), so the result is identical every time and does not depend on generation order. Boundaries between districts are fixed by the macro graph, so tiles always match.
- **Rendering**: switch from SVG to **Canvas 2D** (or WebGL later) for the interactive view. LOD by zoom:
  - far: district fills with density tint, arterials, walls and water;
  - mid: block polygons;
  - near: parcels and buildings.
  SVG export stays available for a chosen region or for small settlements.
- A cache (LRU) of generated districts. The "full detail export" of a megacity can be done tile by tile.
- Hamlets up to cities (< 50 k) may still generate everything eagerly.

**Implemented** (`urban/mega/`, see ARCHITECTURE.md "Megacity scaling"): main settlements above `eagerPop` (default 40 000) get the macro plan + lazy quarters; at or below it the eager town stage runs unchanged. The lazy unit is the *quarter* (the piece between arterials, 4–15 ha), seed `fork('quarter:' + id)`.

Plan form (`mega/plan.ts`, `mega/rings.ts`):
- Growth lines are cost isolines weighted per direction: growth is favoured along the river or the shore and the main roads, and each phase leans to its own side. Some later lines are partial: on one sector they *are* the older line (shared vertices), as with Paris's walls.
- Every line is a max-deviation polygon whose vertices sit on high ground. Towers stand at the vertices and every 60–85 m along the runs. A stretch shared with an older standing wall is drawn once. Fused towns are 7–11-sided enceintes.
- Radials wander, and some fork off an older road outside its gate.
- City-rank elements:
  - a citadel on the best defensible site (`m4-castle`, curtain drawn by the plan);
  - university quarters near the cathedral or across the water;
  - a collegiate church in each fused town;
  - tanneries and mills by the water outside the walls;
  - elite parks toward the palace;
  - in lowland river cities, a canal down a former wall boulevard.
- Arterials carry deterministic `anchors`. Quarter detail starts its first streets there, so streets continue across the arterial.
- The stand-in fabric varies grain, orientation and built form by age and density. The worker pre-details the old core in the background.
- Secondary settlements above the threshold get the same path when their lazy detail is built (quarter keys `si·MEGA_KEY + q`).

## 4. Mixing

- **By phase (discrete)**: `phases: [{morphology:'roman-core'}, {morphology:'european-organic'}, {morphology:'european-organic', ribbon:true}]`. This covers most historical cases (colonial extensions, conquered cities, planned new towns attached to old ones).
- **By district (discrete)**: a phase may split its region into sectors with different morphologies (e.g. a merchant grid sector and an organic sector in the same enclosure; a Jewish/Christian quarter with its own ward wall in a medina).
- **By blending (continuous)**: `blend(a, b, t)` interpolates numeric params and picks discrete ops from the dominant side (or unions the op lists with weights). UI slider "medina ↔ european" etc.
- **Landmarks** are merged from all cultures present, deduplicated by role (a town gets one "main worship" landmark per culture present, placed in that culture's phase).

## 4b. Density and plot filling (all cultures)

Plots are not static. The **burgage cycle** (Conzen) says that plots fill over time: first a house at the front and a garden behind; then rear wings, workshops and back-to-back tenements along the plot sides; finally the whole plot is built, leaving only narrow courtyards or a passage. Consequences:
- A `coverage`/`infill` parameter grows with **phase age** and **density**. Historic core: 75–95 % built, agglomerated masses of merged footprints. Recent phases and faubourgs: 40–60 %. Villages and hamlets: yards and gardens.
- Merged masses are rendered as one dark fabric pierced by courtyards (Nolli/Merian style), not as one rectangle per plot.
- Each culture has its own dense form. Medina: courtyard houses packed wall to wall. Chinese hutong: siheyuan subdivided into shared courtyards. Edo: nagaya row-tenements behind the merchant fronts. Roman insulae: blocks built solid.

## 5. Invariants shared by all morphologies

Same as ARCHITECTURE.md: no buildings in water/streets/overlapping, every plot reachable (cul-de-sacs count), determinism with `rng.fork('phase:k')`, `fork('block:i')`. The European default must keep the organic, phased, radio-concentric character (user rule).

## 6. UI

`culture` select (presets) + "advanced" panel: phases list (add/remove, morphology per phase, enclosure shape), blend slider between two cultures, key params (curvature, dead ends, grid skew, row continuity, courtyard ratio). Everything serializes into the URL/share code.

## 7. References

Kostof, *The City Shaped* / *The City Assembled*; Conzen (town-plan analysis, burgage cycle); Hakim, *Arabic-Islamic Cities: Building and Planning Principles*; Bonine / Wirth on medina structure; Steinhardt, *Chinese Imperial City Planning*; Wheatley, *The Pivot of the Four Quarters*; Hein / Sorensen on jōkamachi; Volwahsen, *Living Architecture: Indian* (Vastu-Purusha Mandala); Morris, *History of Urban Form*.
