"""City-scale elevation grid (~5km). Gentle rolling terrain."""

from __future__ import annotations

from town_generator.terrain.noise import SimplexNoise


class ElevationGenerator:

    def __init__(self, noise: SimplexNoise) -> None:
        self._noise = noise

    def generate(
        self,
        size: int,
        noise_scale: float = 1.0,
        octaves: int = 3,
        persistence: float = 0.5,
    ) -> list[list[float]]:
        """Return size x size elevation grid in [0.0, 1.0].

        Low-frequency noise for gentle city-scale terrain.
        """
        scale = noise_scale / size
        grid = self._noise.octave_noise2d_grid(size, octaves, persistence, 2.0, scale)

        # Normalize [-1,1] to gentle range [0.3, 0.7]
        for y in range(size):
            for x in range(size):
                v = grid[y][x] * 0.2 + 0.5
                grid[y][x] = max(0.0, min(1.0, v))

        return grid
