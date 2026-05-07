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

### 5. Long Audio (≤ 2h) — 시간 기반 청크 + 병렬 처리
**Decision (2026-05-07):** 9분 초과 오디오는 ffmpeg로 **10분 시간 단위** 청크 분할 후 Files API + `Promise.all` 동시 8개 호출.
- **왜 시간 기반인가**: Gemini는 입력 오디오를 16Kbps로 다운샘플링 처리하므로 토큰량/출력 길이는 음성 길이에만 비례 (비트레이트 무관). 용량 기반 분할은 비트레이트가 낮으면 청크당 음성 길이가 길어져 출력 토큰 잘림이 들쑥날쑥.
- **왜 10분인가**: gemini-flash 출력 한도(8K~64K tok) 대비 빠른 발화(분당 ~400자) 케이스에도 안전마진. 15분은 빠른 발화에서 잘림 위험.
- **보조 가드**: 청크 1개 ≤ 150MB. 위반 시 ffmpeg `-b:a 64k` 재인코딩 폴백 (사실상 트리거 안 됨, 보험).
- **화자 정합**: 청크별 화자A/B 라벨이 청크 간 다른 사람을 가리킬 수 있어, 청크 ≥ 2 인 경우 사후 LLM 1회 호출로 통합 매핑(화자1, 화자2 ...)을 받아 정규식 치환. 매핑 실패 시 fallback (원본 라벨 유지 + 사용자 경고).
- 구현: [src/utils/audio-splitter.ts](../src/utils/audio-splitter.ts), [src/services/audio-pipeline.ts](../src/services/audio-pipeline.ts).

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
- 대안 채택: `Promise.all` + `PARALLEL_LIMIT=8` 동시 처리 → Tier 1 RPM 한도(150~300) 안에서 9~13청크 ~1~2분 완료. webhook 없이도 "기다림 최소화" 목표 달성.
- 향후 "절약 모드"로 batch 트랙 추가 여지는 열어둠 (별도 백엔드 결정 필요 시 재검토).
