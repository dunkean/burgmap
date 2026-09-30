"""Small web app for real-time town generation."""

from __future__ import annotations

import os

try:
    from fastapi import FastAPI, Query
    from fastapi.responses import HTMLResponse, Response
    from fastapi.staticfiles import StaticFiles
except ImportError:
    raise ImportError("FastAPI is required for the web app. Install with: pip install fastapi uvicorn jinja2")

from town_generator.building.model import Model
from town_generator.rendering.palette import PALETTES, DEFAULT
from town_generator.rendering.svg_renderer import render_svg

app = FastAPI(title="Town Generator")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
TEMPLATE_DIR = os.path.join(os.path.dirname(__file__), "templates")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", response_class=HTMLResponse)
def index():
    with open(os.path.join(TEMPLATE_DIR, "index.html"), "r") as f:
        return f.read()


def _parse_toggle(val: str | None) -> bool | None:
    if val is None or val == "":
        return None
    return val.lower() == "true"


@app.get("/api/generate")
def generate(
    seed: int = Query(default=-1),
    size: int = Query(default=15),
    palette: str = Query(default="default"),
    plaza: str | None = Query(default=None),
    citadel: str | None = Query(default=None),
    walls: str | None = Query(default=None),
    temple: str | None = Query(default=None),
    river: str | None = Query(default=None),
    coast: str | None = Query(default=None),
    shanty_town: str | None = Query(default=None),
    roads: int | None = Query(default=None),
    road_style: str | None = Query(default=None),
    elongation: float | None = Query(default=None),
    river_curvature: float | None = Query(default=None),
    coast_roughness: float | None = Query(default=None),
    building_density: float | None = Query(default=None),
    building_style: str | None = Query(default=None),
    style: str | None = Query(default=None),
):
    pal = PALETTES.get(palette.lower(), DEFAULT)
    model = Model(
        n_patches=size,
        seed=seed if seed != -1 else -1,
        plaza=_parse_toggle(plaza),
        citadel=_parse_toggle(citadel),
        walls=_parse_toggle(walls),
        temple=_parse_toggle(temple),
        river=_parse_toggle(river),
        coast=_parse_toggle(coast),
        shanty_town=_parse_toggle(shanty_town),
        n_roads=roads,
        road_style=road_style,
        elongation=elongation,
        river_curvature=river_curvature,
        coast_roughness=coast_roughness,
        building_density=building_density,
        building_style=building_style,
        style=style,
    )
    svg = render_svg(model, pal)
    return Response(content=svg, media_type="image/svg+xml")


@app.get("/api/city")
def generate_city(
    seed: int = Query(default=-1),
    size: int = Query(default=15),
    style: str = Query(default="generic"),
    populator: str | None = Query(default=None),
    min_area: float | None = Query(default=None),
    grid_chaos: float | None = Query(default=None),
    size_chaos: float | None = Query(default=None),
    empty_prob: float | None = Query(default=None),
    density: float | None = Query(default=None),
    alley_width: float | None = Query(default=None),
    roofscape: bool = Query(default=False),
    roof_type: str = Query(default="auto"),
    overhang: float = Query(default=0.0),
    facade_density: int = Query(default=1),
    massing_mode: str = Query(default="adaptive"),
    complexity: float = Query(default=0.4),
    complex_ratio: float = Query(default=0.22),
    join_ratio: float = Query(default=0.0),
    setback: float = Query(default=0.14),
    plaza: str | None = Query(default=None),
    citadel: str | None = Query(default=None),
    walls: str | None = Query(default=None),
    temple: str | None = Query(default=None),
    river: str | None = Query(default=None),
    coast: str | None = Query(default=None),
    shanty_town: str | None = Query(default=None),
    roads: int | None = Query(default=None),
    road_style: str | None = Query(default=None),
    elongation: float | None = Query(default=None),
    river_curvature: float | None = Query(default=None),
    coast_roughness: float | None = Query(default=None),
    building_density: float | None = Query(default=None),
    building_style: str | None = Query(default=None),
):
    """Generate city and return CityMap JSON (M3 contract)."""
    model = Model(
        n_patches=size,
        seed=seed if seed != -1 else -1,
        plaza=_parse_toggle(plaza),
        citadel=_parse_toggle(citadel),
        walls=_parse_toggle(walls),
        temple=_parse_toggle(temple),
        river=_parse_toggle(river),
        coast=_parse_toggle(coast),
        shanty_town=_parse_toggle(shanty_town),
        n_roads=roads,
        road_style=road_style,
        elongation=elongation,
        river_curvature=river_curvature,
        coast_roughness=coast_roughness,
        building_density=building_density,
        building_style=building_style,
        district_populator=populator,
        district_min_area=min_area,
        district_grid_chaos=grid_chaos,
        district_size_chaos=size_chaos,
        district_empty_prob=empty_prob,
        district_density=density,
        district_alley_width=alley_width,
        district_roofscape=roofscape,
        district_roof_type=roof_type,
        district_overhang=overhang,
        district_facade_density=facade_density,
        district_massing_mode=massing_mode,
        district_complexity=complexity,
        district_complex_ratio=complex_ratio,
        district_join_ratio=join_ratio,
        district_setback=setback,
        style=style,
    )
    return model.to_city_map()


