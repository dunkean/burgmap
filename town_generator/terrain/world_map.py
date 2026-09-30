"""City-scale terrain map — the geographic substrate for city generation.

Produces elevation, water mask (coast + rivers), and terrain classification
at a scale appropriate for placing a single city and its immediate surroundings.

All real-world dimensions are in meters. The grid is an NxN raster where
each cell represents cell_size_m x cell_size_m meters of terrain.
"""

from __future__ import annotations

import json

from town_generator.terrain.noise import SimplexNoise
from town_generator.terrain.elevation import ElevationGenerator
from town_generator.terrain.hydrology import (
    CoastlineGenerator, RiverGenerator, Shoreline, River,
    rasterize_coast, rasterize_rivers, cleanup_water_mask,
)
from town_generator.terrain.ground_cover import GroundCoverGenerator


# Terrain types at city scale
TERRAIN_TYPES = ["water", "wetland", "flat", "slope", "hill"]


class WorldMap:
    """City-scale terrain map.

    Does NOT use the project's global Random class. All randomness is
    isolated via SimplexNoise permutation tables and stdlib random.Random
    instances seeded from self.seed.
    """

    def __init__(
        self,
        seed: int = 42,
        size: int = 128,
        map_extent_m: float = 2000.0,
        noise_scale: float = 2.0,
        octaves: int = 4,
        persistence: float = 0.5,
        coast: bool = False,
        coast_direction: int = 2,
        sea_level: float = 0.15,
        river_count: int = 1,
        river_width_m: float = 30.0,
    ) -> None:
        self.seed = seed
        self.size = size
        self.map_extent_m = map_extent_m
        self.cell_size_m = map_extent_m / size
        self.noise_scale = noise_scale
        self.octaves = octaves
        self.persistence = persistence
        self.coast = coast
        self.coast_direction = coast_direction if coast else -1
        self.sea_level = sea_level
        self.river_count = river_count
        self.river_width_m = river_width_m
        # Convert river width from meters to cells for internal use
        self._river_width_cells = max(2.0, river_width_m / self.cell_size_m)

        self.elevation: list[list[float]] = []
        self.water: list[list[bool]] = []
        self.terrain: list[list[str]] = []
        self.ground_cover: list[list[str]] = []
        self.rivers: list[River] = []
        self.shoreline: Shoreline | None = None
        self.coastline: list[tuple[int, int]] = []

        self._build()

    def _build(self) -> None:
        noise = SimplexNoise(self.seed)

        # 1. Elevation (gentle city-scale hills)
        elev_gen = ElevationGenerator(noise)
        self.elevation = elev_gen.generate(
            self.size, self.noise_scale, self.octaves, self.persistence,
        )

        # 2. Coastline (vectorized tortuous shoreline)
        if self.coast:
            coast_gen = CoastlineGenerator()
            self.shoreline = coast_gen.generate(
                self.seed, self.size, self.coast_direction,
                coast_position=0.25, roughness=0.35,
            )

        # 3. Rivers (wide, vectorized centerlines)
        river_gen = RiverGenerator()
        self.rivers = river_gen.generate(
            self.seed, self.size, self.river_count, self._river_width_cells,
            self.coast_direction,
        )

        # 4. Water mask (coast + rivers combined)
        self.water = self._build_water_mask()
        cleanup_water_mask(self.water, self.size)

        # 5. Coastline cells (land/water boundary)
        self.coastline = self._extract_coastline()

        # 6. Terrain classification
        self.terrain = self._classify_terrain()

        # 7. Ground cover (forest, swamp, farmland patches)
        cover_noise = SimplexNoise(self.seed + 3000)
        cover_gen = GroundCoverGenerator(cover_noise)
        self.ground_cover = cover_gen.generate(
            self.size, self.elevation, self.water, self.terrain,
        )

    def _build_water_mask(self) -> list[list[bool]]:
        """Combine rasterized coast and rasterized rivers."""
        # Start with river water
        water = rasterize_rivers(self.rivers, self.size)

        # Add coast water
        if self.shoreline and self.coast:
            coast_water = rasterize_coast(
                self.shoreline, self.size, self.coast_direction,
            )
            for y in range(self.size):
                for x in range(self.size):
                    if coast_water[y][x]:
                        water[y][x] = True

        return water

    def _extract_coastline(self) -> list[tuple[int, int]]:
        """Find land cells adjacent to water."""
        coast: list[tuple[int, int]] = []
        for y in range(self.size):
            for x in range(self.size):
                if not self.water[y][x]:
                    for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < self.size and 0 <= ny < self.size:
                            if self.water[ny][nx]:
                                coast.append((x, y))
                                break
        return coast

    def _classify_terrain(self) -> list[list[str]]:
        """Classify each cell: water, wetland, flat, slope, hill."""
        grid = [["flat"] * self.size for _ in range(self.size)]

        for y in range(self.size):
            for x in range(self.size):
                if self.water[y][x]:
                    grid[y][x] = "water"
                    continue

                elev = self.elevation[y][x]
                slope = self._local_slope(x, y)

                # Near water = wetland
                if self._near_water(x, y, radius=2):
                    if slope < 0.03:
                        grid[y][x] = "wetland"
                        continue

                if slope > 0.06:
                    grid[y][x] = "slope"
                elif elev > 0.65:
                    grid[y][x] = "hill"
                else:
                    grid[y][x] = "flat"

        return grid

    def _local_slope(self, x: int, y: int) -> float:
        """Compute max elevation difference to 4-neighbors."""
        e = self.elevation[y][x]
        max_diff = 0.0
        for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            nx, ny = x + dx, y + dy
            if 0 <= nx < self.size and 0 <= ny < self.size:
                diff = abs(self.elevation[ny][nx] - e)
                if diff > max_diff:
                    max_diff = diff
        return max_diff

    def _near_water(self, x: int, y: int, radius: int = 2) -> bool:
        for dy in range(-radius, radius + 1):
            for dx in range(-radius, radius + 1):
                nx, ny = x + dx, y + dy
                if 0 <= nx < self.size and 0 <= ny < self.size:
                    if self.water[ny][nx]:
                        return True
        return False

    def to_dict(self) -> dict:
        """Serialize to city-scale terrain JSON."""
        return {
            "size": [self.size, self.size],
            "map_extent_m": self.map_extent_m,
            "cell_size_m": round(self.cell_size_m, 2),
            "seed": self.seed,
            "elevation": [[round(v, 3) for v in row] for row in self.elevation],
            "water": self.water,
            "terrain": self.terrain,
            "ground_cover": self.ground_cover,
            "rivers": [r.to_dict() for r in self.rivers],
            "coastline": [list(pt) for pt in self.coastline],
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict())
