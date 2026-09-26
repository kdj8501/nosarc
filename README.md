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
- PDF/CBZ 원본 업로드 접수 및 작업 상태 모델
- 원본 파일과 페이지 파일을 보호된 `/media/:id`로 제공
- 첫 번째 라이브러리 화면과 업로드 폼

OCR, 번역, PDF/CBZ 페이지 변환은 다음 구현 단계에서 작업 큐와 연결합니다.

## 실행

Node.js 20 이상이 필요합니다.

```powershell
npm install
Copy-Item .env.example .env
npm start
```

브라우저에서 `http://localhost:3000`을 열고 개발 환경 기본 비밀번호 `change-this-password`로 로그인합니다. 실제 사용 전에는 `.env`의 `NOSARC_ACCESS_PASSWORD`를 바꾸거나 `NOSARC_ACCESS_PASSWORD_HASH`에 Argon2id 해시를 설정하세요.

```powershell
npm test
```

원본과 SQLite 데이터베이스는 기본적으로 `data/` 아래에 저장되며 Git에 커밋되지 않습니다. 운영 환경에서는 `APP_ENV=production`, 긴 `SESSION_SECRET`, Argon2id 비밀번호 해시와 HTTPS를 사용해야 합니다.
