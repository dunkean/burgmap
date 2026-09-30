"""M2 Regional Layout tests — single city placement, landmarks, satellites."""

import math

from town_generator.terrain.world_map import WorldMap
from town_generator.region.region import Region
from town_generator.region.road_network import (
    astar, douglas_peucker, chaikin_smooth,
)


# ── Fixtures ────────────────────────────────────────────────────────

def _make_world(seed=42, size=64, **kw):
    return WorldMap(seed=seed, size=size, **kw)


# ── Region Determinism ──────────────────────────────────────────────

def test_region_determinism():
    """Same seed produces identical Region."""
    wm = _make_world(seed=42)
    r1 = Region(world_map=wm, seed=42)
    r2 = Region(world_map=wm, seed=42)
    assert r1.to_dict() == r2.to_dict()


def test_region_different_terrain():
    """Different terrain seeds produce different city placements."""
    wm1 = _make_world(seed=1)
    wm2 = _make_world(seed=2)
    r1 = Region(world_map=wm1, seed=42)
    r2 = Region(world_map=wm2, seed=42)
    assert (r1.city["x"], r1.city["y"]) != (r2.city["x"], r2.city["y"])


# ── City Placement ──────────────────────────────────────────────────

def test_city_placed():
    """Region always places exactly one city."""
    wm = _make_world()
    r = Region(world_map=wm, seed=42)
    assert r.city
    assert "x" in r.city and "y" in r.city


def test_city_not_on_water():
    """City should not be placed on a water cell."""
    wm = _make_world(river_count=2)
    r = Region(world_map=wm, seed=42)
    assert not wm.water[r.city["y"]][r.city["x"]]


def test_city_has_required_fields():
    """City dict has all required fields."""
    wm = _make_world()
    r = Region(world_map=wm, seed=42)
    required = {"id", "x", "y", "type", "size", "specialization", "style", "features"}
    assert required <= set(r.city.keys())


def test_city_features():
    """City features dict has expected keys."""
    wm = _make_world()
    r = Region(world_map=wm, seed=42)
    feat_keys = {"has_walls", "has_castle", "has_harbor", "dominant_resource"}
    assert feat_keys <= set(r.city["features"].keys())


# ── Landmarks ───────────────────────────────────────────────────────

def test_landmarks_detected():
    """Region detects at least the market landmark (city center)."""
    wm = _make_world()
    r = Region(world_map=wm, seed=42)
    types = [lm["type"] for lm in r.landmarks]
    assert "market" in types


def test_castle_landmark():
    """Castle landmark should exist and be at elevated position."""
    wm = _make_world()
    r = Region(world_map=wm, seed=42)
    castles = [lm for lm in r.landmarks if lm["type"] == "castle"]
    assert len(castles) == 1
    assert "elevation" in castles[0]


def test_landmarks_within_city_radius():
    """All landmarks should be within or near the city radius."""
    wm = _make_world(size=128)
    r = Region(world_map=wm, seed=42, city_radius=20)
    cx, cy = r.city["x"], r.city["y"]
    for lm in r.landmarks:
        dist = math.sqrt((lm["x"] - cx) ** 2 + (lm["y"] - cy) ** 2)
        # Allow some slack beyond radius for perimeter landmarks
        assert dist <= 25, f"{lm['type']} too far: {dist:.1f}"


def test_landmark_has_required_fields():
    """Each landmark has type, x, y."""
    wm = _make_world()
    r = Region(world_map=wm, seed=42)
    for lm in r.landmarks:
        assert "type" in lm
        assert "x" in lm
        assert "y" in lm


def test_docks_near_water():
    """If docks landmark exists, it should be near water."""
    wm = _make_world(river_count=1, river_width_m=60)
    r = Region(world_map=wm, seed=42, city_radius=20)
    docks = [lm for lm in r.landmarks if lm["type"] == "docks"]
    if docks:
        dx, dy = docks[0]["x"], docks[0]["y"]
        # Check that at least one neighbor is water
        near_water = False
        for ddx, ddy in [(-1, 0), (1, 0), (0, -1), (0, 1), (-2, 0), (2, 0), (0, -2), (0, 2)]:
            nx, ny = dx + ddx, dy + ddy
            if 0 <= nx < wm.size and 0 <= ny < wm.size and wm.water[ny][nx]:
                near_water = True
                break
        assert near_water, "Docks should be adjacent to water"


# ── Score Map ───────────────────────────────────────────────────────

def test_score_map_dimensions():
    """Score map has correct dimensions."""
    wm = _make_world(size=64)
    r = Region(world_map=wm, seed=42)
    assert len(r.score_map) == 64
    assert len(r.score_map[0]) == 64


def test_score_map_range():
    """All scores are in [0, 1]."""
    wm = _make_world(size=64)
    r = Region(world_map=wm, seed=42)
    for row in r.score_map:
        for v in row:
            assert 0.0 <= v <= 1.0, f"Score {v} out of range"


def test_water_cells_score_zero():
    """Water cells should have score 0."""
    wm = _make_world(size=64, river_count=1, river_width_m=60)
    r = Region(world_map=wm, seed=42)
    for y in range(64):
        for x in range(64):
            if wm.water[y][x]:
                assert r.score_map[y][x] == 0.0


# ── Satellites ──────────────────────────────────────────────────────

