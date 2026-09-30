"""Compound building shapes — unions of rectangular wings.

Buildings in plan view are decomposed into overlapping rectangular wings.
Each wing gets its own roof or a merged roof computed on the union outline.
Supports randomized proportions via seed parameter.
"""

from __future__ import annotations

import math
import random as _random_mod
from dataclasses import dataclass, field

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon


def _jitter(rng: _random_mod.Random | None, base: float, pct: float = 0.15) -> float:
    """Return base ± pct variation using rng. No-op if rng is None."""
    if rng is None:
        return base
    return base * (1.0 - pct + rng.random() * 2 * pct)


@dataclass
class Wing:
    """One rectangular section of a compound building."""
    footprint: Polygon
    label: str = ""          # e.g. "nave", "transept", "north_wing"
    stories: int = 1
    building_type: str = "house"

    def to_dict(self) -> dict:
        return {
            "footprint": [[round(p.x, 2), round(p.y, 2)] for p in self.footprint],
            "label": self.label,
            "stories": self.stories,
            "building_type": self.building_type,
        }


@dataclass
class CompoundShape:
    """A building described as a union of rectangular wings."""
    wings: list[Wing]
    outline: Polygon          # the full merged outline (for shadow / footprint)
    shape_type: str = ""

    def to_dict(self) -> dict:
        return {
            "shape_type": self.shape_type,
            "outline": [[round(p.x, 2), round(p.y, 2)] for p in self.outline],
            "wings": [w.to_dict() for w in self.wings],
        }


# ---------------------------------------------------------------------------
# Shape factory helpers
# ---------------------------------------------------------------------------

def _rect(cx: float, cy: float, w: float, h: float, angle: float = 0.0) -> Polygon:
    """Create a rectangle centered at (cx,cy) with width w, height h, rotated by angle."""
    hw, hh = w / 2, h / 2
    corners = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]
    cos_a = math.cos(angle)
    sin_a = math.sin(angle)
    pts = []
    for x, y in corners:
        rx = x * cos_a - y * sin_a + cx
        ry = x * sin_a + y * cos_a + cy
        pts.append(Point(rx, ry))
    return Polygon(pts)


def _make_outline_from_wings(wings: list[Wing]) -> Polygon:
    """Approximate the union outline of all wings.

    For rendering purposes we compute the convex-hull-like merged outline.
    For non-convex shapes (L, U, etc.) we build the outline explicitly
    from the wing geometry.
    """
    # Collect all wing vertices
    all_pts = []
    for w in wings:
        all_pts.extend((p.x, p.y) for p in w.footprint)

    if not all_pts:
        return Polygon()

    # Convex hull (good enough for shadow casting; the actual per-wing
    # footprints are drawn individually for the wall layer)
    return _convex_hull([Point(x, y) for x, y in all_pts])


def _convex_hull(points: list[Point]) -> Polygon:
    """Graham scan convex hull."""
    pts = sorted(points, key=lambda p: (p.x, p.y))
    if len(pts) <= 2:
        return Polygon(pts)

    # Lower hull
    lower = []
    for p in pts:
        while len(lower) >= 2:
            o, a, b = lower[-2], lower[-1], p
            if (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x) <= 0:
                lower.pop()
            else:
                break
        lower.append(p)

    # Upper hull
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2:
            o, a, b = upper[-2], upper[-1], p
            if (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x) <= 0:
                upper.pop()
            else:
                break
        upper.append(p)

    return Polygon(lower[:-1] + upper[:-1])


# ---------------------------------------------------------------------------
# Compound shape generators
# ---------------------------------------------------------------------------

def make_l_shape(
    w1: float = 12, h1: float = 8,
    w2: float = 8, h2: float = 12,
    stories: int = 1,
    building_type: str = "house",
    seed: int | None = None,
) -> CompoundShape:
    """L-shaped building: two perpendicular wings sharing a corner."""
    rng = _random_mod.Random(seed) if seed is not None else None
    w1, h1 = _jitter(rng, w1), _jitter(rng, h1)
    w2, h2 = _jitter(rng, w2), _jitter(rng, h2)

    wing_h = Wing(
        footprint=_rect(0, h2 / 2 - h1 / 2, w1, h1),
        label="main",
        stories=stories,
        building_type=building_type,
    )
    wing_v = Wing(
        footprint=_rect(-w1 / 2 + w2 / 2, 0, w2, h2),
        label="wing",
        stories=stories,
        building_type=building_type,
    )
    wings = [wing_h, wing_v]
    return CompoundShape(
        wings=wings,
        outline=_make_l_outline(w1, h1, w2, h2),
        shape_type="L",
    )


