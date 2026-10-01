"""Nos Arc's small, line-oriented local translation worker.

The Node.js server owns authentication, jobs, and the database. This process
only loads the CPU-friendly translation model and communicates over JSONL so
the model can be replaced without coupling Python dependencies to the server.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any


def emit(payload: dict[str, Any]) -> None:
    data = (json.dumps(payload, ensure_ascii=True) + "\n").encode("utf-8")
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def prepare_images(request: dict[str, Any]) -> None:
    from PIL import Image
    import math

    max_side = max(512, int(request.get("maxSide", 2000)))
    max_pixels = max(262144, int(request.get("maxPixels", 4000000)))
    max_source_pixels = max(max_pixels, int(request.get("maxSourcePixels", 80000000)))
    Image.MAX_IMAGE_PIXELS = max_source_pixels
    pages = request.get("pages", [])
    for index, page in enumerate(pages):
        try:
            with Image.open(page["imagePath"]) as source:
                width, height = source.size
                if width <= 0 or height <= 0 or width * height > max_source_pixels:
                    raise RuntimeError(f"이미지 픽셀 수가 제한({max_source_pixels:,})을 초과했습니다.")
                scale = min(1.0, max_side / max(width, height), math.sqrt(max_pixels / (width * height)))
                output_size = (max(1, int(width * scale)), max(1, int(height * scale)))
                # JPEG draft decoding reduces memory before the full RGB conversion.
                source.draft("RGB", output_size)
                image = source.convert("RGB")
                if image.size != output_size:
                    image = image.resize(output_size, Image.Resampling.LANCZOS)
                image.save(page["outputPath"], format="PNG")
                emit({"type": "prepared_result", "pageId": page["pageId"],
                      "outputPath": page["outputPath"], "width": output_size[0], "height": output_size[1]})
        except Exception as error:
            emit({"type": "prepare_error", "pageId": page["pageId"], "message": str(error)[:500]})
        emit({"type": "progress", "progress": int((index + 1) / max(1, len(pages)) * 100)})
    emit({"type": "done", "progress": 100})


def translate(request: dict[str, Any]) -> None:
    try:
        import ctranslate2
        from transformers import AutoTokenizer
    except ImportError as error:
        raise RuntimeError(
            "AI 워커 의존성이 없습니다. ai-worker/requirements.txt를 설치해 주세요."
        ) from error

    texts = [str(text).strip() for text in request.get("texts", [])]
    if not texts:
        raise RuntimeError("번역할 텍스트가 없습니다.")

    model_path = os.environ.get("AI_TRANSLATION_MODEL_PATH", "")
    tokenizer_path = os.environ.get("AI_TRANSLATION_TOKENIZER_PATH", "") or model_path
    if not model_path or not os.path.isdir(model_path):
        raise RuntimeError(f"번역 모델 경로를 찾을 수 없습니다: {model_path}")
    if not tokenizer_path or not os.path.isdir(tokenizer_path):
        raise RuntimeError(f"번역 토크나이저 경로를 찾을 수 없습니다: {tokenizer_path}")

    compute_type = os.environ.get("AI_TRANSLATION_COMPUTE_TYPE", "int8")
    model_family = os.environ.get("AI_TRANSLATION_MODEL_FAMILY", "nllb")
    source_code = str(request.get("sourceCode", "jpn_Jpan"))
    target_code = str(request.get("targetCode", "kor_Hang"))
    threads = max(1, int(os.environ.get("AI_WORKER_THREADS", "1")))
    batch_size = max(1, int(os.environ.get("AI_TRANSLATION_BATCH_SIZE", "8")))
    beam_size = max(1, min(8, int(os.environ.get("AI_TRANSLATION_BEAM_SIZE", "4"))))
    translator = ctranslate2.Translator(
        model_path,
        device="cpu",
        compute_type=compute_type,
        inter_threads=threads,
        intra_threads=1,
    )
    tokenizer = AutoTokenizer.from_pretrained(tokenizer_path, local_files_only=True)

    emit({"type": "progress", "stage": "model-loaded", "progress": 5})
    if model_family == "nllb":
        source_tokens = []
        for text in texts:
            tokenizer.src_lang = source_code
            tokens = tokenizer.convert_ids_to_tokens(tokenizer.encode(text, add_special_tokens=True))
            source_tokens.append([source_code] + [token for token in tokens if token not in {source_code, "</s>"}] + ["</s>"])
        target_prefix = [[target_code]] * len(texts)
    else:
        source_tokens = [tokenizer.convert_ids_to_tokens(tokenizer.encode(text, add_special_tokens=True)) for text in texts]
        target_prefix = None
    emit({"type": "progress", "stage": "translating", "progress": 10})
    for start in range(0, len(source_tokens), batch_size):
        end = min(len(source_tokens), start + batch_size)
        batch_prefix = target_prefix[start:end] if target_prefix is not None else None
        results = translator.translate_batch(
            source_tokens[start:end],
            beam_size=beam_size,
            batch_type="tokens",
            max_batch_size=batch_size,
            target_prefix=batch_prefix,
            return_scores=False,
        )

        for offset, result in enumerate(results):
            index = start + offset
            hypothesis = result.hypotheses[0] if result.hypotheses else []
            token_ids = tokenizer.convert_tokens_to_ids(hypothesis)
            text = tokenizer.decode(token_ids, skip_special_tokens=True).strip()
            emit({
                "type": "result",
                "index": index,
                "text": text,
                "progress": 10 + int(((index + 1) / len(texts)) * 85),
            })
        emit({"type": "progress", "stage": "translating", "progress": 10 + int((end / len(texts)) * 85)})
    emit({"type": "done", "progress": 100})


def recognize_manga(request: dict[str, Any]) -> None:
    try:
        from manga_ocr import MangaOcr
        from PIL import Image
    except ImportError as error:
        raise RuntimeError(
            "Manga OCR 의존성이 없습니다. ai-worker/requirements-cpu.txt를 설치해 주세요."
        ) from error

    pages = request.get("pages", [])
    if not pages:
        raise RuntimeError("Manga OCR 대상 페이지가 없습니다.")

    model_name = os.environ.get("OCR_MANGA_MODEL", "kha-white/manga-ocr-base")
    padding = max(0.0, min(0.5, float(os.environ.get("OCR_MANGA_PADDING", "0.12"))))
    mocr = MangaOcr(pretrained_model_name_or_path=model_name, force_cpu=True)
    emit({"type": "progress", "stage": "manga-model-loaded", "progress": 5})
    total = sum(len(page.get("candidates", [])) for page in pages)
    completed = 0

    for page in pages:
        image_path = str(page.get("imagePath", ""))
        if not image_path or not os.path.isfile(image_path):
            raise RuntimeError(f"OCR 이미지 경로를 찾을 수 없습니다: {image_path}")
        with Image.open(image_path) as image:
            image = image.convert("RGB")
            width, height = image.size
            for candidate in page.get("candidates", []):
                polygon = candidate.get("polygon", [])
                points = [
                    (float(point.get("x", 0)), float(point.get("y", 0)))
                    for point in polygon
                    if isinstance(point, dict)
                ]
                if len(points) < 3:
                    completed += 1
                    continue
                left = min(point[0] for point in points) * width
                top = min(point[1] for point in points) * height
                right = max(point[0] for point in points) * width
                bottom = max(point[1] for point in points) * height
                pad_x = max(2, round((right - left) * padding))
                pad_y = max(2, round((bottom - top) * padding))
                min_x = max(0, int(left) - pad_x)
                min_y = max(0, int(top) - pad_y)
                max_x = min(width, int(right) + pad_x)
                max_y = min(height, int(bottom) + pad_y)
                text = ""
                if max_x > min_x and max_y > min_y:
                    text = str(mocr(image.crop((min_x, min_y, max_x, max_y)))).strip()
                emit({
                    "type": "ocr_result",
                    "pageIndex": int(page.get("pageIndex", 0)),
                    "candidateIndex": int(candidate.get("candidateIndex", 0)),
                    "text": text,
                    "progress": 5 + int(((completed + 1) / max(total, 1)) * 90),
                })
                completed += 1
    emit({"type": "done", "progress": 100})


def detect_comic_text(request: dict[str, Any]) -> None:
    try:
        import cv2
        import numpy as np
        from comic_detector import ComicTextDetector
    except ImportError as error:
        raise RuntimeError(
            "Comic Text Detector dependencies are missing. Install ai-worker/requirements-cpu.txt."
        ) from error

    pages = request.get("pages", [])
    if not pages:
        raise RuntimeError("Comic text detection received no pages.")

    model_path = os.environ.get("OCR_TEXT_DETECTOR_MODEL_PATH", "")
    if not model_path or not os.path.isfile(model_path):
        raise RuntimeError(f"Comic text detector model not found: {model_path}")

    detector = ComicTextDetector(model_path=model_path)
    emit({"type": "progress", "stage": "comic-detector-loaded", "progress": 5})
    for page_index, page in enumerate(pages):
        image_path = str(page.get("imagePath", ""))
        if not image_path or not os.path.isfile(image_path):
            raise RuntimeError(f"OCR image not found: {image_path}")
        image_bytes = np.fromfile(image_path, dtype=np.uint8)
        image = cv2.imdecode(image_bytes, cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError(f"Could not decode OCR image: {image_path}")

        candidates = detector.detect(image)
        for candidate_index, candidate in enumerate(candidates):
            emit({
                "type": "detection_result",
                "pageIndex": int(page.get("pageIndex", page_index)),
                "candidateIndex": candidate_index,
                **candidate,
                "progress": 5 + int(((page_index + 1) / len(pages)) * 90),
            })
        emit({
            "type": "progress",
            "stage": "detecting-comic-text",
            "progress": 5 + int(((page_index + 1) / len(pages)) * 90),
        })
    emit({"type": "done", "progress": 100})


def inpaint_lama(request: dict[str, Any]) -> None:
    try:
        import numpy as np
        import onnxruntime as ort
        from PIL import Image
    except ImportError as error:
        raise RuntimeError(
            "LaMa ONNX Runtime 의존성이 없습니다. ai-worker/requirements-cpu.txt를 설치해 주세요."
        ) from error

    model_path = os.environ.get("INPAINT_MODEL_PATH", "")
    if not model_path or not os.path.isfile(model_path):
        raise RuntimeError(f"LaMa ONNX 모델을 찾을 수 없습니다: {model_path}")
    pages = request.get("pages", [])
    if not pages:
        raise RuntimeError("LaMa 인페인팅 대상 페이지가 없습니다.")

    session_options = ort.SessionOptions()
    session_options.log_severity_level = 3
    session_options.intra_op_num_threads = max(1, int(os.environ.get("INPAINT_THREADS", "1")))
    session_options.inter_op_num_threads = 1
    session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    model = ort.InferenceSession(model_path, sess_options=session_options, providers=["CPUExecutionProvider"])
    emit({"type": "progress", "stage": "lama-model-loaded", "progress": 5})

    for page_index, page in enumerate(pages):
        try:
            image_path = str(page.get("imagePath", ""))
            mask_path = str(page.get("maskPath", ""))
            output_path = str(page.get("outputPath", ""))
            if not os.path.isfile(image_path):
                raise RuntimeError(f"LaMa 입력 이미지를 읽을 수 없습니다: {image_path}")
            if not os.path.isfile(mask_path):
                raise RuntimeError(f"LaMa 마스크를 읽을 수 없습니다: {mask_path}")
            with Image.open(image_path) as source:
                image = source.convert("RGB")
            with Image.open(mask_path) as source_mask:
                mask = source_mask.convert("L")
            image_array = np.asarray(image, dtype=np.uint8)
            mask_array = (np.asarray(mask, dtype=np.uint8) > 0)
            image_height, image_width = mask_array.shape
            tile_size = 512
            tile_step = 448

            def tile_starts(length: int) -> list[int]:
                starts = [0]
                while starts[-1] + tile_size < length:
                    starts.append(starts[-1] + tile_step)
                return starts

            x_starts = tile_starts(image_width)
            y_starts = tile_starts(image_height)
            tile_count = sum(
                bool(mask_array[top:min(top + tile_size, image_height), left:min(left + tile_size, image_width)].any())
                for top in y_starts for left in x_starts
            )
            accumulated = np.zeros((image_height, image_width, 3), dtype=np.float32)
            accumulated_weight = np.zeros((image_height, image_width), dtype=np.float32)
            axis = np.minimum(np.arange(tile_size) + 1, tile_size - np.arange(tile_size)).astype(np.float32)
            feather = np.clip(axis / 32.0, 0.05, 1.0)
            tile_index = 0

            for top in y_starts:
                for left in x_starts:
                    bottom = min(top + tile_size, image_height)
                    right = min(left + tile_size, image_width)
                    mask_crop = mask_array[top:bottom, left:right]
                    if not mask_crop.any():
                        continue

                    image_crop = image_array[top:bottom, left:right]
                    pad_y = tile_size - image_crop.shape[0]
                    pad_x = tile_size - image_crop.shape[1]
                    image_tile = np.pad(image_crop, ((0, pad_y), (0, pad_x), (0, 0)), mode="reflect")
                    mask_tile = np.zeros((tile_size, tile_size), dtype=np.float32)
                    mask_tile[:mask_crop.shape[0], :mask_crop.shape[1]] = mask_crop.astype(np.float32)
                    image_tensor = np.transpose(image_tile[:, :, ::-1].astype(np.float32) / 255.0, (2, 0, 1))[None, ...]
                    model_mask = (mask_tile > 0).astype(np.float32)[None, None, ...]
                    output = model.run(["output"], {"image": image_tensor, "mask": model_mask})[0][0]
                    output = np.transpose(output, (1, 2, 0))
                    if float(output.max()) <= 1.5:
                        output = output * 255.0
                    output = np.clip(output, 0, 255).astype(np.uint8)[:, :, ::-1]

                    weights = feather[:mask_crop.shape[0], None] * feather[None, :mask_crop.shape[1]]
                    weights = weights * mask_crop.astype(np.float32)
                    accumulated[top:bottom, left:right] += output[:mask_crop.shape[0], :mask_crop.shape[1]].astype(np.float32) * weights[:, :, None]
                    accumulated_weight[top:bottom, left:right] += weights
                    tile_index += 1
                    emit({
                        "type": "progress",
                        "stage": "lama-inpainting",
                        "progress": 5 + int(((page_index + tile_index / max(tile_count, 1)) / len(pages)) * 90),
                    })

            restored = image_array.copy()
            selected = mask_array & (accumulated_weight > 0)
            restored[selected] = np.clip(
                accumulated[selected] / accumulated_weight[selected, None], 0, 255
            ).astype(np.uint8)
            output_image = Image.fromarray(restored, mode="RGB")
            os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
            output_image.save(output_path, format="PNG")
            emit({
                "type": "inpaint_result",
                "pageId": str(page.get("pageId", "")),
                "outputPath": output_path,
                "progress": 5 + int(((page_index + 1) / len(pages)) * 90),
            })
        except Exception as error:
            emit({"type": "inpaint_error", "pageId": str(page.get("pageId", "")), "message": str(error)[:500]})
            emit({"type": "progress", "stage": "lama-inpainting", "progress": 5 + int(((page_index + 1) / len(pages)) * 90)})
    emit({"type": "done", "progress": 100})


def main() -> int:
    for raw_line in sys.stdin.buffer:
        if not raw_line.strip():
            continue
        try:
            request = json.loads(raw_line.decode("utf-8"))
            if request.get("kind") == "prepare":
                prepare_images(request)
            elif request.get("kind", "translate") == "ocr":
                recognize_manga(request)
            elif request.get("kind") == "detect":
                detect_comic_text(request)
            elif request.get("kind") == "inpaint":
                inpaint_lama(request)
            else:
                translate(request)
            return 0
        except Exception as error:  # noqa: BLE001 - send a safe message to Node.
            emit({"type": "error", "message": str(error)[:500]})
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
