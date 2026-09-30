# Urban geometry — how space is built and divided

**Principle: partition, never place.** Urban space is built as a *hierarchy of exact partitions*: region → quarters → blocks → plots → built/unbuilt parts of each plot. Every level divides the level above with no gaps and no overlaps, by construction. Nothing is "placed then checked for collisions". Streets are not objects laid over the land: they are the *cuts* of the partition, given a width. Overlaps become impossible, and every plot has street access because of how the pieces are cut.

The failed first attempt (branch `wip/m3-sonnet-attempt`) grew streets, then placed plots and buildings independently and tried to avoid collisions. The result was overlapping wedges and meaningless shapes. Do not repeat that design.

References:
- Yang, Wang, Vouga, Wonka (2013), *Urban Pattern: Layout Design by Hierarchical Domain Splitting* (SIGGRAPH Asia): streamline-guided recursive splitting.
- Vanegas, Kelly, Weber, Halatsch, Aliaga, Müller (2012), *Procedural Generation of Parcels in Urban Modeling*: straight-skeleton strips and OBB splitting.
- Chen et al. (2024), *Hierarchical Co-generation of Parcels and Streets*.
- Weber et al. (2009), *Interactive Geometric Simulation of 4D Cities*: growth over time.
- Conzen (1960): the burgage cycle.
- watabou's Medieval Fantasy City Generator: Voronoi wards plus recursive bisection. That design is the baseline to beat, not a model to copy.

## 0. Geometry kernel (`src/gen/geo/`)

- **Units and precision**: meters. Snap all constructed coordinates to a 1 cm grid (`Math.round(v*100)/100`). Remove duplicate and collinear vertices (angle < 1°) and edges shorter than 0.3 m after every boolean operation. Validate simplicity; if a polygon self-intersects, repair it with `polygon-clipping.union(p)` and keep the largest piece.
- **Booleans**: `polygon-clipping` (union, intersection, difference) on MultiPolygons.
- **Straight skeleton**: npm `straight-skeleton` (CGAL compiled to WASM, async `SkeletonBuilder.init()`; it returns faces per input edge). Initialize it once in the worker and in tests. It must stay compatible with the single-file build: inline the wasm as base64 if needed. Fallback: port `town_generator/detail/skeleton.py` (Felkel & Obdržálek), but CGAL is preferred for robustness.
- **Planar street graph** (`graph.ts`): nodes and edges. Edge attributes: `width`, `rank` (0 arterial … 4 cul-de-sac), `phase`, `kind` (street, lane, ring, quay, wall-lane). Insertion of a polyline:
  - split it against existing edges at intersections;
  - snap endpoints to a node within `snapR` (3 m), or onto an edge within `snapR` (split that edge);
  - reject near-parallel overlaps: a new segment within 4 m of an existing one at an angle < 15° is merged, not duplicated.
  
  **Face extraction**: sort half-edges by angle at each node, walk next = twin.prev, drop the outer face. Dangling edges (cul-de-sacs) are kept. The face walk goes around them, and they are handled at block level (§2.4).
- **Spatial index**: uniform grid hash for segments and polygons, used for snapping and for the tests.

## 1. Level 1 — Phases and quarters

1. **Phase regions**:
   - `R_1 ⊂ R_2 ⊂ … ⊂ R_n` are nested cost-isolines of the travel-cost field from the nucleus, smoothed (Chaikin twice, then simplified with RDP at 2 m) and clipped to buildable land. Their areas follow the population target and the densities.
   - **Faubourg phases** are ribbons: the road polyline buffered by 40–70 m, minus the enclosed city.
   - For each ring k ≥ 2, `ring_k = R_k \ R_{k-1}`.
2. **Primary streets** go into the graph:
   - **radials**: the regional roads inside `R_n`, from the gates to the nucleus. If the town is large and a sector has an angular gap of more than 70°, add an extra radial, a streamline of the radial field from the ring to the nucleus.
   - **rings**: the boundary of each older `R_k` (k < n) that is fossilized. It becomes a closed ring street, the old wall line.
   - **the wall**: the boundary of `R_n` (when walled). It is not a street, but an inner wall-lane may be added.
   - **water edges**: quays along the river or coast inside the town, if a harbor exists.
