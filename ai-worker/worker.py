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
    results = translator.translate_batch(
        source_tokens,
        beam_size=1,
        batch_type="tokens",
        max_batch_size=8,
        target_prefix=target_prefix,
        return_scores=False,
    )

    for index, result in enumerate(results):
        hypothesis = result.hypotheses[0] if result.hypotheses else []
        token_ids = tokenizer.convert_tokens_to_ids(hypothesis)
        text = tokenizer.decode(token_ids, skip_special_tokens=True).strip()
        emit({
            "type": "result",
            "index": index,
            "text": text,
            "progress": 10 + int(((index + 1) / len(texts)) * 85),
        })
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
    padding = max(0.0, min(0.2, float(os.environ.get("OCR_MANGA_PADDING", "0.04"))))
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
                min_x = max(0, int((min(point[0] for point in points) - padding) * width))
                min_y = max(0, int((min(point[1] for point in points) - padding) * height))
                max_x = min(width, int((max(point[0] for point in points) + padding) * width))
                max_y = min(height, int((max(point[1] for point in points) + padding) * height))
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


def main() -> int:
    for raw_line in sys.stdin.buffer:
        if not raw_line.strip():
            continue
        try:
            request = json.loads(raw_line.decode("utf-8"))
            if request.get("kind", "translate") == "ocr":
                recognize_manga(request)
            else:
                translate(request)
            return 0
        except Exception as error:  # noqa: BLE001 - send a safe message to Node.
            emit({"type": "error", "message": str(error)[:500]})
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
