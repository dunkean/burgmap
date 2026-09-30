"""Catmull-Rom spline curves. Port of Spline.hx."""

from __future__ import annotations

from town_generator.geom.point import Point


CURVATURE = 0.1


def start_curve(p0: Point, p1: Point, p2: Point) -> list[Point]:
    tangent = p2.subtract(p0)
    control = p1.subtract(tangent.scale(CURVATURE))
    return [control, p1]


def end_curve(p0: Point, p1: Point, p2: Point) -> list[Point]:
    tangent = p2.subtract(p0)
    control = p1.add(tangent.scale(CURVATURE))
    return [control, p2]


def mid_curve(p0: Point, p1: Point, p2: Point, p3: Point) -> list[Point]:
    tangent1 = p2.subtract(p0)
    tangent2 = p3.subtract(p1)

    p1a = p1.add(tangent1.scale(CURVATURE))
    p2a = p2.subtract(tangent2.scale(CURVATURE))
    p12 = p1a.add(p2a).scale(0.5)

    return [p1a, p12, p2a, p2]
