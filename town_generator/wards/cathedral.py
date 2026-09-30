from __future__ import annotations
import math
from typing import TYPE_CHECKING
from town_generator.wards.ward import Ward
from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.utils.random import Random
if TYPE_CHECKING:
    from town_generator.building.model import Model
    from town_generator.building.patch import Patch


class Cathedral(Ward):
    def create_geometry(self) -> None:
        block = self.get_city_block()
        center = block.center

        # Find main axis from longest edge
        best_v = None
        best_len = -1.0
        for i in range(len(block)):
            v0 = block[i]
            v1 = block[(i + 1) % len(block)]
            d = Point.distance(v0, v1)
            if d > best_len:
                best_len = d
                best_v = v1.subtract(v0)

        if best_v is None:
            self.geometry = [block]
            self._filter_water()
            return

        # Main axis angle and perpendicular
        angle = math.atan2(best_v.y, best_v.x)

        # Get bounding dimensions of the block
        bounds = block.get_bounds()
        bw = bounds[2] - bounds[0]
        bh = bounds[3] - bounds[1]
        block_size = max(bw, bh)

        # Nave (main body) -- long rectangle along the main axis
        nave_l = block_size * (0.55 + Random.float() * 0.25)
        nave_w = block_size * (0.25 + Random.float() * 0.15)
        nave = Polygon.rect(nave_l, nave_w)
        nave.rotate(angle)
        nave.offset(center)

        # Transept (crossing) -- shorter but wider, perpendicular
        trans_l = block_size * (0.15 + Random.float() * 0.15)
        trans_w = block_size * (0.35 + Random.float() * 0.2)
        transept = Polygon.rect(trans_l, trans_w)
        transept.rotate(angle)
        # Offset transept slightly from center along the nave axis
        offset_along = (Random.float() - 0.5) * nave_l * 0.2
        transept.offset(Point(
            center.x + math.cos(angle) * offset_along,
            center.y + math.sin(angle) * offset_along,
        ))

        self.geometry = [nave, transept]

        # Optional apse (small rectangle at one end of the nave)
        if Random.bool(0.6):
            apse_l = block_size * (0.1 + Random.float() * 0.1)
            apse_w = nave_w * (0.7 + Random.float() * 0.3)
            apse = Polygon.rect(apse_l, apse_w)
            apse.rotate(angle)
            apse_offset = nave_l * 0.5 + apse_l * 0.4
            apse.offset(Point(
                center.x + math.cos(angle) * apse_offset,
                center.y + math.sin(angle) * apse_offset,
            ))
            self.geometry.append(apse)

        # Optional tower / bell tower (small square)
        if Random.bool(0.5):
            tower_size = block_size * (0.08 + Random.float() * 0.06)
            tower = Polygon.rect(tower_size, tower_size)
            tower.rotate(angle)
            tower_offset = -nave_l * 0.4
            tower.offset(Point(
                center.x + math.cos(angle) * tower_offset,
                center.y + math.sin(angle) * tower_offset,
            ))
            self.geometry.append(tower)

        self._filter_water()

    @staticmethod
    def rate_location(model: Model, patch: Patch) -> float:
        if model.plaza is not None and patch.shape.borders(model.plaza.shape):
            return -1 / patch.shape.square
        return patch.shape.distance(
            model.plaza.shape.center if model.plaza is not None else model.center
        ) * patch.shape.square

    def get_label(self) -> str:
        return "Temple"
