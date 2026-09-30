"""Populator registry — maps (district_type, style) to populator instances.

Also provides a flat lookup by populator name for the standalone UI.
"""

from __future__ import annotations

from town_generator.district.base import BasePopulator
from town_generator.district.organic_alley import OrganicAlleyPopulator
from town_generator.district.grid import GridPopulator
from town_generator.district.courtyard import CourtyardPopulator
from town_generator.district.disk_packing import DiskPackingPopulator
from town_generator.district.bazaar import BazaarPopulator
from town_generator.district.monastic import MonasticPopulator
from town_generator.district.farm_plot import FarmPlotPopulator
from town_generator.district.military import MilitaryPopulator
from town_generator.district.palace import PalacePopulator


# All available populators by name
POPULATORS: dict[str, BasePopulator] = {
    "organic_alley": OrganicAlleyPopulator(),
    "grid": GridPopulator(),
    "courtyard": CourtyardPopulator(),
    "disk_packing": DiskPackingPopulator(),
    "bazaar": BazaarPopulator(),
    "monastic": MonasticPopulator(),
    "farm_plot": FarmPlotPopulator(),
    "military": MilitaryPopulator(),
    "palace": PalacePopulator(),
}


# Mapping: (district_type, cultural_style) → populator name
# Falls back to district_type alone, then to "organic_alley"
_STYLE_MAP: dict[tuple[str, str], str] = {
    # Roman
    ("craftsmen", "roman"): "grid",
    ("merchant", "roman"): "grid",
    ("patriciate", "roman"): "grid",
    ("residential", "roman"): "grid",
    ("military", "roman"): "military",
    ("cathedral", "roman"): "monastic",
    # Arabic / Islamic
    ("craftsmen", "arabic_islamic"): "organic_alley",
    ("merchant", "arabic_islamic"): "bazaar",
    ("market", "arabic_islamic"): "bazaar",
    ("patriciate", "arabic_islamic"): "courtyard",
    ("cathedral", "arabic_islamic"): "monastic",
    # East Asian
    ("craftsmen", "east_asian"): "grid",
    ("merchant", "east_asian"): "grid",
    ("patriciate", "east_asian"): "courtyard",
    ("cathedral", "east_asian"): "monastic",
    # Norse
    ("craftsmen", "norse"): "organic_alley",
    ("merchant", "norse"): "organic_alley",
    # Mongol
    ("craftsmen", "mongol"): "disk_packing",
    ("merchant", "mongol"): "disk_packing",
    ("residential", "mongol"): "disk_packing",
}

# Fallback by district type alone (any style)
_TYPE_MAP: dict[str, str] = {
    "craftsmen": "organic_alley",
    "merchant": "organic_alley",
    "patriciate": "organic_alley",
    "residential": "organic_alley",
    "slum": "organic_alley",
    "gate": "organic_alley",
    "shanty_town": "organic_alley",
    "market": "bazaar",
    "cathedral": "monastic",
    "castle": "palace",
    "military": "military",
    "administration": "organic_alley",
    "park": "farm_plot",
    "farm": "farm_plot",
}


def get_populator(
    district_type: str = "craftsmen",
    style: str = "generic",
) -> BasePopulator:
    """Look up the best populator for a district type + cultural style.

    Args:
        district_type: Ward/district type name (e.g. "craftsmen", "market").
        style: Cultural style id (e.g. "roman", "arabic_islamic").

    Returns:
        A populator instance ready to call .populate().
    """
    # Try (type, style) specific mapping
    key = (district_type, style)
    name = _STYLE_MAP.get(key)
    if name and name in POPULATORS:
        return POPULATORS[name]

    # Fallback to type-only mapping
    name = _TYPE_MAP.get(district_type)
    if name and name in POPULATORS:
        return POPULATORS[name]

    # Default
    return POPULATORS["organic_alley"]
