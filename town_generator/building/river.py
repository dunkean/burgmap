"""River generator — creates a river through the city."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.geom.segment import Segment
from town_generator.geom import geom_utils
from town_generator.utils.random import Random

if TYPE_CHECKING:
    from town_generator.building.model import Model


class River:
    def __init__(self, city_radius: float, coast_direction: float | None = None, curvature: float = 3.0) -> None:
        self.width: float = 6 + Random.float() * 4
        self.path: list[Point] = []
        self.left_bank: list[Point] = []
        self.right_bank: list[Point] = []
        self.polygon: Polygon = Polygon()
        self.bridges: list[Segment] = []

        self._generate(city_radius, coast_direction, curvature)

    def _generate(self, city_radius: float, coast_direction: float | None = None, curvature: float = 3.0) -> None:
        if coast_direction is not None:
            # River flows toward the coast — exit angle points into the water
            exit_angle = coast_direction
            entry_angle = exit_angle + math.pi + (Random.float() - 0.5) * math.pi / 4
        else:
            entry_angle = Random.float() * 2 * math.pi
            exit_angle = entry_angle + math.pi + (Random.float() - 0.5) * math.pi / 3

        extent = city_radius * 5.0

        entry = Point(math.cos(entry_angle) * extent, math.sin(entry_angle) * extent)
        exit_pt = Point(math.cos(exit_angle) * extent, math.sin(exit_angle) * extent)

        raw_path = self._midpoint_displacement(entry, exit_pt, city_radius * curvature, 6)
        self.path = self._chaikin_smooth(raw_path, iterations=1)

        self.left_bank = []
        self.right_bank = []
        half_w = self.width / 2
        n_points = len(self.path)

        for i in range(n_points):
            if i == 0:
                tangent = self.path[1].subtract(self.path[0])
            elif i == n_points - 1:
                tangent = self.path[-1].subtract(self.path[-2])
            else:
                tangent = self.path[i + 1].subtract(self.path[i - 1])

            # Estuary: river widens from entry (0.6x) to exit (2.5x)
            t = i / (n_points - 1) if n_points > 1 else 0.5
            current_half_w = half_w * (0.6 + t * 1.9)

            normal = tangent.rotate90()
            normal.normalize(current_half_w)

            self.left_bank.append(self.path[i].add(normal))
            self.right_bank.append(self.path[i].subtract(normal))

        self.polygon = Polygon(
            self.left_bank + list(reversed(self.right_bank))
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

    def _chaikin_smooth(self, points: list[Point], iterations: int = 2) -> list[Point]:
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

    def point_in_river(self, p: Point) -> bool:
        """Ray casting test for point inside river polygon."""
        poly = self.polygon
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
        """Remove patches whose centroids are fully submerged. Leave partial ones intact."""
        from town_generator.building.patch import Patch
        surviving = []
        for patch in model.patches:
            centroid = patch.shape.centroid
            if self.point_in_river(centroid):
                wp = Patch(list(patch.shape))
                model.waterbody.append(wp)
                if patch in model.inner:
                    model.inner.remove(patch)
            else:
                surviving.append(patch)
        model.patches = surviving

    def find_bridges(self, arteries: list[Polygon], coast=None) -> None:
        """Detect where arteries cross the river.

        If *coast* is provided, bridges whose midpoint falls inside the
        coast water area (i.e. over the sea) are silently skipped.
        """
        self.bridges = []
        for artery in arteries:
            for i in range(len(artery) - 1):
                p1 = artery[i]
                p2 = artery[i + 1]
                # Check if this segment crosses the river polygon
                if self._segment_crosses_river(p1, p2):
                    if coast is not None:
                        mid = Point((p1.x + p2.x) / 2, (p1.y + p2.y) / 2)
                        if coast.is_in_water(mid):
                            continue  # skip bridges in the sea
                    self.bridges.append(Segment(p1, p2))

    def _segment_crosses_river(self, p1: Point, p2: Point) -> bool:
        """Test if a segment crosses the river polygon boundary."""
        dx1 = p2.x - p1.x
        dy1 = p2.y - p1.y
        poly = self.polygon
        n = len(poly)
        for i in range(n):
            v0 = poly[i]
            v1 = poly[(i + 1) % n]
            t = geom_utils.intersect_lines(
                p1.x, p1.y, dx1, dy1,
                v0.x, v0.y, v1.x - v0.x, v1.y - v0.y
            )
            if t is not None and 0 <= t.x <= 1 and 0 <= t.y <= 1:
                return True
        return False
