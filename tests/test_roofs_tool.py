import json
import math
import pytest
import random

from town_generator.detail.roof import ROOF_GENERATORS, generate_gabled, generate_skeleton
from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon


def make_concave_polygon():
    return Polygon([
        Point(-12, -8), Point(10, -8), Point(10, -2), Point(2, -2),
        Point(2, 8), Point(-12, 8),
    ])


def make_u_polygon():
    return Polygon([
        Point(-14, -12), Point(14, -12), Point(14, 12), Point(7, 12),
        Point(7, -2), Point(-7, -2), Point(-7, 12), Point(-14, 12),
    ])


def make_problem_polygon():
    return Polygon([
        Point(5.46, -9.15), Point(7.28, -1.51), Point(12.41, 2.62), Point(8.88, 9.46),
        Point(-1.87, 11.54), Point(-10.27, 9.38), Point(-7.64, 2.42), Point(-14.66, -1.63),
        Point(-7.75, -12.42), Point(0.57, -8.67),
    ])


def make_random_radial_polygon(seed):
    rng = random.Random(seed)
    count = rng.randint(6, 10)
    radius = rng.uniform(8.0, 18.0)
    pts = []
    for i in range(count):
        angle = -math.pi / 2 + i * (2 * math.pi / count) + rng.uniform(-0.22, 0.22)
        dist = radius * rng.uniform(0.45, 1.1)
        pts.append(Point(
            round(math.cos(angle) * dist, 2),
            round(math.sin(angle) * dist, 2),
        ))
    return Polygon(pts)


