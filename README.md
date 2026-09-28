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
- 만화 전용 Comic Text Detector 검출 + Manga OCR 재인식 기반 일본어 OCR 작업과 진행 상태
- 리더 안에서 OCR 블록별 번역문과 기본 식자 스타일 편집
- 로컬 CTranslate2 기반 자동 번역·식자 작업 큐
- CPU 기반 LaMa 원문 영역 제거·배경 복원·번역 이미지 렌더링
- PDF/CBZ 원본 업로드 접수 및 작업 상태 모델
- 원본 파일과 페이지 파일을 보호된 `/media/:id`로 제공
- 첫 번째 라이브러리 화면과 업로드 폼

현재 OCR 기본값(`OCR_PROVIDER=manga-ocr`)은 만화 전용 Comic Text Detector로 페이지에서 글 영역을 찾고, 각 영역을 Manga OCR로 읽습니다. Tesseract 희소 검출과 근접 영역 병합은 더 이상 기본 경로에 사용하지 않습니다. `OCR_PROVIDER=tesseract`로 설정하면 기존 Tesseract OCR만 사용하는 대체 경로로 동작합니다.

리더에서 `번역 편집`을 누르면 OCR 블록별 번역문을 입력하고 세로쓰기/가로쓰기와 글자 크기를 저장할 수 있습니다. 저장된 결과는 번역 모드의 식자 레이어로 표시됩니다. 역식 데이터 API는 `POST /api/pages/:id/ocr-blocks`, `POST /api/ocr-blocks/:id/translations`, `PATCH /api/lettering-layers/:id`이며, 좌표는 페이지 기준 0~1 정규화 좌표를 사용합니다.

권을 업로드하면 페이지 준비 → OCR → 로컬 자동 번역·식자 작업이 순서대로 백그라운드에서 실행됩니다. 화면의 처리 패널에서 단계와 진행률을 확인할 수 있으며, 자동 역식이 끝나면 번역된 만화 리더를 바로 엽니다. 번역은 블록별 CTranslate2/NLLB 추론을 사용하고 기본 빔 크기는 4입니다. 한국어 자동 식자는 가로쓰기를 우선하고, 매우 좁은 상자 안의 짧은 문구만 세로쓰기를 유지합니다. 렌더러는 복원된 페이지 위에 불투명한 사각 배경을 덮지 않고 얇은 글자 외곽선으로 대비를 보강합니다. 글자 크기를 OCR 상자에 맞추고 단어와 문장부호 단위로 줄바꿈합니다. LaMa 모델이 없으면 4방향 주변 픽셀을 이용한 CPU 보간으로 원문 영역을 채웁니다. 이 보간은 만화 전용 인페인팅 모델의 복원 품질과 같지 않습니다.

## OCR 모델 준비

`OCR_PROVIDER=manga-ocr`는 만화 전용 Comic Text Detector로 글 영역을 찾은 다음, 각 영역을 Manga OCR로 읽습니다. 영역 검출과 인식은 로컬 CPU에서 실행합니다. 첫 설치 후 `npm run setup:ai`를 실행하면 CPU용 Python 라이브러리, 약 95MB 검출 모델, Manga OCR 인식 모델을 준비합니다. 최초 모델 설치에는 인터넷 연결이 필요합니다.

이미 등록한 권은 작품 목록의 `역식 다시 실행` 버튼으로 새 OCR·번역 파이프라인을 적용할 수 있습니다. 확인 후 새 OCR을 성공적으로 마치면 이전 OCR 문장과 번역·식자 레이어를 교체합니다. OCR에 실패하면 기존 결과를 유지합니다.

