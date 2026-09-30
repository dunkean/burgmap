"""City-scale water features — coastline and rivers.

Coast: a single tortuous vectorized line cutting across one map edge.
Rivers: smooth vectorized centerlines with constant width, dilated to water mask.
Both use midpoint displacement + Chaikin smoothing.
"""

from __future__ import annotations

import math
import random as stdlib_random


class Shoreline:
    """A coastline as a polyline crossing the map. Sea is on one side."""

    def __init__(self) -> None:
        self.points: list[tuple[float, float]] = []

    def to_dict(self) -> dict:
        return {
            "points": [[round(x, 1), round(y, 1)] for x, y in self.points],
        }


class River:
    """A river as a smooth centerline with constant width."""

    def __init__(self) -> None:
        self.centerline: list[tuple[float, float]] = []
        self.width: float = 8.0

    def to_dict(self) -> dict:
        return {
            "centerline": [[round(x, 1), round(y, 1)] for x, y in self.centerline],
            "width": round(self.width, 1),
        }


# ── Shared geometry helpers ──────────────────────────────────────────

def midpoint_displacement(
    x0: float, y0: float, x1: float, y1: float,
    rng: stdlib_random.Random,
    depth: int, roughness: float = 0.3,
    clamp_min: float = -1e9, clamp_max: float = 1e9,
) -> list[tuple[float, float]]:
    """Recursive midpoint displacement for natural curves."""
    if depth <= 0:
        return [(x0, y0), (x1, y1)]

    mx = (x0 + x1) / 2
    my = (y0 + y1) / 2
    dx = x1 - x0
    dy = y1 - y0
    length = math.sqrt(dx * dx + dy * dy)

    offset = (rng.random() - 0.5) * 2 * length * roughness
    if length > 0:
        mx += (-dy / length) * offset
        my += (dx / length) * offset

    mx = max(clamp_min, min(clamp_max, mx))
    my = max(clamp_min, min(clamp_max, my))

    left = midpoint_displacement(x0, y0, mx, my, rng, depth - 1, roughness, clamp_min, clamp_max)
    right = midpoint_displacement(mx, my, x1, y1, rng, depth - 1, roughness, clamp_min, clamp_max)
    return left + right[1:]


def chaikin_smooth(points: list[tuple[float, float]], iterations: int = 2) -> list[tuple[float, float]]:
    """Chaikin corner-cutting smoothing."""
    result = points
    for _ in range(iterations):
        if len(result) < 3:
            break
        new = [result[0]]
        for i in range(len(result) - 1):
            x0, y0 = result[i]
            x1, y1 = result[i + 1]
            new.append((0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1))
            new.append((0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1))
        new.append(result[-1])
        result = new
    return result


def _point_segment_dist(
    px: float, py: float,
    ax: float, ay: float, bx: float, by: float,
) -> float:
    """Distance from point to line segment."""
    dx = bx - ax
    dy = by - ay
    len_sq = dx * dx + dy * dy
    if len_sq < 1e-10:
        return math.sqrt((px - ax) ** 2 + (py - ay) ** 2)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / len_sq))
    proj_x = ax + t * dx
    proj_y = ay + t * dy
    return math.sqrt((px - proj_x) ** 2 + (py - proj_y) ** 2)


def _edge_to_point(edge: int, pos: float, size: int) -> tuple[float, float]:
    if edge == 0:    return (pos, 0.0)
    if edge == 1:    return (float(size - 1), pos)
    if edge == 2:    return (pos, float(size - 1))
    return (0.0, pos)


# ── Coastline ────────────────────────────────────────────────────────

class CoastlineGenerator:
    """Generate a single tortuous coastline cutting across one map edge."""

    def generate(
        self,
        seed: int,
        size: int,
        coast_direction: int,
        coast_position: float = 0.25,
        roughness: float = 0.30,
    ) -> Shoreline:
        """Create a coastline.

        coast_direction: 0=N, 1=E, 2=S, 3=W — which edge has ocean.
        coast_position: 0.0-0.5, how far into the map the shore sits.
        """
        rng = stdlib_random.Random(seed + 4000)
        shore = Shoreline()

        base = coast_position * size

        if coast_direction in (0, 2):
            # Horizontal shoreline
            y_base = base if coast_direction == 0 else size - 1 - base
            pts = midpoint_displacement(
                0, y_base, size - 1, y_base, rng,
                depth=5, roughness=roughness,
                clamp_min=0, clamp_max=size - 1,
            )
        else:
            # Vertical shoreline
            x_base = base if coast_direction == 3 else size - 1 - base
            pts = midpoint_displacement(
                x_base, 0, x_base, size - 1, rng,
                depth=5, roughness=roughness,
                clamp_min=0, clamp_max=size - 1,
            )

        shore.points = chaikin_smooth(pts, iterations=3)
        return shore


