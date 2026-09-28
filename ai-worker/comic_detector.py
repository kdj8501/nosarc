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
        blocks = group_output((boxes, classes, scores), lines, width, height, mask)

        results = []
        for block in blocks:
            x1, y1, x2, y2 = block.xyxy
            x1, x2 = sorted((max(0, min(width, int(x1))), max(0, min(width, int(x2)))))
            y1, y2 = sorted((max(0, min(height, int(y1))), max(0, min(height, int(y2)))))
            if x2 - x1 < 4 or y2 - y1 < 4:
                continue
            mask_polygons = []
            for line in block.lines:
                points = np.asarray(line, dtype=np.float32).reshape(-1, 2)
                if len(points) < 3:
                    continue
                mask_polygons.append([
                    {"x": float(np.clip(point[0] / width, 0, 1)), "y": float(np.clip(point[1] / height, 0, 1))}
                    for point in points
                ])
            results.append({
                "bbox": [x1 / width, y1 / height, x2 / width, y2 / height],
                "maskPolygons": mask_polygons,
                "confidence": None,
                "vertical": bool(block.vertical),
                "textLineCount": len(block.lines),
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
