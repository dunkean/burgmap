"""DiskPackingPopulator — random disk packing for Mongol ger clusters.

Places circular (approximated as 16-gon) ger/yurt footprints within the
district polygon using rejection sampling with minimum distance enforcement.
"""

from __future__ import annotations

import math

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.utils.random import Random
from town_generator.district.base import (
    BasePopulator, BuildingFootprint, PopulatorParams, PopulatorResult,
)


class DiskPackingPopulator(BasePopulator):
    """Random disk packing of circular ger footprints.

    Used for: Mongol encampment / ger cluster districts.
    """

    name = "disk_packing"
    description = "Disk packing — Mongol ger clusters"

    def populate(self, polygon: Polygon, params: PopulatorParams) -> PopulatorResult:
        Random.reset(params.seed)
        result = PopulatorResult()

        bounds = polygon.get_bounds()
        bx, by, bx2, by2 = bounds
        bw = bx2 - bx
        bh = by2 - by

        if bw < 4 or bh < 4:
            return result

        area = abs(polygon.square)

        # Ger radius range based on min_area
        base_r = max(2.0, math.sqrt(params.min_area / math.pi))
        min_r = base_r * 0.7
        max_r = base_r * 1.3

        # Minimum gap between gers
        min_gap = params.alley_width * 1.5

        # Target number of gers based on density and area
        max_gers = max(3, int(area * params.density / (math.pi * base_r * base_r * 3)))

        placed: list[tuple[float, float, float]] = []  # (cx, cy, radius)
        max_attempts = max_gers * 20

        for _ in range(max_attempts):
            if len(placed) >= max_gers:
                break

            # Random position within bounds
            px = bx + Random.float() * bw
            py = by + Random.float() * bh
            r = min_r + Random.float() * (max_r - min_r)

            # Check if center is inside the polygon
            if not self._point_in_polygon(Point(px, py), polygon):
                continue

            # Check minimum distance to all placed gers
            too_close = False
            for ox, oy, or_ in placed:
                dist = math.sqrt((px - ox) ** 2 + (py - oy) ** 2)
                if dist < r + or_ + min_gap:
                    too_close = True
                    break

            if too_close:
                continue

            # Check all vertices of the circle are inside polygon
            all_inside = True
            for k in range(8):
                angle = k * math.pi * 2 / 8
                test_pt = Point(px + r * math.cos(angle), py + r * math.sin(angle))
                if not self._point_in_polygon(test_pt, polygon):
                    all_inside = False
                    break

            if not all_inside:
                continue

            placed.append((px, py, r))

            # Create circular footprint as 16-gon
            circle = Polygon.circle(r)
            circle.offset(Point(px, py))

            result.buildings.append(BuildingFootprint(
                footprint=circle,
                building_type="ger",
                sub_type="yurt",
                stories=1,
                style_hints={"circular": True, "radius": round(r, 2)},
            ))

        return result

    @staticmethod
    def _point_in_polygon(pt: Point, poly: Polygon) -> bool:
        x, y = pt.x, pt.y
        inside = False
        n = len(poly)
        j = n - 1
        for i in range(n):
            xi, yi = poly[i].x, poly[i].y
            xj, yj = poly[j].x, poly[j].y
            if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
                inside = not inside
            j = i
        return inside