def rasterize_coast(
    shore: Shoreline, size: int, coast_direction: int,
) -> list[list[bool]]:
    """Rasterize coast: water on the ocean side of the shoreline."""
    water = [[False] * size for _ in range(size)]
    if not shore.points:
        return water

    if coast_direction in (0, 2):
        shore_y = _shore_y_per_column(shore.points, size)
        for x in range(size):
            threshold = int(round(shore_y[x]))
            if coast_direction == 0:
                for y in range(min(size, threshold + 1)):
                    water[y][x] = True
            else:
                for y in range(max(0, threshold), size):
                    water[y][x] = True
    else:
        shore_x = _shore_x_per_row(shore.points, size)
        for y in range(size):
            threshold = int(round(shore_x[y]))
            if coast_direction == 3:
                for x in range(min(size, threshold + 1)):
                    water[y][x] = True
            else:
                for x in range(max(0, threshold), size):
                    water[y][x] = True

    return water


def _shore_y_per_column(
    points: list[tuple[float, float]], size: int,
) -> list[float]:
    """For a roughly horizontal polyline, get y value at each integer x.

    Walks all polyline segments, records y for each column the segment
    covers, fills gaps, then smooths to reduce staircase artifacts.
    """
    result: list[float | None] = [None] * size
    if len(points) < 2:
        return [0.0] * size

    for i in range(len(points) - 1):
        x0, y0 = points[i]
        x1, y1 = points[i + 1]
        lo_x = min(x0, x1)
        hi_x = max(x0, x1)
        start = max(0, int(math.floor(lo_x)))
        end = min(size - 1, int(math.ceil(hi_x)))

        dx = x1 - x0
        for x in range(start, end + 1):
            if abs(dx) < 0.001:
                result[x] = (y0 + y1) / 2
            else:
                t = max(0.0, min(1.0, (x - x0) / dx))
                result[x] = y0 + t * (y1 - y0)

    _fill_gaps(result, size)

    # Smooth to reduce staircase artifacts at the boundary
    out: list[float] = list(result)  # type: ignore[arg-type]
    for _ in range(2):
        prev = list(out)
        for x in range(1, size - 1):
            out[x] = (prev[x - 1] + prev[x] + prev[x + 1]) / 3.0
    return out


def _shore_x_per_row(
    points: list[tuple[float, float]], size: int,
) -> list[float]:
    """For a roughly vertical polyline, get x value at each integer y."""
    result: list[float | None] = [None] * size
    if len(points) < 2:
        return [0.0] * size

    for i in range(len(points) - 1):
        x0, y0 = points[i]
        x1, y1 = points[i + 1]
        lo_y = min(y0, y1)
        hi_y = max(y0, y1)
        start = max(0, int(math.floor(lo_y)))
        end = min(size - 1, int(math.ceil(hi_y)))

        dy = y1 - y0
        for y in range(start, end + 1):
            if abs(dy) < 0.001:
                result[y] = (x0 + x1) / 2
            else:
                t = max(0.0, min(1.0, (y - y0) / dy))
                result[y] = x0 + t * (x1 - x0)

    _fill_gaps(result, size)

    out: list[float] = list(result)  # type: ignore[arg-type]
    for _ in range(2):
        prev = list(out)
        for y in range(1, size - 1):
            out[y] = (prev[y - 1] + prev[y] + prev[y + 1]) / 3.0
    return out


def _fill_gaps(result: list, size: int) -> None:
    """Fill None gaps by extending from nearest known value."""
    last = None
    for i in range(size):
        if result[i] is not None:
            last = result[i]
        elif last is not None:
            result[i] = last
    last = None
    for i in range(size - 1, -1, -1):
        if result[i] is not None:
            last = result[i]
        elif last is not None:
            result[i] = last
    for i in range(size):
        if result[i] is None:
            result[i] = 0.0


# ── Rivers ───────────────────────────────────────────────────────────

