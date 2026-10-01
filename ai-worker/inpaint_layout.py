"""Choose bounded LaMa crops with context around the text being removed."""

from __future__ import annotations

import cv2
import numpy as np


def text_centered_tiles(mask: np.ndarray, tile_size: int = 512, context: int = 32) -> list[tuple[int, int, int, int]]:
    """Group nearby ink and keep small text regions away from crop seams.

    Large connected regions still use overlapping tiles. Coordinates refer to
    the source page; the caller pads small pages to the model's fixed input size.
    """
    if mask.ndim != 2:
        raise ValueError("The inpainting mask must be two-dimensional.")
    height, width = mask.shape
    if not height or not width or not mask.any():
        return []
    if tile_size < 16 or not 0 < context < tile_size // 2:
        raise ValueError("Invalid inpainting tile or context size.")

    ink = (mask > 0).astype(np.uint8)
    # Connect neighboring glyphs before selecting crops so a single word or
    # balloon is not split just because its strokes are disconnected.
    radius = max(1, context // 2)
    grouped = cv2.dilate(ink, np.ones((radius * 2 + 1, radius * 2 + 1), dtype=np.uint8))
    _, _, stats, _ = cv2.connectedComponentsWithStats(grouped, connectivity=8)
    tiles: set[tuple[int, int, int, int]] = set()

    def starts(low: int, high: int, length: int) -> list[int]:
        span = min(length, tile_size)
        last = max(0, length - span)
        low = max(0, low - context)
        high = min(length, high + context)
        if high - low <= span:
            return [max(0, min(last, (low + high - span) // 2))]
        first = min(last, low)
        final = max(first, min(last, high - span))
        positions = list(range(first, final + 1, tile_size - context * 2))
        if positions[-1] != final:
            positions.append(final)
        return positions

    for x, y, region_width, region_height, _ in stats[1:]:
        for top in starts(int(y), int(y + region_height), height):
            for left in starts(int(x), int(x + region_width), width):
                bottom, right = min(height, top + tile_size), min(width, left + tile_size)
                if ink[top:bottom, left:right].any():
                    tiles.add((left, top, right, bottom))

    return sorted(tiles, key=lambda tile: (tile[1], tile[0]))
