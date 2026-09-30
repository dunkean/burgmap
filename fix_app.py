import sys
import os

with open('town_generator/webapp/app.py', 'r') as f:
    text = f.read()

prefix = text
if '@app.get("/tools/gen-roofs/", response_class=HTMLResponse)' in text:
    prefix = text.split('@app.get("/tools/gen-roofs/", response_class=HTMLResponse)')[0]

new_code = """@app.get("/tools/gen-roofs/", response_class=HTMLResponse)
def gen_roofs_editor():
    with open(os.path.join(TEMPLATE_DIR, "gen_roofs.html"), "r") as f:
        return f.read()

@app.get("/api/gen_roofs")
def generate_gen_roofs(
    roof_type: str = Query(default=""),
    overhang: float = Query(default=-1.0),
    style: str = Query(default="generic"),
    building_type: str = Query(default="house"),
    stories: int = Query(default=1),
    polygon: str = Query(default=""),
    levels: str = Query(default=""),
):
    import json
    from town_generator.geom.point import Point
    from town_generator.geom.polygon import Polygon
    from town_generator.detail.roof import RoofGeometry, RoofFace
    from town_generator.detail.gen_roofs import process_gen_roof

    selected_roof_type = roof_type if roof_type and roof_type != "auto" else "auto"

    if levels:
        raw_levels = json.loads(levels)
    else:
        if polygon:
            raw_polygon = json.loads(polygon)
        else:
            raw_polygon = [[-9, -6], [11, -5], [14, 1], [7, 8], [-3, 9], [-12, 2]]
        raw_levels = [{
            "id": "level_1",
            "polygon": raw_polygon,
            "stories": stories,
            "building_type": building_type,
        }]

    out_levels = []
    for idx, raw_level in enumerate(raw_levels):
        pts_raw = raw_level.get("polygon", [])
        if len(pts_raw) < 3:
            continue
        fp = Polygon([Point(p[0], p[1]) for p in pts_raw])
        level_stories = int(raw_level.get("stories", stories))
        level_type = raw_level.get("building_type", building_type)
        level_style = raw_level.get("style", style)

        custom_data = process_gen_roof(fp, style=level_style)

        polygon_coords = [[round(p.x, 2), round(p.y, 2)] for p in fp]
        out_levels.append({
            "id": str(raw_level.get("id", f"level_{idx + 1}")),
            "label": raw_level.get("label", f"Level {idx + 1}"),
            "polygon": polygon_coords,
            "footprint": polygon_coords,
            "building_type": level_type,
            "style": level_style,
            "stories": level_stories,
            "roof": custom_data,
        })

    return {
        "multi_level": len(out_levels) > 1,
        "levels": out_levels,
        "params": {
            "roof_type": selected_roof_type,
            "overhang": overhang if overhang >= 0 else "auto",
            "style": style,
            "building_type": building_type,
            "stories": stories,
        },
    }
"""

with open('town_generator/webapp/app.py', 'w') as f:
    f.write(prefix + new_code)
print('Fixed app.py!')
