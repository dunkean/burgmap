"""Flow-based river network generation.

Rivers follow the terrain downhill using D8 flow direction and flow
accumulation.  This produces natural dendritic networks with proper
confluences at acute angles.

Pipeline:
1. Perturb elevation with multi-scale noise (creates meander variation)
2. Fill sinks (priority-flood with epsilon for flat area drainage)
3. Compute D8 flow direction for every cell
4. Compute flow accumulation (how many upstream cells drain here)
5. Find the N highest-accumulation exit points on map edges / coast
6. Trace upstream from each exit to build river centerlines
7. Smooth: Douglas-Peucker simplify → Catmull-Rom spline → final thin
"""

from __future__ import annotations

import math
import random as stdlib_random
from dataclasses import dataclass, field

from town_generator.terrain.noise import SimplexNoise
from town_generator.terrain_v2.scales import MapScale


@dataclass
class RiverSegment:
    centerline: list[tuple[float, float]] = field(
        default_factory=list,
    )
    widths: list[float] = field(default_factory=list)
    is_tributary: bool = False
    parent_index: int | None = None

    def to_dict(self) -> dict:
        return {
            "centerline": [
                [round(x, 2), round(y, 2)]
                for x, y in self.centerline
            ],
            "widths": [round(w, 2) for w in self.widths],
            "is_tributary": self.is_tributary,
        }


@dataclass
class RiverNetwork:
    segments: list[RiverSegment] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"segments": [s.to_dict() for s in self.segments]}


# D8 directions: (dx, dy) for 8 neighbors
_D8_DX = [-1, 0, 1, -1, 1, -1, 0, 1]
_D8_DY = [-1, -1, -1, 0, 0, 1, 1, 1]
_D8_DIST = [
    math.sqrt(2), 1.0, math.sqrt(2),
    1.0, 1.0,
    math.sqrt(2), 1.0, math.sqrt(2),
]


def generate_rivers(
    seed: int,
    scale: MapScale,
    n_rivers: int,
    elevation: list[list[float]],
    sea_mask: list[list[bool]] | None = None,
) -> RiverNetwork:
    """Generate a river network that follows the terrain."""
    if n_rivers <= 0:
        return RiverNetwork()

    size = scale.grid_size
    base_w = scale.river_base_width_m

    # 1. Perturb elevation slightly for meander variation
    perturbed = _perturb_elevation(seed, size, elevation, scale)

    # 2. Fill sinks (essential for continuous drainage network)
    filled = _fill_sinks(perturbed, size, sea_mask)

    # 3. Compute D8 flow directions on filled surface
    flow_dir = _compute_flow_directions(filled, size, sea_mask)

    # 4. Compute flow accumulation
    accumulation = _compute_flow_accumulation(flow_dir, size)

    # 5. Find exit points (edge cells or sea-adjacent cells)
    exits = _find_exit_points(
        accumulation, flow_dir, size, sea_mask,
    )

    # 6. Take top N exits, trace upstream to build river trees
    segments = _build_river_segments(
        exits, n_rivers, accumulation, flow_dir,
        size, base_w, scale.cell_m,
    )

    return RiverNetwork(segments=segments)


def _fill_sinks(
    elevation: list[list[float]],
    size: int,
    sea_mask: list[list[bool]] | None,
) -> list[list[float]]:
    """Fill sinks using priority-flood with epsilon gradient.

    Ensures every cell can drain to a map edge or sea cell.
    Adds a tiny epsilon to filled cells so flat areas have a
    gentle slope toward the drain point (prevents flow stagnation).
    """
    import heapq

    # Tiny increment to ensure filled areas slope toward drain
    eps = 1e-5

    filled = [row[:] for row in elevation]
    visited = [[False] * size for _ in range(size)]

    # Priority queue: (elevation, x, y)
    pq: list[tuple[float, int, int]] = []

    # Seed with all edge cells and sea-adjacent cells
    for y in range(size):
        for x in range(size):
            is_border = (
                x == 0 or x == size - 1
                or y == 0 or y == size - 1
            )
            is_sea = sea_mask[y][x] if sea_mask else False
            if is_border or is_sea:
                heapq.heappush(pq, (elevation[y][x], x, y))
                visited[y][x] = True

    # Process from lowest to highest
    while pq:
        elev, x, y = heapq.heappop(pq)

        for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1),
                       (-1, -1), (1, -1), (-1, 1), (1, 1)]:
            nx, ny = x + dx, y + dy
            if not (0 <= nx < size and 0 <= ny < size):
                continue
            if visited[ny][nx]:
                continue
            visited[ny][nx] = True

            if sea_mask and sea_mask[ny][nx]:
                heapq.heappush(pq, (filled[ny][nx], nx, ny))
                continue

            # If neighbor is lower or equal, raise it slightly
            # above current cell to create drainage slope
            if filled[ny][nx] <= elev:
                filled[ny][nx] = elev + eps
            heapq.heappush(pq, (filled[ny][nx], nx, ny))

    return filled


