"""MonasticPopulator — cloister quadrangle + chapel layout.

For cathedral/monastery campus districts: central cloister courtyard
surrounded by chapel, refectory, dormitory, and chapter house.
"""

from __future__ import annotations

import math

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.utils.random import Random
from town_generator.district.base import (
    BasePopulator, BuildingFootprint, PopulatorParams, PopulatorResult,
)


class MonasticPopulator(BasePopulator):
    """Cloister quadrangle: central court + surrounding buildings.

    Used for: Cathedral, monastery campus, temple compound.
    """

    name = "monastic"
    description = "Cloister quadrangle — chapel + refectory + dormitory"

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

        # Main axis from longest edge
        ux, uy = self._find_main_axis(polygon)
        vx, vy = -uy, ux

        # Bounding box in local coords
        projs_u = [(p.x - cx) * ux + (p.y - cy) * uy for p in polygon]
        projs_v = [(p.x - cx) * vx + (p.y - cy) * vy for p in polygon]
        half_u = min(abs(min(projs_u)), abs(max(projs_u))) * 0.85
        half_v = min(abs(min(projs_v)), abs(max(projs_v))) * 0.85

        # Ensure reasonable proportions
        half_u = max(half_u, 4)
        half_v = max(half_v, 4)

        # Cloister courtyard (central open space)
        court_u = half_u * 0.4
        court_v = half_v * 0.4

        courtyard = self._local_to_world_rect(
            -court_u, -court_v, court_u, court_v,
            cx, cy, ux, uy, vx, vy,
        )
        result.alleys.append(list(courtyard))

        wall_thickness = max(2.0, min(half_u, half_v) * 0.2)

        # Chapel (north side — +v direction, larger)
        chapel_depth = wall_thickness * (1.2 + Random.float() * 0.5)
        chapel = self._local_to_world_rect(
            -half_u * 0.8, court_v, half_u * 0.8, court_v + chapel_depth,
            cx, cy, ux, uy, vx, vy,
        )
        if self._centroid_in_polygon(chapel, polygon):
            result.buildings.append(BuildingFootprint(
                footprint=chapel,
                building_type="chapel",
                sub_type="nave",
                stories=2,
                style_hints={"religious": True},
            ))

        # Refectory (south side — -v direction)
        ref_depth = wall_thickness * (0.8 + Random.float() * 0.3)
        refectory = self._local_to_world_rect(
            -half_u * 0.6, -court_v - ref_depth, half_u * 0.6, -court_v,
            cx, cy, ux, uy, vx, vy,
        )
        if self._centroid_in_polygon(refectory, polygon):
            result.buildings.append(BuildingFootprint(
                footprint=refectory,
                building_type="refectory",
                stories=1,
            ))

        # Dormitory (east side — +u direction)
        dorm_depth = wall_thickness * (0.7 + Random.float() * 0.3)
        dormitory = self._local_to_world_rect(
            court_u, -half_v * 0.7, court_u + dorm_depth, half_v * 0.7,
            cx, cy, ux, uy, vx, vy,
        )
        if self._centroid_in_polygon(dormitory, polygon):
            result.buildings.append(BuildingFootprint(
                footprint=dormitory,
                building_type="dormitory",
                stories=2,
            ))

        # Chapter house (west side — -u direction)
        ch_depth = wall_thickness * (0.6 + Random.float() * 0.3)
        chapter = self._local_to_world_rect(
            -court_u - ch_depth, -half_v * 0.5, -court_u, half_v * 0.5,
            cx, cy, ux, uy, vx, vy,
        )
        if self._centroid_in_polygon(chapter, polygon):
            result.buildings.append(BuildingFootprint(
                footprint=chapter,
                building_type="chapter_house",
                stories=1,
            ))

        # Optional bell tower (corner of chapel)
        if Random.bool(0.6):
            tower_s = wall_thickness * 0.5
            tower_u = half_u * 0.8 - tower_s if Random.bool() else -half_u * 0.8
            tower_v = court_v + chapel_depth
            tower = self._local_to_world_rect(
                tower_u, tower_v, tower_u + tower_s, tower_v + tower_s,
                cx, cy, ux, uy, vx, vy,
            )
            if self._centroid_in_polygon(tower, polygon):
                result.buildings.append(BuildingFootprint(
                    footprint=tower,
                    building_type="tower",
                    sub_type="bell_tower",
                    stories=3,
                    style_hints={"tower": True},
                ))

        # Optional garden plots (small outbuildings)
        if Random.bool(0.5):
            for _ in range(2 + Random.int(0, 3)):
                gu = -half_u * 0.7 + Random.float() * half_u * 1.4
                gv = -half_v * 0.7 + Random.float() * half_v * 1.4

                # Skip if inside courtyard
                if abs(gu) < court_u and abs(gv) < court_v:
                    continue

                gs = wall_thickness * (0.3 + Random.float() * 0.3)
                garden = self._local_to_world_rect(
                    gu - gs, gv - gs, gu + gs, gv + gs,
                    cx, cy, ux, uy, vx, vy,
                )
                if self._centroid_in_polygon(garden, polygon):
                    result.buildings.append(BuildingFootprint(
                        footprint=garden,
                        building_type="outbuilding",
                        stories=1,
                    ))

        return result

    @staticmethod
    def _local_to_world_rect(
        u0: float, v0: float, u1: float, v1: float,
        cx: float, cy: float,
        ux: float, uy: float, vx: float, vy: float,
    ) -> Polygon:
        """Create a rectangle from local (u, v) coords to world coords."""
        corners = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
        pts = []
        for lu, lv in corners:
            pts.append(Point(cx + lu * ux + lv * vx, cy + lu * uy + lv * vy))
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
