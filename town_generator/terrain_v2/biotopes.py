"""Biome classification and region vectorization.

Classifies each land cell into a biome type based on elevation, slope,
water proximity, and noise variation. Then extracts vector boundary
polygons for each biome region.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from town_generator.terrain.noise import SimplexNoise
from town_generator.terrain_v2.contours import extract_contours


BIOME_TYPES = ["meadow", "forest", "marsh", "field", "pasture", "scrub"]


@dataclass
class BiomeRegion:
    biome_type: str
    boundary: list[tuple[float, float]] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "type": self.biome_type,
            "boundary": [[round(x, 2), round(y, 2)] for x, y in self.boundary],
        }


@dataclass
class BiotopeData:
    raster: list[list[str]] = field(default_factory=list)
    regions: list[BiomeRegion] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "raster": self.raster,
            "regions": [r.to_dict() for r in self.regions],
        }


def generate_biotopes(
    seed: int,
    size: int,
    elevation: list[list[float]],
    max_elevation_m: float,
    water_mask: list[list[bool]],
) -> BiotopeData:
    """Classify biomes and extract vector regions."""
    noise = SimplexNoise(seed + 9000)

    # 1. Cell-level classification
    raster = _classify_cells(noise, size, elevation, max_elevation_m, water_mask)

    # 2. Smooth boundaries (majority filter)
    _smooth_boundaries(raster, size, water_mask, passes=2)

    # 3. Vectorize biome regions
    regions = _vectorize_regions(raster, size, water_mask)

    return BiotopeData(raster=raster, regions=regions)


def _classify_cells(
    noise: SimplexNoise,
    size: int,
    elevation: list[list[float]],
    max_elev: float,
    water_mask: list[list[bool]],
) -> list[list[str]]:
    """Classify each land cell into a biome type."""
    grid = [["water"] * size for _ in range(size)]
    scale1 = 3.0 / size
    scale2 = 5.0 / size

    for y in range(size):
        for x in range(size):
            if water_mask[y][x]:
                grid[y][x] = "water"
                continue

            elev = elevation[y][x]
            norm_elev = elev / max_elev if max_elev > 0 else 0.0
            slope = _local_slope(elevation, x, y, size)
            near_water = _near_water(water_mask, x, y, size, radius=3)

            # Noise for variation
            n1 = noise.noise2d(x * scale1, y * scale1)
            n2 = noise.noise2d(x * scale2 + 200, y * scale2 + 200)

            # Classification rules
            if near_water and slope < 0.03 and norm_elev < 0.35:
                grid[y][x] = "marsh"
            elif n1 > 0.25 and norm_elev < 0.5 and slope < 0.04:
                grid[y][x] = "field"
            elif n1 < -0.15 and norm_elev > 0.2 and norm_elev < 0.7:
                grid[y][x] = "forest"
            elif n2 > 0.3 and norm_elev > 0.55:
                grid[y][x] = "scrub"
            elif norm_elev < 0.45 and slope < 0.05 and n2 < 0.0:
                grid[y][x] = "pasture"
            else:
                grid[y][x] = "meadow"

    return grid


def _local_slope(
    elevation: list[list[float]], x: int, y: int, size: int,
) -> float:
    """Max elevation difference to 4-neighbors (normalized)."""
    e = elevation[y][x]
    max_diff = 0.0
    for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
        nx, ny = x + dx, y + dy
        if 0 <= nx < size and 0 <= ny < size:
            diff = abs(elevation[ny][nx] - e)
            if diff > max_diff:
                max_diff = diff
    return max_diff


def _near_water(
    water_mask: list[list[bool]], x: int, y: int, size: int, radius: int = 3,
) -> bool:
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            nx, ny = x + dx, y + dy
            if 0 <= nx < size and 0 <= ny < size and water_mask[ny][nx]:
                return True
    return False


def _smooth_boundaries(
    raster: list[list[str]], size: int,
    water_mask: list[list[bool]], passes: int = 2,
) -> None:
    """Apply majority filter to smooth biome boundaries in-place."""
    for _ in range(passes):
        prev = [row[:] for row in raster]
        for y in range(1, size - 1):
            for x in range(1, size - 1):
                if water_mask[y][x]:
                    continue
                # Count biome types in 3x3 neighborhood
                counts: dict[str, int] = {}
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        t = prev[y + dy][x + dx]
                        if t != "water":
                            counts[t] = counts.get(t, 0) + 1
                if counts:
                    majority = max(counts, key=counts.get)  # type: ignore[arg-type]
                    raster[y][x] = majority


def _vectorize_regions(
    raster: list[list[str]],
    size: int,
    water_mask: list[list[bool]],
) -> list[BiomeRegion]:
    """Extract vector boundary polygons for each biome type using marching squares."""
    regions: list[BiomeRegion] = []

    for biome in BIOME_TYPES:
        if biome == "water":
            continue

        # Create binary mask for this biome
        mask = []
        for y in range(size):
            row = []
            for x in range(size):
                row.append(1.0 if raster[y][x] == biome else 0.0)
            mask.append(row)

        # Extract contours at threshold 0.5
        contours = extract_contours(
            mask, size,
            min_level=0.5, max_level=0.5, interval=1.0,
            smooth_iterations=1,
        )

        for contour in contours:
            if len(contour.points) >= 6:
                # Simplify (skip every other point for large polylines)
                pts = contour.points
                if len(pts) > 50:
                    pts = _douglas_peucker(pts, tolerance=1.5)
                regions.append(BiomeRegion(
                    biome_type=biome,
                    boundary=pts,
                ))

    return regions


def _douglas_peucker(
    points: list[tuple[float, float]], tolerance: float,
) -> list[tuple[float, float]]:
    """Douglas-Peucker polyline simplification."""
    if len(points) <= 2:
        return points

    # Find the point with the maximum distance from the line start->end
    start = points[0]
    end = points[-1]
    max_dist = 0.0
    max_idx = 0

    dx = end[0] - start[0]
    dy = end[1] - start[1]
    line_len_sq = dx * dx + dy * dy

    for i in range(1, len(points) - 1):
        px, py = points[i]
        if line_len_sq < 1e-10:
            dist = math.sqrt((px - start[0]) ** 2 + (py - start[1]) ** 2)
        else:
            t = max(0.0, min(1.0,
                ((px - start[0]) * dx + (py - start[1]) * dy) / line_len_sq))
            proj_x = start[0] + t * dx
            proj_y = start[1] + t * dy
            dist = math.sqrt((px - proj_x) ** 2 + (py - proj_y) ** 2)

        if dist > max_dist:
            max_dist = dist
            max_idx = i

    if max_dist > tolerance:
        left = _douglas_peucker(points[:max_idx + 1], tolerance)
        right = _douglas_peucker(points[max_idx:], tolerance)
        return left[:-1] + right
    else:
        return [start, end]