@app.get("/tools/city/", response_class=HTMLResponse)
def city_editor():
    with open(os.path.join(TEMPLATE_DIR, "city.html"), "r") as f:
        return f.read()


@app.get("/tools/terrain/", response_class=HTMLResponse)
def terrain_editor():
    with open(os.path.join(TEMPLATE_DIR, "terrain.html"), "r") as f:
        return f.read()


@app.get("/api/terrain")
def generate_terrain(
    seed: int = Query(default=42),
    size: int = Query(default=128),
    map_extent_m: float = Query(default=2000.0),
    noise_scale: float = Query(default=2.0),
    octaves: int = Query(default=4),
    persistence: float = Query(default=0.5),
    coast: bool = Query(default=False),
    coast_direction: int = Query(default=2),
    sea_level: float = Query(default=0.15),
    river_count: int = Query(default=1),
    river_width_m: float = Query(default=30.0),
):
    from town_generator.terrain.world_map import WorldMap
    world = WorldMap(
        seed=seed, size=size, map_extent_m=map_extent_m,
        noise_scale=noise_scale,
        octaves=octaves, persistence=persistence,
        coast=coast, coast_direction=coast_direction,
        sea_level=sea_level, river_count=river_count,
        river_width_m=river_width_m,
    )
    return world.to_dict()


# ── Geology (terrain v2) ────────────────────────────────────────────

@app.get("/tools/geology/", response_class=HTMLResponse)
def geology_editor():
    with open(os.path.join(TEMPLATE_DIR, "geology.html"), "r") as f:
        return f.read()


@app.get("/api/geology")
def generate_geology(
    seed: int = Query(default=42),
    scale: str = Query(default="town"),
    terrain_type: str = Query(default="normal"),
    coast: bool = Query(default=False),
    coast_direction: int = Query(default=2),
    n_rivers: int = Query(default=1),
    lakes: bool = Query(default=True),
):
    from town_generator.terrain_v2.geology_map import GeologyMap
    gmap = GeologyMap(
        seed=seed, scale_name=scale, terrain_type=terrain_type,
        coast=coast, coast_direction=coast_direction,
        n_rivers=n_rivers, lakes=lakes,
    )
    return gmap.to_dict()


@app.get("/tools/region/", response_class=HTMLResponse)
def region_editor():
    with open(os.path.join(TEMPLATE_DIR, "region.html"), "r") as f:
        return f.read()


@app.get("/tools/district/", response_class=HTMLResponse)
def district_editor():
    with open(os.path.join(TEMPLATE_DIR, "district.html"), "r") as f:
        return f.read()


@app.get("/tools/district_roofs/", response_class=HTMLResponse)
def district_roofs_editor():
    with open(os.path.join(TEMPLATE_DIR, "district_roofs.html"), "r") as f:
        return f.read()


