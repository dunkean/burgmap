"""Test Voronoi construction."""

from town_generator.geom.point import Point
from town_generator.geom.voronoi import Voronoi


def test_build_simple():
    points = [Point(0, 0), Point(10, 0), Point(5, 10)]
    v = Voronoi.build(points)
    assert len(v.points) > 3  # frame + our 3 points


def test_partitioning():
    points = [Point(i * 10, j * 10) for i in range(3) for j in range(3)]
    v = Voronoi.build(points)
    regions = v.partitioning()
    # At least the central point should produce a region
    assert len(regions) > 0


def test_relax():
    points = [Point(0, 0), Point(10, 0), Point(5, 10), Point(5, -10)]
    v = Voronoi.build(points)
    v2 = Voronoi.relax(v)
    assert len(v2.points) >= len(points)
