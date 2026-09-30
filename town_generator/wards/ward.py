"""Base Ward class — createAlleys, createOrthoBuilding, getCityBlock, filterOutskirts.
Port of Ward.hx.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.geom import geom_utils
from town_generator.utils.random import Random
from town_generator.building.cutter import bisect
from town_generator.utils import array_utils

if TYPE_CHECKING:
    from town_generator.building.model import Model
    from town_generator.building.patch import Patch


MAIN_STREET = 2.0
REGULAR_STREET = 1.0
ALLEY = 0.6


class Ward:
    def __init__(self, model: Model, patch: Patch) -> None:
        self.model = model
        self.patch = patch
        self.geometry: list[Polygon] = []

    def create_geometry(self) -> None:
        self.geometry = []

    def get_city_block(self) -> Polygon:
        inset_dist: list[float] = []
        inner_patch = self.model.wall is None or self.patch.within_walls

        def _calc_inset(v0: Point, v1: Point) -> None:
            if self.model.wall is not None and self.model.wall.borders_by(self.patch, v0, v1):
                inset_dist.append(MAIN_STREET / 2)
            else:
                on_street = (
                    inner_patch
                    and self.model.plaza is not None
                    and self.model.plaza.shape.find_edge(v1, v0) != -1
                )
                if not on_street:
                    for street in self.model.arteries:
                        if street.contains_point(v0) and street.contains_point(v1):
                            on_street = True
                            break
                alley_w = getattr(self.model, 'alley_width', ALLEY)
                inset_dist.append(
                    (MAIN_STREET if on_street else (REGULAR_STREET if inner_patch else alley_w)) / 2
                )

        self.patch.shape.for_edge(_calc_inset)

        if self.patch.shape.is_convex():
            return self.patch.shape.shrink(inset_dist)
        else:
            return self.patch.shape.buffer(inset_dist)

    def _filter_water(self) -> None:
        """Remove buildings that fall inside water bodies."""
        if self.model.river is not None:
            def _not_in_river(b: Polygon) -> bool:
                if self.model.river.point_in_river(b.centroid):
                    return False
                for v in b:
                    if self.model.river.point_in_river(v):
                        return False
                return True
            self.geometry = [b for b in self.geometry if _not_in_river(b)]
        if self.model.coast is not None:
            def _not_in_coast(b: Polygon) -> bool:
                if self.model.coast.is_in_water(b.centroid):
                    return False
                for v in b:
                    if self.model.coast.is_in_water(v):
                        return False
                return True
            self.geometry = [b for b in self.geometry if _not_in_coast(b)]

    def _filter_outskirts(self) -> None:
        populated_edges: list[dict] = []

        def add_edge(v1: Point, v2: Point, factor: float = 1.0) -> None:
            dx = v2.x - v1.x
            dy = v2.y - v1.y
            distances: dict[int, float] = {}

            def _rate(v: Point) -> float:
                val = (
                    geom_utils.distance2line(v1.x, v1.y, dx, dy, v.x, v.y)
                    if v is not v1 and v is not v2
                    else 0
                ) * factor
                distances[id(v)] = val
                return val

            d = array_utils.max_by(list(self.patch.shape), _rate)
            populated_edges.append({
                "x": v1.x, "y": v1.y, "dx": dx, "dy": dy, "d": distances[id(d)]
            })

        def _check_edge(v1: Point, v2: Point) -> None:
            on_road = False
            for street in self.model.arteries:
                if street.contains_point(v1) and street.contains_point(v2):
                    on_road = True
                    break

            if on_road:
                add_edge(v1, v2, 1)
            else:
                n = self.model.get_neighbour(self.patch, v1)
                if n is not None:
                    if n.within_city:
                        add_edge(v1, v2, 1 if self.model.is_enclosed(n) else 0.4)

        self.patch.shape.for_edge(_check_edge)

        density: list[float] = []
        for v in self.patch.shape:
            if any(v is g for g in self.model.gates):
                density.append(1)
            elif all(p.within_city for p in self.model.patch_by_vertex(v)):
                density.append(2 * Random.float())
            else:
                density.append(0)

        def _keep(building: Polygon) -> bool:
            min_dist = 1.0
            for edge in populated_edges:
                for v in building:
                    d = geom_utils.distance2line(edge["x"], edge["y"], edge["dx"], edge["dy"], v.x, v.y)
                    dist = d / edge["d"] if edge["d"] != 0 else 1.0
                    if dist < min_dist:
                        min_dist = dist

            c = building.center
            interp = self.patch.shape.interpolate(c)
            p = 0.0
            for j in range(len(interp)):
                p += density[j] * interp[j]
            if p != 0:
                min_dist /= p

            return Random.fuzzy(1) > min_dist

        self.geometry = [b for b in self.geometry if _keep(b)]

    def _get_road_direction(self) -> tuple[float, float] | None:
        """Direction (ux, uy) of the longest road-facing edge on this patch."""
        best_len = 0.0
        best_dir = None
        inner_patch = self.model.wall is None or self.patch.within_walls

        def _check(v0: Point, v1: Point) -> None:
            nonlocal best_len, best_dir
            on_street = False
            if self.model.wall is not None and self.model.wall.borders_by(self.patch, v0, v1):
                on_street = True
            elif (inner_patch and self.model.plaza is not None
                  and self.model.plaza.shape.find_edge(v1, v0) != -1):
                on_street = True
            else:
                for street in self.model.arteries:
                    if street.contains_point(v0) and street.contains_point(v1):
                        on_street = True
                        break
            if on_street:
                dx = v1.x - v0.x
                dy = v1.y - v0.y
                d = math.sqrt(dx * dx + dy * dy)
                if d > best_len:
                    best_len = d
                    best_dir = (dx / d, dy / d)

        self.patch.shape.for_edge(_check)
        return best_dir

    def get_label(self) -> str | None:
        return None

    @staticmethod
    def rate_location(model: Model, patch: Patch) -> float:
        return 0

    @staticmethod
    def create_alleys(
        p: Polygon,
        min_sq: float,
        grid_chaos: float,
        size_chaos: float,
        empty_prob: float = 0.04,
        split: bool = True,
        alley_width: float | None = None,
    ) -> list[Polygon]:
        if alley_width is None:
            alley_width = ALLEY

        # Find longest edge
        best_v: Point | None = None
        best_length = -1.0

        def _find_longest(p0: Point, p1: Point) -> None:
            nonlocal best_v, best_length
            ln = Point.distance(p0, p1)
            if ln > best_length:
                best_length = ln
                best_v = p0

        p.for_edge(_find_longest)

        spread = 0.8 * grid_chaos
        ratio = (1 - spread) / 2 + Random.float() * spread

        angle_spread = math.pi / 6 * grid_chaos * (0.0 if p.square < min_sq * 4 else 1)
        b = (Random.float() - 0.5) * angle_spread

        halves = bisect(p, best_v, ratio, b, alley_width if split else 0.0)

        buildings: list[Polygon] = []
        for half in halves:
            threshold = min_sq * math.pow(2, 4 * size_chaos * (Random.float() - 0.5))
            if half.square < threshold:
                if not Random.bool(empty_prob) and len(half) >= 4:
                    buildings.append(half)
            else:
                do_split = half.square > min_sq / (Random.float() * Random.float()) if Random.float() * Random.float() > 0 else True
                buildings.extend(
                    Ward.create_alleys(half, min_sq, grid_chaos, size_chaos, empty_prob, do_split, alley_width)
                )

        buildings = [b for b in buildings if len(b) >= 4]
        return buildings

    @staticmethod
    def _find_longest_edge(poly: Polygon) -> Point:
        return array_utils.min_by(list(poly), lambda v: -poly.vector(v).length)

    @staticmethod
    def create_ortho_building(
        poly: Polygon,
        min_block_sq: float,
        fill: float,
    ) -> list[Polygon]:

        def _slice(poly: Polygon, c1: Point, c2: Point) -> list[Polygon]:
            v0 = Ward._find_longest_edge(poly)
            v1 = poly.next(v0)
            v = v1.subtract(v0)

            ratio = 0.4 + Random.float() * 0.2
            p1 = geom_utils.interpolate(v0, v1, ratio)

            if abs(geom_utils.scalar(v.x, v.y, c1.x, c1.y)) < abs(geom_utils.scalar(v.x, v.y, c2.x, c2.y)):
                c = c1
            else:
                c = c2

            halves = poly.cut(p1, p1.add(c))
            buildings: list[Polygon] = []
            for half in halves:
                if half.square < min_block_sq * math.pow(2, Random.normal() * 2 - 1):
                    if Random.bool(fill):
                        buildings.append(half)
                else:
                    buildings.extend(_slice(half, c1, c2))
            return buildings

        if poly.square < min_block_sq:
            return [poly]
        else:
            c1 = poly.vector(Ward._find_longest_edge(poly))
            c2 = c1.rotate90()
            while True:
                blocks = _slice(poly, c1, c2)
                blocks = [b for b in blocks if len(b) >= 4]
                if len(blocks) > 0:
                    return blocks

    # ------------------------------------------------------------------
    # Building style post-processing
    # ------------------------------------------------------------------

    @staticmethod
    def _get_bbox(poly: Polygon, direction: tuple[float, float] | None = None, shrink: float = 0.9):
        """Bounding box aligned to *direction* (or longest edge).

        Returns (centroid, cu, cv, w, h, ux, uy, vx, vy) or None.
        """
        if len(poly) < 3:
            return None

        if direction is not None:
            ux, uy = direction
        else:
            best_len = 0.0
            best_i = 0
            for i in range(len(poly)):
                d = Point.distance(poly[i], poly[(i + 1) % len(poly)])
                if d > best_len:
                    best_len = d
                    best_i = i
            v0 = poly[best_i]
            v1 = poly[(best_i + 1) % len(poly)]
            dx = v1.x - v0.x
            dy = v1.y - v0.y
            length = math.sqrt(dx * dx + dy * dy)
            if length < 0.01:
                return None
            ux, uy = dx / length, dy / length

        vx, vy = -uy, ux
        centroid = poly.centroid

        projs_u = [(p.x - centroid.x) * ux + (p.y - centroid.y) * uy for p in poly]
        projs_v = [(p.x - centroid.x) * vx + (p.y - centroid.y) * vy for p in poly]

        min_u, max_u = min(projs_u), max(projs_u)
        min_v, max_v = min(projs_v), max(projs_v)

        w = (max_u - min_u) * shrink
        h = (max_v - min_v) * shrink
        cu = (min_u + max_u) / 2
        cv = (min_v + max_v) / 2

        return centroid, cu, cv, w, h, ux, uy, vx, vy

    @staticmethod
    def _local_to_world(local_pts, centroid, cu, cv, ux, uy, vx, vy) -> Polygon:
        pts: list[Point] = []
        for lu, lv in local_pts:
            x = centroid.x + (cu + lu) * ux + (cv + lv) * vx
            y = centroid.y + (cu + lu) * uy + (cv + lv) * vy
            pts.append(Point(x, y))
        return Polygon(pts)

    @staticmethod
    def _make_rect_at(centroid, cu, cv, w, h, ux, uy, vx, vy) -> Polygon:
        return Ward._local_to_world(
            [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)],
            centroid, cu, cv, ux, uy, vx, vy,
        )

    # --- Style: composite (overlapping rectangles) ---

    @staticmethod
    def _to_composites(buildings: list[Polygon]) -> list[Polygon]:
        result: list[Polygon] = []
        for b in buildings:
            result.extend(Ward._to_composite(b))
        return result

    @staticmethod
    def _to_composite(poly: Polygon) -> list[Polygon]:
        """Two overlapping rectangles (fast, has overlap artifacts)."""
        area = abs(poly.square)
        if area < 1.5 or len(poly) < 3:
            return []

        bbox = Ward._get_bbox(poly)
        if bbox is None:
            return [poly]
        centroid, cu, cv, w, h, ux, uy, vx, vy = bbox

        if w < 1.0 or h < 1.0:
            return [poly]
        if area < 10 or min(w, h) < 2.0:
            return [Ward._make_rect_at(centroid, cu, cv, w, h, ux, uy, vx, vy)]

        body_w = w * (0.55 + Random.float() * 0.25)
        wing_h = h * (0.35 + Random.float() * 0.25)
        side = 1 if Random.bool() else -1
        end = 1 if Random.bool() else -1
        body_off = side * (w - body_w) * 0.4
        wing_off = end * (h - wing_h) * 0.4

        body = Ward._make_rect_at(centroid, cu + body_off, cv, body_w, h, ux, uy, vx, vy)
        wing = Ward._make_rect_at(centroid, cu, cv + wing_off, w, wing_h, ux, uy, vx, vy)
        return [body, wing]

    # --- Style: mixed (variety of original, rect, L-shape) ---

    @staticmethod
    def _to_mixed(
        buildings: list[Polygon],
        road_dir: tuple[float, float] | None = None,
    ) -> list[Polygon]:
        """Mix of original polygons, road-aligned rectangles, and L-shapes."""
        result: list[Polygon] = []
        for b in buildings:
            area = abs(b.square)
            if area < 1.5 or len(b) < 3:
                continue

            r = Random.float()

            if area < 6:
                # Tiny: always keep original
                result.append(b)
            elif area < 15:
                # Small: mostly original + some rects
                if r < 0.55:
                    result.append(b)
                else:
                    rect = Ward._aligned_rect(b, road_dir)
                    result.append(rect if rect is not None else b)
            else:
                # Medium / large: mix of all three
                if r < 0.30:
                    result.append(b)
                elif r < 0.60:
                    rect = Ward._aligned_rect(b, road_dir)
                    result.append(rect if rect is not None else b)
                else:
                    l = Ward._aligned_l_shape(b, road_dir)
                    result.append(l if l is not None else b)
        return result

    @staticmethod
    def _aligned_rect(
        poly: Polygon, road_dir: tuple[float, float] | None = None,
    ) -> Polygon | None:
        """Road-aligned rectangle fitted inside the polygon."""
        bbox = Ward._get_bbox(poly, road_dir, shrink=0.82)
        if bbox is None:
            return None
        centroid, cu, cv, w, h, ux, uy, vx, vy = bbox
        if w < 0.5 or h < 0.5:
            return None
        return Ward._make_rect_at(centroid, cu, cv, w, h, ux, uy, vx, vy)

    @staticmethod
    def _aligned_l_shape(
        poly: Polygon, road_dir: tuple[float, float] | None = None,
    ) -> Polygon | None:
        """Road-aligned 6-vertex L-shape fitted inside the polygon."""
        bbox = Ward._get_bbox(poly, road_dir, shrink=0.80)
        if bbox is None:
            return None
        centroid, cu, cv, full_w, full_h, ux, uy, vx, vy = bbox

        if full_w < 2.0 or full_h < 2.0:
            return None

        fw = full_w / 2
        fh = full_h / 2
        body_w = full_w * (0.55 + Random.float() * 0.25)
        wing_h = full_h * (0.35 + Random.float() * 0.25)
        nw = full_w - body_w
        nh = full_h - wing_h
        side = 1 if Random.bool() else -1
        end = 1 if Random.bool() else -1

        # 6-vertex L: full rect minus one corner notch at (-side, -end).
        if side == 1 and end == 1:
            local = [(-fw, -fh + nh), (-fw + nw, -fh + nh), (-fw + nw, -fh),
                     (fw, -fh), (fw, fh), (-fw, fh)]
        elif side == 1 and end == -1:
            local = [(-fw, -fh), (fw, -fh), (fw, fh),
                     (-fw + nw, fh), (-fw + nw, fh - nh), (-fw, fh - nh)]
        elif side == -1 and end == 1:
            local = [(-fw, -fh), (fw - nw, -fh), (fw - nw, -fh + nh),
                     (fw, -fh + nh), (fw, fh), (-fw, fh)]
        else:
            local = [(-fw, -fh), (fw, -fh), (fw, fh - nh),
                     (fw - nw, fh - nh), (fw - nw, fh), (-fw, fh)]

        return Ward._local_to_world(local, centroid, cu, cv, ux, uy, vx, vy)

    @staticmethod
    def apply_building_style(
        buildings: list[Polygon],
        style: str,
        road_dir: tuple[float, float] | None = None,
    ) -> list[Polygon]:
        """Apply the chosen building style post-processing."""
        if style == "composite":
            return Ward._to_composites(buildings)
        elif style == "mixed":
            return Ward._to_mixed(buildings, road_dir)
        return buildings  # "original"