@app.get("/api/district")
def populate_district(
    populator: str = Query(default="organic_alley"),
    seed: int = Query(default=42),
    min_area: float = Query(default=20.0),
    grid_chaos: float = Query(default=0.4),
    size_chaos: float = Query(default=0.4),
    empty_prob: float = Query(default=0.04),
    density: float = Query(default=0.6),
    alley_width: float = Query(default=0.8),
    polygon: str = Query(default=""),
    district_type: str = Query(default="craftsmen"),
    style: str = Query(default="generic"),
    preset: str = Query(default=""),
):
    """Run a populator on a district polygon (M4 standalone endpoint).

    The polygon param is a JSON array of [x,y] pairs, e.g. "[[0,0],[50,0],[50,40],[0,40]]".
    If empty, a default test polygon is generated.
    If preset is given (e.g. "hexagon", "irregular", "elongated"), use that shape.
    """
    import json
    from town_generator.geom.point import Point
    from town_generator.geom.polygon import Polygon
    from town_generator.district.base import PopulatorParams
    from town_generator.district.registry import POPULATORS, get_populator

    # Build polygon
    if polygon:
        pts_raw = json.loads(polygon)
        poly = Polygon([Point(p[0], p[1]) for p in pts_raw])
    elif preset:
        poly = _make_preset_polygon(preset)
    else:
        poly = _make_preset_polygon("default")

    # Select populator
    if populator and populator in POPULATORS:
        pop = POPULATORS[populator]
    else:
        pop = get_populator(district_type, style)

    params = PopulatorParams(
        min_area=min_area,
        grid_chaos=grid_chaos,
        size_chaos=size_chaos,
        empty_prob=empty_prob,
        density=density,
        alley_width=alley_width,
        seed=seed,
    )

    result = pop.populate(poly, params)
    out = result.to_dict()
    out["polygon"] = [[round(v.x, 2), round(v.y, 2)] for v in poly]
    out["populator"] = pop.name
    out["params"] = {
        "seed": seed, "min_area": min_area, "grid_chaos": grid_chaos,
        "size_chaos": size_chaos, "empty_prob": empty_prob,
        "density": density, "alley_width": alley_width,
    }
    return out


@app.get("/api/district_roofs")
def populate_district_roofs(
    populator: str = Query(default="organic_alley"),
    seed: int = Query(default=42),
    min_area: float = Query(default=20.0),
    grid_chaos: float = Query(default=0.4),
    size_chaos: float = Query(default=0.4),
    empty_prob: float = Query(default=0.04),
    density: float = Query(default=0.6),
    alley_width: float = Query(default=0.8),
    polygon: str = Query(default=""),
    district_type: str = Query(default="craftsmen"),
    style: str = Query(default="generic"),
    preset: str = Query(default=""),
    roof_type: str = Query(default="auto"),
    overhang: float = Query(default=0.0),
    facade_density: int = Query(default=1),
    massing_mode: str = Query(default="adaptive"),
    complexity: float = Query(default=0.4),
    complex_ratio: float = 0.22,
    join_ratio: float = 0.0,
    setback: float = Query(default=0.14),
):
    """Populate a district with complexified footprints and roof detail."""
    import json
    from town_generator.geom.point import Point
    from town_generator.geom.polygon import Polygon
    from town_generator.district.base import PopulatorParams
    from town_generator.district.registry import POPULATORS, get_populator
    from town_generator.detail.processor import DetailParams
    from town_generator.detail.district_roofs import generate_district_roofscape

    if polygon:
        pts_raw = json.loads(polygon)
        poly = Polygon([Point(p[0], p[1]) for p in pts_raw])
    elif preset:
        poly = _make_preset_polygon(preset)
    else:
        poly = _make_preset_polygon("default")

    if populator and populator in POPULATORS:
        pop = POPULATORS[populator]
    else:
        pop = get_populator(district_type, style)

    pop_params = PopulatorParams(
        min_area=min_area,
        grid_chaos=grid_chaos,
        size_chaos=size_chaos,
        empty_prob=empty_prob,
        density=density,
        alley_width=alley_width,
        seed=seed,
    )
    detail_overhang = 0.0 if overhang < 0 else overhang
    detail_params = DetailParams(
        roof_type=None if roof_type in ("", "auto") else roof_type,
        overhang=detail_overhang,
        facade_density=max(0, min(2, facade_density)),
        style=style,
    )

    out = generate_district_roofscape(
        polygon=poly,
        populator=pop,
        pop_params=pop_params,
        detail_params=detail_params,
        style=style,
        massing_mode=massing_mode,
        complexity=complexity,
        complex_ratio=complex_ratio,
        join_ratio=join_ratio,
        setback_ratio=setback,
    )
    out["polygon"] = [[round(v.x, 2), round(v.y, 2)] for v in poly]
    out["populator"] = pop.name
    out["params"] = {
        "seed": seed,
        "min_area": min_area,
        "grid_chaos": grid_chaos,
        "size_chaos": size_chaos,
        "empty_prob": empty_prob,
        "density": density,
        "alley_width": alley_width,
        "roof_type": roof_type,
        "overhang": round(detail_overhang, 2),
        "facade_density": max(0, min(2, facade_density)),
        "massing_mode": massing_mode,
        "complexity": complexity,
        "complex_ratio": complex_ratio,
        "join_ratio": join_ratio,
        "setback": setback,
        "style": style,
    }
    return out


