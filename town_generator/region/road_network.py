"""Roads from satellite settlements to the main city via A* on terrain.

Each satellite gets a track/path road to the city center. Roads are
A* least-cost paths smoothed via Chaikin + Douglas-Peucker.
"""

from __future__ import annotations

import heapq
import math


def build_satellite_roads(
    city: dict,
    satellites: list[dict],
    size: int,
    elevation: list[list[float]],
    water: list[list[bool]],
    terrain: list[list[str]],
) -> tuple[list[dict], list[dict]]:
    """Build a road from each satellite to the main city. Returns (roads, bridges).

    Star topology: every satellite connects directly to the city center.
    """
    if not satellites:
        return [], []

    roads: list[dict] = []
    bridges: list[dict] = []

    cost_map = _build_cost_map(size, elevation, water, terrain)

    for i, sat in enumerate(satellites):
        path = astar(
            cost_map, size, water,
            (sat["x"], sat["y"]),
            (city["x"], city["y"]),
        )
        if not path:
            continue

        smoothed = _smooth_path(path)

        road_bridges = _detect_bridges(path, water, size)
        for bpos in road_bridges:
            bridges.append({
                "pos": list(bpos),
                "road_ref": f"road_{i}",
            })

        roads.append({
            "id": f"road_{i}",
            "from": sat["id"],
            "to": city["id"],
            "type": "track",
            "path": [[round(x, 1), round(y, 1)] for x, y in smoothed],
        })

    return roads, bridges


def astar(
    cost_map: list[list[float]],
    size: int,
    water: list[list[bool]],
    start: tuple[int, int],
    goal: tuple[int, int],
) -> list[tuple[int, int]]:
    """A* pathfinding over the terrain cost map.

    Returns a list of (x, y) grid coordinates from start to goal.
    """
    sx, sy = start
    gx, gy = goal

    open_set: list[tuple[float, float, int, int]] = []
    heapq.heappush(open_set, (0.0, 0.0, sx, sy))

    came_from: dict[tuple[int, int], tuple[int, int]] = {}
    g_score: dict[tuple[int, int], float] = {(sx, sy): 0.0}

    # 8-directional movement
    dirs = [
        (-1, 0, 1.0), (1, 0, 1.0), (0, -1, 1.0), (0, 1, 1.0),
        (-1, -1, 1.414), (1, -1, 1.414), (-1, 1, 1.414), (1, 1, 1.414),
    ]

    visited: set[tuple[int, int]] = set()
    max_iterations = size * size * 4

    for _ in range(max_iterations):
        if not open_set:
            break

        _, g, cx, cy = heapq.heappop(open_set)
        pos = (cx, cy)

        if pos in visited:
            continue
        visited.add(pos)

        if cx == gx and cy == gy:
            return _reconstruct_path(came_from, (gx, gy))

        for dx, dy, base_dist in dirs:
            nx, ny = cx + dx, cy + dy
            if not (0 <= nx < size and 0 <= ny < size):
                continue
            npos = (nx, ny)
            if npos in visited:
                continue

            move_cost = base_dist * cost_map[ny][nx]

            if water[ny][nx]:
                move_cost *= 8.0

            tentative_g = g + move_cost

            if tentative_g < g_score.get(npos, float("inf")):
                g_score[npos] = tentative_g
                came_from[npos] = pos
                h = math.sqrt((nx - gx) ** 2 + (ny - gy) ** 2)
                heapq.heappush(open_set, (tentative_g + h, tentative_g, nx, ny))

    return _straight_line(start, goal)


def _reconstruct_path(
    came_from: dict[tuple[int, int], tuple[int, int]],
    current: tuple[int, int],
) -> list[tuple[int, int]]:
    path = [current]
    while current in came_from:
        current = came_from[current]
        path.append(current)
    path.reverse()
    return path


