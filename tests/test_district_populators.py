"""Tests for M4 District Population — all populators."""

import pytest

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.district.base import PopulatorParams, PopulatorResult
from town_generator.district.registry import POPULATORS, get_populator
from town_generator.district.organic_alley import OrganicAlleyPopulator
from town_generator.district.grid import GridPopulator
from town_generator.district.courtyard import CourtyardPopulator
from town_generator.district.disk_packing import DiskPackingPopulator
from town_generator.district.bazaar import BazaarPopulator
from town_generator.district.monastic import MonasticPopulator
from town_generator.district.farm_plot import FarmPlotPopulator
from town_generator.district.military import MilitaryPopulator
from town_generator.district.palace import PalacePopulator


# --- Test fixtures ---

def make_rect(w=50, h=40, cx=0, cy=0):
    """Simple rectangular polygon centered at (cx, cy)."""
    return Polygon([
        Point(cx - w / 2, cy - h / 2),
        Point(cx + w / 2, cy - h / 2),
        Point(cx + w / 2, cy + h / 2),
        Point(cx - w / 2, cy + h / 2),
    ])


def make_hexagon(r=30, cx=0, cy=0):
    """Regular hexagonal polygon."""
    import math
    pts = [Point(cx + r * math.cos(i * math.pi / 3), cy + r * math.sin(i * math.pi / 3))
           for i in range(6)]
    return Polygon(pts)


def make_irregular():
    """Irregular 7-sided polygon."""
    return Polygon([
        Point(-25, -20), Point(10, -25), Point(30, -10),
        Point(35, 15), Point(15, 30), Point(-10, 25), Point(-30, 10),
    ])


def default_params(seed=42):
    return PopulatorParams(
        min_area=20.0, grid_chaos=0.4, size_chaos=0.4,
        empty_prob=0.04, density=0.6, alley_width=0.8, seed=seed,
    )


# --- Registry tests ---

class TestRegistry:
    def test_all_populators_registered(self):
        expected = {
            "organic_alley", "grid", "courtyard", "disk_packing",
            "bazaar", "monastic", "farm_plot", "military", "palace",
        }
        assert expected == set(POPULATORS.keys())

    def test_get_populator_default(self):
        pop = get_populator("unknown_type", "unknown_style")
        assert pop.name == "organic_alley"

    def test_get_populator_style_mapping(self):
        pop = get_populator("craftsmen", "roman")
        assert pop.name == "grid"

    def test_get_populator_type_fallback(self):
        pop = get_populator("military", "generic")
        assert pop.name == "military"

    def test_get_populator_arabic_market(self):
        pop = get_populator("market", "arabic_islamic")
        assert pop.name == "bazaar"

    def test_get_populator_mongol(self):
        pop = get_populator("craftsmen", "mongol")
        assert pop.name == "disk_packing"


# --- Individual populator tests ---

class TestOrganicAlleyPopulator:
    def test_produces_buildings(self):
        pop = OrganicAlleyPopulator()
        result = pop.populate(make_rect(), default_params())
        assert isinstance(result, PopulatorResult)
        assert len(result.buildings) > 0

    def test_deterministic(self):
        pop = OrganicAlleyPopulator()
        r1 = pop.populate(make_rect(), default_params(seed=100))
        r2 = pop.populate(make_rect(), default_params(seed=100))
        assert len(r1.buildings) == len(r2.buildings)

    def test_different_seeds_differ(self):
        pop = OrganicAlleyPopulator()
        r1 = pop.populate(make_rect(), default_params(seed=1))
        r2 = pop.populate(make_rect(), default_params(seed=999))
        # Very likely different building counts (not guaranteed but extremely likely)
        coords1 = [(b.footprint[0].x, b.footprint[0].y) for b in r1.buildings]
        coords2 = [(b.footprint[0].x, b.footprint[0].y) for b in r2.buildings]
        assert coords1 != coords2

    def test_hexagon_input(self):
        pop = OrganicAlleyPopulator()
        result = pop.populate(make_hexagon(), default_params())
        assert len(result.buildings) > 0

    def test_irregular_input(self):
        pop = OrganicAlleyPopulator()
        result = pop.populate(make_irregular(), default_params())
        assert len(result.buildings) > 0

    def test_high_chaos(self):
        pop = OrganicAlleyPopulator()
        params = default_params()
        params.grid_chaos = 0.9
        params.size_chaos = 0.9
        result = pop.populate(make_rect(), params)
        assert len(result.buildings) > 0