@app.get("/api/district/populators")
def list_populators():
    """List all available populators with their descriptions."""
    from town_generator.district.registry import POPULATORS
    return [
        {"name": name, "description": p.description}
        for name, p in POPULATORS.items()
    ]


def _make_preset_polygon(preset: str):
    """Create a test polygon for standalone district testing."""
    import math
    from town_generator.geom.point import Point
    from town_generator.geom.polygon import Polygon

    if preset == "hexagon":
        r = 30
        pts = [Point(r * math.cos(a), r * math.sin(a))
               for a in (i * math.pi / 3 for i in range(6))]
        return Polygon(pts)
    elif preset == "elongated":
        return Polygon([
            Point(-40, -15), Point(40, -15),
            Point(45, 0), Point(40, 15), Point(-40, 15), Point(-45, 0),
        ])
    elif preset == "irregular":
        return Polygon([
            Point(-25, -20), Point(10, -25), Point(30, -10),
            Point(35, 15), Point(15, 30), Point(-10, 25), Point(-30, 10),
        ])
    elif preset == "large":
        return Polygon([
            Point(-50, -40), Point(50, -40), Point(55, 0),
            Point(50, 40), Point(-50, 40), Point(-55, 0),
        ])
    else:  # "default" — a reasonable rectangle
        return Polygon([
            Point(-25, -20), Point(25, -20),
            Point(25, 20), Point(-25, 20),
        ])


@app.get("/api/region")
def generate_region(
    seed: int = Query(default=42),
    size: int = Query(default=128),
    map_extent_m: float = Query(default=2000.0),
    noise_scale: float = Query(default=2.0),
    octaves: int = Query(default=4),
    persistence: float = Query(default=0.5),
    coast: bool = Query(default=False),
    coast_direction: int = Query(default=2),
    sea_level: float = Query(default=0.15),
    river_count: int = Query(default=1),
    river_width_m: float = Query(default=30.0),
    population: int = Query(default=10000),
    city_radius_m: float = Query(default=0),
    n_satellites: int = Query(default=0),
    style: str = Query(default="generic"),
    build_roads: bool = Query(default=True),
):
    import math
    from town_generator.terrain.world_map import WorldMap
    from town_generator.region.region import Region

    world = WorldMap(
        seed=seed, size=size, map_extent_m=map_extent_m,
        noise_scale=noise_scale,
        octaves=octaves, persistence=persistence,
        coast=coast, coast_direction=coast_direction,
        sea_level=sea_level, river_count=river_count,
        river_width_m=river_width_m,
    )

    # Derive city radius from population if not overridden
    if city_radius_m <= 0:
        density_ha = 150  # people per hectare
        city_radius_m = math.sqrt(population / (density_ha * math.pi)) * 100
    city_radius_cells = max(5, int(city_radius_m / world.cell_size_m))

    region = Region(
        world_map=world, seed=seed,
        city_radius=city_radius_cells, n_satellites=n_satellites,
        style=style, build_roads=build_roads,
    )
    result = region.to_dict()
    result["population"] = population
    result["city_radius_m"] = round(city_radius_m, 1)
    result["city_radius_cells"] = city_radius_cells
    result["terrain"] = {
        "elevation": world.to_dict()["elevation"],
        "water": world.water,
        "terrain": world.terrain,
        "ground_cover": world.ground_cover,
        "rivers": [r.to_dict() for r in world.rivers],
        "coastline": [list(pt) for pt in world.coastline],
    }
    return result