def _point_in_polygon(point, polygon):
    x, y = point
    inside = False
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > y) != (yj > y)):
            x_cross = (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi
            if x < x_cross:
                inside = not inside
        j = i
    return inside


def _roof_covers_polygon(roof, samples=16):
    xs = [x for x, _ in roof.polygon]
    ys = [y for _, y in roof.polygon]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    step_x = (max_x - min_x) / samples
    step_y = (max_y - min_y) / samples
    for xi in range(samples):
        for yi in range(samples):
            pt = (min_x + (xi + 0.5) * step_x, min_y + (yi + 0.5) * step_y)
            if not _point_in_polygon(pt, roof.polygon):
                continue
            if not any(_point_in_polygon(pt, face.polygon) for face in roof.faces):
                return False
    return True


def test_generate_skeleton_handles_simple_concave_polygon():
    roof = generate_skeleton(make_concave_polygon())
    assert roof.roof_type == "skeleton"
    algo = roof.extras.get("algorithm", "")
    assert algo.startswith("straight_skeleton") or algo.startswith("rectilinear_partition") or algo.startswith("fallback")
    assert len(roof.faces) >= 4


def test_generate_skeleton_handles_u_polygon():
    roof = generate_skeleton(make_u_polygon())
    assert roof.roof_type == "skeleton"
    algo = roof.extras.get("algorithm", "")
    assert algo.startswith("straight_skeleton") or algo.startswith("rectilinear_partition") or algo.startswith("fallback")
    assert len(roof.faces) >= 4


def test_generate_skeleton_produces_closed_roof_faces_for_rectangle():
    roof = generate_skeleton(Polygon([
        Point(-12, -8), Point(12, -8), Point(12, 8), Point(-12, 8),
    ]))
    outer_area = _polygon_area(roof.polygon)
    face_area = sum(_polygon_area(face.polygon) for face in roof.faces)
    assert outer_area > 0
    assert face_area >= outer_area * 0.92


def test_generate_gabled_partitions_rectilinear_u_polygon():
    roof = generate_gabled(make_u_polygon())
    assert roof.roof_type == "gabled"
    assert roof.extras.get("algorithm") == "rectilinear_partition_gabled"
    assert len(roof.faces) >= 4


def test_generate_skeleton_fills_problem_polygon_without_holes():
    roof = generate_skeleton(make_problem_polygon())
    assert roof.roof_type == "skeleton"
    assert _roof_covers_polygon(roof)


@pytest.mark.parametrize("seed", [130, 142, 293, 17, 38, 59, 84, 111])
def test_generate_skeleton_covers_fixed_irregular_polygons(seed):
    roof = generate_skeleton(make_random_radial_polygon(seed))
    assert roof.roof_type == "skeleton"
    assert _roof_covers_polygon(roof)


def test_skeleton_not_registered_in_shared_building_registry():
    assert "skeleton" not in ROOF_GENERATORS


def test_roofs_api_supports_multiple_levels():
    from town_generator.webapp.app import generate_roofs

    levels = [
        {
            "id": "base",
            "label": "Base",
            "stories": 2,
            "polygon": [[-14, -10], [14, -10], [14, 10], [-14, 10]],
            "building_type": "house",
        },
        {
            "id": "upper",
            "label": "Upper",
            "stories": 4,
            "polygon": [[-6, -4], [6, -4], [6, 4], [-6, 4]],
            "building_type": "house",
        },
    ]

    payload = generate_roofs(
        roof_type="skeleton",
        overhang=-1.0,
        style="generic",
        building_type="house",
        stories=1,
        polygon="",
        levels=json.dumps(levels),
    )
    assert payload["multi_level"] is True
    assert len(payload["levels"]) == 2
    assert [level["stories"] for level in payload["levels"]] == [2, 4]
    assert all(level["roof"]["type"] == "skeleton" for level in payload["levels"])


def test_roofs_api_auto_uses_building_type_and_style_rules():
    from town_generator.webapp.app import generate_roofs

    payload = generate_roofs(
        roof_type="auto",
        overhang=-1.0,
        style="arabic_islamic",
        building_type="mosque",
        stories=1,
        polygon=json.dumps([[-8, -8], [8, -8], [8, 8], [-8, 8]]),
        levels="",
    )
    assert payload["levels"][0]["roof"]["type"] == "domed"


def test_roofs_api_global_roof_type_overrides_blank_level_roof_type():
    from town_generator.webapp.app import generate_roofs

    levels = [
        {
            "id": "main",
            "label": "Main",
            "stories": 2,
            "polygon": [[-12, -6], [12, -6], [12, 6], [-12, 6]],
            "building_type": "house",
            "roof_type": "",
        },
    ]

    payload = generate_roofs(
        roof_type="flat",
        overhang=-1.0,
        style="european_medieval",
        building_type="house",
        stories=2,
        polygon="",
        levels=json.dumps(levels),
    )
    assert payload["levels"][0]["roof"]["type"] == "flat"


def test_roofs_api_can_join_touching_same_story_parts():
    from town_generator.webapp.app import generate_roofs

    levels = [
        {
            "id": "west",
            "label": "West Wing",
            "stories": 1,
            "join_group": "h_compound",
            "join_stories": 2,
            "polygon": [[-14, -12], [-8, -12], [-8, 12], [-14, 12]],
        },
        {
            "id": "bridge",
            "label": "Bridge",
            "stories": 2,
            "join_group": "h_compound",
            "join_stories": 2,
            "polygon": [[-8, -3], [8, -3], [8, 3], [-8, 3]],
        },
        {
            "id": "east",
            "label": "East Wing",
            "stories": 2,
            "join_group": "h_compound",
            "join_stories": 2,
            "polygon": [[8, -12], [14, -12], [14, 12], [8, 12]],
        },
    ]

    separate = generate_roofs(
        roof_type="gabled",
        overhang=-1.0,
        style="european_medieval",
        building_type="house",
        stories=2,
        polygon="",
        levels=json.dumps(levels),
        join_touches=False,
    )
    joined = generate_roofs(
        roof_type="gabled",
        overhang=-1.0,
        style="european_medieval",
        building_type="house",
        stories=2,
        polygon="",
        levels=json.dumps(levels),
        join_touches=True,
    )

    assert len(separate["levels"]) == 3
    assert len(joined["levels"]) == 1
    assert joined["levels"][0]["joined"] is True
    assert joined["levels"][0]["roof"]["type"] == "gabled"
    assert joined["levels"][0]["stories"] == 2


def test_roofs_api_can_join_explicit_roof_type_across_mixed_building_types():
    from town_generator.webapp.app import generate_roofs

    levels = [
        {
            "id": "nave",
            "label": "Nave",
            "stories": 3,
            "building_type": "cathedral",
            "polygon": [[-4, -16], [4, -16], [4, 16], [-4, 16]],
        },
        {
            "id": "transept",
            "label": "Transept",
            "stories": 3,
            "building_type": "tower",
            "polygon": [[-14, -4], [14, -4], [14, 4], [-14, 4]],
        },
    ]

    payload = generate_roofs(
        roof_type="skeleton",
        overhang=-1.0,
        style="european_medieval",
        building_type="cathedral",
        stories=3,
        polygon="",
        levels=json.dumps(levels),
        join_touches=True,
    )

    assert len(payload["levels"]) == 1
    assert payload["levels"][0]["joined"] is True
    assert payload["levels"][0]["roof"]["type"] == "skeleton"


def test_building_roof_types_endpoint_unchanged():
    from town_generator.webapp.app import list_roof_types

    payload = list_roof_types()
    assert "skeleton" not in payload["roof_types"]


def _polygon_area(points):
    area = 0.0
    for i in range(len(points)):
        x1, y1 = points[i]
        x2, y2 = points[(i + 1) % len(points)]
        area += x1 * y2 - x2 * y1
    return abs(area / 2.0)
