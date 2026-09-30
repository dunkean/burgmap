"""Straight skeleton algorithm for arbitrary simple polygons.

Computes the straight skeleton of a polygon, producing roof faces where
each original edge gets one sloped face. Based on the Felkel & Obdrzalek
approach with edge events and split events.

Pure Python, zero dependencies beyond stdlib.
"""

from __future__ import annotations

import heapq
import math
from dataclasses import dataclass, field


# ---------------------------------------------------------------------------
# Vector helpers (inline, no dependency on Point)
# ---------------------------------------------------------------------------

Vec2 = tuple[float, float]

_EPS = 1e-9


def _v_sub(a: Vec2, b: Vec2) -> Vec2:
    return (a[0] - b[0], a[1] - b[1])


def _v_add(a: Vec2, b: Vec2) -> Vec2:
    return (a[0] + b[0], a[1] + b[1])


def _v_scale(a: Vec2, s: float) -> Vec2:
    return (a[0] * s, a[1] * s)


def _v_dot(a: Vec2, b: Vec2) -> float:
    return a[0] * b[0] + a[1] * b[1]


def _v_cross(a: Vec2, b: Vec2) -> float:
    return a[0] * b[1] - a[1] * b[0]


def _v_len(a: Vec2) -> float:
    return math.sqrt(a[0] * a[0] + a[1] * a[1])


def _v_norm(a: Vec2) -> Vec2:
    ln = _v_len(a)
    if ln < _EPS:
        return (0.0, 0.0)
    return (a[0] / ln, a[1] / ln)


def _v_perp_left(a: Vec2) -> Vec2:
    """Left perpendicular (rotate 90 deg CCW)."""
    return (-a[1], a[0])


def _v_dist2(a: Vec2, b: Vec2) -> float:
    dx = a[0] - b[0]
    dy = a[1] - b[1]
    return dx * dx + dy * dy


# ---------------------------------------------------------------------------
# Core data structures
# ---------------------------------------------------------------------------

@dataclass
class _OrigEdge:
    """An original polygon edge with its line equation."""
    __slots__ = ("start", "end", "index", "direction", "normal")
    start: Vec2
    end: Vec2
    index: int
    direction: Vec2  # unit direction along edge
    normal: Vec2     # unit inward normal

    def __init__(self, start: Vec2, end: Vec2, index: int):
        self.start = start
        self.end = end
        self.index = index
        d = _v_sub(end, start)
        self.direction = _v_norm(d)
        self.normal = _v_perp_left(self.direction)

    def signed_dist(self, p: Vec2) -> float:
        """Signed distance from p to the supporting line (positive = inward side)."""
        return _v_dot(self.normal, _v_sub(p, self.start))


class _Node:
    """Active vertex in the shrinking polygon (LAV node)."""
    __slots__ = (
        "point", "edge_left", "edge_right", "prev", "next",
        "bisector_dir", "is_reflex", "valid", "lav", "_is_antiparallel",
    )

    def __init__(self, point: Vec2, edge_left: _OrigEdge, edge_right: _OrigEdge):
        self.point = point
        self.edge_left = edge_left   # edge arriving at this vertex
        self.edge_right = edge_right  # edge departing from this vertex
        self.prev: _Node | None = None
        self.next: _Node | None = None
        self.valid = True
        self.lav: _LAV | None = None
        self._compute_bisector()

    def _compute_bisector(self):
        # Sum of inward normals gives bisector direction
        nl = self.edge_left.normal
        nr = self.edge_right.normal
        b = _v_add(nl, nr)
        blen = _v_len(b)
        if blen < 1e-6:
            # Anti-parallel edges: temporary direction (will be fixed by
            # _recompute_bisector_antiparallel once LAV neighbors are linked)
            self.bisector_dir = _v_perp_left(self.edge_left.direction)
            self._is_antiparallel = True
        else:
            self.bisector_dir = _v_norm(b)
            self._is_antiparallel = False

        # Reflex if cross product of edge directions indicates CW turn
        cross = _v_cross(self.edge_left.direction, self.edge_right.direction)
        self.is_reflex = cross < -_EPS

    def _recompute_bisector_antiparallel(self):
        """Fix bisector for anti-parallel edges using LAV neighbor midpoint."""
        if not self._is_antiparallel:
            return
        if self.prev is not None and self.next is not None:
            mid = (
                (self.prev.point[0] + self.next.point[0]) / 2.0,
                (self.prev.point[1] + self.next.point[1]) / 2.0,
            )
            to_mid = _v_sub(mid, self.point)
            if _v_len(to_mid) > _EPS:
                self.bisector_dir = _v_norm(to_mid)
                return
        # Fallback: use edge direction
        self.bisector_dir = _v_perp_left(self.edge_left.direction)

    def bisector_point(self, t: float) -> Vec2:
        return _v_add(self.point, _v_scale(self.bisector_dir, t))

    def invalidate(self):
        self.valid = False


