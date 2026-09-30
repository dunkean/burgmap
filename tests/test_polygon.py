"""Test polygon operations."""

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon


def test_square_rect():
    p = Polygon.rect(10, 10)
    # Area of 10x10 should be 100 (or -100 depending on winding)
    assert abs(abs(p.square) - 100) < 0.01


def test_center():
    p = Polygon.rect(4, 4)
    c = p.center
    assert abs(c.x) < 0.01
    assert abs(c.y) < 0.01


def test_cut():
    p = Polygon.rect(10, 10)
    halves = p.cut(Point(0, -10), Point(0, 10))
    assert len(halves) == 2
    total = abs(halves[0].square) + abs(halves[1].square)
    assert abs(total - 100) < 1


def test_shrink():
    p = Polygon.rect(10, 10)
    s = p.shrink_eq(1)
    # Should be roughly 8x8 = 64
    assert 50 < abs(s.square) < 80


def test_identity_semantics():
    a = Point(1, 2)
    b = Point(1, 2)
    p = Polygon([a, b, Point(3, 4)])
    assert p.index_of(a) == 0
    assert p.index_of(b) == 1
    assert p.contains_point(a)
    assert not p.contains_point(Point(1, 2))  # different object
