"""Mutable Point class with identity semantics.

CRITICAL: Do NOT override __eq__/__hash__. The entire codebase relies on
``==`` meaning "same object" (``is``).  Python's default object identity
is correct here.
"""

from __future__ import annotations

import math


class Point:
    __slots__ = ("x", "y")

    def __init__(self, x: float = 0.0, y: float = 0.0) -> None:
        self.x = x
        self.y = y

    # --- Immutable operations (return new Point) ---

    def clone(self) -> Point:
        return Point(self.x, self.y)

    def add(self, other: Point) -> Point:
        return Point(self.x + other.x, self.y + other.y)

    def subtract(self, other: Point) -> Point:
        return Point(self.x - other.x, self.y - other.y)

    def scale(self, f: float) -> Point:
        return Point(self.x * f, self.y * f)

    def rotate90(self) -> Point:
        return Point(-self.y, self.x)

    def norm(self, length: float = 1.0) -> Point:
        p = self.clone()
        p.normalize(length)
        return p

    # --- Mutating operations ---

    def set_to(self, x: float, y: float) -> None:
        self.x = x
        self.y = y

    def set_from(self, other: Point) -> None:
        self.x = other.x
        self.y = other.y

    def offset(self, dx: float, dy: float) -> None:
        self.x += dx
        self.y += dy

    def add_eq(self, other: Point) -> None:
        self.x += other.x
        self.y += other.y

    def sub_eq(self, other: Point) -> None:
        self.x -= other.x
        self.y -= other.y

    def scale_eq(self, f: float) -> None:
        self.x *= f
        self.y *= f

    def normalize(self, length: float = 1.0) -> None:
        d = self.length
        if d > 0:
            self.x = self.x / d * length
            self.y = self.y / d * length

    # --- Properties ---

    @property
    def length(self) -> float:
        return math.sqrt(self.x * self.x + self.y * self.y)

    def atan(self) -> float:
        return math.atan2(self.y, self.x)

    def dot(self, other: Point) -> float:
        return self.x * other.x + self.y * other.y

    @staticmethod
    def distance(a: Point, b: Point) -> float:
        dx = a.x - b.x
        dy = a.y - b.y
        return math.sqrt(dx * dx + dy * dy)

    def __repr__(self) -> str:
        return f"Point({self.x:.4f}, {self.y:.4f})"
