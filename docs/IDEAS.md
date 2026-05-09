# 보류된 개선 아이디어

이 문서는 분석은 끝났지만 **구현 보류** 상태인 개선안 모음. 결정 시점에 참고.

---

## 1. OCR 2-Pass 교체 — Flash×N + 교차검증

**상태**: 보류 (2026-05-07 분석)
**관련 코드**: [src/services/ocr-pipeline.ts](../src/services/ocr-pipeline.ts) Pass 1 / Pass 2

### 현재 구조

| Pass | 모델 | 역할 |
|---|---|---|
| Pass 1 | `gemini-3.1-flash-image-preview` | 손글씨 → raw text, 불확실 글자 `[?]` 마커 |
| Pass 2 | `gemini-3-pro-image-preview` | 원본 + Pass 1 입력 → 교정 + `[?]` 복원 + Markdown 구조화 |

비용 (1페이지 기준): **~$0.022** (Pass 2 Pro가 dominant)

### 제안

Pass 1·Pass 2 모두 **Flash로 통일**하고 합치기 단계에서 **교차검증** 강화.

가설: "Flash 두 번 독립 추출 + 비교 ≥ Pro 한 번 + 검토" — Pro가 더 잘하는 영역이 글자 인식이 아니라 문맥 추론이라면, 두 번 독립 인식의 self-consistency가 더 robust.

### 검증된 4가지 패턴

| 패턴 | 동작 | 비용/페이지 | 강점 | 약점 |
|---|---|---|---|---|
| **A. 글자별 self-consistency** | Flash 2회 독립 → 글자 단위 일치 비교 → 다른 부분만 LLM 1회 | ~$0.005 | cheap | 글자별 diff 까다로움 |
| **B. Line-level diff + Flash 합치기** | Flash 2회 → 줄 단위 비교 → 차이 줄만 합치기 (Flash 호출) | ~$0.005~0.007 | 단순 구현 | 줄 정렬 어긋나면 무용 |
| **C. Triple Flash 다수결** | Flash 3회 독립 → 글자 majority vote → 모두 다른 부분만 LLM | ~$0.008 | 가장 robust | 3 RPM 사용 |
| **D. Hybrid (Flash×2 + Pro fallback)** | Flash 2회 + Flash 합치기 시도, 결과가 너무 갈리면 Pro로 escalate | ~$0.005~0.020 | 평균 cheap, 어려운 페이지만 expensive | 복잡도↑ |

### 권장: 패턴 B + Flash 합치기

```
Pass 1: Flash (독립 raw extract)
Pass 2: Flash (Pass 1 결과 모름, 동일 프롬프트로 독립 추출)
Pass 3: Flash 합치기
  입력: 원본 이미지 + Pass 1 텍스트 + Pass 2 텍스트
  지시: 일치 부분은 그대로, 다른 부분 + [?] 부분만 원본 보고 결정 + Markdown 구조화
```

**비용**: 현재 ~$0.022 → 제안 ~$0.005~0.007 (**~70% 절감**)
**처리 시간**: Pass 1·2 를 `Promise.all` 병렬화하면 현재와 동일 (5~10초)

### 보류 사유

1. **품질 측정 미실시** — 손글씨 샘플로 A/B 테스트 안 됐음. "Flash×2 + 교차검증 ≥ Pro 한 번" 가설은 실측 없이 단정 불가.
2. **Flash 인식 한계 우려** — Pro 가 추론으로 잡던 어려운 글자(흘림체·약자)를 Flash 합치기가 못 잡을 가능성.
3. **`[?]` 환각 트레이드오프** — Pro 는 "[?]를 문맥 추론으로 복원" 명시 지시. Flash 에 같은 지시 주면 환각 위험. 보수적으로 가면 [?] 잔존 → 가독성 ↓.
4. **현재 시스템 이미 동작** — 회귀 위험 대비 70% 비용 절감의 ROI 가 손글씨 OCR 사용량에 따라 달라짐. 사용량 누적 후 결정.

### 진행 트리거 (언제 다시 검토할지)

- 손글씨 OCR 사용량이 월 50페이지 이상 → 비용 의미 있어짐
- 또는 사용자가 손글씨 샘플 1~2개로 A/B 테스트 결과를 가져오면 즉시 결정 가능
- 또는 Pro 모델이 응답 속도/할당량 문제 일으킬 때

### 구현 시 안전판

