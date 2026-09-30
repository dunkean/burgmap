"""District roofscape generation.

Combines M4 district population with a deterministic massing pass that turns
simple lot footprints into richer building outlines before feeding them into
the M5 roof/facade processor.
"""

from __future__ import annotations

from dataclasses import dataclass
import inspect
import math
import random
from typing import Any

from town_generator.detail.compound import COMPOUND_SHAPES, CompoundShape, Wing
from town_generator.detail.processor import DetailParams, process_building
from town_generator.detail.roof import (
    BUILDING_ROOF_OVERRIDES,
    STYLE_ROOF_DEFAULTS,
    _boundary_edges_from_cells,
    _is_rectilinear_coords,
    _largest_coord_loop,
    _offset_polygon_clean,
    _polygon_is_simple_coords,
    _rectilinear_cells_from_polygons,
    _split_cell_components,
    _trace_boundary_loops,
    generate_roof,
    merge_touching_roof_levels,
)
from town_generator.district.base import BasePopulator, BuildingFootprint, PopulatorParams
from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon


_TEMPLATE_NAMES = {
    "chamfer",
    "octagon",
    "l_wing",
    "t_wing",
    "u_court",
    "plus",
    "h_wing",
    "step",
    "longhall",
    "temple",
    "keep",
}

_COMPOUND_TEMPLATE_MAP = {
    "l_wing": "l_shape",
    "t_wing": "t_shape",
    "h_wing": "h_shape",
    "u_court": "u_shape",
    "plus": "plus",
    "temple": "cathedral",
    "keep": "keep",
}

_SAFE_GABLED_TYPES = {
    "house", "shop", "stall", "insula", "chapel", "refectory", "dormitory",
    "chapter_house", "great_hall", "wing", "gatehouse", "outbuilding",
    "farmhouse", "barracks", "headquarters", "armory",
}


@dataclass
class RoofscapeLot:
    building: BuildingFootprint
    source_lots: list[Polygon]


def _coords(poly: Polygon) -> list[list[float]]:
    return [[round(p.x, 2), round(p.y, 2)] for p in poly]


def _clean_polygon(poly: Polygon, digits: int = 2, min_seg: float = 0.18) -> Polygon:
    pts = [Point(round(p.x, digits), round(p.y, digits)) for p in poly]
    if len(pts) < 3:
        return Polygon(pts)

    deduped: list[Point] = []
    for pt in pts:
        if not deduped or Point.distance(deduped[-1], pt) > 1e-9:
            deduped.append(pt)
    if len(deduped) > 1 and Point.distance(deduped[0], deduped[-1]) <= 1e-9:
        deduped.pop()

    changed = True
    while changed and len(deduped) >= 3:
        changed = False
        filtered: list[Point] = []
        for i in range(len(deduped)):
            prev_p = deduped[(i - 1) % len(deduped)]
            cur_p = deduped[i]
            next_p = deduped[(i + 1) % len(deduped)]
            if Point.distance(prev_p, cur_p) < min_seg or Point.distance(cur_p, next_p) < min_seg:
                changed = True
                continue
            cross = abs((cur_p.x - prev_p.x) * (next_p.y - cur_p.y) - (cur_p.y - prev_p.y) * (next_p.x - cur_p.x))
            if cross < 1e-6:
                changed = True
                continue
            filtered.append(cur_p)
        if len(filtered) >= 3:
            deduped = filtered
        else:
            break

    return Polygon(deduped)


def _rounded_polygon(poly: Polygon, digits: int = 2) -> Polygon:
    return _clean_polygon(poly, digits=digits)


def _coord_area(coords: list[list[float]] | list[tuple[float, float]]) -> float:
    if len(coords) < 3:
        return 0.0
    area = 0.0
    for i in range(len(coords)):
        x1, y1 = coords[i]
        x2, y2 = coords[(i + 1) % len(coords)]
        area += x1 * y2 - x2 * y1
    return area / 2.0


def _point_on_segment(
    p: tuple[float, float],
    a: tuple[float, float],
    b: tuple[float, float],
    eps: float = 1e-6,
) -> bool:
    ax, ay = a
    bx, by = b
    px, py = p
    cross = abs((bx - ax) * (py - ay) - (by - ay) * (px - ax))
    if cross > eps:
        return False
    dot = (px - ax) * (bx - ax) + (py - ay) * (by - ay)
    if dot < -eps:
        return False
    length_sq = (bx - ax) ** 2 + (by - ay) ** 2
    return dot - length_sq <= eps


def _point_in_coords(
    point: tuple[float, float],
    coords: list[tuple[float, float]],
    include_boundary: bool = True,
) -> bool:
    if len(coords) < 3:
        return False

    if include_boundary:
        for i in range(len(coords)):
            if _point_on_segment(point, coords[i], coords[(i + 1) % len(coords)]):
                return True

    x, y = point
    inside = False
    j = len(coords) - 1
    for i in range(len(coords)):
        xi, yi = coords[i]
        xj, yj = coords[j]
        intersects = (yi > y) != (yj > y)
        if intersects:
            x_cross = (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi
            if x < x_cross:
                inside = not inside
        j = i
    return inside


def _point_in_or_near_coords(
    point: tuple[float, float],
    coords: list[tuple[float, float]],
    tolerance: float = 0.14,
) -> bool:
    if _point_in_coords(point, coords, include_boundary=True):
        return True
    px, py = point
    for i in range(len(coords)):
        ax, ay = coords[i]
        bx, by = coords[(i + 1) % len(coords)]
        if _point_segment_distance(px, py, ax, ay, bx, by) <= tolerance:
            return True
    return False


def _point_segment_distance(
    px: float,
    py: float,
    ax: float,
    ay: float,
    bx: float,
    by: float,
) -> float:
    dx = bx - ax
    dy = by - ay
    len2 = dx * dx + dy * dy
    if len2 <= 1e-12:
        return math.sqrt((px - ax) ** 2 + (py - ay) ** 2)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / len2))
    qx = ax + t * dx
    qy = ay + t * dy
    return math.sqrt((px - qx) ** 2 + (py - qy) ** 2)


def _sample_polygon_edge_points(poly: Polygon) -> list[tuple[float, float]]:
    samples: list[tuple[float, float]] = []
    for i in range(len(poly)):
        a = poly[i]
        b = poly[(i + 1) % len(poly)]
        samples.append((a.x, a.y))
        samples.append(((a.x + b.x) / 2.0, (a.y + b.y) / 2.0))
        samples.append((a.x + (b.x - a.x) * 0.25, a.y + (b.y - a.y) * 0.25))
        samples.append((a.x + (b.x - a.x) * 0.75, a.y + (b.y - a.y) * 0.75))
    return samples


def _polyline_segments(points: list[Point] | Polygon) -> list[tuple[Point, Point]]:
    if len(points) < 2:
        return []
    return [(points[i], points[(i + 1) % len(points)]) for i in range(len(points))]


def _footprint_is_road_adjacent(
    footprint: Polygon,
    district_polygon: Polygon,
    alleys: list[list[Point]],
    alley_width: float,
) -> bool:
    threshold = max(0.24, min(0.55, alley_width * 0.42))
    edge_samples = _sample_polygon_edge_points(footprint)
    boundary_segments = _polyline_segments(district_polygon)
    alley_segments = [segment for alley in alleys for segment in _polyline_segments(alley)]
    if not boundary_segments and not alley_segments:
        return True

    for sx, sy in edge_samples:
        for a, b in boundary_segments:
            if _point_segment_distance(sx, sy, a.x, a.y, b.x, b.y) <= threshold:
                return True
        for a, b in alley_segments:
            if _point_segment_distance(sx, sy, a.x, a.y, b.x, b.y) <= threshold:
                return True
    return False


def _footprint_is_fully_enclosed(
    footprint: Polygon,
    other_footprints: list[Polygon],
    alley_width: float,
) -> bool:
    if not other_footprints:
        return False

    threshold = max(0.18, min(0.42, alley_width * 0.36))
    edge_samples = _sample_polygon_edge_points(footprint)

    for sx, sy in edge_samples:
        blocked = False
        for other in other_footprints:
            for a, b in _polyline_segments(other):
                if _point_segment_distance(sx, sy, a.x, a.y, b.x, b.y) <= threshold:
                    blocked = True
                    break
            if blocked:
                break
        if not blocked:
            return False
    return True


