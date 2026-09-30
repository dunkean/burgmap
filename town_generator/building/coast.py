"""Coast generator — creates an irregular coastline with water on one side."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.geom import geom_utils
from town_generator.utils.random import Random

if TYPE_CHECKING:
    from town_generator.building.model import Model


class Coast:
    def __init__(self, city_radius: float, roughness: float = 0.5) -> None:
        self.direction: float = 0.0
        self.shoreline: list[Point] = []
        self.water_polygon: Polygon = Polygon()

        self._generate(city_radius, roughness)

    def _generate(self, city_radius: float, roughness: float = 0.5) -> None:
        self.direction = Random.float() * 2 * math.pi
        shore_dist = city_radius * (0.4 + 0.3 * Random.float())

        cx = math.cos(self.direction) * shore_dist
        cy = math.sin(self.direction) * shore_dist

        perp_angle = self.direction + math.pi / 2
        extent = city_radius * 4

        p1 = Point(
            cx + math.cos(perp_angle) * extent,
            cy + math.sin(perp_angle) * extent,
        )
        p2 = Point(
            cx - math.cos(perp_angle) * extent,
            cy - math.sin(perp_angle) * extent,
        )

        raw_shoreline = self._midpoint_displacement(p1, p2, city_radius * roughness, 6)
        smoothed = self._chaikin_smooth(raw_shoreline, iterations=1)
        self.shoreline = self._add_micro_noise(smoothed, city_radius)

        water_offset = city_radius * 3
        dx = math.cos(self.direction) * water_offset
        dy = math.sin(self.direction) * water_offset

        far_p1 = Point(p1.x + dx, p1.y + dy)
        far_p2 = Point(p2.x + dx, p2.y + dy)

        self.water_polygon = Polygon(
            self.shoreline + [far_p2, far_p1]
        )

    def _midpoint_displacement(
        self, p1: Point, p2: Point, magnitude: float, depth: int
    ) -> list[Point]:
        if depth <= 0:
            return [p1, p2]

        mid = geom_utils.interpolate(p1, p2)
        d = p2.subtract(p1)
        normal = d.rotate90()
        normal.normalize((Random.float() - 0.5) * 2 * magnitude)
        mid.add_eq(normal)

        left = self._midpoint_displacement(p1, mid, magnitude * 0.55, depth - 1)
        right = self._midpoint_displacement(mid, p2, magnitude * 0.55, depth - 1)
        return left + right[1:]

    def _chaikin_smooth(self, points: list[Point], iterations: int = 1) -> list[Point]:
        """Apply Chaikin's corner-cutting subdivision to smooth a polyline."""
        for _ in range(iterations):
            if len(points) < 3:
                break
            new_pts = [points[0]]
            for i in range(len(points) - 1):
                p0 = points[i]
                p1 = points[i + 1]
                new_pts.append(Point(0.75 * p0.x + 0.25 * p1.x, 0.75 * p0.y + 0.25 * p1.y))
                new_pts.append(Point(0.25 * p0.x + 0.75 * p1.x, 0.25 * p0.y + 0.75 * p1.y))
            new_pts.append(points[-1])
            points = new_pts
        return points

    def _add_micro_noise(self, points: list[Point], city_radius: float) -> list[Point]:
        """Add small perpendicular offsets to every other point for micro-irregularity."""
        magnitude = city_radius * 0.02
        result: list[Point] = []
        n = len(points)
        for i in range(n):
            pt = points[i]
            if i % 2 == 1 and 0 < i < n - 1:
                # Compute tangent from neighbors
                tangent = points[i + 1].subtract(points[i - 1])
                normal = tangent.rotate90()
                normal.normalize((Random.float() - 0.5) * 2 * magnitude)
                result.append(Point(pt.x + normal.x, pt.y + normal.y))
            else:
                result.append(pt)
        return result

    def is_in_water(self, p: Point) -> bool:
        """Ray casting test for point in water polygon."""
        poly = self.water_polygon
        n = len(poly)
        if n < 3:
            return False
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

    def clip_patches(self, model: Model) -> None:
        """Remove patches whose centroids are fully in water."""
        from town_generator.building.patch import Patch
        surviving = []
        new_inner = []

        for patch in model.patches:
            centroid = patch.shape.centroid
            if self.is_in_water(centroid):
                wp = Patch(list(patch.shape))
                model.waterbody.append(wp)
            else:
                surviving.append(patch)
                if patch in model.inner:
                    new_inner.append(patch)

        model.patches = surviving
        model.inner = new_inner
