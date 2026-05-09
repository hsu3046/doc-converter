# Project Memory (doc-converter)

**Last Updated:** 2026-05-07

## Important Decisions & Context

### 1. Handling Extreme-Resolution Scanned PDFs (Gemini `INVALID_ARGUMENT` Fallback)
**Symptom:** Certain PDFs (e.g., 3-4 pages but weighing over 50MB) triggered immediate `INVALID_ARGUMENT` crashes when uploaded to the Gemini File API.
**Root Cause:** These PDFs contain embedded, uncompressed raw images (TIFF/PNG lossy structures) whose raw pixel dimensions or memory footprint exceed Gemini's internal multimodal safety thresholds (e.g., 10000x10000 pixels constraint).
**Solution / Pattern:** 
Instead of sending these anomalous PDFs directly to Gemini, the pipeline now automatically catches the `INVALID_ARGUMENT` error and triggers a **Local Rasterization Fallback**:
1. Uses `child_process.exec('pdftoppm -png -r 150')` to shell out to the local Mac `poppler` installation.
2. Extracts each PDF page to a standardized, highly compressed 150 DPI PNG image.
3. Packages the extracted PNG array into a multimodal `image/png` payload (inline base64 or File API) to safely deliver the content without violating API dimension limits.
*Note:* This pattern requires the system to have `poppler` installed (`brew install poppler`).