class _LAV:
    """List of Active Vertices — a circular doubly-linked list."""
    __slots__ = ("head", "length")

    def __init__(self):
        self.head: _Node | None = None
        self.length = 0

    def add(self, node: _Node):
        node.lav = self
        if self.head is None:
            self.head = node
            node.prev = node
            node.next = node
        else:
            last = self.head.prev
            last.next = node
            node.prev = last
            node.next = self.head
            self.head.prev = node
        self.length += 1

    def remove(self, node: _Node):
        if self.length <= 1:
            self.head = None
            self.length = 0
            return
        node.prev.next = node.next
        node.next.prev = node.prev
        if self.head is node:
            self.head = node.next
        self.length -= 1

    def __iter__(self):
        if self.head is None:
            return
        cur = self.head
        while True:
            yield cur
            cur = cur.next
            if cur is self.head:
                break


# ---------------------------------------------------------------------------
# Event types
# ---------------------------------------------------------------------------

_EVENT_EDGE = 0
_EVENT_SPLIT = 1

@dataclass(order=True)
class _Event:
    distance: float
    _seq: int = field(compare=True)  # tiebreaker
    event_type: int = field(compare=False)
    point: Vec2 = field(compare=False)
    node_a: _Node = field(compare=False)
    node_b: _Node | None = field(compare=False, default=None)
    opposite_edge: _OrigEdge | None = field(compare=False, default=None)


# ---------------------------------------------------------------------------
# Skeleton arc and face output
# ---------------------------------------------------------------------------

@dataclass
class SkeletonArc:
    """A line segment of the skeleton."""
    start: Vec2
    end: Vec2
    left_face: int   # index of original edge on the left
    right_face: int   # index of original edge on the right


@dataclass
class SkeletonFace:
    """A roof face corresponding to one original polygon edge."""
    edge_index: int
    vertices: list[Vec2]  # ordered polygon vertices for this face


# ---------------------------------------------------------------------------
# Ray-ray intersection
# ---------------------------------------------------------------------------

def _ray_ray_intersect(
    p1: Vec2, d1: Vec2, p2: Vec2, d2: Vec2,
) -> tuple[float, float] | None:
    """Intersect ray(p1,d1) with ray(p2,d2). Returns (t1, t2) or None if parallel."""
    cross = _v_cross(d1, d2)
    if abs(cross) < _EPS:
        return None
    dp = _v_sub(p2, p1)
    t1 = _v_cross(dp, d2) / cross
    t2 = _v_cross(dp, d1) / cross
    return (t1, t2)


# ---------------------------------------------------------------------------
# Event computation
# ---------------------------------------------------------------------------

def _compute_edge_event(node: _Node, seq_counter: list[int]) -> _Event | None:
    """Compute when node and node.next collide (their shared edge vanishes)."""
    nb = node.next
    if nb is None or not nb.valid:
        return None

    result = _ray_ray_intersect(
        node.point, node.bisector_dir,
        nb.point, nb.bisector_dir,
    )
    if result is None:
        return None

    t1, t2 = result
    if t1 < -_EPS or t2 < -_EPS:
        return None

    pt = node.bisector_point(t1)

    # Distance = perpendicular distance from pt to the shared edge
    dist = node.edge_right.signed_dist(pt)
    if dist < -_EPS:
        return None

    seq_counter[0] += 1
    return _Event(
        distance=dist, _seq=seq_counter[0],
        event_type=_EVENT_EDGE, point=pt,
        node_a=node, node_b=nb,
    )


