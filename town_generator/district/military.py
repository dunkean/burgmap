"""MilitaryPopulator — regular grid of barracks + parade ground.

Garrison districts: orderly rows of long rectangular barracks buildings
arranged around a central parade ground / drill square.
"""

from __future__ import annotations

import math

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.utils.random import Random
from town_generator.district.base import (
    BasePopulator, BuildingFootprint, PopulatorParams, PopulatorResult,
)


class MilitaryPopulator(BasePopulator):
    """Regular grid of long buildings + parade ground.

    Used for: Barracks, garrison, military camp districts.
    """

    name = "military"
    description = "Regular barracks grid with parade ground"

    def populate(self, polygon: Polygon, params: PopulatorParams) -> PopulatorResult:
        Random.reset(params.seed)
        result = PopulatorResult()

        bounds = polygon.get_bounds()
        bx, by, bx2, by2 = bounds
        bw = bx2 - bx
        bh = by2 - by

        if bw < 8 or bh < 8:
            return result

        centroid = polygon.centroid
        cx, cy = centroid.x, centroid.y

        # Main axis (very orderly — low chaos)
        ux, uy = self._find_main_axis(polygon)
        vx, vy = -uy, ux

        projs_u = [(p.x - cx) * ux + (p.y - cy) * uy for p in polygon]
        projs_v = [(p.x - cx) * vx + (p.y - cy) * vy for p in polygon]
        half_u = min(abs(min(projs_u)), abs(max(projs_u))) * 0.85
        half_v = min(abs(min(projs_v)), abs(max(projs_v))) * 0.85

        # Parade ground (central open area)
        parade_u = half_u * 0.35
        parade_v = half_v * 0.35
        parade = self._local_to_world_rect(
            -parade_u, -parade_v, parade_u, parade_v,
            cx, cy, ux, uy, vx, vy,
        )
        result.alleys.append(list(parade))

        # Barracks rows on each side of the parade ground
        barrack_w = max(3.0, half_u * 0.6)
        barrack_h = max(2.0, half_v * 0.15)
        gap = params.alley_width

        for side_u in [-1, 1]:
            u_start = parade_u + gap if side_u > 0 else -half_u
            u_end = half_u if side_u > 0 else -parade_u - gap

            v = -half_v + gap
            while v < half_v - barrack_h:
                bh_local = barrack_h + Random.float() * params.size_chaos * barrack_h * 0.2

                if Random.bool(params.empty_prob * 3):
                    v += bh_local + gap
                    continue

                bw_local = min(barrack_w, u_end - u_start)
                if bw_local < 2:
                    v += bh_local + gap
                    continue

                barrack = self._local_to_world_rect(
                    u_start, v, u_start + bw_local, v + bh_local,
                    cx, cy, ux, uy, vx, vy,
                )

                if self._centroid_in_polygon(barrack, polygon):
                    result.buildings.append(BuildingFootprint(
                        footprint=barrack,
                        building_type="barracks",
                        stories=1,
                        style_hints={"military": True},
                    ))

                v += bh_local + gap

        # Headquarters building (larger, at one end of parade ground)
        hq_w = barrack_w * 0.7
        hq_h = barrack_h * 1.5
        hq = self._local_to_world_rect(
            -hq_w / 2, parade_v + gap, hq_w / 2, parade_v + gap + hq_h,
            cx, cy, ux, uy, vx, vy,
        )
        if self._centroid_in_polygon(hq, polygon):
            result.buildings.append(BuildingFootprint(
                footprint=hq,
                building_type="headquarters",
                stories=2,
                style_hints={"military": True, "command": True},
            ))

        # Optional armory
        if Random.bool(0.6):
            arm_s = barrack_h * 1.2
            arm = self._local_to_world_rect(
                -hq_w / 2 - arm_s - gap, parade_v + gap,
                -hq_w / 2 - gap, parade_v + gap + arm_s,
                cx, cy, ux, uy, vx, vy,
            )
            if self._centroid_in_polygon(arm, polygon):
                result.buildings.append(BuildingFootprint(
                    footprint=arm,
                    building_type="armory",
                    stories=1,
                    style_hints={"military": True},
                ))

        return result

    @staticmethod
    def _local_to_world_rect(
        u0: float, v0: float, u1: float, v1: float,
        cx: float, cy: float,
        ux: float, uy: float, vx: float, vy: float,
    ) -> Polygon:
        corners = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
        pts = [Point(cx + lu * ux + lv * vx, cy + lu * uy + lv * vy) for lu, lv in corners]
        return Polygon(pts)

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
    def _centroid_in_polygon(rect: Polygon, boundary: Polygon) -> bool:
        pt = rect.centroid
        x, y = pt.x, pt.y
        inside = False
        n = len(boundary)
        j = n - 1
        for i in range(n):
            xi, yi = boundary[i].x, boundary[i].y
            xj, yj = boundary[j].x, boundary[j].y
            if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
                inside = not inside
            j = i
        return inside
