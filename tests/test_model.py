"""End-to-end model test."""

from town_generator.building.model import Model
from town_generator.rendering.svg_renderer import render_svg


def test_generate_with_seed():
    model = Model(n_patches=6, seed=42)
    assert model is not None
    assert len(model.patches) > 0
    assert model.city_radius > 0


def test_svg_output():
    model = Model(n_patches=6, seed=42)
    svg = render_svg(model)
    assert svg.startswith("<svg")
    assert "viewBox" in svg
    assert len(svg) > 100