class TestGridPopulator:
    def test_produces_buildings(self):
        pop = GridPopulator()
        result = pop.populate(make_rect(), default_params())
        assert len(result.buildings) > 0

    def test_buildings_are_grid_aligned(self):
        pop = GridPopulator()
        result = pop.populate(make_rect(), default_params())
        for b in result.buildings:
            assert b.style_hints.get("grid_aligned") is True

    def test_building_type_is_insula(self):
        pop = GridPopulator()
        result = pop.populate(make_rect(), default_params())
        for b in result.buildings:
            assert b.building_type == "insula"

    def test_density_affects_count(self):
        pop = GridPopulator()
        params_sparse = default_params()
        params_sparse.density = 0.2
        params_dense = default_params()
        params_dense.density = 0.9
        r_sparse = pop.populate(make_rect(80, 60), params_sparse)
        r_dense = pop.populate(make_rect(80, 60), params_dense)
        assert len(r_dense.buildings) >= len(r_sparse.buildings)


class TestCourtyardPopulator:
    def test_produces_buildings_and_courtyard(self):
        pop = CourtyardPopulator()
        result = pop.populate(make_rect(), default_params())
        assert len(result.buildings) > 0
        assert len(result.alleys) > 0  # courtyard is recorded as alley

    def test_buildings_have_courtyard_hint(self):
        pop = CourtyardPopulator()
        result = pop.populate(make_rect(), default_params())
        for b in result.buildings:
            assert b.style_hints.get("has_courtyard") is True

    def test_hexagon_input(self):
        pop = CourtyardPopulator()
        result = pop.populate(make_hexagon(), default_params())
        assert len(result.buildings) > 0


class TestDiskPackingPopulator:
    def test_produces_circular_buildings(self):
        pop = DiskPackingPopulator()
        result = pop.populate(make_rect(60, 60), default_params())
        assert len(result.buildings) > 0
        for b in result.buildings:
            assert b.building_type == "ger"
            assert b.style_hints.get("circular") is True

    def test_buildings_have_radius(self):
        pop = DiskPackingPopulator()
        result = pop.populate(make_rect(60, 60), default_params())
        for b in result.buildings:
            assert "radius" in b.style_hints

    def test_no_overlap(self):
        """Buildings should not overlap (centers separated by sum of radii + gap)."""
        pop = DiskPackingPopulator()
        params = default_params()
        params.density = 0.8
        result = pop.populate(make_rect(80, 80), params)
        import math
        centers = []
        for b in result.buildings:
            fp = b.footprint
            cx = sum(v.x for v in fp) / len(fp)
            cy = sum(v.y for v in fp) / len(fp)
            r = b.style_hints.get("radius", 3)
            centers.append((cx, cy, r))
        # Check pairwise distances
        for i in range(len(centers)):
            for j in range(i + 1, len(centers)):
                dist = math.sqrt(
                    (centers[i][0] - centers[j][0]) ** 2 +
                    (centers[i][1] - centers[j][1]) ** 2
                )
                min_dist = centers[i][2] + centers[j][2]
                assert dist >= min_dist * 0.9  # slight tolerance


