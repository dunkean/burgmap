"""Base populator class and shared data structures for M4 district population."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon


@dataclass
class PopulatorParams:
    """Parameters controlling building generation within a district."""
    min_area: float = 20.0          # minimum building footprint area
    grid_chaos: float = 0.4         # alignment disorder 0..1
    size_chaos: float = 0.4         # size variance 0..1
    empty_prob: float = 0.04        # probability of empty lot
    density: float = 0.6            # 0=sparse, 1=dense
    alley_width: float = 0.8        # gap between buildings
    seed: int = 42                  # PRNG seed


@dataclass
class BuildingFootprint:
    """A single building output from a populator."""
    footprint: Polygon
    building_type: str = "house"
    sub_type: str = ""
    stories: int = 1
    style_hints: dict[str, Any] = field(default_factory=dict)


@dataclass
class PopulatorResult:
    """Complete output from a populator run."""
    buildings: list[BuildingFootprint] = field(default_factory=list)
    alleys: list[list[Point]] = field(default_factory=list)

    def to_dict(self) -> dict:
        """Serialize for JSON API response."""
        buildings = []
        for i, b in enumerate(self.buildings):
            buildings.append({
                "id": f"b{i}",
                "footprint": [[round(v.x, 2), round(v.y, 2)] for v in b.footprint],
                "type": b.building_type,
                "sub_type": b.sub_type,
                "stories": b.stories,
                "style_hints": b.style_hints,
            })
        alleys = []
        for a in self.alleys:
            alleys.append({
                "points": [[round(v.x, 2), round(v.y, 2)] for v in a],
            })
        return {"buildings": buildings, "alleys": alleys}


class BasePopulator:
    """Interface for district population algorithms.

    Subclasses implement populate() which takes a polygon + params and returns
    building footprints. No Model/Patch dependency — works standalone.
    """

    name: str = "base"
    description: str = "Base populator (no buildings)"

    def populate(self, polygon: Polygon, params: PopulatorParams) -> PopulatorResult:
        """Subdivide *polygon* into building footprints.

        Args:
            polygon: The district boundary polygon (already inset from streets).
            params: Generation parameters.

        Returns:
            PopulatorResult with buildings and alleys.
        """
        return PopulatorResult()