def _poly_dims(poly: Polygon) -> tuple[float, float]:
    left, top, right, bottom = poly.get_bounds()
    return max(right - left, 0.0), max(bottom - top, 0.0)


def _is_convex_polygon(poly: Polygon) -> bool:
    if len(poly) < 4:
        return True
    sign = None
    for i in range(len(poly)):
        a = poly[i]
        b = poly[(i + 1) % len(poly)]
        c = poly[(i + 2) % len(poly)]
        cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
        if abs(cross) < 1e-9:
            continue
        current = cross > 0
        if sign is None:
            sign = current
        elif current != sign:
            return False
    return True


def _roof_choice_seed(
    footprint: Polygon,
    building: BuildingFootprint,
) -> int:
    center = footprint.centroid
    return (
        int(round(center.x * 100)) * 73856093
        ^ int(round(center.y * 100)) * 19349663
        ^ len(footprint) * 83492791
        ^ building.stories * 2654435761
    ) & 0xFFFFFFFF


def _edge_overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(max(a0, a1), max(b0, b1)) - max(min(a0, a1), min(b0, b1)))


def _shared_edge_length(a: Polygon, b: Polygon, eps: float = 1e-6) -> float:
    length = 0.0
    for i in range(len(a)):
        a0 = a[i]
        a1 = a[(i + 1) % len(a)]
        adx = abs(a1.x - a0.x)
        ady = abs(a1.y - a0.y)
        if adx > eps and ady > eps:
            continue
        for j in range(len(b)):
            b0 = b[j]
            b1 = b[(j + 1) % len(b)]
            bdx = abs(b1.x - b0.x)
            bdy = abs(b1.y - b0.y)
            if bdx > eps and bdy > eps:
                continue
            if adx <= eps and bdx <= eps and abs(a0.x - b0.x) <= eps:
                length += _edge_overlap(a0.y, a1.y, b0.y, b1.y)
            elif ady <= eps and bdy <= eps and abs(a0.y - b0.y) <= eps:
                length += _edge_overlap(a0.x, a1.x, b0.x, b1.x)
    return length


def _join_bridge_polygon(
    a: Polygon,
    b: Polygon,
    max_gap: float = 0.6,
    min_overlap: float = 1.8,
    eps: float = 1e-6,
) -> Polygon | None:
    best: tuple[float, float, Polygon] | None = None
    for i in range(len(a)):
        a0 = a[i]
        a1 = a[(i + 1) % len(a)]
        adx = abs(a1.x - a0.x)
        ady = abs(a1.y - a0.y)
        if adx > eps and ady > eps:
            continue
        for j in range(len(b)):
            b0 = b[j]
            b1 = b[(j + 1) % len(b)]
            bdx = abs(b1.x - b0.x)
            bdy = abs(b1.y - b0.y)
            if bdx > eps and bdy > eps:
                continue

            if adx <= eps and bdx <= eps:
                overlap = _edge_overlap(a0.y, a1.y, b0.y, b1.y)
                gap = abs(a0.x - b0.x)
                if overlap < min_overlap or gap > max_gap:
                    continue
                y0 = max(min(a0.y, a1.y), min(b0.y, b1.y))
                y1 = min(max(a0.y, a1.y), max(b0.y, b1.y))
                trim = min(0.25, overlap * 0.12)
                y0 += trim
                y1 -= trim
                if y1 - y0 <= eps:
                    continue
                x0 = min(a0.x, b0.x)
                x1 = max(a0.x, b0.x)
                bridge = Polygon([
                    Point(x0, y0), Point(x1, y0), Point(x1, y1), Point(x0, y1),
                ])
            elif ady <= eps and bdy <= eps:
                overlap = _edge_overlap(a0.x, a1.x, b0.x, b1.x)
                gap = abs(a0.y - b0.y)
                if overlap < min_overlap or gap > max_gap:
                    continue
                x0 = max(min(a0.x, a1.x), min(b0.x, b1.x))
                x1 = min(max(a0.x, a1.x), max(b0.x, b1.x))
                trim = min(0.25, overlap * 0.12)
                x0 += trim
                x1 -= trim
                if x1 - x0 <= eps:
                    continue
                y0 = min(a0.y, b0.y)
                y1 = max(a0.y, b0.y)
                bridge = Polygon([
                    Point(x0, y0), Point(x1, y0), Point(x1, y1), Point(x0, y1),
                ])
            else:
                continue

            score = (gap, -overlap)
            if best is None or score < (best[0], best[1]):
                best = (score[0], score[1], bridge)
    return best[2] if best is not None else None


def _union_rectilinear_lots(polygons: list[Polygon]) -> Polygon | None:
    if len(polygons) < 2:
        return None

    loops = _trace_boundary_loops(_boundary_edges_from_cells(_rectilinear_cells_from_polygons([
        _coords(poly) for poly in polygons
    ])))
    best = _largest_coord_loop(loops)
    if len(best) < 3 or not _polygon_is_simple_coords(best):
        return None

    coords = list(best)
    if _coord_area(coords) < 0:
        coords.reverse()
    return Polygon([Point(x, y) for x, y in coords])


def _join_building_type(
    a: BuildingFootprint,
    b: BuildingFootprint,
    merged_area: float,
) -> str:
    types = {a.building_type, b.building_type}
    hints = a.style_hints | b.style_hints
    if "field" in types:
        return "field"
    if "tower" in types and merged_area >= 180.0:
        return "keep"
    if hints.get("religious") or types & {"chapel", "cathedral", "chapter_house"}:
        return "chapel" if merged_area < 260.0 else "cathedral"
    if hints.get("military") or types & {"barracks", "headquarters", "armory", "gatehouse"}:
        return "keep" if merged_area >= 220.0 else "barracks"
    if types & {"great_hall", "refectory", "dormitory", "farmhouse"}:
        return "great_hall"
    if types & {"shop", "stall"}:
        return "shop"
    if "insula" in types:
        return "insula"
    return a.building_type


def _can_join_lots(a: BuildingFootprint, b: BuildingFootprint) -> bool:
    if a.stories <= 0 or b.stories <= 0:
        return False
    if "field" in {a.building_type, b.building_type}:
        return False
    if a.style_hints.get("circular") or b.style_hints.get("circular"):
        return False
    if a.building_type in {"tower", "ger"} or b.building_type in {"tower", "ger"}:
        return False
    if abs(a.stories - b.stories) > 2:
        return False
    return True


