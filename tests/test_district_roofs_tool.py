from town_generator.webapp.app import populate_district_roofs


def test_district_roofs_endpoint_can_complexify_grid_lots_with_skeleton_roofs():
    payload = populate_district_roofs(
        populator="grid",
        seed=42,
        min_area=20.0,
        grid_chaos=0.1,
        size_chaos=0.1,
        empty_prob=0.0,
        density=0.7,
        alley_width=0.8,
        polygon="",
        district_type="craftsmen",
        style="european_medieval",
        preset="large",
        roof_type="skeleton",
        overhang=-1.0,
        facade_density=1,
        massing_mode="chamfered",
        complexity=0.9,
        setback=0.12,
    )

    assert payload["buildings"]
    complexified = [b for b in payload["buildings"] if b.get("massing_type") in {"chamfer", "octagon"}]
    assert complexified
    first = complexified[0]
    assert len(first["footprint"]) > len(first["lot_footprint"])
    assert first["roof"]["type"] == "skeleton"
    assert first["facade_details"]


def test_district_roofs_endpoint_auto_roofs_follow_style_defaults():
    payload = populate_district_roofs(
        populator="bazaar",
        seed=77,
        min_area=12.0,
        grid_chaos=0.3,
        size_chaos=0.3,
        empty_prob=0.0,
        density=0.7,
        alley_width=0.8,
        polygon="",
        district_type="market",
        style="arabic_islamic",
        preset="large",
        roof_type="auto",
        overhang=-1.0,
        facade_density=1,
        massing_mode="adaptive",
        complexity=0.7,
        setback=0.1,
    )

    shops = [b for b in payload["buildings"] if b["type"] == "shop"]
    assert shops
    assert all(b["roof"]["type"] == "flat" for b in shops[:5])
    assert all(b["roof"]["polygon"] == b["footprint"] for b in shops[:5])


def test_district_roofs_fields_remain_undetailed():
    payload = populate_district_roofs(
        populator="farm_plot",
        seed=19,
        min_area=20.0,
        grid_chaos=0.2,
        size_chaos=0.2,
        empty_prob=0.0,
        density=0.8,
        alley_width=0.8,
        polygon="",
        district_type="farm",
        style="generic",
        preset="large",
        roof_type="auto",
        overhang=-1.0,
        facade_density=1,
        massing_mode="adaptive",
        complexity=0.6,
        setback=0.1,
    )

    fields = [b for b in payload["buildings"] if b["type"] == "field"]
    assert fields
    assert all("roof" not in field for field in fields)


def test_district_roofs_keeps_most_buildings_simple_while_allowing_some_complex_landmarks():
    payload = populate_district_roofs(
        populator="monastic",
        seed=123,
        min_area=20.0,
        grid_chaos=0.2,
        size_chaos=0.2,
        empty_prob=0.0,
        density=0.6,
        alley_width=0.8,
        polygon="",
        district_type="cathedral",
        style="european_medieval",
        preset="large",
        roof_type="auto",
        overhang=0.0,
        facade_density=1,
        massing_mode="adaptive",
        complexity=0.4,
        setback=0.14,
    )

    roofed = [b for b in payload["buildings"] if "roof" in b]
    simple = [b for b in roofed if b["massing_type"] == "original"]
    complexified = [b for b in roofed if b["massing_type"] != "original"]

    assert roofed
    assert simple
    assert complexified
    assert len(simple) > len(complexified)


def test_district_roofs_complex_ratio_controls_complex_share():
    low = populate_district_roofs(
        populator="monastic",
        seed=123,
        min_area=20.0,
        grid_chaos=0.2,
        size_chaos=0.2,
        empty_prob=0.0,
        density=0.6,
        alley_width=0.8,
        polygon="",
        district_type="cathedral",
        style="european_medieval",
        preset="large",
        roof_type="auto",
        overhang=0.0,
        facade_density=1,
        massing_mode="adaptive",
        complexity=0.4,
        complex_ratio=0.0,
        setback=0.14,
    )
    high = populate_district_roofs(
        populator="monastic",
        seed=123,
        min_area=20.0,
        grid_chaos=0.2,
        size_chaos=0.2,
        empty_prob=0.0,
        density=0.6,
        alley_width=0.8,
        polygon="",
        district_type="cathedral",
        style="european_medieval",
        preset="large",
        roof_type="auto",
        overhang=0.0,
        facade_density=1,
        massing_mode="adaptive",
        complexity=0.4,
        complex_ratio=0.8,
        setback=0.14,
    )

    low_complex = sum(1 for b in low["buildings"] if b.get("massing_type") not in (None, "original"))
    high_complex = sum(1 for b in high["buildings"] if b.get("massing_type") not in (None, "original"))
    assert high_complex > low_complex


