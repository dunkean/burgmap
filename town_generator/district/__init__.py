"""M4 — District Population module.

Populator algorithms that subdivide district polygons into building footprints.
Each populator works standalone (no Model dependency) for independent testing.
"""

from town_generator.district.base import BasePopulator, PopulatorParams, PopulatorResult
from town_generator.district.registry import get_populator, POPULATORS

__all__ = [
    "BasePopulator",
    "PopulatorParams",
    "PopulatorResult",
    "get_populator",
    "POPULATORS",
]
