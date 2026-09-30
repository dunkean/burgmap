from __future__ import annotations
import math
from typing import TYPE_CHECKING
from town_generator.wards.ward import Ward, MAIN_STREET
from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.building.curtain_wall import CurtainWall
from town_generator.utils.random import Random
if TYPE_CHECKING:
    from town_generator.building.model import Model
    from town_generator.building.patch import Patch


class Castle(Ward):
    def __init__(self, model: Model, patch: Patch) -> None:
        super().__init__(model, patch)

        reserved = [
            v for v in patch.shape
            if any(
                not p.within_city
                for p in model.patch_by_vertex(v)
            )
        ]
        self.wall = CurtainWall(True, model, [patch], reserved)

    def create_geometry(self) -> None:
        block = self.patch.shape.shrink_eq(MAIN_STREET * 2)
        center = block.center
        bounds = block.get_bounds()
        bw = bounds[2] - bounds[0]
        bh = bounds[3] - bounds[1]
        size = min(bw, bh)

        # Main keep (large central rectangle)
        keep_w = size * (0.35 + Random.float() * 0.15)
        keep_h = size * (0.35 + Random.float() * 0.15)
        keep = Polygon.rect(keep_w, keep_h)
        angle = Random.float() * math.pi * 0.1  # slight rotation
        keep.rotate(angle)
        keep.offset(center)
        self.geometry = [keep]

        # Side wings (1-3 rectangular wings radiating from the keep)
        n_wings = 1 + Random.int(0, 3)
        for i in range(n_wings):
            wing_w = size * (0.15 + Random.float() * 0.15)
            wing_h = size * (0.2 + Random.float() * 0.2)
            wing = Polygon.rect(wing_w, wing_h)
            wing_angle = angle + (i + 1) * math.pi * 2 / (n_wings + 1)
            wing.rotate(wing_angle)
            wing_dist = keep_w * 0.4 + wing_w * 0.3
            wing.offset(Point(
                center.x + math.cos(wing_angle) * wing_dist,
                center.y + math.sin(wing_angle) * wing_dist,
            ))
            self.geometry.append(wing)

        # Optional corner towers (small squares at keep corners)
        if Random.bool(0.5):
            tower_size = size * (0.08 + Random.float() * 0.04)
            # Place towers at two opposite corners of the keep
            for corner_idx in [0, 2]:
                tower = Polygon.rect(tower_size, tower_size)
                tower.rotate(angle)
                tower.offset(keep[corner_idx])
                self.geometry.append(tower)

        self._filter_water()

    def get_label(self) -> str:
        return "Castle"
