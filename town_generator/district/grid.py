"""GridPopulator — cardo/decumanus grid subdivision.

Roman-style regular grid layout: two perpendicular main axes (cardo and
decumanus), then each insula block is subdivided into row houses.
"""

from __future__ import annotations

import math

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.utils.random import Random
from town_generator.district.base import (
    BasePopulator, BuildingFootprint, PopulatorParams, PopulatorResult,
)


class GridPopulator(BasePopulator):
    """Regular cardo/decumanus grid subdivision.

    Used for: Roman, East Asian residential districts.
    """

    name = "grid"
    description = "Regular grid — Roman insula blocks"

    def populate(self, polygon: Polygon, params: PopulatorParams) -> PopulatorResult:
        Random.reset(params.seed)
        result = PopulatorResult()

        bounds = polygon.get_bounds()
        bx, by, bx2, by2 = bounds
        bw = bx2 - bx
        bh = by2 - by

        if bw < 2 or bh < 2:
            return result

        # Determine grid orientation from longest edge
        ux, uy = self._find_main_axis(polygon)
        vx, vy = -uy, ux  # perpendicular

        centroid = polygon.centroid
        cx, cy = centroid.x, centroid.y

        # Block size based on density
        block_size = max(6, params.min_area ** 0.5 * (2.0 - params.density))
        street_w = params.alley_width

        # Project polygon extent along axes
        projs_u = [(p.x - cx) * ux + (p.y - cy) * uy for p in polygon]
        projs_v = [(p.x - cx) * vx + (p.y - cy) * vy for p in polygon]
        min_u, max_u = min(projs_u), max(projs_u)
        min_v, max_v = min(projs_v), max(projs_v)

        # Inset from edges
        inset = street_w
        min_u += inset
        max_u -= inset
        min_v += inset
        max_v -= inset

        # Generate grid of blocks
        u = min_u
        while u < max_u:
            block_w = block_size + Random.float() * params.size_chaos * block_size * 0.3
            v = min_v
            while v < max_v:
                block_h = block_size + Random.float() * params.size_chaos * block_size * 0.3

                # Skip empty lots
                if Random.bool(params.empty_prob):
                    v += block_h + street_w
                    continue

                # Chaos: random offset
                du = Random.float() * params.grid_chaos * street_w * 0.5
                dv = Random.float() * params.grid_chaos * street_w * 0.5

                # Create building polygon in world coords
                corners = []
                for lu, lv in [(0, 0), (block_w, 0), (block_w, block_h), (0, block_h)]:
                    wx = cx + (u + lu + du) * ux + (v + lv + dv) * vx
                    wy = cy + (u + lu + du) * uy + (v + lv + dv) * vy
                    corners.append(Point(wx, wy))

                bldg = Polygon(corners)

                # Only keep if centroid is inside the district polygon
                if self._point_in_polygon(bldg.centroid, polygon):
                    stories = 1 + (1 if abs(bldg.square) > params.min_area * 2 else 0)
                    result.buildings.append(BuildingFootprint(
                        footprint=bldg,
                        building_type="insula",
                        stories=stories,
                        style_hints={"grid_aligned": True},
                    ))

                v += block_h + street_w
            u += block_w + street_w

        return result

    @staticmethod
    def _find_main_axis(polygon: Polygon) -> tuple[float, float]:
        """Find direction of longest edge as primary axis."""
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
        """Ray-casting point-in-polygon test."""
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
