"""Roof geometry generation — 2D plan-view projections of 3D roofs.

Each roof type takes a building footprint (Polygon) and produces:
- roof_polygon: the outer roof edge (with overhang)
- ridge_polygon: the ridge line(s) or inner feature
- roof_type: string identifier

All output is 2D plan-view geometry — no actual 3D.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon


@dataclass
class RoofFace:
    """A single slope face of the roof — a polygon with a direction for shading."""
    polygon: list[list[float]]   # [[x,y], ...] closed polygon
    direction: list[float]       # [dx, dy] outward direction (for light calc)

    def to_dict(self) -> dict:
        return {
            "polygon": self.polygon,
            "direction": [round(self.direction[0], 3), round(self.direction[1], 3)],
        }


@dataclass
class RoofGeometry:
    """Result of roof generation for one building."""
    roof_type: str
    polygon: list[list[float]]       # outer roof edge [[x,y], ...]
    ridge_polygon: list[list[float]]  # ridge / inner feature
    overhang: float = 0.0
    faces: list[RoofFace] = field(default_factory=list)
    extras: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = {
            "type": self.roof_type,
            "polygon": self.polygon,
            "ridge_polygon": self.ridge_polygon,
            "overhang": round(self.overhang, 2),
        }
        if self.faces:
            d["faces"] = [f.to_dict() for f in self.faces]
        if self.extras:
            d["extras"] = self.extras
        return d


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------

def _pts_to_coords(pts: list[Point]) -> list[list[float]]:
    return [[round(p.x, 2), round(p.y, 2)] for p in pts]


def _coords_to_points(coords: list[tuple[float, float]] | list[list[float]]) -> list[Point]:
    return [Point(float(x), float(y)) for x, y in coords]


def _signed_area_points(pts: list[Point]) -> float:
    if len(pts) < 3:
        return 0.0
    area = 0.0
    for i, p in enumerate(pts):
        q = pts[(i + 1) % len(pts)]
        area += p.x * q.y - q.x * p.y
    return area / 2.0


def _ensure_ccw_points(pts: list[Point]) -> list[Point]:
    if _signed_area_points(pts) < 0:
        return list(reversed(pts))
    return [p.clone() for p in pts]


def _is_simple_coords(coords: list[tuple[float, float]]) -> bool:
    n = len(coords)
    if n < 3:
        return False
    for i in range(n):
        a1 = coords[i]
        a2 = coords[(i + 1) % n]
        for j in range(i + 1, n):
            b1 = coords[j]
            b2 = coords[(j + 1) % n]
            if i == j:
                continue
            if (i + 1) % n == j or (j + 1) % n == i:
                continue
            if _seg_seg_intersect(a1, a2, b1, b2) is not None:
                return False
    return True


def _largest_coord_loop(loops: list[list[tuple[float, float]]]) -> list[tuple[float, float]]:
    if not loops:
        return []
    return max(loops, key=lambda loop: abs(_signed_area_coords(loop)))


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
    len2 = (bx - ax) ** 2 + (by - ay) ** 2
    if dot - len2 > eps:
        return False
    return True


def _point_in_polygon_coords(
    p: tuple[float, float],
    poly: list[tuple[float, float]],
    include_boundary: bool = True,
) -> bool:
    if len(poly) < 3:
        return False

    if include_boundary:
        for i in range(len(poly)):
            if _point_on_segment(p, poly[i], poly[(i + 1) % len(poly)]):
                return True

    x, y = p
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        intersects = ((yi > y) != (yj > y))
        if intersects:
            x_cross = (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi
            if x < x_cross:
                inside = not inside
        j = i
    return inside


def _polygon_is_simple_coords(coords: list[list[float]] | list[tuple[float, float]]) -> bool:
    return _is_simple_coords([(float(x), float(y)) for x, y in coords])


def _polygon_centroid_coords(coords: list[tuple[float, float]]) -> tuple[float, float]:
    if not coords:
        return (0.0, 0.0)
    area = _signed_area_coords(coords)
    if abs(area) < 1e-9:
        return (
            sum(x for x, _ in coords) / len(coords),
            sum(y for _, y in coords) / len(coords),
        )
    cx = 0.0
    cy = 0.0
    for i in range(len(coords)):
        x1, y1 = coords[i]
        x2, y2 = coords[(i + 1) % len(coords)]
        cross = x1 * y2 - x2 * y1
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    factor = 1.0 / (6.0 * area)
    return (cx * factor, cy * factor)


def _normalize_polygon_coords(
    coords: list[list[float]] | list[tuple[float, float]],
    eps: float = 1e-6,
) -> list[tuple[float, float]]:
    normalized = [(float(x), float(y)) for x, y in coords]
    if len(normalized) > 1 and _vtx_close(normalized[0], normalized[-1], eps):
        normalized.pop()

    deduped: list[tuple[float, float]] = []
    for pt in normalized:
        if not deduped or not _vtx_close(deduped[-1], pt, eps):
            deduped.append(pt)

    if len(deduped) > 1 and _vtx_close(deduped[0], deduped[-1], eps):
        deduped.pop()

    if len(deduped) < 3:
        return deduped

    cleaned: list[tuple[float, float]] = []
    n = len(deduped)
    for i in range(n):
        prev_pt = deduped[(i - 1) % n]
        cur_pt = deduped[i]
        next_pt = deduped[(i + 1) % n]
        if abs(_triangle_signed_area(prev_pt, cur_pt, next_pt)) > eps:
            cleaned.append(cur_pt)

    return cleaned if len(cleaned) >= 3 else deduped


def _vtx_close(a: tuple[float, float], b: tuple[float, float], eps: float = 1e-6) -> bool:
    return abs(a[0] - b[0]) <= eps and abs(a[1] - b[1]) <= eps


def _triangle_signed_area(
    a: tuple[float, float],
    b: tuple[float, float],
    c: tuple[float, float],
) -> float:
    return ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2.0


def _point_in_triangle_coords(
    p: tuple[float, float],
    a: tuple[float, float],
    b: tuple[float, float],
    c: tuple[float, float],
    include_boundary: bool = True,
    eps: float = 1e-6,
) -> bool:
    area1 = _triangle_signed_area(p, a, b)
    area2 = _triangle_signed_area(p, b, c)
    area3 = _triangle_signed_area(p, c, a)
    if include_boundary:
        return (
            area1 >= -eps and area2 >= -eps and area3 >= -eps
        ) or (
            area1 <= eps and area2 <= eps and area3 <= eps
        )
    return (
        area1 > eps and area2 > eps and area3 > eps
    ) or (
        area1 < -eps and area2 < -eps and area3 < -eps
    )


def _diagonal_is_inside_polygon(
    a: tuple[float, float],
    b: tuple[float, float],
    polygon: list[tuple[float, float]],
) -> bool:
    midpoint = ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)
    if not _point_in_polygon_coords(midpoint, polygon, include_boundary=False):
        return False

    for i in range(len(polygon)):
        p0 = polygon[i]
        p1 = polygon[(i + 1) % len(polygon)]
        if _vtx_close(a, p0) or _vtx_close(a, p1) or _vtx_close(b, p0) or _vtx_close(b, p1):
            continue
        if _seg_seg_intersect(a, b, p0, p1) is not None:
            return False

    return True


def _triangulate_polygon_coords(
    coords: list[list[float]] | list[tuple[float, float]],
) -> list[list[tuple[float, float]]]:
    ring = _normalize_polygon_coords(coords)
    if len(ring) < 3:
        return []

    if _signed_area_coords(ring) < 0:
        ring = list(reversed(ring))

    remaining = list(range(len(ring)))
    triangles: list[list[tuple[float, float]]] = []
    safety = len(ring) * len(ring)

    while len(remaining) > 3 and safety > 0:
        safety -= 1
        ear_found = False
        count = len(remaining)

        for pos, idx in enumerate(remaining):
            prev_idx = remaining[(pos - 1) % count]
            next_idx = remaining[(pos + 1) % count]
            a = ring[prev_idx]
            b = ring[idx]
            c = ring[next_idx]
            current_polygon = [ring[item] for item in remaining]

            if _triangle_signed_area(a, b, c) <= 1e-8:
                continue
            if not _diagonal_is_inside_polygon(a, c, current_polygon):
                continue

            blocked = False
            for other_idx in remaining:
                if other_idx in {prev_idx, idx, next_idx}:
                    continue
                if _point_in_triangle_coords(ring[other_idx], a, b, c, include_boundary=False):
                    blocked = True
                    break
            if blocked:
                continue

            triangles.append([a, b, c])
            del remaining[pos]
            ear_found = True
            break

        if not ear_found:
            break

    if len(remaining) == 3:
        triangles.append([ring[remaining[0]], ring[remaining[1]], ring[remaining[2]]])

    return triangles


def _closest_point_on_segment_coords(
    p: tuple[float, float],
    a: tuple[float, float],
    b: tuple[float, float],
) -> tuple[float, float]:
    ax, ay = a
    bx, by = b
    px, py = p
    dx = bx - ax
    dy = by - ay
    len2 = dx * dx + dy * dy
    if len2 < 1e-12:
        return a
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / len2))
    return (ax + t * dx, ay + t * dy)


def _nearest_boundary_direction(
    p: tuple[float, float],
    outer_coords: list[tuple[float, float]],
) -> list[float]:
    ccw = _signed_area_coords(outer_coords) >= 0
    best_dir = [0.0, -1.0]
    best_d2 = float("inf")

    for i in range(len(outer_coords)):
        a = outer_coords[i]
        b = outer_coords[(i + 1) % len(outer_coords)]
        closest = _closest_point_on_segment_coords(p, a, b)
        d2 = (closest[0] - p[0]) ** 2 + (closest[1] - p[1]) ** 2
        if d2 >= best_d2:
            continue

        dx = b[0] - a[0]
        dy = b[1] - a[1]
        length = math.sqrt(dx * dx + dy * dy)
        if length < 1e-9:
            continue

        if ccw:
            best_dir = [dy / length, -dx / length]
        else:
            best_dir = [-dy / length, dx / length]
        best_d2 = d2

    return best_dir


def _edge_outward_direction(
    a: tuple[float, float],
    b: tuple[float, float],
    outer_coords: list[tuple[float, float]],
    eps: float = 1e-6,
) -> list[float] | None:
    ccw = _signed_area_coords(outer_coords) >= 0
    for i in range(len(outer_coords)):
        p0 = outer_coords[i]
        p1 = outer_coords[(i + 1) % len(outer_coords)]
        same = _vtx_close(a, p0, eps) and _vtx_close(b, p1, eps)
        reverse = _vtx_close(a, p1, eps) and _vtx_close(b, p0, eps)
        if not same and not reverse:
            continue

        dx = p1[0] - p0[0]
        dy = p1[1] - p0[1]
        length = math.sqrt(dx * dx + dy * dy)
        if length < 1e-9:
            return None

        if ccw:
            return [dy / length, -dx / length]
        return [-dy / length, dx / length]
    return None


def _triangulated_face_direction(
    tri: list[tuple[float, float]],
    outer_coords: list[tuple[float, float]],
) -> list[float]:
    best_dir: list[float] | None = None
    best_len = -1.0

    for i in range(len(tri)):
        a = tri[i]
        b = tri[(i + 1) % len(tri)]
        edge_dir = _edge_outward_direction(a, b, outer_coords)
        if edge_dir is None:
            continue
        length = math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)
        if length > best_len:
            best_len = length
            best_dir = edge_dir

    if best_dir is not None:
        return best_dir

    centroid = _polygon_centroid_coords(tri)
    return _nearest_boundary_direction(centroid, outer_coords)


def _generate_triangulated_roof_faces(outer_polygon: list[Point]) -> list[RoofFace]:
    outer_coords = [(p.x, p.y) for p in outer_polygon]
    triangles = _triangulate_polygon_coords(outer_coords)
    faces: list[RoofFace] = []

    for tri in triangles:
        faces.append(RoofFace(
            polygon=[[x, y] for x, y in tri],
            direction=_triangulated_face_direction(tri, outer_coords),
        ))

    return faces


def _generate_rectilinear_cell_roof_faces(outer_polygon: list[Point]) -> list[RoofFace]:
    poly = Polygon([Point(p.x, p.y) for p in outer_polygon])
    if not _is_rectilinear_polygon(poly):
        return []

    outer_coords = [(p.x, p.y) for p in outer_polygon]
    cells = _rectilinear_cells(poly)
    faces: list[RoofFace] = []

    for x0, y0, x1, y1 in cells:
        rect = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        centroid = ((x0 + x1) / 2.0, (y0 + y1) / 2.0)
        faces.append(RoofFace(
            polygon=[[x, y] for x, y in rect],
            direction=_nearest_boundary_direction(centroid, outer_coords),
        ))

    return faces


def _roof_faces_valid(
    outer_polygon: list[Point],
    faces: list[RoofFace],
) -> bool:
    if not faces:
        return False

    outer_coords = [(p.x, p.y) for p in outer_polygon]
    outer_area = abs(_signed_area_coords(outer_coords))
    face_area_sum = 0.0

    for face in faces:
        coords = [(float(x), float(y)) for x, y in face.polygon]
        if len(coords) < 3:
            return False
        if not _polygon_is_simple_coords(coords):
            return False

        area = abs(_signed_area_coords(coords))
        if area < 1e-6:
            return False
        face_area_sum += area

        centroid = _polygon_centroid_coords(coords)
        if not _point_in_polygon_coords(centroid, outer_coords):
            return False

        for i in range(len(coords)):
            mx = (coords[i][0] + coords[(i + 1) % len(coords)][0]) / 2.0
            my = (coords[i][1] + coords[(i + 1) % len(coords)][1]) / 2.0
            if not _point_in_polygon_coords((mx, my), outer_coords):
                return False

    if outer_area > 1e-6 and face_area_sum < outer_area * 0.92:
        return False

    if outer_area > 1e-6 and face_area_sum > outer_area * 1.8:
        return False

    triangles = _triangulate_polygon_coords(outer_coords)
    if not triangles:
        return False

    face_coords = [[(float(x), float(y)) for x, y in face.polygon] for face in faces]
    for tri in triangles:
        samples = [_polygon_centroid_coords(tri)]
        for i in range(3):
            a = tri[i]
            b = tri[(i + 1) % 3]
            samples.append(((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0))
        for sample in samples:
            if not any(_point_in_polygon_coords(sample, coords) for coords in face_coords):
                return False

    return True


def _is_rectilinear_polygon(fp: Polygon, eps: float = 1e-6) -> bool:
    if len(fp) < 4:
        return False
    for i in range(len(fp)):
        a = fp[i]
        b = fp[(i + 1) % len(fp)]
        dx = abs(b.x - a.x)
        dy = abs(b.y - a.y)
        if dx > eps and dy > eps:
            return False
    return True


def _rectilinear_cells(fp: Polygon) -> list[tuple[float, float, float, float]]:
    xs = sorted({round(p.x, 6) for p in fp})
    ys = sorted({round(p.y, 6) for p in fp})
    coords = [(p.x, p.y) for p in fp]
    cells: list[tuple[float, float, float, float]] = []
    for xi in range(len(xs) - 1):
        for yi in range(len(ys) - 1):
            x0, x1 = xs[xi], xs[xi + 1]
            y0, y1 = ys[yi], ys[yi + 1]
            if x1 - x0 < 1e-6 or y1 - y0 < 1e-6:
                continue
            center = ((x0 + x1) / 2.0, (y0 + y1) / 2.0)
            if _point_in_polygon_coords(center, coords, include_boundary=False):
                cells.append((x0, y0, x1, y1))
    return cells


def _is_rectilinear_coords(
    coords: list[list[float]] | list[tuple[float, float]],
    eps: float = 1e-6,
) -> bool:
    if len(coords) < 4:
        return False
    for i in range(len(coords)):
        x0, y0 = coords[i]
        x1, y1 = coords[(i + 1) % len(coords)]
        dx = abs(float(x1) - float(x0))
        dy = abs(float(y1) - float(y0))
        if dx > eps and dy > eps:
            return False
    return True


def _rectilinear_cells_from_polygons(
    polygons: list[list[list[float]] | list[tuple[float, float]]],
) -> list[tuple[float, float, float, float]]:
    xs = sorted({round(float(x), 6) for poly in polygons for x, _ in poly})
    ys = sorted({round(float(y), 6) for poly in polygons for _, y in poly})
    if len(xs) < 2 or len(ys) < 2:
        return []

    normalized = [[(float(x), float(y)) for x, y in poly] for poly in polygons]
    cells: list[tuple[float, float, float, float]] = []
    for xi in range(len(xs) - 1):
        for yi in range(len(ys) - 1):
            x0, x1 = xs[xi], xs[xi + 1]
            y0, y1 = ys[yi], ys[yi + 1]
            if x1 - x0 < 1e-6 or y1 - y0 < 1e-6:
                continue
            center = ((x0 + x1) / 2.0, (y0 + y1) / 2.0)
            if any(_point_in_polygon_coords(center, poly, include_boundary=False) for poly in normalized):
                cells.append((x0, y0, x1, y1))
    return cells


def _cells_share_edge(
    a: tuple[float, float, float, float],
    b: tuple[float, float, float, float],
    eps: float = 1e-6,
) -> bool:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    vertical_touch = (
        (abs(ax1 - bx0) < eps or abs(bx1 - ax0) < eps)
        and min(ay1, by1) - max(ay0, by0) > eps
    )
    horizontal_touch = (
        (abs(ay1 - by0) < eps or abs(by1 - ay0) < eps)
        and min(ax1, bx1) - max(ax0, bx0) > eps
    )
    return vertical_touch or horizontal_touch


def _split_cell_components(
    cells: list[tuple[float, float, float, float]],
) -> list[list[tuple[float, float, float, float]]]:
    components: list[list[tuple[float, float, float, float]]] = []
    visited: set[int] = set()
    for idx in range(len(cells)):
        if idx in visited:
            continue
        stack = [idx]
        visited.add(idx)
        component: list[tuple[float, float, float, float]] = []
        while stack:
            current = stack.pop()
            component.append(cells[current])
            for other in range(len(cells)):
                if other in visited:
                    continue
                if _cells_share_edge(cells[current], cells[other]):
                    visited.add(other)
                    stack.append(other)
        components.append(component)
    return components


def _boundary_edges_from_cells(
    cells: list[tuple[float, float, float, float]],
) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    edges: dict[
        tuple[tuple[float, float], tuple[float, float]],
        tuple[tuple[float, float], tuple[float, float]],
    ] = {}
    for x0, y0, x1, y1 in cells:
        vertices = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        rect_edges = [
            (vertices[0], vertices[1]),
            (vertices[1], vertices[2]),
            (vertices[2], vertices[3]),
            (vertices[3], vertices[0]),
        ]
        for start, end in rect_edges:
            key = tuple(sorted((start, end)))
            if key in edges:
                del edges[key]
            else:
                edges[key] = (start, end)
    return list(edges.values())


def _trace_boundary_loops(
    edges: list[tuple[tuple[float, float], tuple[float, float]]],
) -> list[list[tuple[float, float]]]:
    outgoing: dict[tuple[float, float], list[tuple[float, float]]] = {}
    for start, end in edges:
        outgoing.setdefault(start, []).append(end)

    used: set[tuple[tuple[float, float], tuple[float, float]]] = set()
    loops: list[list[tuple[float, float]]] = []

    for edge in edges:
        if edge in used:
            continue
        start, end = edge
        loop = [start, end]
        used.add(edge)
        current = end

        while current != start:
            next_edges = outgoing.get(current, [])
            next_point = None
            for candidate in next_edges:
                candidate_edge = (current, candidate)
                if candidate_edge not in used:
                    next_point = candidate
                    used.add(candidate_edge)
                    break
            if next_point is None:
                loop = []
                break
            loop.append(next_point)
            current = next_point

        if len(loop) >= 4:
            loops.append(loop[:-1])

    return loops


def merge_touching_roof_levels(
    raw_levels: list[dict[str, Any]],
    default_building_type: str = "house",
    default_style: str = "generic",
    default_roof_type: str = "auto",
) -> list[dict[str, Any]]:
    grouped: dict[tuple[int, str, str, str], list[dict[str, Any]]] = {}
    for raw_level in raw_levels:
        polygon = raw_level.get("polygon", [])
        stories = int(raw_level.get("join_stories", raw_level.get("stories", 1)))
        roof_type = str(raw_level.get("roof_type") or default_roof_type or "auto")
        level_type = str(raw_level.get("building_type", default_building_type))
        level_style = str(raw_level.get("style", default_style))
        join_group = str(raw_level.get("join_group", "")).strip()
        if join_group:
            key = (stories, roof_type, f"group:{join_group}", "*")
        elif roof_type == "auto":
            key = (stories, roof_type, level_type, level_style)
        else:
            key = (stories, roof_type, "*", "*")
        grouped.setdefault(key, []).append(raw_level)

    merged_levels: list[dict[str, Any]] = []
    for key, levels in grouped.items():
        if len(levels) == 1:
            merged_levels.extend(levels)
            continue

        polygons = [level.get("polygon", []) for level in levels]
        if not all(
            len(poly) >= 3 and _polygon_is_simple_coords(poly) and _is_rectilinear_coords(poly)
            for poly in polygons
        ):
            merged_levels.extend(levels)
            continue

        cells = _rectilinear_cells_from_polygons(polygons)
        components = _split_cell_components(cells)
        if len(components) != 1:
            merged_levels.extend(levels)
            continue

        loops = _trace_boundary_loops(_boundary_edges_from_cells(components[0]))
        if len(loops) != 1 or not _polygon_is_simple_coords(loops[0]):
            merged_levels.extend(levels)
            continue

        stories, roof_type, level_type, level_style = key
        if roof_type != "auto":
            level_type = str(levels[0].get("building_type", default_building_type))
            level_style = str(levels[0].get("style", default_style))
        if level_type.startswith("group:"):
            level_type = str(levels[0].get("building_type", default_building_type))
            level_style = str(levels[0].get("style", default_style))
        ids = [str(level.get("id", "")) for level in levels if level.get("id")]
        labels = [str(level.get("label", "")) for level in levels if level.get("label")]
        merged_levels.append({
            "id": "+".join(ids) if ids else f"joined_{len(merged_levels) + 1}",
            "label": " + ".join(labels) if labels else "Joined Mass",
            "stories": stories,
            "polygon": [[round(x, 2), round(y, 2)] for x, y in loops[0]],
            "building_type": level_type,
            "style": level_style,
            "roof_type": roof_type if roof_type != "auto" else "",
            "joined": True,
            "source_ids": ids,
        })

    return merged_levels


def _merge_rectilinear_cells(
    cells: list[tuple[float, float, float, float]],
) -> list[tuple[float, float, float, float]]:
    if not cells:
        return []

    rows: dict[tuple[float, float], list[tuple[float, float]]] = {}
    for x0, y0, x1, y1 in cells:
        rows.setdefault((y0, y1), []).append((x0, x1))

    horizontal: list[tuple[float, float, float, float]] = []
    for (y0, y1), spans in rows.items():
        spans.sort()
        cur_x0, cur_x1 = spans[0]
        for x0, x1 in spans[1:]:
            if abs(x0 - cur_x1) < 1e-6:
                cur_x1 = x1
            else:
                horizontal.append((cur_x0, y0, cur_x1, y1))
                cur_x0, cur_x1 = x0, x1
        horizontal.append((cur_x0, y0, cur_x1, y1))

    horizontal.sort(key=lambda r: (r[0], r[2], r[1], r[3]))
    merged: list[tuple[float, float, float, float]] = []
    for rect in horizontal:
        if not merged:
            merged.append(rect)
            continue
        last = merged[-1]
        if (
            abs(last[0] - rect[0]) < 1e-6
            and abs(last[2] - rect[2]) < 1e-6
            and abs(last[3] - rect[1]) < 1e-6
        ):
            merged[-1] = (last[0], last[1], last[2], rect[3])
        else:
            merged.append(rect)
    return merged


def _rect_from_bounds(x0: float, y0: float, x1: float, y1: float) -> Polygon:
    return Polygon([
        Point(x0, y0),
        Point(x1, y0),
        Point(x1, y1),
        Point(x0, y1),
    ])


def _ridge_segments_from_roof(roof: RoofGeometry) -> list[list[list[float]]]:
    if roof.extras.get("segments"):
        return list(roof.extras["segments"])

    ridge = roof.ridge_polygon or []
    if len(ridge) < 2:
        return []

    segments: list[list[list[float]]] = []
    if roof.roof_type in {"gabled", "vaulted"}:
        for i in range(0, len(ridge) - 1, 2):
            segments.append([ridge[i], ridge[i + 1]])
        return segments

    if len(ridge) == 2:
        return [[ridge[0], ridge[1]]]

    for i in range(len(ridge)):
        segments.append([ridge[i], ridge[(i + 1) % len(ridge)]])
    return segments


def _generate_rectilinear_partition_roof(
    fp: Polygon,
    overhang: float = 0.35,
    part_mode: str = "mixed",
) -> RoofGeometry:
    cells = _rectilinear_cells(fp)
    rects = _merge_rectilinear_cells(cells)
    if not rects:
        fallback = generate_hipped_merged(fp, overhang=overhang)
        fallback.roof_type = "skeleton"
        fallback.extras["algorithm"] = "fallback_hipped_no_rect_partition"
        return fallback

    face_parts: list[RoofFace] = []
    ridge_segments: list[list[list[float]]] = []
    ridge_points: list[list[float]] = []
    seen_ridge_pts: set[tuple[float, float]] = set()

    for rect in rects:
        rect_poly = _rect_from_bounds(*rect)
        width = abs(rect[2] - rect[0])
        height = abs(rect[3] - rect[1])
        if part_mode == "gabled":
            generator = generate_gabled
        elif part_mode == "hipped":
            generator = generate_hipped
        else:
            generator = generate_gabled if max(width, height) / max(min(width, height), 1e-6) >= 1.6 else generate_hipped
        part = generator(rect_poly, overhang=0.0)
        face_parts.extend(part.faces)
        for segment in _ridge_segments_from_roof(part):
            ridge_segments.append(segment)
            for x, y in segment:
                key = (round(x, 2), round(y, 2))
                if key not in seen_ridge_pts:
                    seen_ridge_pts.add(key)
                    ridge_points.append([round(x, 2), round(y, 2)])

    outline = _offset_polygon(fp, overhang) if overhang > 0 else [p.clone() for p in fp]

    return RoofGeometry(
        roof_type="skeleton",
        polygon=_pts_to_coords(outline),
        ridge_polygon=ridge_points,
        overhang=overhang,
        faces=face_parts,
        extras={
            "algorithm": f"rectilinear_partition_{part_mode}",
            "segments": ridge_segments,
            "component_count": len(rects),
        },
    )


def _footprint_bbox(fp: Polygon) -> tuple[float, float, float, float]:
    """Return (min_x, min_y, max_x, max_y)."""
    xs = [p.x for p in fp]
    ys = [p.y for p in fp]
    return min(xs), min(ys), max(xs), max(ys)


def _footprint_longest_axis(fp: Polygon) -> tuple[Point, Point, float]:
    """Return the two endpoints and angle of the longest edge."""
    best_len = -1.0
    best_a = fp[0]
    best_b = fp[1] if len(fp) > 1 else fp[0]
    n = len(fp)
    for i in range(n):
        a = fp[i]
        b = fp[(i + 1) % n]
        d = Point.distance(a, b)
        if d > best_len:
            best_len = d
            best_a = a
            best_b = b
    angle = math.atan2(best_b.y - best_a.y, best_b.x - best_a.x)
    return best_a, best_b, angle


def _offset_polygon(fp: Polygon, dist: float) -> list[Point]:
    """Simple outward offset of a polygon by *dist* (positive = outward).

    Uses edge-normal offsetting with line-line intersection for corners.
    Falls back gracefully for degenerate cases.
    """
    n = len(fp)
    if n < 3:
        return list(fp)

    # Detect winding: positive signed area = CCW, negative = CW
    signed_area = 0.0
    for i in range(n):
        a = fp[i]
        b = fp[(i + 1) % n]
        signed_area += (b.x - a.x) * (b.y + a.y)
    # signed_area > 0 means CW in screen coords (y-down)
    winding_sign = 1.0 if signed_area > 0 else -1.0

    # Compute offset edges
    edges = []
    for i in range(n):
        a = fp[i]
        b = fp[(i + 1) % n]
        dx = b.x - a.x
        dy = b.y - a.y
        length = math.sqrt(dx * dx + dy * dy)
        if length < 1e-9:
            edges.append((a, b, 0, 0))
            continue
        # Outward normal: direction depends on winding
        nx = -dy / length * dist * winding_sign
        ny = dx / length * dist * winding_sign
        edges.append((
            Point(a.x + nx, a.y + ny),
            Point(b.x + nx, b.y + ny),
            nx, ny,
        ))

    result = []
    for i in range(n):
        e1 = edges[i]
        e2 = edges[(i + 1) % n]
        # Intersect the two offset edge lines
        pt = _line_intersect(e1[0], e1[1], e2[0], e2[1])
        if pt is not None:
            result.append(pt)
        else:
            # Parallel edges — just use the endpoint
            result.append(e1[1])

    return result


def _line_intersect(a1: Point, a2: Point, b1: Point, b2: Point) -> Point | None:
    """Intersect two infinite lines (a1→a2) and (b1→b2). Returns None if parallel."""
    dx1 = a2.x - a1.x
    dy1 = a2.y - a1.y
    dx2 = b2.x - b1.x
    dy2 = b2.y - b1.y
    denom = dx1 * dy2 - dy1 * dx2
    if abs(denom) < 1e-12:
        return None
    t = ((b1.x - a1.x) * dy2 - (b1.y - a1.y) * dx2) / denom
    return Point(a1.x + dx1 * t, a1.y + dy1 * t)


def _inset_polygon(fp: Polygon, dist: float) -> list[Point]:
    """Inward offset (shrink). Just negative of offset."""
    return _offset_polygon(fp, -dist)


# ---------------------------------------------------------------------------
# Self-intersection handling for non-convex polygon offset
# ---------------------------------------------------------------------------

def _seg_seg_intersect(
    a1: tuple[float, float], a2: tuple[float, float],
    b1: tuple[float, float], b2: tuple[float, float],
) -> tuple[float, float] | None:
    """Intersection point of segments a1-a2 and b1-b2, or None."""
    d1x = a2[0] - a1[0]
    d1y = a2[1] - a1[1]
    d2x = b2[0] - b1[0]
    d2y = b2[1] - b1[1]
    denom = d1x * d2y - d1y * d2x
    if abs(denom) < 1e-10:
        return None
    dx = b1[0] - a1[0]
    dy = b1[1] - a1[1]
    t = (dx * d2y - dy * d2x) / denom
    s = (dx * d1y - dy * d1x) / denom
    eps = 1e-8
    if eps < t < 1 - eps and eps < s < 1 - eps:
        return (a1[0] + d1x * t, a1[1] + d1y * t)
    return None


def _signed_area_coords(pts: list[tuple[float, float]]) -> float:
    """Signed area of a polygon from coordinate tuples. Positive = CCW."""
    n = len(pts)
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
    return area / 2.0


def _split_self_intersecting(
    pts: list[tuple[float, float]],
) -> list[list[tuple[float, float]]]:
    """Split a self-intersecting polygon into non-intersecting sub-polygons.

    Recursively finds intersections and splits. Only keeps loops with
    positive (CCW) winding and area > threshold.
    """
    n = len(pts)
    if n < 3:
        return []

    # Find first self-intersection among non-adjacent edges
    for i in range(n):
        ni = (i + 1) % n
        for j in range(i + 2, n):
            nj = (j + 1) % n
            if ni == j or nj == i:
                continue
            pt = _seg_seg_intersect(pts[i], pts[ni], pts[j], pts[nj])
            if pt is not None:
                # Build two loops by splitting at the intersection
                loop_a = [pt]
                k = ni
                while k != nj:
                    loop_a.append(pts[k])
                    k = (k + 1) % n

                loop_b = [pt]
                k = nj
                while k != ni:
                    loop_b.append(pts[k])
                    k = (k + 1) % n

                # Recursively clean each loop
                # Reverse CW loops to CCW (they're valid regions traced backwards)
                result = []
                for loop in (loop_a, loop_b):
                    if len(loop) < 3:
                        continue
                    area = _signed_area_coords(loop)
                    if abs(area) < 0.1:
                        continue
                    if area < 0:
                        loop = list(reversed(loop))
                    result.extend(_split_self_intersecting(loop))
                return result if result else []

    # No self-intersection — polygon is clean
    return [pts]


def _offset_polygon_clean(
    fp: Polygon, dist: float,
) -> list[list[tuple[float, float]]]:
    """Offset polygon and split any self-intersections.

    Returns a list of non-self-intersecting polygons as coordinate lists.
    Handles non-convex footprints where naive offset creates spikes.
    """
    raw = _offset_polygon(fp, dist)
    if len(raw) < 3:
        return []
    raw_coords = [(p.x, p.y) for p in raw]
    return _split_self_intersecting(raw_coords)


def _closest_point_on_segments(
    pts: list[tuple[float, float]], target: tuple[float, float],
) -> tuple[float, float]:
    """Find the closest point on any edge of the polygon to target."""
    best_pt = pts[0]
    best_d2 = float("inf")
    n = len(pts)
    tx, ty = target
    for i in range(n):
        ax, ay = pts[i]
        bx, by = pts[(i + 1) % n]
        # Project target onto segment
        dx, dy = bx - ax, by - ay
        len2 = dx * dx + dy * dy
        if len2 < 1e-12:
            px, py = ax, ay
        else:
            t = max(0.0, min(1.0, ((tx - ax) * dx + (ty - ay) * dy) / len2))
            px = ax + t * dx
            py = ay + t * dy
        d2 = (px - tx) ** 2 + (py - ty) ** 2
        if d2 < best_d2:
            best_d2 = d2
            best_pt = (px, py)
    return best_pt


def _compute_hipped_faces_multi(
    outer: list[Point],
    inner_groups: list[list[tuple[float, float]]],
    center: Point,
) -> list[RoofFace]:
    """Build slope faces between outer polygon and multiple inner (ridge) polygons.

    Each outer edge maps to the closest point on any inner polygon edge.
    Direction uses edge outward normal (correct for non-convex shapes).
    """
    n_out = len(outer)
    if n_out < 3 or not inner_groups:
        return []

    # Detect winding for outward normal computation
    signed = sum(
        (outer[(i + 1) % n_out].x - outer[i].x) * (outer[(i + 1) % n_out].y + outer[i].y)
        for i in range(n_out)
    )
    ws = 1.0 if signed > 0 else -1.0  # CW=1, CCW=-1

    def _best_closest(target: tuple[float, float]) -> tuple[float, float]:
        best_pt = inner_groups[0][0]
        best_d2 = float("inf")
        for group in inner_groups:
            pt = _closest_point_on_segments(group, target)
            d2 = (pt[0] - target[0]) ** 2 + (pt[1] - target[1]) ** 2
            if d2 < best_d2:
                best_d2 = d2
                best_pt = pt
        return best_pt

    faces = []
    for i in range(n_out):
        a = outer[i]
        b = outer[(i + 1) % n_out]

        pa = _best_closest((a.x, a.y))
        pb = _best_closest((b.x, b.y))

        face_pts = [
            [round(a.x, 2), round(a.y, 2)],
            [round(b.x, 2), round(b.y, 2)],
            [round(pb[0], 2), round(pb[1], 2)],
            [round(pa[0], 2), round(pa[1], 2)],
        ]

        # Edge outward normal as slope direction
        edx = b.x - a.x
        edy = b.y - a.y
        length = math.sqrt(edx * edx + edy * edy)
        if length > 0:
            nx = -edy / length * ws
            ny = edx / length * ws
        else:
            nx, ny = 0.0, 0.0

        faces.append(RoofFace(polygon=face_pts, direction=[nx, ny]))

    for group in inner_groups:
        if len(group) >= 3 and abs(_signed_area_coords(group)) > 1e-6:
            gx, gy = _polygon_centroid_coords(group)
            faces.extend(_compute_cap_faces_to_apex(
                _coords_to_points(group),
                Point(gx, gy),
            ))

    return faces


def _polygon_centroid(pts: list[Point]) -> Point:
    """Centroid of a list of points (simple average)."""
    cx = sum(p.x for p in pts) / len(pts)
    cy = sum(p.y for p in pts) / len(pts)
    return Point(cx, cy)


def _edge_midpoint(a: Point, b: Point) -> Point:
    return Point((a.x + b.x) / 2, (a.y + b.y) / 2)


def _compute_hipped_faces(
    outer: list[Point], inner: list[Point], center: Point,
) -> list[RoofFace]:
    """Build slope faces between outer polygon and inner polygon.

    Each outer edge maps to the closest inner edge, forming a trapezoid.
    Direction is computed from the face midpoint outward from center.
    """
    n_out = len(outer)
    n_in = len(inner)
    if n_out < 3 or n_in < 3:
        return []

    faces = []
    for i in range(n_out):
        a = outer[i]
        b = outer[(i + 1) % n_out]

        # Find closest inner points to a and b
        ia = _closest_idx(inner, a)
        ib = _closest_idx(inner, b)

        face_pts = [a, b, inner[ib], inner[ia]]
        # Direction: midpoint of outer edge → outward from center
        mx = (a.x + b.x) / 2
        my = (a.y + b.y) / 2
        dx = mx - center.x
        dy = my - center.y
        length = math.sqrt(dx * dx + dy * dy)
        if length > 0:
            dx /= length
            dy /= length

        faces.append(RoofFace(
            polygon=_pts_to_coords(face_pts),
            direction=[dx, dy],
        ))

    return faces


def _compute_hipped_quad_faces(
    outer: list[Point],
    center: Point,
    direction: Point,
    ridge_a: Point,
    ridge_b: Point,
) -> list[RoofFace]:
    """Build a true hipped roof for quadrilateral footprints with no plateau."""
    if len(outer) != 4:
        return []

    perp = Point(-direction.y, direction.x)
    local = []
    for p in outer:
        u = (p.x - center.x) * direction.x + (p.y - center.y) * direction.y
        v = (p.x - center.x) * perp.x + (p.y - center.y) * perp.y
        local.append((u, v, p))

    top = sorted(sorted(local, key=lambda item: item[1], reverse=True)[:2], key=lambda item: item[0])
    bottom = sorted(sorted(local, key=lambda item: item[1])[:2], key=lambda item: item[0])
    top_left, top_right = top[0][2], top[1][2]
    bottom_left, bottom_right = bottom[0][2], bottom[1][2]

    ridge_len2 = (ridge_b.x - ridge_a.x) ** 2 + (ridge_b.y - ridge_a.y) ** 2
    if ridge_len2 < 1e-6:
        apex = ridge_a
        return [
            RoofFace(polygon=_pts_to_coords([top_left, top_right, apex]), direction=[perp.x, perp.y]),
            RoofFace(polygon=_pts_to_coords([top_right, bottom_right, apex]), direction=[direction.x, direction.y]),
            RoofFace(polygon=_pts_to_coords([bottom_right, bottom_left, apex]), direction=[-perp.x, -perp.y]),
            RoofFace(polygon=_pts_to_coords([bottom_left, top_left, apex]), direction=[-direction.x, -direction.y]),
        ]

    return [
        RoofFace(polygon=_pts_to_coords([top_left, top_right, ridge_b, ridge_a]), direction=[perp.x, perp.y]),
        RoofFace(polygon=_pts_to_coords([top_right, bottom_right, ridge_b]), direction=[direction.x, direction.y]),
        RoofFace(polygon=_pts_to_coords([bottom_right, bottom_left, ridge_a, ridge_b]), direction=[-perp.x, -perp.y]),
        RoofFace(polygon=_pts_to_coords([bottom_left, top_left, ridge_a]), direction=[-direction.x, -direction.y]),
    ]


def _compute_gabled_faces(
    outer: list[Point], ridge_a: Point, ridge_b: Point, center: Point,
    direction: Point,
) -> list[RoofFace]:
    """Build slope faces for gabled roof: two long slopes + two gable triangles.

    Splits outer polygon vertices into those on each side of the ridge line,
    then connects each side's eave points + ridge endpoints into a proper
    non-self-intersecting polygon.
    """
    n = len(outer)
    if n < 3:
        return []

    # Perpendicular to ridge direction
    perp_x = -direction.y
    perp_y = direction.x

    # Split outer vertices by which side of the ridge they're on
    side_pos = []  # positive side of perpendicular
    side_neg = []

    for p in outer:
        dot = (p.x - center.x) * perp_x + (p.y - center.y) * perp_y
        if dot >= 0:
            side_pos.append(p)
        else:
            side_neg.append(p)

    faces = []

    # Positive side: eave goes left→right, ridge goes right→left to close
    if side_pos:
        side_pos.sort(key=lambda p: (p.x - center.x) * direction.x + (p.y - center.y) * direction.y)
        face_pts = side_pos + [ridge_b, ridge_a]
        faces.append(RoofFace(
            polygon=_pts_to_coords(face_pts),
            direction=[perp_x, perp_y],
        ))

    # Negative side: ridge goes left→right, eave goes right→left to close
    if side_neg:
        side_neg.sort(key=lambda p: (p.x - center.x) * direction.x + (p.y - center.y) * direction.y)
        face_pts = [ridge_a, ridge_b] + list(reversed(side_neg))
        faces.append(RoofFace(
            polygon=_pts_to_coords(face_pts),
            direction=[-perp_x, -perp_y],
        ))

    return faces


def _compute_conical_faces(
    outer: list[Point], apex: Point,
) -> list[RoofFace]:
    """Build triangular slope faces for a conical roof."""
    n = len(outer)
    faces = []
    for i in range(n):
        a = outer[i]
        b = outer[(i + 1) % n]
        mx = (a.x + b.x) / 2
        my = (a.y + b.y) / 2
        dx = mx - apex.x
        dy = my - apex.y
        length = math.sqrt(dx * dx + dy * dy)
        if length > 0:
            dx /= length
            dy /= length
        faces.append(RoofFace(
            polygon=_pts_to_coords([a, b, apex]),
            direction=[dx, dy],
        ))
    return faces


def _compute_cap_faces_to_apex(
    ring: list[Point],
    apex: Point,
) -> list[RoofFace]:
    """Fill an inner ridge ring with sloped faces instead of a flat cap."""
    if len(ring) < 3:
        return []
    return _compute_conical_faces(ring, apex)


def _compute_dome_faces(
    circle_pts: list[Point], center: Point, n_rings: int = 3,
) -> list[RoofFace]:
    """Build concentric ring faces for dome shading."""
    n = len(circle_pts)
    faces = []
    for ring in range(n_rings):
        r_outer = 1.0 - ring / n_rings
        r_inner = 1.0 - (ring + 1) / n_rings
        for i in range(n):
            a = circle_pts[i]
            b = circle_pts[(i + 1) % n]
            # Outer edge
            ao = Point(center.x + (a.x - center.x) * r_outer,
                       center.y + (a.y - center.y) * r_outer)
            bo = Point(center.x + (b.x - center.x) * r_outer,
                       center.y + (b.y - center.y) * r_outer)
            # Inner edge
            ai = Point(center.x + (a.x - center.x) * r_inner,
                       center.y + (a.y - center.y) * r_inner)
            bi = Point(center.x + (b.x - center.x) * r_inner,
                       center.y + (b.y - center.y) * r_inner)
            mx = (ao.x + bo.x) / 2
            my = (ao.y + bo.y) / 2
            dx = mx - center.x
            dy = my - center.y
            length = math.sqrt(dx * dx + dy * dy)
            if length > 0:
                dx /= length
                dy /= length
            # Steeper toward center: add vertical component analog
            steepness = 0.3 + 0.7 * (1.0 - r_outer)
            faces.append(RoofFace(
                polygon=_pts_to_coords([ao, bo, bi, ai]),
                direction=[dx * (1.0 - steepness), dy * (1.0 - steepness)],
            ))
    return faces


def _closest_idx(pts: list[Point], target: Point) -> int:
    best = 0
    best_d = float("inf")
    for i, p in enumerate(pts):
        d = (p.x - target.x) ** 2 + (p.y - target.y) ** 2
        if d < best_d:
            best_d = d
            best = i
    return best


def _oriented_bbox(fp: Polygon) -> tuple[Point, Point, float, float, float]:
    """Compute oriented bounding box center, direction, half-width, half-height, angle.

    Uses the longest edge as the primary axis.
    Returns: (center, direction_unit, half_length, half_width, angle_rad)
    """
    a, b, angle = _footprint_longest_axis(fp)
    cos_a = math.cos(-angle)
    sin_a = math.sin(-angle)

    # Rotate all points to axis-aligned space
    rotated = []
    for p in fp:
        rx = (p.x) * cos_a - (p.y) * sin_a
        ry = (p.x) * sin_a + (p.y) * cos_a
        rotated.append((rx, ry))

    min_x = min(r[0] for r in rotated)
    max_x = max(r[0] for r in rotated)
    min_y = min(r[1] for r in rotated)
    max_y = max(r[1] for r in rotated)

    half_l = (max_x - min_x) / 2
    half_w = (max_y - min_y) / 2
    cx_r = (min_x + max_x) / 2
    cy_r = (min_y + max_y) / 2

    # Rotate center back
    cos_a2 = math.cos(angle)
    sin_a2 = math.sin(angle)
    cx = cx_r * cos_a2 - cy_r * sin_a2
    cy = cx_r * sin_a2 + cy_r * cos_a2

    direction = Point(math.cos(angle), math.sin(angle))
    return Point(cx, cy), direction, half_l, half_w, angle


# ---------------------------------------------------------------------------
# Roof type generators
# ---------------------------------------------------------------------------

def generate_gabled(fp: Polygon, overhang: float = 0.5) -> RoofGeometry:
    """Gabled pitched roof — ridge line along long axis, triangular gable ends.

    Plan view: the roof polygon is the overhang outline; the ridge is
    a single line segment along the long axis center.
    For rectilinear non-convex polygons, decomposes into rectangular
    sub-roofs so crosses / courtyards get clean ridges. For other
    non-convex polygons, delegates to the validated skeleton path.
    """
    if not _is_convex_polygon(fp):
        if _is_rectilinear_polygon(fp):
            result = _generate_rectilinear_partition_roof(fp, overhang=overhang, part_mode="gabled")
            result.roof_type = "gabled"
            return result
        result = generate_skeleton(fp, overhang=overhang)
        result.roof_type = "gabled"
        return result

    center, direction, half_l, half_w, angle = _oriented_bbox(fp)

    # Ridge endpoints along the long axis
    ridge_a = Point(center.x - direction.x * half_l * 0.85,
                    center.y - direction.y * half_l * 0.85)
    ridge_b = Point(center.x + direction.x * half_l * 0.85,
                    center.y + direction.y * half_l * 0.85)

    # Overhang polygon
    if overhang > 0:
        roof_pts = _offset_polygon(fp, overhang)
    else:
        roof_pts = [p.clone() for p in fp]

    faces = _compute_gabled_faces(roof_pts, ridge_a, ridge_b, center, direction)

    return RoofGeometry(
        roof_type="gabled",
        polygon=_pts_to_coords(roof_pts),
        ridge_polygon=_pts_to_coords([ridge_a, ridge_b]),
        overhang=overhang,
        faces=faces,
    )


def _is_convex_polygon(fp: Polygon) -> bool:
    """Check if polygon is convex (all cross products same sign)."""
    n = len(fp)
    if n < 3:
        return True
    sign = None
    for i in range(n):
        a = fp[i]
        b = fp[(i + 1) % n]
        c = fp[(i + 2) % n]
        cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
        if abs(cross) < 1e-9:
            continue
        s = cross > 0
        if sign is None:
            sign = s
        elif s != sign:
            return False
    return True


def generate_hipped(fp: Polygon, overhang: float = 0.5) -> RoofGeometry:
    """Hipped roof — all sides slope inward to an inner polygon.

    For convex polygons: uses oriented bounding box + inset ridge.
    For rectilinear non-convex polygons (L, T, U, etc.): uses rectangular
    partitioning to avoid invalid global skeleton faces in deep concavities.
    For other non-convex polygons: delegates to the validated skeleton path.
    """
    if not _is_convex_polygon(fp):
        if _is_rectilinear_polygon(fp):
            result = _generate_rectilinear_partition_roof(fp, overhang=overhang, part_mode="hipped")
            result.roof_type = "hipped"
            return result
        result = generate_skeleton(fp, overhang=overhang)
        result.roof_type = "hipped"
        return result

    center, direction, half_l, half_w, _ = _oriented_bbox(fp)

    # Outer: overhang expansion
    if overhang > 0:
        roof_pts = _offset_polygon(fp, overhang)
    else:
        roof_pts = [p.clone() for p in fp]

    if len(fp) == 4:
        ridge_half = max(half_l - half_w, 0.0)
        ridge_a = Point(center.x - direction.x * ridge_half, center.y - direction.y * ridge_half)
        ridge_b = Point(center.x + direction.x * ridge_half, center.y + direction.y * ridge_half)
        ridge_pts = [ridge_a, ridge_b] if ridge_half > 1e-6 else [center]
        faces = _compute_hipped_quad_faces(roof_pts, center, direction, ridge_a, ridge_b)
    else:
        # Inner ridge polygon for general convex polygons
        inset_dist = min(half_w * 0.6, half_l * 0.3)
        inset_dist = max(inset_dist, 0.5)
        ridge_pts = _inset_polygon(fp, inset_dist)
        faces = _compute_hipped_faces(roof_pts, ridge_pts, center)
        faces.extend(_compute_cap_faces_to_apex(ridge_pts, center))

    return RoofGeometry(
        roof_type="hipped",
        polygon=_pts_to_coords(roof_pts),
        ridge_polygon=_pts_to_coords(ridge_pts),
        overhang=overhang,
        faces=faces,
    )


def generate_flat(fp: Polygon, overhang: float = 0.0) -> RoofGeometry:
    """Flat roof — just the footprint edge, no ridge.

    Optional parapet line slightly inset.
    """
    # Flat roofs typically have no overhang
    roof_pts = [p.clone() for p in fp]

    # Parapet: slight inset
    parapet_pts = _inset_polygon(fp, 0.3)

    # Single face covering the whole roof (flat = uniform shading)
    faces = [RoofFace(
        polygon=_pts_to_coords(roof_pts),
        direction=[0.0, -1.0],  # slightly lit from top
    )]

    return RoofGeometry(
        roof_type="flat",
        polygon=_pts_to_coords(roof_pts),
        ridge_polygon=_pts_to_coords(parapet_pts),
        overhang=overhang,
        faces=faces,
        extras={"parapet": True},
    )


def generate_domed(fp: Polygon, overhang: float = 0.0) -> RoofGeometry:
    """Dome — circle inscribed in footprint.

    Plan view: the roof polygon is the footprint; the ridge polygon
    is a circle (approximated as regular polygon) inscribed in the bbox.
    """
    center, _, half_l, half_w, _ = _oriented_bbox(fp)
    radius = min(half_l, half_w) * 0.85

    # Approximate circle with 16 segments
    n_seg = 16
    circle_pts = []
    for i in range(n_seg):
        a = 2 * math.pi * i / n_seg
        circle_pts.append(Point(center.x + radius * math.cos(a),
                                center.y + radius * math.sin(a)))

    roof_pts = [p.clone() for p in fp]

    faces = _compute_dome_faces(circle_pts, center, n_rings=3)

    return RoofGeometry(
        roof_type="domed",
        polygon=_pts_to_coords(roof_pts),
        ridge_polygon=_pts_to_coords(circle_pts),
        overhang=overhang,
        faces=faces,
        extras={"dome_center": [round(center.x, 2), round(center.y, 2)],
                "dome_radius": round(radius, 2)},
    )


def generate_pagoda(fp: Polygon, overhang: float = 1.0) -> RoofGeometry:
    """Pagoda roof — stepped concentric polygons.

    Plan view: outer polygon (with generous overhang) + multiple
    concentric inset rings as the ridge polygon.
    """
    # Generous overhang for the swept-up eaves
    roof_pts = _offset_polygon(fp, overhang)
    center, _, half_l, half_w, _ = _oriented_bbox(fp)

    # Generate concentric rings and faces between them
    step = min(half_w, half_l) * 0.25
    step = max(step, 0.5)
    ring_levels: list[list[Point]] = [roof_pts]
    ridge_coords: list[list[float]] = []
    for level in range(1, 4):
        ring_pts = _inset_polygon(fp, step * level)
        if len(ring_pts) >= 3:
            ring_levels.append(ring_pts)
            ridge_coords.extend(_pts_to_coords(ring_pts))

    # Compute faces between consecutive rings
    faces = []
    for li in range(len(ring_levels) - 1):
        outer_ring = ring_levels[li]
        inner_ring = ring_levels[li + 1]
        faces.extend(_compute_hipped_faces(outer_ring, inner_ring, center))

    top_ring = ring_levels[-1] if ring_levels else []
    if len(top_ring) >= 3:
        faces.extend(_compute_cap_faces_to_apex(top_ring, _polygon_centroid(top_ring)))

    return RoofGeometry(
        roof_type="pagoda",
        polygon=_pts_to_coords(roof_pts),
        ridge_polygon=ridge_coords,
        overhang=overhang,
        faces=faces,
        extras={"levels": len(ring_levels) - 1},
    )


def generate_thatched(fp: Polygon, overhang: float = 0.8) -> RoofGeometry:
    """Thatched roof — hipped shape with hatched fill indicator.

    Geometrically similar to hipped, but with a thicker overhang
    and a style hint for hatched rendering.
    """
    result = generate_hipped(fp, overhang=overhang)
    result.roof_type = "thatched"
    result.extras["hatch_fill"] = True
    return result


def generate_conical(fp: Polygon, overhang: float = 0.3) -> RoofGeometry:
    """Conical roof — circle to apex point (towers, turrets).

    Plan view: circular roof outline, single center point as ridge.
    """
    center, _, half_l, half_w, _ = _oriented_bbox(fp)
    radius = max(half_l, half_w) + overhang

    # Circle outline
    n_seg = 16
    circle_pts = []
    for i in range(n_seg):
        a = 2 * math.pi * i / n_seg
        circle_pts.append(Point(center.x + radius * math.cos(a),
                                center.y + radius * math.sin(a)))

    faces = _compute_conical_faces(circle_pts, center)

    return RoofGeometry(
        roof_type="conical",
        polygon=_pts_to_coords(circle_pts),
        ridge_polygon=[[round(center.x, 2), round(center.y, 2)]],
        overhang=overhang,
        faces=faces,
        extras={"apex": [round(center.x, 2), round(center.y, 2)]},
    )


def generate_hipped_merged(fp: Polygon, overhang: float = 0.5) -> RoofGeometry:
    """Hipped roof for potentially non-convex footprints (L, T, U, etc.).

    Uses _offset_polygon_clean to handle self-intersections in the ridge
    polygon, then builds faces mapping outer edges to nearest ridge points.
    """
    center, _, half_l, half_w, _ = _oriented_bbox(fp)

    if overhang > 0:
        roof_pts = _offset_polygon(fp, overhang)
    else:
        roof_pts = [p.clone() for p in fp]

    inset_dist = min(half_w * 0.6, half_l * 0.3)
    inset_dist = max(inset_dist, 0.5)

    ridge_groups = _offset_polygon_clean(fp, -inset_dist)

    if not ridge_groups:
        ridge_groups = [[(center.x, center.y)]]

    faces = _compute_hipped_faces_multi(roof_pts, ridge_groups, center)

    all_ridge_coords = []
    for group in ridge_groups:
        all_ridge_coords.extend([[round(x, 2), round(y, 2)] for x, y in group])

    return RoofGeometry(
        roof_type="hipped",
        polygon=_pts_to_coords(roof_pts),
        ridge_polygon=all_ridge_coords,
        overhang=overhang,
        faces=faces,
        extras={"merged": True, "ridge_count": len(ridge_groups)},
    )


def generate_skeleton(fp: Polygon, overhang: float = 0.35) -> RoofGeometry:
    """Straight-skeleton roof for arbitrary simple polygons.

    This is the best-fit generator for hand-drawn, non-convex footprints.
    It computes one sloped roof face per roof edge and exposes the skeleton
    arcs as ridge segments for visualization.
    """
    from town_generator.detail.skeleton import compute_straight_skeleton, skeleton_to_faces

    if len(fp) < 3:
        return generate_flat(fp, overhang=0.0)

    base_pts = _ensure_ccw_points([p.clone() for p in fp])
    roof_pts = base_pts

    if overhang > 0:
        offset_pts = _offset_polygon(fp, overhang)
        offset_coords = [(p.x, p.y) for p in offset_pts]
        if _is_simple_coords(offset_coords):
            roof_pts = _ensure_ccw_points(offset_pts)
        else:
            clean_loops = _offset_polygon_clean(fp, overhang)
            best_loop = _largest_coord_loop(clean_loops)
            if len(best_loop) >= 3 and _is_simple_coords(best_loop):
                roof_pts = _ensure_ccw_points(_coords_to_points(best_loop))

    roof_coords = [(p.x, p.y) for p in roof_pts]
    try:
        arcs = compute_straight_skeleton(roof_coords)
        sk_faces = skeleton_to_faces(roof_coords, arcs)
    except Exception:
        arcs = []
        sk_faces = []

    faces: list[RoofFace] = []
    n = len(roof_pts)
    area = _signed_area_points(roof_pts)
    ccw = area >= 0

    for face in sk_faces:
        if len(face.vertices) < 3 or not (0 <= face.edge_index < n):
            continue

        a = roof_pts[face.edge_index]
        b = roof_pts[(face.edge_index + 1) % n]
        dx = b.x - a.x
        dy = b.y - a.y
        length = math.sqrt(dx * dx + dy * dy)
        if length < 1e-9:
            continue

        if ccw:
            nx = dy / length
            ny = -dx / length
        else:
            nx = -dy / length
            ny = dx / length

        coords = [[round(x, 2), round(y, 2)] for x, y in face.vertices]
        deduped: list[list[float]] = []
        for pt in coords:
            if not deduped or deduped[-1] != pt:
                deduped.append(pt)
        if len(deduped) >= 3:
            faces.append(RoofFace(polygon=deduped, direction=[nx, ny]))

    ridge_segments = [
        [
            [round(arc.start[0], 2), round(arc.start[1], 2)],
            [round(arc.end[0], 2), round(arc.end[1], 2)],
        ]
        for arc in arcs
    ]
    ridge_points: list[list[float]] = []
    seen: set[tuple[float, float]] = set()
    for seg in ridge_segments:
        for x, y in seg:
            key = (x, y)
            if key not in seen:
                seen.add(key)
                ridge_points.append([x, y])

    if not _roof_faces_valid(roof_pts, faces):
        rounded_roof_pts = _coords_to_points(_pts_to_coords(roof_pts))
        triangulated_faces = _generate_triangulated_roof_faces(rounded_roof_pts)
        if _roof_faces_valid(rounded_roof_pts, triangulated_faces):
            return RoofGeometry(
                roof_type="skeleton",
                polygon=_pts_to_coords(rounded_roof_pts),
                ridge_polygon=ridge_points,
                overhang=overhang,
                faces=triangulated_faces,
                extras={
                    "algorithm": "fallback_triangulated_skeleton_faces",
                    "requested_algorithm": "straight_skeleton",
                    "segments": ridge_segments,
                    "face_count": len(triangulated_faces),
                    "arc_count": len(ridge_segments),
                },
            )
        rectilinear_faces = _generate_rectilinear_cell_roof_faces(rounded_roof_pts)
        if _roof_faces_valid(rounded_roof_pts, rectilinear_faces):
            return RoofGeometry(
                roof_type="skeleton",
                polygon=_pts_to_coords(rounded_roof_pts),
                ridge_polygon=ridge_points,
                overhang=overhang,
                faces=rectilinear_faces,
                extras={
                    "algorithm": "fallback_rectilinear_cells_skeleton_faces",
                    "requested_algorithm": "straight_skeleton",
                    "segments": ridge_segments,
                    "face_count": len(rectilinear_faces),
                    "arc_count": len(ridge_segments),
                },
            )
        if _is_rectilinear_polygon(fp):
            return _generate_rectilinear_partition_roof(fp, overhang=overhang)
        fallback = generate_hipped_merged(fp, overhang=overhang)
        fallback.roof_type = "skeleton"
        fallback.extras["algorithm"] = "fallback_hipped_invalid_faces"
        fallback.extras["requested_algorithm"] = "straight_skeleton"
        return fallback

    return RoofGeometry(
        roof_type="skeleton",
        polygon=_pts_to_coords(roof_pts),
        ridge_polygon=ridge_points,
        overhang=overhang,
        faces=faces,
        extras={
            "algorithm": "straight_skeleton",
            "segments": ridge_segments,
            "face_count": len(faces),
            "arc_count": len(ridge_segments),
        },
    )


def generate_vaulted(fp: Polygon, overhang: float = 0.3) -> RoofGeometry:
    """Vaulted (barrel) roof — parallel lines along the long axis.

    Plan view: roof polygon (overhang) + parallel ridge lines.
    Two slope faces (like gabled) with vault line decoration.
    """
    center, direction, half_l, half_w, angle = _oriented_bbox(fp)

    # Overhang
    if overhang > 0:
        roof_pts = _offset_polygon(fp, overhang)
    else:
        roof_pts = [p.clone() for p in fp]

    # Ridge line along center (like gabled)
    ridge_a = Point(center.x - direction.x * half_l * 0.9,
                    center.y - direction.y * half_l * 0.9)
    ridge_b = Point(center.x + direction.x * half_l * 0.9,
                    center.y + direction.y * half_l * 0.9)

    # Parallel vault lines along the long axis (for decoration)
    perp = Point(-direction.y, direction.x)
    n_lines = max(2, int(half_w * 2 / 2.0))
    n_lines = min(n_lines, 6)
    vault_ridge_pts = []
    for i in range(n_lines):
        t = -1.0 + 2.0 * (i + 0.5) / n_lines
        offset = perp.scale(t * half_w * 0.7)
        line_a = Point(center.x - direction.x * half_l * 0.9 + offset.x,
                       center.y - direction.y * half_l * 0.9 + offset.y)
        line_b = Point(center.x + direction.x * half_l * 0.9 + offset.x,
                       center.y + direction.y * half_l * 0.9 + offset.y)
        vault_ridge_pts.append(line_a)
        vault_ridge_pts.append(line_b)

    faces = _compute_gabled_faces(roof_pts, ridge_a, ridge_b, center, direction)

    return RoofGeometry(
        roof_type="vaulted",
        polygon=_pts_to_coords(roof_pts),
        ridge_polygon=_pts_to_coords(vault_ridge_pts),
        overhang=overhang,
        faces=faces,
        extras={"vault_lines": n_lines},
    )


# ---------------------------------------------------------------------------
# Registry & dispatch
# ---------------------------------------------------------------------------

ROOF_GENERATORS = {
    "gabled": generate_gabled,
    "hipped": generate_hipped,
    "flat": generate_flat,
    "domed": generate_domed,
    "pagoda": generate_pagoda,
    "thatched": generate_thatched,
    "conical": generate_conical,
    "vaulted": generate_vaulted,
}

# Style → default roof type mapping
STYLE_ROOF_DEFAULTS: dict[str, str] = {
    "european_medieval": "gabled",
    "norse": "gabled",
    "arabic_islamic": "flat",
    "arabic": "flat",
    "east_asian": "hipped",
    "mongol": "flat",
    "viking": "thatched",
    "roman": "hipped",
    "byzantine": "domed",
    "generic": "hipped",
}

# Building type → roof type overrides (regardless of style)
BUILDING_ROOF_OVERRIDES: dict[str, str] = {
    "tower": "conical",
    "keep": "conical",
    "turret": "conical",
    "mosque": "domed",
    "church": "gabled",
    "cathedral": "gabled",
    "chapel": "gabled",
    "pagoda": "pagoda",
    "barn": "gabled",
    "ger": "conical",
    "farmhouse": "thatched",
    "great_hall": "gabled",
}


def generate_roof(
    footprint: Polygon,
    roof_type: str | None = None,
    building_type: str = "house",
    style: str = "generic",
    overhang: float | None = None,
) -> RoofGeometry:
    """Generate roof geometry for a building footprint.

    Args:
        footprint: The building footprint polygon.
        roof_type: Explicit roof type override. If None, inferred from
                   building_type and style.
        building_type: Type of building (e.g. "house", "tower", "mosque").
        style: Cultural style id.
        overhang: Overhang depth. If None, uses the generator's default.

    Returns:
        RoofGeometry with plan-view roof polygon and ridge.
    """
    if len(footprint) < 3:
        return RoofGeometry(
            roof_type="flat",
            polygon=_pts_to_coords(list(footprint)),
            ridge_polygon=[],
            overhang=0.0,
        )

    # Determine roof type
    if roof_type is None:
        roof_type = BUILDING_ROOF_OVERRIDES.get(
            building_type,
            STYLE_ROOF_DEFAULTS.get(style, "hipped"),
        )

    if roof_type == "skeleton":
        if overhang is not None:
            return generate_skeleton(footprint, overhang=overhang)
        return generate_skeleton(footprint)

    if roof_type == "merged_hipped":
        if overhang is not None:
            return generate_hipped_merged(footprint, overhang=overhang)
        return generate_hipped_merged(footprint)

    gen_fn = ROOF_GENERATORS.get(roof_type, generate_hipped)

    if overhang is not None:
        return gen_fn(footprint, overhang=overhang)
    return gen_fn(footprint)
