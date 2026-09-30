"""Polygon — the largest geometry class. Port of Polygon.hx.

Subclasses ``list`` so it IS an array of Points, matching Haxe's
``abstract Polygon(Array<Point>)``.
"""

from __future__ import annotations

import math
from typing import Callable

from town_generator.geom.point import Point
from town_generator.geom import geom_utils
from town_generator.utils.math_utils import sign


DELTA = 0.000001


class Polygon(list):

    def __init__(self, vertices: list[Point] | None = None) -> None:
        super().__init__(vertices[:] if vertices else [])

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def square(self) -> float:
        n = len(self)
        if n < 3:
            return 0.0
        v1 = self[-1]
        v2 = self[0]
        s = v1.x * v2.y - v2.x * v1.y
        for i in range(1, n):
            v1 = v2
            v2 = self[i]
            s += v1.x * v2.y - v2.x * v1.y
        return s * 0.5

    @property
    def perimeter(self) -> float:
        length = 0.0
        def _add(v0: Point, v1: Point) -> None:
            nonlocal length
            length += Point.distance(v0, v1)
        self.for_edge(_add)
        return length

    @property
    def compactness(self) -> float:
        p = self.perimeter
        return 4 * math.pi * self.square / (p * p)

    @property
    def center(self) -> Point:
        c = Point()
        for v in self:
            c.add_eq(v)
        c.scale_eq(1 / len(self))
        return c

    @property
    def centroid(self) -> Point:
        x = 0.0
        y = 0.0
        a = 0.0
        def _accum(v0: Point, v1: Point) -> None:
            nonlocal x, y, a
            f = geom_utils.cross(v0.x, v0.y, v1.x, v1.y)
            a += f
            x += (v0.x + v1.x) * f
            y += (v0.y + v1.y) * f
        self.for_edge(_accum)
        s6 = 1 / (3 * a)
        return Point(s6 * x, s6 * y)

    # ------------------------------------------------------------------
    # Iteration
    # ------------------------------------------------------------------

    def contains_point(self, v: Point) -> bool:
        """Identity-based membership (same object)."""
        return any(p is v for p in self)

    def index_of(self, v: Point) -> int:
        """Identity-based index lookup."""
        for i, p in enumerate(self):
            if p is v:
                return i
        return -1

    def last_index_of(self, v: Point) -> int:
        for i in range(len(self) - 1, -1, -1):
            if self[i] is v:
                return i
        return -1

    def for_edge(self, f: Callable[[Point, Point], None]) -> None:
        n = len(self)
        for i in range(n):
            f(self[i], self[(i + 1) % n])

    def for_segment(self, f: Callable[[Point, Point], None]) -> None:
        for i in range(len(self) - 1):
            f(self[i], self[i + 1])

    # ------------------------------------------------------------------
    # Geometry queries
    # ------------------------------------------------------------------

    def is_convex_vertex_i(self, i: int) -> bool:
        n = len(self)
        v0 = self[(i + n - 1) % n]
        v1 = self[i]
        v2 = self[(i + 1) % n]
        return geom_utils.cross(v1.x - v0.x, v1.y - v0.y, v2.x - v1.x, v2.y - v1.y) > 0

    def is_convex_vertex(self, v1: Point) -> bool:
        v0 = self.prev(v1)
        v2 = self.next(v1)
        return geom_utils.cross(v1.x - v0.x, v1.y - v0.y, v2.x - v1.x, v2.y - v1.y) > 0

    def is_convex(self) -> bool:
        for i in range(len(self)):
            if not self.is_convex_vertex_i(i):
                return False
        return True

    def distance(self, p: Point) -> float:
        """Min distance from any vertex to p."""
        v0 = self[0]
        d = Point.distance(v0, p)
        for i in range(1, len(self)):
            v1 = self[i]
            d1 = Point.distance(v1, p)
            if d1 < d:
                v0 = v1
                d = d1
        return d

    def find_edge(self, a: Point, b: Point) -> int:
        idx = self.index_of(a)
        if idx != -1 and self[(idx + 1) % len(self)] is b:
            return idx
        return -1

    def next(self, a: Point) -> Point:
        return self[(self.index_of(a) + 1) % len(self)]

    def prev(self, a: Point) -> Point:
        return self[(self.index_of(a) + len(self) - 1) % len(self)]

    def vector(self, v: Point) -> Point:
        return self.next(v).subtract(v)

    def vector_i(self, i: int) -> Point:
        return self[0 if i == len(self) - 1 else i + 1].subtract(self[i])

    def borders(self, another: Polygon) -> bool:
        len1 = len(self)
        len2 = len(another)
        for i in range(len1):
            j = another.index_of(self[i])
            if j != -1:
                nxt = self[(i + 1) % len1]
                if nxt is another[(j + 1) % len2] or nxt is another[(j + len2 - 1) % len2]:
                    return True
        return False

    def get_bounds(self) -> tuple[float, float, float, float]:
        """Returns (left, top, right, bottom)."""
        left = right = self[0].x
        top = bottom = self[0].y
        for v in self:
            if v.x < left:
                left = v.x
            if v.x > right:
                right = v.x
            if v.y < top:
                top = v.y
            if v.y > bottom:
                bottom = v.y
        return left, top, right, bottom

    # ------------------------------------------------------------------
    # Smoothing
    # ------------------------------------------------------------------

    def smooth_vertex_i(self, i: int, f: float = 1.0) -> Point:
        v = self[i]
        n = len(self)
        prv = self[(i + n - 1) % n]
        nxt = self[(i + 1) % n]
        return Point(
            (prv.x + v.x * f + nxt.x) / (2 + f),
            (prv.y + v.y * f + nxt.y) / (2 + f),
        )

    def smooth_vertex(self, v: Point, f: float = 1.0) -> Point:
        prv = self.prev(v)
        nxt = self.next(v)
        return Point(prv.x + v.x * f + nxt.x, prv.y + v.y * f + nxt.y).scale(1 / (2 + f))

    def smooth_vertex_eq(self, f: float = 1.0) -> Polygon:
        n = len(self)
        v1 = self[n - 1]
        v2 = self[0]
        result = []
        for i in range(n):
            v0 = v1
            v1 = v2
            v2 = self[(i + 1) % n]
            result.append(Point(
                (v0.x + v1.x * f + v2.x) / (2 + f),
                (v0.y + v1.y * f + v2.y) / (2 + f),
            ))
        return Polygon(result)

    def filter_short(self, threshold: float) -> Polygon:
        i = 1
        v0 = self[0]
        result = [v0]
        while i < len(self):
            v1 = self[i]
            i += 1
            while Point.distance(v0, v1) < threshold and i < len(self):
                v1 = self[i]
                i += 1
            result.append(v1)
            v0 = v1
        return Polygon(result)

    # ------------------------------------------------------------------
    # Transforms
    # ------------------------------------------------------------------

    def offset(self, p: Point) -> None:
        dx, dy = p.x, p.y
        for v in self:
            v.offset(dx, dy)

    def rotate(self, a: float) -> None:
        cos_a = math.cos(a)
        sin_a = math.sin(a)
        for v in self:
            vx = v.x * cos_a - v.y * sin_a
            vy = v.y * cos_a + v.x * sin_a
            v.set_to(vx, vy)

    def set_from(self, p: Polygon) -> None:
        for i in range(len(p)):
            self[i].set_from(p[i])

    # ------------------------------------------------------------------
    # Inset / buffer / shrink
    # ------------------------------------------------------------------

    def inset(self, p1: Point, d: float) -> None:
        i1 = self.index_of(p1)
        i0 = i1 - 1 if i1 > 0 else len(self) - 1
        p0 = self[i0]
        i2 = i1 + 1 if i1 < len(self) - 1 else 0
        p2 = self[i2]
        i3 = i2 + 1 if i2 < len(self) - 1 else 0
        p3 = self[i3]

        v0 = p1.subtract(p0)
        v1 = p2.subtract(p1)
        v2 = p3.subtract(p2)

        cos_val = v0.dot(v1) / v0.length / v1.length
        z = v0.x * v1.y - v0.y * v1.x
        sin_sq = 1 - cos_val * cos_val
        t = d / math.sqrt(max(sin_sq, 1e-20))
        if z > 0:
            t = min(t, v0.length * 0.99)
        else:
            t = min(t, v1.length * 0.5)
        t *= sign(z)
        self[i1] = p1.subtract(v0.norm(t))

        cos_val = v1.dot(v2) / v1.length / v2.length
        z = v1.x * v2.y - v1.y * v2.x
        sin_sq = 1 - cos_val * cos_val
        t = d / math.sqrt(max(sin_sq, 1e-20))
        if z > 0:
            t = min(t, v2.length * 0.99)
        else:
            t = min(t, v1.length * 0.5)
        self[i2] = p2.add(v2.norm(t))

    def inset_all(self, d: list[float]) -> Polygon:
        p = Polygon(self)
        for i in range(len(p)):
            if d[i] != 0:
                p.inset(p[i], d[i])
        return p

    def inset_eq(self, d: float) -> None:
        for i in range(len(self)):
            self.inset(self[i], d)

    def buffer(self, d: list[float]) -> Polygon:
        q = Polygon()
        i_counter = [0]

        def _offset_edge(v0: Point, v1: Point) -> None:
            dd = d[i_counter[0]]
            i_counter[0] += 1
            if dd == 0:
                q.append(v0)
                q.append(v1)
            else:
                v = v1.subtract(v0)
                n = v.rotate90().norm(dd)
                q.append(v0.add(n))
                q.append(v1.add(n))

        self.for_edge(_offset_edge)

        was_cut = True
        last_edge = 0
        while was_cut:
            was_cut = False
            n = len(q)
            for i in range(last_edge, n - 2):
                last_edge = i
                p11 = q[i]
                p12 = q[i + 1]
                x1, y1 = p11.x, p11.y
                dx1, dy1 = p12.x - x1, p12.y - y1

                end_j = n if i > 0 else n - 1
                for j in range(i + 2, end_j):
                    p21 = q[j]
                    p22 = q[j + 1] if j < n - 1 else q[0]
                    x2, y2 = p21.x, p21.y
                    dx2, dy2 = p22.x - x2, p22.y - y2

                    intr = geom_utils.intersect_lines(x1, y1, dx1, dy1, x2, y2, dx2, dy2)
                    if intr is not None and intr.x > DELTA and intr.x < 1 - DELTA and intr.y > DELTA and intr.y < 1 - DELTA:
                        pn = Point(x1 + dx1 * intr.x, y1 + dy1 * intr.x)
                        q.insert(j + 1, pn)
                        q.insert(i + 1, pn)
                        was_cut = True
                        break
                if was_cut:
                    break

        regular = list(range(len(q)))
        best_part = None
        best_part_sq = float("-inf")

        while len(regular) > 0:
            indices: list[int] = []
            start = regular[0]
            i = start
            while True:
                indices.append(i)
                if i in regular:
                    regular.remove(i)

                nxt = (i + 1) % len(q)
                v = q[nxt]
                next1 = q.index_of(v)
                if next1 == nxt:
                    next1 = q.last_index_of(v)
                i = nxt if next1 == -1 else next1
                if i == start:
                    break

            p = Polygon([q[idx] for idx in indices])
            s = p.square
            if s > best_part_sq:
                best_part = p
                best_part_sq = s

        return best_part

    def buffer_eq(self, d: float) -> Polygon:
        return self.buffer([d for _ in self])

    def shrink(self, d: list[float]) -> Polygon:
        q = Polygon(self)
        i_counter = [0]

        def _shrink_edge(v1: Point, v2: Point) -> None:
            dd = d[i_counter[0]]
            i_counter[0] += 1
            nonlocal q
            if dd > 0:
                v = v2.subtract(v1)
                n = v.rotate90().norm(dd)
                q = q.cut(v1.add(n), v2.add(n), 0)[0]

        self.for_edge(_shrink_edge)
        return q

    def shrink_eq(self, d: float) -> Polygon:
        return self.shrink([d for _ in self])

    def peel(self, v1: Point, d: float) -> Polygon:
        i1 = self.index_of(v1)
        i2 = 0 if i1 == len(self) - 1 else i1 + 1
        v2 = self[i2]
        v = v2.subtract(v1)
        n = v.rotate90().norm(d)
        return self.cut(v1.add(n), v2.add(n), 0)[0]

    # ------------------------------------------------------------------
    # Splitting / cutting
    # ------------------------------------------------------------------

    def split(self, p1: Point, p2: Point) -> list[Polygon]:
        return self.split_i(self.index_of(p1), self.index_of(p2))

    def split_i(self, i1: int, i2: int) -> list[Polygon]:
        if i1 > i2:
            i1, i2 = i2, i1
        return [
            Polygon(self[i1:i2 + 1]),
            Polygon(self[i2:] + self[:i1 + 1]),
        ]

    def cut(self, p1: Point, p2: Point, gap: float = 0.0) -> list[Polygon]:
        x1, y1 = p1.x, p1.y
        dx1, dy1 = p2.x - x1, p2.y - y1

        n = len(self)
        edge1 = 0
        ratio1 = 0.0
        edge2 = 0
        ratio2 = 0.0
        count = 0

        for i in range(n):
            v0 = self[i]
            v1 = self[(i + 1) % n]

            x2, y2 = v0.x, v0.y
            dx2, dy2 = v1.x - x2, v1.y - y2

            t = geom_utils.intersect_lines(x1, y1, dx1, dy1, x2, y2, dx2, dy2)
            if t is not None and t.y >= 0 and t.y <= 1:
                if count == 0:
                    edge1 = i
                    ratio1 = t.x
                elif count == 1:
                    edge2 = i
                    ratio2 = t.x
                count += 1

        if count == 2:
            d = p2.subtract(p1)
            point1 = p1.add(d.scale(ratio1))
            point2 = p1.add(d.scale(ratio2))

            half1 = Polygon(self[edge1 + 1:edge2 + 1])
            half1.insert(0, point1)
            half1.append(point2)

            half2 = Polygon(self[edge2 + 1:] + self[:edge1 + 1])
            half2.insert(0, point2)
            half2.append(point1)

            if gap > 0:
                half1 = half1.peel(point2, gap / 2)
                half2 = half2.peel(point1, gap / 2)

            v = self.vector_i(edge1)
            if geom_utils.cross(dx1, dy1, v.x, v.y) > 0:
                return [half1, half2]
            else:
                return [half2, half1]
        else:
            return [Polygon(self)]

    # ------------------------------------------------------------------
    # Simplification
    # ------------------------------------------------------------------

    def simplify(self, n: int) -> None:
        length = len(self)
        while length > n:
            result = 0
            min_val = float("inf")

            b = self[length - 1]
            c = self[0]
            for i in range(length):
                a = b
                b = c
                c = self[(i + 1) % length]
                measure = abs(a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
                if measure < min_val:
                    result = i
                    min_val = measure

            del self[result]
            length -= 1

    # ------------------------------------------------------------------
    # Interpolation
    # ------------------------------------------------------------------

    def interpolate(self, p: Point) -> list[float]:
        total = 0.0
        dd = []
        for v in self:
            d = 1 / Point.distance(v, p)
            total += d
            dd.append(d)
        return [d / total for d in dd]

    # ------------------------------------------------------------------
    # Static constructors
    # ------------------------------------------------------------------

    @staticmethod
    def rect(w: float = 1.0, h: float = 1.0) -> Polygon:
        return Polygon([
            Point(-w / 2, -h / 2),
            Point(w / 2, -h / 2),
            Point(w / 2, h / 2),
            Point(-w / 2, h / 2),
        ])

    @staticmethod
    def regular(n: int = 8, r: float = 1.0) -> Polygon:
        return Polygon([
            Point(r * math.cos(i / n * math.pi * 2), r * math.sin(i / n * math.pi * 2))
            for i in range(n)
        ])

    @staticmethod
    def circle(r: float = 1.0) -> Polygon:
        return Polygon.regular(16, r)
