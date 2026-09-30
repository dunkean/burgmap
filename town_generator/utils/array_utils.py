"""Array utility functions using our PRNG. Port of ArrayExtender.hx."""

from __future__ import annotations

from typing import Any, Callable, TypeVar

from town_generator.utils.random import Random

T = TypeVar("T")


def shuffle(a: list[T]) -> list[T]:
    result: list[T] = []
    for e in a:
        result.insert(int(Random.float() * (len(result) + 1)), e)
    return result


def random_element(a: list[T]) -> T:
    return a[int(Random.float() * len(a))]


def weighted(a: list[T], weights: list[float]) -> T:
    total = sum(weights)
    z = Random.float() * total
    acc = 0.0
    for i in range(len(a)):
        acc += weights[i]
        if z <= acc:
            return a[i]
    return a[0]


def last(a: list[T]) -> T:
    return a[-1]


def min_by(a: list[T], f: Callable[[T], float]) -> T:
    result = a[0]
    min_val = f(result)
    for i in range(1, len(a)):
        element = a[i]
        measure = f(element)
        if measure < min_val:
            result = element
            min_val = measure
    return result


def max_by(a: list[T], f: Callable[[T], float]) -> T:
    result = a[0]
    max_val = f(result)
    for i in range(1, len(a)):
        element = a[i]
        measure = f(element)
        if measure > max_val:
            result = element
            max_val = measure
    return result


def add_unique(a: list[T], el: T) -> None:
    """Add element only if not already present (identity-based)."""
    if not any(x is el for x in a):
        a.append(el)


def clean(a: list[T]) -> list[T]:
    """Remove duplicates preserving order (identity-based)."""
    seen: list[T] = []
    result: list[T] = []
    for el in a:
        if not any(x is el for x in seen):
            seen.append(el)
            result.append(el)
    return result


def intersect(a: list[T], b: list[T]) -> list[T]:
    return [el for el in a if any(el is x for x in b)]


def union(a: list[T], b: list[T]) -> list[T]:
    return a + [el for el in b if not any(el is x for x in a)]


def remove_all(a: list[T], b: list[T]) -> None:
    for el in b:
        for i, x in enumerate(a):
            if x is el:
                a.pop(i)
                break


def difference(a: list[T], b: list[T]) -> list[T]:
    return [el for el in a if not any(el is x for x in b)]


def flatten(a: list[list[T]]) -> list[T]:
    result: list[T] = []
    for sub in a:
        result.extend(sub)
    return result


def replace(a: list[T], el: T, new_els: list[T]) -> None:
    """Replace element with multiple elements in-place."""
    for i, x in enumerate(a):
        if x is el:
            a[i] = new_els[0]
            for j in range(1, len(new_els)):
                a.insert(i + j, new_els[j])
            return
