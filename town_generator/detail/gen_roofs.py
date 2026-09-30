from __future__ import annotations

import math
from town_generator.geom.point import Point
from town_generator.geom.polygon import Polygon

def process_gen_roof(polygon: Polygon, style: str, **kwargs):
    # Calculate center
    cx = sum(p.x for p in polygon) / len(polygon)
    cy = sum(p.y for p in polygon) / len(polygon)
    
    faces = []
    for i in range(len(polygon)):
        p1 = polygon[i]
        p2 = polygon[(i + 1) % len(polygon)]
        
        # Calculate normal direction (approximate direction for coloring)
        dx = p2.x - p1.x
        dy = p2.y - p1.y
        # perpendicular
        nx, ny = dy, -dx
        length = math.hypot(nx, ny)
        if length > 0:
            nx, ny = nx / length, ny / length
            
        faces.append({
            "polygon": [[p1.x, p1.y], [p2.x, p2.y], [cx, cy]],
            "direction": [nx, ny]
        })
        
    return {
        "type": "custom_skeleton",
        "polygon": [[p.x, p.y] for p in polygon],
        "ridge_polygon": [[cx, cy]],
        "overhang": 0.0,
        "faces": faces,
        "extras": {}
    }

