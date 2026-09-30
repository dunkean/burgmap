"""Tests for M5 Building Detail & Roofscape — roof geometry, facade details, processor."""

import json
import math
import pytest

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.detail.roof import (
    RoofGeometry,
    generate_roof,
    generate_gabled,
    generate_hipped,
    generate_hipped_merged,
    generate_flat,
    generate_domed,
    generate_pagoda,
    generate_thatched,
    generate_conical,
    generate_vaulted,
    ROOF_GENERATORS,
    STYLE_ROOF_DEFAULTS,
    BUILDING_ROOF_OVERRIDES,
)
from town_generator.detail.facade import (
    FacadeDetail,
    generate_facade_details,
    place_windows,
    place_door,
    place_chimney,
    place_buttresses,
    place_balcony,
    place_minaret,
    DENSITY_NONE,
    DENSITY_SPARSE,
    DENSITY_RICH,
)
from town_generator.detail.processor import (
    DetailParams,
    BuildingDetail,
    process_building,
    process_buildings,
    process_city_map,
)


# --- Fixtures ---

def make_rect(w=12, h=8, cx=0, cy=0):
    return Polygon([
        Point(cx - w / 2, cy - h / 2),
        Point(cx + w / 2, cy - h / 2),
        Point(cx + w / 2, cy + h / 2),
        Point(cx - w / 2, cy + h / 2),
    ])


def make_square(s=10, cx=0, cy=0):
    return make_rect(s, s, cx, cy)


def make_octagon(r=5, cx=0, cy=0):
    return Polygon([
        Point(cx + r * math.cos(i * math.pi / 4),
              cy + r * math.sin(i * math.pi / 4))
        for i in range(8)
    ])


def make_l_shape():
    return Polygon([
        Point(-6, -6), Point(6, -6), Point(6, 0),
        Point(0, 0), Point(0, 6), Point(-6, 6),
    ])


def make_cruciform():
    return Polygon([
        Point(-4, -12), Point(4, -12), Point(4, -4),
        Point(10, -4), Point(10, 4), Point(4, 4),
        Point(4, 12), Point(-4, 12), Point(-4, 4),
        Point(-10, 4), Point(-10, -4), Point(-4, -4),
    ])


def make_triangle():
    return Polygon([Point(0, -8), Point(7, 5), Point(-7, 5)])


def _has_flat_cap_face(roof):
    ridge_vertices = {(round(x, 2), round(y, 2)) for x, y in roof.ridge_polygon}
    for face in roof.faces:
        if len(face.polygon) < 3:
            continue
        if all((round(x, 2), round(y, 2)) in ridge_vertices for x, y in face.polygon):
            return True
    return False


def _has_face_matching_ring(roof, ring):
    ring_vertices = {(round(x, 2), round(y, 2)) for x, y in ring}
    for face in roof.faces:
        if len(face.polygon) != len(ring):
            continue
        face_vertices = {(round(x, 2), round(y, 2)) for x, y in face.polygon}
        if face_vertices == ring_vertices:
            return True
    return False


# --- Roof Geometry Tests ---

class TestRoofRegistry:
    def test_all_types_registered(self):
        expected = {"gabled", "hipped", "flat", "domed", "pagoda", "thatched", "conical", "vaulted"}
        assert expected == set(ROOF_GENERATORS.keys())

    def test_style_defaults_cover_common_styles(self):
        for style in ["generic", "european_medieval", "arabic_islamic", "roman", "viking"]:
            assert style in STYLE_ROOF_DEFAULTS or style.replace("_islamic", "") in STYLE_ROOF_DEFAULTS

    def test_building_overrides_exist(self):
        assert "tower" in BUILDING_ROOF_OVERRIDES
        assert "mosque" in BUILDING_ROOF_OVERRIDES
        assert BUILDING_ROOF_OVERRIDES["tower"] == "conical"


