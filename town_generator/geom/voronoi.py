"""Incremental Delaunay triangulation + Voronoi regions. Port of Voronoi.hx."""

from __future__ import annotations

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.utils.math_utils import sign


class Triangle:
    __slots__ = ("p1", "p2", "p3", "c", "r")

    def __init__(self, p1: Point, p2: Point, p3: Point) -> None:
        s = ((p2.x - p1.x) * (p2.y + p1.y)
             + (p3.x - p2.x) * (p3.y + p2.y)
             + (p1.x - p3.x) * (p1.y + p3.y))
        self.p1 = p1
        self.p2 = p2 if s > 0 else p3
        self.p3 = p3 if s > 0 else p2

        x1 = (p1.x + p2.x) / 2
        y1_m = (p1.y + p2.y) / 2
        x2 = (p2.x + p3.x) / 2
        y2_m = (p2.y + p3.y) / 2

        dx1 = p1.y - p2.y
        dy1 = p2.x - p1.x
        dx2 = p2.y - p3.y
        dy2 = p3.x - p2.x

        tg1 = dy1 / dx1 if dx1 != 0 else float("inf")
        denom = dy2 - dx2 * tg1
        if denom == 0:
            t2 = 0.0
        else:
            t2 = ((y1_m - y2_m) - (x1 - x2) * tg1) / denom

        self.c = Point(x2 + dx2 * t2, y2_m + dy2 * t2)
        self.r = Point.distance(self.c, p1)

    def has_edge(self, a: Point, b: Point) -> bool:
        return (
            (self.p1 is a and self.p2 is b)
            or (self.p2 is a and self.p3 is b)
            or (self.p3 is a and self.p1 is b)
        )


class Region:
    __slots__ = ("seed", "vertices")

    def __init__(self, seed: Point) -> None:
        self.seed = seed
        self.vertices: list[Triangle] = []

    def sort_vertices(self) -> Region:
        self.vertices.sort(key=lambda v: 0, reverse=False)
        self.vertices.sort(key=_make_angle_key(self.seed))
        return self

    def center(self) -> Point:
        c = Point()
        for v in self.vertices:
            c.add_eq(v.c)
        c.scale_eq(1 / len(self.vertices))
        return c

    def borders(self, r: Region) -> bool:
        len1 = len(self.vertices)
        len2 = len(r.vertices)
        for i in range(len1):
            try:
                j = r.vertices.index(self.vertices[i])
            except ValueError:
                continue
            if self.vertices[(i + 1) % len1] is r.vertices[(j + len2 - 1) % len2]:
                return True
        return False


def _make_angle_key(seed: Point):
    """Replicates the Haxe compareAngles sort."""
    def key(v: Triangle) -> tuple[int, float]:
        x = v.c.x - seed.x
        y = v.c.y - seed.y
        # Partition into right half (x >= 0) = group 1, left half = group 0
        if x >= 0 and x == 0 and y == 0:
            return (0, 0.0)
        if x >= 0:
            group = 1
        else:
            group = 0
        # Within group, sort by cross product (ascending in original means descending angle)
        return (group, -(x * 0 - 0 * y))  # placeholder — use full sort below
    return _angle_cmp_key(seed)


def _angle_cmp_key(seed: Point):
    """Faithful port of the Haxe compareAngles using functools."""
    import functools

    def cmp(v1: Triangle, v2: Triangle) -> int:
        x1 = v1.c.x - seed.x
        y1 = v1.c.y - seed.y
        x2 = v2.c.x - seed.x
        y2 = v2.c.y - seed.y

        if x1 >= 0 and x2 < 0:
            return 1
        if x2 >= 0 and x1 < 0:
            return -1
        if x1 == 0 and x2 == 0:
            return 1 if y2 > y1 else -1
        return sign(x2 * y1 - x1 * y2)

    return functools.cmp_to_key(cmp)


