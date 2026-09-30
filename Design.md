# Design Document — Enhanced Medieval City Generator
**Version 0.1 — March 2026**

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Detailed Objectives and Features](#detailed-objectives-and-features)
3. [High-Level Design](#high-level-design)
4. [Generation Pipeline](#generation-pipeline)
5. [Module Specifications](#module-specifications)
   - [M1 — Terrain & World Map](#m1--terrain--world-map)
   - [M2 — Regional Layout & Settlement Placement](#m2--regional-layout--settlement-placement)
   - [M3 — City-Level Structure](#m3--city-level-structure)
   - [M4 — District Population](#m4--district-population)
   - [M5 — Building Detail & Roofscape](#m5--building-detail--roofscape)
   - [M6 — Environmental Dressing](#m6--environmental-dressing)
6. [Cultural Style System](#cultural-style-system)
7. [Data Model & Inter-Module Contract](#data-model--inter-module-contract)
8. [UI/UX Specifications](#uiux-specifications)
9. [Rendering Architecture](#rendering-architecture)
10. [Technology Recommendations](#technology-recommendations)
11. [Migration Strategy from Current Codebase](#migration-strategy-from-current-codebase)
12. [Testing Strategy](#testing-strategy)
13. [Recommendations](#recommendations)
14. [Design Decisions](#design-decisions)

---

## Executive Summary

The current project (port of watabou's TownGeneratorOS) produces a convincing single-city SVG map from a Voronoi diagram and a set of toggles. It covers approximately 25% of the desired feature space: it has no terrain, no regional context, no cultural styles, no resource-driven logic, and no multi-layer geographic constraints.

This document specifies an ambitious but tractable extension: a **six-stage generative pipeline** that goes from raw terrain noise all the way to detailed building roofscapes and environmental dressing, all driven by geographic constraints, resource availability, and a configurable cultural style. Each stage is a **self-contained, independently runnable module** with its own editor view. Modules communicate through a well-defined JSON data contract, so any stage can be mocked, replaced, or iterated without touching the others.

The primary deliverable is an interactive browser-based application built on Canvas 2D with vanilla JavaScript. The Python backend is retained for heavy geometry/generation work; the frontend handles all interaction, editing, and rendering.

---

## Detailed Objectives and Features

### Core Goal
Generate a plausible, stylistically coherent medieval agglomeration — from a single isolated hamlet to a walled capital city — situated in a believable geographic context with visible resource logic.

### Feature Areas

#### Geographic Constraints
- **Elevation map** with mountains, hills, plateaus, valleys, plains
- **Hydrography**: rivers (source → sea), lakes, ponds, estuaries
- **Coastlines** and **islands**
- **Biome zones**: desert, steppe, taiga, temperate forest, jungle, tundra, alpine
- **Resource nodes**: arable land, timber, stone quarries, iron/ore deposits, fishing grounds, trade routes

#### Settlement Types & Scale
- **Hamlet** (3–8 buildings, informal cluster, no walls)
- **Village** (10–30 buildings, central well/church, possible palisade)
- **Town** (50–200 buildings, market, guildhall, small castle or keep)
- **City** (200–1000+ buildings, cathedral, full walls, multiple districts)
- **Agglomeration** (1 main city + surrounding hamlets/villages as satellites) — primary target

> The tool is scoped to a single agglomeration: one main city and its immediate satellite settlements. A regional map showing two or more full cities is out of scope. Hamlet and village generation uses a **fast path** (see below) that bypasses M2 and goes directly to a countryside-oriented single-district output.

#### Cultural Styles
Seven distinct styles with separate rule sets for street patterns, building typology, landmark preferences, material palettes, and wall types:
1. **European Medieval** (Norman/Gothic)
2. **Arabic / Islamic**
3. **East Asian** (Tang/Song dynasty Chinese)
4. **Mongol / Steppe Nomadic**
5. **Viking / Norse**
6. **Classic Antiquity** (Roman/Greek)
7. **Generic / Fantasy** (current default, no historical model)

#### District System
- Each Voronoi cell is a **district** with a type, sub-type, and style parameters
- District types span civic, residential, commercial, industrial, religious, military, agricultural, wild
- Districts have adjacency rules (a slum doesn't border a patriciate quarter without a buffer)
- District geometry adapts to terrain slope

#### Building Variety
- Per-style building typologies (courtyard house, longhouse, insula, ger, etc.)
- Procedural facades (windows, doors, balconies) as SVG detail layer
- Roof varieties: pitched, hipped, flat, vaulted, domed, pagoda, thatched
- Landmark buildings: cathedral, mosque, pagoda, forum, stave church, stepped pyramid, bathhouse, bazaar, caravanserai, belltower

#### Environmental Dressing
- Forest zones (tree placement with density variation)
- Agricultural plots (strip fields, paddy, terraces on slopes)
- Orchards, vineyards, market gardens
- Roads outside city: track, path, cobblestone, paved highway
- Wells, fountains, shrines along roads
- Harbor and dock infrastructure

#### Independent Module Development
Every module runs standalone with:
- Its own HTML page (`/tools/<module-name>/`)
- Mock data generator (if upstream data is absent)
- JSON export/import
- Full UI with all controls for that stage

---

## High-Level Design

### Pipeline Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  M1: Terrain & World Map                                             │
│  Noise → elevation, moisture, temperature, biome, resources         │
│  Output: WorldMap JSON (grid of cells)                               │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│  M2: Regional Layout                                                 │
│  Settlement placement, inter-city road network (A* over terrain)    │
│  Output: Region JSON (settlements, roads, POIs)                     │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ (pick one settlement to expand)
┌──────────────────────────▼──────────────────────────────────────────┐
│  M3: City Structure                                                  │
│  Voronoi districts, walls, gates, major streets, landmark sites     │
│  Output: CityMap JSON (districts, streets, landmarks, boundary)     │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│  M4: District Population                                             │
│  Sub-divide each district → building footprints, alleys             │
│  Output: CityMap JSON + buildings list per district                  │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│  M5: Building Detail                                                 │
│  Roof geometry, facade details, annex structures, courtyards        │
│  Output: CityMap JSON + roof/facade data per building                │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│  M6: Environmental Dressing                                          │
│  Trees, fields, gardens, street furniture, harbors                  │
│  Output: Final CityMap JSON (all layers)                             │
└─────────────────────────────────────────────────────────────────────┘
```

### Architectural Principles

1. **Module independence**: Each module can be opened at `localhost:9000/tools/m1/`, etc. If no upstream JSON is provided, mock data is generated automatically.
2. **Immutable stage outputs**: Each module produces a JSON snapshot. Running a module again replaces only its own layer — downstream stages can be recomputed or kept frozen.
3. **Style as a parameter, not a mode**: Cultural style is a JSON object passed down the pipeline. Any module can read style fields relevant to it; unknown fields are ignored.
4. **Terrain-aware geometry everywhere**: Every stage with geographic logic (roads, walls, building orientation) receives and responds to elevation/terrain data.
5. **Progressive refinement**: The pipeline can stop at any stage and produce a valid (partial) output. A M1+M3 run should produce a stylized map; adding M5+M6 simply enriches it.
6. **Zero external JavaScript dependencies**: Vanilla JS + Canvas 2D. SVG export for print quality.

---

## Generation Pipeline

### Stage Responsibility Matrix

| Stage | Inputs | Outputs | Can run standalone? |
|---|---|---|---|
| M1 Terrain | seed, noise params, map size | WorldMap JSON | **Yes** — seeds from params |
| M2 Regional | WorldMap JSON, style, n_settlements | Region JSON | **Yes** — mock flat terrain |
| M3 City | Region JSON (one settlement), style | CityMap JSON (districts, streets) | **Yes** — mock region entry |
| M4 Districts | CityMap JSON, style | CityMap JSON + buildings | **Yes** — mock city outline |
| M5 Detail | CityMap JSON + buildings, style | CityMap JSON + roofs/facades | **Yes** — mock building footprints |
| M6 Dressing | CityMap JSON (full), WorldMap fragment, style | Final output JSON | **Yes** — mock city boundary |

### Data Flow in Tightly-Coupled Mode (Full Pipeline)
The full pipeline runs sequentially. A `Pipeline` controller holds each stage's output and can selectively re-run any single stage and then propagate downstream changes. "Freeze" flags on individual stages prevent downstream propagation.

### Data Flow in Module Mode (Independent Development)
Each module has a `MockDataGenerator` class that produces plausible input data without upstream stages. This is used for:
- Developing and testing a module early
- Demoing a single stage
- Unit testing

### Small-Settlement Fast Path

Hamlet and village generation bypasses the full M1–M6 pipeline. They use a dedicated single-district workflow:

```
style + seed + settlement_type
        │
        ▼
  (skip M1, M2, M3 multi-district layout)
        │
        ▼
  SinglePatchGenerator   ← one polygon, no walls, 3–30 buildings
        │
        ▼
  M4 variant: countryside populator
  (farmhouses, longhouses, or ger clusters depending on style)
        │
        ▼
  M6 light dressing: fields, trees, well, shrine
```

This produces a **countryside scene** — an isolated farmstead, hamlet, or small village — not a city. It has its own UI entry point (`/tools/hamlet/`) and its own export format. Satellite settlements in the agglomeration view are rendered using this fast path at reduced detail.

---

## Module Specifications

---

### M1 — Terrain & World Map

**Purpose**: Produce the geographic substrate everything else is built on.

**Standalone URL**: `/tools/terrain/`

#### Algorithms

**Elevation**
- Multi-octave Simplex noise (6 octaves, lacunarity 2.0, persistence 0.5)
- Optional island mask: radial falloff centered on map to guarantee coastline
- Continental shelf: sub-zero area = ocean; shallow shelf gradient near coast

> **Note**: This module is a placeholder for early-stage city generation. It will eventually be replaced by importing a tile from a dedicated world-builder project. Keep terrain generation simple and noise-based — no hydraulic erosion.

**Moisture**
- Independent Simplex noise layer
- Modified by elevation (rain shadow on mountain downwind side — configurable wind direction)
- Rivers increase local moisture along their banks

**Temperature**
- Latitude gradient (top = cold, bottom = warm) + elevation modifier (–6°C per 1000m equivalent)
- Used for biome classification

**Biome Classification** (Whittaker diagram approximation)
```
temperature × moisture grid:
  hot + wet       → Tropical Forest / Jungle
  hot + dry       → Desert / Savanna
  temperate + wet → Temperate Forest / Rainforest
  temperate + dry → Steppe / Shrubland
  cold + wet      → Taiga / Boreal Forest
  cold + dry      → Tundra
  very cold       → Alpine / Permanent Snow
  below sea level → Ocean / Lake
```

**Hydrography**
- River tracing: from local elevation maxima (peaks), trace steepest-descent path; merge tributaries; widen near sea
- Lake placement: local minima in elevation below a threshold
- Estuary: river + coast proximity → widen final segment

**Resource Layer**
Resources are derivative of biome + elevation:
| Resource | Biome / Condition |
|---|---|
| Arable Land | Flat temperate, near river |
| Timber | Forest biome, non-alpine |
| Stone | Rocky hillside, mountain foot |
| Iron Ore | Mountain, rocky hills |
| Gold/Silver | High mountain, specific noise threshold |
| Fish | Coast, lake, river segments |
| Trade Node | Road/river crossings |

**Output (WorldMap JSON)**
```json
{
  "size": [256, 256],
  "cell_size": 4,
  "seed": 42,
  "elevation": [[0.0, ...], ...],
  "moisture": [[0.0, ...], ...],
  "temperature": [[0.0, ...], ...],
  "biome": [["temperate_forest", ...], ...],
  "resources": [
    {"type": "timber", "x": 45, "y": 32, "abundance": 0.8},
    ...
  ],
  "rivers": [
    {"points": [[x, y], ...], "width": [1.0, 1.2, ...]}
  ],
  "coastline": [[x, y], ...]
}
```

#### UI Controls (M1 Editor)
- **Map Size**: 64/128/256/512 grid (dropdown)
- **Seed** (number input)
- **Noise Scale** (0.5–4.0, slider) — coarser/finer terrain features
- **Octaves** (2–8) and **Persistence** (0.3–0.8)
- **Island Mode** toggle — forces radial sea boundary
- **Wind Direction** (0–360°)
- **Sea Level** threshold slider
- **River Count** (0–20)
- **Resource Density** (slider)
- **Biome panel**: display identified biome areas with color key
- Canvas with layer toggles: Elevation | Moisture | Temperature | Biome | Resources | Rivers

#### Visualization Layers
| Layer | Visual |
|---|---|
| Elevation | Grayscale heightmap or hypsometric tints |
| Biome | Color-coded biome zones |
| Moisture | Blue gradient overlay |
| Resources | Colored icon markers (lumber icon, pick icon, etc.) |
| Rivers | Blue lines with width |
| Coastline | Dark outline |

---

### M2 — Regional Layout & Settlement Placement

**Purpose**: Place settlements in geographically motivated positions, connect them with roads, derive their scale and character from local resources.

**Standalone URL**: `/tools/region/`

#### Settlement Placement Logic

**Site scoring function** for candidate cells:
```
score = (flatness × 0.3)
      + (water_proximity × 0.25)      # within 15 cells of river/coast
      + (resource_abundance × 0.25)   # sum of resource values in radius 20
      + (defensibility × 0.10)        # elevated, preferably hilltop
      + (existing_road_proximity × 0.10)  # if roads already placed
      - (already_settled_penalty)     # distance from existing settlements
```

**Settlement size determination** (based on resource score):
```
score < 0.2  → Hamlet
score < 0.4  → Village
score < 0.6  → Town
score < 0.8  → City
score >= 0.8 → Capital
```

**Settlement type specializations** (dominant resource within radius):
- Timber dominant → Logging town (sawmills, woodworkers)
- Arable dominant → Agricultural town / Market town
- Stone/Iron dominant → Mining town / Smithy town
- Coast/Fish dominant → Fishing port
- Trade node → Merchant city
- Hilltop + defensible → Military garrison / Castle town

**Inter-Settlement Roads (Least-Cost A*)**

Cost function per terrain step:
```
move_cost = base_distance
          × slope_penalty(Δelevation)    # ×4 per 45°, avoid >60° slopes
          × river_crossing_penalty(here) # ×8 at river (bridge needed)
          × biome_penalty(biome)         # desert/mountain ×1.5, flat ×1.0
```

Road output is **fully vectorized**: the A* path on the grid is post-processed by Chaikin smoothing + Douglas–Peucker simplification to produce clean polylines with natural curves, not staircase grid artifacts. This is the priority — use whatever grid resolution and routing method is needed to achieve convincing, smooth road geometry quickly.

Road types by importance:
- **Highway**: connects cities and towns, typically straighter
- **Trade Road**: connects towns, follows terrain more
- **Track**: connects villages and hamlets, highly tortuous
- **Mountain Pass**: specific steep crossing path (marked separately)

**Output (Region JSON)**
```json
{
  "world_map_ref": "worldmap_seed42.json",
  "settlements": [
    {
      "id": "s1",
      "x": 120, "y": 85,
      "type": "city",
      "size": 42,
      "specialization": "merchant",
      "style": "european_medieval",
      "features": {
        "has_walls": true,
        "has_castle": true,
        "has_harbor": false,
        "dominant_resource": "trade"
      }
    }
  ],
  "roads": [
    {"from": "s1", "to": "s2", "type": "highway", "path": [[x,y],...]}
  ],
  "bridges": [
    {"pos": [x, y], "road_ref": "road_0"}
  ],
  "mountain_passes": [...]
}
```

#### UI Controls (M2 Editor)
- **WorldMap import** (file picker or use M1 output)
- **Agglomeration mode**: 1 main settlement (city/town) + 0–8 satellite hamlets/villages
- **Forced placements**: drag-drop settlements onto map
- **Style override**: assign cultural style per settlement (or global default)
- **Road generation** toggle
- **Candidate heatmap** overlay (show site scoring)
- Click settlement → detail panel (type, specialization, edit label)
- Drag settlement → recompute roads

#### Visualization Layers
| Layer | Visual |
|---|---|
| Terrain (base) | Biome shading or elevation tints |
| Settlements | Colored icons by type (hamlet=dot, village=small square, etc.) |
| Roads | Lines with stroke weight by road type |
| Bridges | Perpendicular bar at river crossings |
| Resources | Subtle icon markers |
| Score Heatmap | Transparent gradient (candidate site attractiveness) |
| Influence Zones | Voronoi of settlement influence radii |

---

### M3 — City-Level Structure

**Purpose**: Take a single settlement entry from M2 (or mock data) and generate its internal structure: districts, walls, gates, primary streets, and landmark sites. This is the stage closest to the current TownGeneratorOS core.

**Standalone URL**: `/tools/city/`

**Key enhancements over current implementation:**
- Terrain-deformed Voronoi (districts follow elevation contours)
- Landmark site allocation driven by resources and style
- Cultural style drives street pattern (grid/organic/radial/labyrinthine)
- District adjacency rules enforced during assignment
- Exterior road continuity with regional roads from M2

#### Terrain-Aware Voronoi
Seeds for Voronoi generation are biased by the terrain subsection:
- Denser seeds on flat areas (easier to build)
- Sparser seeds on steep terrain
- **Rivers as forced seed lines**: river banks are inserted as explicit Voronoi generator points before the main diagram is computed, so no Voronoi edge crosses a river without a bridge. Upgrade to Constrained Delaunay Triangulation only if degenerate thin cells prove problematic in practice.
- Voronoi relaxation (Lloyd's) is weighted by terrain flatness

#### Street Pattern Modes (by Style)
| Style | Pattern | Description |
|---|---|---|
| European Medieval | Organic | Radial from center, irregular blocks |
| Arabic/Islamic | Labyrinthine | Nested irregular courts, few through-roads |
| East Asian | Grid | Regular grid, cardinal axes |
| Roman | Orthogonal | Strict cardo/decumanus grid with forum |
| Norse | Cluster | Organic harbor-centric clusters |
| Mongol | Open | No fixed streets, open space between ger clusters |
| Generic | Organic | Current TownGeneratorOS default |

#### Landmark Site Allocation
Landmarks are placed as explicit Voronoi seeds before general district generation:

| Landmark | Placement Rule |
|---|---|
| Castle / Keep | Highest elevation within city boundary |
| Cathedral / Temple | Central, adjacent to market |
| Market / Bazaar | Centroid of inner city, road intersection |
| Docks | At riverbank or coastline |
| Forum / Plaza | Geometric center |
| Citadel | Extreme edge, defensible |
| Mill | Near river (watermill) |
| Baths / Hammam | Central, near water supply |
| Granary | Near gate, ground level |
| Arsenal / Armory | Near citadel/military ward |

#### District Type Assignment
Assignment proceeds in concentric priority rings:

**Ring 0 — Civic Core** (innermost 1–3 patches):
- Plaza / Market / Forum

**Ring 1 — Elite / Sacred** (adjacent to core):
- Cathedral / Temple / Mosque / Pagoda
- Administration / Palace Quarter
- Patriciate / Nobility Quarter

**Ring 2 — Commercial** (along major roads):
- Merchant Quarter
- Bazaar / Market Street
- Caravanserai (if trade specialization)

**Ring 3 — Residential / Production** (middle city):
- Craftsmen / Artisan districts (multiple, by craft type)
- Military Precinct
- Slum / Poor Quarter

**Ring 4 — Periphery** (near walls or unenclosed):
- Gate Ward
- Tannery / Noxious Trades (downwind, near water)
- Shanty Town (outside walls)
- Park / Green Space
- Harbor (if coastal/river)

#### Wall System
- Walls follow district boundary (current behavior retained)
- Barbican gate enhancement: gate ward → gate complex geometry
- Towers at regular intervals (not just vertices)
- Multi-ring walls for large cities (inner citadel wall + outer city wall)
- Style-specific wall types: stone (European), packed earth (Eastern/Mongol), wooden palisade (Norse/Village), no wall (Mongol)

#### Output (CityMap JSON — structural layer)
```json
{
  "settlement_ref": "s1",
  "seed": 42,
  "style": "european_medieval",
  "bounds": {"cx": 0, "cy": 0, "radius": 300},
  "terrain_fragment": {...},
  "districts": [
    {
      "id": "d0",
      "type": "market",
      "sub_type": "main_plaza",
      "polygon": [[x,y],...],
      "center": [x, y],
      "elevation": 0.45,
      "within_walls": true,
      "adjacent": ["d1","d2","d3"],
      "landmark": "market_square"
    }
  ],
  "streets": [
    {"type": "artery", "points": [[x,y],...], "width": 4.0},
    {"type": "ring_road", "points": [[x,y],...], "width": 3.0}
  ],
  "walls": [
    {"polygon": [[x,y],...], "type": "stone", "towers": [[x,y],...], "gates": [...]}
  ],
  "landmarks": [
    {"type": "castle", "district_id": "d14", "centroid": [x, y]}
  ],
  "rivers": [...],
  "coastline": [...]
}
```

#### UI Controls (M3 Editor)
- **Settlement import** (from M2 or manual entry)
- **Seed**, **City Size** (patches count), **Style** selector
- **Landmark overrides**: toggle each landmark type on/off/forced
- **Wall type**: None / Palisade / Stone / Multi-ring
- **Road style**: Organic / Labyrinthine / Grid / Radial
- **District count** (5–80)
- Map view with:
  - Selectable districts (click → edit type)
  - Drag district centers
  - Toggle walls/roads/landmarks overlays
- **Export JSON** button

---

### M4 — District Population

**Purpose**: For each district, subdivide its polygon into building footprints and alleys using style-appropriate algorithms. This is the most complex stage and the one with the most algorithmic variety.

**Standalone URL**: `/tools/district/`

**Can load a single district polygon** for focused development.

#### Algorithm Registry (per district type × style)

Each combination of district type and cultural style maps to a **populator**: a function `(DistrictPolygon, StyleParams, ResourceContext) → [BuildingFootprint]`.

| Populator | When used | Algorithm |
|---|---|---|
| `GridPopulator` | Roman, East Asian residential | Cardo/decumanus subdivision → insula blocks |
| `OrganicAlleyPopulator` | European medieval, craftsmen | Current `create_alleys` recursive bisection |
| `CourtyardPopulator` | Arabic, East Asian noble | Courtyard inset → outer ring buildings |
| `LonghousePopulator` | Norse | Central longhouse + outbuildings radially |
| `GerClusterPopulator` | Mongol | Random disk packing of circular ger footprints |
| `InsulaPopulator` | Roman residential | Rectangular block → row houses with shared walls |
| `BazaarPopulator` | Arabic commercial | Narrow alleys + stalls along walls |
| `MonasticPopulator` | Cathedral / Monastery campus | Cloister quad + chapel + refectory |
| `HarborPopulator` | Dock district | Quay wall + berths + warehouses |
| `ParkPopulator` | Green space | Tree positions + paths (current park behavior) |
| `FarmPlotPopulator` | Agriculture | Strip fields + farmhouse cluster |
| `MilitaryPopulator` | Barracks, garrison | Regular grid of long buildings + parade ground |
| `PalacePopulator` | Palace/Noble compound | Walled compound + inner court + wings |

#### Core Subdivision Algorithms

**RecursiveBisectionPopulator** (generalizes current `create_alleys`):
- Input: polygon, min building area, orientation chaos, size chaos, empty probability
- Recursively splits polygon along short axis (or random if chaos > threshold)
- Split is offset randomly away from midpoint by `size_chaos × half-width`
- Terminates when area < min building area
- Configurable street widths at each recursion depth

**CourtyardSubdivision** (new):
- Inset polygon by courtyard width → inner courtyard
- Outer ring divided into building cells by radial cuts
- Building cells optionally subdivided further
- Optional covered gallery (rotationally symmetric overhang)

**IslamicLabyrinthSubdivision** (new):
- Non-planar street hierarchy: public artery → semi-public lane → private cul-de-sac
- Cul-de-sac dead ends terminate in single-family compounds
- Block boundaries are irregular, house orientation follows local lane direction

**DiskPackingPopulator** (new, for Mongol ger clusters):
- Place disks of radius 8–16 randomly within polygon
- Min-distance between disks enforced
- Each disk = one ger footprint (rendered as circle)

#### Building Style Modifiers (applied post-footprint, pre-geometry)
Applied by M5 but computed here as metadata:
- **L-shape notch** (current 35% chance) — kept, extended to other styles
- **Courtyard well** — small inset square, central, for courtyard houses
- **Stacked offset** — narrow upper floor inset (East Asian)
- **Arcade** — ground floor wider than upper floors (Roman)

#### Output additions to CityMap JSON
```json
{
  "districts": [
    {
      "id": "d0",
      "buildings": [
        {
          "id": "b0",
          "footprint": [[x,y],...],
          "type": "house",
          "sub_type": "courtyard",
          "stories": 2,
          "style_hints": {"has_courtyard": true, "arcade": false}
        }
      ],
      "alleys": [
        {"points": [[x,y],...], "width": 2.0}
      ]
    }
  ]
}
```

#### UI Controls (M4 Editor)
- **CityMap JSON import** or **single district mode** (paste polygon)
- **District selector** (list + click on map)
- **Populator override** (force a specific populator for selected district)
- **Min building area** (slider per district type)
- **Chaos** (alignment disorder, 0.0–1.0)
- **Density** (0.0 sparse → 1.0 dense)
- **Empty lot probability** (0–30%)
- **Show alley widths** toggle
- **Per-building click** → show footprint attributes
- Preview panel shows isolated district with labeled buildings

---

### M5 — Building Detail & Roofscape

**Purpose**: Add 3D-implied geometry to flat footprints: roofs (as top-view polygon projections), facade detail markers, annex structures.

**Standalone URL**: `/tools/building/`

**Note**: This module produces 2D top-view geometry implying 3D — it is NOT a 3D renderer. Roofs are drawn as projected trapezoids/polygons in plan view, similar to how watabou's other tools (like his building generator) handle it.

#### Roof Types (Top-View Plan Projection)

| Roof Type | Visual (plan) | Used by Style |
|---|---|---|
| Gabled pitched | Ridge line + inset triangular ends | European, Norse |
| Hipped | All sides slope → inner polygon offset | European, Roman, Asian |
| Flat | No roof symbol (just footprint edge) | Arabic, Mongol |
| Domed | Circle inscribed in footprint | Arabic, Byzantine |
| Pagoda | Stepped concentric polygons with bracket marks | East Asian |
| Thatched | Hatched fill pattern on hipped shape | Village, Norse |
| Conical | Circle → apex point mark | Tower, keep turret |
| Vaulted (barrel) | Parallel lines along long axis | Roman, Islamic |

Roof geometry is derived from footprint:
1. Compute footprint medial axis (or approximate via inset polygon series)
2. Select ridge points from medial axis
3. Generate roof polygon from eave edge + ridge points
4. Overhang: offset footprint outward by style-dependent eave depth

#### Facade Detail System
Facade details are added as SVG decoration groups within building polygons:
- **Windows**: evenly spaced small rectangles on long walls
- **Door**: centered gap/marker on street-facing edge
- **Chimney**: small rectangle offset from ridge, smoke-smudge optional
- **Balcony**: narrow rectangle overhanging outer wall
- **Buttress**: small perpendicular projections at intervals (Gothic)
- **Minaret / Tower**: attached cylinder at one corner

Placement logic: identify street-facing edge (nearest alley centerline), place door there; place windows on all edges visible from alley except blank walls.

#### Output additions to CityMap JSON
```json
{
  "buildings": [
    {
      "id": "b0",
      "roof": {
        "type": "hipped",
        "polygon": [[x,y],...],
        "ridge_polygon": [[x,y],...],
        "overhang": 0.5
      },
      "facade_details": [
        {"type": "window", "pos": [x,y], "orientation": 90},
        {"type": "door", "pos": [x,y], "orientation": 0}
      ]
    }
  ]
}
```

#### UI Controls (M5 Editor)
- **Building JSON import** or **single footprint mode**
- **Roof type override** (global or per building selection)
- **Overhang** depth (0.0–2.0)
- **Facade detail density** (0=none, 1=sparse, 2=rich)
- **Style preset** (auto-selects roof type + details from style)
- Click building on canvas → detail panel (select roof type, toggle details)
- Side-by-side view: footprint only vs with roof

---

### M6 — Environmental Dressing

**Purpose**: Populate non-built space with vegetation, fields, water features, street furniture, and extra geographic features.

**Standalone URL**: `/tools/dressing/`

#### Vegetation

**Forest Stands** (outside city, from WorldMap biome):
- Clusters of tree symbols: circle-dot (broadleaf), triangle (conifer)
- Density varies with biome and proximity to city (clearings near settlements)
- Tree placement: Poisson disk sampling within biome zone, min distance 5–8 units

**City Trees**:
- Park districts: regular or scattered tree placement (current behavior extended)
- Street trees: evenly spaced along major arteries (style-dependent)
- Courtyard gardens: small shrub symbols inside courtyard bounds

#### Agricultural Plots

**Strip Fields** (European):
- Rectangular strips radiating from settlement along roads
- Width 8–15, length 40–120
- Alternating fallow/crop fill patterns

**Paddy Fields** (East Asian):
- Irregular terraced polygons on gentle slopes
- Concentric contour approximation for stepped appearance

**Desert Gardens** (Arabic):
- Small walled enclosures (qanats implied by dotted lines)

**Orchards / Vineyards**:
- Regular grid of small tree symbols in rectangular plots

#### Water Features
- **Wells**: circle symbol at road intersections or courtyards
- **Fountains**: decorative circle-in-square at plaza/forum
- **Mill Race / Leat**: dashed line from river → mill building
- **Harbor / Quay**: solid line along waterfront; pier lines perpendicular into water
- **Fish Traps / Weirs**: angular lines across river in fishing villages

#### Street Furniture
- **Market stalls**: small rectangle clusters in market district
- **Shrines / Wayside crosses**: small symbol along roads at intervals
- **Gallows / Stocks**: near gate ward or market (grim medieval flavor)
- **Siege equipment storage**: near military ward

#### Output additions to CityMap JSON
```json
{
  "environment": {
    "trees": [{"x": x, "y": y, "type": "broadleaf", "radius": 4}],
    "fields": [{"polygon": [...], "type": "strip_field"}],
    "water_features": [{"type": "well", "pos": [x, y]}],
    "street_furniture": [{"type": "shrine", "pos": [x, y]}]
  }
}
```

#### UI Controls (M6 Editor)
- **Forest density** (0–1 slider)
- **Agricultural zone radius** (in city-radii units)
- **Field type** (strip / paddy / orchard — follows style default)
- **Tree style** (broadleaf / conifer / palm / bamboo)
- **Water features** toggle list
- **Street furniture** toggle list
- Layer toggles for each category in canvas view

---

## Cultural Style System

The style system is a JSON descriptor object that is threaded through all stages M2–M6. Each module reads only the fields relevant to it.

### Style Descriptor Schema
```json
{
  "id": "arabic",
  "name": "Arabic / Islamic",
  "street_pattern": "labyrinthine",
  "wall_type": "mud_brick",
  "wall_probability": 0.9,
  "gate_style": "barbican",
  "dominant_landmark": "mosque",
  "landmark_priorities": ["mosque", "bazaar", "caravanserai", "hammam"],
  "district_palette": {
    "residential": "courtyard",
    "commercial": "bazaar",
    "religious": "mosque_complex",
    "military": "citadel"
  },
  "building_populator": "courtyard",
  "roof_type": "flat",
  "facade_detail_level": "moderate",
  "colors": {
    "paper": "#E8D9C0",
    "building_fill": "#C8B48A",
    "building_stroke": "#6B4F30",
    "road": "#B8A882",
    "water": "#4A7A9B"
  },
  "field_type": "garden_walled",
  "tree_type": "palm",
  "settlement_size_bias": 1.2,
  "defensibility_weight": 0.2
}
```

### Pre-Defined Styles

| Style ID | Street Pattern | Wall Type | Landmark | Populator | Roof |
|---|---|---|---|---|---|
| `european_medieval` | organic | stone | cathedral | organic_alley | gabled |
| `arabic` | labyrinthine | mud_brick | mosque | courtyard | flat |
| `east_asian` | grid | stone/earth | pagoda | grid | hipped/pagoda |
| `mongol` | open | earthen/none | shrine | ger_cluster | none |
| `viking` | cluster | palisade | stave_church | longhouse | thatched |
| `roman` | orthogonal | stone | forum | insular | hipped |
| `generic` | organic | variable | castle | organic_alley | hipped |

### Style Inheritance
Styles can inherit from a base style and override specific fields:
```json
{
  "id": "moorish",
  "extends": "arabic",
  "colors": { "paper": "#F0E8D0" },
  "dominant_landmark": "alcazar"
}
```

User-defined styles are serializable to JSON and can be exported/imported via the standard export panel.

---

## Data Model & Inter-Module Contract

### WorldMap JSON Schema
```typescript
interface WorldMap {
  size: [number, number];          // grid dimensions [cols, rows]
  cell_size: number;               // real-world units per cell
  seed: number;
  elevation: number[][];           // 0.0–1.0
  moisture: number[][];
  temperature: number[][];
  biome: string[][];
  resources: ResourceNode[];
  rivers: River[];
  coastline: Point[];
}
```

### Region JSON Schema
```typescript
interface Region {
  world_map_ref: string;
  settlements: Settlement[];
  roads: Road[];
  bridges: Bridge[];
}
interface Settlement {
  id: string;
  x: number; y: number;
  type: "hamlet" | "village" | "town" | "city" | "capital";
  size: number;
  specialization: string;
  style: string;           // style id
  features: SettlementFeatures;
}
```

### CityMap JSON Schema (grows through M3–M6)
```typescript
interface CityMap {
  settlement_ref: string;
  seed: number;
  style: string;
  bounds: Bounds;
  terrain_fragment: TerrainFragment;
  districts: District[];
  streets: Street[];
  walls: Wall[];
  landmarks: Landmark[];
  rivers: River[];
  coastline: Point[];
  environment?: Environment;        // added by M6
}
interface District {
  id: string;
  type: DistrictType;
  sub_type: string;
  polygon: Point[];
  center: Point;
  elevation: number;
  within_walls: boolean;
  adjacent: string[];
  landmark?: string;
  buildings?: Building[];           // added by M4
  alleys?: Alley[];
}
interface Building {
  id: string;
  footprint: Point[];
  type: string;
  stories: number;
  style_hints: Record<string, unknown>;
  roof?: RoofGeometry;              // added by M5
  facade_details?: FacadeDetail[];
}
```

### Module Bridge Protocol
Each module exposes:
```javascript
class ModuleN {
  static name = "terrain";          // url slug
  static inputSchema = "WorldMap";  // or null if standalone
  static outputSchema = "WorldMap";

  constructor(container, options) {}
  loadData(json) {}                  // import previous stage
  generateMock() {}                  // standalone mock
  generate(params) {}                // run the algorithm
  exportData() { return json; }      // export for next stage
  getCanvas() { return canvas; }     // main visual output
}
```

The **Pipeline Controller** (`pipeline.js`) knows all modules in order, passes `exportData()` output from stage N as `loadData()` input to stage N+1, and exposes a `regenerate(fromStage)` method.

---

## UI/UX Specifications

### Primary Interface Layout

```
┌────────────────────────────────────────────────────────────────────┐
│  HEADER: "City Generator" | Stage tabs [M1][M2][M3][M4][M5][M6]   │
│          | Full Pipeline button | Export button | Style selector   │
├────────────────────────────────────────────────────────────────────┤
│  SIDEBAR (320px) │          MAIN CANVAS (flex, fills remainder)    │
│                  │                                                  │
│  [Current stage  │    ┌────────────────────────────────────────┐   │
│   controls]      │    │                                        │   │
│                  │    │             Canvas output               │   │
│  ─────────────── │    │        (zoom/pan/interact)             │   │
│  [Stage pipeline │    │                                        │   │
│   status list]   │    └────────────────────────────────────────┘   │
│                  │                                                  │
│  ─────────────── │  STATUS BAR: generation time | seed | size     │
│  [Layer toggles] │                                                  │
└────────────────────────────────────────────────────────────────────┘
```

### Stage Tabs
Each tab loads its module's UI in the sidebar and its canvas view in the main area. Stage tabs have status indicators:
- Gray: not yet run
- Yellow: running
- Green: complete
- Red: failed / needs rerun
- Lock icon: frozen (won't be overwritten by upstream rerun)

### Sidebar Organization (per stage)

**Section: Parameters**
All generation parameters with appropriate input types (sliders, number inputs, selects, tri-state toggles). Grouped by category with collapsible sections.

**Section: Actions**
- **[Re]Generate** button (primary)
- **Apply** button (when editing by hand)
- **Reset to Default** link

**Section: Stage Status**
- Last run: seed used, time elapsed
- "Freeze" checkbox
- Link to import JSON / export JSON

### Canvas Interactions (shared across all modules)

| Interaction | Effect |
|---|---|
| Mouse wheel | Zoom in/out toward cursor |
| Left drag | Pan |
| Right click | Context menu (if applicable) |
| Click element | Select / show properties in sidebar |
| Hover element | Tooltip with type/ID |
| Shift+Click | Multi-select |
| Escape | Deselect |
| Ctrl+Z | Undo last manual edit |

### Layer Toggle Panel

Each module has a list of toggleable visual layers. Common layers across all stages:
- **Grid** (terrain grid reference)
- **Elevation** (shaded relief overlay)
- **Labels** (district names, landmark labels)
- **Debug** (polygon IDs, Voronoi edges, graph edges)

Module-specific layers listed in module sections above.

### Export / Import Flows

**Export panel** (accessible from header):
- SVG (full resolution, current view or full-extent)
- PNG (at selected DPI: 72/150/300)
- JSON (any individual stage or all stages bundled)
- Print preset: A3/A4/Letter at 300 DPI

**Import panel**:
- Drag-drop JSON file onto canvas
- URL parameter `?data=<url>` loads remote JSON
- Paste raw JSON in text area

### Keyboard Shortcuts
| Key | Action |
|---|---|
| `G` | Generate (current module) |
| `F` | Toggle freeze current stage |
| `1`–`6` | Switch to module 1–6 |
| `Space` | Reset zoom |
| `L` | Toggle labels |
| `D` | Toggle debug overlay |
| `E` | Export SVG |
| `Ctrl+Z` | Undo |

### Mobile / Tablet Consideration
The tool is primarily desktop. However:
- Canvas should be touch-scrollable (pinch zoom, two-finger pan)
- Sidebar collapses to a bottom sheet on narrow viewports
- Critical controls (Seed, Generate) remain accessible on mobile

---

## Rendering Architecture

### Layered Canvas System

Replace the current single SVG with a **layered Canvas 2D rendering** system. Each layer is a separate `<canvas>` element overlaid in a CSS stack:

```
Layer 0: Terrain (rarely redrawn)
Layer 1: Geographic (rivers, coast, forests)
Layer 2: Infrastructure (roads, walls, bridges)
Layer 3: Districts (patch fills, building footprints)
Layer 4: Buildings (roof geometry, facades)
Layer 5: Details (trees, street furniture, fields)
Layer 6: UI (selection highlight, hover, labels, debug)
```

Layers are z-stacked via CSS `position: absolute`. Each layer is only redrawn when its data changes. This allows fast interactive editing (e.g., moving a district center redraws only layer 3+, not the terrain).

### SVG Export (High Quality)
SVG export is generated on demand by serializing all canvas layers into a single SVG document with proper grouping (`g` elements per layer, `title` on each group). Buildings and landmarks get `id` attributes for post-processing in vector editors.

### Rendering per Cultural Style
Each style defines a **palette** (extended from current 5-color system) and optional **texture hints**:

```json
{
  "palette": {
    "paper": "#E8D9C0",
    "building_main": "#C8B48A",
    "building_shadow": "#A09070",
    "building_accent": "#7A5C30",
    "road_fill": "#B8A882",
    "road_edge": "#8A7860",
    "water_fill": "#4A7A9B",
    "water_edge": "#2A5A7B",
    "wall": "#6A5A4A",
    "park": "#8AB080",
    "field": "#C8D4A0"
  },
  "stroke_widths": {
    "building": 0.3,
    "wall": 2.0,
    "artery": 2.5,
    "alley": 0.8
  },
  "hatch_fields": true,
  "draw_shadows": false,
  "line_weight_style": "flat"   // "flat", "variable" (tapered), "calligraphic"
}
```

### Road Rendering Modes

Current implementation: double-stroke (outline + fill). Extended:
- **Single stroke** (track, path)
- **Double stroke** (road — current)
- **Triple stroke** (highway — center line marking)
- **Dotted / dashed** (proposed road, path through fields)

---

## Technology Recommendations

### Frontend Stack (Primary)

**Canvas 2D** — keep as rendering target. Reasons: no dependencies, excellent performance for thousands of polygons, native in all browsers. The current SVG approach will struggle at large scales (thousands of buildings). Canvas 2D is the primary target; WebGL (via raw canvas context) is the planned upgrade path if benchmarks at 60+ districts with full M4–M6 show frame-rate issues.

**Vanilla JS (ES2022 modules)** — consistent with current zero-dep approach. Use native ES modules with `import`/`export` for the module system. No bundler required for development; optional esbuild for production.

**OffscreenCanvas + Web Workers** — for heavy generation passes (terrain noise, building placement). Worker thread does the math; posts back a bitmap to main thread. Use workers wherever they keep the UI responsive.

**URL hash as sole persistence** — `#s=42&style=arabic&coast=true&…` encodes seed + options. One hash deterministically reproduces one city (given the same geo-map). No localStorage, no IndexedDB, no server-side session. Manual edits (if any) are not persisted.

### Backend Stack (Python, retained for heavy computation)

Keep Python/FastAPI for:
- Voronoi + Delaunay geometry (current, proven)
- A* pathfinding over terrain grids
- SVG export rendering (server-side, print quality)

New endpoints needed:
- `POST /api/terrain` → WorldMap JSON
- `POST /api/region` → Region JSON
- `POST /api/city` → CityMap JSON (replaces current `/api/generate`)
- `POST /api/district` → buildings for one district
- `POST /api/export/svg` → full-quality SVG blob

### Noise Library
- **Simplex noise**: implement in Python (`opensimplex` or hand-port) for terrain. Also implement in JS for any client-side noise. No erosion pass — noise quality is sufficient for the placeholder terrain stage.
- Current Park-Miller PRNG is retained for city-level generation (existing tests depend on it).

### Geometry
- All current Python geometry (Polygon, Voronoi, Graph) is retained and extended.
- New: `TerrainMesh` class for grid-based terrain operations.
- New: `CostMap` class wrapping terrain data for A* cost functions.
- New: `PoissonDiskSampler` for tree and building placement.

---

## Migration Strategy from Current Codebase

The current codebase is a solid foundation. Rather than rewriting, we extend:

### Phase 1 — Module Framework (no feature change)
1. Create `town_generator/webapp/tools/` directory
2. Add `/tools/<name>/` routes to FastAPI for each module standalone page
3. Create `pipeline.js` controller
4. Wrap existing `/api/generate` endpoint as M3 with the new CityMap JSON output format
5. Add JSON import/export to current UI — no visual change, just data plumbing
6. **Tests**: pipeline wiring, JSON schema validation

### Phase 2 — M1 Terrain
1. Add `town_generator/terrain/` package: `noise.py`, `biome.py`, `hydrology.py`, `resources.py`
2. Add `POST /api/terrain` endpoint
3. Build M1 standalone HTML/JS page
4. **Tests**: deterministic terrain from seed, biome classification boundaries

### Phase 3 — M3 Enhancement (City Structure)
1. Extend `building/model.py` to accept `terrain_fragment` and `style` objects
2. Add terrain-biased Voronoi seeding
3. Add full landmark site system
4. Add cultural style parameter to district assignment
5. Extend palette system for per-style color descriptors
6. **Tests**: all existing 29 tests must still pass

### Phase 4 — M4 District Populators
1. Add `town_generator/wards/populators/` package
2. Port `create_alleys` to `OrganicAlleyPopulator` class
3. Implement `CourtyardPopulator`, `GridPopulator`
4. Build M4 standalone HTML/JS page with single-district mode
5. **Tests**: all populators with known polygons, snapshot tests

### Phase 5 — M2 Regional Layout
1. Add `town_generator/region/` package: `site_scoring.py`, `road_network.py`
2. Add `POST /api/region` endpoint
3. Build M2 standalone page
4. **Tests**: settlement count, road connectivity, no roads through high mountains

### Phase 6 — M5 Building Detail + M6 Dressing
1. Add `town_generator/detail/` package: `roof.py`, `facade.py`
2. Add `town_generator/dressing/` package: `vegetation.py`, `fields.py`
3. Update SVG renderer to draw new layers
4. Canvas renderer for M5+M6 visual preview

### Phase 7 — Full Integration
1. Full pipeline view in main UI
2. Style system complete (all 7 styles)
3. Export system (SVG, PNG, JSON bundle)
4. Polish, performance tuning

---

## Testing Strategy

### Unit Tests (per module)

Each module's core algorithm is testable with fixed inputs:
- **Terrain**: given seed → deterministic elevation, biome grid
- **Voronoi**: existing tests retained
- **City structure**: existing 29 tests retained + new landmark placement tests
- **Populators**: given polygon + style → building count in expected range
- **Roof geometry**: given footprint type → valid roof polygon (non-self-intersecting)

### Integration Tests
- Full pipeline with fixed seed → snapshot comparison of final CityMap JSON
- Style consistency: european style → only european landmarks placed

> Structural/layout aesthetic invariants ("castle always on high ground") are **not tested**. Tests focus on determinism, schema validity, and structural correctness — not visual aesthetics.

### Module Standalone Tests
- Each module page loads at its `/tools/<name>/` URL without errors
- Mock data generator produces valid data
- Export button produces parseable JSON

---

## Recommendations

### Start with the Most Useful Standalone Module
**M4 (District Population)** is the highest-leverage standalone module: it directly extends the current city generator's most visible output (building placement), is algorithmically self-contained, and can be developed without any terrain or region data. Build it first.

### Keep the Current Pipeline Working Throughout
The current `/api/generate` endpoint must remain functional throughout the migration. Every phase should end with `pytest tests/ -x -q` passing. Use feature flags to gate new behavior without breaking old.

### Prioritize the Courtyard Populator
The `CourtyardPopulator` (for Arabic/East Asian styles) produces the most visually distinctive output and is the sharpest departure from the current Haxe port. It signals clearly that the new system can do things the original could not.

### Canvas Over SVG for Interactive Editing
For the interactive editor, Canvas 2D is strongly preferred over SVG for the map view. SVG with thousands of path elements becomes sluggish for pan/zoom/hover. Use SVG only for export.

### Modular CSS with CSS Custom Properties
Use CSS custom properties for the palette system so the dark-themed UI can be updated with a single palette swap:
```css
:root { --color-paper: #1A1F2E; --color-accent: #C53030; }
```

### Incremental Voronoi Enhancement
The current Voronoi is a clean Bowyer-Watson implementation. Before adding terrain bias, consider adding **weighted Voronoi** (power diagram) as an intermediate step — it gives more control over district sizes without changing the underlying algorithm.

### Avoid Premature 3D
Resist the temptation to add isometric or 3D rendering. The genre (watabou's tools, Fantasy City Generator) is firmly 2D top-down with implied 3D via roof projection and shadow hints. Full 3D adds enormous complexity for marginal visual gain at this scale.

### Internationalized Labels (for styles)
District type labels and landmark labels are more valuable than proper city/street names. These should be visible at all zoom levels and culturally appropriate (e.g., “Souk” not “Market” for arabic style). Port `MarkovChain.hx` from the Haxe codebase as a placeholder name generator; it will be replaced by a dedicated external name-generator project. Priority: district type labels, landmark type labels, building type annotations. Proper names are secondary.

### Save / Load via URL Hash
Persistence model: `seed + options = 1 URL hash`. The hash encodes all generation parameters (seed, style, toggles, road count, etc.). Appending a geo-map reference (WorldMap JSON URL or hash) fully identifies a city. **No server-side storage or local database.** Manual edits, if they exist in the future, are not saved — only the generative parameters are preserved.

---

## Design Decisions

All questions from the original design review have been resolved. The following decisions are now incorporated into the document above.

| # | Decision |
|---|---|
| 1 | **No hydraulic erosion.** Terrain uses simple multi-octave Simplex noise only. M1 is a placeholder until a dedicated world-builder project provides tile imports. |
| 2 | **Rivers use forced Voronoi seed lines.** River banks are explicit generator points before diagram computation. Upgrade to CDT only if degenerate cells become a real problem. |
| 3 | **Vectorized roads are the priority.** A* output is post-processed (Chaikin + Douglas–Peucker) to produce smooth polylines. Use whatever resolution/method achieves convincing vector geometry quickly. |
| 4 | **Labyrinthine subdivision starts simple.** Recursive block split with 30% dead-end stub probability. Increase fidelity if results are unsatisfying. |
| 5 | **Canvas 2D first, WebGL upgrade path.** Start with Canvas 2D; plan for WebGL if benchmarks at 60+ districts with M4–M6 show issues. |
| 6 | **Minimal editing only.** The tool is a procedural generator, not an editor. Permitted low-cost edits: move district centroid, force landmark type, lock a stage. No polygon editing. |
| 7 | **Small settlements use a fast path.** Hamlet and village bypass the full pipeline. A separate `SinglePatchGenerator` produces a countryside scene (farmsteads, hamlets) with its own workflow at `/tools/hamlet/`. |
| 8 | **Agglomeration scope: 1 city + small satellites.** The regional map supports one main city and surrounding hamlet/village satellites rendered via the fast path. Not sized for two full cities. |
| 9 | **District/building type labels over names.** Port `MarkovChain.hx` as a temporary placeholder; it will be replaced by an external name-generator. Priority is culturally correct type labels (e.g., “Souk”, “Khana”, “Forum”), not proper names. |
| 10 | **No accessible palettes.** The rendering system will change once cities are satisfying. Skip colorblind variants for now. |
| 11 | **Keep Python/JS split.** Use whichever language is easier per component. No Wasm or full-JS port planned. |
| 12 | **URL hash is the only persistence.** `seed + options = 1 hash`. No localStorage, IndexedDB, or server sessions. Manual edits (if any) are not saved. |
| 13 | **Use Web Workers if they speed things up.** No erosion, so generation is fast. Workers are used where they keep the UI responsive — use them at discretion. |
| 14 | **Export is deferred.** Client-side canvas-to-PNG for now; proper SVG/PNG export system is a later milestone. |
| 15 | **No aesthetic invariant tests.** Tests cover determinism, schema validity, and structural correctness. Visual/layout aesthetics are not tested. |