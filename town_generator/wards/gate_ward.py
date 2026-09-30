from __future__ import annotations
from typing import TYPE_CHECKING
from town_generator.wards.common_ward import CommonWard
from town_generator.utils.random import Random
if TYPE_CHECKING:
    from town_generator.building.model import Model
    from town_generator.building.patch import Patch


class GateWard(CommonWard):
    def __init__(self, model: Model, patch: Patch) -> None:
        super().__init__(
            model, patch,
            10 + 50 * Random.float() * Random.float(),
            0.5 + Random.float() * 0.3, 0.7,
        )

    def get_label(self) -> str:
        return "Gate"
