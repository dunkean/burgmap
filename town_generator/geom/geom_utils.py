"""Low-level geometry helpers — direct port of GeomUtils.hx."""

from __future__ import annotations

import math

from town_generator.geom.point import Point


def intersect_lines(
    x1: float, y1: float, dx1: float, dy1: float,
    x2: float, y2: float, dx2: float, dy2: float,
) -> Point | None:
    d = dx1 * dy2 - dy1 * dx2
    if d == 0:
        return None
    t2 = (dy1 * (x2 - x1) - dx1 * (y2 - y1)) / d
    t1 = ((x2 - x1 + dx2 * t2) / dx1) if dx1 != 0 else ((y2 - y1 + dy2 * t2) / dy1)
    return Point(t1, t2)


def interpolate(p1: Point, p2: Point, ratio: float = 0.5) -> Point:
    dx = p2.x - p1.x
    dy = p2.y - p1.y
    return Point(p1.x + dx * ratio, p1.y + dy * ratio)


def scalar(x1: float, y1: float, x2: float, y2: float) -> float:
    return x1 * x2 + y1 * y2


def cross(x1: float, y1: float, x2: float, y2: float) -> float:
    return x1 * y2 - y1 * x2


def distance2line(
    x1: float, y1: float, dx1: float, dy1: float, x0: float, y0: float,
) -> float:
    return (dx1 * y0 - dy1 * x0 + (y1 + dy1) * x1 - (x1 + dx1) * y1) / math.sqrt(
        dx1 * dx1 + dy1 * dy1
    )
