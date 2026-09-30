"""BazaarPopulator — narrow alleys with market stalls along walls.

Arabic commercial districts: a main artery through the polygon with narrow
branching alleys. Buildings (stalls/shops) line both sides of each alley.
"""

from __future__ import annotations

import math

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.utils.random import Random
from town_generator.district.base import (
    BasePopulator, BuildingFootprint, PopulatorParams, PopulatorResult,
)


class BazaarPopulator(BasePopulator):
    """Narrow alleys + stalls along walls.

    Used for: Arabic commercial / souk districts.
    """

    name = "bazaar"
    description = "Narrow alleys with market stalls — Arabic souk"

    def populate(self, polygon: Polygon, params: PopulatorParams) -> PopulatorResult:
        Random.reset(params.seed)
        result = PopulatorResult()

        bounds = polygon.get_bounds()
        bx, by, bx2, by2 = bounds
        bw = bx2 - bx
        bh = by2 - by

        if bw < 4 or bh < 4:
            return result

        # Main axis along longest edge
        ux, uy = self._find_main_axis(polygon)
        vx, vy = -uy, ux

        centroid = polygon.centroid
        cx, cy = centroid.x, centroid.y

        # Project polygon to get extent along axes
        projs_u = [(p.x - cx) * ux + (p.y - cy) * uy for p in polygon]
        projs_v = [(p.x - cx) * vx + (p.y - cy) * vy for p in polygon]
        min_u, max_u = min(projs_u), max(projs_u)
        min_v, max_v = min(projs_v), max(projs_v)

        alley_w = params.alley_width * 0.6  # narrow alleys
        stall_depth = max(2.5, params.min_area ** 0.5 * 0.6)
        stall_width = max(2.0, params.min_area ** 0.5 * 0.5)

        # Main artery runs along u-axis through the center
        main_alley = [
            Point(cx + min_u * ux + 0 * vx, cy + min_u * uy + 0 * vy),
            Point(cx + max_u * ux + 0 * vx, cy + max_u * uy + 0 * vy),
        ]
        result.alleys.append(main_alley)

        # Branch alleys perpendicular at intervals
        branch_spacing = stall_width * 3 + alley_w
        u = min_u + branch_spacing
        while u < max_u - branch_spacing * 0.5:
            # Branch goes in +v and -v from the main artery
            for sign in [1, -1]:
                branch_start = Point(
                    cx + u * ux + alley_w * 0.5 * sign * vx,
                    cy + u * uy + alley_w * 0.5 * sign * vy,
                )
                branch_end_v = max_v * 0.7 if sign > 0 else min_v * 0.7
                branch_end = Point(
                    cx + u * ux + branch_end_v * vx,
                    cy + u * uy + branch_end_v * vy,
                )

                # Check if branch endpoints are inside polygon
                if self._point_in_polygon(branch_end, polygon):
                    result.alleys.append([branch_start, branch_end])

            u += branch_spacing + Random.float() * params.grid_chaos * branch_spacing * 0.5

        # Place stalls along the main artery on both sides
        u = min_u + alley_w
        while u < max_u - stall_width:
            sw = stall_width + Random.float() * params.size_chaos * stall_width * 0.3

            for side in [1, -1]:
                if Random.bool(params.empty_prob):
                    continue

                sd = stall_depth + Random.float() * params.size_chaos * stall_depth * 0.2
                v_start = alley_w * 0.5 * side
                v_end = v_start + sd * side

                # Stall corners in local coords
                corners = [
                    (u, v_start), (u + sw, v_start),
                    (u + sw, v_end), (u, v_end),
                ]

                # Transform to world coords
                world_pts = []
                for lu, lv in corners:
                    wx = cx + lu * ux + lv * vx
                    wy = cy + lu * uy + lv * vy
                    world_pts.append(Point(wx, wy))

                stall = Polygon(world_pts)

                if self._point_in_polygon(stall.centroid, polygon):
                    result.buildings.append(BuildingFootprint(
                        footprint=stall,
                        building_type="shop",
                        sub_type="stall",
                        stories=1,
                        style_hints={"market_stall": True},
                    ))

            u += sw + alley_w * 0.5

        # Place stalls along branch alleys
        for alley_pts in result.alleys[1:]:  # skip main artery
            if len(alley_pts) < 2:
                continue
            a0, a1 = alley_pts[0], alley_pts[1]
            dx = a1.x - a0.x
            dy = a1.y - a0.y
            length = math.sqrt(dx * dx + dy * dy)
            if length < stall_width * 2:
                continue

            # Perpendicular to branch direction
            bux = dx / length
            buy = dy / length
            bvx = -buy
            bvy = bux

            t = alley_w
            while t < length - stall_width:
                sw = stall_width + Random.float() * params.size_chaos * stall_width * 0.2
                for side in [1, -1]:
                    if Random.bool(params.empty_prob * 2):
                        continue

                    sd = stall_depth * 0.8

                    wx0 = a0.x + t * bux + alley_w * 0.3 * side * bvx
                    wy0 = a0.y + t * buy + alley_w * 0.3 * side * bvy

                    stall_pts = [
                        Point(wx0, wy0),
                        Point(wx0 + sw * bux, wy0 + sw * buy),
                        Point(wx0 + sw * bux + sd * side * bvx, wy0 + sw * buy + sd * side * bvy),
                        Point(wx0 + sd * side * bvx, wy0 + sd * side * bvy),
                    ]
                    stall = Polygon(stall_pts)
                    if self._point_in_polygon(stall.centroid, polygon):
                        result.buildings.append(BuildingFootprint(
                            footprint=stall,
                            building_type="shop",
                            sub_type="stall",
                            stories=1,
                            style_hints={"market_stall": True},
                        ))

                t += sw + alley_w * 0.4

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