class Voronoi:
    def __init__(self, minx: float, miny: float, maxx: float, maxy: float) -> None:
        self.triangles: list[Triangle] = []

        c1 = Point(minx, miny)
        c2 = Point(minx, maxy)
        c3 = Point(maxx, miny)
        c4 = Point(maxx, maxy)
        self.frame = [c1, c2, c3, c4]
        self.points = [c1, c2, c3, c4]
        self.triangles.append(Triangle(c1, c2, c3))
        self.triangles.append(Triangle(c2, c3, c4))

        self._regions: dict[int, Region] = {}
        for p in self.points:
            self._regions[id(p)] = self._build_region(p)
        self._regions_dirty = False

    def add_point(self, p: Point) -> None:
        to_split: list[Triangle] = []
        for tr in self.triangles:
            if Point.distance(p, tr.c) < tr.r:
                to_split.append(tr)

        if len(to_split) > 0:
            self.points.append(p)

            a: list[Point] = []
            b: list[Point] = []
            for t1 in to_split:
                e1, e2, e3 = True, True, True
                for t2 in to_split:
                    if t2 is not t1:
                        if e1 and t2.has_edge(t1.p2, t1.p1):
                            e1 = False
                        if e2 and t2.has_edge(t1.p3, t1.p2):
                            e2 = False
                        if e3 and t2.has_edge(t1.p1, t1.p3):
                            e3 = False
                        if not (e1 or e2 or e3):
                            break
                if e1:
                    a.append(t1.p1)
                    b.append(t1.p2)
                if e2:
                    a.append(t1.p2)
                    b.append(t1.p3)
                if e3:
                    a.append(t1.p3)
                    b.append(t1.p1)

            index = 0
            while True:
                self.triangles.append(Triangle(p, a[index], b[index]))
                # Find next index: where does b[index] appear in a?
                target = b[index]
                found = -1
                for k, v in enumerate(a):
                    if v is target:
                        found = k
                        break
                index = found
                if index == 0:
                    break

            for tr in to_split:
                self.triangles.remove(tr)

            self._regions_dirty = True

    def _build_region(self, p: Point) -> Region:
        r = Region(p)
        for tr in self.triangles:
            if tr.p1 is p or tr.p2 is p or tr.p3 is p:
                r.vertices.append(tr)
        return r.sort_vertices()

    @property
    def regions(self) -> dict[int, Region]:
        if self._regions_dirty:
            self._regions = {}
            self._regions_dirty = False
            for p in self.points:
                self._regions[id(p)] = self._build_region(p)
        return self._regions

    def _is_real(self, tr: Triangle) -> bool:
        frame = self.frame
        return not (
            any(tr.p1 is f for f in frame)
            or any(tr.p2 is f for f in frame)
            or any(tr.p3 is f for f in frame)
        )

    def triangulation(self) -> list[Triangle]:
        return [tr for tr in self.triangles if self._is_real(tr)]

    def partitioning(self) -> list[Region]:
        result: list[Region] = []
        for p in self.points:
            r = self.regions[id(p)]
            is_real = True
            for v in r.vertices:
                if not self._is_real(v):
                    is_real = False
                    break
            if is_real:
                result.append(r)
        return result

    def get_neighbours(self, r1: Region) -> list[Region]:
        return [r2 for r2 in self.regions.values() if r1.borders(r2)]

    @staticmethod
    def relax(voronoi: Voronoi, to_relax: list[Point] | None = None) -> Voronoi:
        regions = voronoi.partitioning()

        points = voronoi.points[:]
        for p in voronoi.frame:
            if p in points:
                points.remove(p)

        if to_relax is None:
            to_relax = voronoi.points
        for r in regions:
            if any(r.seed is p for p in to_relax):
                if r.seed in points:
                    points.remove(r.seed)
                points.append(r.center())

        return Voronoi.build(points)

    @staticmethod
    def build(vertices: list[Point]) -> Voronoi:
        minx = miny = 1e10
        maxx = maxy = -1e9
        for v in vertices:
            if v.x < minx:
                minx = v.x
            if v.y < miny:
                miny = v.y
            if v.x > maxx:
                maxx = v.x
            if v.y > maxy:
                maxy = v.y
        dx = (maxx - minx) * 0.5
        dy = (maxy - miny) * 0.5

        voronoi = Voronoi(minx - dx / 2, miny - dy / 2, maxx + dx / 2, maxy + dy / 2)
        for v in vertices:
            voronoi.add_point(v)
        return voronoi