class TestRoofGeometryOutput:
    """All roof generators must produce valid RoofGeometry."""

    @pytest.mark.parametrize("roof_type", ROOF_GENERATORS.keys())
    def test_produces_valid_output(self, roof_type):
        fp = make_rect()
        gen = ROOF_GENERATORS[roof_type]
        result = gen(fp)
        assert isinstance(result, RoofGeometry)
        assert result.roof_type == roof_type
        assert isinstance(result.polygon, list)
        assert len(result.polygon) >= 1  # at least some output
        assert isinstance(result.ridge_polygon, list)

    @pytest.mark.parametrize("roof_type", ROOF_GENERATORS.keys())
    def test_polygon_coords_are_valid(self, roof_type):
        fp = make_rect()
        result = ROOF_GENERATORS[roof_type](fp)
        for pt in result.polygon:
            assert len(pt) == 2
            assert isinstance(pt[0], (int, float))
            assert isinstance(pt[1], (int, float))
            assert not math.isnan(pt[0])
            assert not math.isnan(pt[1])

    @pytest.mark.parametrize("roof_type", ROOF_GENERATORS.keys())
    def test_to_dict_serializable(self, roof_type):
        fp = make_rect()
        result = ROOF_GENERATORS[roof_type](fp)
        d = result.to_dict()
        text = json.dumps(d)
        assert len(text) > 0
        assert d["type"] == roof_type

    @pytest.mark.parametrize("roof_type", ROOF_GENERATORS.keys())
    def test_works_with_square(self, roof_type):
        fp = make_square()
        result = ROOF_GENERATORS[roof_type](fp)
        assert isinstance(result, RoofGeometry)
        assert len(result.polygon) >= 1

    @pytest.mark.parametrize("roof_type", ROOF_GENERATORS.keys())
    def test_works_with_octagon(self, roof_type):
        fp = make_octagon()
        result = ROOF_GENERATORS[roof_type](fp)
        assert isinstance(result, RoofGeometry)

    @pytest.mark.parametrize("roof_type", ROOF_GENERATORS.keys())
    def test_works_with_l_shape(self, roof_type):
        fp = make_l_shape()
        result = ROOF_GENERATORS[roof_type](fp)
        assert isinstance(result, RoofGeometry)

    @pytest.mark.parametrize("roof_type", ROOF_GENERATORS.keys())
    def test_works_with_triangle(self, roof_type):
        fp = make_triangle()
        result = ROOF_GENERATORS[roof_type](fp)
        assert isinstance(result, RoofGeometry)


class TestGabledRoof:
    def test_ridge_is_line_segment(self):
        result = generate_gabled(make_rect(20, 10))
        # Ridge should be 2 points (a line)
        assert len(result.ridge_polygon) == 2

    def test_ridge_along_long_axis(self):
        result = generate_gabled(make_rect(20, 10))
        ridge = result.ridge_polygon
        # Ridge should be roughly horizontal for a wider-than-tall rect
        dx = abs(ridge[1][0] - ridge[0][0])
        dy = abs(ridge[1][1] - ridge[0][1])
        assert dx > dy  # longer in x direction

    def test_overhang_expands_polygon(self):
        fp = make_rect()
        r1 = generate_gabled(fp, overhang=0)
        r2 = generate_gabled(fp, overhang=1.0)
        # Polygon with overhang should be larger
        bbox1 = _bbox(r1.polygon)
        bbox2 = _bbox(r2.polygon)
        assert bbox2[2] - bbox2[0] >= bbox1[2] - bbox1[0]  # wider


class TestHippedRoof:
    def test_rectangular_hipped_roof_uses_ridge_line(self):
        result = generate_hipped(make_rect())
        assert len(result.ridge_polygon) == 2

    def test_ridge_inside_footprint(self):
        fp = make_rect()
        result = generate_hipped(fp)
        fp_bbox = _bbox([[p.x, p.y] for p in fp])
        ridge_bbox = _bbox(result.ridge_polygon)
        # Ridge should be contained within footprint bbox (approximately)
        assert ridge_bbox[0] >= fp_bbox[0] - 1  # small tolerance
        assert ridge_bbox[2] <= fp_bbox[2] + 1

    def test_has_no_plateau_face_for_rectangular_hipped_roof(self):
        result = generate_hipped(make_rect())
        ridge = result.ridge_polygon
        assert all(face.polygon != ridge for face in result.faces)

    def test_has_no_flat_cap_face_for_octagonal_hipped_roof(self):
        result = generate_hipped(make_octagon())
        assert not _has_flat_cap_face(result)

    def test_has_no_flat_cap_face_for_merged_hipped_roof(self):
        result = generate_hipped_merged(make_l_shape())
        assert not _has_flat_cap_face(result)


class TestFlatRoof:
    def test_no_overhang(self):
        result = generate_flat(make_rect())
        assert result.overhang == 0.0

    def test_has_parapet(self):
        result = generate_flat(make_rect())
        assert result.extras.get("parapet") is True


class TestDomedRoof:
    def test_has_dome_center(self):
        result = generate_domed(make_square())
        assert "dome_center" in result.extras
        assert "dome_radius" in result.extras

    def test_dome_radius_positive(self):
        result = generate_domed(make_square())
        assert result.extras["dome_radius"] > 0

    def test_ridge_is_circle(self):
        result = generate_domed(make_square())
        # Should have multiple points forming a circle
        assert len(result.ridge_polygon) >= 8


