"""CourtyardPopulator — courtyard inset with outer ring buildings.

Arabic/East Asian noble districts: inset the polygon to form an inner courtyard,
then divide the outer ring into building cells with radial cuts.
"""

from __future__ import annotations

import math

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.utils.random import Random
from town_generator.district.base import (
    BasePopulator, BuildingFootprint, PopulatorParams, PopulatorResult,
)


class CourtyardPopulator(BasePopulator):
    """Courtyard compound: inset polygon → inner court, outer ring → buildings.

    Used for: Arabic, East Asian noble, palace compound districts.
    """

    name = "courtyard"
    description = "Courtyard compound — inset court with outer ring"

    def populate(self, polygon: Polygon, params: PopulatorParams) -> PopulatorResult:
        Random.reset(params.seed)
        result = PopulatorResult()

        area = abs(polygon.square)
        if area < params.min_area * 2 or len(polygon) < 3:
            return result

        # Courtyard inset depth: proportional to polygon size
        perim = polygon.perimeter
        avg_radius = math.sqrt(area / math.pi)
        court_depth = avg_radius * (0.3 + 0.15 * params.density)

        # Create the inner courtyard by uniform inset
        inset_dists = [court_depth] * len(polygon)
        if polygon.is_convex():
            inner = polygon.shrink(inset_dists)
        else:
            inner = polygon.buffer(inset_dists)

        if len(inner) < 3 or abs(inner.square) < params.min_area * 0.5:
            # Too small for a courtyard — fall back to single building
            result.buildings.append(BuildingFootprint(
                footprint=polygon,
                building_type="house",
                sub_type="solid_block",
            ))
            return result

        # Record courtyard as an alley (open space)
        result.alleys.append(list(inner))

        # Generate buildings in the outer ring by creating sectors between
        # outer polygon vertices and their inset counterparts
        n = len(polygon)
        n_inner = len(inner)

        if n_inner == n:
            # Same vertex count — pair them up for clean sectors
            buildings = self._paired_sectors(polygon, inner, params)
        else:
            # Different counts — use radial cuts from centroid
            buildings = self._radial_sectors(polygon, inner, params)

        for b in buildings:
            result.buildings.append(b)

        return result

    @staticmethod
    def _paired_sectors(
        outer: Polygon, inner: Polygon, params: PopulatorParams,
    ) -> list[BuildingFootprint]:
        """Create building sectors when outer and inner have matching vertices."""
        n = len(outer)
        buildings: list[BuildingFootprint] = []

        for i in range(n):
            i_next = (i + 1) % n
            # Quad from outer[i], outer[i+1], inner[i+1], inner[i]
            sector = Polygon([
                outer[i], outer[i_next],
                inner[i_next % len(inner)], inner[i % len(inner)],
            ])

            if abs(sector.square) < params.min_area * 0.3:
                continue

            if Random.bool(params.empty_prob):
                continue

            # Optionally subdivide large sectors
            if abs(sector.square) > params.min_area * 3 and Random.bool(0.6):
                subs = CourtyardPopulator._subdivide_sector(sector, params.min_area)
                for s in subs:
                    buildings.append(BuildingFootprint(
                        footprint=s,
                        building_type="house",
                        sub_type="courtyard_wing",
                        stories=1 + (1 if abs(s.square) > params.min_area * 2 else 0),
                        style_hints={"has_courtyard": True},
                    ))
            else:
                buildings.append(BuildingFootprint(
                    footprint=sector,
                    building_type="house",
                    sub_type="courtyard_wing",
                    stories=1 + (1 if abs(sector.square) > params.min_area * 2 else 0),
                    style_hints={"has_courtyard": True},
                ))

        return buildings

    @staticmethod
    def _radial_sectors(
        outer: Polygon, inner: Polygon, params: PopulatorParams,
    ) -> list[BuildingFootprint]:
        """Create building sectors using radial cuts from centroid."""
        center = outer.centroid
        buildings: list[BuildingFootprint] = []

        for i in range(len(outer)):
            i_next = (i + 1) % len(outer)

            # Find closest inner vertex to each outer vertex
            def _closest(target: Point, poly: Polygon) -> Point:
                best = poly[0]
                best_d = Point.distance(target, best)
                for v in poly:
                    d = Point.distance(target, v)
                    if d < best_d:
                        best_d = d
                        best = v
                return best

            in_a = _closest(outer[i], inner)
            in_b = _closest(outer[i_next], inner)

            if in_a is in_b:
                # Triangle sector
                sector = Polygon([outer[i], outer[i_next], in_a])
            else:
                sector = Polygon([outer[i], outer[i_next], in_b, in_a])

            if abs(sector.square) < params.min_area * 0.3 or len(sector) < 3:
                continue
            if Random.bool(params.empty_prob):
                continue

            buildings.append(BuildingFootprint(
                footprint=sector,
                building_type="house",
                sub_type="courtyard_wing",
                stories=1,
                style_hints={"has_courtyard": True},
            ))

        return buildings

    @staticmethod
    def _subdivide_sector(sector: Polygon, min_area: float) -> list[Polygon]:
        """Split a sector roughly in half along its short dimension."""
        if len(sector) != 4 or abs(sector.square) < min_area:
            return [sector]

        # Midpoints of the two "radial" edges (edges 0-3 and 1-2)
        m1 = Point((sector[0].x + sector[3].x) / 2, (sector[0].y + sector[3].y) / 2)
        m2 = Point((sector[1].x + sector[2].x) / 2, (sector[1].y + sector[2].y) / 2)

        half1 = Polygon([sector[0], sector[1], m2, m1])
        half2 = Polygon([m1, m2, sector[2], sector[3]])

        results: list[Polygon] = []
        for h in [half1, half2]:
            if abs(h.square) >= min_area * 0.3 and len(h) >= 3:
                results.append(h)
        return results if results else [sector]