def test_district_roofs_auto_avoids_hipped_plateaus_on_complex_generic_buildings():
    payload = populate_district_roofs(
        populator="monastic",
        seed=123,
        min_area=20.0,
        grid_chaos=0.2,
        size_chaos=0.2,
        empty_prob=0.0,
        density=0.6,
        alley_width=0.8,
        polygon="",
        district_type="cathedral",
        style="generic",
        preset="large",
        roof_type="auto",
        overhang=0.0,
        facade_density=1,
        massing_mode="adaptive",
        complexity=0.5,
        complex_ratio=0.8,
        setback=0.14,
    )

    complexified = [b for b in payload["buildings"] if b.get("massing_type") not in (None, "original")]
    assert complexified
    concave = [b for b in complexified if len(b["footprint"]) > 6]
    assert concave
    assert all(
        not str(b["roof"].get("extras", {}).get("algorithm", "")).startswith(("rectilinear_partition", "fallback_hipped"))
        for b in concave
    )


def test_district_roofs_complex_templates_use_clean_roof_algorithms_in_organic_blocks():
    payload = populate_district_roofs(
        populator="organic_alley",
        seed=42,
        min_area=20.0,
        grid_chaos=0.4,
        size_chaos=0.4,
        empty_prob=0.04,
        density=0.6,
        alley_width=0.8,
        polygon="",
        district_type="craftsmen",
        style="generic",
        preset="default",
        roof_type="auto",
        overhang=0.0,
        facade_density=1,
        massing_mode="adaptive",
        complexity=0.4,
        complex_ratio=0.22,
        join_ratio=0.43,
        setback=0.14,
    )

    complexified = [b for b in payload["buildings"] if b.get("massing_type") not in (None, "original")]
    assert complexified
    assert all(
        not str(b["roof"].get("extras", {}).get("algorithm", "")).startswith(("rectilinear_partition", "fallback_hipped"))
        for b in complexified
    )
    assert any(b.get("compound") for b in complexified)


