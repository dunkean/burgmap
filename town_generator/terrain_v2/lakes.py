"""Lake generation — fills natural depressions in the terrain.

Lakes form where the terrain has local minima (pits).  We find pits,
flood-fill them up to their spill elevation, and extract the lake
boundary as a smoothed polygon.
"""

from __future__ import annotations

import math
import random as stdlib_random
from dataclasses import dataclass, field

from town_generator.terrain.hydrology import chaikin_smooth
from town_generator.terrain_v2.scales import MapScale


@dataclass
class Lake:
    boundary: list[tuple[float, float]] = field(
        default_factory=list,
    )
    elevation_m: float = 0.0
    center: tuple[float, float] = (0.0, 0.0)

    def to_dict(self) -> dict:
        return {
            "boundary": [
                [round(x, 2), round(y, 2)]
                for x, y in self.boundary
            ],
            "elevation_m": round(self.elevation_m, 1),
            "center": [
                round(self.center[0], 2),
                round(self.center[1], 2),
            ],
        }


def generate_lakes(
    seed: int,
    scale: MapScale,
    elevation: list[list[float]],
    water_mask: list[list[bool]],
    n_lakes: int | None = None,
) -> list[Lake]:
    """Generate lakes by finding and flooding terrain depressions."""
    rng = stdlib_random.Random(seed + 8000)
    size = scale.grid_size

    if n_lakes is None:
        n_lakes = rng.randint(1, 3)

    # Find local minima (pits) — cells lower than all neighbors
    pits = _find_pits(elevation, water_mask, size)

    # Shuffle and select candidates
    rng.shuffle(pits)

    # Min/max lake area in cells
    min_area = max(20, int((50 / scale.cell_m) ** 2))
    max_area = max(100, int((400 / scale.cell_m) ** 2))
    margin = max(5, size // 10)

    lakes: list[Lake] = []
    used = set()

    for px, py in pits:
        if len(lakes) >= n_lakes:
            break

        # Skip if too close to edge
        if px < margin or px >= size - margin:
            continue
        if py < margin or py >= size - margin:
            continue

        # Skip if already used by another lake
        if (px, py) in used:
            continue

        # Skip if already water
        if water_mask[py][px]:
            continue

        # Flood-fill this depression to find the lake
        lake_cells, spill_elev = _flood_depression(
            px, py, elevation, water_mask, size,
            max_area, used,
        )

        if len(lake_cells) < min_area:
            continue

        # Mark cells as used
        for cx, cy in lake_cells:
            used.add((cx, cy))

        # Extract boundary polygon
        boundary = _extract_lake_boundary(lake_cells, size)
        if len(boundary) < 6:
            continue

        boundary = chaikin_smooth(boundary, iterations=2)
        # Close polygon
        if boundary[0] != boundary[-1]:
            boundary.append(boundary[0])

        # Compute center
        sum_x = sum(c[0] for c in lake_cells)
        sum_y = sum(c[1] for c in lake_cells)
        n = len(lake_cells)
        center = (sum_x / n, sum_y / n)

        lakes.append(Lake(
            boundary=boundary,
            elevation_m=spill_elev,
            center=center,
        ))

    return lakes


def _find_pits(
    elevation: list[list[float]],
    water_mask: list[list[bool]],
    size: int,
) -> list[tuple[int, int]]:
    """Find local minima — cells lower than all 8 neighbors."""
    pits: list[tuple[int, int]] = []

    for y in range(1, size - 1):
        for x in range(1, size - 1):
            if water_mask[y][x]:
                continue

            e = elevation[y][x]
            is_pit = True
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    if elevation[y + dy][x + dx] < e:
                        is_pit = False
                        break
                if not is_pit:
                    break

            if is_pit:
                pits.append((x, y))

    return pits


def _flood_depression(
    start_x: int,
    start_y: int,
    elevation: list[list[float]],
    water_mask: list[list[bool]],
    size: int,
    max_area: int,
    used: set,
) -> tuple[list[tuple[int, int]], float]:
    """Flood-fill a depression from a pit.

    Progressively raise water level until the lake reaches max_area
    or finds a spill point.  Returns (lake_cells, spill_elevation).
    """
    pit_elev = elevation[start_y][start_x]

    # Collect cells and their elevations around the pit
    # using a priority-queue-like approach
    lake_cells: list[tuple[int, int]] = [(start_x, start_y)]
    in_lake = {(start_x, start_y)}

    # Frontier: cells adjacent to lake, sorted by elevation
    frontier: list[tuple[float, int, int]] = []
    _add_neighbors_to_frontier(
        start_x, start_y, elevation, size,
        water_mask, in_lake, used, frontier,
    )
    frontier.sort()

    spill_elev = pit_elev

    while frontier and len(lake_cells) < max_area:
        elev, fx, fy = frontier.pop(0)

        # If this cell is significantly higher, it's the spill point
        if elev > pit_elev + (spill_elev - pit_elev) * 3 + 5.0:
            break

        spill_elev = max(spill_elev, elev)
        lake_cells.append((fx, fy))
        in_lake.add((fx, fy))

        _add_neighbors_to_frontier(
            fx, fy, elevation, size,
            water_mask, in_lake, used, frontier,
        )
        frontier.sort()

    return lake_cells, spill_elev


def _add_neighbors_to_frontier(
    x: int, y: int,
    elevation: list[list[float]],
    size: int,
    water_mask: list[list[bool]],
    in_lake: set,
    used: set,
    frontier: list[tuple[float, int, int]],
) -> None:
    """Add 4-connected neighbors to the frontier."""
    for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
        nx, ny = x + dx, y + dy
        if not (0 <= nx < size and 0 <= ny < size):
            continue
        if (nx, ny) in in_lake or (nx, ny) in used:
            continue
        if water_mask[ny][nx]:
            continue
        frontier.append((elevation[ny][nx], nx, ny))


def _extract_lake_boundary(
    lake_cells: list[tuple[int, int]],
    size: int,
) -> list[tuple[float, float]]:
    """Extract boundary polygon from a set of lake cells.

    Walks the border of the cell set to produce an ordered polygon.
    """
    cell_set = set(lake_cells)
    if not cell_set:
        return []

    # Find boundary cells (cells with at least one non-lake neighbor)
    boundary_cells: list[tuple[int, int]] = []
    for x, y in lake_cells:
        for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            if (x + dx, y + dy) not in cell_set:
                boundary_cells.append((x, y))
                break

    if not boundary_cells:
        return []

    # Simple approach: sort boundary cells by angle from center
    cx = sum(c[0] for c in lake_cells) / len(lake_cells)
    cy = sum(c[1] for c in lake_cells) / len(lake_cells)

    boundary_cells.sort(
        key=lambda p: math.atan2(p[1] - cy, p[0] - cx),
    )

    # Convert to float coords (cell centers)
    return [(float(x) + 0.5, float(y) + 0.5) for x, y in boundary_cells]


def rasterize_lakes(
    lakes: list[Lake], size: int,
) -> list[list[bool]]:
    """Rasterize lake boundaries to a water mask."""
    water = [[False] * size for _ in range(size)]

    for lake in lakes:
        boundary = lake.boundary
        if len(boundary) < 3:
            continue
        _fill_polygon(boundary, water, size)

    return water


def _fill_polygon(
    poly: list[tuple[float, float]],
    grid: list[list[bool]],
    size: int,
) -> None:
    """Simple scanline polygon fill."""
    min_y = max(0, int(min(p[1] for p in poly)))
    max_y = min(size - 1, int(max(p[1] for p in poly)))

    for y in range(min_y, max_y + 1):
        intersections: list[float] = []
        n = len(poly)
        for i in range(n):
            j = (i + 1) % n
            y0, y1 = poly[i][1], poly[j][1]
            x0, x1 = poly[i][0], poly[j][0]

            if (y0 <= y < y1) or (y1 <= y < y0):
                if abs(y1 - y0) > 0.001:
                    t = (y - y0) / (y1 - y0)
                    ix = x0 + t * (x1 - x0)
                    intersections.append(ix)

        intersections.sort()

        for k in range(0, len(intersections) - 1, 2):
            x_start = max(0, int(math.ceil(intersections[k])))
            x_end = min(
                size - 1, int(math.floor(intersections[k + 1])),
            )
            for x in range(x_start, x_end + 1):
                grid[y][x] = True