def _compute_split_events(
    node: _Node, edges: list[_OrigEdge], seq_counter: list[int],
) -> list[_Event]:
    """For a reflex vertex, compute potential split events against non-adjacent edges."""
    if not node.is_reflex:
        return []

    events = []
    for edge in edges:
        # Skip adjacent edges
        if edge is node.edge_left or edge is node.edge_right:
            continue

        d0 = edge.signed_dist(node.point)
        dv = _v_dot(edge.normal, node.bisector_dir)

        if abs(dv) < _EPS:
            continue  # bisector parallel to edge

        # Time for bisector to reach the edge's supporting line
        t = -d0 / dv
        if t < _EPS:
            continue

        pt = node.bisector_point(t)

        # Check if intersection is strictly interior to the edge segment
        # (reject hits at or near endpoints — those are vertex events, not splits)
        edge_vec = _v_sub(edge.end, edge.start)
        edge_len2 = _v_dot(edge_vec, edge_vec)
        if edge_len2 < _EPS:
            continue
        proj = _v_dot(_v_sub(pt, edge.start), edge_vec) / edge_len2
        if proj < 0.02 or proj > 0.98:
            continue

        # Verify the point is on the correct (inward) side of both adjacent edges
        dl = node.edge_left.signed_dist(pt)
        dr = node.edge_right.signed_dist(pt)
        if dl < -_EPS or dr < -_EPS:
            continue

        dist = max(dl, dr, _EPS)

        seq_counter[0] += 1
        events.append(_Event(
            distance=dist, _seq=seq_counter[0],
            event_type=_EVENT_SPLIT, point=pt,
            node_a=node, opposite_edge=edge,
        ))

    return events


# ---------------------------------------------------------------------------
# Main algorithm
# ---------------------------------------------------------------------------

def compute_straight_skeleton(polygon: list[Vec2]) -> list[SkeletonArc]:
    """Compute the straight skeleton of a simple polygon.

    Args:
        polygon: List of (x, y) vertices (either winding).

    Returns:
        List of SkeletonArc segments forming the skeleton.
    """
    n = len(polygon)
    if n < 3:
        return []

    # Ensure CCW orientation
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += polygon[i][0] * polygon[j][1] - polygon[j][0] * polygon[i][1]
    if area < 0:
        polygon = list(reversed(polygon))

    # Build original edges
    edges = []
    for i in range(n):
        j = (i + 1) % n
        edges.append(_OrigEdge(polygon[i], polygon[j], i))

    # Initialize LAV
    lav = _LAV()
    nodes = []
    for i in range(n):
        edge_left = edges[(i - 1) % n]
        edge_right = edges[i]
        node = _Node(polygon[i], edge_left, edge_right)
        nodes.append(node)
        lav.add(node)

    # Fix any anti-parallel bisectors now that LAV is linked
    for node in nodes:
        node._recompute_bisector_antiparallel()

    lavs = [lav]
    arcs: list[SkeletonArc] = []
    seq_counter = [0]

    # Initial event queue
    pq: list[_Event] = []
    for node in nodes:
        ev = _compute_edge_event(node, seq_counter)
        if ev:
            heapq.heappush(pq, ev)
        for sev in _compute_split_events(node, edges, seq_counter):
            heapq.heappush(pq, sev)

    # Process events (with safety limit)
    max_events = n * n * 4
    processed = 0
    while pq and processed < max_events:
        event = heapq.heappop(pq)
        processed += 1

        if event.event_type == _EVENT_EDGE:
            _handle_edge_event(event, lavs, edges, arcs, pq, seq_counter)
        else:
            _handle_split_event(event, lavs, edges, arcs, pq, seq_counter)

    # Handle remaining LAVs
    for lv in lavs:
        if lv.head is None or lv.length < 2:
            continue
        ns = list(lv)
        if not ns:
            continue
        # Compute intersection point of all remaining bisectors (use centroid)
        cx = sum(nd.point[0] for nd in ns) / len(ns)
        cy = sum(nd.point[1] for nd in ns) / len(ns)
        peak = (cx, cy)
        for nd in ns:
            if nd.valid:
                arcs.append(SkeletonArc(
                    start=nd.point, end=peak,
                    left_face=nd.edge_left.index,
                    right_face=nd.edge_right.index,
                ))
                nd.invalidate()
        lv.head = None
        lv.length = 0

    # Filter degenerate arcs (start == end)
    arcs = [a for a in arcs if _v_dist2(a.start, a.end) > _EPS * _EPS]

    return arcs


