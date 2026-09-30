"""Facade detail placement — windows, doors, chimneys, etc.

Decorates building footprints with 2D markers for architectural details.
All positions are in the same coordinate space as the footprint.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon


@dataclass
class FacadeDetail:
    """A single facade decoration element."""
    detail_type: str      # "window", "door", "chimney", "balcony", "buttress", "minaret"
    pos: list[float]      # [x, y]
    orientation: float    # degrees, 0 = right, 90 = down
    size: float = 1.0     # relative scale

    def to_dict(self) -> dict:
        return {
            "type": self.detail_type,
            "pos": [round(self.pos[0], 2), round(self.pos[1], 2)],
            "orientation": round(self.orientation, 1),
            "size": round(self.size, 2),
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _edge_length(a: Point, b: Point) -> float:
    return Point.distance(a, b)


def _edge_angle_deg(a: Point, b: Point) -> float:
    """Angle of the edge a→b in degrees."""
    return math.degrees(math.atan2(b.y - a.y, b.x - a.x))


def _edge_normal_angle_deg(a: Point, b: Point) -> float:
    """Outward-facing normal angle in degrees (90° CW from edge direction)."""
    return _edge_angle_deg(a, b) + 90.0


def _point_along_edge(a: Point, b: Point, t: float) -> tuple[float, float]:
    """Interpolate along edge a→b at parameter t (0..1)."""
    return (a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)


def _edges_sorted_by_length(fp: Polygon) -> list[tuple[int, Point, Point, float]]:
    """Return edges sorted by length (longest first).

    Each entry: (edge_index, point_a, point_b, length)
    """
    n = len(fp)
    edges = []
    for i in range(n):
        a = fp[i]
        b = fp[(i + 1) % n]
        edges.append((i, a, b, _edge_length(a, b)))
    edges.sort(key=lambda e: -e[3])
    return edges


def _find_street_facing_edge(fp: Polygon, alley_centers: list[list[float]] | None = None) -> int:
    """Identify the most likely street-facing edge.

    If alley_centers are provided, picks the edge closest to an alley centerline.
    Otherwise, picks the longest edge as the most likely street-facing one.
    """
    n = len(fp)
    if not alley_centers or len(alley_centers) == 0:
        # Default: longest edge
        edges = _edges_sorted_by_length(fp)
        return edges[0][0] if edges else 0

    # Find edge whose midpoint is closest to any alley center
    best_idx = 0
    best_dist = float("inf")
    for i in range(n):
        a = fp[i]
        b = fp[(i + 1) % n]
        mx, my = (a.x + b.x) / 2, (a.y + b.y) / 2
        for ac in alley_centers:
            d = math.sqrt((mx - ac[0]) ** 2 + (my - ac[1]) ** 2)
            if d < best_dist:
                best_dist = d
                best_idx = i
    return best_idx


# ---------------------------------------------------------------------------
# Detail generators
# ---------------------------------------------------------------------------

def place_windows(
    fp: Polygon,
    spacing: float = 3.0,
    min_edge_length: float = 4.0,
    street_edge: int | None = None,
    exclude_edges: set[int] | None = None,
) -> list[FacadeDetail]:
    """Place windows along edges of the footprint.

    Windows are evenly spaced rectangles on edges longer than min_edge_length.
    The street-facing edge gets windows; back/blank walls may be excluded.
    """
    n = len(fp)
    exclude = exclude_edges or set()
    details = []

    for i in range(n):
        if i in exclude:
            continue
        a = fp[i]
        b = fp[(i + 1) % n]
        length = _edge_length(a, b)
        if length < min_edge_length:
            continue

        angle = _edge_normal_angle_deg(a, b)
        n_windows = max(1, int(length / spacing))
        for j in range(n_windows):
            t = (j + 0.5) / n_windows
            # Inset slightly from edge
            px, py = _point_along_edge(a, b, t)
            dx = b.x - a.x
            dy = b.y - a.y
            el = length if length > 0 else 1
            # Inset 0.3 units toward interior
            nx = -dy / el * 0.3
            ny = dx / el * 0.3
            details.append(FacadeDetail(
                detail_type="window",
                pos=[px + nx, py + ny],
                orientation=angle,
                size=0.8,
            ))

    return details


def place_door(
    fp: Polygon,
    street_edge: int | None = None,
    alley_centers: list[list[float]] | None = None,
) -> list[FacadeDetail]:
    """Place a door on the street-facing edge.

    Returns a single door detail at the center of the street-facing edge.
    """
    if street_edge is None:
        street_edge = _find_street_facing_edge(fp, alley_centers)

    n = len(fp)
    a = fp[street_edge]
    b = fp[(street_edge + 1) % n]
    mx, my = _point_along_edge(a, b, 0.5)
    angle = _edge_normal_angle_deg(a, b)

    return [FacadeDetail(
        detail_type="door",
        pos=[mx, my],
        orientation=angle,
        size=1.2,
    )]


def place_chimney(
    fp: Polygon,
    ridge_center: list[float] | None = None,
) -> list[FacadeDetail]:
    """Place a chimney near the ridge center, offset to one side.

    If no ridge center is provided, places near the footprint centroid.
    """
    if ridge_center:
        cx, cy = ridge_center[0], ridge_center[1]
    else:
        c = _polygon_centroid_simple(fp)
        cx, cy = c[0], c[1]

    # Offset slightly from center
    _, _, half_l, half_w = _simple_bbox(fp)
    offset = min(half_l, half_w) * 0.3

    return [FacadeDetail(
        detail_type="chimney",
        pos=[cx + offset, cy - offset],
        orientation=0,
        size=0.6,
    )]


def place_buttresses(
    fp: Polygon,
    spacing: float = 5.0,
    min_edge_length: float = 8.0,
) -> list[FacadeDetail]:
    """Place buttress projections at intervals along long walls (Gothic)."""
    n = len(fp)
    details = []

    for i in range(n):
        a = fp[i]
        b = fp[(i + 1) % n]
        length = _edge_length(a, b)
        if length < min_edge_length:
            continue

        angle = _edge_normal_angle_deg(a, b)
        n_buttresses = max(1, int(length / spacing))
        for j in range(n_buttresses):
            t = (j + 0.5) / n_buttresses
            px, py = _point_along_edge(a, b, t)
            details.append(FacadeDetail(
                detail_type="buttress",
                pos=[px, py],
                orientation=angle,
                size=1.0,
            ))

    return details


def place_balcony(
    fp: Polygon,
    street_edge: int | None = None,
    alley_centers: list[list[float]] | None = None,
) -> list[FacadeDetail]:
    """Place a balcony on the street-facing edge (upper stories)."""
    if street_edge is None:
        street_edge = _find_street_facing_edge(fp, alley_centers)

    n = len(fp)
    a = fp[street_edge]
    b = fp[(street_edge + 1) % n]
    length = _edge_length(a, b)
    if length < 4.0:
        return []

    mx, my = _point_along_edge(a, b, 0.5)
    angle = _edge_normal_angle_deg(a, b)

    return [FacadeDetail(
        detail_type="balcony",
        pos=[mx, my],
        orientation=angle,
        size=max(1.0, length * 0.4),
    )]


def place_minaret(fp: Polygon) -> list[FacadeDetail]:
    """Place a minaret/tower at one corner of the building."""
    if len(fp) < 3:
        return []

    # Pick the first corner
    p = fp[0]
    return [FacadeDetail(
        detail_type="minaret",
        pos=[p.x, p.y],
        orientation=0,
        size=1.5,
    )]


# ---------------------------------------------------------------------------
# Composite facade generation
# ---------------------------------------------------------------------------

# Detail density levels
DENSITY_NONE = 0
DENSITY_SPARSE = 1
DENSITY_RICH = 2

# Style → facade detail configuration
STYLE_FACADE_CONFIG: dict[str, dict] = {
    "european_medieval": {
        "windows": True, "door": True, "chimney": True,
        "buttress": False, "balcony": False, "minaret": False,
    },
    "norse": {
        "windows": True, "door": True, "chimney": True,
        "buttress": False, "balcony": False, "minaret": False,
    },
    "arabic_islamic": {
        "windows": True, "door": True, "chimney": False,
        "buttress": False, "balcony": True, "minaret": True,
    },
    "arabic": {
        "windows": True, "door": True, "chimney": False,
        "buttress": False, "balcony": True, "minaret": True,
    },
    "roman": {
        "windows": True, "door": True, "chimney": False,
        "buttress": True, "balcony": False, "minaret": False,
    },
    "east_asian": {
        "windows": True, "door": True, "chimney": False,
        "buttress": False, "balcony": True, "minaret": False,
    },
    "viking": {
        "windows": True, "door": True, "chimney": True,
        "buttress": False, "balcony": False, "minaret": False,
    },
    "generic": {
        "windows": True, "door": True, "chimney": True,
        "buttress": False, "balcony": False, "minaret": False,
    },
}


def generate_facade_details(
    footprint: Polygon,
    building_type: str = "house",
    style: str = "generic",
    density: int = DENSITY_SPARSE,
    stories: int = 1,
    alley_centers: list[list[float]] | None = None,
    ridge_center: list[float] | None = None,
) -> list[FacadeDetail]:
    """Generate all facade details for a building.

    Args:
        footprint: The building footprint polygon.
        building_type: Type of building.
        style: Cultural style id.
        density: 0=none, 1=sparse, 2=rich.
        stories: Number of stories (affects balcony placement).
        alley_centers: Optional alley centerline points for street detection.
        ridge_center: Optional ridge center for chimney placement.

    Returns:
        List of FacadeDetail objects.
    """
    if density == DENSITY_NONE or len(footprint) < 3:
        return []

    config = STYLE_FACADE_CONFIG.get(style, STYLE_FACADE_CONFIG["generic"])
    street_edge = _find_street_facing_edge(footprint, alley_centers)
    details: list[FacadeDetail] = []

    # Door (always, if enabled)
    if config.get("door"):
        details.extend(place_door(footprint, street_edge, alley_centers))

    # Windows
    if config.get("windows"):
        spacing = 3.0 if density == DENSITY_RICH else 5.0
        details.extend(place_windows(footprint, spacing=spacing, street_edge=street_edge))

    # Chimney (sparse: sometimes; rich: always)
    if config.get("chimney") and density >= DENSITY_SPARSE:
        details.extend(place_chimney(footprint, ridge_center))

    # Rich-only details
    if density >= DENSITY_RICH:
        if config.get("buttress") and building_type in ("church", "cathedral", "chapel"):
            details.extend(place_buttresses(footprint))

        if config.get("balcony") and stories >= 2:
            details.extend(place_balcony(footprint, street_edge, alley_centers))

        if config.get("minaret") and building_type in ("mosque",):
            details.extend(place_minaret(footprint))

    return details


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _polygon_centroid_simple(fp: Polygon) -> tuple[float, float]:
    cx = sum(p.x for p in fp) / max(len(fp), 1)
    cy = sum(p.y for p in fp) / max(len(fp), 1)
    return (cx, cy)


def _simple_bbox(fp: Polygon) -> tuple[float, float, float, float]:
    """Return (cx, cy, half_w, half_h)."""
    xs = [p.x for p in fp]
    ys = [p.y for p in fp]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    return ((min_x + max_x) / 2, (min_y + max_y) / 2,
            (max_x - min_x) / 2, (max_y - min_y) / 2)
