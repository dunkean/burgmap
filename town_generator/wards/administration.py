from __future__ import annotations
from typing import TYPE_CHECKING
from town_generator.wards.common_ward import CommonWard
from town_generator.utils.random import Random
if TYPE_CHECKING:
    from town_generator.building.model import Model
    from town_generator.building.patch import Patch


class AdministrationWard(CommonWard):
    def __init__(self, model: Model, patch: Patch) -> None:
        super().__init__(
            model, patch,
            80 + 30 * Random.float() * Random.float(),
            0.1 + Random.float() * 0.3, 0.3,
        )

    @staticmethod
    def rate_location(model: Model, patch: Patch) -> float:
        if model.plaza is not None:
            if patch.shape.borders(model.plaza.shape):
                return 0
            return patch.shape.distance(model.plaza.shape.center)
        return patch.shape.distance(model.center)

    def get_label(self) -> str:
        return "Administration"
