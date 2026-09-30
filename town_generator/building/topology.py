"""Street graph from patches + pathfinding. Port of Topology.hx."""

from __future__ import annotations

from typing import TYPE_CHECKING

from town_generator.geom.point import Point
from town_generator.geom.graph import Graph, Node
from town_generator.utils import array_utils

if TYPE_CHECKING:
    from town_generator.building.model import Model


class Topology:
    def __init__(self, model: Model) -> None:
        self.model = model
        self.graph = Graph()
        self.pt2node: dict[int, Node] = {}
        self.node2pt: dict[Node, Point] = {}

        self.blocked: list[Point] = []
        self.inner: list[Node] = []
        self.outer: list[Node] = []

        if model.citadel is not None:
            self.blocked = self.blocked + list(model.citadel.shape)
        if model.wall is not None:
            self.blocked = self.blocked + list(model.wall.shape)
        self.blocked = array_utils.difference(self.blocked, model.gates)

        border = model.border.shape

        for p in model.patches:
            within_city = p.within_city
            n_verts = len(p.shape)

            v1 = p.shape[-1]
            n1 = self._process_point(v1)

            for i in range(n_verts):
                v0, v1 = v1, p.shape[i]
                n0, n1 = n1, self._process_point(v1)

                if n0 is not None and not border.contains_point(v0):
                    if within_city:
                        array_utils.add_unique(self.inner, n0)
                    else:
                        array_utils.add_unique(self.outer, n0)
                if n1 is not None and not border.contains_point(v1):
                    if within_city:
                        array_utils.add_unique(self.inner, n1)
                    else:
                        array_utils.add_unique(self.outer, n1)

                if n0 is not None and n1 is not None:
                    n0.link(n1, Point.distance(v0, v1))

    def _process_point(self, v: Point) -> Node | None:
        vid = id(v)
        if vid in self.pt2node:
            n = self.pt2node[vid]
        else:
            n = self.graph.add()
            self.pt2node[vid] = n
            self.node2pt[n] = v

        if any(v is b for b in self.blocked):
            return None
        return n

    def build_path(
        self,
        from_pt: Point,
        to_pt: Point,
        exclude: list[Node] | None = None,
    ) -> list[Point] | None:
        from_node = self.pt2node.get(id(from_pt))
        to_node = self.pt2node.get(id(to_pt))
        if from_node is None or to_node is None:
            return None
        path = self.graph.a_star(from_node, to_node, exclude)
        if path is None:
            return None
        return [self.node2pt[n] for n in path]