@app.get("/tools/building/", response_class=HTMLResponse)
def building_editor():
    with open(os.path.join(TEMPLATE_DIR, "building.html"), "r") as f:
        return f.read()


@app.get("/tools/roofs/", response_class=HTMLResponse)
def roof_editor():
    with open(os.path.join(TEMPLATE_DIR, "roofs.html"), "r") as f:
        return f.read()


@app.get("/api/building")
def generate_building_detail(
    roof_type: str = Query(default=""),
    overhang: float = Query(default=-1.0),
    facade_density: int = Query(default=1),
    style: str = Query(default="generic"),
    building_type: str = Query(default="house"),
    stories: int = Query(default=1),
    polygon: str = Query(default=""),
    preset: str = Query(default=""),
    compound: str = Query(default=""),
    seed: int = Query(default=42),
):
    """M5 standalone: generate roof + facade details for a building footprint.

    Use `compound` param for multi-wing shapes (l_shape, t_shape, h_shape,
    u_shape, plus, courtyard, cathedral, keep).
    """
    import json
    from town_generator.geom.point import Point
    from town_generator.geom.polygon import Polygon
    from town_generator.detail.processor import (
        DetailParams, process_building, process_compound,
    )
    from town_generator.detail.compound import COMPOUND_SHAPES

    params = DetailParams(
        roof_type=roof_type if roof_type else None,
        overhang=overhang if overhang >= 0 else None,
        facade_density=max(0, min(2, facade_density)),
        style=style,
    )

    # Compound shape mode
    if compound and compound in COMPOUND_SHAPES:
        import inspect
        factory = COMPOUND_SHAPES[compound]
        sig = inspect.signature(factory)
        kwargs = {}
        if "stories" in sig.parameters:
            kwargs["stories"] = stories
        if "building_type" in sig.parameters:
            kwargs["building_type"] = building_type
        if "seed" in sig.parameters and seed != -1:
            kwargs["seed"] = seed
        shape = factory(**kwargs)
        result = process_compound(shape, building_id="b0", params=params)
        out = result.to_dict()
        out["params"] = {
            "compound": compound,
            "roof_type": params.roof_type or "auto",
            "overhang": params.overhang if params.overhang is not None else "auto",
            "facade_density": params.facade_density,
            "style": params.style,
            "building_type": building_type,
            "stories": stories,
        }
        return out

    # Single footprint mode
    if polygon:
        pts_raw = json.loads(polygon)
        fp = Polygon([Point(p[0], p[1]) for p in pts_raw])
    elif preset:
        fp = _make_building_preset(preset)
    else:
        fp = _make_building_preset("house")

    result = process_building(
        footprint=fp,
        building_id="b0",
        building_type=building_type,
        stories=stories,
        params=params,
    )

    out = result.to_dict()
    out["polygon"] = [[round(v.x, 2), round(v.y, 2)] for v in fp]
    out["params"] = {
        "roof_type": params.roof_type or "auto",
        "overhang": params.overhang if params.overhang is not None else "auto",
        "facade_density": params.facade_density,
        "style": params.style,
        "building_type": building_type,
        "stories": stories,
    }
    return out


