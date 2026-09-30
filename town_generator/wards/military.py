from __future__ import annotations
import math
from typing import TYPE_CHECKING
from town_generator.wards.ward import Ward
from town_generator.utils.random import Random
if TYPE_CHECKING:
    from town_generator.building.model import Model
    from town_generator.building.patch import Patch


class MilitaryWard(Ward):
    def create_geometry(self) -> None:
        block = self.get_city_block()
        self.geometry = Ward.create_alleys(
            block,
            math.sqrt(block.square) * (1 + Random.float()),
            0.1 + Random.float() * 0.3, 0.3,
            0.25,
        )
        self._filter_water()

    @staticmethod
    def rate_location(model: Model, patch: Patch) -> float:
        if model.citadel is not None and model.citadel.shape.borders(patch.shape):
            return 0
        if model.wall is not None and model.wall.borders(patch):
            return 1
        return 0 if (model.citadel is None and model.wall is None) else float("inf")

    def get_label(self) -> str:
        return "Military"