def _perturb_elevation(
    seed: int,
    size: int,
    elevation: list[list[float]],
    scale: MapScale,
) -> list[list[float]]:
    """Add multi-scale noise perturbation for meander variation.

    Two noise layers:
    - Low frequency (meander wavelength ~20-40 cells): creates broad bends
    - Medium frequency (~8-15 cells): adds smaller wiggles

    Amplitude is 5% of max elevation — enough to deflect flow laterally
    in gentle slopes without reversing major ridges.
    """
    noise1 = SimplexNoise(seed + 5555)
    noise2 = SimplexNoise(seed + 7777)

    # Low-freq: features at ~30 cells → broad meanders
    freq_lo = scale.extent_m / 400.0 / size
    # Medium-freq: features at ~12 cells → small wiggles
    freq_hi = scale.extent_m / 150.0 / size

    amp = scale.max_elevation_m * 0.05

    result = []
    for y in range(size):
        row = []
        for x in range(size):
            n = (
                noise1.noise2d(x * freq_lo, y * freq_lo) * 0.7
                + noise2.noise2d(x * freq_hi, y * freq_hi) * 0.3
            )
            row.append(elevation[y][x] + n * amp)
        result.append(row)
    return result


def _compute_flow_directions(
    elevation: list[list[float]],
    size: int,
    sea_mask: list[list[bool]] | None,
) -> list[list[int]]:
    """Compute D8 flow direction for each cell.

    Each cell points to its steepest-descent neighbor (0-7).
    Value -1 means no outflow (pit or edge).
    Value -2 means sea cell (skip).
    """
    flow = [[-1] * size for _ in range(size)]

    for y in range(size):
        for x in range(size):
            if sea_mask and sea_mask[y][x]:
                flow[y][x] = -2
                continue

            best_dir = -1
            best_drop = 0.0
            e = elevation[y][x]

            for d in range(8):
                nx = x + _D8_DX[d]
                ny = y + _D8_DY[d]
                if 0 <= nx < size and 0 <= ny < size:
                    drop = (e - elevation[ny][nx]) / _D8_DIST[d]
                    if drop > best_drop:
                        best_drop = drop
                        best_dir = d
                elif _is_edge(x, y, size):
                    # Flow off the map edge
                    drop = e / _D8_DIST[d]
                    if drop > best_drop:
                        best_drop = drop
                        best_dir = d

            flow[y][x] = best_dir

    return flow


def _is_edge(x: int, y: int, size: int) -> bool:
    return x == 0 or x == size - 1 or y == 0 or y == size - 1


def _compute_flow_accumulation(
    flow_dir: list[list[int]],
    size: int,
) -> list[list[int]]:
    """Compute flow accumulation: how many cells drain through each cell.

    Uses topological sort approach for efficiency.
    """
    # Count incoming flows for each cell
    in_count = [[0] * size for _ in range(size)]
    for y in range(size):
        for x in range(size):
            d = flow_dir[y][x]
            if d < 0:
                continue
            nx = x + _D8_DX[d]
            ny = y + _D8_DY[d]
            if 0 <= nx < size and 0 <= ny < size:
                in_count[ny][nx] += 1

    # Initialize accumulation to 1 (each cell contributes itself)
    accum = [[1] * size for _ in range(size)]

    # Queue: start with cells that have no incoming flow (sources)
    queue: list[tuple[int, int]] = []
    for y in range(size):
        for x in range(size):
            if in_count[y][x] == 0 and flow_dir[y][x] >= 0:
                queue.append((x, y))

    # Process in topological order
    head = 0
    while head < len(queue):
        x, y = queue[head]
        head += 1

        d = flow_dir[y][x]
        if d < 0:
            continue
        nx = x + _D8_DX[d]
        ny = y + _D8_DY[d]
        if 0 <= nx < size and 0 <= ny < size:
            accum[ny][nx] += accum[y][x]
            in_count[ny][nx] -= 1
            if in_count[ny][nx] == 0 and flow_dir[ny][nx] >= 0:
                queue.append((nx, ny))

    return accum


