"""Simple start/end line segment."""

from __future__ import annotations

from town_generator.geom.point import Point


class Segment:
    __slots__ = ("start", "end")

    def __init__(self, start: Point, end: Point) -> None:
        self.start = start
        self.end = end

    @property
    def dx(self) -> float:
        return self.end.x - self.start.x

    @property
    def dy(self) -> float:
        return self.end.y - self.start.y

    @property
    def vector(self) -> Point:
        return self.end.subtract(self.start)

    @property
    def length(self) -> float:
        return Point.distance(self.start, self.end)
