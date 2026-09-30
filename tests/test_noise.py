"""Test Simplex noise determinism and value range."""

from town_generator.terrain.noise import SimplexNoise


def test_noise_determinism():
    """Same seed produces identical noise values."""
    n1 = SimplexNoise(42)
    n2 = SimplexNoise(42)
    for x in range(20):
        for y in range(20):
            assert n1.noise2d(x * 0.1, y * 0.1) == n2.noise2d(x * 0.1, y * 0.1)


def test_noise_range():
    """Noise values are in [-1, 1]."""
    n = SimplexNoise(123)
    for x in range(100):
        for y in range(100):
            v = n.noise2d(x * 0.05, y * 0.05)
            assert -1.0 <= v <= 1.0, f"noise2d({x*0.05}, {y*0.05}) = {v}"


def test_octave_noise_range():
    """Multi-octave noise is normalized to [-1, 1]."""
    n = SimplexNoise(99)
    for x in range(50):
        for y in range(50):
            v = n.octave_noise2d(x * 0.1, y * 0.1, octaves=6)
            assert -1.0 <= v <= 1.0, f"octave_noise2d = {v}"


def test_different_seeds_differ():
    """Different seeds produce different outputs."""
    n1 = SimplexNoise(1)
    n2 = SimplexNoise(2)
    values1 = [n1.noise2d(i * 0.1, 0) for i in range(10)]
    values2 = [n2.noise2d(i * 0.1, 0) for i in range(10)]
    assert values1 != values2


def test_grid_matches_individual():
    """Grid generation matches individual noise2d calls."""
    n = SimplexNoise(42)
    grid = n.octave_noise2d_grid(32, octaves=4, persistence=0.5, lacunarity=2.0, scale=0.05)

    n2 = SimplexNoise(42)
    for y in range(32):
        for x in range(32):
            expected = n2.octave_noise2d(x, y, octaves=4, persistence=0.5, lacunarity=2.0, scale=0.05)
            assert abs(grid[y][x] - expected) < 1e-10, f"Mismatch at ({x},{y})"


def test_noise_not_all_zero():
    """Noise produces non-trivial variation."""
    n = SimplexNoise(42)
    values = set()
    for x in range(20):
        for y in range(20):
            values.add(round(n.noise2d(x * 0.3, y * 0.3), 6))
    assert len(values) > 10, "Noise should produce varied values"