class RiverGenerator:
    """Generate rivers as smooth vectorized paths with constant width.

    When multiple rivers are generated, later rivers merge into earlier
    ones at the nearest point instead of crossing them.
    """

    def generate(
        self,
        seed: int,
        size: int,
        river_count: int = 1,
        river_width: float = 8.0,
        coast_direction: int = -1,
    ) -> list[River]:
        if river_count <= 0:
            return []

        rng = stdlib_random.Random(seed + 2000)
        rivers: list[River] = []

        for i in range(river_count):
            river = self._create_river(size, rng, river_width, coast_direction)
            if river and len(river.centerline) >= 2:
                if rivers:
                    river = self._merge_if_crossing(river, rivers, size)
                if river and len(river.centerline) >= 2:
                    rivers.append(river)

        return rivers

    def _merge_if_crossing(
        self, river: River, existing: list[River], size: int,
    ) -> River:
        """If the new river crosses an existing one, truncate it at the
        confluence point (tributary merges into the main river)."""
        new_pts = river.centerline

        for other in existing:
            other_pts = other.centerline
            # Find the first point on the new river that is within
            # the combined width of both rivers from the existing one
            merge_threshold = (river.width + other.width) / 2 + 2.0

            for ni in range(len(new_pts)):
                nx, ny = new_pts[ni]
                for oi in range(len(other_pts) - 1):
                    dist = _point_segment_dist(
                        nx, ny,
                        other_pts[oi][0], other_pts[oi][1],
                        other_pts[oi + 1][0], other_pts[oi + 1][1],
                    )
                    if dist < merge_threshold:
                        # Found a near-crossing. Check if the new river
                        # actually passes through and out the other side
                        # (i.e. this isn't just the shared endpoint).
                        if ni < 2:
                            # Near start — skip, this is the entry
                            continue
                        # Truncate the new river here (tributary ends
                        # at the confluence with the existing river).
                        # Snap the endpoint onto the existing river.
                        snap_x, snap_y = _snap_to_polyline(
                            nx, ny, other_pts,
                        )
                        result = River()
                        result.width = river.width
                        result.centerline = list(new_pts[:ni]) + [(snap_x, snap_y)]
                        if len(result.centerline) >= 2:
                            return result
                        return river

        return river

    def _create_river(
        self,
        size: int,
        rng: stdlib_random.Random,
        width: float,
        coast_direction: int,
    ) -> River:
        river = River()
        river.width = max(3.0, width)

        entry_edge = self._pick_edge(rng, exclude=coast_direction)
        entry_pos = rng.uniform(size * 0.2, size * 0.8)

        if coast_direction >= 0:
            exit_edge = coast_direction
        else:
            exit_edge = self._pick_edge(rng, exclude=entry_edge)
        exit_pos = rng.uniform(size * 0.2, size * 0.8)

        sx, sy = _edge_to_point(entry_edge, entry_pos, size)
        ex, ey = _edge_to_point(exit_edge, exit_pos, size)

        margin = size * 0.03
        pts = midpoint_displacement(
            sx, sy, ex, ey, rng,
            depth=3, roughness=0.12,
            clamp_min=margin, clamp_max=size - 1 - margin,
        )
        river.centerline = chaikin_smooth(pts, iterations=2)

        return river

    @staticmethod
    def _pick_edge(rng: stdlib_random.Random, exclude: int) -> int:
        edges = [e for e in range(4) if e != exclude]
        return rng.choice(edges)


def _snap_to_polyline(
    px: float, py: float,
    polyline: list[tuple[float, float]],
) -> tuple[float, float]:
    """Find the closest point on a polyline to (px, py)."""
    best_dist = float("inf")
    best_x, best_y = px, py

    for i in range(len(polyline) - 1):
        ax, ay = polyline[i]
        bx, by = polyline[i + 1]
        dx = bx - ax
        dy = by - ay
        len_sq = dx * dx + dy * dy
        if len_sq < 1e-10:
            cx, cy = ax, ay
        else:
            t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / len_sq))
            cx = ax + t * dx
            cy = ay + t * dy
        d = math.sqrt((px - cx) ** 2 + (py - cy) ** 2)
        if d < best_dist:
            best_dist = d
            best_x, best_y = cx, cy

    return best_x, best_y


def rasterize_rivers(rivers: list[River], size: int) -> list[list[bool]]:
    """Dilate river centerlines to their constant widths."""
    water = [[False] * size for _ in range(size)]

    for river in rivers:
        pts = river.centerline
        half_w = river.width / 2 + 1
        if len(pts) < 2:
            continue

        for seg_i in range(len(pts) - 1):
            ax, ay = pts[seg_i]
            bx, by = pts[seg_i + 1]

            min_x = max(0, int(min(ax, bx) - half_w))
            max_x = min(size - 1, int(max(ax, bx) + half_w))
            min_y = max(0, int(min(ay, by) - half_w))
            max_y = min(size - 1, int(max(ay, by) + half_w))

            for y in range(min_y, max_y + 1):
                for x in range(min_x, max_x + 1):
                    if water[y][x]:
                        continue
                    dist = _point_segment_dist(
                        x + 0.5, y + 0.5, ax, ay, bx, by,
                    )
                    if dist <= river.width / 2:
                        water[y][x] = True

    return water


def cleanup_water_mask(water: list[list[bool]], size: int) -> None:
    """Remove 1-pixel artifacts from the water mask (in-place).

    If a cell disagrees with 3+ of its 4 cardinal neighbors, flip it.
    """
    for _ in range(2):
        changed = False
        for y in range(1, size - 1):
            for x in range(1, size - 1):
                neighbors_water = (
                    int(water[y - 1][x]) + int(water[y + 1][x])
                    + int(water[y][x - 1]) + int(water[y][x + 1])
                )
                if water[y][x] and neighbors_water <= 1:
                    water[y][x] = False
                    changed = True
                elif not water[y][x] and neighbors_water >= 3:
                    water[y][x] = True
                    changed = True
        if not changed:
            break
