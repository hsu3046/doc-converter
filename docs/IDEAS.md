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

(향후 보류 항목 추가 시 H2 섹션으로 계속 누적)