- 디폴트는 Flash×3
- 합치기 단계 결과의 글자 일치율 < X% 면 Pro 로 자동 escalate (옵션)
- CLI 옵션 `--ocr-cross-check pro|flash` 로 수동 선택 가능
- 기존 [src/types/index.ts](../src/types/index.ts) `MODELS.OCR_ENHANCE` 는 fallback 용으로 보존

---

## 2. iPhone 지원 — Mac 호스트 PWA / Capacitor / Native Swift

**상태**: 보류 (2026-05-07 분석)
**관련 코드**: 현재 doc-converter 는 Electron macOS 전용. iOS 미지원.

### 분석한 4가지 옵션

| 방식 | 작업량 | 코드 재사용 | iPhone 단독 동작 | 비용 |
|---|---|---|---|---|
| **A. PWA + Mac 호스트** | ~30분 | 100% | X (Mac 켜져 있어야) | $0 |
| **B. Capacitor + sideload** | 1~2일 | ~70% | △ (backend 별도 호스트 또는 ffmpeg.wasm) | $0~$99/년 |
| **C. Cloud backend + PWA** | 반나절 + 운영 | ~50% | ✓ | 운영비 |
| **D. Native Swift 새로 작성** | 2~4주 | 0% | ✓ | 시간 다대 |

### 본인 사용 한정 sideload 방식 (B 또는 D 적용 시)

| 방식 | 비용 | 갱신 주기 | 기기 |
|---|---|---|---|
| Free Apple ID (Xcode Personal Team) | $0 | 7일마다 재서명 | 본인 1대, 동시 앱 3개 |
| Apple Developer Program | $99/년 | 1년 | 100대 등록 |
| AltStore / SideStore | $0 (또는 AltStore Pro $1.50/월) | 7일 자동 (Mac/PC 같은 네트워크 시) | 본인 |

### A안 (PWA + Mac 호스트) — 가장 가성비 좋음

- Mac 에서 Express 서버 (`app.listen(port, '0.0.0.0')`) 실행
- iPhone Safari → `http://<mac-ip>:3002` (또는 Tailscale 으로 외부 네트워크에서도)
- "공유 → 홈 화면에 추가" → 앱 아이콘 + 풀스크린 PWA
- 처리는 Mac 이 다 — iPhone 은 UI 만

**구현 시 변경**:
- `src/ui/server.ts` host bind 옵션 (`0.0.0.0` 모드)
- `src/ui/public/manifest.json` 신규 — PWA manifest
- `index.html` apple-touch-icon meta + manifest link
- (선택) service-worker.js — 오프라인 캐싱

**한계**:
- Mac 이 항상 켜져 있어야 (MacBook 잠자면 X, Mac mini 항상 on 환경이면 OK)
- iPhone 마이크 직접 녹음 → 즉시 변환은 PWA 도 가능하지만 추가 UI 필요 (현재는 파일 업로드만)

### B안 (Capacitor + sideload) — iPhone 단독 동작 원할 때

- HTML/JS UI 거의 그대로 (`@capacitor` plugins 로 native 기능 통합)
- `ffmpeg.wasm` 으로 음성 청크 분할 (브라우저 안에서 처리, 2시간 음성에선 느림 — 수 분 소요)
- 또는 짧은 파일만 (≤ 15분) 지원 — Gemini 가 inline 으로 직접 받음
- API 키 → Capacitor Keychain plugin
- 파일 → iOS Files 앱 / iCloud Drive 통합 (`@capacitor/filesystem`)

**도전**:
- ffmpeg 처리 — `ffmpeg.wasm` (느림) vs native plugin (Swift bridge 필요) vs Mac 에 처리 위임
- backend (Gemini/Claude API 직접 호출) 은 Capacitor WebView 안에서 OK

### 진행 트리거 (언제 다시 검토)

- Mac 자주 안 켜져 있는 환경 → A안 의미 X
- iPhone 단독 사용 빈도 ≥ 주 1회 → B안 시도 가치
- iPhone native UX (Files 통합, share extension 등) 핵심 → D안 가치

**현재 결정**: 본인 사용 시 Mac 켜져 있는 환경이라 A안 충분. 진행 보류.

---

## 3. Vercel 배포 — 모든 기능 + Webhook + Batch (Pro plan)

**상태**: 보류 (2026-05-07 분석)
**관련 코드**: 현재 doc-converter = Mac Electron + 로컬 CLI 만. 웹 배포 X.

### 배경 — 2026 Vercel 변경으로 재평가