3. **Quarters** are the faces of this graph. They are already a partition, and each quarter knows its phase.
4. The **nucleus** is reserved first: the market place polygon at the meeting of the radials, and the church or castle lots. It is carved as a face, or a sub-face split off with a street.

## 2. Level 2 — Blocks by guided recursive splitting

Each quarter is split recursively. **Every cut is a street.** Stop when the piece is a good block.

### 2.1 Guidance field (per morphology)

A direction field `θ(p)` gives the preferred street directions at each point:
- **european-organic**: a cross-field built from `radial(p)` (toward the nucleus) and `tangential(p)` (radial + 90°). On slopes above 6 %, blend it toward the contour direction, since streets follow contours and climb with lanes. Then add low-frequency angular noise (±12°, wavelength ~150 m) for the organic effect.
- **grid / bastide / chinese**: a constant orientation (cardinal, or aligned to the main road) plus `gridSkew` noise.
- **medina**: radial for the gate-to-gate spines, then *no* global field for the derbs (see §2.4).

### 2.2 One split step

Input: a piece P (polygon) and its level ℓ.
1. Candidate orientations are the two cross-field directions at P's centroid. Prefer the one most perpendicular to P's long axis (from its oriented bounding box). This mostly avoids long thin blocks.
2. Candidate positions: 3–5 seeds along the long axis at t ∈ [0.35, 0.65], with random jitter.
3. For each seed, **trace a streamline** of the chosen direction family both ways until it leaves P. Integrate with steps of 5 m, and constrain curvature so the heading changes at most `curvature` × 10° per 10 m.
4. Snap the ends to P's boundary. If an end lands within 6 m of an existing node, snap to that node, so streets meet at shared junctions instead of offset jogs.
5. **Split** P along the polyline into P₁ and P₂. The polyline must cross P exactly once (reject it otherwise).
6. **Score** the split and keep the best candidate:
   - rejected outright if a piece has area < `minBlock`, width < `minWidth` (the straight-skeleton max offset × 2), or a corner angle < 25° (unless that corner becomes a place, §2.3);
   - otherwise scored on area balance, on the angle between the cut and the existing streets (T or Y junctions between 60° and 120° are preferred), and on straightness where the morphology wants it.
7. Add the cut to the graph with `rank = min(4, ℓ+1)` and `width = widthByRank × widthScale`, with width jitter along the edge.
8. Recurse on P₁ and P₂ with level ℓ+1, until the area is in `blockSize` (drawn per piece with variance, smaller near the nucleus and in older phases).

If no valid split exists for a piece, stop: it is a block. Some large blocks are fine, and they give interior gardens.

### 2.3 Places (squares) are pieces, not holes

- Small triangular pieces created at acute forks (area < 400–900 m², or a corner angle < 35°) become **places**: open paved spaces, often with a well or a cross.
- The market is a piece reserved in §1.4.
- Churchyards and parvises are pieces reserved when landmarks are assigned. Those lots are claimed before plots are cut.

### 2.4 Cul-de-sacs, closes and courts (medina, European yards)

A dead-end is a *slit* into a block: a polyline from a street edge into the block interior, of length ≤ 60 % of the block depth, buffered to its width (2–3 m). The block becomes `block \ buffer(slit)`, which is still a single polygon, now with a notch. Plots may front the slit (§3), which is how medina derbs and European courts (*cours*, *closes*, *Höfe*) serve deep blocks.

For **medina** (the `culDeSacTree` operator): recursive tree of slits from the spine streets, with branching angle 60–110°, depth 3–4, and `deadEndRatio` controlling it. Plots are then cut as courtyard houses (§3.3).

### 2.5 From faces to block polygons (exact)

