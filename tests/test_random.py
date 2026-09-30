"""Verify PRNG produces correct Park-Miller sequences."""

from town_generator.utils.random import Random


def test_park_miller_sequence():
    Random.reset(1)
    # Park-Miller with g=48271, n=2^31-1, seed=1
    # next(1) = 48271
    # next(48271) = 48271*48271 % 2147483647 = 182605794
    v1 = Random._next()
    assert v1 == 48271
    v2 = Random._next()
    assert v2 == (48271 * 48271) % 2147483647


def test_float_range():
    Random.reset(42)
    for _ in range(100):
        v = Random.float()
        assert 0.0 <= v < 1.0


def test_determinism():
    Random.reset(12345)
    seq1 = [Random.float() for _ in range(50)]
    Random.reset(12345)
    seq2 = [Random.float() for _ in range(50)]
    assert seq1 == seq2


def test_bool():
    Random.reset(99)
    results = [Random.bool(0.5) for _ in range(100)]
    assert any(results) and not all(results)
