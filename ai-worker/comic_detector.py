"""CPU inference adapter for the vendored Comic Text Detector ONNX model."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import torch


VENDOR_ROOT = Path(__file__).resolve().parent / "vendor" / "comic-text-detector"
if str(VENDOR_ROOT) not in sys.path:
    sys.path.insert(0, str(VENDOR_ROOT))

from utils.db_utils import SegDetectorRepresenter  # noqa: E402
from utils.imgproc_utils import letterbox  # noqa: E402
from utils.textblock import group_output  # noqa: E402


class ComicTextDetector:
    """Detect and group comic text regions without importing training packages."""

    def __init__(self, model_path: str, input_size: int = 1024) -> None:
        self.input_size = input_size
        self.model = cv2.dnn.readNetFromONNX(model_path)
        self.output_names = self.model.getUnconnectedOutLayersNames()
        self.segmentation = SegDetectorRepresenter(thresh=0.3)

    def detect(self, image: np.ndarray) -> list[dict[str, Any]]:
        height, width = image.shape[:2]
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        prepared, _, (pad_x, pad_y) = letterbox(
            rgb,
            new_shape=(self.input_size, self.input_size),
            auto=False,
            stride=64,
        )
        prepared = prepared.transpose((2, 0, 1))[::-1]
        blob = np.ascontiguousarray(prepared[None], dtype=np.float32) / 255.0

        self.model.setInput(blob)
        raw_boxes, raw_mask, line_map = self.model.forward(self.output_names)
        boxes, classes, scores = self._decode_boxes(raw_boxes)

        resize_ratio = (
            width / (self.input_size - pad_x),
            height / (self.input_size - pad_y),
        )
        if len(boxes):
            boxes[:, [0, 2]] *= resize_ratio[0]
            boxes[:, [1, 3]] *= resize_ratio[1]

        lines, line_scores = self.segmentation(self.input_size, line_map)
        selected = np.where(line_scores[0] > 0.6)[0]
        lines = lines[0][selected]
        if len(lines):
            lines = lines.astype(np.float64)
            lines[..., 0] *= resize_ratio[0]
            lines[..., 1] *= resize_ratio[1]
            lines = lines.astype(np.int32)

        mask = np.squeeze(raw_mask) * 255
        mask = mask[: mask.shape[0] - pad_y, : mask.shape[1] - pad_x]
        mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_LINEAR)
        mask = np.clip(mask, 0, 255).astype(np.uint8)
        blocks = group_output((boxes, classes, scores), lines, width, height, mask)

        results = []
        for block in blocks:
            x1, y1, x2, y2 = block.xyxy
            x1, x2 = sorted((max(0, min(width, int(x1))), max(0, min(width, int(x2)))))
            y1, y2 = sorted((max(0, min(height, int(y1))), max(0, min(height, int(y2)))))
            if x2 - x1 < 4 or y2 - y1 < 4:
                continue
            mask_polygons = _text_ink_polygons(mask, block.lines, width, height)
            results.append({
                "bbox": [x1 / width, y1 / height, x2 / width, y2 / height],
                "maskPolygons": mask_polygons,
                "confidence": None,
                "vertical": bool(block.vertical),
                "rotation": float(block.angle),
                "textLineCount": len(block.lines),
                "foregroundColor": _estimate_ink_color(image, mask, block.lines, width, height),
            })
        return results

    @staticmethod
    def _decode_boxes(raw: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Apply confidence filtering and class-aware NMS to YOLO output."""
        if raw.ndim == 2:
            prediction = raw
        elif raw.ndim == 3 and raw.shape[0] == 1:
            prediction = raw[0]
        else:
            raise RuntimeError(f"Unexpected comic detector output shape: {raw.shape}")
        if prediction.shape[1] < 6:
            raise RuntimeError(f"Comic detector output has too few columns: {prediction.shape}")

        object_confidence = prediction[:, 4]
        candidate_indexes = np.flatnonzero(object_confidence > 0.4)
        if candidate_indexes.size == 0:
            return np.empty((0, 4), np.float32), np.empty((0,), np.int32), np.empty((0,), np.float32)

        candidates = prediction[candidate_indexes]
        class_scores = candidates[:, 5:] * candidates[:, 4:5]
        classes = class_scores.argmax(axis=1).astype(np.int32)
        scores = class_scores.max(axis=1).astype(np.float32)
        keep = scores > 0.4
        candidates, classes, scores = candidates[keep], classes[keep], scores[keep]
        if not len(candidates):
            return np.empty((0, 4), np.float32), np.empty((0,), np.int32), np.empty((0,), np.float32)

        center_x, center_y, box_width, box_height = candidates[:, :4].T
        boxes = np.column_stack((
            center_x - box_width / 2,
            center_y - box_height / 2,
            center_x + box_width / 2,
            center_y + box_height / 2,
        )).astype(np.float32)

        selected = []
        for class_id in np.unique(classes):
            class_indexes = np.flatnonzero(classes == class_id)
            xywh = [
                [float(x1), float(y1), float(x2 - x1), float(y2 - y1)]
                for x1, y1, x2, y2 in boxes[class_indexes]
            ]
            kept = cv2.dnn.NMSBoxes(xywh, scores[class_indexes].tolist(), 0.4, 0.35)
            if len(kept):
                selected.extend(class_indexes[np.asarray(kept).reshape(-1)].tolist())
        if not selected:
            return np.empty((0, 4), np.float32), np.empty((0,), np.int32), np.empty((0,), np.float32)

        selected = np.asarray(selected, dtype=np.int64)
        selected = selected[np.argsort(scores[selected])[::-1][:300]]
        return boxes[selected], classes[selected], scores[selected]


