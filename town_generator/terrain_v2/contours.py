"""Marching squares contour extraction from elevation grids.

Extracts iso-lines as vector polylines for each contour level.
"""

from __future__ import annotations

from dataclasses import dataclass

from town_generator.terrain.hydrology import chaikin_smooth


@dataclass
class ContourLine:
    level_m: float
    points: list[tuple[float, float]]
    is_closed: bool


# Marching squares edge lookup table.
# For each of the 16 cases, lists pairs of (edge_a, edge_b) where the
# contour crosses. Edges: 0=top, 1=right, 2=bottom, 3=left.
_EDGE_TABLE: list[list[tuple[int, int]]] = [
    [],                 # 0:  ....
    [(3, 2)],           # 1:  ...X
    [(2, 1)],           # 2:  ..X.
    [(3, 1)],           # 3:  ..XX
    [(1, 0)],           # 4:  .X..
    [(3, 0), (1, 2)],   # 5:  .X.X  (ambiguous — saddle)
    [(2, 0)],           # 6:  .XX.
    [(3, 0)],           # 7:  .XXX
    [(0, 3)],           # 8:  X...
    [(0, 2)],           # 9:  X..X
    [(0, 1), (2, 3)],   # 10: X.X.  (ambiguous — saddle)
    [(0, 1)],           # 11: X.XX
    [(1, 3)],           # 12: XX..
    [(1, 2)],           # 13: XX.X
    [(2, 3)],           # 14: XXX.
    [],                 # 15: XXXX
]


def _edge_midpoint(
    x: int, y: int, edge: int,
    grid: list[list[float]], level: float, size: int,
) -> tuple[float, float]:
    """Interpolate the contour crossing point on a cell edge."""
    if edge == 0:  # top: (x,y) to (x+1,y)
        v0, v1 = grid[y][x], grid[y][min(x + 1, size - 1)]
    elif edge == 1:  # right: (x+1,y) to (x+1,y+1)
        v0, v1 = grid[y][min(x + 1, size - 1)], grid[min(y + 1, size - 1)][min(x + 1, size - 1)]
    elif edge == 2:  # bottom: (x,y+1) to (x+1,y+1)
        v0, v1 = grid[min(y + 1, size - 1)][x], grid[min(y + 1, size - 1)][min(x + 1, size - 1)]
    else:  # left: (x,y) to (x,y+1)
        v0, v1 = grid[y][x], grid[min(y + 1, size - 1)][x]

    denom = v1 - v0
    t = (level - v0) / denom if abs(denom) > 1e-10 else 0.5

    t = max(0.0, min(1.0, t))

    if edge == 0:
        return (x + t, float(y))
    elif edge == 1:
        return (float(x + 1), y + t)
    elif edge == 2:
        return (x + t, float(y + 1))
    else:
        return (float(x), y + t)


def extract_contours(
    grid: list[list[float]],
    size: int,
    min_level: float,
    max_level: float,
    interval: float,
    smooth_iterations: int = 1,
) -> list[ContourLine]:
    """Extract contour polylines from an elevation grid via marching squares.

    Returns contour lines for each level from min_level to max_level
    (exclusive of 0 and max to avoid edge artifacts).
    """
    contours: list[ContourLine] = []
    level = min_level
    while level <= max_level:
        segments = _march_level(grid, size, level)
        polylines = _assemble_polylines(segments)
        for pts, closed in polylines:
            if len(pts) >= 3:
                if smooth_iterations > 0:
                    pts = chaikin_smooth(pts, iterations=smooth_iterations)
                contours.append(ContourLine(
                    level_m=round(level, 2),
                    points=pts,
                    is_closed=closed,
                ))
        level += interval

    return contours


