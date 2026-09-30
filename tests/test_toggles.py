"""Tests for feature toggles and new features."""

from town_generator.building.model import Model
from town_generator.rendering.svg_renderer import render_svg


def test_plaza_true():
    model = Model(n_patches=8, seed=42, plaza=True)
    assert model.plaza is not None


def test_plaza_false():
    model = Model(n_patches=8, seed=42, plaza=False)
    assert model.plaza is None


def test_walls_true():
    model = Model(n_patches=8, seed=42, walls=True)
    assert model.wall is not None


def test_walls_false():
    model = Model(n_patches=8, seed=42, walls=False)
    assert model.wall is None


def test_citadel_true():
    model = Model(n_patches=8, seed=42, citadel=True)
    assert model.citadel is not None


def test_citadel_false():
    model = Model(n_patches=8, seed=42, citadel=False)
    assert model.citadel is None


def test_temple_true():
    from town_generator.wards.cathedral import Cathedral
    model = Model(n_patches=10, seed=42, temple=True)
    has_cathedral = any(
        isinstance(p.ward, Cathedral) for p in model.patches if p.ward is not None
    )
    assert has_cathedral


def test_temple_false():
    from town_generator.wards.cathedral import Cathedral
    model = Model(n_patches=10, seed=42, temple=False)
    has_cathedral = any(
        isinstance(p.ward, Cathedral) for p in model.patches if p.ward is not None
    )
    assert not has_cathedral


def test_river():
    model = Model(n_patches=10, seed=42, river=True)
    assert model.river is not None
    assert len(model.river.path) > 0
    assert len(model.river.polygon) > 0


def test_coast():
    model = Model(n_patches=10, seed=42, coast=True)
    assert model.coast is not None
    assert len(model.coast.shoreline) > 0


def test_shanty_town():
    from town_generator.wards.shanty_town import ShantyTown
    model = Model(n_patches=10, seed=42, shanty_town=True, walls=True)
    has_shanty = any(
        isinstance(p.ward, ShantyTown) for p in model.patches if p.ward is not None
    )
    assert has_shanty


def test_default_none_backward_compat():
    """Default all-None toggles with same seed should produce same SVG."""
    svg1 = render_svg(Model(n_patches=6, seed=100))
    svg2 = render_svg(Model(n_patches=6, seed=100))
    assert svg1 == svg2


def test_river_svg():
    model = Model(n_patches=8, seed=42, river=True)
    svg = render_svg(model)
    assert "river" in svg.lower() or "id=\"river\"" in svg


def test_coast_svg():
    model = Model(n_patches=8, seed=42, coast=True)
    svg = render_svg(model)
    assert "coast" in svg.lower() or "id=\"coast\"" in svg
