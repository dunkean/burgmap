"""Region generator — places one main city on terrain with landmarks.

Takes a WorldMap and produces a Region JSON containing:
- The main city site (best terrain location)
- Terrain-derived landmark sites (castle hilltop, docks, mill, etc.)
- Optional satellite hamlets/villages with connecting roads
- Site attractiveness heatmap

Does NOT use the project's global Random class.
"""

from __future__ import annotations

import json
import random as stdlib_random

from town_generator.terrain.world_map import WorldMap
from town_generator.region.site_scoring import (
    compute_score_map, find_city_site, detect_landmarks,
    place_satellites, determine_specialization,
)
from town_generator.region.road_network import build_satellite_roads


class Region:
    """One main city + landmarks + optional satellites on terrain."""

    def __init__(
        self,
        world_map: WorldMap | None = None,
        seed: int = 42,
        city_radius: int = 15,
        n_satellites: int = 0,
        style: str = "generic",
        build_roads: bool = True,
    ) -> None:
        self.seed = seed
        self.city_radius = city_radius
        self.n_satellites = n_satellites
        self.style = style
        self.build_roads = build_roads

        if world_map is None:
            world_map = WorldMap(seed=seed, size=128, river_count=1)
        self.world_map = world_map

        self.city: dict = {}
        self.landmarks: list[dict] = []
        self.satellites: list[dict] = []
        self.roads: list[dict] = []
        self.bridges: list[dict] = []
        self.score_map: list[list[float]] = []

        self._build()

    def _build(self) -> None:
        rng = stdlib_random.Random(self.seed + 5000)
        wm = self.world_map

        # 1. Score map
        self.score_map = compute_score_map(
            wm.size, wm.elevation, wm.water, wm.terrain, wm.ground_cover,
        )

        # 2. Find city site
        cx, cy, score = find_city_site(wm.size, self.score_map, wm.water)

        spec = determine_specialization(
            wm.ground_cover, wm.terrain, wm.water,
            cx, cy, wm.size, radius=15,
        )

        has_harbor = any(
            wm.water[ny][nx]
            for dy in range(-5, 6) for dx in range(-5, 6)
            for nx, ny in [(cx + dx, cy + dy)]
            if 0 <= nx < wm.size and 0 <= ny < wm.size
        )

        self.city = {
            "id": "city",
            "x": cx, "y": cy,
            "type": "city",
            "size": rng.randint(25, 45),
            "specialization": spec,
            "style": self.style,
            "score": round(score, 3),
            "features": {
                "has_walls": True,
                "has_castle": True,
                "has_harbor": has_harbor,
                "dominant_resource": spec,
            },
        }

        # 3. Detect landmark sites from terrain
        self.landmarks = detect_landmarks(
            cx, cy, self.city_radius,
            wm.size, wm.elevation, wm.water, wm.terrain,
        )

        # 4. Satellite hamlets/villages
        if self.n_satellites > 0:
            self.satellites = place_satellites(
                cx, cy, self.city_radius,
                wm.size, self.score_map, wm.water, rng,
                n_satellites=self.n_satellites,
                style=self.style,
            )

        # 5. Roads from satellites to city
        if self.build_roads and self.satellites:
            self.roads, self.bridges = build_satellite_roads(
                self.city, self.satellites,
                wm.size, wm.elevation, wm.water, wm.terrain,
            )

    def to_dict(self) -> dict:
        return {
            "seed": self.seed,
            "world_map_seed": self.world_map.seed,
            "world_map_size": self.world_map.size,
            "city": self.city,
            "landmarks": self.landmarks,
            "satellites": self.satellites,
            "roads": self.roads,
            "bridges": self.bridges,
            "score_map": [
                [round(v, 3) for v in row]
                for row in self.score_map
            ],
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict())