def _march_level(
    grid: list[list[float]], size: int, level: float,
) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    """Run marching squares for a single contour level.

    Returns a list of line segments (p1, p2).
    """
    segments: list[tuple[tuple[float, float], tuple[float, float]]] = []

    for y in range(size - 1):
        for x in range(size - 1):
            # Classify corners: TL=bit3, TR=bit2, BR=bit1, BL=bit0
            tl = 1 if grid[y][x] >= level else 0
            tr = 1 if grid[y][min(x + 1, size - 1)] >= level else 0
            br = 1 if grid[min(y + 1, size - 1)][min(x + 1, size - 1)] >= level else 0
            bl = 1 if grid[min(y + 1, size - 1)][x] >= level else 0

            case = (tl << 3) | (tr << 2) | (br << 1) | bl

            # Disambiguate saddle cases using center value
            if case == 5 or case == 10:
                center = (grid[y][x] + grid[y][x + 1] +
                          grid[y + 1][x] + grid[y + 1][x + 1]) / 4.0
                if case == 5 and center >= level:
                    case = 5  # keep as-is (connects NW-SE)
                elif case == 5:
                    # Swap to connect NE-SW
                    edges = [(3, 0), (1, 2)]  # same as default case 5
                    # Actually flip: connect differently
                    edges = [(3, 2), (1, 0)]
                    for ea, eb in edges:
                        p1 = _edge_midpoint(x, y, ea, grid, level, size)
                        p2 = _edge_midpoint(x, y, eb, grid, level, size)
                        segments.append((p1, p2))
                    continue
                elif case == 10 and center >= level:
                    case = 10
                elif case == 10:
                    edges = [(0, 3), (2, 1)]
                    for ea, eb in edges:
                        p1 = _edge_midpoint(x, y, ea, grid, level, size)
                        p2 = _edge_midpoint(x, y, eb, grid, level, size)
                        segments.append((p1, p2))
                    continue

            edges = _EDGE_TABLE[case]
            for ea, eb in edges:
                p1 = _edge_midpoint(x, y, ea, grid, level, size)
                p2 = _edge_midpoint(x, y, eb, grid, level, size)
                segments.append((p1, p2))

    return segments


def _assemble_polylines(
    segments: list[tuple[tuple[float, float], tuple[float, float]]],
) -> list[tuple[list[tuple[float, float]], bool]]:
    """Chain segments into continuous polylines.

    Returns list of (points, is_closed) tuples.
    """
    if not segments:
        return []

    # Build adjacency by snapping endpoints to a grid
    # (round to 4 decimal places to handle float imprecision)
    def _key(p: tuple[float, float]) -> tuple[int, int]:
        return (round(p[0] * 10000), round(p[1] * 10000))

    # Index segments by their endpoints
    endpoint_map: dict[tuple[int, int], list[int]] = {}
    for i, (p1, p2) in enumerate(segments):
        k1, k2 = _key(p1), _key(p2)
        endpoint_map.setdefault(k1, []).append(i)
        endpoint_map.setdefault(k2, []).append(i)

    used = [False] * len(segments)
    results: list[tuple[list[tuple[float, float]], bool]] = []

    for start_idx in range(len(segments)):
        if used[start_idx]:
            continue
        used[start_idx] = True

        chain: list[tuple[float, float]] = [segments[start_idx][0], segments[start_idx][1]]

        # Extend forward from chain[-1]
        _extend_chain(chain, segments, endpoint_map, used, _key, forward=True)
        # Extend backward from chain[0]
        _extend_chain(chain, segments, endpoint_map, used, _key, forward=False)

        # Check if closed
        is_closed = (_key(chain[0]) == _key(chain[-1])) and len(chain) > 3

        results.append((chain, is_closed))

    return results


def _extend_chain(
    chain: list[tuple[float, float]],
    segments: list[tuple[tuple[float, float], tuple[float, float]]],
    endpoint_map: dict[tuple[int, int], list[int]],
    used: list[bool],
    key_fn,
    forward: bool,
) -> None:
    """Extend a chain of points by following connected segments."""
    max_iter = len(segments)
    for _ in range(max_iter):
        tip = chain[-1] if forward else chain[0]
        tip_key = key_fn(tip)

        candidates = endpoint_map.get(tip_key, [])
        found = False
        for idx in candidates:
            if used[idx]:
                continue
            p1, p2 = segments[idx]
            k1, k2 = key_fn(p1), key_fn(p2)

            if k1 == tip_key:
                next_pt = p2
            elif k2 == tip_key:
                next_pt = p1
            else:
                continue

            used[idx] = True
            if forward:
                chain.append(next_pt)
            else:
                chain.insert(0, next_pt)
            found = True
            break

        if not found:
            break