def _prepare_roofscape_lots(
    buildings: list[BuildingFootprint],
    join_ratio: float,
    alley_width: float,
    seed: int,
) -> list[RoofscapeLot]:
    join_ratio = max(0.0, min(1.0, join_ratio))
    items = [RoofscapeLot(
        building=BuildingFootprint(
            footprint=Polygon([p.clone() for p in b.footprint]),
            building_type=b.building_type,
            sub_type=b.sub_type,
            stories=b.stories,
            style_hints=dict(b.style_hints),
        ),
        source_lots=[Polygon([p.clone() for p in b.footprint])],
    ) for b in buildings]
    if join_ratio <= 0.0:
        return items

    rng = random.Random(seed * 811 + 17)
    bridge_gap = max(0.3, min(0.7, alley_width * 0.7))
    candidates: list[tuple[float, float, int, int]] = []
    for i in range(len(items)):
        a = items[i].building
        for j in range(i + 1, len(items)):
            b = items[j].building
            if not _can_join_lots(a, b):
                continue
            shared = _shared_edge_length(a.footprint, b.footprint)
            bridge = None
            if shared < 2.0:
                bridge = _join_bridge_polygon(a.footprint, b.footprint, max_gap=bridge_gap)
                if bridge is None:
                    continue
            merge_parts = [a.footprint, b.footprint] + ([bridge] if bridge is not None else [])
            union = _union_rectilinear_lots(merge_parts)
            if union is None:
                continue
            combined_area = sum(abs(part.square) for part in merge_parts)
            if abs(abs(union.square) - combined_area) > max(1.0, combined_area * 0.06):
                continue
            candidates.append((-shared, rng.random(), i, j))

    used: set[int] = set()
    merged: list[RoofscapeLot] = []
    joinable_buildings = {idx for _, _, i, j in candidates for idx in (i, j)}
    target_joined = int(round(len(joinable_buildings) * join_ratio))
    target_merges = min(len(joinable_buildings) // 2, target_joined // 2)
    if join_ratio > 0.0 and target_merges == 0 and len(joinable_buildings) >= 2:
        target_merges = 1
    for _, _, i, j in sorted(candidates):
        if len(merged) >= target_merges:
            break
        if i in used or j in used:
            continue
        a = items[i]
        b = items[j]
        shared = _shared_edge_length(a.building.footprint, b.building.footprint)
        bridge = None
        if shared < 2.0:
            bridge = _join_bridge_polygon(a.building.footprint, b.building.footprint, max_gap=bridge_gap)
            if bridge is None:
                continue
        merge_parts = [a.building.footprint, b.building.footprint] + ([bridge] if bridge is not None else [])
        union = _union_rectilinear_lots(merge_parts)
        if union is None:
            continue
        merged_area = abs(union.square)
        style_hints = dict(a.building.style_hints)
        style_hints.update(b.building.style_hints)
        style_hints["joined_lots"] = True
        merged.append(RoofscapeLot(
            building=BuildingFootprint(
                footprint=union,
                building_type=_join_building_type(a.building, b.building, merged_area),
                sub_type=a.building.sub_type or b.building.sub_type,
                stories=max(a.building.stories, b.building.stories),
                style_hints=style_hints,
            ),
            source_lots=a.source_lots + b.source_lots,
        ))
        used.add(i)
        used.add(j)

    prepared = [items[idx] for idx in range(len(items)) if idx not in used]
    prepared.extend(merged)
    return prepared


def _longest_axis_angle(poly: Polygon) -> float:
    if len(poly) < 2:
        return 0.0
    best = 0.0
    angle = 0.0
    for i in range(len(poly)):
        a = poly[i]
        b = poly[(i + 1) % len(poly)]
        length = Point.distance(a, b)
        if length > best:
            best = length
            angle = math.atan2(b.y - a.y, b.x - a.x)
    return angle


def _rotate_to_local(
    x: float,
    y: float,
    cx: float,
    cy: float,
    angle: float,
) -> tuple[float, float]:
    dx = x - cx
    dy = y - cy
    cos_a = math.cos(-angle)
    sin_a = math.sin(-angle)
    return (
        dx * cos_a - dy * sin_a,
        dx * sin_a + dy * cos_a,
    )


def _rotate_to_world(
    x: float,
    y: float,
    cx: float,
    cy: float,
    angle: float,
) -> Point:
    cos_a = math.cos(angle)
    sin_a = math.sin(angle)
    return Point(
        cx + x * cos_a - y * sin_a,
        cy + x * sin_a + y * cos_a,
    )


def _ordered_quad(poly: Polygon) -> tuple[Point, Point, Point, Point] | None:
    if len(poly) != 4:
        return None
    angle = _longest_axis_angle(poly)
    center = poly.centroid
    local = [_rotate_to_local(p.x, p.y, center.x, center.y, angle) for p in poly]
    tagged = list(zip(local, poly))
    top = sorted(sorted(tagged, key=lambda item: item[0][1])[:2], key=lambda item: item[0][0])
    bottom = sorted(sorted(tagged, key=lambda item: item[0][1], reverse=True)[:2], key=lambda item: item[0][0])
    if len(top) != 2 or len(bottom) != 2:
        return None
    top_left, top_right = top[0][1], top[1][1]
    bottom_left, bottom_right = bottom[0][1], bottom[1][1]
    return top_left, top_right, bottom_right, bottom_left


def _lerp_point(a: Point, b: Point, t: float) -> Point:
    return Point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)


def _map_quad_template_point(
    corners: tuple[Point, Point, Point, Point],
    x: float,
    y: float,
) -> Point:
    top_left, top_right, bottom_right, bottom_left = corners
    u = max(0.0, min(1.0, (x + 1.0) * 0.5))
    v = max(0.0, min(1.0, (y + 1.0) * 0.5))
    top = _lerp_point(top_left, top_right, u)
    bottom = _lerp_point(bottom_left, bottom_right, u)
    return _lerp_point(top, bottom, v)


def _normalized_coord(value: float, low: float, high: float) -> float:
    span = max(high - low, 1e-6)
    return ((value - low) / span) * 2.0 - 1.0


def _map_normalized_point_to_base(
    base: Polygon,
    x: float,
    y: float,
    scale_x: float = 1.0,
    scale_y: float = 1.0,
) -> Point:
    x = max(-1.0, min(1.0, x * scale_x))
    y = max(-1.0, min(1.0, y * scale_y))

    quad = _ordered_quad(base)
    if quad is not None:
        return _map_quad_template_point(quad, x, y)

    angle = _longest_axis_angle(base)
    center = base.centroid
    local = [_rotate_to_local(p.x, p.y, center.x, center.y, angle) for p in base]
    min_x = min(px for px, _ in local)
    max_x = max(px for px, _ in local)
    min_y = min(py for _, py in local)
    max_y = max(py for _, py in local)
    half_w = max(max_x - min_x, 1.0) / 2.0
    half_h = max(max_y - min_y, 1.0) / 2.0
    return _rotate_to_world(x * half_w, y * half_h, center.x, center.y, angle)


def _transform_polygon_to_base(
    source: Polygon,
    source_bounds: tuple[float, float, float, float],
    base: Polygon,
    scale_x: float = 1.0,
    scale_y: float = 1.0,
) -> Polygon:
    min_x, min_y, max_x, max_y = source_bounds
    pts = [
        _map_normalized_point_to_base(
            base,
            _normalized_coord(p.x, min_x, max_x),
            _normalized_coord(p.y, min_y, max_y),
            scale_x=scale_x,
            scale_y=scale_y,
        )
        for p in source
    ]
    return _rounded_polygon(Polygon(pts))


def _transform_polygon_to_base_oriented(
    source: Polygon,
    source_bounds: tuple[float, float, float, float],
    base: Polygon,
    scale_x: float = 1.0,
    scale_y: float = 1.0,
) -> Polygon:
    min_x, min_y, max_x, max_y = source_bounds
    angle = _longest_axis_angle(base)
    center = base.centroid
    local = [_rotate_to_local(p.x, p.y, center.x, center.y, angle) for p in base]
    base_min_x = min(px for px, _ in local)
    base_max_x = max(px for px, _ in local)
    base_min_y = min(py for _, py in local)
    base_max_y = max(py for _, py in local)
    half_w = max(base_max_x - base_min_x, 1.0) * 0.5 * scale_x
    half_h = max(base_max_y - base_min_y, 1.0) * 0.5 * scale_y

    pts = []
    for p in source:
        nx = _normalized_coord(p.x, min_x, max_x)
        ny = _normalized_coord(p.y, min_y, max_y)
        pts.append(_rotate_to_world(nx * half_w, ny * half_h, center.x, center.y, angle))
    return _rounded_polygon(Polygon(pts))


def _polygon_to_local_coords(poly: Polygon, center: Point, angle: float) -> list[list[float]]:
    raw = [
        [x, y]
        for x, y in (_rotate_to_local(p.x, p.y, center.x, center.y, angle) for p in poly)
    ]
    return _snap_local_rectilinear_coords(raw)


def _snap_local_rectilinear_coords(
    coords: list[list[float]],
    tolerance: float = 0.08,
) -> list[list[float]]:
    def snap_axis(values: list[float]) -> dict[float, float]:
        groups: list[list[float]] = []
        for value in sorted(values):
            if not groups or abs(value - groups[-1][-1]) > tolerance:
                groups.append([value])
            else:
                groups[-1].append(value)
        mapping: dict[float, float] = {}
        for group in groups:
            snapped = round(sum(group) / len(group), 4)
            for value in group:
                mapping[value] = snapped
        return mapping

    x_map = snap_axis([float(x) for x, _ in coords])
    y_map = snap_axis([float(y) for _, y in coords])
    return [[x_map[float(x)], y_map[float(y)]] for x, y in coords]


