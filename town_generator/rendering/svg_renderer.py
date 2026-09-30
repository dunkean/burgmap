"""SVG output — replaces CityMap.hx + GraphicsExtender.hx.

Uses only stdlib xml.etree.ElementTree for zero external dependencies.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.building.model import Model
from town_generator.rendering.palette import Palette, DEFAULT

from town_generator.wards.castle import Castle
from town_generator.wards.cathedral import Cathedral
from town_generator.wards.market import Market
from town_generator.wards.craftsmen import CraftsmenWard
from town_generator.wards.merchant import MerchantWard
from town_generator.wards.gate_ward import GateWard
from town_generator.wards.slum import Slum
from town_generator.wards.administration import AdministrationWard
from town_generator.wards.military import MilitaryWard
from town_generator.wards.patriciate import PatriciateWard
from town_generator.wards.farm import Farm
from town_generator.wards.park import Park
from town_generator.wards.shanty_town import ShantyTown
from town_generator.wards.ward import Ward, MAIN_STREET

NORMAL_STROKE = 0.300
THICK_STROKE = 1.800


def _c(color: int) -> str:
    return f"#{color:06x}"


def _polygon_d(poly: Polygon | list[Point]) -> str:
    """SVG path data for a closed polygon."""
    if not poly:
        return ""
    parts = [f"M{poly[-1].x:.2f},{poly[-1].y:.2f}"]
    for v in poly:
        parts.append(f"L{v.x:.2f},{v.y:.2f}")
    parts.append("Z")
    return "".join(parts)


def _polyline_d(poly: Polygon | list[Point]) -> str:
    """SVG path data for an open polyline."""
    if not poly:
        return ""
    parts = [f"M{poly[0].x:.2f},{poly[0].y:.2f}"]
    for i in range(1, len(poly)):
        parts.append(f"L{poly[i].x:.2f},{poly[i].y:.2f}")
    return "".join(parts)


def render_svg(model: Model, palette: Palette | None = None) -> str:
    if palette is None:
        palette = DEFAULT

    # Calculate viewbox
    all_points: list[Point] = []
    for p in model.patches:
        all_points.extend(p.shape)
    if not all_points:
        return "<svg></svg>"

    min_x = min(p.x for p in all_points) - 10
    min_y = min(p.y for p in all_points) - 10
    max_x = max(p.x for p in all_points) + 10
    max_y = max(p.y for p in all_points) + 10
    w = max_x - min_x
    h = max_y - min_y

    svg = ET.Element("svg")
    svg.set("xmlns", "http://www.w3.org/2000/svg")
    svg.set("viewBox", f"{min_x:.1f} {min_y:.1f} {w:.1f} {h:.1f}")
    svg.set("width", str(int(w)))
    svg.set("height", str(int(h)))

    # Background
    bg = ET.SubElement(svg, "rect")
    bg.set("x", f"{min_x:.1f}")
    bg.set("y", f"{min_y:.1f}")
    bg.set("width", f"{w:.1f}")
    bg.set("height", f"{h:.1f}")
    bg.set("fill", _c(palette.paper))

    # Build a clip-path that excludes water areas (river + coast) from
    # land-bound elements like walls and roads.
    has_water = model.coast is not None or model.river is not None
    if has_water:
        defs = ET.SubElement(svg, "defs")
        clip = ET.SubElement(defs, "clipPath", id="land-clip")
        # Single path: viewBox rect + water polygons with evenodd rule.
        # The rect is the "positive" area; each water polygon punches a hole.
        margin = 10
        clip_d = (
            f"M{min_x - margin:.2f},{min_y - margin:.2f}"
            f"L{max_x + margin:.2f},{min_y - margin:.2f}"
            f"L{max_x + margin:.2f},{max_y + margin:.2f}"
            f"L{min_x - margin:.2f},{max_y + margin:.2f}Z"
        )
        if model.coast is not None and model.coast.water_polygon:
            clip_d += _polygon_d(model.coast.water_polygon)
        if model.river is not None and model.river.polygon:
            clip_d += _polygon_d(model.river.polygon)
        clip_path_el = ET.SubElement(clip, "path")
        clip_path_el.set("d", clip_d)
        clip_path_el.set("clip-rule", "evenodd")

    # Coast water area
    if model.coast is not None:
        water_group = ET.SubElement(svg, "g", id="coast")
        path = ET.SubElement(water_group, "path")
        path.set("d", _polygon_d(model.coast.water_polygon))
        path.set("fill", _c(palette.water))
        path.set("stroke", "none")
        # Shoreline
        shore_path = ET.SubElement(water_group, "path")
        shore_path.set("d", _polyline_d(model.coast.shoreline))
        shore_path.set("fill", "none")
        shore_path.set("stroke", _c(palette.medium))
        shore_path.set("stroke-width", f"{NORMAL_STROKE * 2:.3f}")

    # River water area
    if model.river is not None:
        river_group = ET.SubElement(svg, "g", id="river")
        path = ET.SubElement(river_group, "path")
        path.set("d", _polygon_d(model.river.polygon))
        path.set("fill", _c(palette.water))
        path.set("stroke", "none")

    # 1. Roads (background layer)
    roads_group = ET.SubElement(svg, "g", id="roads")
    if has_water:
        roads_group.set("clip-path", "url(#land-clip)")
    for road in model.roads:
        # Outer stroke
        path = ET.SubElement(roads_group, "path")
        path.set("d", _polyline_d(road))
        path.set("fill", "none")
        path.set("stroke", _c(palette.medium))
        path.set("stroke-width", f"{MAIN_STREET + NORMAL_STROKE:.3f}")
        path.set("stroke-linecap", "butt")

        # Inner stroke (paper color)
        path2 = ET.SubElement(roads_group, "path")
        path2.set("d", _polyline_d(road))
        path2.set("fill", "none")
        path2.set("stroke", _c(palette.paper))
        path2.set("stroke-width", f"{MAIN_STREET - NORMAL_STROKE:.3f}")
        path2.set("stroke-linecap", "butt")

    # 2. Patches
    patches_group = ET.SubElement(svg, "g", id="patches")
    for patch in model.patches:
        ward = patch.ward
        if ward is None:
            continue

        if isinstance(ward, Castle):
            _draw_building(patches_group, ward.geometry, palette.light, palette.dark, NORMAL_STROKE * 2, palette)
        elif isinstance(ward, Cathedral):
            _draw_building(patches_group, ward.geometry, palette.light, palette.dark, NORMAL_STROKE, palette)
        elif isinstance(ward, (Market, CraftsmenWard, MerchantWard, GateWard, Slum,
                               AdministrationWard, MilitaryWard, PatriciateWard, Farm, ShantyTown)):
            for building in ward.geometry:
                path = ET.SubElement(patches_group, "path")
                path.set("d", _polygon_d(building))
                path.set("fill", _c(palette.light))
                path.set("stroke", _c(palette.dark))
                path.set("stroke-width", f"{NORMAL_STROKE:.3f}")
        elif isinstance(ward, Park):
            for grove in ward.geometry:
                path = ET.SubElement(patches_group, "path")
                path.set("d", _polygon_d(grove))
                path.set("fill", _c(palette.medium))
                path.set("stroke", "none")

    # 3. Walls (foreground)
    walls_group = ET.SubElement(svg, "g", id="walls")
    if has_water:
        walls_group.set("clip-path", "url(#land-clip)")
    if model.wall is not None:
        _draw_wall(walls_group, model.wall, False, palette)
    if model.citadel is not None and isinstance(model.citadel.ward, Castle):
        _draw_wall(walls_group, model.citadel.ward.wall, True, palette)

    # 4. Bridges (over river)
    if model.river is not None and model.river.bridges:
        bridges_group = ET.SubElement(svg, "g", id="bridges")
        for bridge in model.river.bridges:
            line = ET.SubElement(bridges_group, "line")
            line.set("x1", f"{bridge.start.x:.2f}")
            line.set("y1", f"{bridge.start.y:.2f}")
            line.set("x2", f"{bridge.end.x:.2f}")
            line.set("y2", f"{bridge.end.y:.2f}")
            line.set("stroke", _c(palette.dark))
            line.set("stroke-width", f"{MAIN_STREET + 1:.3f}")
            line.set("stroke-linecap", "butt")
            # Bridge deck (lighter)
            deck = ET.SubElement(bridges_group, "line")
            deck.set("x1", f"{bridge.start.x:.2f}")
            deck.set("y1", f"{bridge.start.y:.2f}")
            deck.set("x2", f"{bridge.end.x:.2f}")
            deck.set("y2", f"{bridge.end.y:.2f}")
            deck.set("stroke", _c(palette.light))
            deck.set("stroke-width", f"{MAIN_STREET - 0.5:.3f}")
            deck.set("stroke-linecap", "butt")

    return ET.tostring(svg, encoding="unicode", xml_declaration=False)


def _draw_building(
    parent: ET.Element,
    blocks: list[Polygon],
    fill: int,
    line: int,
    thickness: float,
    palette: Palette,
) -> None:
    # First pass: outlines (thick stroke)
    for block in blocks:
        path = ET.SubElement(parent, "path")
        path.set("d", _polygon_d(block))
        path.set("fill", "none")
        path.set("stroke", _c(line))
        path.set("stroke-width", f"{thickness * 2:.3f}")

    # Second pass: fills
    for block in blocks:
        path = ET.SubElement(parent, "path")
        path.set("d", _polygon_d(block))
        path.set("fill", _c(fill))
        path.set("stroke", "none")


def _draw_wall(
    parent: ET.Element,
    wall,
    large: bool,
    palette: Palette,
) -> None:
    # Wall outline
    path = ET.SubElement(parent, "path")
    path.set("d", _polygon_d(wall.shape))
    path.set("fill", "none")
    path.set("stroke", _c(palette.dark))
    path.set("stroke-width", f"{THICK_STROKE:.3f}")

    # Gates
    for gate in wall.gates:
        _draw_gate(parent, wall.shape, gate, palette)

    # Towers
    r = THICK_STROKE * (1.5 if large else 1.0)
    for t in wall.towers:
        circle = ET.SubElement(parent, "circle")
        circle.set("cx", f"{t.x:.2f}")
        circle.set("cy", f"{t.y:.2f}")
        circle.set("r", f"{r:.3f}")
        circle.set("fill", _c(palette.dark))
        circle.set("stroke", "none")


def _draw_gate(
    parent: ET.Element,
    wall: Polygon,
    gate: Point,
    palette: Palette,
) -> None:
    direction = wall.next(gate).subtract(wall.prev(gate))
    length = direction.length
    if length > 0:
        direction.normalize(THICK_STROKE * 1.5)

    p1 = gate.subtract(direction)
    p2 = gate.add(direction)

    line = ET.SubElement(parent, "line")
    line.set("x1", f"{p1.x:.2f}")
    line.set("y1", f"{p1.y:.2f}")
    line.set("x2", f"{p2.x:.2f}")
    line.set("y2", f"{p2.y:.2f}")
    line.set("stroke", _c(palette.dark))
    line.set("stroke-width", f"{THICK_STROKE * 2:.3f}")
    line.set("stroke-linecap", "butt")
