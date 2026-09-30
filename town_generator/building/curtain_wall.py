"""City walls, gates, and towers. Port of CurtainWall.hx."""

from __future__ import annotations

from typing import TYPE_CHECKING

from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon
from town_generator.utils.random import Random

if TYPE_CHECKING:
    from town_generator.building.model import Model
    from town_generator.building.patch import Patch


class CurtainWall:
    def __init__(
        self,
        real: bool,
        model: Model,
        patches: list[Patch],
        reserved: list[Point],
    ) -> None:
        self.real = True
        self.patches = patches

        if len(patches) == 1:
            self.shape = patches[0].shape
        else:
            from town_generator.building.model import Model as M
            self.shape = M.find_circumference(patches)

            if real:
                smooth_factor = min(1, 40 / len(patches))
                smoothed = [
                    v if any(v is rv for rv in reserved)
                    else self.shape.smooth_vertex(v, smooth_factor)
                    for v in self.shape
                ]
                self.shape.set_from(Polygon(smoothed))

        self.segments: list[bool] = [True for _ in self.shape]
        self.gates: list[Point] = []
        self.towers: list[Point] = []

        self._build_gates(real, model, reserved)

    def _build_gates(self, real: bool, model: Model, reserved: list[Point]) -> None:
        self.gates = []

        if len(self.patches) > 1:
            entrances = [
                v for v in self.shape
                if not any(v is rv for rv in reserved)
                and sum(1 for p in self.patches if p.shape.contains_point(v)) > 1
            ]
        else:
            entrances = [v for v in self.shape if not any(v is rv for rv in reserved)]

        if len(entrances) == 0:
            raise RuntimeError("Bad walled area shape!")

        while True:
            index = Random.int(0, len(entrances))
            gate = entrances[index]
            self.gates.append(gate)

            if real:
                outer_wards = [
                    w for w in model.patch_by_vertex(gate)
                    if not any(w is p for p in self.patches)
                ]
                if len(outer_wards) == 1:
                    outer = outer_wards[0]
                    if len(outer.shape) > 3:
                        wall_v = self.shape.next(gate).subtract(self.shape.prev(gate))
                        out = Point(wall_v.y, -wall_v.x)

                        from town_generator.utils import array_utils

                        def _rate(v: Point) -> float:
                            if self.shape.contains_point(v) or any(v is rv for rv in reserved):
                                return float("-inf")
                            else:
                                dir_v = v.subtract(gate)
                                return dir_v.dot(out) / dir_v.length

                        farthest = array_utils.max_by(list(outer.shape), _rate)
                        new_patches = [
                            _make_patch(half)
                            for half in outer.shape.split(gate, farthest)
                        ]
                        array_utils.replace(model.patches, outer, new_patches)

            if index == 0:
                entrances = entrances[2:]
                if entrances:
                    entrances.pop()
            elif index == len(entrances) - 1:
                del entrances[index - 1:]
                if entrances:
                    entrances.pop(0)
            else:
                del entrances[index - 1:index + 2]

            if len(entrances) < 3:
                break

        if len(self.gates) == 0:
            raise RuntimeError("Bad walled area shape!")

        if real:
            for gate in self.gates:
                smoothed = self.shape.smooth_vertex(gate)
                gate.set_from(smoothed)

    def build_towers(self) -> None:
        self.towers = []
        if self.real:
            n = len(self.shape)
            for i in range(n):
                t = self.shape[i]
                if (
                    not any(t is g for g in self.gates)
                    and (self.segments[(i + n - 1) % n] or self.segments[i])
                ):
                    self.towers.append(t)

    def get_radius(self) -> float:
        radius = 0.0
        for v in self.shape:
            radius = max(radius, v.length)
        return radius

    def borders_by(self, p: Patch, v0: Point, v1: Point) -> bool:
        if any(p is pp for pp in self.patches):
            index = self.shape.find_edge(v0, v1)
        else:
            index = self.shape.find_edge(v1, v0)
        return index != -1 and self.segments[index]

    def borders(self, p: Patch) -> bool:
        within_walls = any(p is pp for pp in self.patches)
        length = len(self.shape)
        for i in range(length):
            if self.segments[i]:
                v0 = self.shape[i]
                v1 = self.shape[(i + 1) % length]
                if within_walls:
                    index = p.shape.find_edge(v0, v1)
                else:
                    index = p.shape.find_edge(v1, v0)
                if index != -1:
                    return True
        return False


def _make_patch(poly: Polygon) -> Patch:
    from town_generator.building.patch import Patch
    return Patch(list(poly))
