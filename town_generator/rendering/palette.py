"""Color palettes. Port of Palette.hx."""

from __future__ import annotations


class Palette:
    def __init__(self, paper: int, light: int, medium: int, dark: int, water: int = 0x5B8BA0) -> None:
        self.paper = paper
        self.light = light
        self.medium = medium
        self.dark = dark
        self.water = water

    def color_str(self, color: int) -> str:
        return f"#{color:06x}"


DEFAULT = Palette(0xCCC5B8, 0x99948A, 0x67635C, 0x1A1917, 0x5B8BA0)
BLUEPRINT = Palette(0x455B8D, 0x7383AA, 0xA1ABC6, 0xFCFBFF, 0x3A4F7A)
BW = Palette(0xFFFFFF, 0xCCCCCC, 0x888888, 0x000000, 0xAAAAAA)
INK = Palette(0xCCCAC2, 0x9A979B, 0x6C6974, 0x130F26, 0x5A6880)
NIGHT = Palette(0x000000, 0x402306, 0x674B14, 0x99913D, 0x0A1628)
ANCIENT = Palette(0xCCC5A3, 0xA69974, 0x806F4D, 0x342414, 0x6A8A7A)
COLOUR = Palette(0xFFF2C8, 0xD6A36E, 0x869A81, 0x4C5950, 0x5B8BA0)
SIMPLE = Palette(0xFFFFFF, 0x000000, 0x000000, 0x000000, 0x888888)

PALETTES = {
    "default": DEFAULT,
    "blueprint": BLUEPRINT,
    "bw": BW,
    "ink": INK,
    "night": NIGHT,
    "ancient": ANCIENT,
    "colour": COLOUR,
    "simple": SIMPLE,
}
