"""Patch — wraps a Polygon with ward assignment and flags. Port of Patch.hx."""

from __future__ import annotations

from typing import TYPE_CHECKING

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon

if TYPE_CHECKING:
    from town_generator.geom.voronoi import Region
    from town_generator.wards.ward import Ward


class Patch:
    def __init__(self, vertices: list[Point]) -> None:
        self.shape = Polygon(vertices)
        self.ward: Ward | None = None
        self.within_walls: bool = False
        self.within_city: bool = False

    @staticmethod
    def from_region(r: Region) -> Patch:
        return Patch([tr.c for tr in r.vertices])