def _make_l_outline(w1, h1, w2, h2):
    """Explicit L-shape outline (6 vertices)."""
    # Origin at center of bounding box
    bw = w1
    bh = h2
    x0 = -bw / 2
    y0 = -bh / 2
    return Polygon([
        Point(x0, y0),
        Point(x0 + w1, y0),
        Point(x0 + w1, y0 + (h2 - h1)),
        Point(x0 + w2, y0 + (h2 - h1)),
        Point(x0 + w2, y0 + h2),
        Point(x0, y0 + h2),
    ])


def make_t_shape(
    w_top: float = 16, h_top: float = 6,
    w_stem: float = 6, h_stem: float = 12,
    stories: int = 1,
    building_type: str = "house",
    seed: int | None = None,
) -> CompoundShape:
    """T-shaped building: horizontal bar + vertical stem."""
    rng = _random_mod.Random(seed) if seed is not None else None
    w_top, h_top = _jitter(rng, w_top), _jitter(rng, h_top)
    w_stem, h_stem = _jitter(rng, w_stem), _jitter(rng, h_stem)

    wing_top = Wing(
        footprint=_rect(0, -h_stem / 2 + h_top / 2, w_top, h_top),
        label="bar",
        stories=stories,
        building_type=building_type,
    )
    wing_stem = Wing(
        footprint=_rect(0, 0, w_stem, h_stem),
        label="stem",
        stories=stories,
        building_type=building_type,
    )
    wings = [wing_top, wing_stem]
    return CompoundShape(
        wings=wings,
        outline=_make_t_outline(w_top, h_top, w_stem, h_stem),
        shape_type="T",
    )


def _make_t_outline(wt, ht, ws, hs):
    y_top = -hs / 2
    return Polygon([
        Point(-wt / 2, y_top),
        Point(wt / 2, y_top),
        Point(wt / 2, y_top + ht),
        Point(ws / 2, y_top + ht),
        Point(ws / 2, y_top + hs),
        Point(-ws / 2, y_top + hs),
        Point(-ws / 2, y_top + ht),
        Point(-wt / 2, y_top + ht),
    ])


def make_h_shape(
    w_left: float = 6, h_left: float = 16,
    w_bridge: float = 8, h_bridge: float = 5,
    w_right: float = 6, h_right: float = 16,
    stories: int = 1,
    building_type: str = "house",
    seed: int | None = None,
) -> CompoundShape:
    """H-shaped building: two vertical wings connected by a bridge."""
    rng = _random_mod.Random(seed) if seed is not None else None
    w_left, h_left = _jitter(rng, w_left), _jitter(rng, h_left)
    w_bridge, h_bridge = _jitter(rng, w_bridge), _jitter(rng, h_bridge)
    w_right, h_right = _jitter(rng, w_right), _jitter(rng, h_right)

    gap = w_bridge
    wing_l = Wing(
        footprint=_rect(-gap / 2 - w_left / 2, 0, w_left, h_left),
        label="left_wing",
        stories=stories,
        building_type=building_type,
    )
    wing_r = Wing(
        footprint=_rect(gap / 2 + w_right / 2, 0, w_right, h_right),
        label="right_wing",
        stories=stories,
        building_type=building_type,
    )
    wing_bridge = Wing(
        footprint=_rect(0, 0, gap + w_left + w_right, h_bridge),
        label="bridge",
        stories=stories,
        building_type=building_type,
    )
    wings = [wing_l, wing_r, wing_bridge]
    return CompoundShape(
        wings=wings,
        outline=_make_outline_from_wings(wings),
        shape_type="H",
    )