def _polygon_from_local_coords(coords: list[list[float]], center: Point, angle: float) -> Polygon:
    return _rounded_polygon(Polygon([
        _rotate_to_world(x, y, center.x, center.y, angle)
        for x, y in coords
    ]))


def _template_shape_seed(
    base: Polygon,
    building: BuildingFootprint,
    template_name: str,
) -> int:
    return (
        _roof_choice_seed(base, building)
        ^ (stable_hash := sum((idx + 1) * ord(ch) for idx, ch in enumerate(template_name)))
        ^ (len(base) * 1103515245)
    ) & 0xFFFFFFFF


def _build_template_compound(
    base: Polygon,
    template_name: str,
    complexity: float,
    building: BuildingFootprint,
) -> CompoundShape | None:
    factory_name = _COMPOUND_TEMPLATE_MAP.get(template_name)
    if factory_name is None:
        return None

    factory = COMPOUND_SHAPES.get(factory_name)
    if factory is None:
        return None

    kwargs: dict[str, Any] = {}
    sig = inspect.signature(factory)
    if "stories" in sig.parameters:
        kwargs["stories"] = max(1, building.stories)
    if "building_type" in sig.parameters:
        kwargs["building_type"] = building.building_type
    if "seed" in sig.parameters:
        kwargs["seed"] = _template_shape_seed(base, building, template_name)

    shape = factory(**kwargs)
    bounds = shape.outline.get_bounds()
    quad = _ordered_quad(base)
    fill_scale = 1.0 if quad is not None else 0.98

    wings = [
        Wing(
            footprint=_transform_polygon_to_base_oriented(wing.footprint, bounds, base, scale_x=fill_scale, scale_y=fill_scale),
            label=wing.label,
            stories=wing.stories,
            building_type=wing.building_type,
        )
        for wing in shape.wings
    ]

    if complexity >= 0.7 and template_name in {"l_wing", "t_wing", "u_court", "h_wing"}:
        wings = [
            Wing(
                footprint=_safe_inset(wing.footprint, 0.0),
                label=wing.label,
                stories=wing.stories,
                building_type=wing.building_type,
            )
            for wing in wings
        ]

    outline = _transform_polygon_to_base_oriented(shape.outline, bounds, base, scale_x=fill_scale, scale_y=fill_scale)
    wing_outline = _compound_outline_from_wings(wings)
    if wing_outline is not None:
        outline = wing_outline

    return CompoundShape(wings=wings, outline=outline, shape_type=shape.shape_type)


def _compound_outline_from_wings(wings: list[Wing]) -> Polygon | None:
    polygons = []
    for wing in wings:
        coords = [(round(p.x, 2), round(p.y, 2)) for p in wing.footprint]
        if len(coords) < 3 or not _polygon_is_simple_coords(coords) or not _is_rectilinear_coords(coords):
            return None
        polygons.append([[x, y] for x, y in coords])

    if not polygons:
        return None

    cells = _rectilinear_cells_from_polygons(polygons)
    components = _split_cell_components(cells)
    if len(components) != 1:
        return None

    loops = _trace_boundary_loops(_boundary_edges_from_cells(components[0]))
    best = _largest_coord_loop(loops)
    if len(best) < 3 or not _polygon_is_simple_coords(best):
        return None

    coords = list(best)
    if _coord_area(coords) < 0:
        coords.reverse()
    return _rounded_polygon(Polygon([Point(x, y) for x, y in coords]))


def _safe_inset(poly: Polygon, inset: float) -> Polygon:
    if inset <= 0:
        return Polygon([p.clone() for p in poly])

    target = inset
    for _ in range(4):
        loops = _offset_polygon_clean(poly, -target)
        best = _largest_coord_loop(loops)
        if len(best) >= 3 and _polygon_is_simple_coords(best):
            coords = list(best)
            if _coord_area(coords) < 0:
                coords.reverse()
            return Polygon([Point(x, y) for x, y in coords])
        target *= 0.65

    return Polygon([p.clone() for p in poly])


def _chamfer_polygon(poly: Polygon, ratio: float = 0.18) -> Polygon:
    if len(poly) < 3:
        return Polygon([p.clone() for p in poly])

    result: list[Point] = []
    for i in range(len(poly)):
        prev_p = poly[(i - 1) % len(poly)]
        p = poly[i]
        next_p = poly[(i + 1) % len(poly)]

        len_prev = Point.distance(prev_p, p)
        len_next = Point.distance(p, next_p)
        d_prev = min(len_prev * ratio, len_prev * 0.45)
        d_next = min(len_next * ratio, len_next * 0.45)

        v_prev = prev_p.subtract(p)
        v_prev.normalize(d_prev)
        v_next = next_p.subtract(p)
        v_next.normalize(d_next)

        result.append(p.add(v_prev))
        result.append(p.add(v_next))

    coords = [(p.x, p.y) for p in result]
    if not _polygon_is_simple_coords(coords) or abs(_coord_area(coords)) < 1e-6:
        return Polygon([p.clone() for p in poly])
    if _coord_area(coords) < 0:
        result.reverse()
    return Polygon(result)


def _template_coords(name: str, complexity: float) -> list[tuple[float, float]]:
    complexity = max(0.0, min(1.0, complexity))
    if name == "octagon":
        cut = 0.34 - complexity * 0.08
        return [
            (-cut, -1.0), (cut, -1.0), (1.0, -cut), (1.0, cut),
            (cut, 1.0), (-cut, 1.0), (-1.0, cut), (-1.0, -cut),
        ]
    if name == "l_wing":
        notch = 0.12 + complexity * 0.20
        return [
            (-1.0, -1.0), (1.0, -1.0), (1.0, -notch),
            (0.12, -notch), (0.12, 1.0), (-1.0, 1.0),
        ]
    if name == "t_wing":
        stem = 0.18 + (1.0 - complexity) * 0.16
        shoulder = -0.22 + complexity * 0.08
        return [
            (-1.0, -1.0), (1.0, -1.0), (1.0, shoulder),
            (stem, shoulder), (stem, 1.0), (-stem, 1.0),
            (-stem, shoulder), (-1.0, shoulder),
        ]
    if name == "u_court":
        arm = 0.22 + (1.0 - complexity) * 0.10
        inner = -0.20 - complexity * 0.18
        return [
            (-1.0, -1.0), (1.0, -1.0), (1.0, 1.0),
            (1.0 - arm, 1.0), (1.0 - arm, inner),
            (-1.0 + arm, inner), (-1.0 + arm, 1.0), (-1.0, 1.0),
        ]
    if name == "plus":
        arm = 0.26 + (1.0 - complexity) * 0.08
        return [
            (-arm, -1.0), (arm, -1.0), (arm, -arm), (1.0, -arm),
            (1.0, arm), (arm, arm), (arm, 1.0), (-arm, 1.0),
            (-arm, arm), (-1.0, arm), (-1.0, -arm), (-arm, -arm),
        ]
    if name == "h_wing":
        arm = 0.28 + (1.0 - complexity) * 0.10
        bridge = 0.18 + complexity * 0.08
        return [
            (-1.0, -1.0), (-arm, -1.0), (-arm, -bridge), (arm, -bridge),
            (arm, -1.0), (1.0, -1.0), (1.0, 1.0), (arm, 1.0),
            (arm, bridge), (-arm, bridge), (-arm, 1.0), (-1.0, 1.0),
        ]
    if name == "step":
        notch = 0.14 + complexity * 0.18
        return [
            (-1.0, -1.0), (0.12, -1.0), (0.12, -notch),
            (1.0, -notch), (1.0, 1.0), (-1.0, 1.0),
        ]
    if name == "longhall":
        shoulder = 0.52 - complexity * 0.10
        return [
            (-1.0, -shoulder), (-0.76, -1.0), (0.76, -1.0), (1.0, -shoulder),
            (1.0, shoulder), (0.76, 1.0), (-0.76, 1.0), (-1.0, shoulder),
        ]
    if name == "temple":
        nave = 0.22 + complexity * 0.10
        transept = 0.48 - complexity * 0.10
        return [
            (-nave, -1.0), (nave, -1.0), (nave, -transept), (1.0, -transept),
            (1.0, transept), (nave, transept), (nave, 1.0), (-nave, 1.0),
            (-nave, transept), (-1.0, transept), (-1.0, -transept), (-nave, -transept),
        ]
    if name == "keep":
        tower = 0.58 + (1.0 - complexity) * 0.10
        court = 0.20 + complexity * 0.10
        return [
            (-1.0, -1.0), (-tower, -1.0), (-tower, -court), (tower, -court),
            (tower, -1.0), (1.0, -1.0), (1.0, 1.0), (tower, 1.0),
            (tower, court), (-tower, court), (-tower, 1.0), (-1.0, 1.0),
        ]
    return [
        (-0.72, -1.0), (0.72, -1.0), (1.0, -0.72), (1.0, 0.72),
        (0.72, 1.0), (-0.72, 1.0), (-1.0, 0.72), (-1.0, -0.72),
    ]


