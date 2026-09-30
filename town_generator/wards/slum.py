from __future__ import annotations
from typing import TYPE_CHECKING
from town_generator.wards.common_ward import CommonWard
from town_generator.utils.random import Random
if TYPE_CHECKING:
    from town_generator.building.model import Model
    from town_generator.building.patch import Patch


class Slum(CommonWard):
    def __init__(self, model: Model, patch: Patch) -> None:
        super().__init__(
            model, patch,
            10 + 30 * Random.float() * Random.float(),
            0.6 + Random.float() * 0.4, 0.8,
            0.03,
        )

    @staticmethod
    def rate_location(model: Model, patch: Patch) -> float:
        return -patch.shape.distance(
            model.plaza.shape.center if model.plaza is not None else model.center
        )

    def get_label(self) -> str:
        return "Slum"
