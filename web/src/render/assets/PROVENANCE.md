# Natural map brushes

Generated with the built-in ImageGen tool on 2026-10-05, at the user’s explicit request. The untouched transparent RGBA originals and full generation/edit prompts are stored here. No manual pixel edits. Both atlases are 1254×1254, a 6×6 grid with 209×209 cells; symbols crop whole cells and keep their original alpha.

Vegetation rows: temperate, forest, desert, steppe, tropical, tundra. Column species are specified in prompts.json. Vegetation v2 corrects the birch (0,2) and steppe acacia (3,0) to overhead views. Terrain rows: dunes, rocks, grass, reeds, garden plants, crops.

Payload: 3497089 PNG bytes; base64 adds about one third. Only the main bundle embeds the URI literals. SVG exports embed each atlas once; classic exports contain no brush image.

{
  "biome-vegetation-v2.png": {
    "bytes": 1625224,
    "sha256": "af7a51b3d7cd4549ca68c1fdf5360eeb1cfbc53261331953646fdf091b927706"
  },
  "terrain-cultivation-v1.png": {
    "bytes": 1871865,
    "sha256": "889759ad696b9ace262b73236ab114bc202c1d8f215ae959cd77dec49dbee3c4"
  }
}