`block = face \ ⋃ ribbon(edge)`. A ribbon is the polyline buffered by `width/2`, with a round join at nodes of degree ≥ 3 (which gives slightly rounded corners, a natural look) and a flat cap at dead ends. Do the difference once per quarter, not globally, for speed. The result is a partition of the land into street space and blocks.

**Block vs street is exact.** Street space is `quarter \ ⋃ blocks`, and render it as one polygon per quarter. Consecutive blocks never overlap, because they come from disjoint faces minus the ribbons.

## 3. Level 3 — Plots (parcels)

### 3.1 Frontage classification

Classify each block edge by the street it faces: find the nearest ribbon and its rank. Walls, water and quarter boundaries without a street are *non-frontage*. Merge consecutive frontage edges whose turn is < 20° into **frontage runs**, which are polylines.

### 3.2 Burgage plots (european-organic, bastide, hanseatic, machiya): skeleton strips (Vanegas 2012, skeleton method)

1. Compute the **straight skeleton** of the block. Each block edge owns one skeleton face.
2. **α-strips**: union the skeleton faces of each frontage run into one strip per run.
3. **β-strips (corners)**:
   - The skeleton assigns corner regions diagonally. Reassign each corner triangle to the run of the *more important* street (lower rank, or longer run). This gives corner plots that face the main street, with no diagonal plot boundaries.
   - Faces of non-frontage edges are merged into the adjacent strips.
4. **Depth cap**:
   - Plot depth `d` is drawn per run: core 25–45 m, outer 35–70 m, and the whole strip when the block is shallow.
   - Intersect each strip with the offset band `{p : dist(p, run) ≤ d}`. Compute it as the block minus the inward offset of the block at distance d (polygon-clipping with an offset polygon from the skeleton), or with half-planes per run segment.
   - The remaining **back land** (the block core beyond the depth) becomes shared gardens or courtyards. In an old dense phase, it is instead split among the adjacent plots by extending their side lines (the burgage cycle, §4).
5. **Cutting a strip into plots**:
   - Walk along the frontage run and cut every `w`, where `w` is drawn per zone (core 4–7 m, middle 6–10 m, edge 10–20 m; merchant and rich plots up to 2–3 w).
   - The cut direction is the **inward normal of the run at that point**. On curved runs this fans the plots naturally.
   - Add a small random tilt (±6°), and keep the side lines of neighbouring plots nearly parallel.
   - Each cut is a straight segment across the strip. Clip the strip by the half-planes between consecutive cuts (exact, since a strip is a skeleton region whose cross-sections are simple).
   - If a strip is non-convex and a cut would cross it twice, split along the skeleton arc instead.
6. **Cleanup**:
   - Merge plots with area < 35 m² or a frontage < 3 m into their neighbour along the same run.
   - Drop spikes: any vertex angle < 15° is removed by intersecting with a slightly smaller polygon.

**Each plot then has a frontage segment on a street, and plots partition the strip exactly.**

### 3.3 Courtyard houses (medina, siheyuan, haveli, Roman domus)

Recursive **OBB splitting** (Vanegas 2012, OBB method), constrained by access:
- Split the block perpendicular to its OBB long axis, near the middle (40–60 %).
- Accept a split only if both halves keep ≥ 3 m of frontage on a street *or a slit* (§2.4). Otherwise try the other axis, or add a slit.
- Stop when the area is in the house range: medina 80–400 m², siheyuan 300–1 200 m².
- Houses are inward-facing, so the plots are compact (aspect ratio < 2) rather than deep strips.

### 3.4 Compounds

Large lots are claimed *before* plot cutting: temple, palace, monastery, samurai *yashiki*, castle bailey. They take a whole block, or the union of adjacent plots along a run.

## 4. Level 4 — Built / unbuilt inside each plot (never leaves the plot)