class TestBazaarPopulator:
    def test_produces_stalls_and_alleys(self):
        pop = BazaarPopulator()
        result = pop.populate(make_rect(60, 40), default_params())
        assert len(result.buildings) > 0
        assert len(result.alleys) > 0  # at least main artery

    def test_stall_types(self):
        pop = BazaarPopulator()
        result = pop.populate(make_rect(60, 40), default_params())
        for b in result.buildings:
            assert b.building_type == "shop"


class TestMonasticPopulator:
    def test_produces_campus_buildings(self):
        pop = MonasticPopulator()
        result = pop.populate(make_rect(60, 50), default_params())
        assert len(result.buildings) > 0
        types = {b.building_type for b in result.buildings}
        assert "chapel" in types

    def test_has_courtyard(self):
        pop = MonasticPopulator()
        result = pop.populate(make_rect(60, 50), default_params())
        assert len(result.alleys) > 0  # cloister courtyard


class TestFarmPlotPopulator:
    def test_produces_farmhouse_and_fields(self):
        pop = FarmPlotPopulator()
        result = pop.populate(make_rect(80, 60), default_params())
        assert len(result.buildings) > 0
        types = {b.building_type for b in result.buildings}
        assert "farmhouse" in types or "field" in types

    def test_field_buildings_zero_stories(self):
        pop = FarmPlotPopulator()
        result = pop.populate(make_rect(80, 60), default_params())
        for b in result.buildings:
            if b.building_type == "field":
                assert b.stories == 0


class TestMilitaryPopulator:
    def test_produces_barracks(self):
        pop = MilitaryPopulator()
        result = pop.populate(make_rect(60, 50), default_params())
        assert len(result.buildings) > 0
        types = {b.building_type for b in result.buildings}
        assert "barracks" in types

    def test_has_parade_ground(self):
        pop = MilitaryPopulator()
        result = pop.populate(make_rect(60, 50), default_params())
        assert len(result.alleys) > 0  # parade ground


class TestPalacePopulator:
    def test_produces_palace_buildings(self):
        pop = PalacePopulator()
        result = pop.populate(make_rect(60, 50), default_params())
        assert len(result.buildings) > 0
        types = {b.building_type for b in result.buildings}
        assert "great_hall" in types

    def test_has_courtyard(self):
        pop = PalacePopulator()
        result = pop.populate(make_rect(60, 50), default_params())
        assert len(result.alleys) > 0


# --- Serialization tests ---

class TestSerialization:
    def test_to_dict_structure(self):
        pop = OrganicAlleyPopulator()
        result = pop.populate(make_rect(), default_params())
        d = result.to_dict()
        assert "buildings" in d
        assert "alleys" in d
        assert len(d["buildings"]) > 0
        bldg = d["buildings"][0]
        assert "id" in bldg
        assert "footprint" in bldg
        assert "type" in bldg
        assert isinstance(bldg["footprint"], list)
        assert isinstance(bldg["footprint"][0], list)
        assert len(bldg["footprint"][0]) == 2

    def test_all_populators_serializable(self):
        """Every populator should produce JSON-serializable output."""
        import json
        poly = make_rect(60, 50)
        params = default_params()
        for name, pop in POPULATORS.items():
            result = pop.populate(poly, params)
            d = result.to_dict()
            # Should not raise
            text = json.dumps(d)
            assert len(text) > 0, f"Populator {name} produced empty JSON"


# --- Tiny polygon edge case ---

class TestEdgeCases:
    def test_tiny_polygon(self):
        """Populators should handle polygons too small for buildings."""
        tiny = Polygon([Point(0, 0), Point(2, 0), Point(2, 2), Point(0, 2)])
        params = default_params()
        for name, pop in POPULATORS.items():
            result = pop.populate(tiny, params)
            assert isinstance(result, PopulatorResult)

    def test_triangle_polygon(self):
        """Populators should handle triangular polygons."""
        tri = Polygon([Point(0, 0), Point(40, 0), Point(20, 35)])
        params = default_params()
        for name, pop in POPULATORS.items():
            result = pop.populate(tri, params)
            assert isinstance(result, PopulatorResult)