def _handle_edge_event(
    event: _Event,
    lavs: list[_LAV],
    edges: list[_OrigEdge],
    arcs: list[SkeletonArc],
    pq: list[_Event],
    seq_counter: list[int],
):
    """Handle edge event: two adjacent nodes merge, shared edge collapses."""
    na = event.node_a
    nb = event.node_b

    if not na.valid or not nb.valid:
        return

    pt = event.point

    # Emit skeleton arcs from both nodes to the event point
    arcs.append(SkeletonArc(
        start=na.point, end=pt,
        left_face=na.edge_left.index,
        right_face=na.edge_right.index,
    ))
    arcs.append(SkeletonArc(
        start=nb.point, end=pt,
        left_face=nb.edge_left.index,
        right_face=nb.edge_right.index,
    ))

    the_lav = na.lav

    # If only 3 nodes left in LAV, this is the final collapse
    if the_lav is not None and the_lav.length <= 3:
        # Last triangle: connect remaining node(s) to the peak
        remaining = na.prev
        if remaining is na or remaining is nb:
            remaining = nb.next
        if remaining is not None and remaining is not na and remaining is not nb and remaining.valid:
            arcs.append(SkeletonArc(
                start=remaining.point, end=pt,
                left_face=remaining.edge_left.index,
                right_face=remaining.edge_right.index,
            ))
            remaining.invalidate()
        na.invalidate()
        nb.invalidate()
        the_lav.head = None
        the_lav.length = 0
        return

    # Create new node at the intersection point
    new_node = _Node(pt, na.edge_left, nb.edge_right)

    # Remove old nodes and insert new one
    na.invalidate()
    nb.invalidate()

    if the_lav is not None:
        prev_node = na.prev
        next_node = nb.next

        new_node.prev = prev_node
        new_node.next = next_node
        prev_node.next = new_node
        next_node.prev = new_node
        new_node.lav = the_lav
        new_node._recompute_bisector_antiparallel()

        the_lav.length -= 1  # removed 2, added 1
        if the_lav.head is na or the_lav.head is nb:
            the_lav.head = new_node

        # Compute new events
        ev = _compute_edge_event(new_node, seq_counter)
        if ev:
            heapq.heappush(pq, ev)
        ev2 = _compute_edge_event(new_node.prev, seq_counter)
        if ev2:
            heapq.heappush(pq, ev2)
        for sev in _compute_split_events(new_node, edges, seq_counter):
            heapq.heappush(pq, sev)


