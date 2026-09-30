"""Park-Miller LCG PRNG — must match Haxe Random.hx exactly."""

from __future__ import annotations

import math
import time


class Random:
    _g = 48271.0
    _n = 2147483647

    _seed: int = 1

    @classmethod
    def reset(cls, seed: int = -1) -> None:
        cls._seed = seed if seed != -1 else int(time.time() * 1000) % cls._n

    @classmethod
    def get_seed(cls) -> int:
        return cls._seed

    @classmethod
    def _next(cls) -> int:
        cls._seed = int((cls._seed * cls._g) % cls._n)
        return cls._seed

    @classmethod
    def float(cls) -> float:
        return cls._next() / cls._n

    @classmethod
    def normal(cls) -> float:
        return (cls.float() + cls.float() + cls.float()) / 3

    @classmethod
    def int(cls, min_val: int, max_val: int) -> int:
        return int(min_val + cls._next() / cls._n * (max_val - min_val))

    @classmethod
    def bool(cls, chance: float = 0.5) -> bool:
        return cls.float() < chance

    @classmethod
    def fuzzy(cls, f: float = 1.0) -> float:
        if f == 0:
            return 0.5
        return (1 - f) / 2 + f * cls.normal()