def _candidate_order(
    building: BuildingFootprint,
    style: str,
    aspect: float,
    massing_mode: str,
    rng: random.Random,
) -> list[str]:
    if massing_mode == "chamfered":
        return ["chamfer", "octagon"]
    elif building.style_hints.get("joined_lots"):
        if building.style_hints.get("military") or building.building_type in {"keep", "gatehouse", "barracks", "headquarters", "armory"}:
            order = ["keep", "h_wing", "u_court", "temple", "l_wing", "t_wing"]
        elif building.style_hints.get("religious") or building.building_type in {"chapel", "cathedral", "chapter_house"}:
            order = ["temple", "u_court", "h_wing", "plus", "l_wing", "t_wing"]
        else:
            order = ["l_wing", "u_court", "h_wing", "t_wing", "temple", "plus"]
    elif building.building_type in {"tower", "keep", "ger"} or building.style_hints.get("tower"):
        order = ["octagon", "chamfer", "plus"]
    elif building.building_type in {"cathedral", "chapel"} or building.style_hints.get("religious"):
        order = ["temple", "plus", "t_wing", "u_court", "octagon", "chamfer"]
    elif building.building_type in {"keep", "gatehouse", "headquarters", "armory"} or building.style_hints.get("military"):
        order = ["keep", "h_wing", "u_court", "l_wing", "chamfer"]
    elif building.building_type in {"great_hall", "refectory", "dormitory", "barracks", "farmhouse"} or aspect >= 1.8:
        order = ["longhall", "h_wing", "t_wing", "l_wing", "u_court", "chamfer"]
    elif style in {"roman", "east_asian"}:
        order = ["temple", "u_court", "t_wing", "plus", "h_wing", "chamfer", "octagon"]
    elif style in {"arabic_islamic", "arabic"}:
        order = ["u_court", "l_wing", "plus", "octagon", "chamfer"]
    elif style in {"norse", "viking"}:
        order = ["longhall", "l_wing", "t_wing", "chamfer"]
    else:
        order = ["l_wing", "u_court", "h_wing", "t_wing", "plus", "temple"]

    if massing_mode == "compound":
        order = [name for name in order if name not in {"chamfer", "octagon"}] + ["chamfer", "octagon"]

    head = order[: max(1, min(4, len(order)))]
    tail = order[len(head):]
    rng.shuffle(head)
    return head + tail


def _template_allowed(
    template_name: str,
    footprint: Polygon,
    building: BuildingFootprint,
) -> bool:
    width, height = _poly_dims(footprint)
    min_dim = min(width, height)
    area = abs(footprint.square)
    aspect = max(width, height) / max(min_dim, 1e-6)
    joined = bool(building.style_hints.get("joined_lots"))

    if template_name == "l_wing":
        return area >= (18.0 if not joined else 14.0) and min_dim >= 4.0 and aspect >= 1.12
    if template_name == "t_wing":
        return area >= (18.0 if not joined else 14.0) and min_dim >= 4.0
    if template_name == "u_court":
        return area >= (22.0 if not joined else 16.0) and min_dim >= 4.4
    if template_name == "h_wing":
        return area >= (24.0 if not joined else 18.0) and min_dim >= 4.8
    if template_name == "plus":
        return area >= (26.0 if not joined else 20.0) and min_dim >= 5.0
    if template_name == "temple":
        return area >= (28.0 if not joined else 22.0) and min_dim >= 5.2
    if template_name == "keep":
        return joined and area >= 24.0 and min_dim >= 4.8
    if template_name in {"step", "longhall"}:
        return area >= 16.0 and min_dim >= 3.8
    if template_name in {"octagon", "chamfer"}:
        return area >= 16.0 and min_dim >= 3.8
    return True


def _build_template_polygon(
    base: Polygon,
    template_name: str,
    complexity: float,
    building: BuildingFootprint,
    rng: random.Random,
) -> Polygon | None:
    compound = _build_template_compound(base, template_name, complexity, building)
    if compound is not None:
        return compound.outline

    template = _template_coords(template_name, complexity)
    quad = _ordered_quad(base)
    if quad is not None:
        pts = [_map_quad_template_point(quad, x, y) for x, y in template]
        coords = [(p.x, p.y) for p in pts]
        if not _polygon_is_simple_coords(coords) or abs(_coord_area(coords)) < 1e-6:
            return None
        if _coord_area(coords) < 0:
            pts.reverse()
        return _rounded_polygon(Polygon(pts))

    angle = _longest_axis_angle(base)
    center = base.centroid
    local = [_rotate_to_local(p.x, p.y, center.x, center.y, angle) for p in base]
    min_x = min(x for x, _ in local)
    max_x = max(x for x, _ in local)
    min_y = min(y for _, y in local)
    max_y = max(y for _, y in local)
    width = max_x - min_x
    height = max_y - min_y
    if width < 1.0 or height < 1.0:
        return None

    if template_name == "longhall":
        scale_x = 0.96
        scale_y = 0.62 + (1.0 - complexity) * 0.10
    elif template_name == "temple":
        scale_x = 0.90 - complexity * 0.03
        scale_y = 0.94 - complexity * 0.02
    elif template_name in {"h_wing", "keep"}:
        scale_x = 0.94 - complexity * 0.03
        scale_y = 0.94 - complexity * 0.03
    elif template_name in {"octagon", "chamfer"}:
        scale_x = scale_y = 0.94 - complexity * 0.03
    else:
        scale_x = 0.93 - complexity * 0.03
        scale_y = 0.93 - complexity * 0.03

    half_w = width * scale_x / 2.0
    half_h = height * scale_y / 2.0
    offset_x = 0.0
    offset_y = 0.0
    pts: list[Point] = []
    for x, y in template:
        pts.append(
            _rotate_to_world(
                x * half_w + offset_x,
                y * half_h + offset_y,
                center.x,
                center.y,
                angle,
            )
        )

    coords = [(p.x, p.y) for p in pts]
    if not _polygon_is_simple_coords(coords) or abs(_coord_area(coords)) < 1e-6:
        return None
    if _coord_area(coords) < 0:
        pts.reverse()
    return _rounded_polygon(Polygon(pts))


def _find_complex_candidate(
    footprint: Polygon,
    building: BuildingFootprint,
    style: str,
    complexity: float,
    massing_mode: str,
    rng: random.Random,
) -> tuple[Polygon | None, str]:
    width, height = _poly_dims(footprint)
    min_dim = min(width, height)
    area = abs(footprint.square)
    if min_dim < 2.0 or area < 8.0:
        return None, "original"

    base = Polygon([p.clone() for p in footprint])
    aspect = max(width, height) / max(min_dim, 1e-6)
    for name in _candidate_order(building, style, aspect, massing_mode, rng):
        if not _template_allowed(name, footprint, building):
            continue
        if name == "chamfer":
            ratio = 0.14 + complexity * 0.10
            candidate = _rounded_polygon(_chamfer_polygon(base, ratio=ratio))
        else:
            candidate = _build_template_polygon(base, name, complexity, building, rng)
        if candidate is not None and _candidate_fits(candidate, footprint):
            return candidate, name

    if massing_mode == "chamfered" or building.building_type in {"tower", "keep"} or building.style_hints.get("tower"):
        fallback = _rounded_polygon(_chamfer_polygon(base, ratio=0.16))
        if _candidate_fits(fallback, footprint):
            return fallback, "chamfer"
    return None, "original"