이전 분석에서 "Vercel 부적합" 결론 냈으나 Fluid Compute 도입으로 핵심 차단 요인 모두 해결:

| 차단 요인 | 이전 분석 | 2026 현재 |
|---|---|---|
| 함수 timeout (5~6분 처리) | ❌ 60s | **✅ Pro 800s (13분)** |
| 250MB 업로드 (4.5MB body) | ❌ | **✅ Vercel Blob direct upload (5TB)** |
| In-memory job registry | ❌ | **✅ Vercel KV (Redis)** |
| ffmpeg/poppler 시스템 의존 | ❌ | **✅ 브라우저 ffmpeg.wasm 또는 짧은 파일만** |
| 사용자 템플릿 영구 저장 | ❌ | **✅ Vercel Blob** |

### 사용자 결정 사항 (2026-05-07)

- **대상 기능**: 모든 기능 (Webhook + Batch 활용)
- **Electron 유지**: O — Mac 은 Electron, 웹 은 Vercel 병행
- **알림 방식**: Polling KV (페이지 닫아도 OK)
- **Vercel 플랜**: Pro $20/월
- **인증**: Vercel Pro 의 Password Protection (코드 변경 0)

### 핵심 아키텍처

**짧은 작업과 긴 작업 분리**:
- **짧은 작업** (회의록·채팅·OCR·≤ 1h 음성): Pro function 800s 안 직접 처리 + KV 진행률
- **긴 음성** (> 1h): Gemini Batch API + Webhook → KV → polling

**프로젝트 구조 — monorepo 방식**:
```
doc-converter/
├── electron/          # 그대로 (Mac 앱)
├── src/
│   ├── services/      # ★ 비즈니스 로직 — Vercel + Electron 공유
│   ├── ui/server.ts   # Express (Electron 만)
│   └── ui/public/     # 정적 — 둘 다 사용
└── vercel/            # 신규
    ├── api/           # Vercel function endpoints
    ├── public/        # frontend (HTML 분기 endpoint path)
    └── vercel.json
```

`src/services/*` 는 ESM 으로 Vercel function 들이 import. Express 는 Electron 만 사용 — Vercel 에선 X.

### Phase 단위 실행 계획

| Phase | 작업 | 일정 |
|---|---|---|
| 1 | Vercel 셋업 + 정적 deploy | 1일 |
| 2 | 가벼운 기능 (회의록·채팅·OCR — 800s 안) | 1일 |
| 3 | Vercel Blob 큰 파일 업로드 | 1일 |
| 4 | Vercel KV 잡 큐 + polling | 1일 |
| 5 | 짧은 음성 (≤ 1h, sequential 패턴) | 2일 |
| 6 | 긴 음성 (> 1h, Gemini Batch + Webhook) | 3일 |
| 7 | 인증 + 사용자 템플릿 (Blob) | 2일 |
| 8 | (선택) Electron ↔ Vercel 데이터 호환 | 1일 |

**총 ~10영업일** (선택 항목 포함).

### 비용 추정

| 항목 | 사용량 (월) | 비용 |
|---|---|---|
| Vercel Pro plan | 1 user | $20 |
| Vercel Blob storage | ~5GB | ~$0.12 |
| Vercel Blob transfer | ~10GB | $0.50 |
| Vercel KV | ~1MB | ~$0 (free tier 안) |
| Gemini API | 2h × 5회 | ~$1.40 |
| Claude API (회의록) | 5회 | ~$0.30 |
| **합계** | | **~$22/월** |

Gemini Batch 50% 할인 시 ~$0.70 절감.

### 핵심 트레이드오프 / 한계

1. **화자 매핑 정확도 저하** (긴 음성 Batch 모드)
   - Electron 의 sequential + 직전 컨텍스트 inject 패턴은 단일 process 내에서만 가능
   - Vercel Batch 는 청크 병렬 처리 → 사후 매핑 LLM 으로 회귀
   - 보완: 화자 관리 UI 의 수동 rename
2. **ffmpeg.wasm 브라우저 처리 시간** (~1~5분 for 2h 음성)
   - native ffmpeg 대비 4~10x 느림
   - 페이지 떠나면 재시작 (브라우저 안 처리)
3. **Vercel Pro plan 비용** $20/월
4. **이중 코드베이스** — Electron + Vercel API
   - 비즈니스 로직 (`src/services/*`) 공유 → 중복 X
   - UI HTML 약간 분기 (endpoint path)

### 새 의존성

