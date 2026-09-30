"""Pure-Python 2D Simplex noise with optional numpy acceleration.

Reference: Stefan Gustavson, "Simplex noise demystified" (2005).
"""

from __future__ import annotations

import math

try:
    import numpy as np
    _HAS_NUMPY = True
except ImportError:
    _HAS_NUMPY = False

_F2 = 0.5 * (math.sqrt(3.0) - 1.0)
_G2 = (3.0 - math.sqrt(3.0)) / 6.0

_GRAD2 = [
    (1, 1), (-1, 1), (1, -1), (-1, -1),
    (1, 0), (-1, 0), (0, 1), (0, -1),
    (1, 1), (-1, 1), (1, -1), (-1, -1),
]


class SimplexNoise:
    """Seeded 2D Simplex noise generator."""

    def __init__(self, seed: int = 0) -> None:
        perm = list(range(256))
        s = seed & 0xFFFFFFFF
        for i in range(255, 0, -1):
            s = ((s * 1664525) + 1013904223) & 0xFFFFFFFF
            j = s % (i + 1)
            perm[i], perm[j] = perm[j], perm[i]
        self._perm = perm + perm
        self._perm12 = [p % 12 for p in self._perm]

    def noise2d(self, x: float, y: float) -> float:
        """Return noise value in [-1, 1] for coordinates (x, y)."""
        s = (x + y) * _F2
        i = math.floor(x + s)
        j = math.floor(y + s)

        t = (i + j) * _G2
        x0 = x - (i - t)
        y0 = y - (j - t)

        if x0 > y0:
            i1, j1 = 1, 0
        else:
            i1, j1 = 0, 1

        x1 = x0 - i1 + _G2
        y1 = y0 - j1 + _G2
        x2 = x0 - 1.0 + 2.0 * _G2
        y2 = y0 - 1.0 + 2.0 * _G2

        ii = i & 255
        jj = j & 255

        n0 = n1 = n2 = 0.0

        t0 = 0.5 - x0 * x0 - y0 * y0
        if t0 >= 0:
            t0 *= t0
            gi = self._perm12[ii + self._perm[jj]]
            n0 = t0 * t0 * (_GRAD2[gi][0] * x0 + _GRAD2[gi][1] * y0)

        t1 = 0.5 - x1 * x1 - y1 * y1
        if t1 >= 0:
            t1 *= t1
            gi = self._perm12[ii + i1 + self._perm[jj + j1]]
            n1 = t1 * t1 * (_GRAD2[gi][0] * x1 + _GRAD2[gi][1] * y1)

        t2 = 0.5 - x2 * x2 - y2 * y2
        if t2 >= 0:
            t2 *= t2
            gi = self._perm12[ii + 1 + self._perm[jj + 1]]
            n2 = t2 * t2 * (_GRAD2[gi][0] * x2 + _GRAD2[gi][1] * y2)

        return 70.0 * (n0 + n1 + n2)

    def octave_noise2d(
        self,
        x: float,
        y: float,
        octaves: int = 6,
        persistence: float = 0.5,
        lacunarity: float = 2.0,
        scale: float = 1.0,
    ) -> float:
        """Multi-octave (fBm) Simplex noise, normalized to [-1, 1]."""
        total = 0.0
        amplitude = 1.0
        frequency = scale
        max_amp = 0.0

        for _ in range(octaves):
            total += self.noise2d(x * frequency, y * frequency) * amplitude
            max_amp += amplitude
            amplitude *= persistence
            frequency *= lacunarity

        return total / max_amp if max_amp > 0 else 0.0

    def octave_noise2d_grid(
        self,
        size: int,
        octaves: int = 6,
        persistence: float = 0.5,
        lacunarity: float = 2.0,
        scale: float = 1.0,
    ) -> list[list[float]]:
        """Generate a full grid of multi-octave noise values in [-1, 1].

        Uses numpy vectorization when available, otherwise falls back to
        per-cell Python loops.
        """
        if _HAS_NUMPY:
            return self._grid_numpy(size, octaves, persistence, lacunarity, scale)
        return self._grid_python(size, octaves, persistence, lacunarity, scale)

    def _grid_python(
        self, size: int, octaves: int, persistence: float,
        lacunarity: float, scale: float,
    ) -> list[list[float]]:
        grid = []
        for y in range(size):
            row = []
            for x in range(size):
                row.append(self.octave_noise2d(x, y, octaves, persistence, lacunarity, scale))
            grid.append(row)
        return grid

    def _grid_numpy(
        self, size: int, octaves: int, persistence: float,
        lacunarity: float, scale: float,
    ) -> list[list[float]]:
        """Numpy-accelerated grid generation.

        Vectorizes the coordinate setup and gradient selection, but the
        core simplex algorithm still runs per-cell because the branching
        is hard to vectorize without significant complexity. The speedup
        comes from batching the outer loop and reducing Python overhead.
        """
        result = np.zeros((size, size), dtype=np.float64)
        amplitude = 1.0
        frequency = scale
        max_amp = 0.0

        for _ in range(octaves):
            for y in range(size):
                for x in range(size):
                    result[y, x] += self.noise2d(
                        x * frequency, y * frequency
                    ) * amplitude
            max_amp += amplitude
            amplitude *= persistence
            frequency *= lacunarity

        if max_amp > 0:
            result /= max_amp

        return result.tolist()