def _candidate_fits(candidate: Polygon, lot: Polygon) -> bool:
    coords = [(round(p.x, 2), round(p.y, 2)) for p in lot]
    if len(candidate) < 3:
        return False
    if not _polygon_is_simple_coords([(p.x, p.y) for p in candidate]):
        return False

    area_ratio = abs(candidate.square) / max(abs(lot.square), 1e-6)
    if area_ratio < 0.22:
        return False

    for i in range(len(candidate)):
        a = candidate[i]
        b = candidate[(i + 1) % len(candidate)]
        samples = [
            (a.x, a.y),
            ((a.x + b.x) / 2.0, (a.y + b.y) / 2.0),
            (a.x + (b.x - a.x) * 0.25, a.y + (b.y - a.y) * 0.25),
            (a.x + (b.x - a.x) * 0.75, a.y + (b.y - a.y) * 0.75),
        ]
        for sample in samples:
            if not _point_in_or_near_coords(sample, coords):
                return False

    return True


def _should_keep_simple(
    footprint: Polygon,
    building: BuildingFootprint,
    complexity: float,
    complex_ratio: float,
    massing_mode: str,
    rng: random.Random,
) -> bool:
    if massing_mode in {"compound", "chamfered"}:
        return False

    area = abs(footprint.square)
    width, height = _poly_dims(footprint)
    min_dim = min(width, height)
    aspect = max(width, height) / max(min_dim, 1e-6)

    if building.style_hints.get("joined_lots"):
        return False
    if building.style_hints.get("circular") or building.building_type in {"ger", "tower", "keep"}:
        return True
    if min_dim < 6.0 or area < 65.0:
        return True
    if building.style_hints.get("grid_aligned") and area < 140.0:
        return True
    if building.building_type in {"shop", "house", "insula"} and area < 110.0 and aspect < 2.2:
        return True

    complex_chance = complex_ratio
    if area > 180.0:
        complex_chance += 0.18
    if area > 320.0:
        complex_chance += 0.12
    if aspect > 1.9:
        complex_chance += 0.08
    if building.building_type in {"chapel", "cathedral", "great_hall", "refectory", "dormitory", "barracks", "headquarters", "armory"}:
        complex_chance += 0.18
    if building.style_hints.get("palace") or building.style_hints.get("religious") or building.style_hints.get("military"):
        complex_chance += 0.12

    complex_chance += max(0.0, complexity - 0.4) * 0.2
    complex_chance = max(0.0, min(0.95, complex_chance))
    return rng.random() > complex_chance


def _is_complex_candidate(
    footprint: Polygon,
    building: BuildingFootprint,
) -> bool:
    if building.stories <= 0 or building.building_type == "field":
        return False
    if building.building_type == "ger" or building.style_hints.get("circular"):
        return False

    width, height = _poly_dims(footprint)
    min_dim = min(width, height)
    area = abs(footprint.square)
    if building.style_hints.get("joined_lots"):
        return area >= 18.0 and min_dim >= 4.2
    if building.building_type in {"tower", "keep"}:
        return False
    return area >= 16.0 and min_dim >= 3.8


def _complex_priority(
    footprint: Polygon,
    building: BuildingFootprint,
    complexity: float,
) -> float:
    width, height = _poly_dims(footprint)
    min_dim = min(width, height)
    area = abs(footprint.square)
    aspect = max(width, height) / max(min_dim, 1e-6)

    score = area * 0.06 + min_dim * 0.8 + max(0.0, aspect - 1.2) * 8.0
    if building.style_hints.get("joined_lots"):
        score += 32.0
    if building.building_type in {"chapel", "cathedral", "great_hall", "refectory", "dormitory", "barracks", "headquarters", "armory"}:
        score += 20.0
    if building.style_hints.get("religious") or building.style_hints.get("military") or building.style_hints.get("palace"):
        score += 14.0
    score += complexity * 10.0
    return score


def _select_complex_indices(
    prepared_buildings: list[RoofscapeLot],
    style: str,
    complexity: float,
    complex_ratio: float,
    massing_mode: str,
    seed: int,
) -> set[int]:
    viable_candidates: list[int] = []
    for idx, item in enumerate(prepared_buildings):
        building = item.building
        if not _is_complex_candidate(building.footprint, building):
            continue
        rng = random.Random(seed * 1009 + idx * 9173 + int(abs(building.footprint.square) * 10))
        candidate, massing_type = _find_complex_candidate(
            footprint=building.footprint,
            building=building,
            style=style,
            complexity=complexity,
            massing_mode=massing_mode,
            rng=rng,
        )
        if candidate is not None and massing_type != "original":
            viable_candidates.append(idx)

    if massing_mode in {"compound", "chamfered"}:
        return set(viable_candidates)
    if complex_ratio <= 0.0:
        return set()

    roofable_count = sum(1 for item in prepared_buildings if item.building.stories > 0 and item.building.building_type != "field")
    candidates = viable_candidates
    if not candidates:
        return set()

    target = min(len(candidates), int(round(roofable_count * complex_ratio)))
    if target <= 0:
        return set()
    joined_candidates = [
        idx for idx in candidates
        if prepared_buildings[idx].building.style_hints.get("joined_lots")
    ]
    non_joined_candidates = [
        idx for idx in candidates
        if not prepared_buildings[idx].building.style_hints.get("joined_lots")
    ]
    non_joined_candidates.sort(
        key=lambda idx: (
            abs(prepared_buildings[idx].building.footprint.square),
            min(_poly_dims(prepared_buildings[idx].building.footprint)),
        ),
        reverse=True,
    )
    big_pool_size = min(
        len(non_joined_candidates),
        max(target * 2, math.ceil(len(non_joined_candidates) * 0.45)),
    )
    candidate_pool = joined_candidates + non_joined_candidates[:big_pool_size]
    if candidate_pool:
        candidates = candidate_pool
        target = min(len(candidates), target)

    rng = random.Random(seed * 1237 + 59)
    ranked = sorted(
        candidates,
        key=lambda idx: _complex_priority(prepared_buildings[idx].building.footprint, prepared_buildings[idx].building, complexity) + rng.random() * 6.0,
        reverse=True,
    )
    return set(ranked[:target])


def _complexify_footprint(
    footprint: Polygon,
    building: BuildingFootprint,
    style: str,
    complexity: float,
    complex_ratio: float,
    setback_ratio: float,
    massing_mode: str,
    rng: random.Random,
    force_complex: bool = False,
) -> tuple[Polygon, str]:
    width, height = _poly_dims(footprint)
    min_dim = min(width, height)
    area = abs(footprint.square)
    if min_dim < 2.0 or area < 8.0:
        return footprint, "original"

    if building.building_type == "ger" or building.style_hints.get("circular"):
        return footprint, "original"

    if not force_complex and massing_mode == "adaptive":
        return footprint, "original"

    if not force_complex and _should_keep_simple(footprint, building, complexity, complex_ratio, massing_mode, rng):
        return footprint, "original"

    candidate, massing_type = _find_complex_candidate(
        footprint=footprint,
        building=building,
        style=style,
        complexity=complexity,
        massing_mode=massing_mode,
        rng=rng,
    )
    if candidate is None:
        return footprint, "original"
    return candidate, massing_type


