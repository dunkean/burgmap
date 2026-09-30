"""End-to-end city-scale terrain generation tests."""

from town_generator.terrain.world_map import WorldMap, TERRAIN_TYPES
from town_generator.terrain.ground_cover import COVER_TYPES


def test_worldmap_determinism():
    """Same seed produces identical WorldMap."""
    w1 = WorldMap(seed=42, size=64)
    w2 = WorldMap(seed=42, size=64)
    assert w1.to_dict() == w2.to_dict()


def test_worldmap_sizes():
    """WorldMap generates correct grid dimensions."""
    for sz in [64, 128]:
        w = WorldMap(seed=1, size=sz)
        assert len(w.elevation) == sz
        assert len(w.elevation[0]) == sz
        assert len(w.water) == sz
        assert len(w.terrain) == sz
        assert len(w.ground_cover) == sz


def test_elevation_range():
    """All elevation values in [0, 1]."""
    w = WorldMap(seed=42, size=64)
    for row in w.elevation:
        for v in row:
            assert 0.0 <= v <= 1.0, f"Elevation {v} out of range"


def test_terrain_types_valid():
    """All terrain types are valid strings."""
    w = WorldMap(seed=42, size=64)
    valid = set(TERRAIN_TYPES)
    for row in w.terrain:
        for t in row:
            assert t in valid, f"Unknown terrain type: {t}"


def test_ground_cover_valid():
    """All ground cover types are valid."""
    w = WorldMap(seed=42, size=64)
    valid = set(COVER_TYPES) | {"water"}
    for row in w.ground_cover:
        for gc in row:
            assert gc in valid, f"Unknown ground cover: {gc}"


def test_coast_creates_water():
    """Coast mode should produce water cells on the coast side."""
    w = WorldMap(seed=42, size=64, coast=True, coast_direction=2)
    # Bottom edge (south coast) should have water
    water_count = sum(1 for x in range(64) if w.water[63][x])
    assert water_count > 30, "South coast should have water on bottom edge"


def test_no_coast_no_coastal_water():
    """Without coast, water only comes from rivers."""
    w = WorldMap(seed=42, size=64, coast=False, river_count=0)
    water_count = sum(1 for y in range(64) for x in range(64) if w.water[y][x])
    assert water_count == 0, "No coast + no rivers = no water"


def test_rivers_generated():
    """Rivers are generated when river_count > 0."""
    w = WorldMap(seed=42, size=128, river_count=2)
    assert len(w.rivers) > 0, "Should generate at least one river"


def test_rivers_create_wide_water():
    """Rivers should create wide bands of water cells."""
    w = WorldMap(seed=42, size=128, river_count=1, river_width_m=60)
    water_count = sum(1 for y in range(128) for x in range(128) if w.water[y][x])
    assert water_count > 200, "Wide river should create substantial water area"


def test_no_rivers_when_zero():
    """No rivers when river_count=0."""
    w = WorldMap(seed=42, size=64, river_count=0)
    assert len(w.rivers) == 0


def test_no_interference_with_city_prng():
    """Terrain generation must NOT consume city PRNG state."""
    from town_generator.utils.random import Random

    Random.reset(42)
    seq_before = [Random.float() for _ in range(10)]

    Random.reset(42)
    WorldMap(seed=99, size=64)
    seq_after = [Random.float() for _ in range(10)]

    assert seq_before == seq_after, "WorldMap must not touch the global Random state"


def test_json_schema():
    """WorldMap JSON has all required top-level keys."""
    w = WorldMap(seed=42, size=64)
    d = w.to_dict()
    required_keys = {
        "size", "map_extent_m", "cell_size_m", "seed", "elevation", "water",
        "terrain", "ground_cover", "rivers", "coastline",
    }
    assert required_keys <= set(d.keys()), f"Missing keys: {required_keys - set(d.keys())}"


def test_coastline_with_coast():
    """Coast mode should produce coastline cells."""
    w = WorldMap(seed=42, size=64, coast=True)
    assert len(w.coastline) > 0, "Coast should produce coastline"


def test_coastline_with_river():
    """Rivers should produce coastline (bank) cells."""
    w = WorldMap(seed=42, size=128, river_count=1, river_width_m=30)
    assert len(w.coastline) > 0, "River should produce bank cells"


def test_cell_size_computed():
    """cell_size_m is derived from map_extent_m / grid size."""
    w = WorldMap(seed=42, size=128, map_extent_m=2000)
    assert w.cell_size_m == 2000 / 128
    d = w.to_dict()
    assert d["map_extent_m"] == 2000
    assert d["cell_size_m"] == round(2000 / 128, 2)


def test_different_seeds_produce_different_terrain():
    """Different seeds should produce different elevation grids."""
    w1 = WorldMap(seed=1, size=64)
    w2 = WorldMap(seed=2, size=64)
    assert w1.elevation != w2.elevation
