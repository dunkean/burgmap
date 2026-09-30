"""City site scoring, landmark detection, and satellite placement.

Evaluates terrain to find the best location for ONE main city,
detects terrain-driven landmark sites (castle hilltop, docks, mill),
and optionally places small satellite hamlets/villages around it.
"""

from __future__ import annotations

import math
import random as stdlib_random
from collections import deque


# Specialization mapping: dominant ground_cover/terrain → specialization
SPECIALIZATION_MAP = {
    "forest": "logging",
    "farmland": "agricultural",
    "scrub": "mining",
    "hill": "garrison",
}


def compute_score_map(
    size: int,
    elevation: list[list[float]],
    water: list[list[bool]],
    terrain: list[list[str]],
    ground_cover: list[list[str]],
    *,
    w_flat: float = 0.30,
    w_water: float = 0.25,
    w_resource: float = 0.25,
    w_defense: float = 0.10,
) -> list[list[float]]:
    """Compute site-attractiveness score for every land cell.

    Returns a size x size grid of floats in [0, 1].
    Water cells get score 0.
    """
    scores = [[0.0] * size for _ in range(size)]

    water_dist = _distance_to_water(water, size)
    resource_grid = _resource_abundance(ground_cover, size, radius=12)
    flat_grid = _flatness_grid(elevation, size)

    for y in range(size):
        for x in range(size):
            if water[y][x]:
                continue

            flatness = flat_grid[y][x]
            water_prox = _water_proximity_score(water_dist[y][x], max_dist=15)
            resource = resource_grid[y][x]
            defense = _defensibility(elevation, x, y, size)

            score = (
                w_flat * flatness
                + w_water * water_prox
                + w_resource * resource
                + w_defense * defense
            )
            # Remaining weight (w_road=0.10) left as potential bonus
            scores[y][x] = max(0.0, min(1.0, score))

    return scores


