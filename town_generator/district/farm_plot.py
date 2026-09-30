"""FarmPlotPopulator — strip fields with farmhouse cluster.

Agriculture districts outside city walls: rectangular strip fields
radiating from a central farmhouse cluster.
"""

from __future__ import annotations

import math

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.utils.random import Random
from town_generator.district.base import (
    BasePopulator, BuildingFootprint, PopulatorParams, PopulatorResult,
)


class FarmPlotPopulator(BasePopulator):
    """Strip fields + farmhouse cluster.

    Used for: Agricultural outskirts, countryside.
    """

    name = "farm_plot"
    description = "Strip fields with farmhouse cluster"

    def populate(self, polygon: Polygon, params: PopulatorParams) -> PopulatorResult:
        Random.reset(params.seed)
        result = PopulatorResult()

        bounds = polygon.get_bounds()
        bx, by, bx2, by2 = bounds
        bw = bx2 - bx
        bh = by2 - by

        if bw < 6 or bh < 6:
            return result

        centroid = polygon.centroid
        cx, cy = centroid.x, centroid.y

        # Main axis
        ux, uy = self._find_main_axis(polygon)
        vx, vy = -uy, ux

        # Project extent
        projs_u = [(p.x - cx) * ux + (p.y - cy) * uy for p in polygon]
        projs_v = [(p.x - cx) * vx + (p.y - cy) * vy for p in polygon]
        min_u, max_u = min(projs_u), max(projs_u)
        min_v, max_v = min(projs_v), max(projs_v)

        # Farmhouse cluster near centroid
        farm_size = max(2.5, min(bw, bh) * 0.08)
        n_buildings = 1 + Random.int(0, 3)
        for _ in range(n_buildings):
            fu = Random.float() * farm_size * 2 - farm_size
            fv = Random.float() * farm_size * 2 - farm_size
            fw = farm_size * (0.6 + Random.float() * 0.4)
            fh = farm_size * (0.6 + Random.float() * 0.4)

            corners = []
            for lu, lv in [(fu, fv), (fu + fw, fv), (fu + fw, fv + fh), (fu, fv + fh)]:
                corners.append(Point(cx + lu * ux + lv * vx, cy + lu * uy + lv * vy))
            bldg = Polygon(corners)

            if self._point_in_polygon(bldg.centroid, polygon):
                result.buildings.append(BuildingFootprint(
                    footprint=bldg,
                    building_type="farmhouse",
                    stories=1,
                    style_hints={"rural": True},
                ))

        # Strip fields radiating outward
        strip_width = max(3.0, params.min_area ** 0.5 * 0.4)
        strip_gap = params.alley_width * 0.3

        v = min_v + strip_gap
        while v < max_v - strip_width:
            sw = strip_width + Random.float() * params.size_chaos * strip_width * 0.3

            if Random.bool(0.15):  # fallow field (skip)
                v += sw + strip_gap
                continue

            # Strip runs full length along u-axis, outside farmhouse area
            for u_start, u_end in [(min_u + 1, -farm_size * 1.5), (farm_size * 1.5, max_u - 1)]:
                if u_end <= u_start:
                    continue

                corners = [
                    (u_start, v), (u_end, v),
                    (u_end, v + sw), (u_start, v + sw),
                ]
                world_pts = [
                    Point(cx + lu * ux + lv * vx, cy + lu * uy + lv * vy)
                    for lu, lv in corners
                ]
                strip = Polygon(world_pts)

                if self._point_in_polygon(strip.centroid, polygon):
                    result.buildings.append(BuildingFootprint(
                        footprint=strip,
                        building_type="field",
                        sub_type="strip_field",
                        stories=0,
                        style_hints={"agricultural": True, "fallow": False},
                    ))

            v += sw + strip_gap

        return result

    @staticmethod
    def _find_main_axis(polygon: Polygon) -> tuple[float, float]:
        best_len = 0.0
        best_ux, best_uy = 1.0, 0.0
        for i in range(len(polygon)):
            v0 = polygon[i]
            v1 = polygon[(i + 1) % len(polygon)]
            dx = v1.x - v0.x
            dy = v1.y - v0.y
            d = math.sqrt(dx * dx + dy * dy)
            if d > best_len:
                best_len = d
                best_ux = dx / d
                best_uy = dy / d
        return best_ux, best_uy

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
