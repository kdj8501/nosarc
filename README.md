# Nos Arc

개인 서버에 보관한 일본 만화를 작품·권 단위로 정리하고, 이후 OCR/번역 작업으로 확장하기 위한 개인용 아카이브입니다.

## 현재 구현

- 공유 비밀번호 로그인과 HttpOnly 세션 쿠키
- SQLite 기반 작품, 태그, 권, 페이지, 자산, 작업 모델
- 작품 생성과 검색
- 작품 상세, 권 목록과 처리 상태
- 이미지 여러 장을 페이지 순서대로 업로드
- 이미지 권 리더와 원본/번역 전환 자리
- PDF 페이지 렌더링과 CBZ/ZIP 이미지 추출
- 단일 작업 큐, 진행률, 실패·취소·재시도 상태
- OCR 블록·번역문·식자 레이어 저장 API와 리더 오버레이
- Tesseract.js 검출 + Manga OCR 재인식 기반 일본어 OCR 작업과 진행 상태
- 리더 안에서 OCR 블록별 번역문과 기본 식자 스타일 편집
- 로컬 CTranslate2 기반 자동 번역·식자 작업 큐
- CPU 기반 LaMa 원문 영역 제거·배경 복원·번역 이미지 렌더링
- PDF/CBZ 원본 업로드 접수 및 작업 상태 모델
- 원본 파일과 페이지 파일을 보호된 `/media/:id`로 제공
- 첫 번째 라이브러리 화면과 업로드 폼

현재 OCR 기본값은 Tesseract.js로 말풍선 후보 영역을 검출한 뒤 Manga OCR로 영역을 재인식하는 하이브리드 방식(`OCR_PROVIDER=manga-ocr`)입니다. N100 같은 CPU 환경에서는 검출과 인식을 분리해 불필요한 전체 페이지 추론을 줄입니다. `OCR_PROVIDER=tesseract`로 바꾸면 Tesseract 결과만 사용하는 대체 경로로 동작합니다. Manga OCR 모델은 첫 실행 시 `OCR_MANGA_CACHE_PATH`에 내려받아 재사용합니다.

리더에서 `번역 편집`을 누르면 OCR 블록별 번역문을 입력하고 세로쓰기/가로쓰기와 글자 크기를 저장할 수 있습니다. 저장된 결과는 번역 모드의 식자 레이어로 표시됩니다. 역식 데이터 API는 `POST /api/pages/:id/ocr-blocks`, `POST /api/ocr-blocks/:id/translations`, `PATCH /api/lettering-layers/:id`이며, 좌표는 페이지 기준 0~1 정규화 좌표를 사용합니다.

권을 업로드하면 페이지 준비 → OCR → 로컬 자동 번역·식자 작업이 순서대로 백그라운드에서 실행됩니다. 화면의 처리 패널에서 단계와 진행률을 확인할 수 있으며, 자동 역식이 끝나면 번역된 만화 리더를 바로 엽니다. 번역이 끝나면 OCR 영역 마스크를 LaMa 딥러닝 모델에 전달해 원문을 제거·복원하고, 번역문을 페이지 이미지에 직접 렌더링합니다. 리더의 `이미지 다시 렌더링` 버튼으로 수동 번역 수정 결과도 다시 이미지화할 수 있습니다. LaMa 모델이 없거나 실행에 실패하면 기존 주변 픽셀 보간 방식으로 자동 대체합니다.

## 실행

Node.js 20 이상이 필요합니다.

```powershell
npm install
Copy-Item .env.example .env
npm start
```

브라우저에서 `http://localhost:3000`을 열고 개발 환경 기본 비밀번호 `change-this-password`로 로그인합니다. 실제 사용 전에는 `.env`의 `NOSARC_ACCESS_PASSWORD`를 바꾸거나 `NOSARC_ACCESS_PASSWORD_HASH`에 Argon2id 해시를 설정하세요.

첫 OCR 실행 시 `jpn.traineddata`를 `data/tesseract/`에 내려받으며, 이 디렉터리는 Git에서 무시됩니다. 네트워크가 차단된 환경에서는 `OCR_LANG_PATH`로 미리 받은 언어 데이터를 지정하세요.

자동 번역 워커는 Python 3.11 이상과 로컬 CTranslate2 모델이 필요합니다. N100·16GB 환경에서는 워커를 한 개만 실행하고 INT8 모델을 사용하도록 기본값을 둡니다.

```powershell
py -3.11 -m venv ai-worker/.venv
& .\ai-worker\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\ai-worker\.venv\Scripts\python.exe -m pip install -r ai-worker/requirements-cpu.txt
```

`requirements-cpu.txt`는 CUDA를 설치하지 않고 CPU 전용 PyTorch와 ONNX Runtime을 사용합니다. 모델 변환기, Manga OCR, LaMa ONNX 실행을 위해 필요한 CPU 라이브러리를 함께 설치합니다. Manga OCR 모델은 첫 OCR 실행 시 Hugging Face 캐시(`data/models/huggingface`)에 내려받고, LaMa ONNX 모델은 `data/models/lama/`에 준비합니다.

Windows에서는 기본적으로 `C:\Windows\Fonts\malgun.ttf`를 식자 폰트로 사용합니다. 다른 한글 폰트를 쓰려면 `.env`의 `LETTERING_FONT_PATH`를 변경하세요.

기본 번역 모델은 일본어(`jpn_Jpan`)와 한국어(`kor_Hang`)를 지원하는 NLLB-200 distilled 600M이며, `data/models/nllb-200-distilled-600M`에 준비한 뒤 CTranslate2 형식으로 변환합니다. N100에서는 변환 후 INT8 모델만 실행합니다. 모델 경로와 언어 코드는 `.env`의 `AI_TRANSLATION_MODEL_PATH`, `AI_TRANSLATION_TOKENIZER_PATH`, `AI_TRANSLATION_SOURCE_CODE`, `AI_TRANSLATION_TARGET_CODE`로 바꿀 수 있습니다.

```powershell
& .\ai-worker\.venv\Scripts\hf.exe download facebook/nllb-200-distilled-600M --local-dir data/models/nllb-200-distilled-600M
& .\ai-worker\.venv\Scripts\ct2-transformers-converter.exe --model data/models/nllb-200-distilled-600M --quantization int8 --output_dir data/models/nllb-200-distilled-600M-ct2
```

```powershell
& .\ai-worker\.venv\Scripts\hf.exe download opencv/inpainting_lama inpainting_lama_2025jan.onnx --local-dir data/models/lama
```

Python 실행 파일이 `python` 명령으로 연결되지 않으면 `.env`의 `AI_WORKER_COMMAND`에 가상 환경의 절대 경로를 지정하세요. 모델 파일과 가상 환경은 Git에 커밋되지 않습니다.

```powershell
npm test
```

원본과 SQLite 데이터베이스는 기본적으로 `data/` 아래에 저장되며 Git에 커밋되지 않습니다. 운영 환경에서는 `APP_ENV=production`, 긴 `SESSION_SECRET`, Argon2id 비밀번호 해시와 HTTPS를 사용해야 합니다.
