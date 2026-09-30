"""CLI entry point."""

from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="town-generator",
        description="Generate a medieval fantasy town as SVG or PNG.",
    )
    parser.add_argument("-s", "--seed", type=int, default=-1, help="Random seed (default: random)")
    parser.add_argument("-n", "--patches", type=int, default=15, help="Number of city patches (default: 15)")
    parser.add_argument("-p", "--palette", type=str, default="default",
                        help="Color palette: default, blueprint, bw, ink, night, ancient, colour, simple")
    parser.add_argument("-o", "--output", type=str, default="city.svg", help="Output file path")
    parser.add_argument("--scale", type=float, default=2.0, help="PNG scale factor (default: 2.0)")
    parser.add_argument("--plaza", action=argparse.BooleanOptionalAction, default=None, help="Force plaza on/off")
    parser.add_argument("--citadel", action=argparse.BooleanOptionalAction, default=None, help="Force citadel on/off")
    parser.add_argument("--walls", action=argparse.BooleanOptionalAction, default=None, help="Force walls on/off")
    parser.add_argument("--temple", action=argparse.BooleanOptionalAction, default=None, help="Force temple on/off")
    parser.add_argument("--river", action="store_true", default=False, help="Add a river")
    parser.add_argument("--coast", action="store_true", default=False, help="Add a coastline")
    parser.add_argument("--shanty-town", action="store_true", default=False, help="Add shanty towns")
    parser.add_argument("--roads", type=int, default=None, help="Number of roads radiating from center (default: auto)")
    parser.add_argument("--road-style", type=str, default=None, choices=["organic", "medieval"],
                        help="Road layout style: organic (default) or medieval (concentric rings)")
    parser.add_argument("--elongation", type=float, default=None, help="City elongation (1.0=round, 3.0=very oval, default: random)")
    parser.add_argument("--river-curvature", type=float, default=None, help="River curvature (0.5=straight, 5.0=very curvy, default: 3.0)")
    parser.add_argument("--coast-roughness", type=float, default=None, help="Coast roughness (0.1=smooth, 1.5=jagged, default: 0.5)")
    parser.add_argument("--building-density", type=float, default=None, help="Building density (0.0=sparse, 1.0=dense, default: auto)")
    parser.add_argument("--building-style", type=str, default=None, choices=["original", "composite", "mixed"],
                        help="Building shape style: original, composite (overlapping rects), mixed (L-shapes, default)")

    args = parser.parse_args(argv)

    from town_generator.building.model import Model
    from town_generator.rendering.palette import PALETTES
    from town_generator.rendering.svg_renderer import render_svg

    palette = PALETTES.get(args.palette.lower())
    if palette is None:
        print(f"Unknown palette '{args.palette}'. Available: {', '.join(PALETTES.keys())}")
        sys.exit(1)

    print(f"Generating town (seed={args.seed}, patches={args.patches}, palette={args.palette})...")
    model = Model(
        n_patches=args.patches,
        seed=args.seed,
        plaza=args.plaza,
        citadel=args.citadel,
        walls=args.walls,
        temple=args.temple,
        river=args.river or None,
        coast=args.coast or None,
        shanty_town=args.shanty_town or None,
        n_roads=args.roads,
        road_style=args.road_style,
        elongation=args.elongation,
        river_curvature=args.river_curvature,
        coast_roughness=args.coast_roughness,
        building_density=args.building_density,
        building_style=args.building_style,
    )
    svg = render_svg(model, palette)

    output: str = args.output
    if output.endswith(".png"):
        from town_generator.rendering.png_renderer import render_png
        render_png(svg, output, scale=args.scale)
        print(f"PNG saved to {output}")
    else:
        with open(output, "w", encoding="utf-8") as f:
            f.write(svg)
        print(f"SVG saved to {output}")


if __name__ == "__main__":
    main()
