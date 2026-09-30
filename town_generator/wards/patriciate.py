from __future__ import annotations
from typing import TYPE_CHECKING
from town_generator.wards.common_ward import CommonWard
from town_generator.utils.random import Random
if TYPE_CHECKING:
    from town_generator.building.model import Model
    from town_generator.building.patch import Patch


class PatriciateWard(CommonWard):
    def __init__(self, model: Model, patch: Patch) -> None:
        super().__init__(
            model, patch,
            80 + 30 * Random.float() * Random.float(),
            0.5 + Random.float() * 0.3, 0.8,
            0.2,
        )

    @staticmethod
    def rate_location(model: Model, patch: Patch) -> float:
        from town_generator.wards.park import Park
        from town_generator.wards.slum import Slum
        rate = 0
        for p in model.patches:
            if p.ward is not None and p.shape.borders(patch.shape):
                if isinstance(p.ward, Park):
                    rate -= 1
                elif isinstance(p.ward, Slum):
                    rate += 1
        return rate

    def get_label(self) -> str:
        return "Patriciate"