def make_u_shape(
    w_left: float = 5, h_side: float = 14,
    w_bottom: float = 14, h_bottom: float = 5,
    w_right: float = 5,
    stories: int = 1,
    building_type: str = "house",
    seed: int | None = None,
) -> CompoundShape:
    """U-shaped / courtyard building: two sides + bottom connecting them."""
    rng = _random_mod.Random(seed) if seed is not None else None
    w_left, h_side = _jitter(rng, w_left), _jitter(rng, h_side)
    w_bottom, h_bottom = _jitter(rng, w_bottom), _jitter(rng, h_bottom)
    w_right = _jitter(rng, w_right)

    wing_l = Wing(
        footprint=_rect(-w_bottom / 2 + w_left / 2, 0, w_left, h_side),
        label="left_wing",
        stories=stories,
        building_type=building_type,
    )
    wing_r = Wing(
        footprint=_rect(w_bottom / 2 - w_right / 2, 0, w_right, h_side),
        label="right_wing",
        stories=stories,
        building_type=building_type,
    )
    wing_bot = Wing(
        footprint=_rect(0, h_side / 2 - h_bottom / 2, w_bottom, h_bottom),
        label="base",
        stories=stories,
        building_type=building_type,
    )
    wings = [wing_l, wing_r, wing_bot]
    return CompoundShape(
        wings=wings,
        outline=_make_u_outline(w_left, h_side, w_bottom, h_bottom, w_right),
        shape_type="U",
    )


def _make_u_outline(wl, hs, wb, hb, wr):
    x0, y0 = -wb / 2, -hs / 2
    return Polygon([
        Point(x0, y0),
        Point(x0 + wb, y0),
        Point(x0 + wb, y0 + hs),
        Point(x0 + wb - wr, y0 + hs),
        Point(x0 + wb - wr, y0 + hb),
        Point(x0 + wl, y0 + hb),
        Point(x0 + wl, y0 + hs),
        Point(x0, y0 + hs),
    ])


def make_plus_shape(
    w: float = 6, h: float = 16,
    stories: int = 1,
    building_type: str = "house",
    seed: int | None = None,
) -> CompoundShape:
    """Plus/cross-shaped building: two perpendicular rectangles centered."""
    rng = _random_mod.Random(seed) if seed is not None else None
    w = _jitter(rng, w)
    h = _jitter(rng, h)

    wing_v = Wing(
        footprint=_rect(0, 0, w, h),
        label="vertical",
        stories=stories,
        building_type=building_type,
    )
    wing_h = Wing(
        footprint=_rect(0, 0, h, w),
        label="horizontal",
        stories=stories,
        building_type=building_type,
    )
    wings = [wing_v, wing_h]
    return CompoundShape(
        wings=wings,
        outline=_make_plus_outline(w, h),
        shape_type="plus",
    )


def _make_plus_outline(w, h):
    hw, hh = w / 2, h / 2
    return Polygon([
        Point(-hw, -hh),
        Point(hw, -hh),
        Point(hw, -hw),
        Point(hh, -hw),
        Point(hh, hw),
        Point(hw, hw),
        Point(hw, hh),
        Point(-hw, hh),
        Point(-hw, hw),
        Point(-hh, hw),
        Point(-hh, -hw),
        Point(-hw, -hw),
    ])


def make_courtyard(
    outer_w: float = 18, outer_h: float = 16,
    wall_w: float = 4,
    gate_side: str = "south",
    stories: int = 2,
    building_type: str = "house",
    seed: int | None = None,
) -> CompoundShape:
    """Courtyard building: four wings around a central open space.

    gate_side controls which wing has a gap (or is thinner).
    """
    rng = _random_mod.Random(seed) if seed is not None else None
    outer_w, outer_h = _jitter(rng, outer_w), _jitter(rng, outer_h)
    wall_w = _jitter(rng, wall_w)

    hw, hh = outer_w / 2, outer_h / 2

    wings = [
        Wing(  # North
            footprint=_rect(0, -hh + wall_w / 2, outer_w, wall_w),
            label="north",
            stories=stories,
            building_type=building_type,
        ),
        Wing(  # South (may be thinner for gate)
            footprint=_rect(0, hh - wall_w / 2, outer_w, wall_w),
            label="south",
            stories=1 if gate_side == "south" else stories,
            building_type=building_type,
        ),
        Wing(  # West
            footprint=_rect(-hw + wall_w / 2, 0, wall_w, outer_h - wall_w * 2),
            label="west",
            stories=stories,
            building_type=building_type,
        ),
        Wing(  # East
            footprint=_rect(hw - wall_w / 2, 0, wall_w, outer_h - wall_w * 2),
            label="east",
            stories=stories,
            building_type=building_type,
        ),
    ]

    outline = Polygon([
        Point(-hw, -hh), Point(hw, -hh), Point(hw, hh), Point(-hw, hh),
    ])

    return CompoundShape(wings=wings, outline=outline, shape_type="courtyard")


