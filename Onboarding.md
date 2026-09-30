# City Generator — Deep Technical Onboarding

This document dissects every stage of the city generation pipeline, analyzes the algorithms at play, identifies their limitations, and charts a path from "charming medieval toy" to "realistic settlement generator spanning hamlets to megalopolises."

---

## Table of Contents

1. [High-Level Pipeline](#1-high-level-pipeline)
2. [Stage 1 — Patch Generation (Voronoi)](#2-stage-1--patch-generation-voronoi)
3. [Stage 2 — Water Features (Coast & River)](#3-stage-2--water-features-coast--river)
4. [Stage 3 — Junction Optimization](#4-stage-3--junction-optimization)
5. [Stage 4 — Wall Construction](#5-stage-4--wall-construction)
6. [Stage 5 — Street Network](#6-stage-5--street-network)
7. [Stage 6 — Ward Assignment](#7-stage-6--ward-assignment)
8. [Stage 7 — Building Geometry](#8-stage-7--building-geometry)
9. [Stage 8 — SVG Rendering](#9-stage-8--svg-rendering)
10. [Cross-Cutting Concerns](#10-cross-cutting-concerns)
11. [Road to Realism](#11-road-to-realism)
12. [Scaling: Village to Megalopolis](#12-scaling-village-to-megalopolis)
13. [Performance Analysis & Optimization](#13-performance-analysis--optimization)
14. [Extension Catalog](#14-extension-catalog)

---

## 1. High-Level Pipeline

```
Model.__init__()
  |
  v
_build_patches()         Voronoi tessellation -> city districts ("patches")
  |
  v
_generate_water()        Coast shoreline + river path, remove submerged patches
  |
  v
_optimize_junctions()    Merge close vertices (< 8 units apart)
  |
  v
_build_walls()           Circumference polygon -> CurtainWall + gates + towers
  |
  v
_build_streets()         Topology graph + A* pathfinding -> arteries
  |
  v
river.find_bridges()     Detect road-river crossings
  |
  v
_clip_patches_to_water() Trim patch shapes along coast/river boundaries
  |
  v
_create_wards()          Assign ward type (Market, Cathedral, Slum...) to each patch
  |
  v
_build_geometry()        Ward.create_geometry() -> building polygons per patch
  |
  v
render_svg()             Layered SVG: coast -> river -> roads -> patches -> walls -> bridges
```

The entire pipeline runs synchronously, single-threaded, with a **retry loop** (up to 20 attempts). Any exception during `_build()` triggers a full restart — there is no partial recovery. This is a brute-force resilience strategy inherited from the original Haxe code.

### Configuration Surface

| Parameter | Type | Effect |
|-----------|------|--------|
| `n_patches` | int | City size (3-60 patches) |
| `seed` | int | Deterministic PRNG seed |
| `elongation` | float | Shape stretch (1.0=round, 3.0=very oval) |
| `plaza` | bool\|None | Force central plaza on/off/random |
| `citadel` | bool\|None | Force castle district on/off/random |
| `walls` | bool\|None | Force city walls on/off/random |
| `temple` | bool\|None | Force cathedral on/off/random |
| `river` | bool | Enable river through city |
| `coast` | bool | Enable coastline |
| `shanty_town` | bool | Enable shanty towns outside walls |
| `n_roads` | int\|None | Limit road/gate count |
| `road_style` | str | "organic" (A* paths) or "medieval" (+ ring roads) |
| `river_curvature` | float | River wiggliness (0.5-6.0) |
| `coast_roughness` | float | Coast irregularity (0.1-1.5) |
| `building_density` | float | Building packing (0.0-1.0) |
| `building_style` | str | "original", "composite", "mixed" |

---

## 2. Stage 1 — Patch Generation (Voronoi)

**File:** `building/model.py:_build_patches()` + `geom/voronoi.py`

### 2.1 Point Cloud Generation

The city's spatial structure starts as a spiral point cloud:

```python
for i in range(n_patches * 8):
    a = sa + sqrt(i) * 5          # Fermat-like spiral angle
    r = 0 if i == 0 else 10 + i * (2 + Random.float())  # Growing radius
    px = cos(a) * r
    py = sin(a) * r
```

Points are then stretched along a random axis by the `elongation` factor (rotation + scale + unrotation), producing oval or irregular city shapes instead of always-circular ones.

**Why `n_patches * 8`?** Generates 8x more Voronoi cells than needed. After sorting by distance from origin, only the first `n_patches` are marked as "inner city." The rest form the countryside/outskirts buffer.

### 2.2 Incremental Delaunay Triangulation

`Voronoi.build()` creates a bounding rectangle with 4 frame points, seeds two initial triangles, then incrementally inserts each point:

```
For each new point P:
  1. Find all triangles whose circumscircle contains P
  2. Collect their outer boundary edges
  3. Create new triangles: fan from P to each boundary edge
  4. Remove old triangles
```

**Algorithm:** Bowyer-Watson incremental insertion.
**Complexity:** O(n^2) in the worst case (each insertion scans all triangles). No spatial acceleration structure (quadtree, grid).

### 2.3 Voronoi Dual

The Voronoi diagram is the dual of the Delaunay triangulation. Each `Region` stores the triangles incident to its seed point. The region's polygon vertices are the circumcenters of those triangles, sorted by angle.

`partitioning()` filters out regions that touch the bounding frame (infinite Voronoi cells), giving only the finite interior cells.

### 2.4 Lloyd's Relaxation

```python
for i in range(3):
    to_relax = [voronoi.points[j] for j in range(3)]
    voronoi = Voronoi.relax(voronoi, to_relax)
```

Three rounds of Lloyd relaxation on the **first 3 points only** (the city core). Each relaxation replaces seed points with region centroids and rebuilds the entire Voronoi diagram. This is partial relaxation — it smooths the inner city while keeping the outskirts irregular.

### 2.5 Limitations

- **O(n^2) triangulation** — Acceptable for n=480 (60 patches * 8) but won't scale to thousands of points.
- **No geometric predicates** — Uses raw floating-point circumcircle tests. No robust predicate library (like Shewchuk's). Can produce degenerate triangulations with nearly-cocircular points.
- **Fixed spiral distribution** — The point cloud is always a spiral. No support for terrain-following distributions, road-aligned grids, or geographic constraints.
- **Uniform relaxation** — Partial relaxation only on 3 points. No control over cell size distribution (e.g., larger cells at periphery, smaller at center).

### 2.6 Improvement Paths

| Goal | Approach |
|------|----------|
| **Faster triangulation** | Use Fortune's sweep line O(n log n) or an existing library (scipy.spatial.Delaunay) |
| **Adaptive cell sizes** | Weighted Voronoi (power diagrams) or variable-density point sampling |
| **Terrain-aware patches** | Place points along rivers, roads, and ridgelines; use constrained Delaunay |
| **Anisotropic cells** | Elongated cells along roads using anisotropic Voronoi (CVT with tensor fields) |
| **Multiple nuclei** | For megalopolises: multiple spiral centers that grow toward each other |

---

## 3. Stage 2 — Water Features (Coast & River)

**Files:** `building/coast.py`, `building/river.py`

### 3.1 Coastline Generation

```
1. Pick random direction angle
2. Place shoreline at 0.4-0.7x city radius in that direction
3. Create perpendicular line (4x city radius long)
4. Apply midpoint displacement (depth=6, magnitude=radius*roughness)
5. Chaikin smoothing (1 iteration)
6. Add micro noise (2% radius, every other point)
7. Build water polygon: shoreline + two far-offset points
```

**Midpoint displacement** (a.k.a. diamond-square in 1D): Recursively splits the line at midpoints, offsets each perpendicular to the line by a random amount. Magnitude decays by factor 0.55 each level. Produces 2^6 = 64 segments before smoothing.

**Chaikin smoothing:** Corner-cutting subdivision. Each edge [P0, P1] becomes two points at 75%/25% and 25%/75%. Converges to a quadratic B-spline after many iterations. One iteration is used here — subtle rounding.

**Water test:** `is_in_water()` uses ray casting (crossing number algorithm) against the water polygon. O(n) per query with n = polygon vertices.

### 3.2 River Generation

```
1. Pick entry/exit angles (exit toward coast if coast exists)
2. Endpoints at 5x city radius
3. Midpoint displacement (depth=6, magnitude=radius*curvature)
4. Chaikin smoothing (1 iteration)
5. Compute banks: perpendicular offsets at each path point
6. Estuary effect: width grows from 0.6x to 2.5x base width (entry→exit)
7. Build river polygon: left bank + reversed right bank
```

**Bridge detection:** For each artery segment, test intersection with every river polygon edge. O(arteries * artery_segments * river_polygon_edges). Bridges in the sea (coast water area) are filtered out.

### 3.3 Patch Clipping

`_clip_patches_to_water()` clips each patch shape against water boundaries:

```
1. Test each vertex: is it in water?
2. If mixed (some wet, some dry): find nearest boundary segment to patch centroid
3. Cut the patch polygon along that boundary segment
4. Keep the dry half
```

This is a **single-cut heuristic** — it only tries one cutting line. Complex patches that need multiple cuts may not clip correctly.

### 3.4 Limitations

- **Single river only** — The architecture supports exactly one `River` instance. No tributaries, no confluences.
- **Straight shoreline baseline** — Coast is always a displaced straight line. No bays, peninsulas, or islands.
- **No river-terrain interaction** — River doesn't follow valleys or terrain features. It's a random displaced line through the center.
- **Simple water test** — Ray casting works but is O(n) per query. Used frequently (every building vertex).
- **Estuary is always widening** — River width monotonically increases. No narrows, no rapids.
- **Single-cut clipping** — Patches at river bends may not clip properly.

### 3.5 Improvement Paths

| Goal | Approach |
|------|----------|
| **Multiple rivers** | List[River], each with entry/exit angles. Compute confluences as polygon intersections |
| **Tributaries** | L-system or recursive branching from main river |
| **Islands** | Create closed coast polygons. Patches inside get `within_island=True` |
| **Bays and peninsulas** | Replace straight baseline with another midpoint-displaced curve. Multiple displacements at different scales |
| **Terrain-following rivers** | Generate heightmap first, river follows gradient descent |
| **Better clipping** | Sutherland-Hodgman polygon clipping against water boundary. Handles arbitrary convex/concave shapes |
| **Spatial indexing for water tests** | Precompute a grid of water/land cells. O(1) approximate test, fall back to ray casting at boundaries |

---

## 4. Stage 3 — Junction Optimization

**File:** `building/model.py:_optimize_junctions()`

### 4.1 Algorithm

```
For each inner patch:
  For each consecutive vertex pair (v0, v1) in the patch shape:
    If v0 and v1 are closer than 8 units:
      - Find all other patches containing v1
      - Replace v1 with v0 in those patches (identity-based replacement)
      - Move v0 to the midpoint of (v0, v1)
      - Remove v1 from current patch
  Then: clean up duplicate identities in affected patches
```

This merges tiny Voronoi edges that create visual clutter. It's a local vertex-welding pass.

### 4.2 The Identity Invariant

This is where the **Point identity semantics** (using `is`, not `==`) become critical. When v1 is replaced by v0 in patch shapes, every polygon that shared the same v1 *object* now shares v0. Moving v0 to the midpoint automatically updates all polygons that reference it. This is intentional shared-state mutation.

### 4.3 Limitations

- **Fixed threshold (8 units)** — Hardcoded. Should scale with city size.
- **No topological awareness** — Doesn't check if merging creates degenerate polygons (< 3 vertices) or self-intersecting shapes.
- **O(n*m) complexity** — For each vertex pair, scans all patches. With many patches, this gets slow.
- **Order-dependent** — Merging happens sequentially. The order of iteration affects which vertices survive.

### 4.4 Improvement Paths

- **Adaptive threshold** — Scale with average Voronoi cell size
- **Spatial hash** — O(1) lookup for nearby vertices instead of scanning all patches
- **Topology-aware merging** — Check that resulting polygons remain valid (no self-intersection, minimum vertex count)
- **Edge collapse with priority queue** — Process shortest edges first (like mesh simplification)

---

## 5. Stage 4 — Wall Construction

**File:** `building/curtain_wall.py`

### 5.1 Circumference Extraction

`find_circumference(patches)` computes the outer boundary of a set of patches:

```
1. For each edge (a, b) of each patch:
   - Check if any other patch has the reverse edge (b, a)
   - If no: it's an outer edge. Collect A[]=a, B[]=b
2. Chain edges: start at A[0], follow B[i] → find A[j] where A[j] is B[i]
3. Result: ordered boundary polygon
```

This is an **identity-based boundary extraction** — edges are matched by object identity, not coordinate equality. The algorithm is O(edges * patches) for the inner loop.

### 5.2 Wall Smoothing

If walls are real (visible), vertex positions are smoothed:
```python
smooth_factor = min(1, 40 / len(patches))
smoothed[i] = shape.smooth_vertex(v, smooth_factor)
```

Reserved vertices (citadel corners) are not smoothed, preserving sharp intersections.

### 5.3 Gate Placement

```
1. Collect "entrance" candidates: vertices shared by multiple patches (not reserved)
2. Loop: pick random entrance as gate
3. Split the outer patch at the gate point (for road access)
4. Remove nearby candidates (skip +-1 neighbors in the entrance list)
5. Stop when < 3 candidates remain
```

Gates are then optionally limited by `n_roads` (random subset removal).

### 5.4 Tower Placement

Every non-gate vertex on the wall shape becomes a tower. No distance-based filtering — towers can be extremely close together on short wall segments.

### 5.5 Limitations

- **No wall shape control** — Wall follows Voronoi circumference exactly (with minor smoothing). No support for rectangular, star-shaped, or terrain-following fortifications.
- **Random gate placement** — No strategic placement (e.g., facing roads, waterfront, compass directions).
- **Single wall ring** — No support for concentric walls (inner + outer walls, as in historical cities like Paris or Constantinople).
- **No bastions or towers variations** — All towers are identical circles. No bastions, barbicans, or gatehouse structures.

### 5.6 Improvement Paths

| Goal | Approach |
|------|----------|
| **Concentric walls** | Multiple CurtainWall instances at different radii. Inner patches get `within_inner_walls` flag |
| **Star fortifications** | Post-process wall polygon: insert bastion points at regular intervals |
| **Strategic gates** | Place gates facing existing roads, rivers, or compass directions. Weight by trade route importance |
| **Wall following terrain** | Wall path should avoid crossing rivers, prefer high ground |
| **Historical wall rings** | Small settlement → first wall → growth → second wall. Model as growth phases |

---

## 6. Stage 5 — Street Network

**Files:** `building/topology.py`, `geom/graph.py`, `building/model.py:_build_streets()`

### 6.1 Topology Graph Construction

`Topology.__init__()` builds a planar graph from patch geometry:

```
For each patch:
  For each edge (v0, v1):
    - Create graph nodes for v0 and v1 (if not already created)
    - Link them with weight = Euclidean distance
    - Track which nodes are "inner" (within city) vs "outer"
    - Block nodes on wall/citadel boundaries (except gates)
```

The graph stores bidirectional `Point → Node` mappings using Python `id()` as keys. This is the fundamental structure for pathfinding.

### 6.2 A* Pathfinding

`Graph.a_star()` finds shortest paths:

```python
open_set = [start]   # list, not priority queue!
while open_set:
    current = open_set.pop(0)   # FIFO — NOT a proper A* with heuristic
    ...
```

**Critical issue:** This is labeled A* but is actually **Dijkstra's algorithm with BFS-like behavior**:
- No heuristic function (h(n) = 0 everywhere)
- Open set is a flat list with `pop(0)` — O(n) removal
- No priority ordering — nodes are explored in insertion order

For each gate, two paths are computed:
1. **Street:** Gate → plaza/center (using `outer` nodes as exclusion)
2. **Road:** Farthest-from-gate boundary node → gate (using `inner` nodes as exclusion)

### 6.3 Road Tidying

`_tidy_up_roads()` converts overlapping street/road paths into non-duplicate segment chains ("arteries"):

```
1. Decompose all streets and roads into individual segments
2. Skip duplicate segments (identity-based check)
3. Greedily chain segments into polylines (arteries)
```

### 6.4 Ring Roads (Medieval Style)

When `road_style == "medieval"`, concentric ring roads are added:

```
1. Compute wall radius
2. For 2-3 rings at evenly-spaced fractions of the radius:
   - Collect patch vertices within tolerance of the target radius
   - Sort by angle around center
   - Filter too-close points (< 3 units)
   - Create closed polyline
```

### 6.5 Street Smoothing

All arteries get 2 rounds of vertex smoothing (weighted average with neighbors, factor 3).

### 6.6 Limitations

- **Not real A*** — Missing heuristic and priority queue. Produces correct shortest paths but with O(V^2) complexity instead of O(E + V log V).
- **Radial-only street pattern** — All streets connect gates to center. No through-roads, no grid patterns, no boulevards.
- **No road hierarchy** — All streets have the same width logic. No distinction between highways, alleys, and paths.
- **Ring roads are heuristic** — They snap to Voronoi vertices near the target radius. No guarantee of continuity or smoothness.
- **No cul-de-sacs or secondary streets** — Only main arteries from gates. Interior blocks have no internal streets.
- **No traffic-based routing** — Streets don't follow desire lines or minimize travel distance for inhabitants.

### 6.7 Improvement Paths

| Goal | Approach |
|------|----------|
| **Proper A*** | Use a min-heap (heapq) and Euclidean distance heuristic |
| **Road hierarchy** | Primary (gates→center), secondary (ring roads), tertiary (inter-block alleys). Different widths and styles |
| **Grid patterns** | For regular neighborhoods: generate orthogonal grid, snap to Voronoi edges |
| **Organic street growth** | Agent-based: simulate people walking desire lines, reinforce popular paths |
| **Through-roads** | Connect opposing gates directly instead of routing through center |
| **Cul-de-sacs** | Dead-end streets into large blocks, generated during ward geometry |
| **Road-aware patches** | Constrain Voronoi diagram so cell edges align with major roads |

---

## 7. Stage 6 — Ward Assignment

**File:** `building/model.py:_create_wards()`

### 7.1 Assignment Algorithm

The ward assignment follows a priority-based allocation:

```
Phase 1: CIVIC CORE
  - If plaza enabled: assign Market to plaza patch
  - Assign Cathedral + AdministrationWard to patches adjacent to plaza
    (using rate_location to pick best candidate)

Phase 2: GATE WARDS
  - For each gate vertex: 50% chance (if walls) or 20% chance (if no walls)
    assign GateWard to a patch touching that gate

Phase 3: POOL WALK
  - Pre-shuffled ward type list (weighted toward CraftsmenWard):
    [Craftsmen, Craftsmen, Merchant, Craftsmen, Park, Cathedral,
     Craftsmen, Merchant, Craftsmen, Craftsmen, Craftsmen,
     Patriciate, Craftsmen, Craftsmen, Administration, Merchant,
     Slum, Craftsmen, Slum, Patriciate, Market, ...]
  - For each unassigned patch: pop next ward type from list
  - If ward has rate_location: pick best-rated unassigned patch
  - If ward has no rate_location: pick random unassigned patch

Phase 4: OUTSKIRTS
  - For each gate: probabilistic expansion outside walls (GateWard)

Phase 5: COUNTRYSIDE
  - Shanty towns within 1.2x city radius (if enabled)
  - 20% chance of Farm (if compact enough)
  - Otherwise: bare Ward (empty)
```

### 7.2 Ward Types and Their Parameters

| Ward | Base | min_sq | grid_chaos | size_chaos | empty_prob | Placement |
|------|------|--------|------------|------------|------------|-----------|
| CraftsmenWard | CommonWard | 10-90 | 0.5-0.7 | 0.6 | 0.04 | Random |
| MerchantWard | CommonWard | 50-110 | 0.5-0.8 | 0.7 | 0.15 | Near center |
| PatriciateWard | CommonWard | 80-110 | 0.5-0.8 | 0.8 | 0.20 | Near parks, far from slums |
| Slum | CommonWard | 10-40 | 0.6-1.0 | 0.8 | 0.03 | Far from center |
| GateWard | CommonWard | 10-60 | 0.5-0.8 | 0.7 | 0.04 | At gates |
| ShantyTown | CommonWard | 5-20 | 0.8-1.0 | 0.9 | 0.01 | Outside walls |
| AdministrationWard | CommonWard | 80-110 | 0.1-0.4 | 0.3 | 0.04 | Adjacent to plaza |
| Market | Ward | — | — | — | — | Plaza patch |
| Cathedral | Ward | — | — | — | — | Adjacent to plaza |
| Castle | Ward | — | — | — | — | Citadel patch |
| MilitaryWard | Ward | ~sqrt(area) | 0.1-0.4 | 0.3 | 0.25 | Near citadel/wall |
| Park | Ward | — | — | — | — | Pool walk |
| Farm | Ward | — | — | — | — | Countryside |

**Key parameters explained:**
- `min_sq`: Minimum block area before stopping recursion. Lower = more, smaller buildings.
- `grid_chaos`: How much the cutting angle varies from perpendicular. 0 = perfect grid, 1 = chaotic.
- `size_chaos`: Variation in block size threshold. 0 = uniform, 1 = wildly varied.
- `empty_prob`: Probability of leaving a small block empty (yard/garden space).

### 7.3 Rate Location Functions

Each ward type can define a `rate_location(model, patch) -> float` to influence placement:

- **Cathedral:** Prefers patches adjacent to plaza (returns negative rating). Otherwise: distance * area.
- **Slum:** Prefers *farthest* from center (negative distance).
- **MerchantWard:** Prefers *nearest* to center (positive distance).
- **PatriciateWard:** -1 for each neighboring Park, +1 for each neighboring Slum.
- **MilitaryWard:** 0 if adjacent to citadel, 1 if adjacent to wall, infinity otherwise.
- **AdministrationWard:** 0 if bordering plaza, distance to plaza otherwise.
- **Market:** Prevents adjacent markets, prefers similar size to plaza.
- **ShantyTown:** Prefers close to city but outside walls.

### 7.4 Limitations

- **Fixed ward type pool** — The 36-entry list hardcodes the distribution. Can't dynamically adjust to city size, culture, or era.
- **No socioeconomic simulation** — Ward placement is purely geometric (distance to center, adjacency). No land value, traffic, resource access.
- **No mixed-use zones** — Each patch is exactly one ward type. Real neighborhoods have mixed residential/commercial.
- **No growth phases** — The city appears fully-formed. No historical layering (old town → expansion → suburbs).
- **Limited rate functions** — Simple distance/adjacency heuristics. No multi-factor scoring.

### 7.5 Improvement Paths

| Goal | Approach |
|------|----------|
| **Dynamic ward pools** | Generate ward distribution based on city size, era, and culture parameters |
| **Land value simulation** | Compute desirability per patch: center proximity + road access + water view - flood risk |
| **Mixed-use blocks** | Allow patches to have primary + secondary ward types |
| **Historical growth** | Build city in phases: Phase 1 (core), Phase 2 (first wall), Phase 3 (expansion) |
| **Cultural templates** | Medieval European, Islamic medina, Chinese walled city, colonial grid |
| **Zoning constraints** | Tanneries near water/downwind, markets on crossroads, religious districts on hills |

---

## 8. Stage 7 — Building Geometry

**Files:** `wards/ward.py`, `wards/common_ward.py`, `building/cutter.py`

### 8.1 City Block Extraction

`get_city_block()` computes the buildable area within a patch:

```
For each edge of the patch polygon:
  - If edge borders a wall: inset by MAIN_STREET/2 (1.0)
  - If edge borders a street/artery: inset by MAIN_STREET/2 (1.0)
  - If edge is inner (no road): inset by REGULAR_STREET/2 (0.5)
  - If edge is outer (outskirts): inset by ALLEY/2 (0.3 default)

If patch is convex: shrink() — parallel edge offsetting + polygon cutting
If patch is concave: buffer() — edge offsetting with self-intersection resolution
```

### 8.2 Recursive Bisection (`create_alleys`)

The core building generation algorithm for all CommonWard subclasses:

```
create_alleys(polygon, min_sq, grid_chaos, size_chaos, empty_prob):
  1. Find the longest edge of the polygon
  2. Compute cutting ratio: 0.1-0.9 range (controlled by grid_chaos)
  3. Compute cutting angle: slight random rotation (controlled by grid_chaos)
  4. bisect() the polygon: cut perpendicular to longest edge at the ratio point
  5. For each half:
     a. Compute threshold = min_sq * 2^(4 * size_chaos * (rand-0.5))
     b. If area < threshold:
        - empty_prob chance: skip (leave as empty space)
        - Otherwise: this half IS a building
     c. If area >= threshold: recurse
  6. Filter out degenerate polygons (< 4 vertices)
```

**Bisection detail** (`cutter.py:bisect`):
```
1. Find the next vertex after `vertex` on the polygon edge
2. Interpolate a point P1 at `ratio` along that edge
3. Rotate the edge direction by `angle`
4. Compute P2 along the rotated perpendicular
5. Cut the polygon along line (P1, P2) with optional gap
```

`polygon.cut()` finds the two intersection points of a line with the polygon boundary and splits it into two halves. The `gap` parameter peels each half slightly to create visible alley space between buildings.

### 8.3 Orthogonal Building Subdivision (`create_ortho_building`)

Used by Farm and (via `create_alleys` indirectly) other wards:

```
1. Find longest edge of polygon
2. Get two perpendicular cutting directions from that edge
3. Recursively slice: pick the direction most aligned with the polygon's longest edge
4. Cut at 40-60% along the longest edge
5. Recurse until blocks are small enough
```

This produces more grid-like building layouts than `create_alleys`.

### 8.4 Building Style Post-Processing

After recursive bisection generates building polygons, a style transform is applied:

**Original style:** Keep the raw bisection polygons as-is. Buildings are irregular quadrilaterals/pentagons matching the Voronoi cell subdivisions.

**Composite style:** Each building polygon → two overlapping axis-aligned rectangles:
```
1. Compute oriented bounding box (aligned to longest edge)
2. Create body rectangle (55-80% width, full height)
3. Create wing rectangle (full width, 35-60% height)
4. Offset body to one side, wing to one end
```
Result: L-shaped footprints from overlapping rectangles. Fast but has visual overlap artifacts.

**Mixed style:** Per-building random selection:
- Tiny (< 6 sq): keep original polygon
- Small (< 15 sq): 55% original, 45% road-aligned rectangle
- Medium/Large: 30% original, 30% aligned rectangle, 40% L-shaped hexagon

**L-shape generation:**
```
1. Compute oriented bounding box
2. Choose random corner to notch out
3. Generate 6-vertex polygon: full rectangle minus one corner
4. Transform from local coordinates to world coordinates
```

The road-aligned variants use `_get_road_direction()` to orient buildings along the nearest street edge.

### 8.5 Special Ward Geometries

**Cathedral (cruciform plan):**
```
1. Find longest edge → main axis angle
2. Nave: long rectangle (55-80% of block size) along main axis
3. Transept: wide rectangle (35-55% of block size) perpendicular to nave
4. Optional apse: small rectangle at one end (60% chance)
5. Optional tower: small square at the other end (50% chance)
```

**Castle:**
```
1. Shrink patch by 2x MAIN_STREET → buildable block
2. Keep: central rectangle (35-50% of block size), slightly rotated
3. 1-3 wings: smaller rectangles radiating from keep at equal angles
4. Optional corner towers: small squares at keep corners (50% chance)
```

**Market:**
```
1. Central monument: rectangle or circle (random)
2. Positioned near longest edge or at centroid
3. 3-5 market stalls: small rectangles arranged in a ring around monument
```

**Park:**
```
If compact (compactness >= 0.7): radial sectors (pie slices from centroid)
Otherwise: semi-radial sectors (from nearest vertex to centroid)
```

**Farm:**
```
Single 4x4 rectangle, randomly positioned and rotated within patch.
Subdivided by create_ortho_building.
```

### 8.6 Outskirts Filtering

For patches not fully enclosed by the city, `_filter_outskirts()` probabilistically removes buildings based on:

1. **Edge population:** Which edges face roads or populated neighbors
2. **Vertex density:** Whether vertices are shared with other city patches
3. **Distance falloff:** Buildings farther from populated edges are more likely removed
4. **Inverse-distance interpolation:** Patch shape vertices weighted by their density scores

This creates a natural thinning of buildings toward the countryside.

### 8.7 Water Filtering

`_filter_water()` removes buildings that overlap water:

```
For each building polygon:
  - Check centroid: is it in river? is it in coast water?
  - Check every vertex: is any vertex in water?
  - If any check is True: remove the building
```

This is vertex-level filtering, not proper polygon clipping. A building with all vertices on land but whose interior crosses a river bank will NOT be filtered.

### 8.8 Limitations

- **Recursive bisection only** — All CommonWard buildings come from the same algorithm. Produces similar-looking neighborhoods regardless of culture or era.
- **No building footprint variety** — Bisection always produces quadrilaterals. No courtyards, U-shapes, circular buildings, or complex footprints.
- **No street-facing constraints** — Buildings don't align their fronts to streets. No setback rules.
- **No lot subdivision** — Blocks are recursively split but there's no concept of individual lots with yard/garden space.
- **Cathedral/Castle are parametric** — Simple rectangle combinations. No procedural grammar (L-systems, shape grammars).
- **No height information** — Everything is 2D. No stories, no skyline.
- **Vertex-level water filter** — Misses buildings that span water without any vertex in water.

### 8.9 Improvement Paths

| Goal | Approach |
|------|----------|
| **Shape grammars** | CGA-like rules: Lot → setback → footprint → floors → roof. Per-ward grammar |
| **Street-facing buildings** | Orient building longest edge parallel to nearest street. Setback from street line |
| **Courtyard houses** | Generate U, L, O-shaped footprints with interior yard space |
| **Building height** | Assign stories based on ward type, distance to center, lot size |
| **Lot subdivision** | Divide blocks into individual lots with frontage on alleys. Buildings fill % of lot |
| **Procedural cathedrals** | Generate nave, transept, apse, tower, flying buttresses from grammar rules |
| **Proper clipping** | Sutherland-Hodgman clip building polygons against water boundaries |
| **Curved buildings** | For markets, temples: support circular arcs in building footprints |

---

## 9. Stage 8 — SVG Rendering

**File:** `rendering/svg_renderer.py`

### 9.1 Draw Order

```
1. Background rectangle (palette.paper color)
2. Defs: clipPath "land-clip" (viewbox rect minus water polygons, evenodd rule)
3. Coast water area (filled polygon + shoreline stroke)
4. River water area (filled polygon)
5. Roads (outer stroke + inner stroke, clipped to land)
6. Patches (buildings, per ward type rendering)
7. Walls + towers + gates (clipped to land)
8. Bridges (over river)
```

### 9.2 Water Clipping System

The `land-clip` clipPath uses SVG's `evenodd` fill rule:
- Outer rectangle = positive area (land)
- Water polygons = holes (subtracted)

Roads and walls reference `clip-path="url(#land-clip)"` so they don't render over water.

Buildings are NOT clipped by SVG — they're pre-filtered by `_filter_water()` during geometry generation.

### 9.3 Rendering by Ward Type

- **Castle/Cathedral:** Two-pass rendering — thick stroke outlines first, then filled shapes on top. Creates a bold border effect.
- **CommonWard buildings:** Simple filled polygon + thin stroke.
- **Park:** Filled with `palette.medium` color, no stroke.
- **Walls:** Thick stroke polygon + circle towers + gate lines.
- **Bridges:** Two overlapping lines (dark frame + light deck).

### 9.4 Limitations

- **No textures or patterns** — Flat colors only. No hatching, gradient fills, or SVG patterns.
- **No labels** — Ward names (Market, Cathedral, etc.) are not rendered. Each ward has `get_label()` but it's unused.
- **No legend** — No way to identify ward types visually (all buildings same color).
- **No shadows or depth cues** — Flat 2D rendering.
- **No road labels or icons** — Gates, bridges, and towers are geometric primitives only.
- **Fixed line widths** — Don't scale with zoom. Very thin at wide zoom, very thick at close zoom.

### 9.5 Improvement Paths

| Goal | Approach |
|------|----------|
| **Ward-colored buildings** | Use palette.medium for different ward types, or add ward-specific colors |
| **Labels** | Render `get_label()` at patch centroids as SVG `<text>` elements |
| **Hatching/patterns** | SVG `<pattern>` fills for parks (trees), water (waves), fields (crops) |
| **Shadows** | SVG `<filter>` with feDropShadow for buildings. Or duplicate buildings offset/darkened |
| **3D isometric** | Transform 2D footprints to isometric projection with height extrusion |
| **Interactive SVG** | Add `data-ward-type`, `data-patch-id` attributes for CSS hover effects |
| **Canvas/WebGL rendering** | For large cities: switch to GPU-accelerated rendering |

---

## 10. Cross-Cutting Concerns

### 10.1 PRNG: Park-Miller LCG

```python
class Random:
    _g = 48271.0
    _n = 2147483647  # 2^31 - 1
    _seed: int = 1

    @classmethod
    def _next(cls) -> int:
        cls._seed = int((cls._seed * cls._g) % cls._n)
        return cls._seed
```

**Properties:**
- Full period: 2^31 - 2 (all nonzero values)
- Statistically adequate for procedural generation (not cryptography)
- Global class-level state — not instance-based. **Not thread-safe.**
- `normal()` = average of 3 uniform samples (crude approximation of Gaussian, central limit theorem)
- `fuzzy(f)` = `(1-f)/2 + f * normal()` — configurable tightness

**Seed compatibility invariant:** Model.__init__ always consumes exactly 3 `Random.bool()` calls for plaza/citadel/walls toggles, even when values are forced. This ensures downstream PRNG sequences remain identical regardless of toggle overrides.

### 10.2 Identity Semantics on Point

The Point class deliberately does NOT override `__eq__` or `__hash__`. This means:
- `point1 == point2` is `True` only if `point1 is point2` (same object)
- `point1 in polygon` checks identity, not coordinate equality
- Polygon methods like `index_of()`, `contains_point()`, `find_edge()` all use `is`

**Why:** Voronoi vertices are shared between adjacent cells. When Model modifies a shared vertex (junction optimization, smoothing), the change propagates to all polygons containing that same object. Value-based equality would break this — two different Point objects at the same coordinates must remain distinct.

**Risk:** This makes the code fragile. Any operation that creates a new Point instead of modifying in-place will silently break shared references.

### 10.3 Polygon as list subclass

`class Polygon(list)` — the polygon IS a list of Points. This means:
- Direct indexing: `poly[i]` returns a Point
- `len(poly)` works naturally
- `append()`, `insert()`, `del` work directly
- Slicing returns a plain list (not a Polygon) — must wrap: `Polygon(poly[i:j])`

### 10.4 Error Handling: Retry Loop

```python
for _attempt in range(20):
    try:
        self._build()
        break
    except Exception:
        pass
else:
    raise RuntimeError("Failed to generate city after max retries")
```

Common failure modes:
- Bad citadel shape (compactness < 0.75)
- No valid gate entrances
- Unable to build a street (A* returns None)
- Bad walled area shape (no entrances found)

The retry loop re-rolls the PRNG (since seed advances on each failure) and tries a completely different random layout.

---

## 11. Road to Realism

This section maps the gap between current output and realistic settlement generation.

### 11.1 What's Missing for Realistic Villages

A small village along a road needs:

1. **Linear settlement pattern** — Houses along both sides of a single road. Current system always builds radial cities around a center.
2. **Church + village green** — Single focal point, not a full plaza/gate/wall system.
3. **Agricultural hinterland** — Fields radiating from the settlement, following terrain.
4. **Scale** — 10-50 buildings, not 100+.

**Implementation approach:**
- New `VillageModel` class that generates a road spine first
- Place buildings along the road with front-facing orientation
- Church at a bend or crossroads
- Fields as large rectangular patches filling remaining space

### 11.2 What's Missing for Realistic Towns

1. **Organic growth patterns** — Medieval towns grew incrementally. Streets follow desire lines, not Voronoi edges.
2. **Market square placement** — At the widest point of the main road, not at the Voronoi centroid.
3. **Social stratification** — Rich near center/church, poor at periphery. Current system approximates this but simplistically.
4. **Topography** — Hills, slopes, waterfront lots are prime real estate.

### 11.3 What's Missing for Realistic Cities

1. **Multiple centers** — Large cities have multiple nuclei (old town, merchant quarter, religious district).
2. **Grid planning** — Roman cities, colonial cities, and many modern cities have planned grid sections.
3. **Infrastructure** — Aqueducts, sewers, markets at intersections, harbors.
4. **Temporal layers** — Old narrow streets in center, wider boulevards in 19th-century extensions.

### 11.4 What's Missing for Megalopolises

1. **Multiple settlements merging** — London = City + Westminster + Southwark + dozens of villages.
2. **Multiple rivers/islands** — Paris (Seine + islands), New York (rivers + islands), St. Petersburg (delta).
3. **Industrial zones** — Along rivers, railways, ports. Downwind from residential.
4. **Suburbs and satellite towns** — Connected by roads/rails.
5. **Green belts and parks** — Large urban parks, cemeteries as green space.

### 11.5 Proposed Architecture for Multi-Scale Generation

```
TerrainGenerator
  ├── HeightmapGenerator     (Perlin noise or real data)
  ├── WatershedGenerator     (rivers follow terrain)
  └── CoastlineGenerator     (sea level intersection)

SettlementPlanner
  ├── SeedPointSelector      (crossroads, ford, harbor, hilltop)
  ├── GrowthSimulator        (phase-based expansion)
  ├── RoadNetworkGenerator   (organic or planned streets)
  └── LandUseAllocator       (zoning: residential, commercial, industrial)

DistrictGenerator
  ├── BlockSubdivider        (lot subdivision along streets)
  ├── BuildingPlacer         (footprint generation per lot)
  └── LandmarkPlacer         (churches, castles, markets)

Renderer
  ├── SVGRenderer            (current)
  ├── CanvasRenderer         (for interactive use)
  └── TileRenderer           (for very large maps)
```

---

## 12. Scaling: Village to Megalopolis

### 12.1 Current Scale Limits

| n_patches | Approx. buildings | Generation time | Realism quality |
|-----------|-------------------|-----------------|-----------------|
| 3-6 | 20-60 | ~50ms | OK for hamlet |
| 10-15 | 80-200 | ~200ms | Good for small town |
| 20-30 | 200-500 | ~500ms | Decent medieval town |
| 40-60 | 500-1000 | ~2s | Starts looking uniform |
| 100+ | Not supported | Would be very slow | Would need new approach |

### 12.2 Why Large Cities Won't Work with Current Architecture

1. **Voronoi O(n^2):** 100 patches = 800 points = ~640,000 triangle tests
2. **A* O(V^2) per path:** Graph grows quadratically with patches
3. **Single wall ring:** Can't represent complex fortification histories
4. **Uniform ward pool:** Same distribution at any scale
5. **Single center:** All roads converge to one point

### 12.3 Multi-Settlement Approach

For a megalopolis with 5 rivers and 2 islands:

```
1. TERRAIN LAYER
   - Generate heightmap with 5 river valleys
   - Compute river paths (gradient descent)
   - Identify 2 islands as enclosed contours above sea level
   - Compute floodplains, hilltops, coastal zones

2. SETTLEMENT SEEDS
   - Place initial settlements: ford crossings, harbor sites, hilltops
   - Each seed gets: founding era, culture, initial size
   - Example: City A (ford, 800 AD), City B (island, 900 AD), City C (harbor, 1000 AD)

3. GROWTH SIMULATION (per era)
   - Each settlement grows radially, following roads
   - Growth blocked by: rivers (until bridges), steep terrain, other settlements
   - Walls built when settlement reaches threshold size
   - Settlements merge when growth areas overlap → new connecting roads

4. DISTRICT GENERATION
   - Apply current pipeline to each settlement's growth ring independently
   - Bridge connections between settlements
   - Waterfront districts along rivers
   - Island districts with their own internal structure

5. INFRASTRUCTURE
   - Major roads connecting settlements
   - Bridges at narrowest river points
   - Harbor facilities at coast/river junctions
   - Market squares at road intersections
```

### 12.4 Parallelization Strategy

The current pipeline is inherently sequential. To scale:

```
Phase 1 (Parallelizable):
  - Terrain generation (independent)
  - River path computation (per river, independent)
  - Settlement seed placement (after terrain)

Phase 2 (Per-settlement, parallelizable):
  - Voronoi generation (independent per settlement)
  - Ward assignment (independent per settlement)
  - Building geometry (independent per ward)

Phase 3 (Sequential):
  - Inter-settlement connections (roads, bridges)
  - Global consistency checks
  - SVG rendering (can be parallelized per layer)
```

Python's GIL prevents true thread parallelism for CPU-bound work. Options:
- `multiprocessing` for per-settlement generation
- `concurrent.futures.ProcessPoolExecutor` for building geometry
- Cython/Rust extension for Voronoi triangulation
- WebAssembly compilation for browser-side generation

---

## 13. Performance Analysis & Optimization

### 13.1 Current Bottlenecks (Profiled)

| Stage | Complexity | Bottleneck |
|-------|-----------|------------|
| Voronoi build | O(n^2) | Triangle circumcircle test per insertion |
| Voronoi relax | O(n^2) * 3 | Full rebuild 3 times |
| Circumference | O(E * P) | Edge scan per patch |
| Junction optimize | O(V * P) | Vertex scan per patch |
| A* pathfinding | O(V^2) per path | List-based open set |
| create_alleys | O(n log n) | Recursive bisection (fine) |
| Water filtering | O(B * W) | Ray casting per building vertex per water polygon |
| SVG rendering | O(elements) | String concatenation (fine) |

Where n=points, E=edges, P=patches, V=graph vertices, B=buildings, W=water polygon vertices.

### 13.2 Quick Wins

1. **A* priority queue:** Replace `open_set.pop(0)` with `heapq`. Add Euclidean heuristic. → O(E + V log V) instead of O(V^2)

2. **Spatial indexing for water tests:** Build a grid over the water polygon. Pre-mark cells as wet/dry/boundary. Only ray-cast for boundary cells. → O(1) average instead of O(W)

3. **Voronoi via scipy:** `scipy.spatial.Delaunay` uses Qhull (O(n log n)). Would need adapter to preserve Region/Triangle API.

4. **Circumference via half-edge:** Replace edge scanning with half-edge data structure. Boundary extraction becomes O(boundary edges).

5. **Parallel building generation:** Each ward's `create_geometry()` is independent. Use ProcessPoolExecutor.

### 13.3 Algorithmic Upgrades

| Current | Upgrade | Speedup |
|---------|---------|---------|
| Bowyer-Watson O(n^2) | Fortune's sweep O(n log n) | ~10x at 1000 points |
| BFS-Dijkstra O(V^2) | A* with heapq O(E + V log V) | ~5x at 500 nodes |
| Ray casting O(n) | Grid acceleration O(1) amortized | ~50x for dense queries |
| Full Voronoi rebuild for relax | Incremental point movement | ~3x |
| Sequential ward geometry | Parallel per-ward | ~Px (P = cores) |

---

## 14. Extension Catalog

### 14.1 Near-Term Enhancements (within current architecture)

| Feature | Effort | Impact | How |
|---------|--------|--------|-----|
| Ward-colored buildings | Small | High | Add color per ward type in palette |
| Labels on map | Small | Medium | Render `get_label()` as SVG text |
| More palettes | Small | Medium | Add new Palette instances |
| Tower spacing | Small | Medium | Skip towers too close together |
| Multiple building styles per ward | Medium | High | Ward-specific style overrides |
| Height/stories attribute | Medium | High | Add `stories` field, render as shadow |
| Better ring roads | Medium | Medium | Use graph BFS at radius instead of vertex snapping |
| Concentric walls | Medium | High | Multiple CurtainWall instances |
| Neighborhood names | Small | High | Random name generator per ward type |

### 14.2 Medium-Term Features (architecture changes needed)

| Feature | Effort | Impact | How |
|---------|--------|--------|-----|
| Multiple rivers | Large | High | List[River] + confluence logic |
| Islands | Large | High | Closed coast polygons, bridge connections |
| Linear villages | Large | High | New VillageModel class |
| Grid-planned districts | Large | High | New CityBlock subdivider for regular grids |
| Terrain heightmap | Large | Very High | Perlin noise + erosion simulation |
| Road hierarchy | Medium | High | Primary/secondary/tertiary street widths |
| Harbor/waterfront | Medium | High | Special ward type with docks/piers |
| City growth animation | Medium | High | Render each growth phase as a frame |
| Interactive editing | Large | Very High | Click to change ward type, drag to reshape |

### 14.3 Long-Term Vision (new architecture)

| Feature | Effort | Impact | How |
|---------|--------|--------|-----|
| Multi-settlement regions | Very Large | Very High | Multiple Model instances + connections |
| Historical growth simulation | Very Large | Very High | Agent-based or L-system growth |
| 3D rendering | Very Large | Very High | Three.js or Blender export |
| Real terrain data | Large | Very High | Import DEM/OSM data as constraints |
| Cultural templates | Large | High | Era/culture → ward pool + street style + building grammar |
| Procedural building interiors | Very Large | Medium | Room subdivision per building footprint |
| Population simulation | Very Large | High | Agent-based: homes, workplaces, movement patterns |
| Export to game engines | Large | High | Tile-based export, navmesh generation |

### 14.4 Constraint Environment System

For the "5 rivers, 2 islands, constrained terrain" scenario, a new constraint system is needed:

```python
class EnvironmentConstraints:
    rivers: list[RiverConstraint]       # path hints, width, flow direction
    coastlines: list[CoastConstraint]   # shape, orientation
    islands: list[IslandConstraint]     # position, size, shape
    hills: list[HillConstraint]         # position, height, radius
    roads_in: list[RoadConstraint]      # entry points, directions

class RiverConstraint:
    entry_angle: float
    exit_angle: float
    width: float
    tributaries: list[RiverConstraint]

class IslandConstraint:
    center: Point
    radius: float
    shape: str  # "round", "elongated", "irregular"
    has_settlement: bool
    bridge_to: list[str]  # connection targets
```

The generator would then:
1. Lay out water features according to constraints
2. Identify buildable land areas
3. Place settlement seeds at strategic locations
4. Grow each settlement independently
5. Connect with bridges and roads
6. Render the unified map

---

## Appendix A — File Reference

| File | Lines | Role |
|------|-------|------|
| `geom/point.py` | 93 | Mutable 2D point, identity semantics |
| `geom/polygon.py` | 541 | Core polygon operations (30+ methods) |
| `geom/voronoi.py` | 271 | Delaunay triangulation + Voronoi regions |
| `geom/graph.py` | 95 | Graph + A* pathfinding |
| `geom/segment.py` | 30 | Simple line segment |
| `geom/spline.py` | 32 | Catmull-Rom spline curves |
| `geom/geom_utils.py` | 42 | Line intersection, interpolation, cross product |
| `utils/random.py` | 49 | Park-Miller LCG PRNG |
| `utils/math_utils.py` | ~10 | sign() function |
| `utils/array_utils.py` | ~40 | min_by, max_by, random_element, etc. |
| `building/model.py` | 686 | Main pipeline orchestrator |
| `building/patch.py` | 25 | Polygon + ward assignment wrapper |
| `building/topology.py` | 86 | Street graph from patches |
| `building/curtain_wall.py` | 161 | Walls, gates, towers |
| `building/cutter.py` | 102 | Polygon bisection, radial/ring cutting |
| `building/river.py` | 171 | River generation + bridge detection |
| `building/coast.py` | 142 | Coast generation |
| `wards/ward.py` | 489 | Base ward + building style transforms |
| `wards/common_ward.py` | 43 | Grid-based ward template |
| `wards/castle.py` | 73 | Castle keep + wings + towers |
| `wards/cathedral.py` | 101 | Cruciform church plan |
| `wards/market.py` | 90 | Market square + stalls |
| `wards/park.py` | 17 | Radial/semi-radial sectors |
| `wards/farm.py` | 24 | Single farmhouse |
| `wards/craftsmen.py` | 21 | Dense irregular buildings |
| `wards/merchant.py` | 27 | Larger buildings, near center |
| `wards/slum.py` | 27 | Dense chaotic buildings, far from center |
| `wards/patriciate.py` | 34 | Large buildings, near parks |
| `wards/administration.py` | 28 | Orderly grid, near plaza |
| `wards/military.py` | 32 | Barracks, near citadel/walls |
| `wards/gate_ward.py` | 20 | Mixed buildings at gates |
| `wards/shanty_town.py` | 32 | Very dense, outside walls |
| `rendering/svg_renderer.py` | 291 | SVG output, layered drawing |
| `rendering/palette.py` | 37 | 8 color palettes |
| `rendering/png_renderer.py` | ~20 | SVG→PNG via cairosvg |
| `webapp/app.py` | 88 | FastAPI web interface |
| `cli.py` | 82 | Command-line interface |

## Appendix B — Algorithm Complexity Summary

| Algorithm | Where | Time | Space |
|-----------|-------|------|-------|
| Bowyer-Watson triangulation | voronoi.py | O(n^2) | O(n) |
| Lloyd relaxation | voronoi.py | O(n^2) per round | O(n) |
| Circumference extraction | model.py | O(E * P) | O(E) |
| Junction optimization | model.py | O(V * P) | O(V) |
| A* pathfinding | graph.py | O(V^2) per path | O(V) |
| Midpoint displacement | river.py, coast.py | O(2^depth) | O(2^depth) |
| Chaikin smoothing | river.py, coast.py | O(n) per iteration | O(n) |
| Recursive bisection | ward.py | O(n log n) | O(n) |
| Polygon cut | polygon.py | O(edges) | O(edges) |
| Buffer (self-intersection) | polygon.py | O(n^2) | O(n) |
| Ray casting (water test) | river.py, coast.py | O(polygon vertices) | O(1) |
| SVG rendering | svg_renderer.py | O(total elements) | O(output size) |

## Appendix C — Glossary

| Term | Meaning |
|------|---------|
| **Patch** | A Voronoi cell representing a city district. Contains a shape (Polygon) and a ward assignment |
| **Ward** | The functional type of a district (Market, Slum, Cathedral, etc.) with its building generation logic |
| **Artery** | A major street segment chain connecting gates to the city center |
| **Gate** | An opening in the city wall where a road exits |
| **Citadel** | A fortified district (castle) at the edge of the city, with its own wall |
| **Plaza** | The central market square (if enabled), always the innermost patch |
| **CommonWard** | Ward subclass using recursive bisection for building generation |
| **Bisection** | Cutting a polygon along a line perpendicular to its longest edge |
| **City block** | The buildable area within a patch, after insetting for streets and walls |
| **Grid chaos** | Parameter controlling how far cutting angles deviate from perpendicular (0 = grid, 1 = organic) |
| **Size chaos** | Parameter controlling variation in building sizes within a ward |
| **Midpoint displacement** | Fractal curve generation: recursively split + perpendicular offset |
| **Chaikin smoothing** | Corner-cutting curve subdivision: [P0, P1] → [0.75*P0+0.25*P1, 0.25*P0+0.75*P1] |
| **Park-Miller LCG** | Linear congruential PRNG: seed = (seed * 48271) mod (2^31 - 1) |
| **Identity semantics** | Using Python's `is` operator (object identity) instead of `==` (value equality) |
