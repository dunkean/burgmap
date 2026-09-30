"""Tests for M3 — CityMap JSON export and cultural style system."""

import pytest
from town_generator.building.model import Model
from town_generator.styles.style import get_style, STYLES, CulturalStyle


# --- Style system ---

class TestStyleSystem:
    def test_all_styles_exist(self):
        expected = {"generic", "european_medieval", "arabic_islamic", "east_asian", "roman", "norse", "mongol"}
        assert expected == set(STYLES.keys())

    def test_get_style_returns_generic_for_unknown(self):
        s = get_style("nonexistent")
        assert s.id == "generic"

    def test_each_style_has_required_fields(self):
        for sid, style in STYLES.items():
            assert isinstance(style, CulturalStyle)
            assert style.id == sid
            assert style.name
            assert style.street_pattern in ("organic", "labyrinthine", "grid", "radial", "cluster", "open")
            assert style.wall_type in ("stone", "packed_earth", "palisade", "none")

    def test_landmark_labels_culturally_specific(self):
        arabic = get_style("arabic_islamic")
        assert arabic.landmarks.cathedral_label == "Mosque"
        assert arabic.landmarks.market_label == "Souk"

        roman = get_style("roman")
        assert roman.landmarks.cathedral_label == "Temple"
        assert roman.landmarks.market_label == "Forum"


# --- CityMap JSON export ---

class TestCityMapExport:
    def test_basic_export_has_required_keys(self):
        model = Model(n_patches=8, seed=42)
        cm = model.to_city_map()
        required = {"seed", "style", "bounds", "districts", "streets", "walls", "landmarks", "rivers", "coastline"}
        assert required <= set(cm.keys())

    def test_districts_have_required_fields(self):
        model = Model(n_patches=8, seed=42)
        cm = model.to_city_map()
        for d in cm["districts"]:
            assert "id" in d
            assert "type" in d
            assert "polygon" in d
            assert "center" in d
            assert "within_walls" in d
            assert "adjacent" in d
            assert len(d["polygon"]) >= 3
            assert len(d["center"]) == 2

    def test_district_types_are_valid(self):
        model = Model(n_patches=12, seed=42)
        cm = model.to_city_map()
        valid_types = {
            "craftsmen", "merchant", "cathedral", "administration", "slum",
            "patriciate", "market", "military", "park", "farm", "gate",
            "shanty_town", "castle", "residential", "empty",
        }
        for d in cm["districts"]:
            assert d["type"] in valid_types, f"Unknown district type: {d['type']}"

    def test_bounds_has_cx_cy_radius(self):
        model = Model(n_patches=10, seed=42)
        cm = model.to_city_map()
        b = cm["bounds"]
        assert "cx" in b and "cy" in b and "radius" in b
        assert isinstance(b["radius"], float)
        assert b["radius"] > 0

    def test_adjacency_is_symmetric(self):
        model = Model(n_patches=8, seed=42)
        cm = model.to_city_map()
        dist_map = {d["id"]: d for d in cm["districts"]}
        for d in cm["districts"]:
            for adj_id in d["adjacent"]:
                if adj_id in dist_map:
                    assert d["id"] in dist_map[adj_id]["adjacent"], \
                        f"{d['id']} lists {adj_id} as adjacent but not vice versa"

    def test_walls_present_when_enabled(self):
        model = Model(n_patches=10, seed=42, walls=True)
        cm = model.to_city_map()
        assert len(cm["walls"]) > 0
        wall = cm["walls"][0]
        assert "polygon" in wall
        assert "towers" in wall
        assert "gates" in wall
        assert "type" in wall

    def test_no_walls_when_disabled(self):
        model = Model(n_patches=10, seed=42, walls=False)
        cm = model.to_city_map()
        assert len(cm["walls"]) == 0

    def test_river_data_when_enabled(self):
        model = Model(n_patches=10, seed=42, river=True)
        cm = model.to_city_map()
        assert len(cm["rivers"]) > 0
        assert "path" in cm["rivers"][0]

    def test_coast_data_when_enabled(self):
        model = Model(n_patches=10, seed=42, coast=True)
        cm = model.to_city_map()
        assert len(cm["coastline"]) > 0
        assert len(cm["coast_water"]) > 0, "Coast water polygon must be exported"

    def test_bridge_data_with_river(self):
        model = Model(n_patches=12, seed=42, river=True, coast=True)
        cm = model.to_city_map()
        assert len(cm["rivers"]) > 0
        assert "bridges" in cm["rivers"][0]

    def test_buildings_present_in_districts(self):
        model = Model(n_patches=8, seed=42)
        cm = model.to_city_map()
        has_buildings = any(d.get("buildings") for d in cm["districts"])
        assert has_buildings, "Expected at least some districts to have buildings"

    def test_building_footprints_valid(self):
        model = Model(n_patches=8, seed=42)
        cm = model.to_city_map()
        for d in cm["districts"]:
            for bldg in d.get("buildings", []):
                assert "id" in bldg
                assert "footprint" in bldg
                assert len(bldg["footprint"]) >= 3

    def test_district_populator_metadata_present(self):
        model = Model(n_patches=8, seed=42)
        cm = model.to_city_map()
        assert any("populator" in d for d in cm["districts"])

    def test_citywide_district_populator_override(self):
        model = Model(n_patches=8, seed=42, district_populator="military")
        cm = model.to_city_map()
        assert any(d.get("populator") == "military" for d in cm["districts"])
        assert any(d.get("alleys") for d in cm["districts"])

    def test_citywide_roofscape_detail_present(self):
        model = Model(n_patches=8, seed=42, district_roofscape=True, district_roof_type="flat")
        cm = model.to_city_map()
        buildings = [building for district in cm["districts"] for building in district.get("buildings", [])]
        assert any("lot_footprint" in building for building in buildings)
        assert any("roof" in building for building in buildings if building.get("stories", 1) > 0)

    def test_landmarks_detected(self):
        model = Model(n_patches=12, seed=42, plaza=True, walls=True, citadel=True, temple=True)
        cm = model.to_city_map()
        landmark_types = {lm["type"] for lm in cm["landmarks"]}
        assert "market" in landmark_types, "Expected market landmark when plaza enabled"