def test_district_roofs_complex_shapes_favor_joined_or_larger_lots():
    payload = populate_district_roofs(
        populator="organic_alley",
        seed=42,
        min_area=20.0,
        grid_chaos=0.4,
        size_chaos=0.4,
        empty_prob=0.04,
        density=0.6,
        alley_width=0.8,
        polygon="",
        district_type="craftsmen",
        style="generic",
        preset="default",
        roof_type="auto",
        overhang=0.0,
        facade_density=1,
        massing_mode="adaptive",
        complexity=0.4,
        complex_ratio=0.22,
        join_ratio=0.43,
        setback=0.14,
    )

    roofed = [b for b in payload["buildings"] if "roof" in b and b.get("source_count", 1) == 1]
    complex_non_joined = [b for b in roofed if b.get("massing_type") not in (None, "original")]
    assert complex_non_joined

    def area(points):
        total = 0.0
        for idx in range(len(points)):
            x1, y1 = points[idx]
            x2, y2 = points[(idx + 1) % len(points)]
            total += x1 * y2 - x2 * y1
        return abs(total / 2.0)

    lot_areas = sorted(area(b["lot_footprint"]) for b in roofed)
    median_area = lot_areas[len(lot_areas) // 2]
    assert all(area(b["lot_footprint"]) >= median_area for b in complex_non_joined)


def test_district_roofs_join_ratio_can_merge_touching_lots_into_compounds():
    baseline = populate_district_roofs(
        populator="organic_alley",
        seed=42,
        min_area=20.0,
        grid_chaos=0.4,
        size_chaos=0.4,
        empty_prob=0.04,
        density=0.6,
        alley_width=0.8,
        polygon="",
        district_type="craftsmen",
        style="generic",
        preset="default",
        roof_type="auto",
        overhang=0.0,
        facade_density=1,
        massing_mode="adaptive",
        complexity=0.4,
        complex_ratio=0.22,
        join_ratio=0.0,
        setback=0.14,
    )
    joined = populate_district_roofs(
        populator="organic_alley",
        seed=42,
        min_area=20.0,
        grid_chaos=0.4,
        size_chaos=0.4,
        empty_prob=0.04,
        density=0.6,
        alley_width=0.8,
        polygon="",
        district_type="craftsmen",
        style="generic",
        preset="default",
        roof_type="auto",
        overhang=0.0,
        facade_density=1,
        massing_mode="adaptive",
        complexity=0.4,
        complex_ratio=0.22,
        join_ratio=0.43,
        setback=0.14,
    )

    joined_buildings = [b for b in joined["buildings"] if b.get("source_count", 1) > 1]
    assert len(joined["buildings"]) < len(baseline["buildings"])
    assert joined_buildings
    assert any(b["massing_type"].startswith("joined_") for b in joined_buildings)
    assert any("source_lots" in b for b in joined_buildings)


def test_district_roofs_join_ratio_scales_the_number_of_merged_buildings():
    low = populate_district_roofs(
        populator="organic_alley",
        seed=42,
        min_area=20.0,
        grid_chaos=0.4,
        size_chaos=0.4,
        empty_prob=0.04,
        density=0.6,
        alley_width=0.8,
        polygon="",
        district_type="craftsmen",
        style="generic",
        preset="default",
        roof_type="auto",
        overhang=0.0,
        facade_density=1,
        massing_mode="adaptive",
        complexity=0.4,
        complex_ratio=0.22,
        join_ratio=0.0,
        setback=0.14,
    )
    mid = populate_district_roofs(
        populator="organic_alley",
        seed=42,
        min_area=20.0,
        grid_chaos=0.4,
        size_chaos=0.4,
        empty_prob=0.04,
        density=0.6,
        alley_width=0.8,
        polygon="",
        district_type="craftsmen",
        style="generic",
        preset="default",
        roof_type="auto",
        overhang=0.0,
        facade_density=1,
        massing_mode="adaptive",
        complexity=0.4,
        complex_ratio=0.22,
        join_ratio=0.43,
        setback=0.14,
    )
    high = populate_district_roofs(
        populator="organic_alley",
        seed=42,
        min_area=20.0,
        grid_chaos=0.4,
        size_chaos=0.4,
        empty_prob=0.04,
        density=0.6,
        alley_width=0.8,
        polygon="",
        district_type="craftsmen",
        style="generic",
        preset="default",
        roof_type="auto",
        overhang=0.0,
        facade_density=1,
        massing_mode="adaptive",
        complexity=0.4,
        complex_ratio=0.22,
        join_ratio=0.8,
        setback=0.14,
    )

    low_count = sum(1 for b in low["buildings"] if b.get("source_count", 1) > 1)
    mid_count = sum(1 for b in mid["buildings"] if b.get("source_count", 1) > 1)
    high_count = sum(1 for b in high["buildings"] if b.get("source_count", 1) > 1)

    assert low_count == 0
    assert high_count > mid_count > low_count


def test_district_roofs_auto_mix_can_blend_skeleton_gabled_and_hipped_roofs():
    payload = populate_district_roofs(
        populator="organic_alley",
        seed=42,
        min_area=20.0,
        grid_chaos=0.4,
        size_chaos=0.4,
        empty_prob=0.04,
        density=0.6,
        alley_width=0.8,
        polygon="",
        district_type="craftsmen",
        style="generic",
        preset="default",
        roof_type="auto",
        overhang=0.0,
        facade_density=1,
        massing_mode="adaptive",
        complexity=0.45,
        complex_ratio=0.45,
        join_ratio=0.35,
        setback=0.14,
    )

    roof_types = {b["roof"]["type"] for b in payload["buildings"] if "roof" in b}
    assert {"skeleton", "gabled", "hipped"} <= roof_types


def test_district_roofs_original_irregular_generic_lots_avoid_plain_hipped_roofs():
    payload = populate_district_roofs(
        populator="organic_alley",
        seed=42,
        min_area=20.0,
        grid_chaos=0.4,
        size_chaos=0.4,
        empty_prob=0.04,
        density=0.6,
        alley_width=0.8,
        polygon="",
        district_type="craftsmen",
        style="generic",
        preset="default",
        roof_type="auto",
        overhang=0.0,
        facade_density=1,
        massing_mode="adaptive",
        complexity=0.45,
        complex_ratio=0.45,
        join_ratio=0.35,
        setback=0.14,
    )

    def _is_rectilinear(points):
        for i in range(len(points)):
            x0, y0 = points[i]
            x1, y1 = points[(i + 1) % len(points)]
            if abs(x1 - x0) > 1e-6 and abs(y1 - y0) > 1e-6:
                return False
        return True

    irregular_originals = [
        b for b in payload["buildings"]
        if b.get("massing_type") == "original"
        and len(b.get("footprint", [])) > 4
        and not _is_rectilinear(b["footprint"])
        and "roof" in b
    ]

    assert all(b["roof"]["type"] != "hipped" for b in irregular_originals)