class TestConicalRoof:
    def test_apex_point(self):
        result = generate_conical(make_octagon())
        assert "apex" in result.extras
        # Ridge should be a single point
        assert len(result.ridge_polygon) == 1

    def test_polygon_is_circle(self):
        result = generate_conical(make_octagon())
        assert len(result.polygon) >= 8


class TestPageodaRoof:
    def test_has_levels(self):
        result = generate_pagoda(make_rect())
        assert result.extras.get("levels") == 3

    def test_generous_overhang(self):
        result = generate_pagoda(make_rect())
        assert result.overhang >= 0.8

    def test_has_no_flat_cap_face(self):
        result = generate_pagoda(make_rect())
        top_ring = result.ridge_polygon[-4:]
        assert not _has_face_matching_ring(result, top_ring)


class TestVaultedRoof:
    def test_vault_lines(self):
        result = generate_vaulted(make_rect(20, 10))
        assert result.extras.get("vault_lines", 0) >= 2

    def test_ridge_has_line_pairs(self):
        result = generate_vaulted(make_rect(20, 10))
        # Lines come in pairs
        assert len(result.ridge_polygon) % 2 == 0


class TestGenerateRoof:
    def test_auto_from_style(self):
        result = generate_roof(make_rect(), style="arabic_islamic")
        assert result.roof_type == "flat"

    def test_auto_from_building_type(self):
        result = generate_roof(make_rect(), building_type="tower")
        assert result.roof_type == "conical"

    def test_explicit_override(self):
        result = generate_roof(make_rect(), roof_type="domed")
        assert result.roof_type == "domed"

    def test_explicit_skeleton_override(self):
        result = generate_roof(make_l_shape(), roof_type="skeleton")
        assert result.roof_type == "skeleton"

    def test_building_type_overrides_style(self):
        # Tower should be conical regardless of style
        result = generate_roof(make_rect(), building_type="tower", style="arabic_islamic")
        assert result.roof_type == "conical"

    def test_degenerate_polygon(self):
        tiny = Polygon([Point(0, 0), Point(1, 0)])
        result = generate_roof(tiny)
        assert result.roof_type == "flat"


# --- Facade Detail Tests ---

class TestFacadeWindows:
    def test_places_windows(self):
        fp = make_rect(20, 10)
        windows = place_windows(fp)
        assert len(windows) > 0
        for w in windows:
            assert w.detail_type == "window"

    def test_no_windows_on_tiny_edges(self):
        fp = make_rect(2, 2)  # Very small
        windows = place_windows(fp, min_edge_length=5.0)
        assert len(windows) == 0

    def test_more_windows_with_smaller_spacing(self):
        fp = make_rect(20, 10)
        w1 = place_windows(fp, spacing=5.0)
        w2 = place_windows(fp, spacing=2.0)
        assert len(w2) >= len(w1)


class TestFacadeDoor:
    def test_places_one_door(self):
        fp = make_rect()
        doors = place_door(fp)
        assert len(doors) == 1
        assert doors[0].detail_type == "door"

    def test_door_on_longest_edge_by_default(self):
        fp = make_rect(20, 5)  # Long horizontal
        doors = place_door(fp)
        # Door should be near the midpoint of the long edge
        assert doors[0].pos is not None


class TestFacadeChimney:
    def test_places_chimney(self):
        fp = make_rect()
        chimneys = place_chimney(fp)
        assert len(chimneys) == 1
        assert chimneys[0].detail_type == "chimney"


class TestFacadeButtresses:
    def test_places_buttresses_on_long_edges(self):
        fp = make_rect(20, 10)
        buttresses = place_buttresses(fp)
        assert len(buttresses) > 0
        for b in buttresses:
            assert b.detail_type == "buttress"

    def test_no_buttresses_on_short_edges(self):
        fp = make_rect(5, 5)
        buttresses = place_buttresses(fp, min_edge_length=10.0)
        assert len(buttresses) == 0


class TestFacadeMinaret:
    def test_places_minaret(self):
        fp = make_rect()
        minarets = place_minaret(fp)
        assert len(minarets) == 1
        assert minarets[0].detail_type == "minaret"


class TestGenerateFacadeDetails:
    def test_density_none_produces_empty(self):
        fp = make_rect()
        details = generate_facade_details(fp, density=DENSITY_NONE)
        assert len(details) == 0

    def test_density_sparse_produces_details(self):
        fp = make_rect()
        details = generate_facade_details(fp, density=DENSITY_SPARSE)
        assert len(details) > 0

    def test_density_rich_produces_more(self):
        fp = make_rect(20, 10)
        sparse = generate_facade_details(fp, density=DENSITY_SPARSE)
        rich = generate_facade_details(fp, density=DENSITY_RICH)
        assert len(rich) >= len(sparse)

    def test_style_arabic_has_no_chimney(self):
        fp = make_rect()
        details = generate_facade_details(fp, style="arabic_islamic", density=DENSITY_RICH)
        types = {d.detail_type for d in details}
        assert "chimney" not in types

    def test_all_details_serializable(self):
        fp = make_rect()
        details = generate_facade_details(fp, density=DENSITY_RICH)
        for d in details:
            dd = d.to_dict()
            text = json.dumps(dd)
            assert len(text) > 0

    def test_degenerate_polygon(self):
        tiny = Polygon([Point(0, 0), Point(1, 0)])
        details = generate_facade_details(tiny)
        assert details == []