Every footprint is computed as **plot ∩ (a region defined relative to the plot's own frontage and sides)**. A building therefore can never leave its plot or overlap a neighbour. Adjacent buildings share walls exactly, and the union of a block's buildings forms continuous masses.

- **Front range** (`streetFrontRow`): `plot ∩ band(frontage, depth_b)`, with `depth_b` 8–14 m. Apply a setback of 0–0.5 m in the core and 0.5–3 m outside it (half-plane shift). For side gaps outside the core, shrink by 0.5–2 m from one or both side lines.
- **Burgage cycle, driven by `infill` ∈ [0, 1]** (higher for old phases, high density and the core):
  - `infill > 0.3`: a rear wing `plot ∩ band(sideLine, 3–5 m)`, from the front range to 60–90 % of the depth.
  - `infill > 0.6`: back buildings `plot ∩ band(rear, 6–10 m)`, plus a wing on the second side. A courtyard of at least 3 × 3 m stays free.
  - `infill > 0.85`: the plot is fully built except a light well or courtyard (the plot's straight-skeleton inset at 1.5–3 m, kept only if its area is > 9 m²).
- **Courtyard house**: `plot \ inset(plot, depth 5–8 m)` gives the ring of rooms. The courtyard is the inset. Keep a blank wall to the street, with the entrance on the frontage.
- **Detached** (suburbs and villages): a rectangle of 6–10 × 8–14 m aligned with the frontage and intersected with the plot. Barn and outbuildings are placed along the rear or side edges, again intersected with the plot.
- **Render**: union the buildings per block into masses, keeping the holes (courtyards). Outline the masses. Draw the individual plot lines as a faint hairline over the roofs, so the fabric reads like Nolli or Merian, not like isolated boxes.

## 5. Villages and hamlets (same kernel, different top level)

- **Hamlet**: no street network. There are 3–15 farmsteads, and each farmstead is a plot. Plots are cut from the land along tracks: a strip along the track, cut into wide farm plots of 25–60 m. The front range becomes house and barn around a yard (a U or L built along the plot edges). The rest of the plot is garden or orchard.
- **Village archetypes** only change level 1 and level 2:
  - *street village*: one axis street, plus back lanes;
  - *green village* (Anger): two streets enclosing a lens-shaped green (the green is a place piece);
  - *round village* (Rundling): a circular place with plots fanning out;
  - *nucleated*: short radials plus 1–2 rings;
  - *circulade*: concentric rings around a church or castle on a hilltop.

## 6. Invariants (tests, run on seeds × sizes × morphologies)

1. Σ area(children) = area(parent) ± 0.5 % at every level: quarters → blocks + street space; blocks → plots + back land; plots → built + unbuilt.
2. There is no pairwise overlap > 0.05 m² among blocks, among plots, or among buildings. Check with the spatial index and polygon-clipping intersection.
3. Every plot has ≥ 3 m of frontage within 0.2 m of a street ribbon or slit.
4. Every building is inside its plot; `area(b \ plot) < 0.05 m²`.
5. There is no polygon with a vertex angle < 12° or a width < 2 m (except street slivers inside the street space).
6. The street graph is connected, and every rank ≤ 2 street connects to a gate or to the nucleus.
7. Determinism.
8. Performance: a town (5 k) takes < 1.5 s for the urban stages; a city (50 k) < 5 s; and a lazily generated quarter at megacity scale < 300 ms.

## 7. Parameters (per morphology, in `MorphologyParams`)

| parameter | meaning |
|---|---|
| `curvature` | streamline heading change |
| `fieldNoise` | amplitude of the angular noise in the guidance field |
| `blockSize[min,max]` | target block areas |
| `minBlock`, `minWidth` | limits for a valid block |
| `widthByRank[]`, `widthScale`, `widthJitter` | street widths |
| `placeThreshold` | when a fork piece becomes a place |
| `deadEndRatio`, `slitDepth` | dead ends |
| `frontage[zone]`, `plotDepth[zone]`, `plotTilt` | plot cutting |
| `buildDepth`, `setback`, `sideGap` | front range |
| `infill` (phase age × density) | burgage cycle |
| `courtyardMin` | smallest courtyard kept |

These parameters are the dials the culture presets (URBAN_MORPHOLOGY.md) turn.
