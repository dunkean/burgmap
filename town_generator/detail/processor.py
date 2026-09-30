"""Building detail processor — M5 orchestrator.

Takes building footprints (from M4 or CityMap JSON) and adds roof geometry
and facade details. Can process a single building, a district, or an
entire city.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.detail.roof import (
    RoofGeometry, generate_roof, ROOF_GENERATORS, STYLE_ROOF_DEFAULTS,
)
from town_generator.detail.facade import (
    FacadeDetail, generate_facade_details,
    DENSITY_NONE, DENSITY_SPARSE, DENSITY_RICH,
)
from town_generator.detail.compound import CompoundShape, Wing, COMPOUND_SHAPES


@dataclass
class DetailParams:
    """Parameters for M5 building detail generation."""
    roof_type: str | None = None     # None = auto from style/building type
    overhang: float | None = None    # None = use generator default
    facade_density: int = DENSITY_SPARSE  # 0=none, 1=sparse, 2=rich
    style: str = "generic"


@dataclass
class BuildingDetail:
    """Complete M5 output for one building."""
    building_id: str
    footprint: list[list[float]]
    building_type: str
    stories: int
    roof: RoofGeometry | None = None
    facade_details: list[FacadeDetail] = field(default_factory=list)

    def to_dict(self) -> dict:
        d: dict[str, Any] = {
            "id": self.building_id,
            "footprint": self.footprint,
            "type": self.building_type,
            "stories": self.stories,
        }
        if self.roof is not None:
            d["roof"] = self.roof.to_dict()
        if self.facade_details:
            d["facade_details"] = [fd.to_dict() for fd in self.facade_details]
        return d


def process_building(
    footprint: Polygon,
    building_id: str = "b0",
    building_type: str = "house",
    stories: int = 1,
    style_hints: dict[str, Any] | None = None,
    params: DetailParams | None = None,
    alley_centers: list[list[float]] | None = None,
) -> BuildingDetail:
    """Add roof + facade details to a single building footprint.

    This is the main entry point for standalone / per-building processing.
    """
    if params is None:
        params = DetailParams()

    fp_coords = [[round(p.x, 2), round(p.y, 2)] for p in footprint]

    # Generate roof
    roof = generate_roof(
        footprint,
        roof_type=params.roof_type,
        building_type=building_type,
        style=params.style,
        overhang=params.overhang,
    )

    # Extract ridge center for chimney placement
    ridge_center = None
    if roof.ridge_polygon and len(roof.ridge_polygon) > 0:
        rxs = [p[0] for p in roof.ridge_polygon if len(p) == 2]
        rys = [p[1] for p in roof.ridge_polygon if len(p) == 2]
        if rxs and rys:
            ridge_center = [sum(rxs) / len(rxs), sum(rys) / len(rys)]

    # Generate facade details
    facade = generate_facade_details(
        footprint,
        building_type=building_type,
        style=params.style,
        density=params.facade_density,
        stories=stories,
        alley_centers=alley_centers,
        ridge_center=ridge_center,
    )

    return BuildingDetail(
        building_id=building_id,
        footprint=fp_coords,
        building_type=building_type,
        stories=stories,
        roof=roof,
        facade_details=facade,
    )


def process_buildings(
    buildings: list[dict],
    params: DetailParams | None = None,
    alley_centers: list[list[float]] | None = None,
) -> list[BuildingDetail]:
    """Process a list of building dicts (as from M4/CityMap JSON).

    Each building dict should have: id, footprint ([[x,y],...]), type, stories.
    """
    if params is None:
        params = DetailParams()

    results = []
    for bldg in buildings:
        fp_raw = bldg.get("footprint", [])
        if len(fp_raw) < 3:
            continue
        fp = Polygon([Point(p[0], p[1]) for p in fp_raw])
        result = process_building(
            footprint=fp,
            building_id=bldg.get("id", f"b{len(results)}"),
            building_type=bldg.get("type", "house"),
            stories=bldg.get("stories", 1),
            style_hints=bldg.get("style_hints"),
            params=params,
            alley_centers=alley_centers,
        )
        results.append(result)
    return results


def process_city_map(city_map: dict, params: DetailParams | None = None) -> dict:
    """Add M5 detail to a full CityMap JSON dict.

    Modifies the city_map in place, adding roof and facade_details to each
    building in each district. Returns the modified dict.
    """
    if params is None:
        params = DetailParams()

    for district in city_map.get("districts", []):
        buildings = district.get("buildings")
        if not buildings:
            continue

        # Use alleys as facade orientation hints
        alleys = district.get("alleys", [])
        alley_centers = []
        for a in alleys:
            pts = a.get("points", [])
            if pts:
                cx = sum(p[0] for p in pts) / len(pts)
                cy = sum(p[1] for p in pts) / len(pts)
                alley_centers.append([cx, cy])

        detailed = process_buildings(buildings, params, alley_centers)
        # Update buildings in place with roof/facade data
        for bldg_dict, detail in zip(buildings, detailed):
            d = detail.to_dict()
            if "roof" in d:
                bldg_dict["roof"] = d["roof"]
            if "facade_details" in d:
                bldg_dict["facade_details"] = d["facade_details"]

    return city_map


@dataclass
class HeightGroup:
    """A group of wings at the same story height — gets one merged roof."""
    stories: int
    outline: list[list[float]]
    roof: RoofGeometry | None = None
    wing_indices: list[int] = field(default_factory=list)

    def to_dict(self) -> dict:
        d: dict[str, Any] = {
            "stories": self.stories,
            "outline": self.outline,
        }
        if self.roof is not None:
            d["roof"] = self.roof.to_dict()
        return d


@dataclass
class CompoundBuildingDetail:
    """Complete M5 output for a compound (multi-wing) building."""
    building_id: str
    shape_type: str
    outline: list[list[float]]
    wings: list[BuildingDetail]
    height_groups: list[HeightGroup] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.building_id,
            "compound": True,
            "shape_type": self.shape_type,
            "outline": self.outline,
            "wings": [w.to_dict() for w in self.wings],
            "height_groups": [hg.to_dict() for hg in self.height_groups],
        }


def _merge_wing_outlines(wings: list[Wing]) -> Polygon:
    """Convex hull of all wing vertices (approximate union outline)."""
    from town_generator.detail.compound import _convex_hull
    all_pts = []
    for w in wings:
        all_pts.extend(Point(p.x, p.y) for p in w.footprint)
    if not all_pts:
        return Polygon()
    return _convex_hull(all_pts)


def process_compound(
    compound: CompoundShape,
    building_id: str = "b0",
    params: DetailParams | None = None,
) -> CompoundBuildingDetail:
    """Process a compound building with merged roofs per height group.

    Wings at the same story height share a single merged roof computed on
    their combined outline. Wings at different heights get separate roofs,
    rendered bottom-to-top (taller on top of shorter).

    Facade details are still computed per-wing.
    """
    from town_generator.detail.roof import generate_hipped_merged, generate_roof

    if params is None:
        params = DetailParams()

    outline_coords = [[round(p.x, 2), round(p.y, 2)] for p in compound.outline]

    # Group wings by story height
    groups: dict[int, list[int]] = {}
    for i, wing in enumerate(compound.wings):
        groups.setdefault(wing.stories, []).append(i)

    # Build height groups with merged roofs (sorted low → high)
    height_groups = []
    for stories in sorted(groups.keys()):
        wing_indices = groups[stories]
        group_wings = [compound.wings[i] for i in wing_indices]

        if len(group_wings) == 1 and len(groups) == 1:
            # Single group, single wing: use the compound outline
            group_outline = compound.outline
        elif len(groups) == 1:
            # All wings same height: use the compound outline
            group_outline = compound.outline
        else:
            # Multi-height: compute outline for this group's wings
            group_outline = _merge_wing_outlines(group_wings)

        group_outline_coords = [[round(p.x, 2), round(p.y, 2)] for p in group_outline]

        # Generate merged roof on the group outline
        roof = generate_hipped_merged(
            group_outline,
            overhang=params.overhang if params.overhang is not None else 0.5,
        )

        height_groups.append(HeightGroup(
            stories=stories,
            outline=group_outline_coords,
            roof=roof,
            wing_indices=wing_indices,
        ))

    # Per-wing facade details (no roof per wing)
    wing_details = []
    for i, wing in enumerate(compound.wings):
        fp_coords = [[round(p.x, 2), round(p.y, 2)] for p in wing.footprint]

        facade = generate_facade_details(
            wing.footprint,
            building_type=wing.building_type,
            style=params.style,
            density=params.facade_density,
            stories=wing.stories,
        )

        wing_details.append(BuildingDetail(
            building_id=f"{building_id}_w{i}",
            footprint=fp_coords,
            building_type=wing.building_type,
            stories=wing.stories,
            roof=None,  # roof is on the height group, not per wing
            facade_details=facade,
        ))

    return CompoundBuildingDetail(
        building_id=building_id,
        shape_type=compound.shape_type,
        outline=outline_coords,
        wings=wing_details,
        height_groups=height_groups,
    )
