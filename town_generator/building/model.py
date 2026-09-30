"""Main orchestrator — the full town generation pipeline. Port of Model.hx."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.geom.segment import Segment
from town_generator.geom.voronoi import Voronoi
from town_generator.utils.math_utils import sign
from town_generator.utils.random import Random
from town_generator.utils import array_utils
from town_generator.building.patch import Patch
from town_generator.building.curtain_wall import CurtainWall
from town_generator.building.topology import Topology
from town_generator.styles.style import CulturalStyle, get_style

if TYPE_CHECKING:
    pass

# Type alias matching Haxe's `typedef Street = Polygon`
Street = Polygon


def _get_ward_classes(style: CulturalStyle | None = None) -> list[type]:
    """Lazy import to avoid circular deps.

    When *style* is provided and is not generic, build a weighted ward list
    from the style's ward_weights.  Otherwise return the original hardcoded
    list for backward compatibility.
    """
    from town_generator.wards.craftsmen import CraftsmenWard
    from town_generator.wards.merchant import MerchantWard
    from town_generator.wards.cathedral import Cathedral
    from town_generator.wards.administration import AdministrationWard
    from town_generator.wards.slum import Slum
    from town_generator.wards.patriciate import PatriciateWard
    from town_generator.wards.market import Market
    from town_generator.wards.military import MilitaryWard
    from town_generator.wards.park import Park

    if style is None or style.id == "generic":
        return [
            CraftsmenWard, CraftsmenWard, MerchantWard, CraftsmenWard, Park, Cathedral,
            CraftsmenWard, MerchantWard, CraftsmenWard, CraftsmenWard, CraftsmenWard,
            PatriciateWard, CraftsmenWard, CraftsmenWard, AdministrationWard, MerchantWard,
            Slum, CraftsmenWard, Slum, PatriciateWard, Market,
            Slum, CraftsmenWard, Park, MerchantWard, Slum,
            CraftsmenWard, CraftsmenWard, Park, MilitaryWard, Slum,
            CraftsmenWard, Park, PatriciateWard, Market, CraftsmenWard,
        ]

    # Build a weighted list from style ward_weights (36 slots to match original)
    w = style.ward_weights
    pool_size = 36
    entries: list[tuple[type, float]] = [
        (CraftsmenWard, w.craftsmen),
        (MerchantWard, w.merchant),
        (PatriciateWard, w.patriciate),
        (Slum, w.slum),
        (AdministrationWard, w.administration),
        (MilitaryWard, w.military),
        (Park, w.park),
        (Cathedral, w.cathedral),
        (Market, w.market),
    ]
    total = sum(weight for _, weight in entries)
    result: list[type] = []
    for cls, weight in entries:
        count = max(1, round(pool_size * weight / total))
        result.extend([cls] * count)
    return result


class Model:
    instance: Model | None = None

    def __init__(
        self,
        n_patches: int = -1,
        seed: int = -1,
        *,
        plaza: bool | None = None,
        citadel: bool | None = None,
        walls: bool | None = None,
        temple: bool | None = None,
        river: bool | None = None,
        coast: bool | None = None,
        shanty_town: bool | None = None,
        n_roads: int | None = None,
        road_style: str | None = None,
        elongation: float | None = None,
        river_curvature: float | None = None,
        coast_roughness: float | None = None,
        building_density: float | None = None,
        building_style: str | None = None,
        district_populator: str | None = None,
        district_min_area: float | None = None,
        district_grid_chaos: float | None = None,
        district_size_chaos: float | None = None,
        district_empty_prob: float | None = None,
        district_density: float | None = None,
        district_alley_width: float | None = None,
        district_roofscape: bool = False,
        district_roof_type: str | None = None,
        district_overhang: float | None = None,
        district_facade_density: int | None = None,
        district_massing_mode: str | None = None,
        district_complexity: float | None = None,
        district_complex_ratio: float | None = None,
        district_join_ratio: float | None = None,
        district_setback: float | None = None,
        style: str | None = None,
    ) -> None:
        if seed > 0:
            Random.reset(seed)
        self.n_patches = n_patches if n_patches != -1 else 15

        # Always consume PRNG calls to preserve backward seed compatibility
        _p, _c, _w = Random.bool(), Random.bool(), Random.bool()
        self.plaza_needed: bool = plaza if plaza is not None else _p
        self.citadel_needed: bool = citadel if citadel is not None else _c
        self.walls_needed: bool = walls if walls is not None else _w
        self.temple_needed: bool | None = temple
        self.river_enabled: bool = river or False
        self.coast_enabled: bool = coast or False
        self.shanty_town_enabled: bool = shanty_town or False
        self.n_roads: int | None = n_roads
        self._road_style_explicit: str | None = road_style if road_style in ("organic", "medieval") else None
        self.road_style: str = self._road_style_explicit or "organic"
        self.elongation: float | None = elongation
        self.river_curvature: float = river_curvature if river_curvature is not None else 3.0
        self.coast_roughness: float = coast_roughness if coast_roughness is not None else 0.5

        # Building density: None=default, 0.0=sparse, 1.0=dense
        if building_density is not None:
            bd = max(0.0, min(1.0, building_density))
            self.alley_width: float = 1.2 - bd * 0.9  # 1.2 (sparse) to 0.3 (dense)
            self.empty_prob_factor: float = 2.0 - bd * 1.7  # 2.0 (sparse) to 0.3 (dense)
        else:
            self.alley_width = 0.6
            self.empty_prob_factor = 1.0

        self.building_style: str = building_style if building_style in ("original", "composite", "mixed") else "mixed"
        self.district_populator_override: str | None = district_populator or None
        self.district_min_area: float = max(5.0, district_min_area if district_min_area is not None else 20.0)
        self.district_grid_chaos: float = max(0.0, min(1.0, district_grid_chaos if district_grid_chaos is not None else 0.4))
        self.district_size_chaos: float = max(0.0, min(1.0, district_size_chaos if district_size_chaos is not None else 0.4))
        self.district_empty_prob: float = max(
            0.0,
            min(0.5, district_empty_prob if district_empty_prob is not None else 0.04 * self.empty_prob_factor),
        )
        self.district_density: float = max(
            0.0,
            min(1.0, district_density if district_density is not None else (building_density if building_density is not None else 0.6)),
        )
        self.district_alley_width: float = max(
            0.2,
            district_alley_width if district_alley_width is not None else self.alley_width,
        )
        self.district_roofscape_enabled: bool = district_roofscape
        self.district_roof_type: str | None = None if district_roof_type in (None, "", "auto") else district_roof_type
        self.district_overhang: float = max(0.0, district_overhang if district_overhang is not None else 0.0)
        self.district_facade_density: int = max(0, min(2, district_facade_density if district_facade_density is not None else 1))
        self.district_massing_mode: str = (
            district_massing_mode
            if district_massing_mode in {"adaptive", "compound", "chamfered"}
            else "adaptive"
        )
        self.district_complexity: float = max(0.0, min(1.0, district_complexity if district_complexity is not None else 0.4))
        self.district_complex_ratio: float = max(0.0, min(1.0, district_complex_ratio if district_complex_ratio is not None else 0.22))
        self.district_join_ratio: float = max(0.0, min(1.0, district_join_ratio if district_join_ratio is not None else 0.0))
        self.district_setback: float = max(0.04, min(0.35, district_setback if district_setback is not None else 0.14))

        # Cultural style system
        self.style: CulturalStyle = get_style(style or "generic")

        # Apply style-derived road_style when not explicitly set
        if self._road_style_explicit is None and self.style.id != "generic":
            pattern = self.style.street_pattern
            if pattern == "grid":
                self.road_style = "medieval"  # ring roads approximate grid order
            # organic, labyrinthine, cluster, open all use "organic" base

        self.topology: Topology | None = None
        self._district_seed_base: int | None = None
        self.patches: list[Patch] = []
        self.waterbody: list[Patch] = []
        self.inner: list[Patch] = []
        self.citadel: Patch | None = None
        self.plaza: Patch | None = None
        self.center: Point = Point()

        self.border: CurtainWall | None = None
        self.wall: CurtainWall | None = None
        self.city_radius: float = 0.0
        self.gates: list[Point] = []
        self.arteries: list[Street] = []
        self.streets: list[Street] = []
        self.roads: list[Street] = []

        self.river = None
        self.coast = None

        max_retries = 20
        for _attempt in range(max_retries):
            try:
                self._build()
                Model.instance = self
                break
            except Exception:
                Model.instance = None
        else:
            raise RuntimeError("Failed to generate city after max retries")

    def _build(self) -> None:
        self.streets = []
        self.roads = []

        self._build_patches()
        self._generate_water()
        self._optimize_junctions()
        self._build_walls()
        self._build_streets()
        if self.river is not None:
            self.river.find_bridges(self.arteries, coast=self.coast)
        self._clip_patches_to_water()
        self._create_wards()
        self._build_geometry()

    def _build_patches(self) -> None:
        sa = Random.float() * 2 * math.pi
        # City shape elongation (oval/irregular instead of always round)
        if self.elongation is not None:
            elongation = self.elongation
            Random.float()  # consume PRNG to keep sequence stable
        else:
            elongation = 1.0 + Random.float() * 1.2  # random 1.0 to 2.2x
        elong_angle = Random.float() * math.pi
        cos_e = math.cos(elong_angle)
        sin_e = math.sin(elong_angle)

        points = []
        for i in range(self.n_patches * 8):
            a = sa + math.sqrt(i) * 5
            r = 0 if i == 0 else 10 + i * (2 + Random.float())
            px = math.cos(a) * r
            py = math.sin(a) * r
            # Stretch along elongation axis
            rx = px * cos_e + py * sin_e
            ry = -px * sin_e + py * cos_e
            rx *= elongation
            px = rx * cos_e - ry * sin_e
            py = rx * sin_e + ry * cos_e
            points.append(Point(px, py))

        voronoi = Voronoi.build(points)

        for i in range(3):
            to_relax = [voronoi.points[j] for j in range(3)]
            if self.n_patches < len(voronoi.points):
                to_relax.append(voronoi.points[self.n_patches])
            voronoi = Voronoi.relax(voronoi, to_relax)

        voronoi.points.sort(key=lambda p: p.length)
        regions = voronoi.partitioning()

        self.patches = []
        self.inner = []

        count = 0
        for r in regions:
            patch = Patch.from_region(r)
            self.patches.append(patch)

            if count == 0:
                self.center = array_utils.min_by(list(patch.shape), lambda p: p.length)
                if self.plaza_needed:
                    self.plaza = patch
            elif count == self.n_patches and self.citadel_needed:
                self.citadel = patch
                self.citadel.within_city = True

            if count < self.n_patches:
                patch.within_city = True
                patch.within_walls = self.walls_needed
                self.inner.append(patch)

            count += 1

    def _build_walls(self) -> None:
        from town_generator.wards.castle import Castle

        reserved = list(self.citadel.shape) if self.citadel is not None else []
        self.border = CurtainWall(self.walls_needed, self, self.inner, reserved)

        if self.walls_needed:
            self.wall = self.border
            self.wall.build_towers()

        radius = self.border.get_radius()
        self.patches = [p for p in self.patches if p.shape.distance(self.center) < radius * 3]

        self.gates = list(self.border.gates)

        if self.citadel is not None:
            castle = Castle(self, self.citadel)
            castle.wall.build_towers()
            self.citadel.ward = castle

            if self.citadel.shape.compactness < 0.75:
                raise RuntimeError("Bad citadel shape!")

            self.gates = self.gates + list(castle.wall.gates)

        # Limit gate count if n_roads is specified
        if self.n_roads is not None and len(self.gates) > self.n_roads:
            # Keep a random subset of gates
            while len(self.gates) > self.n_roads:
                idx = Random.int(0, len(self.gates) - 1)
                self.gates.pop(idx)

    @staticmethod
    def find_circumference(wards: list[Patch]) -> Polygon:
        if len(wards) == 0:
            return Polygon()
        if len(wards) == 1:
            return Polygon(list(wards[0].shape))

        A: list[Point] = []
        B: list[Point] = []

        for w1 in wards:
            def _check(a: Point, b: Point) -> None:
                outer_edge = True
                for w2 in wards:
                    if w2.shape.find_edge(b, a) != -1:
                        outer_edge = False
                        break
                if outer_edge:
                    A.append(a)
                    B.append(b)
            w1.shape.for_edge(_check)

        result = Polygon()
        index = 0
        while True:
            result.append(A[index])
            # find where B[index] appears in A (identity-based)
            target = B[index]
            found = -1
            for k, v in enumerate(A):
                if v is target:
                    found = k
                    break
            index = found
            if index == 0:
                break

        return result

    def patch_by_vertex(self, v: Point) -> list[Patch]:
        return [p for p in self.patches if p.shape.contains_point(v)]

    def _build_streets(self) -> None:
        def smooth_street(street: Street) -> None:
            for _ in range(2):
                smoothed = street.smooth_vertex_eq(3)
                for i in range(1, len(street) - 1):
                    street[i].set_from(smoothed[i])

        self.topology = Topology(self)

        for gate in self.gates:
            if self.plaza is not None:
                end = array_utils.min_by(
                    list(self.plaza.shape),
                    lambda v: Point.distance(v, gate),
                )
            else:
                end = self.center

            street = self.topology.build_path(gate, end, self.topology.outer)
            if street is not None:
                self.streets.append(Polygon(street))

                if any(gate is g for g in self.border.gates):
                    direction = gate.norm(1000)
                    start = None
                    dist = float("inf")
                    for n in self.topology.node2pt.values():
                        d = Point.distance(n, direction)
                        if d < dist:
                            dist = d
                            start = n

                    road = self.topology.build_path(start, gate, self.topology.inner)
                    if road is not None:
                        self.roads.append(Polygon(road))
            else:
                raise RuntimeError("Unable to build a street!")

        self._tidy_up_roads()

        if self.road_style == "medieval":
            self._add_ring_roads()

        for a in self.arteries:
            smooth_street(a)

    def _add_ring_roads(self) -> None:
        """Add concentric ring streets for medieval layout.

        Collects Voronoi patch vertices at roughly the target radius,
        sorts them by angle around the city centre, and appends the
        resulting ring polylines as additional arteries.
        """
        if self.border is None:
            return

        wall_radius = self.border.get_radius()
        n_rings = 2 if self.n_patches < 12 else 3

        for ring_i in range(n_rings):
            # Place rings at evenly-spaced fractions of the wall radius
            t = (ring_i + 1) / (n_rings + 1)
            target_radius = wall_radius * t
            tolerance = target_radius * 0.3

            # Collect patch vertices close to this radius
            ring_pts: list[Point] = []
            for patch in self.inner:
                for v in patch.shape:
                    dx = v.x - self.center.x
                    dy = v.y - self.center.y
                    dist = math.sqrt(dx * dx + dy * dy)
                    if abs(dist - target_radius) < tolerance:
                        # Avoid adding the same Point identity twice
                        if not any(v is rp for rp in ring_pts):
                            ring_pts.append(v)

            if len(ring_pts) < 4:
                continue

            # Sort by angle around the city centre
            cx, cy = self.center.x, self.center.y
            ring_pts.sort(key=lambda p: math.atan2(p.y - cy, p.x - cx))

            # Remove points that are too close together
            filtered = [ring_pts[0]]
            for p in ring_pts[1:]:
                if Point.distance(p, filtered[-1]) > 3:
                    filtered.append(p)

            # Also check wrap-around: first vs last
            if len(filtered) > 1 and Point.distance(filtered[0], filtered[-1]) <= 3:
                filtered.pop()

            if len(filtered) < 4:
                continue

            # Build ring road as a closed polyline and add as artery
            ring_road = Polygon(filtered + [filtered[0]])
            self.arteries.append(ring_road)

    def _tidy_up_roads(self) -> None:
        segments: list[Segment] = []

        def cut2segments(street: Street) -> None:
            for i in range(1, len(street)):
                v0 = street[i - 1]
                v1 = street[i]

                if self.plaza is not None and self.plaza.shape.contains_point(v0) and self.plaza.shape.contains_point(v1):
                    continue

                exists = False
                for seg in segments:
                    if seg.start is v0 and seg.end is v1:
                        exists = True
                        break

                if not exists:
                    segments.append(Segment(v0, v1))

        for street in self.streets:
            cut2segments(street)
        for road in self.roads:
            cut2segments(road)

        self.arteries = []
        while len(segments) > 0:
            seg = segments.pop()
            attached = False
            for a in self.arteries:
                if a[0] is seg.end:
                    a.insert(0, seg.start)
                    attached = True
                    break
                elif a[-1] is seg.start:
                    a.append(seg.end)
                    attached = True
                    break
            if not attached:
                self.arteries.append(Polygon([seg.start, seg.end]))

    def _optimize_junctions(self) -> None:
        patches_to_optimize = (
            list(self.inner)
            if self.citadel is None
            else self.inner + [self.citadel]
        )

        wards2clean: list[Patch] = []
        for w in patches_to_optimize:
            index = 0
            while index < len(w.shape):
                v0 = w.shape[index]
                v1 = w.shape[(index + 1) % len(w.shape)]

                if v0 is not v1 and Point.distance(v0, v1) < 8:
                    for w1 in self.patch_by_vertex(v1):
                        if w1 is not w:
                            idx = w1.shape.index_of(v1)
                            if idx != -1:
                                w1.shape[idx] = v0
                            wards2clean.append(w1)

                    v0.add_eq(v1)
                    v0.scale_eq(0.5)

                    # Remove v1 identity-based
                    for k, p in enumerate(w.shape):
                        if p is v1:
                            del w.shape[k]
                            break
                index += 1

        for w in wards2clean:
            i = 0
            while i < len(w.shape):
                v = w.shape[i]
                j = i + 1
                while j < len(w.shape):
                    if w.shape[j] is v:
                        del w.shape[j]
                    else:
                        j += 1
                i += 1

    def _create_wards(self) -> None:
        from town_generator.wards.market import Market
        from town_generator.wards.gate_ward import GateWard
        from town_generator.wards.slum import Slum
        from town_generator.wards.farm import Farm
        from town_generator.wards.ward import Ward
        from town_generator.wards.cathedral import Cathedral
        from town_generator.wards.administration import AdministrationWard

        unassigned = list(self.inner)
        if self.plaza is not None:
            self.plaza.ward = Market(self, self.plaza)
            unassigned.remove(self.plaza)

        # Civic core: assign Cathedral/Administration to patches adjacent to plaza
        if self.plaza is not None:
            civic_types = []
            if self.temple_needed is not False:
                civic_types.append(Cathedral)
            civic_types.append(AdministrationWard)
            for civic_class in civic_types:
                best = None
                best_rate = float("inf")
                for p in unassigned:
                    if p.ward is None and p.shape.borders(self.plaza.shape):
                        rate_func = getattr(civic_class, "rate_location", None)
                        r = rate_func(self, p) if rate_func else 0
                        if r < best_rate:
                            best_rate = r
                            best = p
                if best is not None:
                    best.ward = civic_class(self, best)
                    unassigned.remove(best)

        for gate in self.border.gates:
            for patch in self.patch_by_vertex(gate):
                if patch.within_city and patch.ward is None and Random.bool(0.5 if self.wall is not None else 0.2):
                    patch.ward = GateWard(self, patch)
                    if patch in unassigned:
                        unassigned.remove(patch)

        wards = list(_get_ward_classes(self.style))
        # Some shuffling
        for i in range(len(wards) // 10):
            idx = Random.int(0, len(wards) - 1)
            wards[idx], wards[idx + 1] = wards[idx + 1], wards[idx]

        # Temple forcing
        if self.temple_needed is True:
            wards = [w for w in wards if w is not Cathedral]
            wards.insert(0, Cathedral)
        elif self.temple_needed is False:
            wards = [w for w in wards if w is not Cathedral]

        while len(unassigned) > 0:
            ward_class = wards.pop(0) if len(wards) > 0 else Slum
            rate_func = getattr(ward_class, "rate_location", None)

            if rate_func is None or rate_func is Ward.rate_location:
                best_patch = array_utils.random_element(unassigned)
                while best_patch.ward is not None:
                    best_patch = array_utils.random_element(unassigned)
            else:
                best_patch = array_utils.min_by(
                    unassigned,
                    lambda patch, rf=rate_func: rf(self, patch) if patch.ward is None else float("inf"),
                )

            best_patch.ward = ward_class(self, best_patch)
            unassigned.remove(best_patch)

        # Outskirts
        if self.wall is not None:
            for gate in self.wall.gates:
                if not Random.bool(1 / (self.n_patches - 5)):
                    for patch in self.patch_by_vertex(gate):
                        if patch.ward is None:
                            patch.within_city = True
                            patch.ward = GateWard(self, patch)

        # Calculating radius and processing countryside
        self.city_radius = 0
        for patch in self.patches:
            if patch.within_city:
                for v in patch.shape:
                    self.city_radius = max(self.city_radius, v.length)

        max_shanties = max(2, self.n_patches // 5)
        shanty_count = 0
        for patch in self.patches:
            if patch.within_city or patch.ward is not None:
                continue
            if (self.shanty_town_enabled
                    and shanty_count < max_shanties
                    and patch.shape.distance(self.center) < self.city_radius * 1.2):
                from town_generator.wards.shanty_town import ShantyTown
                patch.within_city = True
                patch.ward = ShantyTown(self, patch)
                shanty_count += 1
            elif Random.bool(0.2) and patch.shape.compactness >= 0.7:
                patch.ward = Farm(self, patch)
            else:
                patch.ward = Ward(self, patch)

    def _build_geometry(self) -> None:
        for patch in self.patches:
            if patch.ward is not None:
                patch.ward.create_geometry()

    def _generate_water(self) -> None:
        """Create water geometry early and remove fully submerged outer patches."""
        if not self.coast_enabled and not self.river_enabled:
            return

        radius = 0.0
        for p in self.inner:
            for v in p.shape:
                radius = max(radius, v.length)

        if self.coast_enabled:
            from town_generator.building.coast import Coast
            self.coast = Coast(radius, roughness=self.coast_roughness)
            # Remove outer patches fully in water
            surviving = []
            for patch in self.patches:
                if patch not in self.inner and self.coast.is_in_water(patch.shape.centroid):
                    self.waterbody.append(Patch(list(patch.shape)))
                else:
                    surviving.append(patch)
            self.patches = surviving

        if self.river_enabled:
            from town_generator.building.river import River
            self.river = River(
                radius,
                coast_direction=self.coast.direction if self.coast is not None else None,
                curvature=self.river_curvature,
            )

    def _clip_patches_to_water(self) -> None:
        """Clip patch shapes along coast/river boundaries for building alignment."""
        if self.coast is None and self.river is None:
            return

        for patch in self.patches:
            shape = patch.shape

            if self.coast is not None:
                clipped = self._clip_shape_against_boundary(
                    shape, self.coast.is_in_water, self.coast.shoreline
                )
                if clipped is not None:
                    shape = clipped

            if self.river is not None:
                for bank in [self.river.left_bank, self.river.right_bank]:
                    clipped = self._clip_shape_against_boundary(
                        shape, self.river.point_in_river, bank
                    )
                    if clipped is not None:
                        shape = clipped

            if shape is not patch.shape:
                patch.shape = shape

    @staticmethod
    def _clip_shape_against_boundary(
        shape: Polygon, is_in_water, boundary: list[Point]
    ) -> Polygon | None:
        """Clip a polygon against a water boundary polyline.

        Returns clipped land portion, or None if no clipping needed/possible.
        """
        in_water = [is_in_water(v) for v in shape]

        if not any(in_water):
            return None  # All land — no clipping needed
        if all(in_water):
            return None  # Fully submerged — keep as-is

        centroid = shape.centroid

        # Score boundary segments by distance to patch centroid
        scored: list[tuple[float, int]] = []
        for i in range(len(boundary) - 1):
            mx = (boundary[i].x + boundary[i + 1].x) * 0.5
            my = (boundary[i].y + boundary[i + 1].y) * 0.5
            d = (mx - centroid.x) ** 2 + (my - centroid.y) ** 2
            scored.append((d, i))
        scored.sort()

        # Try nearest boundary segments
        for _, i in scored[:10]:
            halves = shape.cut(boundary[i], boundary[i + 1])
            if len(halves) == 2:
                c0_wet = is_in_water(halves[0].centroid)
                c1_wet = is_in_water(halves[1].centroid)
                if not c0_wet and len(halves[0]) >= 3:
                    return halves[0]
                elif not c1_wet and len(halves[1]) >= 3:
                    return halves[1]
                break  # Both halves wet — stop trying

        return None  # Could not clip

    def get_neighbour(self, patch: Patch, v: Point) -> Patch | None:
        nxt = patch.shape.next(v)
        for p in self.patches:
            if p.shape.find_edge(nxt, v) != -1:
                return p
        return None

    def get_neighbours(self, patch: Patch) -> list[Patch]:
        return [p for p in self.patches if p is not patch and p.shape.borders(patch.shape)]

    def is_enclosed(self, patch: Patch) -> bool:
        return patch.within_city and (
            patch.within_walls
            or all(p.within_city for p in self.get_neighbours(patch))
        )

    # ------------------------------------------------------------------
    # CityMap JSON export (M3 data contract)
    # ------------------------------------------------------------------

    @staticmethod
    def _ward_type_name(ward) -> str:
        """Map ward class to a district type string."""
        from town_generator.wards.craftsmen import CraftsmenWard
        from town_generator.wards.merchant import MerchantWard
        from town_generator.wards.cathedral import Cathedral
        from town_generator.wards.administration import AdministrationWard
        from town_generator.wards.slum import Slum
        from town_generator.wards.patriciate import PatriciateWard
        from town_generator.wards.market import Market
        from town_generator.wards.military import MilitaryWard
        from town_generator.wards.park import Park
        from town_generator.wards.farm import Farm
        from town_generator.wards.gate_ward import GateWard
        from town_generator.wards.shanty_town import ShantyTown
        from town_generator.wards.castle import Castle
        from town_generator.wards.ward import Ward

        _map = {
            CraftsmenWard: "craftsmen",
            MerchantWard: "merchant",
            Cathedral: "cathedral",
            AdministrationWard: "administration",
            Slum: "slum",
            PatriciateWard: "patriciate",
            Market: "market",
            MilitaryWard: "military",
            Park: "park",
            Farm: "farm",
            GateWard: "gate",
            ShantyTown: "shanty_town",
            Castle: "castle",
        }
        return _map.get(type(ward), "residential")

    def _detect_landmarks(self) -> list[dict]:
        """Detect landmarks from ward assignments."""
        from town_generator.wards.cathedral import Cathedral
        from town_generator.wards.castle import Castle
        from town_generator.wards.market import Market

        landmarks = []
        for i, patch in enumerate(self.patches):
            if patch.ward is None:
                continue
            ward = patch.ward
            c = patch.shape.centroid
            if isinstance(ward, Castle):
                label = self.style.landmarks.castle_label
                landmarks.append({
                    "type": "castle",
                    "district_id": f"d{i}",
                    "centroid": [round(c.x, 2), round(c.y, 2)],
                    "label": label,
                })
            elif isinstance(ward, Cathedral):
                label = self.style.landmarks.cathedral_label
                landmarks.append({
                    "type": "cathedral",
                    "district_id": f"d{i}",
                    "centroid": [round(c.x, 2), round(c.y, 2)],
                    "label": label,
                })
            elif isinstance(ward, Market):
                label = self.style.landmarks.market_label
                landmarks.append({
                    "type": "market",
                    "district_id": f"d{i}",
                    "centroid": [round(c.x, 2), round(c.y, 2)],
                    "label": label,
                })
        return landmarks

    def _district_seed(self, district_index: int) -> int:
        base_seed = self.n_patches * 997 + district_index * 7919
        seed_base = self._district_seed_base if self._district_seed_base is not None else Random.get_seed()
        if seed_base > 0:
            base_seed += seed_base
        return (base_seed % 2147483646) + 1

    def _serialize_legacy_buildings(self, patch: Patch, district_id: str, district_type: str) -> list[dict] | None:
        if patch.ward is None or not patch.ward.geometry:
            return None

        buildings = []
        for index, footprint in enumerate(patch.ward.geometry):
            buildings.append({
                "id": f"{district_id}_b{index}",
                "footprint": [[round(v.x, 2), round(v.y, 2)] for v in footprint],
                "type": district_type,
                "sub_type": "",
                "stories": 1,
                "style_hints": {},
            })
        return buildings or None

    def _populate_district(self, patch: Patch, district_id: str, district_index: int, district_type: str) -> tuple[list[dict] | None, list[dict], str | None]:
        if patch.ward is None:
            return None, [], None

        block = patch.ward.get_city_block()
        if len(block) < 3 or abs(block.square) < max(4.0, self.district_min_area * 0.25):
            return self._serialize_legacy_buildings(patch, district_id, district_type), [], None

        from town_generator.district.base import PopulatorParams
        from town_generator.district.registry import POPULATORS, get_populator
        if self.district_populator_override in POPULATORS:
            populator = POPULATORS[self.district_populator_override]
        else:
            populator = get_populator(district_type, self.style.id)

        pop_params = PopulatorParams(
            min_area=self.district_min_area,
            grid_chaos=self.district_grid_chaos,
            size_chaos=self.district_size_chaos,
            empty_prob=self.district_empty_prob,
            density=self.district_density,
            alley_width=self.district_alley_width,
            seed=self._district_seed(district_index),
        )
        if self.district_roofscape_enabled:
            from town_generator.detail.processor import DetailParams
            from town_generator.detail.district_roofs import generate_district_roofscape

            detail_params = DetailParams(
                roof_type=self.district_roof_type,
                overhang=self.district_overhang,
                facade_density=self.district_facade_density,
                style=self.style.id,
            )
            result = generate_district_roofscape(
                polygon=block,
                populator=populator,
                pop_params=pop_params,
                detail_params=detail_params,
                style=self.style.id,
                massing_mode=self.district_massing_mode,
                complexity=self.district_complexity,
                complex_ratio=self.district_complex_ratio,
                join_ratio=self.district_join_ratio,
                setback_ratio=self.district_setback,
            )

            buildings = result.get("buildings") or None
            if buildings:
                for index, building in enumerate(buildings):
                    original_id = str(building.get("id", f"b{index}"))
                    building["id"] = f"{district_id}_{original_id}"
                    if building.get("compound"):
                        for wing_index, wing in enumerate(building.get("wings", [])):
                            wing["id"] = f"{building['id']}_w{wing_index}"
            alleys = result.get("alleys") or []
        else:
            result = populator.populate(block, pop_params)
            buildings = []
            for index, building in enumerate(result.buildings):
                buildings.append({
                    "id": f"{district_id}_b{index}",
                    "footprint": [[round(v.x, 2), round(v.y, 2)] for v in building.footprint],
                    "type": building.building_type or district_type,
                    "sub_type": building.sub_type,
                    "stories": building.stories,
                    "style_hints": building.style_hints,
                })
            alleys = [
                {"points": [[round(v.x, 2), round(v.y, 2)] for v in alley]}
                for alley in result.alleys
            ]

        if not buildings:
            buildings = self._serialize_legacy_buildings(patch, district_id, district_type)

        return buildings, alleys, populator.name

    def to_city_map(self) -> dict:
        """Export the model state as a CityMap JSON dict (M3 contract)."""
        saved_seed = Random.get_seed()
        self._district_seed_base = saved_seed
        # Build district list
        try:
            districts = []
            patch_ids: dict[int, str] = {}
            for i, patch in enumerate(self.patches):
                did = f"d{i}"
                patch_ids[id(patch)] = did

            for i, patch in enumerate(self.patches):
                did = f"d{i}"
                c = patch.shape.centroid
                ward_type = self._ward_type_name(patch.ward) if patch.ward else "empty"

                # Find adjacent district ids
                neighbours = self.get_neighbours(patch)
                adjacent = [patch_ids[id(n)] for n in neighbours if id(n) in patch_ids]

                # Detect landmark on this patch
                landmark = None
                if patch is self.plaza:
                    landmark = self.style.landmarks.market_label.lower().replace(" ", "_")
                elif patch is self.citadel:
                    landmark = self.style.landmarks.citadel_label.lower().replace(" ", "_")

                buildings, alleys, populator = self._populate_district(patch, did, i, ward_type)

                district = {
                    "id": did,
                    "type": ward_type,
                    "polygon": [[round(v.x, 2), round(v.y, 2)] for v in patch.shape],
                    "center": [round(c.x, 2), round(c.y, 2)],
                    "within_walls": patch.within_walls,
                    "within_city": patch.within_city,
                    "adjacent": adjacent,
                }
                if landmark:
                    district["landmark"] = landmark
                if populator:
                    district["populator"] = populator
                if alleys:
                    district["alleys"] = alleys
                if buildings:
                    district["buildings"] = buildings
                districts.append(district)

            # Streets/arteries
            streets = []
            for artery in self.arteries:
                streets.append({
                    "type": "artery",
                    "points": [[round(v.x, 2), round(v.y, 2)] for v in artery],
                    "width": 4.0,
                })
            for road in self.roads:
                streets.append({
                    "type": "road",
                    "points": [[round(v.x, 2), round(v.y, 2)] for v in road],
                    "width": 2.0,
                })

            # Walls
            walls = []
            if self.wall is not None:
                towers = [[round(v.x, 2), round(v.y, 2)] for v in self.wall.towers]
                gates = []
                for g in self.wall.gates:
                    gates.append({"position": [round(g.x, 2), round(g.y, 2)]})
                walls.append({
                    "polygon": [[round(v.x, 2), round(v.y, 2)] for v in self.wall.shape],
                    "type": self.style.wall_type,
                    "towers": towers,
                    "gates": gates,
                })

            # River
            rivers = []
            if self.river is not None:
                bridges = []
                for br in self.river.bridges:
                    bridges.append({
                        "start": [round(br.start.x, 2), round(br.start.y, 2)],
                        "end": [round(br.end.x, 2), round(br.end.y, 2)],
                    })
                rivers.append({
                    "path": [[round(v.x, 2), round(v.y, 2)] for v in self.river.path],
                    "polygon": [[round(v.x, 2), round(v.y, 2)] for v in self.river.polygon] if self.river.polygon else [],
                    "bridges": bridges,
                })

            # Coastline + water polygon
            coastline = []
            coast_water = []
            if self.coast is not None:
                coastline = [[round(v.x, 2), round(v.y, 2)] for v in self.coast.shoreline]
                if self.coast.water_polygon:
                    coast_water = [[round(v.x, 2), round(v.y, 2)] for v in self.coast.water_polygon]

            # Landmarks
            landmarks = self._detect_landmarks()

            return {
                "seed": Random._seed if hasattr(Random, '_seed') else -1,
                "style": self.style.id,
                "bounds": {
                    "cx": round(self.center.x, 2),
                    "cy": round(self.center.y, 2),
                    "radius": round(self.city_radius, 2),
                },
                "districts": districts,
                "streets": streets,
                "walls": walls,
                "landmarks": landmarks,
                "rivers": rivers,
                "coastline": coastline,
                "coast_water": coast_water,
            }
        finally:
            self._district_seed_base = None
            Random.reset(saved_seed)
