"""Cultural style definitions for M3 city-level structure.

Each style defines ward distribution, street pattern, wall type,
landmark preferences, and rendering hints.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class WardWeights:
    """Relative frequency weights for ward types within a style."""
    craftsmen: float = 1.0
    merchant: float = 0.4
    patriciate: float = 0.3
    slum: float = 0.4
    administration: float = 0.2
    military: float = 0.1
    park: float = 0.3
    cathedral: float = 0.1
    market: float = 0.2


@dataclass
class LandmarkPrefs:
    """Placement preferences for landmarks within a style."""
    castle: bool = True
    cathedral: bool = True
    market: bool = True
    docks: bool = True       # only if river/coast
    citadel: bool = True
    plaza: bool = True
    mill: bool = True        # only if river
    baths: bool = False
    granary: bool = False
    arsenal: bool = False

    # Labels use culturally appropriate names
    cathedral_label: str = "Cathedral"
    market_label: str = "Market"
    castle_label: str = "Castle"
    citadel_label: str = "Citadel"


@dataclass
class CulturalStyle:
    """Complete cultural style definition for city generation."""

    id: str
    name: str
    description: str

    # Street pattern
    street_pattern: str = "organic"   # organic, labyrinthine, grid, radial, cluster, open

    # Wall type
    wall_type: str = "stone"          # stone, packed_earth, palisade, none

    # Ward distribution weights
    ward_weights: WardWeights = field(default_factory=WardWeights)

    # Landmark preferences
    landmarks: LandmarkPrefs = field(default_factory=LandmarkPrefs)

    # Building generation hints
    building_density_bias: float = 0.0   # -1 sparse .. +1 dense, added to user setting
    grid_chaos_bias: float = 0.0         # -0.3 orderly .. +0.3 chaotic
    min_sq_factor: float = 1.0           # multiplier on ward min_sq

    # Rendering hints (extended palette)
    palette_overrides: dict[str, int] = field(default_factory=dict)


# --- Style definitions ---

EUROPEAN_MEDIEVAL = CulturalStyle(
    id="european_medieval",
    name="European Medieval",
    description="Radial from center, irregular blocks, stone walls",
    street_pattern="organic",
    wall_type="stone",
    ward_weights=WardWeights(
        craftsmen=1.0, merchant=0.4, patriciate=0.3, slum=0.4,
        administration=0.2, military=0.1, park=0.3, cathedral=0.15, market=0.2,
    ),
    landmarks=LandmarkPrefs(
        castle=True, cathedral=True, market=True, citadel=True, plaza=True,
        cathedral_label="Cathedral", market_label="Market Square",
        castle_label="Castle", citadel_label="Citadel",
    ),
)

ARABIC_ISLAMIC = CulturalStyle(
    id="arabic_islamic",
    name="Arabic / Islamic",
    description="Nested irregular courts, few through-roads, packed earth walls",
    street_pattern="labyrinthine",
    wall_type="packed_earth",
    ward_weights=WardWeights(
        craftsmen=0.8, merchant=0.6, patriciate=0.4, slum=0.3,
        administration=0.2, military=0.15, park=0.1, cathedral=0.15, market=0.3,
    ),
    landmarks=LandmarkPrefs(
        castle=True, cathedral=True, market=True, citadel=True, plaza=True,
        baths=True,
        cathedral_label="Mosque", market_label="Souk",
        castle_label="Qasr", citadel_label="Alcazaba",
    ),
    grid_chaos_bias=0.15,
    building_density_bias=0.2,
)

EAST_ASIAN = CulturalStyle(
    id="east_asian",
    name="East Asian",
    description="Regular grid, cardinal axes, stone or rammed earth walls",
    street_pattern="grid",
    wall_type="stone",
    ward_weights=WardWeights(
        craftsmen=0.8, merchant=0.5, patriciate=0.4, slum=0.2,
        administration=0.3, military=0.2, park=0.4, cathedral=0.1, market=0.3,
    ),
    landmarks=LandmarkPrefs(
        castle=True, cathedral=True, market=True, citadel=True, plaza=True,
        cathedral_label="Pagoda", market_label="Market",
        castle_label="Palace", citadel_label="Inner City",
    ),
    grid_chaos_bias=-0.2,
    min_sq_factor=1.2,
)

ROMAN = CulturalStyle(
    id="roman",
    name="Roman",
    description="Strict cardo/decumanus grid with forum",
    street_pattern="grid",
    wall_type="stone",
    ward_weights=WardWeights(
        craftsmen=0.7, merchant=0.5, patriciate=0.4, slum=0.3,
        administration=0.3, military=0.3, park=0.2, cathedral=0.1, market=0.2,
    ),
    landmarks=LandmarkPrefs(
        castle=False, cathedral=True, market=True, citadel=True, plaza=True,
        baths=True, arsenal=True,
        cathedral_label="Temple", market_label="Forum",
        castle_label="Praetorium", citadel_label="Arx",
    ),
    grid_chaos_bias=-0.3,
    min_sq_factor=1.3,
)

NORSE = CulturalStyle(
    id="norse",
    name="Norse",
    description="Organic harbor-centric clusters, wooden palisade",
    street_pattern="cluster",
    wall_type="palisade",
    ward_weights=WardWeights(
        craftsmen=1.0, merchant=0.5, patriciate=0.2, slum=0.2,
        administration=0.1, military=0.2, park=0.1, cathedral=0.1, market=0.3,
    ),
    landmarks=LandmarkPrefs(
        castle=True, cathedral=True, market=True, citadel=False, plaza=True,
        cathedral_label="Stave Church", market_label="Thing Place",
        castle_label="Jarl's Hall", citadel_label="Hillfort",
    ),
    grid_chaos_bias=0.1,
    building_density_bias=-0.1,
)

MONGOL = CulturalStyle(
    id="mongol",
    name="Mongol",
    description="Open space between ger clusters, packed earth walls or none",
    street_pattern="open",
    wall_type="packed_earth",
    ward_weights=WardWeights(
        craftsmen=0.5, merchant=0.6, patriciate=0.2, slum=0.1,
        administration=0.2, military=0.3, park=0.5, cathedral=0.1, market=0.4,
    ),
    landmarks=LandmarkPrefs(
        castle=True, cathedral=True, market=True, citadel=False, plaza=True,
        cathedral_label="Temple", market_label="Market",
        castle_label="Khan's Palace", citadel_label="Fortress",
    ),
    grid_chaos_bias=0.2,
    building_density_bias=-0.3,
    min_sq_factor=0.8,
)

GENERIC = CulturalStyle(
    id="generic",
    name="Generic",
    description="Current TownGeneratorOS default — organic layout",
    street_pattern="organic",
    wall_type="stone",
)


STYLES: dict[str, CulturalStyle] = {
    "generic": GENERIC,
    "european_medieval": EUROPEAN_MEDIEVAL,
    "arabic_islamic": ARABIC_ISLAMIC,
    "east_asian": EAST_ASIAN,
    "roman": ROMAN,
    "norse": NORSE,
    "mongol": MONGOL,
}


def get_style(style_id: str) -> CulturalStyle:
    """Get a style by ID, defaulting to generic."""
    return STYLES.get(style_id, GENERIC)
