"""CommonWard — template for grid-based wards. Port of CommonWard.hx."""

from __future__ import annotations

from typing import TYPE_CHECKING

from town_generator.wards.ward import Ward

if TYPE_CHECKING:
    from town_generator.building.model import Model
    from town_generator.building.patch import Patch


class CommonWard(Ward):
    def __init__(
        self,
        model: Model,
        patch: Patch,
        min_sq: float,
        grid_chaos: float,
        size_chaos: float,
        empty_prob: float = 0.04,
    ) -> None:
        super().__init__(model, patch)
        self._min_sq = min_sq
        self._grid_chaos = grid_chaos
        self._size_chaos = size_chaos
        self._empty_prob = empty_prob

    def create_geometry(self) -> None:
        block = self.get_city_block()
        alley_w = getattr(self.model, 'alley_width', None)
        ep = self._empty_prob * getattr(self.model, 'empty_prob_factor', 1.0)
        self.geometry = Ward.create_alleys(
            block, self._min_sq, self._grid_chaos, self._size_chaos, ep, alley_width=alley_w
        )
        style = getattr(self.model, 'building_style', 'mixed')
        road_dir = self._get_road_direction() if style == 'mixed' else None
        self.geometry = Ward.apply_building_style(self.geometry, style, road_dir)
        if not self.model.is_enclosed(self.patch):
            self._filter_outskirts()
        self._filter_water()
