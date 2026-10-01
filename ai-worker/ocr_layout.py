"""Bound very tall vertical OCR crops without shrinking an entire column."""
from __future__ import annotations

import numpy as np


def vertical_ocr_crops(image):
    width, height = image.size
    if height < 300 or height / max(width, 1) < 6:
        return [image]
    ink = np.asarray(image.convert('L')) < 180
    # Split columns only at real empty gutters; read Japanese right to left.
    occupied = ink.sum(axis=0) > max(2, height * 0.05)
    columns = []
    start = None
    for x in range(width + 1):
        active = x < width and bool(occupied[x])
        if active and start is None:
            start = x
        if not active and start is not None:
            if x - start >= 3:
                if columns and start - columns[-1][1] < 3:
                    columns[-1] = (columns[-1][0], x)
                else:
                    columns.append((start, x))
            start = None
    if not columns:
        return [image]
    # Tiny side runs are usually furigana, not independent prose columns.
    widest = max(right - left for left, right in columns)
    columns = [(left, right) for left, right in columns if right - left >= max(3, widest * 0.45)]
    crops = []
    for left, right in reversed(columns):
        left = max(0, left - 1)
        right = min(width, right + 1)
        rows = ink[:, left:right].any(axis=1)
        occupied_rows = np.flatnonzero(rows)
        if not len(occupied_rows):
            continue
        top = max(0, int(occupied_rows[0]) - 2)
        bottom = min(height, int(occupied_rows[-1]) + 3)
        limit = max(128, (right - left) * 8)
        while top < bottom:
            end = min(bottom, top + limit)
            if end < bottom:
                # Cut between glyphs rather than through a character.
                gaps = np.flatnonzero(~rows[max(top + 32, end - 40):min(bottom, end + 20)])
                if len(gaps):
                    origin = max(top + 32, end - 40)
                    end = origin + int(gaps[np.argmin(abs(origin + gaps - end))]) + 1
                else:
                    # No safe gap: retain this column rather than sever glyphs.
                    end = bottom
            crop = image.crop((left, top, right, end))
            if rows[top:end].any():
                crops.append(crop)
            top = end
    return crops or [image]