@app.get("/api/roofs")
def generate_roofs(
    roof_type: str = Query(default=""),
    overhang: float = Query(default=-1.0),
    style: str = Query(default="generic"),
    building_type: str = Query(default="house"),
    stories: int = Query(default=1),
    polygon: str = Query(default=""),
    levels: str = Query(default=""),
    join_touches: bool = Query(default=False),
):
    """Generate roof geometry for one arbitrary polygon or multiple roof levels."""
    import json
    from town_generator.geom.point import Point
    from town_generator.geom.polygon import Polygon
    from town_generator.detail.roof import (
        ROOF_GENERATORS,
        generate_roof,
        generate_skeleton,
        merge_touching_roof_levels,
    )

    selected_roof_type = roof_type if roof_type and roof_type != "auto" else "auto"
    roof_generators = {**ROOF_GENERATORS, "skeleton": generate_skeleton}

    if levels:
        raw_levels = json.loads(levels)
    else:
        if polygon:
            raw_polygon = json.loads(polygon)
        else:
            raw_polygon = [[-9, -6], [11, -5], [14, 1], [7, 8], [-3, 9], [-12, 2]]
        raw_levels = [{
            "id": "level_1",
            "polygon": raw_polygon,
            "stories": stories,
            "building_type": building_type,
        }]

    if join_touches:
        raw_levels = merge_touching_roof_levels(
            raw_levels,
            default_building_type=building_type,
            default_style=style,
            default_roof_type=selected_roof_type,
        )

    out_levels = []
    for idx, raw_level in enumerate(raw_levels):
        pts_raw = raw_level.get("polygon", [])
        if len(pts_raw) < 3:
            continue
        fp = Polygon([Point(p[0], p[1]) for p in pts_raw])
        level_stories = int(raw_level.get("stories", stories))
        level_type = raw_level.get("building_type", building_type)
        level_style = raw_level.get("style", style)
        level_roof_type = raw_level.get("roof_type")
        if level_roof_type in ("", None):
            level_roof_type = selected_roof_type

        if level_roof_type in ("", "auto", None):
            if overhang >= 0:
                roof = generate_roof(
                    fp,
                    roof_type=None,
                    building_type=level_type,
                    style=level_style,
                    overhang=overhang,
                )
            else:
                roof = generate_roof(
                    fp,
                    roof_type=None,
                    building_type=level_type,
                    style=level_style,
                )
        else:
            roof_generator = roof_generators.get(level_roof_type, generate_skeleton)
            if overhang >= 0:
                roof = roof_generator(fp, overhang=overhang)
            else:
                roof = roof_generator(fp)

        polygon_coords = [[round(p.x, 2), round(p.y, 2)] for p in fp]
        out_levels.append({
            "id": str(raw_level.get("id", f"level_{idx + 1}")),
            "label": raw_level.get("label", f"Level {idx + 1}"),
            "polygon": polygon_coords,
            "footprint": polygon_coords,
            "building_type": level_type,
            "style": level_style,
            "stories": level_stories,
            "joined": bool(raw_level.get("joined", False)),
            "source_ids": list(raw_level.get("source_ids", [])),
            "roof": roof.to_dict(),
        })

    return {
        "multi_level": len(out_levels) > 1,
        "levels": out_levels,
        "params": {
            "roof_type": selected_roof_type,
            "overhang": overhang if overhang >= 0 else "auto",
            "style": style,
            "building_type": building_type,
            "stories": stories,
            "join_touches": join_touches,
        },
    }


@app.get("/api/building/batch")
def generate_building_batch(
    roof_type: str = Query(default=""),
    overhang: float = Query(default=-1.0),
    facade_density: int = Query(default=1),
    style: str = Query(default="generic"),
    seed: int = Query(default=42),
    size: int = Query(default=15),
):
    """M5 batch: generate a city and add M5 detail to all buildings."""
    from town_generator.detail.processor import DetailParams, process_city_map

    model = Model(
        n_patches=size,
        seed=seed if seed != -1 else -1,
        style=style,
    )
    city_map = model.to_city_map()

    params = DetailParams(
        roof_type=roof_type if roof_type else None,
        overhang=overhang if overhang >= 0 else None,
        facade_density=max(0, min(2, facade_density)),
        style=style,
    )
    process_city_map(city_map, params)
    return city_map


@app.get("/api/building/roof_types")
def list_roof_types():
    """List all available roof types."""
    from town_generator.detail.roof import ROOF_GENERATORS, STYLE_ROOF_DEFAULTS
    return {
        "roof_types": list(ROOF_GENERATORS.keys()),
        "style_defaults": STYLE_ROOF_DEFAULTS,
    }


