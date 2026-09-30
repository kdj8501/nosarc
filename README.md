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

리더에서 `번역 편집`을 누르면 OCR 블록별 번역문과 쓰기 방향, 글자 크기·색, 굵기, 정렬, 외곽선, 기울기를 저장할 수 있습니다. 수정한 스타일은 대사·나레이션·효과음 유형별 작품 기본값으로 저장해 이후 자동 식자에 재사용할 수 있습니다. 역식 데이터 API는 `POST /api/pages/:id/ocr-blocks`, `POST /api/ocr-blocks/:id/translations`, `PATCH /api/lettering-layers/:id`이며, 좌표는 페이지 기준 0~1 정규화 좌표를 사용합니다.

작품 상세의 용어집에는 인물·장소·단체·작품 용어의 원문 표기, 읽는 법, 번역 표기, 별칭, 메모를 저장할 수 있습니다. Ollama 번역에는 현재 문장과 주변 문맥에 등장하는 항목을 전달하고, CTranslate2 번역에는 등록한 원문 표기를 번역 전에 지정한 표기로 치환합니다. 용어집 버전은 번역 결과에 기록됩니다.

권을 업로드하면 페이지 준비 → OCR → 로컬 자동 번역·식자 작업이 백그라운드에서 이어집니다. 업로드 직후 처리 창은 띄우지 않으며, 메인 처리 패널에서 단계와 진행률을 확인할 수 있습니다. 번역은 블록별 CTranslate2/NLLB 추론을 사용하고 기본 빔 크기는 4입니다. 한국어 자동 식자는 가로쓰기를 우선하고, 매우 좁은 상자 안의 짧은 문구만 세로쓰기를 유지합니다. 렌더러는 복원된 페이지 위에 불투명한 사각 배경을 덮지 않으며, 밝은 글자에는 외곽선을 두르지 않습니다. 말풍선 안쪽 공간에 맞춰 글자 크기를 조정하고, 한국어는 줄 길이를 균형 있게 배분하며 문장부호가 줄 첫머리에 오지 않게 줄바꿈합니다. LaMa 모델을 사용하는데 모델 파일이 없거나 처리가 실패하면 저품질 CPU 보간으로 대체하지 않고 식질 작업을 실패 처리합니다.

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

N100/16GB에서는 Ollama `qwen3:8b`를 상한으로 권장하며, 14B 모델은 메모리 여유와 응답 속도 때문에 사용하지 않습니다. 로컬 `.env`에서 `AI_TRANSLATION_PROVIDER=ollama`로 설정하고 서버를 다시 시작하세요. 각 대사는 별도 요청으로 번역하되 같은 페이지의 앞뒤 대사와 작품 용어집을 참고해 문맥·인명을 유지합니다. 한국어 표현은 별도 교정 단계에서 다듬고 말풍선 대사·나레이션·효과음을 구분합니다. 모델, 주소, 요청 묶음 크기, 타임아웃, 추론 모드는 `AI_TRANSLATION_OLLAMA_MODEL`, `AI_TRANSLATION_OLLAMA_URL`, `AI_TRANSLATION_OLLAMA_BATCH_SIZE`, `AI_TRANSLATION_OLLAMA_TIMEOUT_MS`, `AI_TRANSLATION_OLLAMA_THINK`로 조정할 수 있습니다. 번역 요청은 기본적으로 Qwen의 추가 추론을 끄고 토큰 한도와 문맥 창을 줄여 응답 시간을 관리합니다. 추가 추론이 필요하면 `AI_TRANSLATION_OLLAMA_THINK=true`로 켤 수 있습니다.

자동 역식은 검출기의 글자 마스크를 획보다 넓혀 원문을 지우고, 확신도 높은 말풍선 안에서는 OCR 상자도 함께 지운 뒤 LaMa가 복원합니다. 말풍선 후보가 OCR 글자 영역보다 지나치게 크면 버려 이웃 말풍선까지 번역문이 뻗지 않게 합니다. 불확실한 영역에서는 획 마스크만 사용해 화면의 큰 부분이 네모나게 지워지지 않게 합니다. LaMa는 원본 해상도의 겹치는 512px 타일에서 복원하고, 대사·나레이션은 진한 글자색으로 외곽선 없이 식자합니다. 검은 말풍선 윤곽의 작은 틈을 보정해 내부를 추정하고, 후보가 이웃 OCR 글자와 겹치면 해당 확장을 취소합니다. 마스크 여백은 `INPAINT_PADDING`으로 조절합니다.

일부 OCR 블록의 번역이 비어 있어도 나머지는 계속 식자합니다. 번역이 없는 블록은 원문을 보존하고, 완료 경고와 번역 편집기에서 나중에 보완할 수 있습니다. 기존 Manga OCR의 레이아웃 정보는 다음 자동 식질에서 새로 계산하며, OCR 원문과 기존 번역은 유지합니다.

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