def find_city_site(
    size: int,
    score_map: list[list[float]],
    water: list[list[bool]],
) -> tuple[int, int, float]:
    """Find the best cell for the main city.

    Returns (x, y, score). Searches with a margin from map edges.
    """
    margin = max(3, size // 20)
    best_score = -1.0
    best_x, best_y = size // 2, size // 2

    for y in range(margin, size - margin):
        for x in range(margin, size - margin):
            if water[y][x]:
                continue
            if score_map[y][x] > best_score:
                best_score = score_map[y][x]
                best_x, best_y = x, y

    return best_x, best_y, best_score


def detect_landmarks(
    cx: int, cy: int, city_radius: int,
    size: int,
    elevation: list[list[float]],
    water: list[list[bool]],
    terrain: list[list[str]],
) -> list[dict]:
    """Detect terrain-driven landmark sites around the city center.

    Scans within city_radius to find:
    - Castle/Keep: highest elevation point
    - Docks: nearest water-adjacent land cell
    - Mill: land cell adjacent to river (flowing water)
    - Citadel: highest elevation on the city perimeter
    """
    landmarks: list[dict] = []

    # Search bounds (clamped to map)
    r = city_radius
    y0 = max(0, cy - r)
    y1 = min(size, cy + r + 1)
    x0 = max(0, cx - r)
    x1 = min(size, cx + r + 1)

    # Castle: highest elevation within city radius
    best_elev = -1.0
    castle_x, castle_y = cx, cy
    for y in range(y0, y1):
        for x in range(x0, x1):
            if water[y][x]:
                continue
            dist = math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
            if dist > r:
                continue
            if elevation[y][x] > best_elev:
                best_elev = elevation[y][x]
                castle_x, castle_y = x, y

    if best_elev > 0:
        landmarks.append({
            "type": "castle",
            "x": castle_x, "y": castle_y,
            "elevation": round(best_elev, 3),
            "rule": "highest elevation within city radius",
        })

    # Docks: nearest water-adjacent land cell to city center
    dock_x, dock_y = _find_nearest_waterfront(cx, cy, water, size, max_dist=r)
    if dock_x >= 0:
        landmarks.append({
            "type": "docks",
            "x": dock_x, "y": dock_y,
            "rule": "nearest waterfront to city center",
        })

    # Mill: land cell adjacent to river within radius
    mill_x, mill_y = _find_mill_site(cx, cy, r, water, elevation, size)
    if mill_x >= 0:
        landmarks.append({
            "type": "mill",
            "x": mill_x, "y": mill_y,
            "rule": "land adjacent to flowing water",
        })

    # Citadel: highest point on the perimeter ring
    perimeter_r_min = max(1, r - 3)
    best_peri_elev = -1.0
    cit_x, cit_y = cx, cy
    for y in range(y0, y1):
        for x in range(x0, x1):
            if water[y][x]:
                continue
            dist = math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
            if perimeter_r_min <= dist <= r:
                if elevation[y][x] > best_peri_elev:
                    best_peri_elev = elevation[y][x]
                    cit_x, cit_y = x, y

    # Only add citadel if it's different from castle
    if best_peri_elev > 0 and (cit_x != castle_x or cit_y != castle_y):
        landmarks.append({
            "type": "citadel",
            "x": cit_x, "y": cit_y,
            "elevation": round(best_peri_elev, 3),
            "rule": "highest elevation on city perimeter",
        })

    # Market: geometric center (the city center itself)
    landmarks.append({
        "type": "market",
        "x": cx, "y": cy,
        "rule": "city center",
    })

    return landmarks


def place_satellites(
    cx: int, cy: int, city_radius: int,
    size: int,
    score_map: list[list[float]],
    water: list[list[bool]],
    rng: stdlib_random.Random,
    n_satellites: int = 3,
    min_satellite_dist: int = 15,
    style: str = "generic",
) -> list[dict]:
    """Place small satellite settlements around the main city.

    Satellites are distributed across angular sectors around the city
    to ensure geographic diversity (not all clustered near the river).
    """
    satellites: list[dict] = []
    settled: list[tuple[int, int]] = [(cx, cy)]

    outer_r = city_radius * 3
    inner_r = city_radius + 5

    # Divide circle into sectors — one per satellite, shuffled
    sector_size = 2 * math.pi / max(1, n_satellites)
    # Random offset so sectors aren't always aligned the same way
    base_angle = rng.uniform(0, 2 * math.pi)
    sector_order = list(range(n_satellites))
    rng.shuffle(sector_order)

    for idx, sector_i in enumerate(sector_order):
        sector_lo = base_angle + sector_i * sector_size
        sector_hi = sector_lo + sector_size

        best_score = -1.0
        best_x, best_y = -1, -1

        for y in range(max(2, cy - outer_r), min(size - 2, cy + outer_r + 1)):
            for x in range(max(2, cx - outer_r), min(size - 2, cx + outer_r + 1)):
                if water[y][x]:
                    continue
                dx = x - cx
                dy = y - cy
                dist_center = math.sqrt(dx * dx + dy * dy)
                if dist_center < inner_r or dist_center > outer_r:
                    continue

                # Check angular sector
                angle = math.atan2(dy, dx) % (2 * math.pi)
                lo = sector_lo % (2 * math.pi)
                hi = sector_hi % (2 * math.pi)
                if lo < hi:
                    in_sector = lo <= angle < hi
                else:
                    in_sector = angle >= lo or angle < hi
                if not in_sector:
                    continue

                # Check min distance from other satellites
                too_close = False
                for sx, sy in settled:
                    if (sx, sy) == (cx, cy):
                        continue
                    if math.sqrt((x - sx) ** 2 + (y - sy) ** 2) < min_satellite_dist:
                        too_close = True
                        break
                if too_close:
                    continue

                s = score_map[y][x]
                if s > best_score:
                    best_score = s
                    best_x, best_y = x, y

        if best_x < 0:
            continue  # Skip this sector, try next

        settled.append((best_x, best_y))

        stype = "hamlet" if rng.random() < 0.6 else "village"
        n_buildings = rng.randint(3, 8) if stype == "hamlet" else rng.randint(10, 25)

        satellites.append({
            "id": f"sat{idx}",
            "x": best_x,
            "y": best_y,
            "type": stype,
            "size": n_buildings,
            "style": style,
            "score": round(best_score, 3),
        })

    return satellites


def determine_specialization(
    ground_cover: list[list[str]],
    terrain: list[list[str]],
    water: list[list[bool]],
    cx: int, cy: int, size: int, radius: int = 15,
) -> str:
    """Determine the city's economic specialization from surrounding terrain."""
    counts: dict[str, int] = {}
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            nx, ny = cx + dx, cy + dy
            if 0 <= nx < size and 0 <= ny < size:
                gc = ground_cover[ny][nx]
                if gc in SPECIALIZATION_MAP:
                    counts[gc] = counts.get(gc, 0) + 1
                t = terrain[ny][nx]
                if t == "hill":
                    counts["hill"] = counts.get("hill", 0) + 1

    # Check for water proximity → port/fishing
    water_count = 0
    for dy in range(-5, 6):
        for dx in range(-5, 6):
            nx, ny = cx + dx, cy + dy
            if 0 <= nx < size and 0 <= ny < size:
                if water[ny][nx]:
                    water_count += 1
    if water_count > 10:
        return "port"

    if not counts:
        return "trade"

    dominant = max(counts, key=counts.get)  # type: ignore[arg-type]
    return SPECIALIZATION_MAP.get(dominant, "trade")


# ── Helper functions ──────────────────────────────────────────────────


def _distance_to_water(water: list[list[bool]], size: int) -> list[list[int]]:
    """BFS distance from each land cell to nearest water cell."""
    dist = [[size * 2] * size for _ in range(size)]
    queue: deque[tuple[int, int]] = deque()

    for y in range(size):
        for x in range(size):
            if water[y][x]:
                dist[y][x] = 0
                queue.append((x, y))

    while queue:
        cx, cy = queue.popleft()
        for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            nx, ny = cx + dx, cy + dy
            if 0 <= nx < size and 0 <= ny < size:
                if dist[ny][nx] > dist[cy][cx] + 1:
                    dist[ny][nx] = dist[cy][cx] + 1
                    queue.append((nx, ny))

    return dist


def _water_proximity_score(dist: int, max_dist: int = 15) -> float:
    if dist >= max_dist:
        return 0.0
    return 1.0 - dist / max_dist


def _flatness_grid(elevation: list[list[float]], size: int) -> list[list[float]]:
    grid = [[1.0] * size for _ in range(size)]
    for y in range(size):
        for x in range(size):
            e = elevation[y][x]
            max_diff = 0.0
            for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                nx, ny = x + dx, y + dy
                if 0 <= nx < size and 0 <= ny < size:
                    diff = abs(elevation[ny][nx] - e)
                    if diff > max_diff:
                        max_diff = diff
            grid[y][x] = max(0.0, 1.0 - max_diff * 10)
    return grid


def _resource_abundance(
    ground_cover: list[list[str]], size: int, radius: int = 12,
) -> list[list[float]]:
    grid = [[0.0] * size for _ in range(size)]
    step = max(1, radius // 3)
    valuable = {"forest", "farmland", "scrub"}

    for y in range(size):
        for x in range(size):
            count = 0
            total = 0
            for dy in range(-radius, radius + 1, step):
                for dx in range(-radius, radius + 1, step):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < size and 0 <= ny < size:
                        total += 1
                        if ground_cover[ny][nx] in valuable:
                            count += 1
            grid[y][x] = count / max(1, total)

    return grid


def _defensibility(
    elevation: list[list[float]], x: int, y: int, size: int,
) -> float:
    e = elevation[y][x]
    radius = 5
    lower = 0
    total = 0
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dx == 0 and dy == 0:
                continue
            nx, ny = x + dx, y + dy
            if 0 <= nx < size and 0 <= ny < size:
                total += 1
                if elevation[ny][nx] < e:
                    lower += 1
    return lower / max(1, total)


def _find_nearest_waterfront(
    cx: int, cy: int,
    water: list[list[bool]], size: int,
    max_dist: int = 30,
) -> tuple[int, int]:
    """Find nearest land cell that is adjacent to water."""
    best_dist = max_dist + 1
    best_x, best_y = -1, -1

    for dy in range(-max_dist, max_dist + 1):
        for dx in range(-max_dist, max_dist + 1):
            nx, ny = cx + dx, cy + dy
            if not (0 <= nx < size and 0 <= ny < size):
                continue
            if water[ny][nx]:
                continue
            # Check if adjacent to water
            adj_water = False
            for ddx, ddy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                ax, ay = nx + ddx, ny + ddy
                if 0 <= ax < size and 0 <= ay < size and water[ay][ax]:
                    adj_water = True
                    break
            if not adj_water:
                continue
            dist = abs(dx) + abs(dy)
            if dist < best_dist:
                best_dist = dist
                best_x, best_y = nx, ny

    return best_x, best_y


def _find_mill_site(
    cx: int, cy: int, radius: int,
    water: list[list[bool]],
    elevation: list[list[float]],
    size: int,
) -> tuple[int, int]:
    """Find a good mill site: low-elevation land adjacent to water."""
    best_score = -1.0
    best_x, best_y = -1, -1

    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            nx, ny = cx + dx, cy + dy
            if not (0 <= nx < size and 0 <= ny < size):
                continue
            if water[ny][nx]:
                continue
            # Must be adjacent to water
            adj_water = False
            for ddx, ddy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                ax, ay = nx + ddx, ny + ddy
                if 0 <= ax < size and 0 <= ay < size and water[ay][ax]:
                    adj_water = True
                    break
            if not adj_water:
                continue
            # Prefer low elevation (water flows downhill)
            score = 1.0 - elevation[ny][nx]
            dist = math.sqrt(dx * dx + dy * dy)
            # Slight preference for closer to city
            score -= dist / (radius * 4)
            if score > best_score:
                best_score = score
                best_x, best_y = nx, ny

    return best_x, best_y
