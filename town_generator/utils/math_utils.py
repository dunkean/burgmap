"""Utility math functions — gate (clamp), sign."""

from __future__ import annotations


def gate(value: float, min_val: float, max_val: float) -> float:
    return min_val if value < min_val else (value if value < max_val else max_val)


def sign(value: float) -> int:
    if value == 0:
        return 0
    return -1 if value < 0 else 1