### 2. File Upload Name Encoding Corruption (Multer)
**Symptom:** Uploading Korean or non-ASCII filenames via `multer` caused them to appear as corrupted Latin-1 gibberish in the server pipeline.
**Root Cause:** The `multer` library internally relies on `busboy` which has a known legacy bug reading non-ASCII multipart headers as `latin1`.
**Solution / Pattern:**
Manually force string recoding on interception:
\`\`\`typescript
const decodeFilename = (name: string) => Buffer.from(name, 'latin1').toString('utf8');
\`\`\`
Applied deeply in the express route (`file.originalname = decodeFilename(file.originalname)`) to preserve CJK attribution logic before routing to the LLM OCR processors.

### 3. Server-Sent Events (SSE) Granular Progress Streaming
**Context:** Native HTTP long-polling caused request timeouts natively governed by Vercel/Next.js/Express layers because LLM OCR requires ~20s to ~2m of generation time for heavy context.
**Implementation:** Implemented an Event-Driven SSE system where the browser connects to `/api/stream?jobId=xxx`. This guarantees connection heartbeat mapping (`Content-Type: text/event-stream`), emitting real-time phase transitions (Pass 1/Pass 2) directly into the Next.js frontend state.

### 4. Strict ESM imports
**Trap:** Attempting to inject `require('node:util')` randomly inside `gemini.ts` instantly crashed the execution environment on Pass 1 processing because doc-converter relies entirely on `"type": "module"`. Standard `import` is strictly mandatory.

### 5. Long Audio (≤ 2h) — 시간 기반 청크 + 순차 처리 + 직전 컨텍스트 inject
**Decision (2026-05-07, revised from earlier parallel approach):** 9분 초과 오디오는 ffmpeg로 **10분 시간 단위** 청크 분할 후 **순차 처리**. 직전 청크 마지막 발화 6개를 다음 청크 STT 프롬프트에 컨텍스트로 inject — 화자 라벨이 STT 단계에서 일관성 유지.

- **왜 시간 기반인가**: Gemini는 입력 오디오를 16Kbps로 다운샘플링 처리하므로 토큰량/출력 길이는 음성 길이에만 비례 (비트레이트 무관). 용량 기반 분할은 비트레이트가 낮으면 청크당 음성 길이가 길어져 출력 토큰 잘림이 들쑥날쑥.
- **왜 10분인가**: gemini-flash 출력 한도(8K~64K tok) 대비 빠른 발화(분당 ~400자) 케이스에도 안전마진. 15분은 빠른 발화에서 잘림 위험.
- **보조 가드**: 청크 1개 ≤ 150MB. 위반 시 ffmpeg `-b:a 64k` 재인코딩 폴백 (사실상 트리거 안 됨, 보험).
- **왜 순차로 바꿨나 (병렬 → 순차 전환)**: 초기 구현은 병렬 + 사후 reconcileSpeakers LLM 호출. 사용자 보고 — "처음 청크 화자1/화자2 와 두번째 청크 화자1/화자2 가 서로 뒤섞임". 인사말/추임새 짧은 컨텍스트 보고 LLM 매핑은 본질적 한계. 산업 표준 (AssemblyAI/Pyannote) 은 voice embedding 기반 unified context — 우리는 voice embedding 없음. 텍스트만으로는 **STT 단계에서 라벨 일관성 강제** 가 robust. 비용 -10%, 처리 시간 5x 증가 (병렬 1~2분 → 순차 6~12분 for 2h), 화자 매핑 오류 dramatic 개선.
- **타임스탬프 regex 유연성**: Gemini STT 가 짧은 청크에서 `[MM:SS]` 단축 출력하는 경우 처리 — `\d{1,2}:\d{2}(?::\d{2})?` 패턴. `offsetTimestamps` 가 모두 `[HH:MM:SS]` 통일 출력 → UI 화자 변경/삭제 정규식과 일관. (이 함정 못 잡아서 일부 라벨 일괄 변경 누락된 버그 fix)
- 구현: [src/utils/audio-splitter.ts](../src/utils/audio-splitter.ts), [src/services/audio-pipeline.ts](../src/services/audio-pipeline.ts) — `transcribeChunksSequential`, `buildPromptWithContext`, `extractLastSpeakerLines`, `offsetTimestamps`.

### 7. 미팅 노트 = Markdown skill 템플릿
**Decision (2026-05-07):** STT 결과로부터 미팅 노트를 생성할 때 "skill" 단위는 frontmatter(name, description, language) + body 의 단순 .md 파일.
- **빌트인 1개**: `src/meeting-templates/builtin/general.md` — 시드. 나머지는 사용자 .md 업로드로 확장.
- **사용자 디렉토리**: `~/.doc-converter/meeting-templates/`. 첫 실행 시 자동 생성, .gitignore 자연 회피.
- **frontmatter 파서**: yaml 라이브러리 회피 — 단순 key:value line-based 직접 구현([template-loader.ts](../src/services/template-loader.ts)).
- **모델**: `MODELS.NOTES = gemini-3-pro-image-preview` (pro급 추론). 텍스트 입력만이라도 이 모델 사용. 명칭이 image-preview 지만 multimodal 이라 텍스트 OK.
- **파이프라인**: transcript text(frontmatter strip) + template body → Gemini 1회 호출. 100자 미만 transcript 거부.
- **보안**: 사용자 업로드 .md 파일명은 `^[a-zA-Z0-9_-]+$` 만 허용 (path traversal 차단), 100KB 제한, frontmatter `name` 필수.
- **CLI**: `meeting-notes <input> -t <id>` 단독 + `transcribe --notes <id>` 통합.
- **UI**: 음성 결과 인라인 카드 + 독립 탭 둘 다 지원.

### 6. Audio — Webhook + Batch API 미채택 근거
**Considered (2026-05-07):** Gemini Batch API는 audio 입력 지원 + 50% 할인 + Standard Webhooks 로 폴링 회피 가능. 그러나 doc-converter에는 부적합:
- (a) Batch turnaround target = 24h. 평균은 빠르지만 분~수십 분 변동 → 즉시 결과 UX와 충돌.
- (b) Webhook URL은 외부 도달 가능 endpoint 필수. 로컬 CLI/UI 도구 컨셉상 별도 인프라(Vercel Function + Supabase Storage 등) 추가는 과잉.
- 향후 "절약 모드"로 batch 트랙 추가 여지는 열어둠 (별도 백엔드 결정 필요 시 재검토).

### 8. macOS Electron app 패키징
**Decision (2026-05-07):** doc-converter 를 사용자 본인 + 동료 1~2명 한정으로 macOS desktop app 으로 packaging. 외부 배포 X.

- **main process 는 CJS**: [electron/main.cjs](../electron/main.cjs) — ESM 컨텍스트에서 `'electron'` import 깨짐. 나머지 src 는 ESM 유지, main.cjs 안에서 `await import('../dist/src/ui/server.js')` dynamic import.
- **Express 서버 in-process**: 별도 fork 없이 main process 안에서 listen. 포트 자동 탐색 (3002~3022, 충돌 시 +1).
- **시스템 의존성 제거**: ffmpeg/ffprobe → `@ffmpeg-installer/ffmpeg`, `@ffprobe-installer/ffprobe` npm 번들. poppler → `pdf-poppler` npm. 사용자 brew install 불필요.
- **asar path 변환 필수**: `unpackPath()` 헬퍼 ([audio-splitter.ts](../src/utils/audio-splitter.ts)) — `app.asar/` → `app.asar.unpacked/`. ffmpeg-installer 가 asar 안 path 그대로 반환하는데 binary 는 unpacked 에 있음. dev 모드는 무영향.
- **Keychain wrapper = `security` CLI 직접 호출** ([electron/main.cjs](../electron/main.cjs) `keychain` object). `keytar` native module 은 dual-arch 빌드에서 마지막 rebuild arch 만 남는 함정. `security` CLI 는 시스템 표준이라 native module 의존 0, ASAR unpack 불필요.
- **arm64 단일 dmg**: 이전 dual-arch (arm64 + x64) 가 같은 이름 패턴 두 dmg → 사용자가 잘못된 거 클릭. 단일 arm64 dmg 면 헷갈림 0. Intel Mac 동료 필요 시 별도 빌드.
- **코드 서명 X**: Apple Developer Program ($99/년) 안 들임. 첫 실행 시 macOS 보안 경고 → 우클릭 > 열기 > 다시 열기 1회. 본인+동료 한정 OK.
- **`ELECTRON_RUN_AS_NODE` 환경변수**: 셸에 `=1` 박혀있으면 Electron binary 가 일반 Node 모드로 실행됨. `package.json` 의 `dev:electron` / `dist:mac` 스크립트에 `env -u ELECTRON_RUN_AS_NODE` prefix 필수.

**API 키 / 폴더**:
- API 키 입력은 ⚙️ 설정 모달 → macOS Keychain 저장
- 다운로드는 `~/Documents/Doc Converter Output/` 자동 저장 (다이얼로그 X) + toast "Finder 에서 보기"
- 사용자 템플릿: `~/.doc-converter/meeting-templates/`. CLI 와 동일 위치 → 어느 모드에서든 같은 템플릿.

**빌드 / 실행**:
- `npm run dist:mac` → `dist-electron/Doc Converter-1.0.0-arm64.dmg`
- `npm run dev:electron` → 빌드 후 dev 모드 실행
