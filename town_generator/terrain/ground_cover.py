"""Ground cover patches at city scale — forest, swamp, farmland, meadow.

Small patches of different vegetation/land use scattered across the
city-scale terrain, driven by noise + elevation + water proximity.
"""

from __future__ import annotations

from town_generator.terrain.noise import SimplexNoise


COVER_TYPES = ["meadow", "forest", "swamp", "farmland", "scrub"]


class GroundCoverGenerator:

    def __init__(self, noise: SimplexNoise) -> None:
        self._noise = noise

    def generate(
        self,
        size: int,
        elevation: list[list[float]],
        water: list[list[bool]],
        terrain: list[list[str]],
    ) -> list[list[str]]:
        """Return size x size grid of ground cover types.

        Only assigned to land cells. Water cells get "water".
        """
        scale = 3.0 / size
        grid = [["meadow"] * size for _ in range(size)]

        for y in range(size):
            for x in range(size):
                if water[y][x]:
                    grid[y][x] = "water"
                    continue

                if terrain[y][x] == "wetland":
                    grid[y][x] = "swamp"
                    continue

                # Use noise to create patches of different cover
                n1 = self._noise.noise2d(x * scale, y * scale)
                n2 = self._noise.noise2d(x * scale + 100, y * scale + 100)
                elev = elevation[y][x]

                if n1 > 0.3 and elev < 0.55:
                    grid[y][x] = "farmland"
                elif n1 < -0.2 and elev > 0.3:
                    grid[y][x] = "forest"
                elif n2 > 0.4 and elev > 0.5:
                    grid[y][x] = "scrub"
                else:
                    grid[y][x] = "meadow"

        return grid
