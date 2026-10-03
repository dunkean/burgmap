# Polish backlog (user feedback)

Status: [ ] open · [~] in progress · [x] done

## Urban: M4 scope (landmarks, suburbs, shanty towns)
- [x] Shanty towns look bad overall. They need a believable informal fabric: huts packed in clusters along paths, irregular sizes, tiny yards. No uniform scatter or noise.
- [x] Suburbs always hug the main road and never spread. They should thicken into real districts with secondary streets branching away from the road, cross lanes and back lanes, absorbing land between radial roads, plus absorbed villages.
- [x] Too many churches, and every church sits in a garden. Lower the density. Many parish churches stand attached to the fabric with houses against their walls and only a small parvis; a churchyard is only for some of them.
- [x] Bridges: a city crossed by a river has too few bridges.
- [x] Inaccessible buildings in dense cores.
- [x] Seams where two quarters touch without a street. (Built-over old wall lines keep a lane; at unwalled edges, quarter boundaries and lot backs, a strip of back land under ~7 m per side is given to the lots, which meet back to back.)
- [x] Castle count option; walls none / single / double.

## Cultures: next polish agent
- [x] Japanese (jōkamachi): the overall plan is nice, but some quarters are piles of rectangles. Merchant blocks need machiya rows along the street with gardens and storehouses (kura) behind. Samurai lots: walled yashiki with a garden.
- [x] Dwarven: towns are empty. Fill the terraces with halls, workshops, forges, dwellings cut into the slope, and real density. Use a mountain flank when available.
- [x] Medina: hard to read. Houses must show inner courtyards (patio holes) systematically, blank outer walls, and entrances from derbs. Souk lanes need small shop cells. Coverage stays high, but the courtyards must be visible.
- [x] Chinese: the interior of the walled city is too empty.
- [ ] General: cultures are uneven in quality. Each preset must reach the European preset's level.

## New cultures (next culture agent)

Each culture gets a `scale` range: the settlement classes it can produce. [x] `scale: { min, max }` on the ladder hamlet … megacity (culture.ts); village-only cultures become one large village up to 1.5 × their cap, beyond that a cluster of villages linked by tracks (camps/index.ts); the plan selector notes the cap.

- **Village/hamlet-only cultures.** Above their maximum population they degrade to a large village or a confederation of villages, or the UI caps the population with a note.
  - [x] **Barbarian / Germanic–Celtic–Norse village** (`barbarian`, `barbarian-celtic`, `barbarian-norse`; camps/yards.ts):
    - longhouses and byre-houses in a palisaded or ditched enclosure, with a chieftain's hall at the center;
    - sunken huts (Grubenhäuser), granaries on posts, cattle pens;
    - irregular yards, no streets, only trampled paths.
    - Variants: Viking farmstead cluster; Celtic roundhouse village in a ringfort.
  - [x] **Native North American**, three variants (`native-iroquoian`: camps/longhouses.ts, `native-plains`: camps/ring.ts, `native-pueblo`: camps/pueblo.ts):
    - *Iroquoian palisaded longhouse village*: parallel bark longhouses of 20–60 m inside a double palisade, cornfields around;
    - *Plains tipi camp*: a circle of tipis with the opening facing east, council lodge, horse herds;
    - *Pueblo*: terraced, agglutinated stone/adobe room blocks around plazas, kivas (round sunken chambers).
    
    The pueblo can scale up to a town (Taos, Chaco great houses).
  - [x] **Bantu kraal / African village** (`kraal`, camps/ring.ts): a ring of round huts around a central cattle kraal, granaries, a thorn fence.
  - [x] **Nomad camp** (`nomad-camp`, camps/ring.ts): tents in concentric circles around the chief's tent.
- **City cultures**
  - [ ] **Inca**:
    - kancha blocks (rectangular walled compounds with houses around a courtyard) on an orthogonal grid adapted to the terrain;
    - a great central plaza (haukaypata), ushnu platform, temple (Coricancha-like), fortress on the hill (Sacsayhuamán-like zigzag walls);
    - agricultural terraces on the slopes around;
    - canalized streams through the town.
  - [ ] Remaining historical presets from URBAN_MORPHOLOGY §3b, by priority: Aztec, Maya, Khmer, Byzantine, Russian kremlin, Venetian, Persian, Ottoman, Sahel, Hanseatic, Norse ring fort, Celtic oppidum, Korean.
  - [ ] Remaining fantasy presets from §3c: halfling, orcish, gnomish, stilt-town, wizard city, necropolis.

## Global settlement parameter
- [x] **Sprawl / density factor** (`sprawl` ∈ 0.5 … 2, default 1). It multiplies the extent for a given population, lowers coverage, loosens plots, makes gardens more frequent and spreads faubourgs and suburbs. Below 1 it gives a compact dense town. It must interact with the culture defaults (a medina stays dense relative to its own baseline). Expose it in the UI and the URL. (Done: `applySprawl` in morphology.ts scales densities, coverage, infill, plot sizes, blocks, gaps and courtyards per culture; faubourg share and spread; camps loosen their rows and yards. Plan panel slider, `sprawl=` in the URL, tests/urban.sprawl.test.ts.)

## Building footprints: realism, proportions, variety (all cultures)
- [x] Proportions:
  - dwellings mostly 1:1 to 1:2.2, with depth tied to the number of bays;
  - outbuildings (barns, sheds, workshops) clearly smaller and simpler;
  - landmark buildings at their true scale.
- [x] Size distribution: a long-tailed spread, from small cottages and lean-tos (25–40 m²) through standard houses (50–120 m²) to large houses and inns (150–400 m²). Use a log-normal by zone and wealth (rich near the market and main streets, poor at the edges and back lanes).
- [x] Shape variety, driven by plot and culture, never random noise:
  - L-, T- and U-plans;
  - rear wings and annexes;
  - stepped façades (jettied fronts read as small offsets);
  - chamfered or rounded corners at acute street corners;
  - gable-end vs eaves-side to the street (narrow deep vs wide shallow);
  - occasional towers or turrets on rich houses;
  - passages and carriage gates through the front range.
- [x] Façade line: mostly continuous, with small irregular jogs (±0.5–1.5 m) and occasional setbacks. Never a perfectly ruled line.
- [x] Measure it: per culture and per phase, record the histograms of area, aspect ratio and number of vertices. Compare them with target ranges taken from real cadastral samples, e.g. the Napoleonic cadastre of a French town core (median about 60–90 m², aspect about 1.3–2).

## Hydrology / site / roads
- [x] Too many brooks rising inside the map (max 1–2 springs now).

## UI
- [~] Loading bar at the top during generation; the current map stays visible.
