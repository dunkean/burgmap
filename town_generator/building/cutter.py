"""Polygon cutting strategies. Port of Cutter.hx."""

from __future__ import annotations

import math
import functools

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.geom import geom_utils


def bisect(
    poly: Polygon,
    vertex: Point,
    ratio: float = 0.5,
    angle: float = 0.0,
    gap: float = 0.0,
) -> list[Polygon]:
    nxt = poly.next(vertex)
    p1 = geom_utils.interpolate(vertex, nxt, ratio)
    d = nxt.subtract(vertex)

    cos_b = math.cos(angle)
    sin_b = math.sin(angle)
    vx = d.x * cos_b - d.y * sin_b
    vy = d.y * cos_b + d.x * sin_b
    p2 = Point(p1.x - vy, p1.y + vx)

    return poly.cut(p1, p2, gap)


def radial(
    poly: Polygon,
    center: Point | None = None,
    gap: float = 0.0,
) -> list[Polygon]:
    if center is None:
        center = poly.centroid

    sectors: list[Polygon] = []

    def _make_sector(v0: Point, v1: Point) -> None:
        sector = Polygon([center, v0, v1])
        if gap > 0:
            sector = sector.shrink([gap / 2, 0, gap / 2])
        sectors.append(sector)

    poly.for_edge(_make_sector)
    return sectors


def semi_radial(
    poly: Polygon,
    center: Point | None = None,
    gap: float = 0.0,
) -> list[Polygon]:
    if center is None:
        centroid = poly.centroid
        center = min(poly, key=lambda v: Point.distance(v, centroid))

    half_gap = gap / 2
    sectors: list[Polygon] = []

    def _make_sector(v0: Point, v1: Point) -> None:
        if v0 is not center and v1 is not center:
            sector = Polygon([center, v0, v1])
            if half_gap > 0:
                d = [
                    half_gap if poly.find_edge(center, v0) == -1 else 0,
                    0,
                    half_gap if poly.find_edge(v1, center) == -1 else 0,
                ]
                sector = sector.shrink(d)
            sectors.append(sector)

    poly.for_edge(_make_sector)
    return sectors


def ring(poly: Polygon, thickness: float) -> list[Polygon]:
    slices: list[dict] = []

    def _collect(v1: Point, v2: Point) -> None:
        v = v2.subtract(v1)
        n = v.rotate90().norm(thickness)
        slices.append({"p1": v1.add(n), "p2": v2.add(n), "len": v.length})

    poly.for_edge(_collect)

    slices.sort(key=lambda s: s["len"])

    peel: list[Polygon] = []
    p = poly
    for s in slices:
        halves = p.cut(s["p1"], s["p2"])
        p = halves[0]
        if len(halves) == 2:
            peel.append(halves[1])

    return [p for p in peel if len(p) >= 4]