def _text_ink_polygons(mask: np.ndarray, lines: list, width: int, height: int) -> list[list[dict[str, float]]]:
    """Return compact contours around detected ink instead of masking each line as a box."""
    polygons: list[list[dict[str, float]]] = []
    kernel = np.ones((3, 3), dtype=np.uint8)

    for line in lines:
        points = np.asarray(line, dtype=np.float32).reshape(-1, 2)
        if len(points) < 3:
            continue
        left = max(0, int(np.floor(points[:, 0].min())) - 2)
        top = max(0, int(np.floor(points[:, 1].min())) - 2)
        right = min(width, int(np.ceil(points[:, 0].max())) + 3)
        bottom = min(height, int(np.ceil(points[:, 1].max())) + 3)
        if right <= left or bottom <= top:
            continue

        line_region = np.zeros((bottom - top, right - left), dtype=np.uint8)
        local_points = np.rint(points - np.array([left, top], dtype=np.float32)).astype(np.int32)
        cv2.fillPoly(line_region, [local_points], 255)
        line_mask = mask[top:bottom, left:right]
        ink = np.where(line_mask >= 64, 255, 0).astype(np.uint8)
        ink = cv2.bitwise_and(ink, line_region)
        ink = cv2.dilate(ink, kernel, iterations=1)
        contours, _ = cv2.findContours(ink, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        line_polygon_count = len(polygons)

        for contour in contours:
            if cv2.contourArea(contour) < 1:
                continue
            perimeter = cv2.arcLength(contour, True)
            epsilon = max(0.75, perimeter * 0.015)
            polygon = cv2.approxPolyDP(contour, epsilon, True)
            while len(polygon) > 16:
                epsilon *= 1.5
                polygon = cv2.approxPolyDP(contour, epsilon, True)
            if len(polygon) < 3:
                x, y, contour_width, contour_height = cv2.boundingRect(contour)
                polygon = np.asarray(
                    [[[x, y]], [[x + contour_width, y]], [[x + contour_width, y + contour_height]], [[x, y + contour_height]]],
                    dtype=np.int32,
                )
            polygons.append([
                {
                    "x": float(np.clip((point[0][0] + left) / width, 0, 1)),
                    "y": float(np.clip((point[0][1] + top) / height, 0, 1)),
                }
                for point in polygon
            ])

        if len(polygons) == line_polygon_count:
            polygons.append([
                {"x": float(np.clip(point[0] / width, 0, 1)), "y": float(np.clip(point[1] / height, 0, 1))}
                for point in points
            ])

    return polygons


def _estimate_ink_color(image: np.ndarray, mask: np.ndarray, lines: list, width: int, height: int) -> str:
    """Estimate a dominant text fill color for decorative lettering."""
    samples = []
    for line in lines:
        points = np.asarray(line, dtype=np.float32).reshape(-1, 2)
        if len(points) < 3:
            continue
        left = max(0, int(np.floor(points[:, 0].min())))
        top = max(0, int(np.floor(points[:, 1].min())))
        right = min(width, int(np.ceil(points[:, 0].max())) + 1)
        bottom = min(height, int(np.ceil(points[:, 1].max())) + 1)
        if right <= left or bottom <= top:
            continue
        line_region = np.zeros((bottom - top, right - left), dtype=np.uint8)
        local_points = np.rint(points - np.array([left, top], dtype=np.float32)).astype(np.int32)
        cv2.fillPoly(line_region, [local_points], 255)
        line_mask = mask[top:bottom, left:right]
        selected = (line_mask >= 160) & (line_region > 0)
        if int(selected.sum()) < 6:
            selected = (line_mask >= 96) & (line_region > 0)
        if selected.any():
            samples.append(image[top:bottom, left:right][selected])

    if not samples:
        return "#21121a"
    pixels = np.concatenate(samples, axis=0)
    if len(pixels) < 6:
        return "#21121a"

    saturation = pixels.max(axis=1).astype(np.int16) - pixels.min(axis=1).astype(np.int16)
    colored = pixels[saturation >= 40]
    if len(colored) >= max(8, int(len(pixels) * 0.08)):
        pixels = colored
    quantized = pixels // 16
    colors, counts = np.unique(quantized, axis=0, return_counts=True)
    dominant = colors[int(np.argmax(counts))]
    dominant_pixels = pixels[np.all(quantized == dominant, axis=1)]
    blue, green, red = np.median(dominant_pixels, axis=0).astype(np.uint8)
    return f"#{int(red):02x}{int(green):02x}{int(blue):02x}"