def _straight_line(
    start: tuple[int, int], goal: tuple[int, int],
) -> list[tuple[int, int]]:
    """Bresenham-like straight line fallback."""
    x0, y0 = start
    x1, y1 = goal
    points = []
    dx = abs(x1 - x0)
    dy = abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx - dy

    while True:
        points.append((x0, y0))
        if x0 == x1 and y0 == y1:
            break
        e2 = 2 * err
        if e2 > -dy:
            err -= dy
            x0 += sx
        if e2 < dx:
            err += dx
            y0 += sy

    return points


# ── Cost Map ──────────────────────────────────────────────────────────


def _build_cost_map(
    size: int,
    elevation: list[list[float]],
    water: list[list[bool]],
    terrain: list[list[str]],
) -> list[list[float]]:
    """Movement cost map: slope + terrain penalties."""
    cost = [[1.0] * size for _ in range(size)]

    terrain_penalty = {
        "water": 10.0,
        "wetland": 2.0,
        "flat": 1.0,
        "slope": 2.5,
        "hill": 3.0,
    }

    for y in range(size):
        for x in range(size):
            base = terrain_penalty.get(terrain[y][x], 1.0)

            e = elevation[y][x]
            max_diff = 0.0
            for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                nx, ny = x + dx, y + dy
                if 0 <= nx < size and 0 <= ny < size:
                    diff = abs(elevation[ny][nx] - e)
                    if diff > max_diff:
                        max_diff = diff

            slope_mult = 1.0 + max_diff * 15
            cost[y][x] = base * slope_mult

    return cost


# ── Path Smoothing ────────────────────────────────────────────────────


def _smooth_path(path: list[tuple[int, int]]) -> list[tuple[float, float]]:
    """Douglas-Peucker simplification + Chaikin smoothing."""
    if len(path) < 3:
        return [(float(x), float(y)) for x, y in path]

    simplified = douglas_peucker(
        [(float(x), float(y)) for x, y in path],
        epsilon=1.5,
    )
    return chaikin_smooth(simplified, iterations=3)


def douglas_peucker(
    points: list[tuple[float, float]], epsilon: float,
) -> list[tuple[float, float]]:
    """Douglas-Peucker polyline simplification."""
    if len(points) <= 2:
        return points

    max_dist = 0.0
    max_idx = 0
    ax, ay = points[0]
    bx, by = points[-1]

    for i in range(1, len(points) - 1):
        d = _point_line_dist(points[i][0], points[i][1], ax, ay, bx, by)
        if d > max_dist:
            max_dist = d
            max_idx = i

    if max_dist > epsilon:
        left = douglas_peucker(points[: max_idx + 1], epsilon)
        right = douglas_peucker(points[max_idx:], epsilon)
        return left[:-1] + right
    else:
        return [points[0], points[-1]]


def chaikin_smooth(
    points: list[tuple[float, float]], iterations: int = 2,
) -> list[tuple[float, float]]:
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


def _point_line_dist(
    px: float, py: float,
    ax: float, ay: float, bx: float, by: float,
) -> float:
    dx = bx - ax
    dy = by - ay
    len_sq = dx * dx + dy * dy
    if len_sq < 1e-10:
        return math.sqrt((px - ax) ** 2 + (py - ay) ** 2)
    return abs(dy * px - dx * py + bx * ay - by * ax) / math.sqrt(len_sq)


# ── Bridge Detection ─────────────────────────────────────────────────


def _detect_bridges(
    path: list[tuple[int, int]],
    water: list[list[bool]],
    size: int,
) -> list[tuple[int, int]]:
    """Find water crossings along a road path (bridge locations)."""
    bridges: list[tuple[int, int]] = []
    was_in_water = False
    entry_point: tuple[int, int] | None = None

    for x, y in path:
        in_water = (
            0 <= x < size and 0 <= y < size and water[y][x]
        )

        if in_water and not was_in_water:
            entry_point = (x, y)
        elif not in_water and was_in_water and entry_point is not None:
            mid_x = (entry_point[0] + x) // 2
            mid_y = (entry_point[1] + y) // 2
            bridges.append((mid_x, mid_y))
            entry_point = None

        was_in_water = in_water

    return bridges
