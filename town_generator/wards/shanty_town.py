from __future__ import annotations
from typing import TYPE_CHECKING
from town_generator.wards.common_ward import CommonWard
from town_generator.utils.random import Random
if TYPE_CHECKING:
    from town_generator.building.model import Model
    from town_generator.building.patch import Patch


class ShantyTown(CommonWard):
    def __init__(self, model: Model, patch: Patch) -> None:
        super().__init__(
            model, patch,
            5 + 15 * Random.float() * Random.float(),
            0.8 + Random.float() * 0.2, 0.9,
            0.01,
        )

    @staticmethod
    def rate_location(model: Model, patch: Patch) -> float:
        # Prefer patches outside walls, near gates, penalize inner city
        if patch.within_walls:
            return float("inf")
        dist = patch.shape.distance(
            model.plaza.shape.center if model.plaza is not None else model.center
        )
        # Prefer closer to city but outside walls
        return dist

    def get_label(self) -> str:
        return "Shanty Town"
