"""Main orchestrator for geological map generation.

Ties together relief, rivers, coastline, lakes, contours, and biotopes
into a single coherent map suitable for city planning.

Pipeline:
1. Relief (elevation)
2. Coastline (derived from elevation threshold)
3. Rivers (D8 flow on elevation, aware of coast)
4. Lakes (flood natural depressions)
5. Water masks (display: coast+lakes; full: +rivers)
6. Contours
7. Biotopes
"""

from __future__ import annotations

import json

from town_generator.terrain.noise import SimplexNoise
from town_generator.terrain_v2.scales import MapScale, get_scale
from town_generator.terrain_v2.relief import generate_relief, ReliefData
from town_generator.terrain_v2.contours import extract_contours, ContourLine
from town_generator.terrain_v2.rivers import (
    generate_rivers, rasterize_river_network, RiverNetwork,
)
from town_generator.terrain_v2.coastline import (
    generate_coastline, CoastData,
)
from town_generator.terrain_v2.lakes import (
    generate_lakes, rasterize_lakes, Lake,
)
from town_generator.terrain_v2.biotopes import (
    generate_biotopes, BiotopeData,
)


class GeologyMap:
    """Complete geological map for a city site."""

    def __init__(
        self,
        seed: int = 42,
        scale_name: str = "town",
        terrain_type: str = "normal",
        coast: bool = False,
        coast_direction: int = 2,
        n_rivers: int = 1,
        lakes: bool = True,
    ) -> None:
        self.seed = seed
        self.scale: MapScale = get_scale(scale_name)
        self.terrain_type = terrain_type
        self.coast_enabled = coast
        self.coast_direction = coast_direction if coast else -1
        self.n_rivers = n_rivers
        self.lakes_enabled = lakes

        self.relief_data: ReliefData = ReliefData()
        self.contours: list[ContourLine] = []
        self.river_network: RiverNetwork = RiverNetwork()
        self.coast_data: CoastData | None = None
        self.lake_list: list[Lake] = []
        self.water_mask: list[list[bool]] = []
        self.display_water: list[list[bool]] = []
        self.biotope_data: BiotopeData = BiotopeData()

        self._build()

    def _build(self) -> None:
        size = self.scale.grid_size
        noise = SimplexNoise(self.seed)

        # 1. Relief
        self.relief_data = generate_relief(
            noise, self.scale,
            terrain_type=self.terrain_type,
            coast=self.coast_enabled,
            coast_direction=self.coast_direction,
        )

        # 2. Coastline (derived from elevation)
        if self.coast_enabled:
            self.coast_data = generate_coastline(
                self.relief_data.raw,
                size,
                self.coast_direction,
                self.relief_data.max_m,
            )

        sea_mask = (
            self.coast_data.sea_mask if self.coast_data else None
        )

        # 3. Rivers (flow-based, follows elevation)
        self.river_network = generate_rivers(
            self.seed, self.scale, self.n_rivers,
            self.relief_data.raw,
            sea_mask=sea_mask,
        )

        # 4. Lakes (fill depressions)
        preliminary_water = self._build_display_water()

        if self.lakes_enabled:
            self.lake_list = generate_lakes(
                self.seed, self.scale,
                self.relief_data.raw,
                preliminary_water,
            )

        # 5. Water masks
        self.display_water = self._build_display_water()
        self.water_mask = self._build_full_water()

        # 6. Contours
        interval = self.relief_data.contour_interval_m
        max_m = self.relief_data.max_m
        if interval > 0 and max_m > 0:
            self.contours = extract_contours(
                self.relief_data.quantized, size,
                min_level=interval,
                max_level=max_m - interval * 0.5,
                interval=interval,
            )

        # 7. Biotopes
        self.biotope_data = generate_biotopes(
            self.seed, size,
            self.relief_data.raw,
            self.relief_data.max_m,
            self.water_mask,
        )

    def _build_display_water(self) -> list[list[bool]]:
        """Coast + lakes only (no rivers) for raster rendering."""
        size = self.scale.grid_size
        water = [[False] * size for _ in range(size)]

        if self.coast_data:
            sea = self.coast_data.sea_mask
            for y in range(size):
                for x in range(size):
                    if sea[y][x]:
                        water[y][x] = True

        if self.lake_list:
            lake_w = rasterize_lakes(self.lake_list, size)
            for y in range(size):
                for x in range(size):
                    if lake_w[y][x]:
                        water[y][x] = True

        return water

    def _build_full_water(self) -> list[list[bool]]:
        """Coast + rivers + lakes for logic (biotopes, etc.)."""
        size = self.scale.grid_size
        water = [row[:] for row in self.display_water]

        river_w = rasterize_river_network(
            self.river_network, size, self.scale.cell_m,
        )
        for y in range(size):
            for x in range(size):
                if river_w[y][x]:
                    water[y][x] = True

        return water

    def to_dict(self) -> dict:
        """Serialize to JSON-compatible dict."""
        scale = self.scale
        size = scale.grid_size

        display_rows = [
            "".join(
                "1" if self.display_water[y][x] else "0"
                for x in range(size)
            )
            for y in range(size)
        ]

        water_rows = [
            "".join(
                "1" if self.water_mask[y][x] else "0"
                for x in range(size)
            )
            for y in range(size)
        ]

        biome_legend = [
            "water", "meadow", "forest",
            "marsh", "field", "pasture", "scrub",
        ]
        biome_idx = {b: i for i, b in enumerate(biome_legend)}
        biome_grid = [
            [
                biome_idx.get(
                    self.biotope_data.raster[y][x], 0,
                )
                for x in range(size)
            ]
            for y in range(size)
        ]

        return {
            "seed": self.seed,
            "scale": {
                "name": scale.name,
                "extent_m": scale.extent_m,
                "grid_size": scale.grid_size,
                "cell_m": round(scale.cell_m, 2),
            },
            "settings": {
                "terrain_type": self.terrain_type,
                "coast": self.coast_enabled,
                "coast_direction": self.coast_direction,
                "n_rivers": self.n_rivers,
                "lakes": self.lakes_enabled,
            },
            "elevation": {
                "raw": [
                    [round(v, 1) for v in row]
                    for row in self.relief_data.raw
                ],
                "quantized": [
                    [round(v, 1) for v in row]
                    for row in self.relief_data.quantized
                ],
                "max_m": self.relief_data.max_m,
                "contour_interval_m": (
                    self.relief_data.contour_interval_m
                ),
                "n_levels": self.relief_data.n_levels,
            },
            "contours": [
                {
                    "level_m": c.level_m,
                    "points": [
                        [round(x, 1), round(y, 1)]
                        for x, y in c.points
                    ],
                    "closed": c.is_closed,
                }
                for c in self.contours
            ],
            "rivers": (
                self.river_network.to_dict()["segments"]
            ),
            "coastline": (
                self.coast_data.to_dict()
                if self.coast_data else None
            ),
            "lakes": [
                lake.to_dict() for lake in self.lake_list
            ],
            "water_mask": water_rows,
            "display_water": display_rows,
            "biotopes": {
                "legend": biome_legend,
                "raster": biome_grid,
                "regions": [
                    r.to_dict()
                    for r in self.biotope_data.regions
                ],
            },
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict())