`ai-worker/vendor/comic-text-detector`에는 [Comic Text Detector](https://github.com/dmMaze/comic-text-detector) 추론 코드와 GPL-3.0 라이선스가 포함돼 있습니다. 모델은 [manga-image-translator beta 0.2.1 릴리스](https://github.com/zyddnys/manga-image-translator/releases/tag/beta-0.2.1)에서 내려받습니다. 별도의 추론 어댑터가 학습용 의존성 없이 ONNX CPU 모델을 실행합니다. 다른 OCR 경로가 필요하면 `.env`에서 `OCR_PROVIDER=tesseract`를 선택할 수 있습니다.

## 실행

Node.js 20 이상이 필요합니다.

```powershell
npm.cmd install
Copy-Item .env.example .env
npm.cmd run setup:ai
npm.cmd start
```

PowerShell에서 `npm.ps1` 실행 정책 오류가 나면 위처럼 `npm.cmd`를 사용하세요. `NODE_MODULE_VERSION` 불일치가 나오면 설치와 실행에 같은 Node 버전을 사용해야 합니다. 이 작업공간에 Node 22 실행기가 준비돼 있으면 `\.tools\nosarc-npm.cmd`로 npm 명령을 실행하세요. 실행 정책을 바꾸지 않아도 됩니다.

브라우저에서 `http://localhost:3000`을 열고 개발 환경 기본 비밀번호 `change-this-password`로 로그인합니다. 실제 사용 전에는 `.env`의 `NOSARC_ACCESS_PASSWORD`를 바꾸거나 `NOSARC_ACCESS_PASSWORD_HASH`에 Argon2id 해시를 설정하세요.

`OCR_PROVIDER=tesseract` 대체 경로를 쓸 때는 `jpn.traineddata`가 필요합니다. 첫 실행 때 `data/tesseract/`에 내려받으며, 네트워크가 차단된 환경에서는 `OCR_LANG_PATH`로 미리 받은 언어 데이터를 지정하세요.

자동 번역 워커는 Python 3.11 이상과 로컬 CTranslate2 모델이 필요합니다. 번역은 기본 8개 블록씩 나눠 처리해 진행률을 갱신하며, N100·16GB 환경에서는 워커를 한 개만 실행하고 INT8 모델을 사용하도록 기본값을 둡니다. 배치 크기는 `.env`의 `AI_TRANSLATION_BATCH_SIZE`로 조정할 수 있습니다.

```powershell
py -3.11 -m venv ai-worker/.venv
& .\ai-worker\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\ai-worker\.venv\Scripts\python.exe -m pip install -r ai-worker/requirements-cpu.txt
```

`requirements-cpu.txt`는 CUDA를 설치하지 않고 CPU 전용 PyTorch와 ONNX Runtime을 사용합니다. Comic Text Detector, Manga OCR, LaMa ONNX 실행에 필요한 라이브러리를 함께 설치합니다. LaMa ONNX 모델은 `data/models/lama/`에 별도로 준비합니다.

Windows에서는 기본적으로 `C:\Windows\Fonts\malgun.ttf`를 식자 폰트로 사용합니다. 다른 한글 폰트를 쓰려면 `.env`의 `LETTERING_FONT_PATH`를 변경하세요.

기본 번역 모델은 일본어(`jpn_Jpan`)와 한국어(`kor_Hang`)를 지원하는 NLLB-200 distilled 600M이며, `data/models/nllb-200-distilled-600M`에 준비한 뒤 CTranslate2 형식으로 변환합니다. N100에서는 변환 후 INT8 모델만 실행합니다. 모델 경로와 언어 코드는 `.env`의 `AI_TRANSLATION_MODEL_PATH`, `AI_TRANSLATION_TOKENIZER_PATH`, `AI_TRANSLATION_SOURCE_CODE`, `AI_TRANSLATION_TARGET_CODE`로 바꿀 수 있습니다.

대사 문맥과 자연스러운 구어체를 더 반영하려면 Ollama 품질 모드를 사용할 수 있습니다. Ollama를 설치한 뒤 `ollama pull qwen3:4b-instruct`로 약 2.5 GB 모델을 받고, `.env`에서 `AI_TRANSLATION_PROVIDER=ollama`로 바꿔 서버를 다시 시작하세요. 이 모드는 같은 페이지의 앞뒤 대사와 앞선 번역을 함께 참고해 생략된 주어, 인물 관계, 말투를 판단하고, 확신도 높은 인명·지명·작품 내 용어를 장 안에서 일관되게 유지합니다. 첫 번역 뒤 별도 편집 단계에서 한국어 표현을 다시 다듬으며, 말풍선 대사·나레이션·효과음을 구분해 효과음은 짧은 의성어/동작어로 번역합니다. 번역은 로컬에서 처리합니다. 기본 CTranslate2/NLLB 경로는 블록마다 독립 번역하므로 이웃 대사나 용어집을 참고하지 않습니다. Ollama는 N100 CPU에서 더 느릴 수 있습니다. 모델과 주소는 `AI_TRANSLATION_OLLAMA_MODEL`, `AI_TRANSLATION_OLLAMA_URL`로 조정할 수 있습니다.

자동 역식은 검출기의 글자 마스크로 원문만 지우고, 밝고 닫힌 말풍선 내부를 높은 확신도로 찾은 경우 그 안쪽을 번역 식자 공간으로 따로 사용합니다. 여러 OCR 블록이 같은 말풍선을 공유한다고 판단되면 겹치는 식자 후보를 버려 글자가 포개지지 않게 하고 OCR 글자 영역으로 돌아갑니다. 말풍선 후보가 불확실하거나 말풍선 밖 텍스트여도 OCR 글자 영역을 사용합니다. LaMa는 원본 해상도의 겹치는 512px 타일에서 복원해 큰 페이지를 축소하면서 생기는 흐림을 줄입니다. 효과음은 OCR 단계에서 방향, 기울기, 글자색을 기록해 번역 레이어에도 반영합니다. 기존 OCR 블록에는 새 말풍선 후보 정보가 없으므로 해당 장은 OCR을 다시 실행해야 새 식자 방식을 적용할 수 있습니다.

```powershell
& .\ai-worker\.venv\Scripts\hf.exe download facebook/nllb-200-distilled-600M --local-dir data/models/nllb-200-distilled-600M
& .\ai-worker\.venv\Scripts\ct2-transformers-converter.exe --model data/models/nllb-200-distilled-600M --quantization int8 --output_dir data/models/nllb-200-distilled-600M-ct2
```

```powershell
& .\ai-worker\.venv\Scripts\hf.exe download opencv/inpainting_lama inpainting_lama_2025jan.onnx --local-dir data/models/lama
```

서버는 `ai-worker/.venv`가 있으면 그 안의 Python을 자동으로 사용합니다. 다른 실행 파일을 쓰려면 `.env`에서 `AI_WORKER_COMMAND`를 지정하세요. 모델 파일과 가상 환경은 Git에 커밋되지 않습니다.

```powershell
npm.cmd test
```

원본과 SQLite 데이터베이스는 기본적으로 `data/` 아래에 저장되며 Git에 커밋되지 않습니다. 운영 환경에서는 `APP_ENV=production`, 긴 `SESSION_SECRET`, Argon2id 비밀번호 해시와 HTTPS를 사용해야 합니다.
