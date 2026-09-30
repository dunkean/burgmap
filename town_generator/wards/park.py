from __future__ import annotations
from town_generator.wards.ward import Ward, ALLEY
from town_generator.building.cutter import radial, semi_radial


class Park(Ward):
    def create_geometry(self) -> None:
        block = self.get_city_block()
        if block.compactness >= 0.7:
            self.geometry = radial(block, None, ALLEY)
        else:
            self.geometry = semi_radial(block, None, ALLEY)
        self._filter_water()

    def get_label(self) -> str:
        return "Park"