def _select_detail_params_for_building(
    footprint: Polygon,
    building: BuildingFootprint,
    base_params: DetailParams,
    style: str,
    massing_type: str = "original",
) -> DetailParams:
    if base_params.roof_type is not None:
        return base_params

    roof_type = BUILDING_ROOF_OVERRIDES.get(
        building.building_type,
        STYLE_ROOF_DEFAULTS.get(style, "hipped"),
    )
    width, height = _poly_dims(footprint)
    min_dim = min(width, height)
    area = abs(footprint.square)
    aspect = max(width, height) / max(min_dim, 1e-6)
    roof_rng = random.Random(_roof_choice_seed(footprint, building))
    sloped_mix = roof_type in {"gabled", "hipped", "thatched"}
    rectilinear = _is_rectilinear_coords(_coords(footprint))

    def _with_roof(chosen_type: str) -> DetailParams:
        return DetailParams(
            roof_type=chosen_type,
            overhang=base_params.overhang,
            facade_density=base_params.facade_density,
            style=base_params.style,
        )

    if sloped_mix and massing_type == "original" and not rectilinear and len(footprint) > 4:
        return _with_roof("skeleton")

    if building.style_hints.get("joined_lots") and massing_type in {"original", "joined_lots"} and len(footprint) > 4:
        if sloped_mix and (not _is_convex_polygon(footprint) or len(footprint) >= 6):
            return _with_roof("skeleton")
        return _with_roof("gabled" if aspect >= 1.35 else "hipped")

    if massing_type in {"l_wing", "t_wing", "u_court", "h_wing", "plus", "step"}:
        if sloped_mix:
            if len(footprint) >= 7 or not _is_convex_polygon(footprint):
                return _with_roof("skeleton")
            return _with_roof("gabled" if aspect >= 1.35 else "hipped")
        return _with_roof("merged_hipped")

    if massing_type in {"temple", "keep"}:
        return _with_roof("gabled")

    if not _is_convex_polygon(footprint):
        return _with_roof("skeleton" if sloped_mix else "merged_hipped")

    if building.style_hints.get("joined_lots") and building.building_type == "keep":
        return _with_roof("gabled")

    if building.building_type in {"great_hall", "refectory", "dormitory", "farmhouse", "barracks"} or aspect >= 2.15:
        chosen_type = "vaulted" if area >= 24.0 and roof_rng.random() < 0.35 else "gabled"
        return _with_roof(chosen_type)

    if building.building_type in {"shop", "stall", "outbuilding", "insula"} and area >= 18.0 and roof_rng.random() < 0.12:
        return _with_roof("flat")

    if sloped_mix and not rectilinear and len(footprint) >= 7 and building.building_type in _SAFE_GABLED_TYPES:
        if roof_rng.random() < 0.42:
            return _with_roof("skeleton")
        return _with_roof("gabled" if aspect >= 1.35 else "hipped")

    if sloped_mix and building.building_type in _SAFE_GABLED_TYPES:
        if roof_type == "thatched" and roof_rng.random() < 0.58:
            return _with_roof("thatched")
        if aspect >= 1.55:
            return _with_roof("gabled")
        return _with_roof("hipped" if roof_rng.random() < 0.52 else "gabled")

    if roof_type == "gabled" and area >= 20.0 and aspect < 1.7 and roof_rng.random() < 0.28:
        return _with_roof("hipped")

    if roof_type == "hipped" and len(footprint) > 4 and building.building_type in _SAFE_GABLED_TYPES:
        return _with_roof("gabled")

    return base_params


def _base_massing_type(massing_type: str) -> str:
    if massing_type.startswith("joined_"):
        return massing_type[len("joined_"):]
    return massing_type


def _copy_detail_params(base_params: DetailParams, roof_type: str | None) -> DetailParams:
    return DetailParams(
        roof_type=roof_type,
        overhang=base_params.overhang,
        facade_density=base_params.facade_density,
        style=base_params.style,
    )


def _roof_retry_order(
    footprint: Polygon,
    building: BuildingFootprint,
    selected_params: DetailParams,
    massing_type: str,
) -> list[str | None]:
    base_type = _base_massing_type(massing_type)
    width, height = _poly_dims(footprint)
    min_dim = min(width, height)
    area = abs(footprint.square)
    aspect = max(width, height) / max(min_dim, 1e-6)
    default_type = selected_params.roof_type

    if base_type in {"l_wing", "t_wing", "u_court", "h_wing", "plus", "step", "joined_lots"}:
        prefs: list[str | None] = ["skeleton", "gabled", "hipped", "merged_hipped"]
    elif base_type in {"temple", "keep"}:
        prefs = ["gabled", "vaulted", "hipped", "skeleton"]
    elif base_type == "longhall" or building.building_type in {"great_hall", "refectory", "dormitory", "farmhouse", "barracks"} or aspect >= 2.15:
        prefs = ["vaulted", "gabled", "hipped", "skeleton"]
    elif base_type in {"chamfer", "octagon"}:
        prefs = [default_type, "hipped", "gabled", "skeleton"]
    elif not _is_convex_polygon(footprint):
        prefs = ["skeleton", "gabled", "hipped", "merged_hipped"]
    elif building.building_type in {"shop", "stall", "outbuilding", "insula"} and area >= 18.0:
        prefs = [default_type, "flat", "gabled", "hipped", "skeleton"]
    else:
        prefs = [default_type, "gabled", "hipped", "skeleton", "vaulted"]

    ordered: list[str | None] = []
    for roof_type in prefs:
        if roof_type not in ordered:
            ordered.append(roof_type)
    return ordered


def _roof_result_needs_retry(
    footprint: Polygon,
    detail: Any,
    massing_type: str,
) -> bool:
    roof = getattr(detail, "roof", None)
    if roof is None:
        return False

    base_type = _base_massing_type(massing_type)
    algorithm = str((roof.extras or {}).get("algorithm", ""))
    roof_type = str(getattr(roof, "roof_type", ""))
    is_complex = base_type not in {"original", "chamfer", "octagon", "longhall"}

    if algorithm.startswith("fallback_hipped") or algorithm.startswith("rectilinear_partition"):
        return True
    if not is_complex:
        return False
    return False


def _process_building_with_roof_retry(
    footprint: Polygon,
    building_id: str,
    building: BuildingFootprint,
    selected_params: DetailParams,
    alley_centers: list[list[float]],
    massing_type: str,
    allow_retry: bool,
) -> Any:
    roof_types = [selected_params.roof_type]
    if allow_retry:
        roof_types = _roof_retry_order(
            footprint=footprint,
            building=building,
            selected_params=selected_params,
            massing_type=massing_type,
        )

    last_detail = None
    for roof_type in roof_types:
        detail = process_building(
            footprint=footprint,
            building_id=building_id,
            building_type=building.building_type,
            stories=building.stories,
            style_hints=building.style_hints,
            params=_copy_detail_params(selected_params, roof_type),
            alley_centers=alley_centers,
        )
        last_detail = detail
        if not allow_retry or not _roof_result_needs_retry(footprint, detail, massing_type):
            return detail
    return last_detail