def test_no_satellites_by_default():
    """Default is 0 satellites."""
    wm = _make_world()
    r = Region(world_map=wm, seed=42)
    assert len(r.satellites) == 0


def test_satellites_placed():
    """Satellites are placed when requested."""
    wm = _make_world(size=128)
    r = Region(world_map=wm, seed=42, n_satellites=3, city_radius=15)
    assert len(r.satellites) > 0
    assert len(r.satellites) <= 3


def test_satellites_outside_city():
    """Satellites should be outside the city radius."""
    wm = _make_world(size=128)
    cr = 15
    r = Region(world_map=wm, seed=42, n_satellites=3, city_radius=cr)
    cx, cy = r.city["x"], r.city["y"]
    for sat in r.satellites:
        dist = math.sqrt((sat["x"] - cx) ** 2 + (sat["y"] - cy) ** 2)
        assert dist > cr, f"Satellite at ({sat['x']},{sat['y']}) inside city radius"


def test_satellites_are_small():
    """Satellites should be hamlets or villages, not cities."""
    wm = _make_world(size=128)
    r = Region(world_map=wm, seed=42, n_satellites=3, city_radius=15)
    for sat in r.satellites:
        assert sat["type"] in ("hamlet", "village")


def test_satellites_not_on_water():
    """Satellites should not be on water."""
    wm = _make_world(size=128, river_count=2)
    r = Region(world_map=wm, seed=42, n_satellites=3, city_radius=15)
    for sat in r.satellites:
        assert not wm.water[sat["y"]][sat["x"]]


# ── Roads ───────────────────────────────────────────────────────────

def test_roads_connect_satellites_to_city():
    """Each satellite gets a road to the city."""
    wm = _make_world(size=128)
    r = Region(world_map=wm, seed=42, n_satellites=2, city_radius=15)
    assert len(r.roads) == len(r.satellites)
    for road in r.roads:
        assert road["to"] == "city"


def test_roads_have_paths():
    """Each road has a non-empty path."""
    wm = _make_world(size=128)
    r = Region(world_map=wm, seed=42, n_satellites=2, city_radius=15)
    for road in r.roads:
        assert len(road["path"]) >= 2


def test_no_roads_without_satellites():
    """No roads if no satellites."""
    wm = _make_world()
    r = Region(world_map=wm, seed=42, n_satellites=0)
    assert len(r.roads) == 0


def test_no_roads_when_disabled():
    """No roads when build_roads=False."""
    wm = _make_world(size=128)
    r = Region(world_map=wm, seed=42, n_satellites=2, build_roads=False)
    assert len(r.roads) == 0


# ── A* Pathfinding ──────────────────────────────────────────────────

def test_astar_simple():
    """A* finds a path on a flat cost map."""
    size = 20
    cost = [[1.0] * size for _ in range(size)]
    water = [[False] * size for _ in range(size)]
    path = astar(cost, size, water, (0, 0), (19, 19))
    assert len(path) >= 2
    assert path[0] == (0, 0)
    assert path[-1] == (19, 19)


def test_astar_avoids_water():
    """A* prefers paths that avoid water cells."""
    size = 20
    cost = [[1.0] * size for _ in range(size)]
    water = [[False] * size for _ in range(size)]
    for y in range(size):
        if y != 10:
            water[y][10] = True
            cost[y][10] = 10.0

    path = astar(cost, size, water, (0, 10), (19, 10))
    assert len(path) >= 2
    water_crossings = sum(1 for x, y in path if water[y][x])
    assert water_crossings == 0


# ── Path Smoothing ──────────────────────────────────────────────────

def test_douglas_peucker():
    """Douglas-Peucker reduces straight line to endpoints."""
    points = [(float(i), 0.0) for i in range(20)]
    simplified = douglas_peucker(points, epsilon=0.5)
    assert len(simplified) == 2


def test_chaikin_increases_points():
    """Chaikin smoothing increases point count."""
    pts = [(0.0, 0.0), (5.0, 10.0), (10.0, 0.0)]
    smoothed = chaikin_smooth(pts, iterations=2)
    assert len(smoothed) > len(pts)


def test_chaikin_preserves_endpoints():
    """Chaikin preserves start and end points."""
    pts = [(0.0, 0.0), (5.0, 10.0), (10.0, 0.0)]
    smoothed = chaikin_smooth(pts, iterations=2)
    assert smoothed[0] == pts[0]
    assert smoothed[-1] == pts[-1]


# ── JSON Schema ─────────────────────────────────────────────────────

def test_region_json_schema():
    """Region JSON has all required top-level keys."""
    wm = _make_world()
    r = Region(world_map=wm, seed=42)
    d = r.to_dict()
    required = {
        "seed", "world_map_seed", "world_map_size",
        "city", "landmarks", "satellites", "roads", "bridges", "score_map",
    }
    assert required <= set(d.keys()), f"Missing: {required - set(d.keys())}"


# ── PRNG Isolation ──────────────────────────────────────────────────

def test_no_interference_with_city_prng():
    """Region generation must NOT consume city PRNG state."""
    from town_generator.utils.random import Random

    Random.reset(42)
    seq_before = [Random.float() for _ in range(10)]

    Random.reset(42)
    Region(seed=99)
    seq_after = [Random.float() for _ in range(10)]

    assert seq_before == seq_after