def _make_building_preset(preset: str):
    """Create a test building footprint for standalone testing."""
    from town_generator.geom.point import Point
    from town_generator.geom.polygon import Polygon

    if preset == "house":
        return Polygon([
            Point(-6, -4), Point(6, -4), Point(6, 4), Point(-6, 4),
        ])
    elif preset == "tower":
        import math
        r = 4
        return Polygon([
            Point(r * math.cos(i * math.pi / 4), r * math.sin(i * math.pi / 4))
            for i in range(8)
        ])
    elif preset == "cathedral":
        # Cruciform plan
        return Polygon([
            Point(-4, -12), Point(4, -12), Point(4, -4),
            Point(10, -4), Point(10, 4), Point(4, 4),
            Point(4, 12), Point(-4, 12), Point(-4, 4),
            Point(-10, 4), Point(-10, -4), Point(-4, -4),
        ])
    elif preset == "mosque":
        return Polygon([
            Point(-8, -8), Point(8, -8), Point(8, 8), Point(-8, 8),
        ])
    elif preset == "longhouse":
        return Polygon([
            Point(-15, -5), Point(15, -5), Point(15, 5), Point(-15, 5),
        ])
    elif preset == "l_shape":
        return Polygon([
            Point(-6, -6), Point(6, -6), Point(6, 0),
            Point(0, 0), Point(0, 6), Point(-6, 6),
        ])
    elif preset == "large":
        return Polygon([
            Point(-12, -8), Point(12, -8), Point(12, 8), Point(-12, 8),
        ])
    else:  # default small house
        return Polygon([
            Point(-5, -3), Point(5, -3), Point(5, 3), Point(-5, 3),
        ])


def run():
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=9000)


if __name__ == "__main__":
    run()

@app.get("/tools/gen-roofs/", response_class=HTMLResponse)
def gen_roofs_editor():
    with open(os.path.join(TEMPLATE_DIR, "gen_roofs.html"), "r") as f:
        return f.read()

@app.get("/api/gen_roofs")
def generate_gen_roofs(
    roof_type: str = Query(default=""),
    overhang: float = Query(default=-1.0),
    style: str = Query(default="generic"),
    building_type: str = Query(default="house"),
    stories: int = Query(default=1),
    polygon: str = Query(default=""),
    levels: str = Query(default=""),
):
    import json
    from town_generator.geom.point import Point
    from town_generator.geom.polygon import Polygon
    from town_generator.detail.roof import RoofGeometry, RoofFace
    from town_generator.detail.gen_roofs import process_gen_roof

    selected_roof_type = roof_type if roof_type and roof_type != "auto" else "auto"
    
    if levels:
        raw_levels = json.loads(levels)
    else:
        if polygon:
            raw_polygon = json.loads(polygon)
        else:
            raw_polygon = [[-9, -6], [11, -5], [14, 1], [7, 8], [-3, 9], [-12, 2]]
        raw_levels = [{
            "id": "level_1",
            "polygon": raw_polygon,
            "stories": stories,
            "building_type": building_type,
        }]

    out_levels = []
    for idx, raw_level in enumerate(raw_levels):
        pts_raw = raw_level.get("polygon", [])
        if len(pts_raw) < 3:
            continue
        fp = Polygon([Point(p[0], p[1]) for p in pts_raw])
        level_stories = int(raw_level.get("stories", stories))
        level_type = raw_level.get("building_type", building_type)
        level_style = raw_level.get("style", style)
        
        custom_data = process_gen_roof(fp, style=level_style)
        
        polygon_coords = [[round(p.x, 2), round(p.y, 2)] for p in fp]
        out_levels.append({
            "id": str(raw_level.get("id", f"level_{idx + 1}")),
            "label": raw_level.get("label", f"Level {idx + 1}"),
            "polygon": polygon_coords,
            "footprint": polygon_coords,
            "building_type": level_type,
            "style": level_style,
            "stories": level_stories,
            "roof": custom_data,
        })

    return {
        "multi_level": len(out_levels) > 1,
        "levels": out_levels,
        "params": {
            "roof_type": selected_roof_type,
            "overhang": overhang if overhang >= 0 else "auto",
            "style": style,
            "building_type": building_type,
            "stories": stories,
        },
    }