def _find_exit_points(
    accumulation: list[list[int]],
    flow_dir: list[list[int]],
    size: int,
    sea_mask: list[list[bool]] | None,
) -> list[tuple[int, int, int]]:
    """Find cells where rivers exit the map or reach the sea.

    Returns list of (x, y, accumulation) sorted by accumulation desc.
    """
    exits: list[tuple[int, int, int]] = []

    for y in range(size):
        for x in range(size):
            d = flow_dir[y][x]
            if d == -2:  # sea cell
                continue

            is_exit = False

            # Flows off map edge
            if d >= 0:
                nx = x + _D8_DX[d]
                ny = y + _D8_DY[d]
                if not (0 <= nx < size and 0 <= ny < size):
                    is_exit = True
                elif sea_mask and sea_mask[ny][nx]:
                    is_exit = True
            elif d == -1 and _is_edge(x, y, size):
                is_exit = True

            if is_exit and accumulation[y][x] > 1:
                exits.append((x, y, accumulation[y][x]))

    exits.sort(key=lambda e: e[2], reverse=True)
    return exits


def _build_river_segments(
    exits: list[tuple[int, int, int]],
    n_rivers: int,
    accumulation: list[list[int]],
    flow_dir: list[list[int]],
    size: int,
    base_width_m: float,
    cell_m: float,
) -> list[RiverSegment]:
    """Build river segments by tracing upstream from exit points.

    For each exit, trace the main channel upstream (always following
    the tributary with the highest accumulation at each confluence).
    Then collect significant tributaries as separate segments.
    """
    segments: list[RiverSegment] = []
    used = [[False] * size for _ in range(size)]

    # Minimum accumulation to be considered a tributary
    # (low enough to catch meaningful side-branches)
    min_accum = max(5, size // 8)

    for i in range(min(n_rivers, len(exits))):
        ex, ey, _ = exits[i]

        # Check this exit isn't already claimed by a bigger river
        if used[ey][ex]:
            # Try the next exit
            if i + n_rivers < len(exits):
                exits.append(exits[i + n_rivers])
            continue

        # Trace the main channel upstream
        main_path = _trace_upstream_main(
            ex, ey, accumulation, flow_dir, size, used,
        )
        if len(main_path) < 5:
            continue

        # Mark cells as used
        for px, py in main_path:
            ix, iy = int(px), int(py)
            if 0 <= ix < size and 0 <= iy < size:
                used[iy][ix] = True

        # Smooth: simplify → spline → thin
        smoothed = _smooth_river_path(main_path, max_points=200)
        max_accum = accumulation[ey][ex]
        widths = _compute_widths(
            smoothed, max_accum, base_width_m,
        )

        main_idx = len(segments)
        segments.append(RiverSegment(
            centerline=smoothed,
            widths=widths,
        ))

        # Find and add significant tributaries
        tribs = _find_tributaries(
            main_path, accumulation, flow_dir,
            size, used, min_accum,
        )
        for trib_path in tribs:
            for px, py in trib_path:
                ix, iy = int(px), int(py)
                if 0 <= ix < size and 0 <= iy < size:
                    used[iy][ix] = True

            t_smoothed = _smooth_river_path(trib_path, max_points=100)
            t_max_accum = max(
                accumulation[int(p[1])][int(p[0])]
                for p in trib_path
                if (0 <= int(p[0]) < size
                    and 0 <= int(p[1]) < size)
            )
            t_widths = _compute_widths(
                t_smoothed, t_max_accum, base_width_m * 0.5,
            )
            segments.append(RiverSegment(
                centerline=t_smoothed,
                widths=t_widths,
                is_tributary=True,
                parent_index=main_idx,
            ))

    return segments


def _trace_upstream_main(
    start_x: int,
    start_y: int,
    accumulation: list[list[int]],
    flow_dir: list[list[int]],
    size: int,
    used: list[list[bool]],
) -> list[tuple[float, float]]:
    """Trace the main channel upstream from an exit point.

    At each cell, find all cells that flow INTO this cell, and follow
    the one with the highest accumulation (the main branch).
    """
    path: list[tuple[float, float]] = [(float(start_x), float(start_y))]
    visited = set()
    visited.add((start_x, start_y))

    cx, cy = start_x, start_y

    for _ in range(size * 3):  # safety limit
        # Find all upstream neighbors (cells that flow into cx, cy)
        best_x, best_y = -1, -1
        best_accum = 0

        for d in range(8):
            nx = cx + _D8_DX[d]
            ny = cy + _D8_DY[d]
            if not (0 <= nx < size and 0 <= ny < size):
                continue
            if (nx, ny) in visited:
                continue
            # Check if (nx, ny) flows into (cx, cy)
            nd = flow_dir[ny][nx]
            if nd < 0:
                continue
            tx = nx + _D8_DX[nd]
            ty = ny + _D8_DY[nd]
            if tx == cx and ty == cy:
                a = accumulation[ny][nx]
                if a > best_accum:
                    best_accum = a
                    best_x, best_y = nx, ny

        if best_x < 0:
            break

        cx, cy = best_x, best_y
        visited.add((cx, cy))
        path.append((float(cx), float(cy)))

    # Reverse so path goes from source to mouth
    path.reverse()
    return path


def _find_tributaries(
    main_path: list[tuple[float, float]],
    accumulation: list[list[int]],
    flow_dir: list[list[int]],
    size: int,
    used: list[list[bool]],
    min_accum: int,
) -> list[list[tuple[float, float]]]:
    """Find significant tributaries joining the main channel.

    For each point on the main channel, check if there's an unused
    upstream neighbor with high accumulation (a tributary junction).
    """
    tributaries: list[list[tuple[float, float]]] = []
    main_set = set()
    for px, py in main_path:
        main_set.add((int(px), int(py)))

    for px, py in main_path:
        mx, my = int(px), int(py)

        for d in range(8):
            nx = mx + _D8_DX[d]
            ny = my + _D8_DY[d]
            if not (0 <= nx < size and 0 <= ny < size):
                continue
            if (nx, ny) in main_set or used[ny][nx]:
                continue

            # Check if this neighbor flows into the main channel
            nd = flow_dir[ny][nx]
            if nd < 0:
                continue
            tx = nx + _D8_DX[nd]
            ty = ny + _D8_DY[nd]
            if tx == mx and ty == my:
                a = accumulation[ny][nx]
                if a >= min_accum:
                    # Trace this tributary upstream
                    trib = _trace_upstream_main(
                        nx, ny, accumulation, flow_dir,
                        size, used,
                    )
                    if len(trib) >= 5:
                        # Add the junction point at the end
                        trib.append((float(mx), float(my)))
                        tributaries.append(trib)

    # Sort by length (longest first), limit to avoid clutter
    tributaries.sort(key=len, reverse=True)
    return tributaries[:4]


def _thin_path(
    points: list[tuple[float, float]],
    max_points: int = 200,
) -> list[tuple[float, float]]:
    """Subsample a path to at most max_points, keeping endpoints."""
    if len(points) <= max_points:
        return points
    step = (len(points) - 1) / (max_points - 1)
    result = []
    for i in range(max_points - 1):
        idx = int(i * step)
        result.append(points[idx])
    result.append(points[-1])
    return result


def _smooth_river_path(
    raw_path: list[tuple[float, float]],
    max_points: int = 200,
) -> list[tuple[float, float]]:
    """Transform a grid-aligned D8 path into a smooth natural river.

    Pipeline:
    1. Douglas-Peucker simplification — removes redundant grid-aligned
       points while preserving bends and direction changes.
    2. Catmull-Rom spline interpolation — generates a smooth C1 curve
       through the remaining waypoints.
    3. Final thin to max_points if needed.
    """
    if len(raw_path) < 4:
        return raw_path

    # 1. Douglas-Peucker: epsilon ~1.5 cells removes grid staircase
    #    while keeping meaningful bends
    key_pts = _douglas_peucker(raw_path, epsilon=1.5)

    if len(key_pts) < 3:
        # Fallback: uniform subsample for very short paths
        key_pts = raw_path[:: max(1, len(raw_path) // 8)]
        if len(key_pts) < 3:
            return raw_path

    # 2. Catmull-Rom spline through key waypoints
    n_sub = max(4, min(10, max_points // max(1, len(key_pts) - 1)))
    smooth = _catmull_rom_spline(key_pts, n_subdivisions=n_sub)

    # 3. Thin to budget
    if len(smooth) > max_points:
        smooth = _thin_path(smooth, max_points)

    return smooth


def _douglas_peucker(
    points: list[tuple[float, float]],
    epsilon: float,
) -> list[tuple[float, float]]:
    """Simplify a polyline using Douglas-Peucker algorithm.

    Removes points that deviate less than *epsilon* from the line
    between their neighbors, preserving significant bends.
    """
    if len(points) <= 2:
        return list(points)

    # Find the point farthest from the line (first → last)
    dmax = 0.0
    idx = 0
    ax, ay = points[0]
    bx, by = points[-1]
    dx = bx - ax
    dy = by - ay
    len_sq = dx * dx + dy * dy

    for i in range(1, len(points) - 1):
        px, py = points[i]
        if len_sq < 1e-10:
            d = math.sqrt((px - ax) ** 2 + (py - ay) ** 2)
        else:
            t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / len_sq))
            proj_x = ax + t * dx
            proj_y = ay + t * dy
            d = math.sqrt((px - proj_x) ** 2 + (py - proj_y) ** 2)
        if d > dmax:
            dmax = d
            idx = i

    if dmax > epsilon:
        left = _douglas_peucker(points[: idx + 1], epsilon)
        right = _douglas_peucker(points[idx:], epsilon)
        return left[:-1] + right
    else:
        return [points[0], points[-1]]


def _catmull_rom_spline(
    points: list[tuple[float, float]],
    n_subdivisions: int = 8,
) -> list[tuple[float, float]]:
    """Generate a smooth C1 curve through waypoints via Catmull-Rom.

    Each segment between consecutive points is interpolated with
    *n_subdivisions* intermediate samples, using the two surrounding
    points as tangent guides.
    """
    n = len(points)
    if n < 2:
        return list(points)
    if n == 2:
        # Linear interpolation for two points
        result = []
        for t_i in range(n_subdivisions + 1):
            t = t_i / n_subdivisions
            x = points[0][0] + t * (points[1][0] - points[0][0])
            y = points[0][1] + t * (points[1][1] - points[0][1])
            result.append((x, y))
        return result

    result: list[tuple[float, float]] = [points[0]]

    for i in range(n - 1):
        p0 = points[max(0, i - 1)]
        p1 = points[i]
        p2 = points[i + 1]
        p3 = points[min(n - 1, i + 2)]

        for t_i in range(1, n_subdivisions + 1):
            t = t_i / n_subdivisions
            t2 = t * t
            t3 = t2 * t

            x = 0.5 * (
                2.0 * p1[0]
                + (-p0[0] + p2[0]) * t
                + (2.0 * p0[0] - 5.0 * p1[0] + 4.0 * p2[0] - p3[0]) * t2
                + (-p0[0] + 3.0 * p1[0] - 3.0 * p2[0] + p3[0]) * t3
            )
            y = 0.5 * (
                2.0 * p1[1]
                + (-p0[1] + p2[1]) * t
                + (2.0 * p0[1] - 5.0 * p1[1] + 4.0 * p2[1] - p3[1]) * t2
                + (-p0[1] + 3.0 * p1[1] - 3.0 * p2[1] + p3[1]) * t3
            )
            result.append((x, y))

    return result


def _compute_widths(
    centerline: list[tuple[float, float]],
    max_accumulation: int,
    base_width_m: float,
) -> list[float]:
    """Compute river width along the centerline.

    Width grows from source (narrow) to mouth (wide).
    The overall scale depends on the max accumulation.
    """
    n = len(centerline)
    # Scale factor based on drainage area
    area_factor = min(2.0, max(0.5, math.log10(max_accumulation) / 3))
    widths = []
    for i in range(n):
        t = i / max(1, n - 1)
        # Source: 30% of base, mouth: base * area_factor
        w = base_width_m * (0.3 + (area_factor - 0.3) * t)
        widths.append(round(max(1.0, w), 2))
    return widths


def rasterize_river_network(
    network: RiverNetwork,
    size: int,
    cell_m: float,
) -> list[list[bool]]:
    """Rasterize all river segments to a water mask."""
    water = [[False] * size for _ in range(size)]

    for seg in network.segments:
        pts = seg.centerline
        widths = seg.widths
        if len(pts) < 2:
            continue

        for si in range(len(pts) - 1):
            ax, ay = pts[si]
            bx, by = pts[si + 1]
            w_m = widths[si] if si < len(widths) else widths[-1]
            w = w_m / cell_m
            half_w = w / 2 + 1.0

            min_x = max(0, int(min(ax, bx) - half_w))
            max_x = min(size - 1, int(max(ax, bx) + half_w))
            min_y = max(0, int(min(ay, by) - half_w))
            max_y = min(size - 1, int(max(ay, by) + half_w))

            for y in range(min_y, max_y + 1):
                for x in range(min_x, max_x + 1):
                    if water[y][x]:
                        continue
                    dist = _point_segment_dist(
                        x + 0.5, y + 0.5, ax, ay, bx, by,
                    )
                    if dist <= w / 2:
                        water[y][x] = True

    return water


def _point_segment_dist(
    px: float, py: float,
    ax: float, ay: float, bx: float, by: float,
) -> float:
    dx = bx - ax
    dy = by - ay
    len_sq = dx * dx + dy * dy
    if len_sq < 1e-10:
        return math.sqrt((px - ax) ** 2 + (py - ay) ** 2)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / len_sq))
    proj_x = ax + t * dx
    proj_y = ay + t * dy
    return math.sqrt((px - proj_x) ** 2 + (py - proj_y) ** 2)
