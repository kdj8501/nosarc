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
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


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
    source_tokens = [tokenizer.convert_ids_to_tokens(tokenizer.encode(text, add_special_tokens=True)) for text in texts]
    emit({"type": "progress", "stage": "translating", "progress": 10})
    results = translator.translate_batch(
        source_tokens,
        beam_size=1,
        batch_type="tokens",
        max_batch_size=8,
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


def main() -> int:
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            translate(json.loads(line))
            return 0
        except Exception as error:  # noqa: BLE001 - send a safe message to Node.
            emit({"type": "error", "message": str(error)[:500]})
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
