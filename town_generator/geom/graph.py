"""Graph + Node + A* pathfinding. Port of Graph.hx."""

from __future__ import annotations

import math


class Node:
    def __init__(self) -> None:
        self.links: dict[Node, float] = {}

    def link(self, node: Node, price: float = 1.0, symmetrical: bool = True) -> None:
        self.links[node] = price
        if symmetrical:
            node.links[self] = price

    def unlink(self, node: Node, symmetrical: bool = True) -> None:
        self.links.pop(node, None)
        if symmetrical:
            node.links.pop(self, None)

    def unlink_all(self) -> None:
        for node in list(self.links.keys()):
            self.unlink(node)


class Graph:
    def __init__(self) -> None:
        self.nodes: list[Node] = []

    def add(self, node: Node | None = None) -> Node:
        if node is None:
            node = Node()
        self.nodes.append(node)
        return node

    def remove(self, node: Node) -> None:
        node.unlink_all()
        self.nodes.remove(node)

    def a_star(
        self,
        start: Node,
        goal: Node,
        exclude: list[Node] | None = None,
    ) -> list[Node] | None:
        closed_set: list[Node] = list(exclude) if exclude else []
        open_set: list[Node] = [start]
        came_from: dict[Node, Node] = {}
        g_score: dict[Node, float] = {start: 0}

        while len(open_set) > 0:
            current = open_set.pop(0)
            if current is goal:
                return self._build_path(came_from, current)

            closed_set.append(current)
            cur_score = g_score[current]

            for neighbour, cost in current.links.items():
                if neighbour in closed_set:
                    continue

                score = cur_score + cost
                if neighbour not in open_set:
                    open_set.append(neighbour)
                elif score >= g_score.get(neighbour, math.inf):
                    continue

                came_from[neighbour] = current
                g_score[neighbour] = score

        return None

    @staticmethod
    def _build_path(came_from: dict[Node, Node], current: Node) -> list[Node]:
        path = [current]
        while current in came_from:
            current = came_from[current]
            path.append(current)
        return path

    def calculate_price(self, path: list[Node]) -> float:
        if len(path) < 2:
            return 0.0
        price = 0.0
        for i in range(len(path) - 1):
            current = path[i]
            nxt = path[i + 1]
            if nxt in current.links:
                price += current.links[nxt]
            else:
                return math.nan
        return price