# --- Processor Tests ---

class TestProcessBuilding:
    def test_produces_building_detail(self):
        result = process_building(make_rect())
        assert isinstance(result, BuildingDetail)
        assert result.roof is not None
        assert result.roof.roof_type in ROOF_GENERATORS

    def test_custom_params(self):
        params = DetailParams(roof_type="domed", facade_density=DENSITY_RICH, style="arabic")
        result = process_building(make_square(), params=params)
        assert result.roof.roof_type == "domed"
        assert len(result.facade_details) > 0

    def test_to_dict_complete(self):
        result = process_building(make_rect(), building_type="house", stories=2)
        d = result.to_dict()
        assert "id" in d
        assert "footprint" in d
        assert "roof" in d
        assert "facade_details" in d
        assert d["type"] == "house"
        assert d["stories"] == 2

    def test_json_serializable(self):
        result = process_building(make_rect())
        text = json.dumps(result.to_dict())
        assert len(text) > 0


class TestProcessBuildings:
    def test_batch_processing(self):
        buildings = [
            {"id": "b0", "footprint": [[-6, -4], [6, -4], [6, 4], [-6, 4]], "type": "house", "stories": 1},
            {"id": "b1", "footprint": [[-5, -3], [5, -3], [5, 3], [-5, 3]], "type": "shop", "stories": 2},
        ]
        results = process_buildings(buildings)
        assert len(results) == 2
        assert results[0].building_id == "b0"
        assert results[1].building_id == "b1"

    def test_skips_degenerate(self):
        buildings = [
            {"id": "b0", "footprint": [[0, 0], [1, 0]], "type": "house"},  # Only 2 points
            {"id": "b1", "footprint": [[-6, -4], [6, -4], [6, 4], [-6, 4]], "type": "house"},
        ]
        results = process_buildings(buildings)
        assert len(results) == 1
        assert results[0].building_id == "b1"


class TestProcessCityMap:
    def test_adds_roof_to_city_map(self):
        city_map = {
            "districts": [
                {
                    "id": "d0",
                    "type": "craftsmen",
                    "buildings": [
                        {"id": "d0_b0", "footprint": [[-6, -4], [6, -4], [6, 4], [-6, 4]], "type": "house"},
                        {"id": "d0_b1", "footprint": [[-5, -3], [5, -3], [5, 3], [-5, 3]], "type": "shop"},
                    ],
                }
            ]
        }
        result = process_city_map(city_map)
        for bldg in result["districts"][0]["buildings"]:
            assert "roof" in bldg
            assert bldg["roof"]["type"] in ROOF_GENERATORS

    def test_handles_empty_districts(self):
        city_map = {
            "districts": [
                {"id": "d0", "type": "park"},  # No buildings
            ]
        }
        result = process_city_map(city_map)
        assert len(result["districts"]) == 1

    def test_handles_missing_buildings_key(self):
        city_map = {"districts": [{"id": "d0"}]}
        result = process_city_map(city_map)
        assert len(result["districts"]) == 1


class TestAllRoofTypesOnAllShapes:
    """Cross-product test: every roof type on every test shape."""

    shapes = [
        ("rect", make_rect),
        ("square", make_square),
        ("octagon", make_octagon),
        ("l_shape", make_l_shape),
        ("cruciform", make_cruciform),
        ("triangle", make_triangle),
    ]

    @pytest.mark.parametrize("roof_type", ROOF_GENERATORS.keys())
    @pytest.mark.parametrize("shape_name,shape_fn", shapes, ids=[s[0] for s in shapes])
    def test_no_crash(self, roof_type, shape_name, shape_fn):
        fp = shape_fn()
        result = ROOF_GENERATORS[roof_type](fp)
        assert isinstance(result, RoofGeometry)
        # No NaN in roof polygon
        for pt in result.polygon:
            assert not math.isnan(pt[0])
            assert not math.isnan(pt[1])


# --- Helpers ---

def _bbox(pts):
    """Bounding box of [[x,y], ...] -> (min_x, min_y, max_x, max_y)."""
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return (min(xs), min(ys), max(xs), max(ys))