def _process_compound_for_lot(
    lot: Polygon,
    building_id: str,
    building: BuildingFootprint,
    selected_params: DetailParams,
    massing_type: str,
    complexity: float,
) -> dict[str, Any] | None:
    base_type = _base_massing_type(massing_type)
    compound = _build_template_compound(
        base=lot,
        template_name=base_type,
        complexity=complexity,
        building=building,
    )
    if compound is None or not _candidate_fits(compound.outline, lot):
        return None

    wing_items = []
    raw_levels = []
    join_group = f"{building_id}_{base_type}"
    angle = _longest_axis_angle(lot)
    center = lot.centroid
    for idx, wing in enumerate(compound.wings):
        polygon = _coords(wing.footprint)
        wing_type = wing.building_type or building.building_type
        wing_items.append({
            "id": f"{building_id}_w{idx}",
            "footprint": polygon,
            "label": wing.label,
            "stories": wing.stories,
            "building_type": wing_type,
        })
        raw_levels.append({
            "id": f"{building_id}_w{idx}",
            "label": wing.label or f"Wing {idx + 1}",
            "polygon": _polygon_to_local_coords(wing.footprint, center, angle),
            "stories": max(1, wing.stories),
            "join_stories": max(1, building.stories),
            "building_type": wing_type,
            "style": selected_params.style,
            "roof_type": selected_params.roof_type or "",
            "join_group": join_group,
        })

    if base_type in {"l_wing", "t_wing", "u_court", "h_wing", "plus"}:
        merged_levels = _merge_compound_levels_local(raw_levels)
    else:
        merged_levels = merge_touching_roof_levels(
            raw_levels,
            default_building_type=building.building_type,
            default_style=selected_params.style,
            default_roof_type=selected_params.roof_type or "auto",
        )
    if not merged_levels:
        return None

    height_groups: list[dict[str, Any]] = []
    for raw_level in merged_levels:
        world_level_fp = _polygon_from_local_coords(raw_level["polygon"], center, angle)
        level_fp = world_level_fp
        level_type = str(raw_level.get("building_type", building.building_type))
        level_style = str(raw_level.get("style", selected_params.style))
        level_roof_type = raw_level.get("roof_type")
        if level_roof_type in ("", None, "auto"):
            level_roof_type = None
        roof = generate_roof(
            level_fp,
            roof_type=level_roof_type,
            building_type=level_type,
            style=level_style,
            overhang=selected_params.overhang,
        )
        height_groups.append({
            "stories": int(raw_level.get("stories", building.stories)),
            "outline": _coords(world_level_fp),
            "roof": roof.to_dict(),
            "joined": bool(raw_level.get("joined", False)),
            "source_ids": list(raw_level.get("source_ids", [])),
        })

    representative_roof = height_groups[-1]["roof"] if height_groups else None

    return {
        "compound": True,
        "shape_type": compound.shape_type or base_type,
        "outline": _coords(compound.outline),
        "footprint": _coords(compound.outline),
        "wings": wing_items,
        "height_groups": height_groups,
        "roof": representative_roof,
        "facade_details": [],
    }


def _merge_compound_levels_local(raw_levels: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(raw_levels) <= 1:
        return raw_levels

    polygons = [level.get("polygon", []) for level in raw_levels]
    if not all(
        len(poly) >= 3 and _polygon_is_simple_coords(poly) and _is_rectilinear_coords(poly)
        for poly in polygons
    ):
        return raw_levels

    cells = _rectilinear_cells_from_polygons(polygons)
    components = _split_cell_components(cells)
    if len(components) != 1:
        return raw_levels

    loops = _trace_boundary_loops(_boundary_edges_from_cells(components[0]))
    best = _largest_coord_loop(loops)
    if len(best) < 3 or not _polygon_is_simple_coords(best):
        return raw_levels

    coords = list(best)
    if _coord_area(coords) < 0:
        coords.reverse()
    ids = [str(level.get("id", "")) for level in raw_levels if level.get("id")]
    labels = [str(level.get("label", "")) for level in raw_levels if level.get("label")]
    stories = int(raw_levels[0].get("join_stories", raw_levels[0].get("stories", 1)))
    return [{
        "id": "+".join(ids) if ids else "joined_compound",
        "label": " + ".join(labels) if labels else "Joined Mass",
        "stories": stories,
        "polygon": [[round(x, 4), round(y, 4)] for x, y in coords],
        "building_type": raw_levels[0].get("building_type", "house"),
        "style": raw_levels[0].get("style", "generic"),
        "roof_type": raw_levels[0].get("roof_type", ""),
        "joined": True,
        "source_ids": ids,
    }]


def generate_district_roofscape(
    polygon: Polygon,
    populator: BasePopulator,
    pop_params: PopulatorParams,
    detail_params: DetailParams,
    style: str,
    massing_mode: str = "adaptive",
    complexity: float = 0.4,
    complex_ratio: float = 0.22,
    join_ratio: float = 0.0,
    setback_ratio: float = 0.14,
) -> dict[str, Any]:
    """Populate a district, complexify the lot footprints, and add M5 detail."""
    raw = populator.populate(polygon, pop_params)
    district_boundary = Polygon([p.clone() for p in polygon])

    alley_centers: list[list[float]] = []
    for alley in raw.alleys:
        if not alley:
            continue
        alley_centers.append([
            sum(p.x for p in alley) / len(alley),
            sum(p.y for p in alley) / len(alley),
        ])

    buildings: list[dict[str, Any]] = []
    complexity = max(0.0, min(1.0, complexity))
    complex_ratio = max(0.0, min(1.0, complex_ratio))
    join_ratio = max(0.0, min(1.0, join_ratio))
    setback_ratio = max(0.04, min(0.35, setback_ratio))
    massing_mode = massing_mode if massing_mode in {"adaptive", "compound", "chamfered"} else "adaptive"
    prepared_buildings = _prepare_roofscape_lots(
        raw.buildings,
        join_ratio=join_ratio,
        alley_width=pop_params.alley_width,
        seed=pop_params.seed,
    )
    force_complex_indices = _select_complex_indices(
        prepared_buildings=prepared_buildings,
        style=style,
        complexity=complexity,
        complex_ratio=complex_ratio,
        massing_mode=massing_mode,
        seed=pop_params.seed,
    )
    prepared_lot_footprints = [
        Polygon([p.clone() for p in item.building.footprint])
        for item in prepared_buildings
    ]

    for idx, roofscape_lot in enumerate(prepared_buildings):
        building = roofscape_lot.building
        lot = Polygon([p.clone() for p in building.footprint])
        lot_coords = _coords(lot)

        item: dict[str, Any] = {
            "id": f"b{idx}",
            "lot_footprint": lot_coords,
            "type": building.building_type,
            "sub_type": building.sub_type,
            "stories": building.stories,
            "style_hints": building.style_hints,
            "source_count": len(roofscape_lot.source_lots),
        }
        if len(roofscape_lot.source_lots) > 1:
            item["source_lots"] = [_coords(source_lot) for source_lot in roofscape_lot.source_lots]

        if building.building_type == "field" or building.stories <= 0:
            item["footprint"] = lot_coords
            item["massing_type"] = "original"
            buildings.append(item)
            continue

        seed = (
            pop_params.seed * 1009
            + idx * 9173
            + int(abs(building.footprint.square) * 10)
        )
        rng = random.Random(seed)
        complex_fp, massing_type = _complexify_footprint(
            lot,
            building,
            style=style,
            complexity=complexity,
            complex_ratio=complex_ratio,
            setback_ratio=setback_ratio,
            massing_mode=massing_mode,
            rng=rng,
            force_complex=idx in force_complex_indices,
        )
        building_params = _select_detail_params_for_building(
            footprint=complex_fp,
            building=building,
            base_params=detail_params,
            style=style,
            massing_type=massing_type,
        )
        compound_detail = None
        if _base_massing_type(massing_type) in _COMPOUND_TEMPLATE_MAP:
            compound_detail = _process_compound_for_lot(
                lot=lot,
                building_id=f"b{idx}",
                building=building,
                selected_params=building_params,
                massing_type=massing_type,
                complexity=complexity,
            )
        detail = compound_detail or _process_building_with_roof_retry(
            footprint=complex_fp,
            building_id=f"b{idx}",
            building=building,
            selected_params=building_params,
            alley_centers=alley_centers,
            massing_type=massing_type,
            allow_retry=detail_params.roof_type is None,
        ).to_dict()

        detail_fp_raw = detail.get("footprint") or detail.get("outline") or lot_coords
        detail_fp = Polygon([Point(p[0], p[1]) for p in detail_fp_raw])
        if (
            not _footprint_is_road_adjacent(detail_fp, district_boundary, raw.alleys, pop_params.alley_width)
            and _footprint_is_fully_enclosed(
                detail_fp,
                [prepared_lot_footprints[j] for j in range(len(prepared_lot_footprints)) if j != idx],
                pop_params.alley_width,
            )
        ):
            continue

        item.update(detail)
        item["lot_footprint"] = lot_coords
        if len(roofscape_lot.source_lots) > 1 and massing_type == "original":
            item["massing_type"] = "joined_lots"
        elif len(roofscape_lot.source_lots) > 1:
            item["massing_type"] = f"joined_{massing_type}"
        else:
            item["massing_type"] = massing_type
        item["vertex_count"] = len(complex_fp)
        buildings.append(item)

    return {
        "buildings": buildings,
        "alleys": [{"points": [[round(p.x, 2), round(p.y, 2)] for p in alley]} for alley in raw.alleys],
    }
