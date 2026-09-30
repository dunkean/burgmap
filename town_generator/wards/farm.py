from __future__ import annotations
import math
from town_generator.geom.polygon import Polygon
from town_generator.geom import geom_utils
from town_generator.wards.ward import Ward
from town_generator.utils.random import Random
from town_generator.utils import array_utils


class Farm(Ward):
    def create_geometry(self) -> None:
        housing = Polygon.rect(4, 4)
        pos = geom_utils.interpolate(
            array_utils.random_element(list(self.patch.shape)),
            self.patch.shape.centroid,
            0.3 + Random.float() * 0.4,
        )
        housing.rotate(Random.float() * math.pi)
        housing.offset(pos)
        self.geometry = Ward.create_ortho_building(housing, 8, 0.5)
        self._filter_water()

    def get_label(self) -> str:
        return "Farm"