def _handle_split_event(
    event: _Event,
    lavs: list[_LAV],
    edges: list[_OrigEdge],
    arcs: list[SkeletonArc],
    pq: list[_Event],
    seq_counter: list[int],
):
    """Handle split event: reflex vertex reaches an opposite edge, splitting the LAV."""
    node = event.node_a
    if not node.valid:
        return

    opp_edge = event.opposite_edge
    if opp_edge is None:
        return

    pt = event.point

    # Emit skeleton arc from the splitting node
    arcs.append(SkeletonArc(
        start=node.point, end=pt,
        left_face=node.edge_left.index,
        right_face=node.edge_right.index,
    ))

    the_lav = node.lav
    if the_lav is None:
        return

    # Find the nodes in the LAV that bound the opposite edge
    v1 = None  # node whose edge_left is opp_edge
    v2 = None  # node whose edge_right is opp_edge

    for nd in the_lav:
        if nd is node:
            continue
        if nd.edge_left is opp_edge:
            v1 = nd
        if nd.edge_right is opp_edge:
            v2 = nd

    if v1 is None or v2 is None:
        # Also search other LAVs (edge might be in a different LAV)
        for other_lav in lavs:
            if other_lav is the_lav:
                continue
            for nd in other_lav:
                if nd.edge_left is opp_edge:
                    v1 = nd
                if nd.edge_right is opp_edge:
                    v2 = nd

    if v1 is None or v2 is None:
        return

    node.invalidate()

    # Create two new nodes at the split point
    new_node1 = _Node(pt, node.edge_left, opp_edge)
    new_node2 = _Node(pt, opp_edge, node.edge_right)

    prev_n = node.prev
    next_n = node.next

    if v1.lav is the_lav and v2.lav is the_lav:
        # Same LAV: split into two
        lav1 = _LAV()
        new_node1.prev = prev_n
        prev_n.next = new_node1
        new_node1.next = v1
        v1.prev = new_node1
        cur = new_node1
        while True:
            cur.lav = lav1
            lav1.length += 1
            cur = cur.next
            if cur is new_node1:
                break
        lav1.head = new_node1

        lav2 = _LAV()
        new_node2.next = next_n
        next_n.prev = new_node2
        new_node2.prev = v2
        v2.next = new_node2
        cur = new_node2
        while True:
            cur.lav = lav2
            lav2.length += 1
            cur = cur.next
            if cur is new_node2:
                break
        lav2.head = new_node2

        if the_lav in lavs:
            lavs.remove(the_lav)
        lavs.append(lav1)
        lavs.append(lav2)
    else:
        # Different LAVs: merge them
        other_lav = v1.lav if v1.lav is not the_lav else v2.lav

        merged = _LAV()
        new_node1.prev = prev_n
        prev_n.next = new_node1
        new_node1.next = v1
        v1.prev = new_node1

        new_node2.prev = v2
        v2.next = new_node2
        new_node2.next = next_n
        next_n.prev = new_node2

        cur = new_node1
        while True:
            cur.lav = merged
            merged.length += 1
            cur = cur.next
            if cur is new_node1:
                break
        merged.head = new_node1

        if the_lav in lavs:
            lavs.remove(the_lav)
        if other_lav in lavs:
            lavs.remove(other_lav)
        lavs.append(merged)

    # Fix anti-parallel bisectors for new nodes (now that they're linked)
    new_node1._recompute_bisector_antiparallel()
    new_node2._recompute_bisector_antiparallel()

    # Compute events for new nodes
    for new_nd in (new_node1, new_node2):
        ev = _compute_edge_event(new_nd, seq_counter)
        if ev:
            heapq.heappush(pq, ev)
        ev2 = _compute_edge_event(new_nd.prev, seq_counter)
        if ev2:
            heapq.heappush(pq, ev2)
        for sev in _compute_split_events(new_nd, edges, seq_counter):
            heapq.heappush(pq, sev)


# ---------------------------------------------------------------------------
# Face reconstruction from skeleton arcs
# ---------------------------------------------------------------------------

def skeleton_to_faces(
    polygon: list[Vec2], arcs: list[SkeletonArc],
) -> list[SkeletonFace]:
    """Reconstruct roof faces from the skeleton arcs.

    Each original edge gets one face. Uses topological edge chaining:
    for face F, each arc with left_face=F is traversed start->end,
    and right_face=F is traversed end->start. Combined with the polygon
    edge, these form a closed loop without angular-sort artifacts on
    concave polygons.
    """
    n = len(polygon)
    if n < 3:
        return []

    # Build directed edges per face
    face_edges: dict[int, list[tuple[Vec2, Vec2]]] = {i: [] for i in range(n)}

    for arc in arcs:
        # Left face: traversed start -> end
        face_edges[arc.left_face].append((arc.start, arc.end))
        # Right face: traversed end -> start
        face_edges[arc.right_face].append((arc.end, arc.start))

    # Add polygon edges
    for i in range(n):
        j = (i + 1) % n
        face_edges[i].append((polygon[i], polygon[j]))

    faces = []
    for i in range(n):
        edges = face_edges[i]
        if len(edges) < 3:
            continue

        # Build adjacency: from rounded point key -> actual next point
        adj: dict[tuple[float, float], Vec2] = {}
        for s, e in edges:
            sk = (round(s[0], 6), round(s[1], 6))
            adj[sk] = e

        # Chain from polygon[i]
        start = polygon[i]
        start_key = (round(start[0], 6), round(start[1], 6))
        chain: list[Vec2] = [start]
        cur_key = start_key

        for _ in range(len(edges) + 2):
            if cur_key not in adj:
                break
            nxt = adj[cur_key]
            nxt_key = (round(nxt[0], 6), round(nxt[1], 6))
            if nxt_key == start_key:
                break  # closed loop
            chain.append(nxt)
            cur_key = nxt_key

        if len(chain) >= 3:
            faces.append(SkeletonFace(edge_index=i, vertices=chain))

    return faces


def compute_skeleton_faces(polygon: list[Vec2]) -> list[SkeletonFace]:
    """Convenience: compute straight skeleton and return faces."""
    arcs = compute_straight_skeleton(polygon)
    return skeleton_to_faces(polygon, arcs)
