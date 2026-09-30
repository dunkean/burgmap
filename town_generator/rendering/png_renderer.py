"""PNG output via cairosvg."""

from __future__ import annotations


def render_png(svg_string: str, output_path: str, scale: float = 2.0) -> None:
    try:
        import cairosvg
    except ImportError:
        raise ImportError(
            "cairosvg is required for PNG output. Install with: pip install cairosvg"
        )
    cairosvg.svg2png(
        bytestring=svg_string.encode("utf-8"),
        write_to=output_path,
        scale=scale,
    )
