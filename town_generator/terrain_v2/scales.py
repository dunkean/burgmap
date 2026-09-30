"""Map scale definitions for the 5 city sizes."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MapScale:
    name: str
    extent_m: float
    grid_size: int
    river_base_width_m: float
    contour_interval_m: float
    max_elevation_m: float

    @property
    def cell_m(self) -> float:
        return self.extent_m / self.grid_size


SCALES: dict[str, MapScale] = {
    "hamlet": MapScale(
        name="hamlet",
        extent_m=750.0,
        grid_size=128,
        river_base_width_m=3.0,
        contour_interval_m=5.0,
        max_elevation_m=80.0,
    ),
    "village": MapScale(
        name="village",
        extent_m=1500.0,
        grid_size=192,
        river_base_width_m=8.0,
        contour_interval_m=8.0,
        max_elevation_m=120.0,
    ),
    "town": MapScale(
        name="town",
        extent_m=3500.0,
        grid_size=256,
        river_base_width_m=20.0,
        contour_interval_m=12.0,
        max_elevation_m=150.0,
    ),
    "city": MapScale(
        name="city",
        extent_m=7500.0,
        grid_size=320,
        river_base_width_m=40.0,
        contour_interval_m=18.0,
        max_elevation_m=220.0,
    ),
    "agglomeration": MapScale(
        name="agglomeration",
        extent_m=17500.0,
        grid_size=384,
        river_base_width_m=80.0,
        contour_interval_m=25.0,
        max_elevation_m=300.0,
    ),
}


def get_scale(name: str) -> MapScale:
    key = name.lower().strip()
    if key not in SCALES:
        raise ValueError(f"Unknown scale '{name}'. Choose from: {list(SCALES.keys())}")
    return SCALES[key]
