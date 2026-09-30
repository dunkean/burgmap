from __future__ import annotations
import math
from typing import TYPE_CHECKING
from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.geom import geom_utils
from town_generator.wards.ward import Ward
from town_generator.utils.random import Random
if TYPE_CHECKING:
    from town_generator.building.model import Model
    from town_generator.building.patch import Patch


class Market(Ward):
    def create_geometry(self) -> None:
        statue = Random.bool(0.6)
        offset = statue or Random.bool(0.3)

        v0 = None
        v1 = None
        if statue or offset:
            best_length = -1.0
            def _find(p0: Point, p1: Point) -> None:
                nonlocal v0, v1, best_length
                ln = Point.distance(p0, p1)
                if ln > best_length:
                    best_length = ln
                    v0, v1 = p0, p1
            self.patch.shape.for_edge(_find)

        if statue:
            obj = Polygon.rect(1.5 + Random.float() * 1.5, 1.5 + Random.float() * 1.5)
            obj.rotate(math.atan2(v1.y - v0.y, v1.x - v0.x))
        else:
            obj = Polygon.circle(1.5 + Random.float() * 1.0)

        if offset:
            gravity = geom_utils.interpolate(v0, v1)
            center = geom_utils.interpolate(self.patch.shape.centroid, gravity, 0.2 + Random.float() * 0.4)
            obj.offset(center)
        else:
            center = self.patch.shape.centroid
            obj.offset(center)

        self.geometry = [obj]

        # Market stalls around monument
        n_stalls = 3 + Random.int(0, 3)
        stall_angle = Random.float() * 2 * math.pi
        stall_dist = 3.0 + Random.float() * 2.0
        for i in range(n_stalls):
            angle = stall_angle + i * (2 * math.pi / n_stalls)
            sx = center.x + math.cos(angle) * stall_dist
            sy = center.y + math.sin(angle) * stall_dist
            stall = Polygon.rect(0.8 + Random.float() * 0.6, 0.5 + Random.float() * 0.4)
            stall.rotate(angle)
            stall.offset(Point(sx, sy))
            # Only add stall if it's inside the patch shape
            sc = stall.centroid
            if self._point_in_shape(sc):
                self.geometry.append(stall)
        self._filter_water()

    def _point_in_shape(self, p: Point) -> bool:
        """Ray casting test for point in patch shape."""
        poly = self.patch.shape
        n = len(poly)
        inside = False
        j = n - 1
        for i in range(n):
            pi = poly[i]
            pj = poly[j]
            if ((pi.y > p.y) != (pj.y > p.y)) and \
               (p.x < (pj.x - pi.x) * (p.y - pi.y) / (pj.y - pi.y) + pi.x):
                inside = not inside
            j = i
        return inside

    @staticmethod
    def rate_location(model: Model, patch: Patch) -> float:
        for p in model.inner:
            if isinstance(p.ward, Market) and p.shape.borders(patch.shape):
                return float("inf")
        if model.plaza is not None:
            return patch.shape.square / model.plaza.shape.square
        return patch.shape.distance(model.center)

    def get_label(self) -> str:
        return "Market"