- `@vercel/blob` — Direct upload + token
- `@vercel/kv` (또는 `@upstash/redis`) — 잡 상태
- `@ffmpeg/ffmpeg` + `@ffmpeg/util` — 브라우저 ffmpeg.wasm
- `standardwebhooks` — Gemini webhook 서명 검증

### 진행 트리거 (언제 다시 검토)

- iPhone 또는 외부 기기 사용 빈도 ≥ 주 1회 (Mac Electron 만으로 부족)
- 동료에게 .dmg 배포 어려움 (URL 만 공유하고 싶음)
- Vercel Pro 비용 ($20/월) 가치 있다고 판단

### 미채택 대안 (참고)

- **Cloudflare Workers + R2**: timeout 5min (paid) — 우리 음성 처리 부적합
- **AWS Lambda + S3**: maxDuration 15분 — 가능하지만 운영 부담 큼
- **Railway / Fly.io / Render**: long-running container 지원, 우리 코드 거의 그대로 — 단 Vercel password protection 같은 보안 layer 직접 구축 필요
- **Next.js full migration**: 더 깔끔하지만 frontend 재작성 — 현재 vanilla HTML/JS 유지 + Vercel function 만 추가가 ROI 좋음

---

## 4. 미팅 히스토리 RAG / Knowledge Graph / To-Do 추적

**상태**: 보류 (2026-05-07 분석)
**관련 코드**: 현재 회의록 .md 파일 평문 저장만 (`~/Documents/Doc Converter Output/`). 검색/누적 활용 X.

### 목표

회의록이 쌓이면 자동으로:
1. **검색**: "지난번 김PM 이 X 에 대해 뭐라고 했지?" 같은 자연어 질의
2. **자동 컨텍스트 inject**: 새 회의록 작성 시 같은 화자/주제의 과거 미팅 요약 + 미해결 액션 자동 inject
3. **To-Do 추적**: 액션 아이템 누적 + 상태 (open/done) + due date, 미완료 항목 follow-up
4. **엔터티 추적**: 사람/프로젝트/제품 누적, 동일 인물 자동 통합

### 기술 스택 (조사 결과)

#### Embedding 모델

| 모델 | 가격/1M tok | 한국어 | 비고 |
|---|---|---|---|
| **Gemini text-embedding-004** | $0.006 | 좋음 | **GEMINI_API_KEY 재사용** ← 추천 |
| Cohere embed-v4 | $0.10 | 매우 좋음 (multilingual leader) | 새 API 키 |
| OpenAI text-embedding-3-large | $0.13 | 보통 | 새 API 키 |
| Voyage-4 | $0.06 | 보통 (영어 domain 특화) | 새 API 키 |

#### Vector DB (개인 사용 ≤ 수만 벡터)

| DB | 형태 | 우리 상황 |
|---|---|---|
| **SQLite + `sqlite-vec`** | 파일 1개 임베디드 | 단순, 백업 = 파일 복사 ← **추천** |
| Chroma local | SQLite + HNSW | 비슷, Python/JS SDK |
| Qdrant local | Rust binary | over-spec for 개인 규모 |
| pgvector | Postgres extension | Postgres 운영 필요, 과함 |

월 10미팅 × 50 chunks ≈ 6000/년 → SQLite 충분.

#### Knowledge Graph 도구 (Phase 2)

- **LangChain `LLMGraphTransformer`**: schema 정의 + LLM 으로 entity/relationship 추출 — standard
- **LightRAG** (HKU): GraphRAG 의 lighter 버전, indexing 빠름
- Microsoft GraphRAG: full-fledged, indexing 비용 큼 — over-spec

저장: 같은 SQLite 에 `entities` / `relations` 테이블 추가 (별도 Neo4j 불필요).

#### 대안 비교 — Memory 시스템

| 도구 | 차이 |
|---|---|
| **Mem0** | LLM 자동 추출 + 저장. LangChain/LangGraph 통합. 단점: cloud 또는 self-host, 우리 .md 와 분리 |
| **Claude Memory Tool** | Claude API 의 `/memories` 디렉토리. 우리 codebase 와 잘 맞음. 단 Claude 호출 시점에만 활용 |
| **자체 RAG** | 100% 우리 통제, .md 파일 = source of truth ← **추천** |

### Phase 단위 계획

#### Phase 1 — 단순 RAG (가장 큰 효과, 작은 작업량)

