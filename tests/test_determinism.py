"""Determinism: same seed + size must produce identical SVG."""

import hashlib

from town_generator.building.model import Model
from town_generator.rendering.svg_renderer import render_svg


def test_deterministic_output():
    def gen(seed, n):
        model = Model(n_patches=n, seed=seed)
        return render_svg(model)

    svg1 = gen(42, 6)
    svg2 = gen(42, 6)

    h1 = hashlib.sha256(svg1.encode()).hexdigest()
    h2 = hashlib.sha256(svg2.encode()).hexdigest()
    assert h1 == h2, "Same seed should produce identical SVG"