def make_cathedral(
    nave_w: float = 8, nave_h: float = 28,
    transept_w: float = 22, transept_h: float = 8,
    apse_w: float = 6, apse_h: float = 5,
    tower_size: float = 5,
    has_apse: bool = True,
    has_tower: bool = True,
    seed: int | None = None,
) -> CompoundShape:
    """Cathedral: nave + transept + optional apse + optional tower."""
    rng = _random_mod.Random(seed) if seed is not None else None
    nave_w, nave_h = _jitter(rng, nave_w), _jitter(rng, nave_h)
    transept_w, transept_h = _jitter(rng, transept_w), _jitter(rng, transept_h)
    apse_w, apse_h = _jitter(rng, apse_w), _jitter(rng, apse_h)
    tower_size = _jitter(rng, tower_size)

    wings = []

    # Nave (long axis)
    wings.append(Wing(
        footprint=_rect(0, 0, nave_w, nave_h),
        label="nave",
        stories=2,
        building_type="cathedral",
    ))

    # Transept (crossing)
    wings.append(Wing(
        footprint=_rect(0, -nave_h * 0.15, transept_w, transept_h),
        label="transept",
        stories=2,
        building_type="cathedral",
    ))

    # Apse
    if has_apse:
        wings.append(Wing(
            footprint=_rect(0, -nave_h / 2 - apse_h / 2 + 0.5, apse_w, apse_h),
            label="apse",
            stories=1,
            building_type="chapel",
        ))

    # Tower
    if has_tower:
        wings.append(Wing(
            footprint=_rect(0, -nave_h * 0.15, tower_size, tower_size),
            label="tower",
            stories=3,
            building_type="tower",
        ))

    outline = _make_outline_from_wings(wings)
    return CompoundShape(wings=wings, outline=outline, shape_type="cathedral")


def make_keep(
    keep_size: float = 10,
    wing_w: float = 6, wing_h: float = 14,
    n_wings: int = 2,
    tower_size: float = 4,
    has_towers: bool = True,
    seed: int | None = None,
) -> CompoundShape:
    """Castle keep: central block + radiating wings + corner towers."""
    rng = _random_mod.Random(seed) if seed is not None else None
    keep_size = _jitter(rng, keep_size)
    wing_w, wing_h = _jitter(rng, wing_w), _jitter(rng, wing_h)
    tower_size = _jitter(rng, tower_size)

    wings = []

    # Central keep
    wings.append(Wing(
        footprint=_rect(0, 0, keep_size, keep_size),
        label="keep",
        stories=3,
        building_type="keep",
    ))

    # Wings
    angles = [i * 2 * math.pi / max(n_wings, 1) - math.pi / 2 for i in range(n_wings)]
    for i, angle in enumerate(angles):
        cx = math.cos(angle) * (keep_size / 2 + wing_h / 2 - 1)
        cy = math.sin(angle) * (keep_size / 2 + wing_h / 2 - 1)
        wings.append(Wing(
            footprint=_rect(cx, cy, wing_w, wing_h, angle + math.pi / 2),
            label=f"wing_{i}",
            stories=2,
            building_type="house",
        ))

    # Corner towers
    if has_towers:
        for dx, dy in [(-1, -1), (1, -1), (1, 1), (-1, 1)]:
            tx = dx * keep_size / 2
            ty = dy * keep_size / 2
            n_seg = 8
            tower_pts = [
                Point(tx + tower_size / 2 * math.cos(a * 2 * math.pi / n_seg),
                      ty + tower_size / 2 * math.sin(a * 2 * math.pi / n_seg))
                for a in range(n_seg)
            ]
            wings.append(Wing(
                footprint=Polygon(tower_pts),
                label="tower",
                stories=4,
                building_type="tower",
            ))

    outline = _make_outline_from_wings(wings)
    return CompoundShape(wings=wings, outline=outline, shape_type="keep")


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

COMPOUND_SHAPES = {
    "l_shape": make_l_shape,
    "t_shape": make_t_shape,
    "h_shape": make_h_shape,
    "u_shape": make_u_shape,
    "plus": make_plus_shape,
    "courtyard": make_courtyard,
    "cathedral": make_cathedral,
    "keep": make_keep,
}
