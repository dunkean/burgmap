"""Coastline derived from elevation — sea level threshold on terrain.

The coast follows the relief naturally: a directional gradient lowers
terrain toward the chosen coast edge, and everything below sea level
becomes water.  The shoreline polyline is extracted via marching squares.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from town_generator.terrain.hydrology import chaikin_smooth
from town_generator.terrain_v2.contours import extract_contours


@dataclass
class CoastData:
    shoreline_points: list[tuple[float, float]] = field(
        default_factory=list,
    )
    sea_mask: list[list[bool]] = field(default_factory=list)
    river_mouths: list[tuple[float, float]] = field(
        default_factory=list,
    )

    def to_dict(self) -> dict:
        return {
            "points": [
                [round(x, 2), round(y, 2)]
                for x, y in self.shoreline_points
            ],
            "river_mouths": [
                [round(x, 2), round(y, 2)]
                for x, y in self.river_mouths
            ],
        }


def generate_coastline(
    elevation: list[list[float]],
    size: int,
    coast_direction: int,
    max_elevation_m: float,
) -> CoastData:
    """Generate coastline from elevation data.

    Sea level is set so that ~20-30% of the coast-side strip is
    submerged.  The shoreline is the contour at sea level.
    """
    coast = CoastData()

    # Sea level: pick a level that submerges a reasonable coastal strip.
    # We look at the elevation along the coast edge and set sea_level
    # to cover roughly 25% of the map depth on that side.
    sea_level = _compute_sea_level(
        elevation, size, coast_direction, max_elevation_m,
    )

    # Build sea mask: cells below sea level AND on the coast side
    coast.sea_mask = _build_sea_mask(
        elevation, size, coast_direction, sea_level,
    )

    # Extract shoreline as a polyline via marching squares
    # We create a field where sea=0, land=1 and extract contour at 0.5
    coast.shoreline_points = _extract_shoreline(
        coast.sea_mask, size,
    )

    return coast


def _compute_sea_level(
    elevation: list[list[float]],
    size: int,
    coast_direction: int,
    max_elevation_m: float,
) -> float:
    """Find a sea level that gives a natural-looking coast.

    Sample the coast-side quarter of the map and pick a percentile
    that submerges roughly 20-30% of that strip.
    """
    # Collect elevations from the coast-side quarter
    samples: list[float] = []
    quarter = size // 4

    for y in range(size):
        for x in range(size):
            in_strip = False
            if coast_direction == 0 and y < quarter:
                in_strip = True
            elif coast_direction == 2 and y >= size - quarter:
                in_strip = True
            elif coast_direction == 1 and x >= size - quarter:
                in_strip = True
            elif coast_direction == 3 and x < quarter:
                in_strip = True

            if in_strip:
                samples.append(elevation[y][x])

    if not samples:
        return max_elevation_m * 0.15

    samples.sort()
    # Sea level at the 30th percentile of the coastal strip
    idx = int(len(samples) * 0.30)
    return samples[min(idx, len(samples) - 1)]


def _build_sea_mask(
    elevation: list[list[float]],
    size: int,
    coast_direction: int,
    sea_level: float,
) -> list[list[bool]]:
    """Build sea mask: flood-fill from the coast edge.

    Only cells below sea_level that are connected to the coast edge
    become sea (prevents inland seas).
    """
    mask = [[False] * size for _ in range(size)]

    # Seed the flood from the coast edge
    queue: list[tuple[int, int]] = []

    for i in range(size):
        if coast_direction == 0:    # north
            if elevation[0][i] <= sea_level:
                queue.append((i, 0))
                mask[0][i] = True
        elif coast_direction == 2:  # south
            if elevation[size - 1][i] <= sea_level:
                queue.append((i, size - 1))
                mask[size - 1][i] = True
        elif coast_direction == 1:  # east
            if elevation[i][size - 1] <= sea_level:
                queue.append((size - 1, i))
                mask[i][size - 1] = True
        elif coast_direction == 3:  # west
            if elevation[i][0] <= sea_level:
                queue.append((0, i))
                mask[i][0] = True

    # BFS flood fill
    head = 0
    while head < len(queue):
        x, y = queue[head]
        head += 1
        for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            nx, ny = x + dx, y + dy
            if 0 <= nx < size and 0 <= ny < size:
                if not mask[ny][nx] and elevation[ny][nx] <= sea_level:
                    mask[ny][nx] = True
                    queue.append((nx, ny))

    return mask


def _extract_shoreline(
    sea_mask: list[list[bool]],
    size: int,
) -> list[tuple[float, float]]:
    """Extract the shoreline as a smoothed polyline.

    Uses marching squares on the sea mask (0/1 field) at level 0.5.
    Returns the longest contour as the main shoreline.
    """
    # Convert bool mask to float grid for marching squares
    grid = [
        [0.0 if sea_mask[y][x] else 1.0 for x in range(size)]
        for y in range(size)
    ]

    contours = extract_contours(
        grid, size,
        min_level=0.5, max_level=0.5, interval=1.0,
        smooth_iterations=2,
    )

    if not contours:
        return []

    # Return the longest contour as the main shoreline
    longest = max(contours, key=lambda c: len(c.points))
    return longest.points
