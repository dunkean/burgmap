"""Elevation generation with quantization into discrete contour levels.

Produces both a continuous raw elevation grid (for flow/slope calculations)
and a quantized grid (for display as distinct plateaus with contour lines).

Supports 4 terrain types:
- mountainous: steep ridges, high amplitude, lots of detail
- hilly: gentle rolling hills, moderate amplitude
- normal: mixed terrain with plateaus and valleys (default)
- flat: quasi-flat with very gentle undulations
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from town_generator.terrain.noise import SimplexNoise
from town_generator.terrain_v2.scales import MapScale


# Terrain type parameters:
# (elev_factor, base_octaves, base_persist, detail_octaves,
#  detail_persist, detail_blend, amplitude_damping)
_TERRAIN_PARAMS = {
    "mountainous": {
        "elev_factor": 1.8,       # much higher peaks
        "base_octaves": 4,        # more large features
        "base_persist": 0.55,     # each octave stronger
        "detail_octaves": 6,      # lots of fine detail
        "detail_persist": 0.55,
        "detail_blend": 0.4,      # 40% detail
        "freq_mult": 0.8,         # slightly lower freq → bigger features
    },
    "hilly": {
        "elev_factor": 1.0,
        "base_octaves": 3,
        "base_persist": 0.45,
        "detail_octaves": 4,
        "detail_persist": 0.45,
        "detail_blend": 0.25,
        "freq_mult": 1.0,
    },
    "normal": {
        "elev_factor": 0.7,
        "base_octaves": 3,
        "base_persist": 0.40,
        "detail_octaves": 5,
        "detail_persist": 0.5,
        "detail_blend": 0.3,
        "freq_mult": 1.0,
    },
    "flat": {
        "elev_factor": 0.12,
        "base_octaves": 1,
        "base_persist": 0.5,
        "detail_octaves": 0,
        "detail_persist": 0.0,
        "detail_blend": 0.0,
        "freq_mult": 0.5,
    },
}


@dataclass
class ReliefData:
    raw: list[list[float]] = field(default_factory=list)
    quantized: list[list[float]] = field(default_factory=list)
    max_m: float = 0.0
    contour_interval_m: float = 0.0
    n_levels: int = 0


def generate_relief(
    noise: SimplexNoise,
    scale: MapScale,
    terrain_type: str = "normal",
    coast: bool = False,
    coast_direction: int = 2,
) -> ReliefData:
    """Generate elevation grids (raw continuous + quantized stepped).

    All values in meters. Grid coordinates are [y][x].
    """
    size = scale.grid_size
    interval = scale.contour_interval_m

    params = _TERRAIN_PARAMS.get(terrain_type, _TERRAIN_PARAMS["normal"])
    max_elev = scale.max_elevation_m * params["elev_factor"]

    # -- 1. Raw noise --
    raw = _generate_noise(noise, size, scale.extent_m, params)

    # -- 2. Edge falloff (terrain drops near borders) --
    _apply_edge_falloff(raw, size)

    # -- 3. Coast gradient (terrain slopes toward coast) --
    if coast:
        _apply_coast_gradient(raw, size, coast_direction)

    # -- 4. Normalize to [0, max_elev] --
    _normalize(raw, size, max_elev)

    # -- 5. Quantize --
    quantized = _quantize(raw, size, interval)

    n_levels = max(1, int(math.ceil(max_elev / interval)))

    return ReliefData(
        raw=raw,
        quantized=quantized,
        max_m=max_elev,
        contour_interval_m=interval,
        n_levels=n_levels,
    )


def _generate_noise(
    noise: SimplexNoise,
    size: int,
    extent_m: float,
    params: dict,
) -> list[list[float]]:
    """Generate raw noise grid in [-1, 1] range.

    Noise frequency is based on physical extent so that terrain features
    have consistent real-world size across all map scales.
    """
    base_freq = extent_m / 500.0
    freq_per_cell = base_freq / size * params["freq_mult"]

    # Base terrain (large landforms)
    base_scale = freq_per_cell * 1.0
    base = noise.octave_noise2d_grid(
        size,
        octaves=params["base_octaves"],
        persistence=params["base_persist"],
        lacunarity=2.0,
        scale=base_scale,
    )

    detail_blend = params["detail_blend"]
    if detail_blend <= 0 or params["detail_octaves"] <= 0:
        return base

    # Medium-frequency detail (smaller hills, texture)
    detail_noise = SimplexNoise(noise._perm[0] + 7777)
    detail_scale = freq_per_cell * 2.5
    detail = detail_noise.octave_noise2d_grid(
        size,
        octaves=params["detail_octaves"],
        persistence=params["detail_persist"],
        lacunarity=2.0,
        scale=detail_scale,
    )

    # Blend
    base_w = 1.0 - detail_blend
    grid = []
    for y in range(size):
        row = []
        for x in range(size):
            row.append(
                base[y][x] * base_w + detail[y][x] * detail_blend,
            )
        grid.append(row)

    return grid


def _apply_edge_falloff(
    grid: list[list[float]], size: int,
) -> None:
    """Multiply by radial cosine-squared falloff at edges."""
    cx = size / 2.0
    cy = size / 2.0
    max_r = size / 2.0 * 0.9

    for y in range(size):
        for x in range(size):
            dx = (x - cx) / max_r
            dy = (y - cy) / max_r
            r = math.sqrt(dx * dx + dy * dy)
            if r > 1.0:
                grid[y][x] *= max(0.0, 1.0 - (r - 1.0) * 3.0)
            elif r > 0.7:
                t = (r - 0.7) / 0.3
                falloff = math.cos(t * math.pi / 2) ** 2
                grid[y][x] *= 0.3 + 0.7 * falloff


def _apply_coast_gradient(
    grid: list[list[float]],
    size: int,
    coast_direction: int,
) -> None:
    """Lower terrain toward the coast edge."""
    for y in range(size):
        for x in range(size):
            if coast_direction == 0:    # North
                t = 1.0 - y / (size - 1)
            elif coast_direction == 1:  # East
                t = x / (size - 1)
            elif coast_direction == 2:  # South
                t = y / (size - 1)
            else:                       # West
                t = 1.0 - x / (size - 1)

            factor = 1.0 - 0.7 * t
            grid[y][x] *= factor


def _normalize(
    grid: list[list[float]],
    size: int,
    max_elev: float,
) -> None:
    """Normalize grid to [0, max_elev] meters in-place."""
    lo = float("inf")
    hi = float("-inf")
    for y in range(size):
        for x in range(size):
            v = grid[y][x]
            if v < lo:
                lo = v
            if v > hi:
                hi = v

    span = hi - lo if hi > lo else 1.0
    for y in range(size):
        for x in range(size):
            grid[y][x] = ((grid[y][x] - lo) / span) * max_elev


def _quantize(
    raw: list[list[float]],
    size: int,
    interval: float,
) -> list[list[float]]:
    """Quantize elevation into discrete levels.

    Pre-smooths with a 3x3 box filter (2 passes) for cleaner plateaus.
    """
    smoothed = [row[:] for row in raw]

    for _ in range(2):
        prev = [row[:] for row in smoothed]
        for y in range(1, size - 1):
            for x in range(1, size - 1):
                total = 0.0
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        total += prev[y + dy][x + dx]
                smoothed[y][x] = total / 9.0

    result = []
    for y in range(size):
        row = []
        for x in range(size):
            v = smoothed[y][x]
            row.append(round(v / interval) * interval)
        result.append(row)

    return result