# --- Style integration ---

class TestStyleIntegration:
    def test_generic_style_by_default(self):
        model = Model(n_patches=8, seed=42)
        assert model.style.id == "generic"
        cm = model.to_city_map()
        assert cm["style"] == "generic"

    def test_style_parameter_propagates(self):
        model = Model(n_patches=8, seed=42, style="arabic_islamic")
        assert model.style.id == "arabic_islamic"
        cm = model.to_city_map()
        assert cm["style"] == "arabic_islamic"

    def test_style_affects_wall_type(self):
        model = Model(n_patches=10, seed=42, walls=True, style="norse")
        cm = model.to_city_map()
        if cm["walls"]:
            assert cm["walls"][0]["type"] == "palisade"

    def test_style_affects_landmark_labels(self):
        model = Model(n_patches=12, seed=42, plaza=True, temple=True, style="arabic_islamic")
        cm = model.to_city_map()
        for lm in cm["landmarks"]:
            if lm["type"] == "cathedral":
                assert lm["label"] == "Mosque"
            elif lm["type"] == "market":
                assert lm["label"] == "Souk"

    def test_all_styles_generate_without_error(self):
        for style_id in STYLES:
            model = Model(n_patches=8, seed=42, style=style_id)
            cm = model.to_city_map()
            assert len(cm["districts"]) > 0

    def test_style_does_not_break_seed_determinism(self):
        """Same seed + style = same output."""
        cm1 = Model(n_patches=10, seed=99, style="roman").to_city_map()
        cm2 = Model(n_patches=10, seed=99, style="roman").to_city_map()
        assert cm1["districts"] == cm2["districts"]
        assert cm1["streets"] == cm2["streets"]
