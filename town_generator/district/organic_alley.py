"""OrganicAlleyPopulator — recursive bisection (wraps existing create_alleys logic).

This is the core European medieval building generation algorithm from the
original TownGeneratorOS. It recursively splits a polygon along its longest
edge with random perturbation to produce irregular building footprints.
"""

from __future__ import annotations

import math

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.geom import geom_utils
from town_generator.utils.random import Random
from town_generator.building.cutter import bisect
from town_generator.district.base import (
    BasePopulator, BuildingFootprint, PopulatorParams, PopulatorResult,
)


class OrganicAlleyPopulator(BasePopulator):
    """Recursive bisection producing irregular building lots.

    Used for: European medieval, craftsmen, residential districts.
    Algorithm: Find longest edge, bisect at random ratio with angular chaos,
    recurse until area < threshold.
    """

    name = "organic_alley"
    description = "Recursive bisection — irregular medieval blocks"

    def populate(self, polygon: Polygon, params: PopulatorParams) -> PopulatorResult:
        Random.reset(params.seed)
        buildings = self._create_alleys(
            polygon,
            min_sq=params.min_area,
            grid_chaos=params.grid_chaos,
            size_chaos=params.size_chaos,
            empty_prob=params.empty_prob,
            alley_width=params.alley_width,
        )
        result = PopulatorResult()
        for b in buildings:
            result.buildings.append(BuildingFootprint(
                footprint=b,
                building_type="house",
                stories=1 + (1 if abs(b.square) > params.min_area * 1.5 else 0),
            ))
        return result

    @staticmethod
    def _create_alleys(
        p: Polygon,
        min_sq: float,
        grid_chaos: float,
        size_chaos: float,
        empty_prob: float = 0.04,
        split: bool = True,
        alley_width: float = 0.8,
    ) -> list[Polygon]:
        """Recursive bisection along longest edge. Standalone version."""
        best_v: Point | None = None
        best_length = -1.0

        def _find_longest(p0: Point, p1: Point) -> None:
            nonlocal best_v, best_length
            ln = Point.distance(p0, p1)
            if ln > best_length:
                best_length = ln
                best_v = p0

        p.for_edge(_find_longest)

        spread = 0.8 * grid_chaos
        ratio = (1 - spread) / 2 + Random.float() * spread

        angle_spread = math.pi / 6 * grid_chaos * (0.0 if p.square < min_sq * 4 else 1)
        b = (Random.float() - 0.5) * angle_spread

        halves = bisect(p, best_v, ratio, b, alley_width if split else 0.0)

        buildings: list[Polygon] = []
        for half in halves:
            threshold = min_sq * math.pow(2, 4 * size_chaos * (Random.float() - 0.5))
            if half.square < threshold:
                if not Random.bool(empty_prob) and len(half) >= 4:
                    buildings.append(half)
            else:
                do_split = (
                    half.square > min_sq / (Random.float() * Random.float())
                    if Random.float() * Random.float() > 0
                    else True
                )
                buildings.extend(
                    OrganicAlleyPopulator._create_alleys(
                        half, min_sq, grid_chaos, size_chaos, empty_prob,
                        do_split, alley_width,
                    )
                )

        return [b for b in buildings if len(b) >= 4]
