"""PalacePopulator — walled compound with inner court and wings.

Noble/palace compound districts: outer wall (represented as the polygon
boundary), inner courtyard, and multiple wings for great hall, living
quarters, service buildings.
"""

from __future__ import annotations

import math

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.utils.random import Random
from town_generator.district.base import (
    BasePopulator, BuildingFootprint, PopulatorParams, PopulatorResult,
)


class PalacePopulator(BasePopulator):
    """Walled compound + inner court + wings.

    Used for: Palace, noble compound, khan's palace.
    """

    name = "palace"
    description = "Palace compound — walled court with wings"

    def populate(self, polygon: Polygon, params: PopulatorParams) -> PopulatorResult:
        Random.reset(params.seed)
        result = PopulatorResult()

        bounds = polygon.get_bounds()
        bx, by, bx2, by2 = bounds
        bw = bx2 - bx
        bh = by2 - by

        if bw < 10 or bh < 10:
            return result

        centroid = polygon.centroid
        cx, cy = centroid.x, centroid.y

        ux, uy = self._find_main_axis(polygon)
        vx, vy = -uy, ux

        projs_u = [(p.x - cx) * ux + (p.y - cy) * uy for p in polygon]
        projs_v = [(p.x - cx) * vx + (p.y - cy) * vy for p in polygon]
        half_u = min(abs(min(projs_u)), abs(max(projs_u))) * 0.82
        half_v = min(abs(min(projs_v)), abs(max(projs_v))) * 0.82

        half_u = max(half_u, 5)
        half_v = max(half_v, 5)

        # Inner courtyard
        court_u = half_u * 0.3
        court_v = half_v * 0.3
        courtyard = self._rect(
            -court_u, -court_v, court_u, court_v,
            cx, cy, ux, uy, vx, vy,
        )
        result.alleys.append(list(courtyard))

        # Great hall (main building, back of compound)
        hall_w = half_u * (0.7 + Random.float() * 0.2)
        hall_h = max(2.0, half_v * (0.2 + Random.float() * 0.1))
        hall = self._rect(
            -hall_w / 2, court_v, hall_w / 2, court_v + hall_h,
            cx, cy, ux, uy, vx, vy,
        )
        if self._inside(hall, polygon):
            result.buildings.append(BuildingFootprint(
                footprint=hall,
                building_type="great_hall",
                stories=2,
                style_hints={"palace": True, "main": True},
            ))

        # Side wings (east and west)
        for side in [-1, 1]:
            wing_w = max(2.0, half_u * (0.15 + Random.float() * 0.1))
            wing_h = half_v * (0.5 + Random.float() * 0.3)
            u_start = court_u if side > 0 else -court_u - wing_w
            wing = self._rect(
                u_start, -wing_h / 2, u_start + wing_w, wing_h / 2,
                cx, cy, ux, uy, vx, vy,
            )
            if self._inside(wing, polygon):
                result.buildings.append(BuildingFootprint(
                    footprint=wing,
                    building_type="wing",
                    sub_type="living_quarters" if side > 0 else "service",
                    stories=2,
                    style_hints={"palace": True},
                ))

        # Gate house (front, opposite great hall)
        gate_w = max(2.0, half_u * 0.25)
        gate_h = max(1.5, half_v * 0.1)
        gate = self._rect(
            -gate_w / 2, -court_v - gate_h * 2, gate_w / 2, -court_v - gate_h,
            cx, cy, ux, uy, vx, vy,
        )
        if self._inside(gate, polygon):
            result.buildings.append(BuildingFootprint(
                footprint=gate,
                building_type="gatehouse",
                stories=2,
                style_hints={"palace": True, "entrance": True},
            ))

        # Optional corner towers
        if Random.bool(0.5):
            tower_s = max(1.5, min(half_u, half_v) * 0.1)
            for su, sv in [(-1, -1), (-1, 1), (1, -1), (1, 1)]:
                if Random.bool(0.4):
                    continue
                tu = su * (half_u - tower_s * 0.5)
                tv = sv * (half_v - tower_s * 0.5)
                tower = self._rect(
                    tu - tower_s, tv - tower_s, tu + tower_s, tv + tower_s,
                    cx, cy, ux, uy, vx, vy,
                )
                if self._inside(tower, polygon):
                    result.buildings.append(BuildingFootprint(
                        footprint=tower,
                        building_type="tower",
                        stories=3,
                        style_hints={"palace": True, "tower": True},
                    ))

        # Optional gardens (outbuildings)
        n_gardens = Random.int(0, 3)
        for _ in range(n_gardens):
            gu = (Random.float() - 0.5) * half_u * 1.2
            gv = -half_v * (0.5 + Random.float() * 0.3)
            gs = max(1.0, min(half_u, half_v) * 0.08)
            garden = self._rect(
                gu - gs, gv - gs, gu + gs, gv + gs,
                cx, cy, ux, uy, vx, vy,
            )
            if self._inside(garden, polygon):
                result.buildings.append(BuildingFootprint(
                    footprint=garden,
                    building_type="outbuilding",
                    sub_type="garden_pavilion",
                    stories=1,
                    style_hints={"palace": True},
                ))

        return result

    @staticmethod
    def _rect(u0, v0, u1, v1, cx, cy, ux, uy, vx, vy) -> Polygon:
        pts = [Point(cx + lu * ux + lv * vx, cy + lu * uy + lv * vy)
               for lu, lv in [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]]
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
    def _inside(rect: Polygon, boundary: Polygon) -> bool:
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