```
새 .md 생성 → chunk 분할 (단락 단위, ~500자)
            → Gemini Embedding (text-embedding-004)
            → SQLite + sqlite-vec → ~/.doc-converter/index.db

검색: 자연어 query → embed → top-K chunks
자동 inject: 새 회의록 작성 시 top-3 과거 미팅 요약 inject
```

- **비용**: 회의록당 ~$0.01 (5K tokens). 월 10회의록 = $0.10/월
- **작업량**: 3~5일
- **새 의존성**: `better-sqlite3` + `sqlite-vec`
- **효과**:
  - "지난번 X 에 대해 뭐라고 했지?" 검색 가능
  - 새 회의록 LLM 프롬프트에 "이전 컨텍스트" 자동 inject
  - UI 새 탭 "🔍 검색"

#### Phase 2 — Knowledge Graph + To-Do

```
새 회의록 생성 → LangChain LLMGraphTransformer
                 schema: 사람 / 프로젝트 / 결정 / 액션
              → SQLite tables: entities / relations / tasks / decisions
```

**Schema 예**:
```ts
entities  { id, type ('person'|'project'|'product'), name, aliases }
relations { from_id, to_id, type, context_meeting_id }
tasks     { id, content, owner_entity_id, due_date, status, source_meeting_id }
decisions { id, content, decided_at, source_meeting_id, related_entities[] }
```

- **비용**: 회의록당 ~$0.05 (entity extraction LLM 호출). 월 ~$0.50
- **작업량**: 1주
- **새 의존성**: `@langchain/community` + `@langchain/core` (또는 자체 LLM 호출로 LangChain 회피)
- **효과**:
  - "김PM" 노드 → 관련 미팅 + 발언 + 결정 traversal
  - 미완료 To-Do 대시보드 (across 미팅)
  - 화자 자동 통합 (동일 인물 다른 라벨로 등장 시)

#### Phase 3 — UI / 시각화

새 탭 "📚 미팅 히스토리":
- 검색 (자연어 + 필터: 화자 / 날짜 / 템플릿)
- 미팅 타임라인 (시간순)
- 화자별 그래프 (간단 force-directed)
- To-Do 대시보드 (open/done, due date 정렬)
- 자동 inject 토글

**작업량**: 3~4일.

### 트레이드오프 매트릭스

| 항목 | Phase 1 (RAG) | + Phase 2 (Graph) | + Phase 3 (UI) |
|---|---|---|---|
| 검색 정확도 | 보통 (semantic) | 高 (multi-hop) | 동일 |
| To-Do 추적 | X | ✓ | ✓ |
| 화자 동일인물 추적 | X | ✓ | ✓ |
| 작업량 | 3~5일 | +1주 | +3~4일 |
| 비용/회의록 | $0.01 | $0.05 | $0.05 |
| 새 의존성 | sqlite-vec | + LangChain (선택) | none |

### Mac Electron + Vercel 호환성

- **Electron**: SQLite 파일 그대로 사용 — `~/.doc-converter/index.db` (CLI 와 같은 위치)
- **Vercel** (§3 진행 시): SQLite 휘발성 → Turso (분산 SQLite, free tier) 또는 PostgreSQL + pgvector 마이그레이션 필요
- → Phase 1~3 모두 Electron 우선, Vercel 은 §3 작업과 함께 처리

### 핵심 결정 — 개인 사용 + 점진 도입

**Phase 1 만으로도 큰 효과** ("검색" + "자동 컨텍스트 inject"). Phase 2/3 는 Phase 1 사용해보고 가치 검증 후 결정.

### 진행 트리거 (언제 다시 검토)

- 회의록 누적 ≥ 20개 (검색 가치 발생)
- 같은 인물/프로젝트 미팅 반복 (Phase 2 가치)
- "지난번에 뭐라고 했지?" 패턴이 일주일에 1회 이상 (RAG 명확한 ROI)

### 미채택 대안

- **Mem0 통합**: turnkey 이지만 .md 와 분리된 별도 저장소 → source of truth 이중화. 우리 컨셉 (markdown 파일 = canonical) 과 충돌
- **Claude Memory Tool**: Claude API 종속 + 회의록 생성 시점에만 활용. 검색 / 자동 inject 가 별도 구현 필요해서 결국 자체 RAG 와 동일 작업량
- **Microsoft GraphRAG full**: indexing 비용 / 복잡도 우리 규모에 over-spec. LightRAG 또는 LLMGraphTransformer 가 적정

---

(향후 보류 항목 추가 시 H2 섹션으로 계속 누적)
